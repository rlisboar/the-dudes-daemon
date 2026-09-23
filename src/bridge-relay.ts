import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { chmodSync, chownSync, existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import type { DropTarget } from "./privileges.js";
import { getParentPidAsync, getParentPidReader, getUnixPeerPidAsync, resolveAgentIdFromPid, setParentPidReader } from "./privileges.js";
import {
  aadReadChain,
  aadV2,
  COMMENT_FIELDS,
  E2EE_TABLE,
  GOAL_FIELDS,
  PLAN_FIELDS,
  TASK_FIELDS,
} from "@the-dudes/protocol/e2ee-fields";
import { DELEGATION_CONTEXT_MAX, delegationMissionTitle, delegationStepTitle, delegationTaskPrompt } from "@the-dudes/protocol/delegation";
import { decryptForProject, encryptForProject, E2eeRequiredError, isE2eEncrypted, isE2eeRequired, rememberCredentialPlaintext } from "./daemon-crypto.js";
import { scheduleDelegateShadow } from "./typesafe-delegate-shadow.js";
import { scheduleTaskShadow, type PatchTask } from "./typesafe-task-shadow.js";
import { performance } from "node:perf_hooks";
import { recordRelayConnection, recordRelayRequest } from "./debug/store.js";

/** T-812: tempos de uma request do relay (preenchidos pelo handleInner). */
interface RelayTiming {
  peerMs: number;
  upstreamMs: number | null;
  bytesIn: number;
  error: string | null;
}

/**
 * Local Unix-socket HTTP relay. The MCP bridge child process talks to this
 * socket instead of doing fetch() directly to the remote orchestrator.
 *
 * Why: when the daemon runs as root (sudo) but spawns child processes
 * dropped to the user's uid, the user-level node binary may be blocked by
 * an outbound firewall app (Little Snitch / Lulu). Loopback Unix sockets
 * bypass these filters.
 */

/**
 * Cifra os campos de texto de um payload do bridge ANTES de subir pro server.
 *
 * Extraída do handler HTTP para ser testável: o teste de paridade
 * (e2ee-parity.test.ts, daqui e do web) prova que esta função cifra exatamente
 * os campos da lista canônica em `@the-dudes/protocol/e2ee-fields` — e que o
 * web decifra os mesmos. Três bugs de produção nasceram dessa lacuna.
 *
 * Muta e devolve o próprio objeto.
 */
export type BridgeEncryptKind =
  | "send"
  | "memory_add"
  | "board"
  | "tasks_add"
  | "tasks_update"
  | "tasks_comment_add"
  | "goals_add"
  | "goals_update"
  | "plans_create"
  | "plans_add_task"
  | "plans_apply_tasks"
  // T-581: delegação do Brain. goal/context viram mission+step no DB — sem
  // cifra o createMission do server recusa em claro (e2ee_required) e o
  // subagente nunca nasce.
  | "delegate"
  // T-391: kind = op do path (não o nome MCP `save_agent`) — bate com o
  // `catalogPlainHits("agent_save", …)` da T-390 e com o 409 e2ee-required do
  // server, que deriva o kind do op.
  | "agent_save";

/**
 * Ops do bridge cujo corpo carrega campo de catálogo e por isso precisa de
 * cifra antes de subir (T-581: a lista saiu do `handleRequest` — um path novo
 * sem entrada aqui era payload em claro silencioso, e só um teste de rota
 * pega isso).
 */
const BRIDGE_CIPHER_OPS: ReadonlySet<string> = new Set<string>([
  "tasks_add",
  "tasks_update",
  "tasks_comment_add",
  "goals_add",
  "goals_update",
  "plans_create",
  "plans_add_task",
  "plans_apply_tasks",
  "agent_save",
]);

/**
 * Rota de cifra de um path `/api/bridge/<agentId>/<op>`.
 * `null` = path não carrega campo de catálogo (segue em claro, como hoje).
 */
/**
 * T-852: presença dos campos que decidem `event`/skip da sombra do Jev nas
 * tasks. Lê só o FORMATO do request (o valor já pode estar cifrado): título e
 * descrição = edited, responsável = reassigned, só status = nada.
 */
export function camposDoPatch(body: Buffer | null | undefined): PatchTask {
  const out: PatchTask = { title: false, description: false, assignee: false };
  try {
    const j = JSON.parse((body ?? Buffer.alloc(0)).toString("utf8")) as Record<string, unknown>;
    if (!j || typeof j !== "object") return out;
    const alvo = j.task && typeof j.task === "object" ? j.task : j.patch && typeof j.patch === "object" ? j.patch : j;
    const t = alvo as Record<string, unknown>;
    out.title = "title" in t;
    out.description = "description" in t;
    out.assignee = "assignee" in t || "assigneeAgentId" in t;
  } catch { /* corpo não-JSON: sem patch */ }
  return out;
}

export function bridgeCipherRoute(pathname: string): { kind: BridgeEncryptKind; agentId: string } | null {
  const m = pathname.match(/^\/api\/bridge\/([^/]+)\/([A-Za-z0-9_]+)$/);
  if (!m) return null;
  const agentId = m[1]!;
  const op = m[2]!;
  if (op === "send" || op === "memory_add" || op === "delegate") return { kind: op, agentId };
  if (op.startsWith("board_")) return { kind: "board", agentId };
  if (BRIDGE_CIPHER_OPS.has(op)) return { kind: op as BridgeEncryptKind, agentId };
  return null;
}

export function encryptBridgePayload(
  kind: BridgeEncryptKind,
  json: Record<string, unknown>,
  projectId: string,
  opts?: {
    /** Nome do agente que delegou — o subagente responde por send_message
     *  usando este nome, e ele entra no texto do prompt. Só o `delegate` usa. */
    parentName?: string;
  },
): Record<string, unknown> {
  const cifra = (v: unknown, table: string, field: string): unknown => {
    if (typeof v !== "string" || !v || isE2eEncrypted(v)) return v;
    const enc = encryptForProject(v, projectId, aadV2({ projectId, table, field }));
    if (enc) return enc;
    if (isE2eeRequired(projectId)) throw new E2eeRequiredError();
    return v;
  };
  const cifraFields = (obj: Record<string, unknown>, table: string, fields: readonly string[]): void => {
    for (const f of fields) {
      if (f in obj) obj[f] = cifra(obj[f], table, f);
    }
  };
  if (kind === "send") {
    // T-073: messages/content escreve e2e:v2 com aadV2 (reads já em prod, T-072).
    // T-074: fail-closed se e2eeRequired e sem chave (cifra() retorna null).
    if (typeof json.content === "string" && json.content && !isE2eEncrypted(json.content)) {
      const enc = cifra(json.content, E2EE_TABLE.MESSAGES, "content");
      if (enc) json.content = enc;
      else if (isE2eeRequired(projectId)) throw new E2eeRequiredError();
    }
    return json;
  }
  if (kind === "memory_add") {
    if (typeof json.title === "string" && typeof json.body === "string" && !json.contentHash) {
      const norm = (s2: string) => s2.trim().toLowerCase().replace(/\s+/g, " ");
      json.contentHash = createHash("sha256").update(`${norm(json.title)}\n${norm(json.body)}`).digest("hex");
    }
    if (typeof json.title === "string" && !isE2eEncrypted(json.title)) {
      const enc = encryptForProject(json.title, projectId, aadV2({ projectId, table: E2EE_TABLE.MEMORIES, field: "title" }));
      if (enc) { json.titleCipher = enc; delete json.title; }
      else if (isE2eeRequired(projectId)) throw new E2eeRequiredError();
    }
    if (typeof json.body === "string" && !isE2eEncrypted(json.body)) {
      const enc = encryptForProject(json.body, projectId, aadV2({ projectId, table: E2EE_TABLE.MEMORIES, field: "body" }));
      if (enc) { json.bodyCipher = enc; delete json.body; }
      else if (isE2eeRequired(projectId)) throw new E2eeRequiredError();
    }
    return json;
  }
  // T-079: tasks/goals/comments criados pelo agente via bridge — a UI já
  // cifra (encryptTaskFields/Goal/Comment); o relay não cifrava e o
  // e2ee_required recusava title em claro.
  if (kind === "tasks_add" || kind === "tasks_update") {
    const obj = (json.task && typeof json.task === "object"
      ? json.task
      : json.patch && typeof json.patch === "object"
        ? json.patch
        : json) as Record<string, unknown>;
    cifraFields(obj, E2EE_TABLE.TASKS, TASK_FIELDS);
    return json;
  }
  if (kind === "tasks_comment_add") {
    cifraFields(json, E2EE_TABLE.TASK_COMMENTS, COMMENT_FIELDS);
    return json;
  }
  if (kind === "goals_add" || kind === "goals_update") {
    const obj = (json.goal && typeof json.goal === "object"
      ? json.goal
      : json.patch && typeof json.patch === "object"
        ? json.patch
        : json) as Record<string, unknown>;
    cifraFields(obj, E2EE_TABLE.GOALS, GOAL_FIELDS);
    return json;
  }
  // T-083 SEC-04: plans_* — title/description do plano (PLANS); drafts que
  // viram board task: title→tasks.title, prompt→tasks.description (addTask).
  const cifraPlanDraft = (t: Record<string, unknown>): void => {
    if ("title" in t) t.title = cifra(t.title, E2EE_TABLE.TASKS, "title");
    if ("prompt" in t) t.prompt = cifra(t.prompt, E2EE_TABLE.TASKS, "description");
    else if ("description" in t) t.description = cifra(t.description, E2EE_TABLE.TASKS, "description");
  };
  if (kind === "plans_create") {
    cifraFields(json, E2EE_TABLE.PLANS, PLAN_FIELDS);
    if (Array.isArray(json.tasks)) {
      for (const t of json.tasks) {
        if (t && typeof t === "object") cifraPlanDraft(t as Record<string, unknown>);
      }
    }
    return json;
  }
  if (kind === "plans_add_task") {
    cifraPlanDraft(json);
    return json;
  }
  if (kind === "plans_apply_tasks") {
    if (Array.isArray(json.tasks)) {
      for (const t of json.tasks) {
        if (t && typeof t === "object") cifraPlanDraft(t as Record<string, unknown>);
      }
    }
    return json;
  }
  // T-581: `delegate` (Brain) — goal/context são conteúdo do agente e viram
  // mission + step no Postgres. Cifra com o AAD do campo de DESTINO (é o par
  // que o web lê em decryptMission/decryptMissionStep e o que o dispatch do
  // step declara em agent:send.parts). O prompt inteiro é um blob só: quem
  // tem o plaintext e o nome do pai é este processo, não o server.
  if (kind === "delegate") {
    const raw = typeof json.goal === "string" ? json.goal.trim() : "";
    if (!raw) return json;
    if (isE2eEncrypted(raw)) {
      // goal já subiu cifrado (quem cifrou foi outro hop): sem o plaintext não
      // há como recompor título/prompt do step. O server cai no fallback dele
      // (usa o próprio blob). O que ainda dá pra fazer aqui é não deixar o
      // context em claro — senão o createMission recusa a description.
      const ctx = (typeof json.context === "string" ? json.context : "").trim().slice(0, DELEGATION_CONTEXT_MAX);
      if (ctx && !isE2eEncrypted(ctx)) json.context = cifra(ctx, E2EE_TABLE.MISSIONS, "description");
      return json;
    }
    // Normaliza ANTES de cifrar: o blob não aceita trim nem slice depois
    // (cortar base64 quebra a autenticação). Mesmas regras do server em claro.
    const context = (typeof json.context === "string" ? json.context : "").trim().slice(0, DELEGATION_CONTEXT_MAX);
    const goalTitulo = cifra(delegationMissionTitle(raw), E2EE_TABLE.MISSIONS, "title");
    // C3: projeto SEM chave (sem E2EE) sai byte a byte como hoje — se o relay
    // reescrevesse `goal` aqui, o server (que recompõe o título quando o valor
    // não é blob) emitiria "Delegação: Delegação: ...". Sem cifra, quem compõe
    // título/prompt continua sendo o server, com o mesmo template.
    if (typeof goalTitulo !== "string" || !isE2eEncrypted(goalTitulo)) return json;
    json.goal = goalTitulo;
    json.context = context ? cifra(context, E2EE_TABLE.MISSIONS, "description") : "";
    const parentName = opts?.parentName || "?";
    json.stepTitle = cifra(delegationStepTitle(raw), E2EE_TABLE.MISSION_STEPS, "title");
    json.stepPrompt = cifra(
      delegationTaskPrompt(raw, context, parentName),
      E2EE_TABLE.MISSION_STEPS,
      "prompt",
    );
    return json;
  }
  // T-391: agent_save — só spec.systemPrompt é campo do catálogo (AGENTS /
  // system_prompt, o AAD exato que o server lê e que o WS save_agent já usa em
  // main.ts). name/role/... são identificadores, não texto de usuário.
  if (kind === "agent_save") {
    const spec = json.spec;
    if (spec && typeof spec === "object" && !Array.isArray(spec)) {
      const s = spec as Record<string, unknown>;
      if ("systemPrompt" in s) s.systemPrompt = cifra(s.systemPrompt, E2EE_TABLE.AGENTS, "system_prompt");
    }
    return json;
  }
  // board_* — T-024: content é alias de body (mcp-bridge já normaliza; se
  // algum caller mandar content cru, vira body ANTES de cifrar).
  if (json.body == null && typeof json.content === "string") {
    json.body = json.content;
    delete json.content;
  } else if ("content" in json) {
    delete json.content;
  }
  for (const campo of ["title", "body", "say", "text", "label"]) {
    if (campo in json) json[campo] = cifra(json[campo], E2EE_TABLE.BOARDS, campo);
  }
  if (Array.isArray(json.steps)) {
    json.steps = (json.steps as Record<string, unknown>[]).map((st) =>
      st && typeof st === "object"
        ? { ...st, label: cifra(st.label, E2EE_TABLE.BOARDS, "steps.label"), detail: cifra(st.detail, E2EE_TABLE.BOARDS, "steps.detail") }
        : st,
    );
  }
  if (json.chart && typeof json.chart === "object") {
    const c = json.chart as { labels?: unknown[]; series?: Record<string, unknown>[] };
    if (Array.isArray(c.labels)) c.labels = c.labels.map((x) => cifra(x, E2EE_TABLE.BOARDS, "chart.labels"));
    if (Array.isArray(c.series)) {
      c.series = c.series.map((se) =>
        se && typeof se === "object" ? { ...se, name: cifra(se.name, E2EE_TABLE.BOARDS, "chart.series.name") } : se,
      );
    }
  }
  return json;
}

/** Teto alinhado a AGENT_PID_WALK_MAX em privileges.ts (não exportado). */
const PEER_OS_WALK_MAX = 10;

/**
 * T-592: tentativas de resolução POR REQUEST. Sob carga o leitor de peer-pid
 * pode estourar o timeout e um hop do walk pode ficar ilegível; nenhum dos
 * dois pode virar 403 permanente. 3 tentativas custam ~200ms no caminho bom
 * (perl ~66ms + walk cacheado) e só são gastas quando o fato do SO falhou.
 */
const PEER_RESOLVE_ATTEMPTS = 3;

/**
 * #596: ops do bridge cuja resposta traz UM task em `{ task }`. São as rotas
 * de leitura/escrita do MESMO par title/description do `tasks_list` — a
 * allowlist de decrypt tem de cobri-las, senão o agente lê `e2e:v2:…` no
 * `get_task` e no retorno do `update_task` enquanto a lista entrega em claro.
 */
const TASK_SINGLE_OPS = new Set(["tasks_get", "tasks_add", "tasks_update", "tasks_lock", "tasks_unlock"]);

/** Fatos do SO por conexão Unix — nunca o resultado da autorização. */
type PeerOsFacts = {
  peerPid?: number | null;
  parentByPid: Map<number, number | null>;
  walked: boolean;
  /** T-815: a resolução virou assíncrona. Duas requests na MESMA conexão
   *  (pipelining) passam por esta fila e não intercalam a leitura dos fatos. */
  pending?: Promise<unknown>;
};

/**
 * #592: estado do peer-pid em uma palavra, para observabilidade. Sem isso o
 * dono só descobre o downgrade lendo o log da máquina — e "não-enforced" tem
 * DUAS causas opostas que precisam ser distinguíveis:
 *  - `downgrade-insecure`: alguém setou THE_DUDES_PEER_PID_INSECURE=1 →
 *    conexão não verificável é ACEITA (qualquer processo do mesmo uid fala
 *    como qualquer agente do daemon);
 *  - `fail-closed`: sem o env e com o self-test falho → conexão não
 *    verificável é RECUSADA (503).
 */
export type PeerPidMode = "enforced" | "downgrade-insecure" | "fail-closed" | "pending";

export class BridgeRelay {
  public readonly socketPath: string;
  private server: http.Server;
  private orchUrl: string;
  private dropTo: DropTarget | null;
  /** T-071: peer pid + cadeia ppid chaveados por `req.socket`. */
  private readonly peerOsBySocket = new Map<object, PeerOsFacts>();
  /** Lookup the project this agent belongs to, so we can E2EE-encrypt
   *  agent-to-agent message bodies before letting them traverse the
   *  server. Wired by the daemon at startup. */
  private agentProjectLookup?: (agentId: string) => string | null;
  /** T-581: nome do agente — entra no prompt de delegação cifrado pelo relay
   *  (o subagente responde por send_message para este nome). */
  private agentNameLookup?: (agentId: string) => string | null;

  private socketDir: string;
  private peerPidSelfTest?: () => Promise<boolean>;
  /** true só depois do self-test passar E sem downgrade explícito ligado. */
  peerPidEnforced = false;
  /**
   * T-604: true sempre que THE_DUDES_PEER_PID_INSECURE=1 está setado — o env é
   * um downgrade EXPLÍCITO (aceita conexão não verificável), não um consolo
   * para o self-test falho. Sem o env, default = fail-CLOSED.
   */
  peerPidAllowInsecure = false;
  /**
   * #592: o start JÁ decidiu o estado do peer-pid. Sem esta flag, `false` nos
   * dois campos acima é ambíguo — "ainda não decidiu" e "decidiu fail-closed"
   * ficariam indistinguíveis para quem lê o estado de fora (health).
   */
  private peerPidDecided = false;

  constructor(
    orchUrl: string,
    dropTo: DropTarget | null,
    agentProjectLookup?: (agentId: string) => string | null,
    opts?: {
      peerPidSelfTest?: () => Promise<boolean>;
      agentNameLookup?: (agentId: string) => string | null;
    },
  ) {
    this.orchUrl = orchUrl.replace(/\/$/, "");
    this.dropTo = dropTo;
    this.agentProjectLookup = agentProjectLookup;
    this.agentNameLookup = opts?.agentNameLookup;
    this.peerPidSelfTest = opts?.peerPidSelfTest;
    // Symlink attack defense: socket vivia em /tmp/the-dudes-bridge-<pid>.sock
    // — path previsível (PID sequential). Atacante local poderia pré-criar
    // symlink em /tmp/the-dudes-bridge-<next-pid>.sock → /tmp/evil-target.sock
    // antes do daemon iniciar. mkdtempSync cria dir com nome random;
    // socket dentro fica protegido.
    this.socketDir = mkdtempSync(path.join(os.tmpdir(), "the-dudes-bridge-"));
    try { chmodSync(this.socketDir, 0o700); } catch {}
    if (dropTo) {
      try { chownSync(this.socketDir, dropTo.uid, dropTo.gid); } catch {}
    }
    this.socketPath = path.join(this.socketDir, "bridge.sock");
    this.server = http.createServer((req, res) => this.handle(req, res));
    // T-071: a chave do cache é o socket do servidor (`req.socket` ===
    // o objeto do evento `connection`). `close` do cliente não é
    // síncrono com o do servidor — amarra a liberação no accept.
    this.server.on("connection", (sock) => {
      try { recordRelayConnection(); } catch { /* observação */ }
      const forget = () => { this.peerOsBySocket.delete(sock); };
      sock.once("close", forget);
    });
  }

  setAgentProjectLookup(fn: (agentId: string) => string | null) {
    this.agentProjectLookup = fn;
  }

  setAgentNameLookup(fn: (agentId: string) => string | null) {
    this.agentNameLookup = fn;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      // 0o600 (não 0o660): no macOS o gid do dropTo costuma ser `staff` (gid 20),
      // grupo primário de TODO usuário local — 0o660 abriria o relay pra
      // qualquer conta local. Todos os agentes do daemon rodam no mesmo uid,
      // então 0o600 não bloqueia nenhum agente legítimo. umask antes do listen
      // fecha a janela TOCTOU entre listen e chmodSync.
      const prevUmask = process.umask(0o077);
      this.server.listen(this.socketPath, () => {
        process.umask(prevUmask);
        try {
          chmodSync(this.socketPath, 0o600);
          if (this.dropTo) chownSync(this.socketPath, this.dropTo.uid, this.dropTo.gid);
        } catch (e) {
          reject(e);
          return;
        }
        this.server.removeListener("error", reject);
        void this.runPeerPidSelfTest().then(resolve, (e) => {
          this.applyPeerPidSelfTestResult(false, e);
          resolve();
        });
      });
    });
  }

  private applyPeerPidSelfTestResult(ok: boolean, err?: unknown): void {
    // T-604: o env é um downgrade EXPLÍCITO — vale com ou sem self-test.
    // Antes, `peerPidAllowInsecure = !ok && env`: o downgrade só existia se o
    // self-test falhasse. A T-592 subiu o teto (1500 -> 4500ms) e pôs o leitor
    // perl antes do python3, então o self-test passou a PASSAR em CI; o
    // enforcement ligava, o fixture do T-135 perdia o downgrade e o processo do
    // playwright — IRMÃO do daemon (o globalSetup spawna o daemon), não filho —
    // levava 403 "bridge peer does not match agent" na sonda bridgeCall.
    // Sem o env, nada muda: self-test ok => enforcement; self-test falho =>
    // fail-CLOSED (503) após esgotar as tentativas. Produção não seta o env.
    // Footgun: env setado desliga o enforcement mesmo com self-test OK;
    // nenhum daemon.env de campo tem a var hoje, mas se alguém a colocar
    // em prod o peer-pid deixa de ser exigido em silêncio.
    const insecure = process.env.THE_DUDES_PEER_PID_INSECURE === "1";
    this.peerPidEnforced = ok && !insecure;
    this.peerPidAllowInsecure = insecure;
    this.peerPidDecided = true;
    const why = err != null ? String((err as Error).message ?? err) : "self-test failed";
    if (insecure) {
      console.error(
        `[bridge-relay] ERROR: peer-pid ${ok ? "self-test passed" : why} — INSECURE override THE_DUDES_PEER_PID_INSECURE=1 (downgrade; cross-agent token theft not enforced)`,
      );
      return;
    }
    if (ok) return;
    console.error(
      `[bridge-relay] ERROR: peer-pid ${why} — fail-CLOSED. Install python3 (ctypes/getsockopt) or set THE_DUDES_PEER_PID_INSECURE=1 to accept unverifiable bridge connections.`,
    );
  }

  private async runPeerPidSelfTest(): Promise<void> {
    const ok = await (this.peerPidSelfTest ?? (() => this.defaultPeerPidSelfTest()))();
    this.applyPeerPidSelfTestResult(ok);
  }

  /**
   * #592: estado do peer-pid para fora (health do daemon → /api/health).
   *
   * DERIVADO DA DECISÃO, não do ambiente: `applyPeerPidSelfTestResult` lê o
   * env UMA VEZ, no start. Editar o daemon.env não muda nada aqui até o
   * restart — e é isso que o observador precisa ver, não o env atual (que
   * mentiria sobre o que o relay está de fato aplicando).
   *
   * `enforced: null` = o start ainda não decidiu (o self-test roda depois do
   * listen). Nunca é "false" por omissão: um observador que lê `false` cedo
   * demais concluiria downgrade onde ainda não há decisão.
   */
  peerPidState(): { enforced: boolean | null; mode: PeerPidMode } {
    if (!this.peerPidDecided) return { enforced: null, mode: "pending" };
    if (this.peerPidAllowInsecure) return { enforced: false, mode: "downgrade-insecure" };
    if (this.peerPidEnforced) return { enforced: true, mode: "enforced" };
    return { enforced: false, mode: "fail-closed" };
  }

  /**
   * Teto do self-test de peer-pid. DONO DO VALOR: T-592 (o valor não tem
   * outro dono; o #569, que retenta o estouro, REUSA esta constante em vez de
   * declarar teto próprio). Um só dono evita o teto ser rebaixado por engano
   * na resolução do conflito de rebase entre os dois cards.
   *
   * Por que 4500 e não 1500: 1500ms não cabia no caminho de fallback (python3
   * neste host leva 2,0–3,8s sob carga). Sem folga aqui, o self-test falhava e
   * o relay ia a fail-CLOSED (503 para todo mundo) com o leitor funcionando.
   */
  private static readonly SELF_TEST_TIMEOUT_MS = 4_500;

  /**
   * Teto POR TENTATIVA do self-test (T-569). Num host calmo a tentativa fecha
   * em ~30ms. O valor é o mesmo teto único que o T-592 entregou: o T-569 não
   * reverte para 1500ms, ele passa a repetir a tentativa.
   */
  /**
   * Teto POR TENTATIVA do self-test (T-569) — não um total agregado. Cada
   * tentativa tem a folga própria, e o que o teto realmente guarda é a CHEGADA
   * do `connection`: a leitura do peer-pid não é cortada por este timer (o
   * handler para o timer quando a conexão chega — T-815; antes o spawnSync
   * bloqueava o loop e dava no mesmo). Medido no host do dono (load ~32 em 18
   * cpus): accept em 0–13ms, 12 amostras.
   */
  /**
   * Teto POR TENTATIVA do self-test (T-569) — não um total agregado. O valor é
   * o MESMO do T-592 (card task_1890aa3a, dono do valor; lá ele é a constante
   * nomeada usada pelo timer): aqui o teto passa a ser por tentativa e NÃO
   * volta para 1500ms. Tolerância efetiva 3 × 4500 = 13,5s.
   *
   * Por que 4500 e não 2500 (ruling do PM, ~20:3xZ): o que o teto guarda é a
   * CHEGADA do `connection` — leitor lento não é cortado por este timer (o
   * handler o para quando a conexão chega, T-815; medido no host do dono,
   * load ~32 em 18 cpus: accept em 0–13ms, 12 amostras). Mas com 2500
   * sobra a faixa (2500, 4500] de bloqueio de loop SUSTENTADO — exatamente a
   * que o T-592 mediu (accept sem chegar em 1620ms, python3 de fallback em
   * 2,0–3,8s): as 3 tentativas cairiam na mesma faixa curta, esgotariam e o
   * relay iria a fail-CLOSED. Com o teto no valor do T-592 a faixa some, e a
   * evidência do T-592 (que está sendo julgada) não é invalidada em silêncio.
   */
  /**
   * Tentativas antes de aplicar o fail-closed (T-569). Tolerância efetiva =
   * tentativas × teto; num host calmo só a 1ª roda.
   */
  private static readonly SELF_TEST_TENTATIVAS = 3;

  /**
   * T-569: o self-test mede uma capacidade DEPENDENTE DA CARGA e o estouro do
   * teto era DEFINITIVO: `peerPidEnforced` ficava false e, sem
   * THE_DUDES_PEER_PID_INSECURE, o relay passava a responder 503 em TODA
   * request do bridge, sem retry, até restart. Medido no host do dono (load ~40
   * em 18 cpus): o caso A6 do t071 morreu no teto (1620ms) e o bridge ficou
   * fail-CLOSED por um pico transitório.
   *
   * Agora o estouro é RETENTADO: o fail-closed só vale depois de esgotar as
   * tentativas (aí sim é "este host não consegue"). A tolerância é a SOMA das
   * janelas, e a última janela sozinha não precisa cobrir o pior caso agregado
   * — cada tentativa carrega a folga dela.
   *
   * Interação com o T-592 (card task_1890aa3a, mesma função): o T-592 elevou o
   * teto único de 1500 -> 4500ms; aqui o teto passa a ser por tentativa e não
   * volta para 1500. Tolerância efetiva 3 × 4500 = 13,5s contra os 4,5s de uma
   * tentativa única. O valor é o mesmo do T-592 de propósito: o delta tolera o
   * pico sem depender de o T-592 já estar na base, e no rebase as duas pontas
   * apontam para o mesmo número.
   */
  private async defaultPeerPidSelfTest(): Promise<boolean> {
    for (let i = 1; i <= BridgeRelay.SELF_TEST_TENTATIVAS; i++) {
      if (await this.attemptPeerPidSelfTest()) return true;
    }
    return false;
  }

  private attemptPeerPidSelfTest(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let client: net.Socket | undefined;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.server.removeListener("connection", onConn);
        try { client?.destroy(); } catch { /* */ }
        resolve(ok);
      };
      // T-592: 1500ms não cabia no caminho de fallback (python3 neste host
      // leva 2,0–3,8s sob carga). Sem folga aqui, o self-test falhava e o
      // relay ia a fail-CLOSED (503 para todo mundo) com o leitor funcionando.
      const timer = setTimeout(() => finish(false), BridgeRelay.SELF_TEST_TIMEOUT_MS);
      const onConn = (sock: net.Socket) => {
        // T-815: o teto guarda só a CHEGADA do connection. Com o leitor
        // síncrono ele nunca cortava a leitura (o loop ficava parado até ela
        // acabar); com o assíncrono cortaria. A leitura segue com os timeouts
        // de cada sonda (perl 1s, python3 4s).
        clearTimeout(timer);
        void getUnixPeerPidAsync(sock).then((pid) => finish(pid === process.pid));
      };
      this.server.on("connection", onConn);
      client = net.connect(this.socketPath);
      client.on("error", () => finish(false));
    });
  }

  stop() {
    this.peerOsBySocket.clear();
    try { this.server.close(); } catch {}
    try { if (existsSync(this.socketPath)) unlinkSync(this.socketPath); } catch {}
    // Limpa dir random criado por mkdtempSync no shutdown.
    try { rmSync(this.socketDir, { recursive: true, force: true }); } catch {}
  }

  /** T-071 testes A3: entradas vivas no cache OS-facts (por socket). */
  unixPeerOsCacheSize(): number {
    return this.peerOsBySocket.size;
  }

  private bindPeerOsFacts(sock: object): PeerOsFacts {
    let facts = this.peerOsBySocket.get(sock);
    if (facts) return facts;
    facts = { parentByPid: new Map(), walked: false };
    this.peerOsBySocket.set(sock, facts);
    const s = sock as net.Socket;
    const forget = () => { this.peerOsBySocket.delete(sock); };
    if (typeof s.once === "function") {
      if (s.destroyed) forget();
      else s.once("close", forget);
    }
    return facts;
  }

  /**
   * Resolve o agentId do peer desta conexão. Cacheia só fatos do SO
   * (pid + ppid); o registro de autorização é consultado a cada request.
   *
   * T-592: fato do SO que FALHOU não pode ser cacheado como definitivo — sem
   * isso um único timeout do leitor de peer-pid (ou um hop ilegível do walk)
   * deixava a conexão inteira em 403 até o cliente reconectar. Foi o que o QA
   * e o PM mediram (12 curls → 7×403; 5 conexões novas → 5×403).
   */
  private resolvePeerAgentId(sock: object): Promise<string | null> {
    const facts = this.bindPeerOsFacts(sock);
    const run = (facts.pending ?? Promise.resolve()).then(() => this.resolvePeerAgentIdSerial(sock, facts));
    facts.pending = run.catch(() => undefined);
    return run;
  }

  private async resolvePeerAgentIdSerial(sock: object, facts: PeerOsFacts): Promise<string | null> {
    for (let attempt = 0; attempt < PEER_RESOLVE_ATTEMPTS; attempt++) {
      const id = await this.resolvePeerAgentIdOnce(sock, facts);
      if (id) return id;
      // Cadeia lida por inteiro e pid lido: o registro é que não bate (403
      // legítimo, T-061) — repetir não muda nada e custa spawn.
      if (facts.peerPid != null && facts.walked) return null;
      // Invalida só o que falhou; o que já foi lido (hops válidos) fica.
      if (facts.peerPid == null) facts.peerPid = undefined;
      facts.walked = false;
    }
    console.warn(
      `[bridge-relay] peer-pid do peer não resolveu em ${PEER_RESOLVE_ATTEMPTS} tentativas ` +
      `(peerPid=${facts.peerPid ?? "null"}) — 403 na conexão`,
    );
    return null;
  }

  private async resolvePeerAgentIdOnce(sock: object, facts: PeerOsFacts): Promise<string | null> {
    if (facts.peerPid === undefined) {
      // Leitor devolveu null (spawn estourou) → fica undefined, não null: a
      // próxima tentativa volta a perguntar ao SO em vez de congelar o null.
      const pid = await getUnixPeerPidAsync(sock);
      if (pid != null) facts.peerPid = pid;
    }
    const peerPid = facts.peerPid;
    if (peerPid == null) return null;

    if (!facts.walked) facts.walked = await this.walkParents(facts, peerPid);

    // Walk de resolveAgentIdFromPid usa só o cache desta conexão. O reader
    // vigente é PRESERVADO e devolvido: restaurar `null` incondicionalmente
    // (T-592) descartava o reader de quem chamou, e o retry da request caía no
    // `ps` real contra pids que só existiam na injeção. T-815: a troca é
    // síncrona de ponta a ponta (sem await entre set e restore), então nenhuma
    // outra conexão enxerga o reader desta.
    const prevReader = getParentPidReader();
    setParentPidReader((pid) => (facts.parentByPid.has(pid) ? facts.parentByPid.get(pid) ?? 0 : 0));
    try {
      return resolveAgentIdFromPid(peerPid);
    } finally {
      setParentPidReader(prevReader);
    }
  }

  /**
   * Sobe a cadeia de ppid a partir do peer, guardando cada hop no cache da
   * conexão. Devolve true só quando a cadeia terminou de forma LEGÍTIMA
   * (chegou a pid 1, ciclo, ou ao teto de hops).
   *
   * T-592: hop ilegível (`ps` estourou) devolve false e não fica cacheado —
   * antes bastava um hop falho para `walked=true` congelar uma cadeia truncada
   * e o 403 virar permanente na conexão.
   */
  private async walkParents(facts: PeerOsFacts, peerPid: number): Promise<boolean> {
    let current: number | null = peerPid;
    const seen = new Set<number>();
    for (let i = 0; i < PEER_OS_WALK_MAX; i++) {
      if (!current || current <= 1 || seen.has(current)) return true;
      seen.add(current);
      const ppid = await getParentPidAsync(current);
      if (ppid == null) {
        facts.parentByPid.delete(current);
        return false;
      }
      facts.parentByPid.set(current, ppid);
      current = ppid;
    }
    return true;
  }

  /** Cap defensivo no body relayed pelo Unix socket. Qualquer processo do
   *  user (group SUDO_USER) pode falar com o socket; sem cap, atacante
   *  local manda body de gigabytes e derruba daemon por OOM. 10MB cobre
   *  com folga payloads MCP (tasks list, send_message com anexos). */
  private static readonly MAX_BODY_BYTES = 10 * 1024 * 1024;

  /** T-055: fetch nativo sem timeout pende forever se orch/rede congela.
   *  Bridge MCP espera no Unix socket → hang do agente. Critério: 25s. */
  static readonly UPSTREAM_FETCH_TIMEOUT_MS = 25_000;

  /** T-812: mede cada request (status, upstream, peer-pid) para o
   *  dashboard de debug — a tool MCP lenta do agente aparece aqui por op. */
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const t0 = performance.now();
    const timing: RelayTiming = { peerMs: 0, upstreamMs: null, bytesIn: 0, error: null };
    try {
      await this.handleInner(req, res, timing);
    } finally {
      try {
        const m = /^\/api\/bridge\/([^/?]+)\/([A-Za-z0-9_]+)/.exec(req.url ?? "");
        const ms = (v: number) => Math.round(v * 10) / 10;
        recordRelayRequest({
          ts: Date.now(),
          agentId: m?.[1] ?? null,
          op: m?.[2] ?? "(fora da allowlist)",
          method: req.method ?? "?",
          status: res.statusCode,
          totalMs: ms(performance.now() - t0),
          peerMs: ms(timing.peerMs),
          upstreamMs: timing.upstreamMs == null ? null : ms(timing.upstreamMs),
          bytesIn: timing.bytesIn,
          bytesOut: Number(res.getHeader("content-length")) || 0,
          error: timing.error,
        });
      } catch { /* observação nunca muda a resposta */ }
    }
  }

  private async handleInner(req: http.IncomingMessage, res: http.ServerResponse, timing: RelayTiming) {
    // Path allowlist: bridge relay deve só forward /api/bridge/*. Outros
    // paths (ex: /api/admin/users) seriam bypass de auth — atacante local
    // com acesso ao socket poderia chamar endpoints arbitrários via
    // relay (que adiciona Authorization Bearer do daemon).
    const rawUrl = req.url ?? "/";
    // Rejeita traversal explícito (literal ou percent-encoded) ANTES de
    // qualquer normalização: `/api/bridge/../admin/users` passaria num
    // startsWith ingênuo mas o fetch normaliza `..` e escaparia o allowlist.
    if (/\.\.|%2e|%2f|%5c/i.test(rawUrl)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "path not allowed via bridge relay" }));
      return;
    }
    // Valida o pathname NORMALIZADO (não a string crua): só assim o
    // allowlist resiste a `..` que o fetch colapsaria depois.
    let parsed: URL;
    try {
      parsed = new URL(rawUrl, "http://relay.local");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid request path" }));
      return;
    }
    if (!parsed.pathname.startsWith("/api/bridge/")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "path not allowed via bridge relay" }));
      return;
    }
    if (this.peerPidEnforced) {
      const urlAgent = parsed.pathname.match(/^\/api\/bridge\/([^/]+)/)?.[1];
      const peerT0 = performance.now();
      const peerAgent = await this.resolvePeerAgentId(req.socket);
      timing.peerMs = performance.now() - peerT0;
      // Revisão T-815: a resolução agora é assíncrona; o cliente pode ter
      // caído no meio (agente parado com tool em voo). Nada a responder.
      if (req.destroyed || req.socket.destroyed) {
        timing.error = "cliente desconectou durante a resolução do peer";
        return;
      }
      if (!peerAgent || !urlAgent || peerAgent !== urlAgent) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bridge peer does not match agent" }));
        return;
      }
    } else if (!this.peerPidAllowInsecure) {
      console.error(
        "[bridge-relay] ERROR: refusing unverifiable bridge connection — peer-pid unavailable. Install python3 or set THE_DUDES_PEER_PID_INSECURE=1",
      );
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "bridge peer-pid unavailable — install python3 (ctypes/getsockopt) or set THE_DUDES_PEER_PID_INSECURE=1",
      }));
      return;
    } else {
      console.warn(
        "[bridge-relay] WARN: peer-pid INSECURE — accepting unverifiable bridge connection (THE_DUDES_PEER_PID_INSECURE=1)",
      );
    }
    // Reconstrói o upstream a partir do pathname normalizado + search,
    // não da string crua, pra não reintroduzir o que acabamos de validar.
    const path = parsed.pathname + parsed.search;
    const url = `${this.orchUrl}${path}`;
    let body: Buffer | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for await (const chunk of req) {
          const buf = chunk as Buffer;
          total += buf.length;
          if (total > BridgeRelay.MAX_BODY_BYTES) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "payload too large" }));
            req.destroy();
            return;
          }
          chunks.push(buf);
        }
      } catch (e) {
        // Revisão T-815: body abortado pelo cliente ("aborted") não pode virar
        // unhandledRejection — antes do T-815 o body já estava no buffer.
        timing.error = `body abortado: ${(e as Error).message}`;
        return;
      }
      body = Buffer.concat(chunks);
      timing.bytesIn = body.length;
    }
    // E2EE: agent_to_agent send goes through /api/bridge/<agentId>/send.
    // Encrypt the `content` field with the source agent's project key so
    // the server only forwards ciphertext. Target daemon decrypts on the
    // agent:send path. If we don't hold the key, fall through to plain.
    const encryptOr409 = (
      kind: BridgeEncryptKind,
      projectId: string,
      buf: Buffer,
      opts?: { parentName?: string },
    ): boolean => {
      try {
        const json = JSON.parse(buf.toString("utf8"));
        if (json && typeof json === "object") {
          // T-758: plaintext do goal só existe aqui, entre o parse e a cifra.
          // Sem await — o veredito não muda a rota nem o corpo. O try evita
          // que um throw da sombra caia no catch externo e suba o body em claro.
          if (kind === "delegate" && !Array.isArray(json)) {
            try { scheduleDelegateShadow(json, projectId); } catch { /* sombra não falha o delegate */ }
          }
          body = Buffer.from(JSON.stringify(encryptBridgePayload(kind, json, projectId, opts)), "utf8");
        }
        return true;
      } catch (e) {
        if (e instanceof E2eeRequiredError) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
          return false;
        }
        return true;
      }
    };
    if (body && body.length > 0 && this.agentProjectLookup) {
      const route = bridgeCipherRoute(parsed.pathname);
      if (route) {
        const projectId = this.agentProjectLookup(route.agentId);
        // T-581: delegate — goal/context viram mission+step no DB. O prompt
        // cifrado precisa do nome do pai (o subagente responde pra ele).
        const opts = route.kind === "delegate"
          ? { parentName: this.agentNameLookup?.(route.agentId) ?? route.agentId }
          : undefined;
        if (projectId && !encryptOr409(route.kind, projectId, body, opts)) return;
      }
    }
    // Strip headers that don't make sense to forward (host/connection/etc).
    const fwd: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (key === "host" || key === "connection" || key === "content-length") continue;
      if (Array.isArray(v)) fwd[k] = v.join(",");
      else if (typeof v === "string") fwd[k] = v;
    }
    try {
      const ctrl = new AbortController();
      const fetchTimer = setTimeout(
        () => ctrl.abort(new Error(`bridge relay timeout após ${BridgeRelay.UPSTREAM_FETCH_TIMEOUT_MS}ms`)),
        BridgeRelay.UPSTREAM_FETCH_TIMEOUT_MS,
      );
      // Client disconnect no Unix socket → cancela upstream (não deixa fetch órfão).
      // NÃO usar req 'close' (dispara após body consumido com client ainda vivo).
      const onClientGone = () => {
        try { ctrl.abort(new Error("bridge client disconnected")); } catch { /* */ }
      };
      req.once("aborted", onClientGone);
      res.once("close", () => {
        // close sem writableFinished = client desconectou mid-flight
        if (!res.writableFinished) onClientGone();
      });
      let upstream: Response;
      const upT0 = performance.now();
      try {
        upstream = await fetch(url, {
          method: req.method,
          headers: fwd,
          body: body && body.length ? new Uint8Array(body) : undefined,
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(fetchTimer);
        req.removeListener("aborted", onClientGone);
      }
      let buf = Buffer.from(await upstream.arrayBuffer());
      timing.upstreamMs = performance.now() - upT0;
      // E2EE: decrypt cipher fields in list-style responses so the LLM sees
      // plaintext. Server stores ciphertext per project; daemon holds the
      // project key and rewrites the response body in place before handing
      // it to the MCP bridge child.
      //
      // #596: a allowlist tinha só ops de LISTA. As ops que devolvem UMA task
      // (`tasks_get` e as confirmações de escrita) ficavam de fora — o agente
      // via `e2e:v2:…` no `get_task`/`add_task` enquanto `list_tasks full=true`
      // entregava em claro. Mesma classe de bug: rota de leitura do mesmo
      // campo com allowlist diferente.
      const m2 = parsed.pathname.match(/^\/api\/bridge\/([^/]+)\/(tasks_list|tasks_get|tasks_add|tasks_update|tasks_lock|tasks_unlock|tasks_comment_list|goals_list|memory_list|plans_list|plans_get|plans_create|plans_add_task|plans_apply_tasks)$/);
      if (m2 && this.agentProjectLookup && upstream.status === 200) {
        const agentId = m2[1];
        const op = m2[2];
        const projectId = this.agentProjectLookup(agentId);
        if (projectId) {
          try {
            const json = JSON.parse(buf.toString("utf8"));
            const dec = (s: unknown, table?: string, field?: string): unknown => {
              if (typeof s !== "string" || !isE2eEncrypted(s)) return s;
              if (!table || !field) return decryptForProject(s, projectId) ?? s;
              // T-083: destino primeiro, depois no máx. UMA fonte canônica.
              for (const aad of aadReadChain({ projectId, table, field })) {
                const p = decryptForProject(s, projectId, aad);
                if (p != null) return p;
              }
              return s;
            };
            const decTask = (t: any): void => {
              if (!t || typeof t !== "object") return;
              if (t.title) t.title = dec(t.title, E2EE_TABLE.TASKS, "title");
              if (t.description) t.description = dec(t.description, E2EE_TABLE.TASKS, "description");
            };
            const decryptPlanTasks = (tasks: any[]) => {
              for (const t of tasks) {
                // Snapshot do board (T-083): title/prompt herdados de
                // tasks.title / tasks.description. Fallback plan_tasks.*
                // p/ update_plan_task.
                if (t.title) {
                  const a = dec(t.title, E2EE_TABLE.TASKS, "title");
                  t.title = a !== t.title ? a : dec(t.title, E2EE_TABLE.PLAN_TASKS, "title");
                }
                if (t.prompt) {
                  const a = dec(t.prompt, E2EE_TABLE.TASKS, "description");
                  t.prompt = a !== t.prompt ? a : dec(t.prompt, E2EE_TABLE.PLAN_TASKS, "prompt");
                }
                if (t.output) t.output = dec(t.output, E2EE_TABLE.PLAN_TASKS, "output");
              }
            };
            if (op === "tasks_list" && Array.isArray(json.tasks)) {
              for (const t of json.tasks) decTask(t);
            } else if (TASK_SINGLE_OPS.has(op) && json.task && typeof json.task === "object") {
              // #596: tasks_get / tasks_add / tasks_update / tasks_lock /
              // tasks_unlock devolvem `{ task }` — a mesma projeção cifrada
              // que o tasks_list. Sem isto o agente recebe o blob no lugar do
              // texto (e o `update_task` "confirma" com ciphertext).
              //
              // Gate por OP (e não só por `json.task`) de propósito: `plans_*`
              // devolve `{ plan }` e o ramo do plano tem de continuar sendo
              // alcançado. Um `else if` só por forma de campo engoliria
              // qualquer op futura que carregue `task` de outra tabela.
              decTask(json.task);
              // T-852: sombra do Jev nas tasks. Só aqui o `task` da resposta
              // 2xx existe já decifrado; o request só decide evento/skip.
              if (op === "tasks_add" || op === "tasks_update") {
                try { scheduleTaskShadow({ op, projectId, task: json.task, patch: camposDoPatch(body) }); } catch { /* sombra não falha a task */ }
              }
            } else if (op === "tasks_comment_list" && Array.isArray(json.comments)) {
              for (const c of json.comments) {
                if (c.content) c.content = dec(c.content, E2EE_TABLE.TASK_COMMENTS, "content");
              }
            } else if (op === "goals_list" && Array.isArray(json.goals)) {
              for (const g of json.goals) {
                if (g.title) g.title = dec(g.title, E2EE_TABLE.GOALS, "title");
                if (g.description) g.description = dec(g.description, E2EE_TABLE.GOALS, "description");
              }
            } else if (op === "memory_list" && Array.isArray(json.memories)) {
              // entrega title/body em plaintext pro agente (a tool recall
              // filtra query/substring sobre isto). Mantém os campos cipher.
              for (const e of json.memories) {
                if (e.titleCipher) e.title = dec(e.titleCipher, E2EE_TABLE.MEMORIES, "title");
                if (e.bodyCipher) e.body = dec(e.bodyCipher, E2EE_TABLE.MEMORIES, "body");
              }
            } else if (op === "plans_list" && Array.isArray(json.plans)) {
              for (const p of json.plans) {
                if (p.title) p.title = dec(p.title, E2EE_TABLE.PLANS, "title");
                if (p.description) p.description = dec(p.description, E2EE_TABLE.PLANS, "description");
                if (Array.isArray(p.tasks)) decryptPlanTasks(p.tasks);
              }
            } else if ((op === "plans_get" || op === "plans_create" || op === "plans_add_task" || op === "plans_apply_tasks") && json.plan) {
              if (json.plan.title) json.plan.title = dec(json.plan.title, E2EE_TABLE.PLANS, "title");
              if (json.plan.description) json.plan.description = dec(json.plan.description, E2EE_TABLE.PLANS, "description");
              if (Array.isArray(json.plan.tasks)) decryptPlanTasks(json.plan.tasks);
            }
            buf = Buffer.from(JSON.stringify(json), "utf8");
          } catch { /* leave as-is on parse / decrypt failure */ }
        }
      }
      // get_credential: o server devolve o value como o que está guardado —
      // blob "e2e:" (projeto E2EE, server não decifra) ou plaintext (legacy /
      // não-E2EE). O daemon tem a project key → decifra aqui antes de entregar
      // ao agente, e registra o plaintext pra mascarar no egresso do agente.
      const mCred = parsed.pathname.match(/^\/api\/bridge\/([^/]+)\/get_credential$/);
      if (mCred && this.agentProjectLookup && upstream.status === 200) {
        const projectId = this.agentProjectLookup(mCred[1]);
        if (projectId) {
          try {
            const json = JSON.parse(buf.toString("utf8"));
            if (typeof json.value === "string") {
              if (isE2eEncrypted(json.value)) {
                const dec = decryptForProject(
                  json.value,
                  projectId,
                  aadV2({ projectId, table: E2EE_TABLE.CREDENTIALS, field: "value" }),
                );
                if (dec != null) {
                  json.value = dec;
                  rememberCredentialPlaintext(projectId, dec);
                } else {
                  // E2EE mas o daemon não tem a project key (restart antes de
                  // re-receber o wrap). NÃO entrega o blob como se fosse o
                  // segredo — devolve erro claro pro agente.
                  json.error = "credential is E2EE but project key not held by daemon";
                  delete json.value;
                }
              } else {
                // plaintext (legacy / não-E2EE) — registra pra redact do egresso.
                rememberCredentialPlaintext(projectId, json.value);
              }
              buf = Buffer.from(JSON.stringify(json), "utf8");
            }
          } catch { /* leave as-is */ }
        }
      }
      res.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "Content-Length": String(buf.length),
      });
      res.end(buf);
    } catch (e) {
      timing.error = String((e as Error).message ?? e).slice(0, 300);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `relay failed: ${(e as Error).message}` }));
    }
  }
}
