import path from "node:path";
import fs from "node:fs";
import {AgentRunner, type AgentRunnerOptions} from "./agent-runner.js";
import {breadcrumb, captureWarn} from "./sentry.js";
import {assertWorkspaceScoped, autoWorkspaceCwd, cloneRepoIfMissing, expandBasePath, findGitRoot, getWorkspaceRoot, isInsideRoot, repoCwd} from "./workspace.js";
import {aadV2, E2EE_TABLE, MIGRATE_SEED_DROPPED_REASON, MIGRATE_SEED_RESUME_SKIPS_REASON} from "@the-dudes/protocol/e2ee-fields";
import {decryptForProject, encryptForProject, isE2eEncrypted, isE2eeRequired, setE2eeRequired, redactCredentials, redactCredentialsDeep} from "./daemon-crypto.js";
import {classifyRunnerFailure} from "./runners/error-classifier.js";
import {migratedSeedFor, MIGRATED_SEED_LIMIT_BYTES} from "./migrated-seed.js";

/** 1 enum operacional (paridade hung.soft). Classifica no plaintext ANTES do seal. */
export type AgentErrorKind = "rate_limit" | "other";

export function agentErrorKind(plain: string): AgentErrorKind {
  return classifyRunnerFailure(plain) === "rate_limit" ? "rate_limit" : "other";
}

/**
 * A13 (T-425): `git worktree add` isolado do agent-host.
 *  - spawnDropped com drop (quando o daemon roda como root);
 *  - env por allowlist (buildSummarizerEnv) — antes era spawnSync herdando
 *    process.env inteiro e sem drop;
 *  - `--` antes do path (mesmo contrato do task-workspace/T-424).
 */
export function runGitWorktreeAdd(
  gitRoot: string,
  branchName: string,
  worktreePath: string,
  drop: DropTarget | null = null,
): Promise<{ error?: Error; status: number | null; stderr: string }> {
  // R8 (T-463): helper central (env mínimo + spawnDropped + timeout de grupo).
  return runGit(gitRoot, ["worktree", "add", "-b", branchName, "--", worktreePath], { drop }).then((r) => ({
    error: r.timedOut ? new Error("git worktree add timeout") : undefined,
    status: r.ok ? 0 : (r.status ?? 1),
    stderr: r.stderr,
  }));
}

/**
 * T-092: cifra stderr/erro com o mesmo AAD de agent:text (`messages.content`).
 * Sem chave + e2ee-required → null (caller DROP). Sem projectId → plaintext redatado.
 */
export function sealAgentErrorMessage(projectId: string | undefined, message: string): string | null {
  const raw = String(message ?? "");
  const red = projectId ? redactCredentials(projectId, raw) : raw;
  if (!projectId) return red;
  const enc = encryptForProject(
    red,
    projectId,
    aadV2({ projectId, table: E2EE_TABLE.MESSAGES, field: "content" }),
  );
  if (enc) return enc;
  if (isE2eeRequired(projectId)) return null;
  return red;
}

import type {ResolvedCliCommands} from "./cli-config.js";
import type {AgentInfo, ImageAttachment} from "./types.js";
import type {AgentSpawn, FromDaemon} from "./protocol.js";
import {type DropTarget} from "./privileges.js";
import {runGit} from "./runners/run-git.js";

import {compatibleSessionId} from "./runners/index.js";
import {createAgentInboundBuffer} from "./inbound-dedup.js";

// Works in both CJS bundle (where __dirname is native) and ESM dev (tsx)
// where we fall back to the process entry script.
const baseDir: string = (() => {
  // __dirname só existe no bundle CJS; em ESM (tsx) o typeof cai no else.
  if (typeof __dirname !== "undefined") return __dirname as string;
  const entry = process.argv[1] || ".";
  return path.dirname(path.resolve(entry));
})();

function resolveBridge(): { command: string; args: string[] } {
  // P2 (T-474): em dev (entry .ts via tsx) a FONTE vence cjs/js stale em
  // daemon/src — antes um daemon.cjs velho deixado por build local sombreava
  // o mcp-bridge.ts e o daemon rodava código antigo.
  const runningFromTs = String(process.argv[1] ?? "").endsWith(".ts");
  const bundled = path.resolve(baseDir, "mcp-bridge.cjs");
  if (!runningFromTs && fs.existsSync(bundled)) return { command: "node", args: [bundled] };
  // Compiled tsc output
  const compiled = path.resolve(baseDir, "mcp-bridge.js");
  if (!runningFromTs && fs.existsSync(compiled)) return { command: "node", args: [compiled] };
  // Dev: tsx + .ts source
  const source = path.resolve(baseDir, "mcp-bridge.ts");
  const tsxBin = (() => {
    const candidates = [
      path.resolve(baseDir, "../node_modules/.bin/tsx"),
      path.resolve(baseDir, "../../node_modules/.bin/tsx"),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return "tsx";
  })();
  return { command: tsxBin, args: [source] };
}

interface Entry {
  info: AgentInfo;
  runner: AgentRunner | null;
  autoApprove: boolean;
  /** Project ID, captured at spawn. Used to look up the E2EE key when
   *  the bridge relay needs to encrypt/decrypt agent_to_agent traffic. */
  projectId?: string;
  /** Agent token (passed via THE_DUDES_AGENT_TOKEN env). Necessário
   *  pra ressincronizar com o server após restart — server perde o
   *  Map agentTokens (in-memory) mas o processo mcp-bridge segue
   *  rodando com o token antigo. Daemon devolve no resync. */
  agentToken?: string;
  /** Espelho Telegram: chat vinculado pra onde TODA saída do agente é
   *  encaminhada (texto em claro). Setado via agent:send.telegram. */
  telegramMirror?: { botToken: string; chatId: string };
  /** M25 (T-448): worktree isolado deste agente (removido em stop/shutdown).
   *  Sem isto o par (path, gitRoot) perdia-se no escopo do spawn e os
   *  worktrees antigos acumulavam em `<repo>/../worktrees`. */
  worktreePath?: string;
  gitRoot?: string;
}

/**
 * M25 (T-448): remove o worktree de um agente (best-effort, com fallback).
 * `git worktree remove --force` limpa também o metadata (.git/worktrees);
 * se o git falhar (dir já apagado/lock), rmSync + `git worktree prune`.
 */
export function runGitWorktreeRemove(
  gitRoot: string,
  worktreePath: string,
  drop: DropTarget | null = null,
): Promise<{ ok: boolean; detail?: string }> {
  const run = (args: string[]) => runGit(gitRoot, args, { drop });
  return run(["worktree", "remove", "--force", "--", worktreePath]).then(async (r) => {
    if (r.ok) return { ok: true };
    const detail = r.timedOut ? "timeout" : (r.stderr || `exit ${r.status}`);
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* já limpo */ }
    const pr = await run(["worktree", "prune"]);
    if (pr.ok) return { ok: true, detail: `fallback rm+prune (${detail})` };
    return { ok: false, detail };
  });
}

export class AgentHost {
  private entries = new Map<string, Entry>();
  /** T-037: agent:send chegando antes do runner (gap pós-spawn/self-update). */
  private inboundBuffer = createAgentInboundBuffer({ maxPerAgent: 20 });

  /** Quantos agentes este daemon mantém vivos — indicador de saúde da UI. */
  agentCount(): number {
    return this.entries.size;
  }

  /** M18 (T-441): algum runner com turno VIVO fora do turn-gate (claude
   *  contínuo). O idle do self-update precisa consultar isto além do gate. */
  hasActiveTurn(): boolean {
    for (const e of this.entries.values()) {
      if (e.runner?.isTurnActive()) return true;
    }
    return false;
  }
  private autoApproveDefault = false;
  /** Liga watch debounced do grafo (setado pelo DaemonClient). */
  onGraphWatch?: (workspaceRoot: string, graphifyBin: string, projectId?: string) => void;

  /**
   * Após reindex bem-sucedido: injeta graphify MCP nos agentes já rodando
   * com features.graph (reescreve configs no disco).
   */
  refreshGraphifyMcpForAgents(mcpCommand: string, gPath: string): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (!e.runner) continue;
      try {
        if (e.runner.refreshGraphifyMcp(mcpCommand, gPath)) n++;
      } catch { /* skip */ }
    }
    return n;
  }

  constructor(
    /** Retorna false se o frame não foi entregue ao socket (WS down/backpressure). */
    private send: (msg: FromDaemon) => boolean | void,
    private dropTo: DropTarget | null = null,
    private bridgeSocketPath: string | null = null,
    private cliCommands: ResolvedCliCommands,
    private verbose: boolean = false,
    private verboseHuman: boolean = false,
    private verboseHumanIo: boolean = false,
    private log: (level: "info" | "warn" | "error", msg: string) => void = () => {},
    private cliLog: (level: "info" | "warn" | "error", msg: string) => void = () => {},
  ) {}

  /** true se o canal aceitou o frame (void legado = assume ok). */
  private deliver(msg: FromDaemon): boolean {
    const r = this.send(msg);
    return r !== false;
  }

  /** Emite agent:error cifrado (messages.content) ou DROP se e2ee-required sem chave. */
  private emitAgentError(agentId: string, message: string, projectId?: string): void {
    const pid = projectId ?? this.entries.get(agentId)?.projectId;
    const errorKind = agentErrorKind(message);
    const sealed = sealAgentErrorMessage(pid, message);
    if (sealed == null) {
      this.log("error", `agent:error recusado: e2ee-required sem chave project=${pid}`);
      return;
    }
    this.deliver({ type: "agent:error", agentId, message: sealed, errorKind });
  }

  /** Returns the project ID this agent is spawned into, or null if the
   *  agent isn't tracked locally (e.g. message destined for an agent on
   *  another daemon — bridge relay falls back to passing through). */
  getAgentProjectId(agentId: string): string | null {
    return this.entries.get(agentId)?.projectId ?? null;
  }

  /** T-581: nome do agente — o relay usa no prompt de delegação cifrado. */
  getAgentName(agentId: string): string | null {
    return this.entries.get(agentId)?.info.name ?? null;
  }

  /** T-233: task ativa do agente — pass-through pro runner. Fonte
   *  autoritativa: server via agent:send.taskId / task:updated done. */
  setActiveTask(agentId: string, taskId: string): void {
    this.entries.get(agentId)?.runner?.setActiveTask(taskId);
  }

  clearActiveTask(agentId: string, taskId?: string): void {
    this.entries.get(agentId)?.runner?.clearActiveTask(taskId);
  }

  /** T-343: reflexão episódica no done (best-effort; o runner impõe guards
   *  de idle/sessão/cooldown). titleCipher é o título cifrado do task (o
   *  daemon decripta com a key do projeto do agente). */
  noteTaskDone(agentId: string, taskId: string, titleCipher?: string): void {
    const e = this.entries.get(agentId);
    if (!e?.runner || !e.projectId) return;
    let title: string | undefined;
    if (titleCipher) {
      title = isE2eEncrypted(titleCipher)
        ? decryptForProject(titleCipher, e.projectId, aadV2({ projectId: e.projectId, table: E2EE_TABLE.TASKS, field: "title" })) ?? undefined
        : titleCipher;
    }
    void e.runner.noteTaskDone(taskId, title);
  }

  /** Vincula/desvincula o agente a um chat do Telegram (espelho de saída). */
  setTelegramMirror(agentId: string, mirror: { botToken: string; chatId: string } | null): void {
    const e = this.entries.get(agentId);
    if (!e) return;
    e.telegramMirror = mirror ?? undefined;
  }

  /** Encaminha um texto pro chat do Telegram via Bot API (egress local, SSRF
   *  guard). Best-effort: falha não derruba o turno do agente. */
  private async mirrorToTelegram(mirror: { botToken: string; chatId: string }, text: string): Promise<void> {
    try {
      const { safeFetch } = await import("./ssrf-guard.js");
      const url = `https://api.telegram.org/bot${mirror.botToken}/sendMessage`;
      // Telegram corta em 4096 chars/mensagem.
      const body = JSON.stringify({ chat_id: mirror.chatId, text: text.slice(0, 4096), disable_web_page_preview: true });
      await safeFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }, { maxRedirects: 0 });
    } catch (e) {
      // Redact o token do bot caso o erro (undici/cause) ecoe a URL.
      const safe = ((e as Error).message ?? "").replace(/bot\d+:[\w-]+/g, "bot***");
      this.log("warn", `[telegram-mirror] falha enviando pro chat ${mirror.chatId}: ${safe}`);
    }
  }

  setAutoApprove(value: boolean) {
    this.autoApproveDefault = value;
  }

  async spawn(msg: AgentSpawn): Promise<void> {
    if (msg.projectId && msg.e2eeRequired != null) setE2eeRequired(msg.projectId, !!msg.e2eeRequired);
    const existing = this.entries.get(msg.agent.id);
    if (existing?.runner) {
      // Distingue RECONNECT (WS reconectou; mesma config) de RECONFIG
      // (troca de runner/model/effort/… — server parou e re-spawnou). No
      // reconfig, o spawn pode chegar ANTES do runner antigo terminar de
      // sair (race com o fallback de 8s do server). Sem este check, o
      // re-broadcast abaixo re-attacha no runner VELHO e o novo nunca sobe
      // — agente fica mudo até reiniciar, OU (pior) segue com effort/model
      // antigo se só o effort mudou. Detecta a mudança e derruba o velho.
      const reconfig =
        existing.info?.cliRunner !== msg.agent.cliRunner ||
        existing.info?.model !== msg.agent.model ||
        existing.info?.effort !== msg.agent.effort ||
        existing.info?.collectThinking !== msg.agent.collectThinking ||
        existing.info?.planMode !== msg.agent.planMode ||
        existing.info?.claudeConfigDir !== msg.agent.claudeConfigDir ||
        // T-597 F1: pid diferente = re-spawn completo. O reconnect puro não
        // atualiza o entry (nem a closure do runner) e os DOIS selos ficariam
        // no pid velho — com o reconfig, entry e closure nascem juntos no pid
        // novo. Cobre também entry sem pid (daemon antigo) que passaria a
        // selar em plaintext no relay.
        existing.projectId !== msg.projectId;
      // M17 (T-440): reconnect só vale para runner VIVO. Claude cujo proc
      // nunca subiu (spawn error) ou morreu sem exit ficava marcado running e
      // nada rodava; aqui o cadáver cai no spawn completo abaixo.
      if (!reconfig && existing.runner.isAlive()) {
        // Reconnect puro — re-anuncia estado pro orchestrator reconciliar.
        // Re-anuncia o token: server perdeu o Map agentTokens (in-memory)
        // após restart e o mcp-bridge segue com o token antigo — sem isto
        // /api/bridge devolve 401 nas próximas chamadas.
        if (existing.agentToken) {
          this.send({ type: "agent:token_resync", agentId: msg.agent.id, token: existing.agentToken });
        }
        this.send({ type: "agent:running", agentId: msg.agent.id, running: true });
        const sid = existing.info?.sessionId ?? existing.runner.info?.sessionId;
        if (sid) this.send({ type: "agent:session", agentId: msg.agent.id, sessionId: sid });
        this.send({ type: "agent:state", agentId: msg.agent.id, state: existing.runner.currentRuntimeState() });
        return;
      }
      // Reconfig OU runner stale (M17): derruba o antigo antes de criar o
      // novo. Seu onExit tardio não vai zerar o novo (guard
      // `e.runner === thisRunner`).
      try { existing.runner.stop(); } catch { /* já morto */ }
      existing.runner = null;
    }

    // Resolve cwd:
    //   - agentRepo present → legacy path: cwdOverride/<repo.name>; clone repo there if missing.
    //   - agentRepo absent + cwdOverride → cwdOverride direct.
    //   - else detect git from basePath automatically; legacy repoName is only
    //     used when that subfolder already exists.
    let cwd: string;
    // Em container/scoped: os paths configurados na UI (basePath/cwdOverride)
    // são do HOST e podem não existir aqui. Se THE_DUDES_WORKSPACE_ROOT está
    // setado e o path cai fora dele, usa o próprio root (= a pasta montada,
    // ex: /workspace) — senão o agente nem inicia no daemon containerizado.
    const wsRoot = getWorkspaceRoot();
    const remap = (p: string | undefined): string | undefined =>
      (!p || !wsRoot || isInsideRoot(expandBasePath(p), wsRoot)) ? p : wsRoot;
    const cwdOverrideEff = remap(msg.cwdOverride);
    const basePathEff = remap(msg.basePath) ?? msg.basePath;
    if (wsRoot && (cwdOverrideEff !== msg.cwdOverride || basePathEff !== msg.basePath)) {
      this.emitAgentError(
        msg.agent.id,
        `workspace configurado fica fora do root permitido — usando "${wsRoot}" (THE_DUDES_WORKSPACE_ROOT)`,
        msg.projectId,
      );
    }
    if (msg.agentRepo && cwdOverrideEff) {
      const cwdOverride = expandBasePath(cwdOverrideEff);
      cwd = repoCwd(cwdOverride, msg.agentRepo.name);
      if (!fs.existsSync(path.join(cwd, ".git"))) {
        this.emitAgentError(
          msg.agent.id,
          `clonando ${msg.agentRepo.name} em ${cwd} …`,
          msg.projectId,
        );
        try {
          // ensure parent dir exists
          if (!fs.existsSync(cwdOverride)) {
            fs.mkdirSync(cwdOverride, { recursive: true });
            if (this.dropTo) try { fs.chownSync(cwdOverride, this.dropTo.uid, this.dropTo.gid); } catch {}
          }
          const result = await cloneRepoIfMissing(
            cwdOverride,
            { id: "agent", name: msg.agentRepo.name, gitUrl: msg.agentRepo.gitUrl, defaultBranch: msg.agentRepo.branch },
            this.dropTo,
          );
          if (!result.ok) {
            this.emitAgentError(
              msg.agent.id,
              `git clone falhou: ${result.message}`,
              msg.projectId,
            );
            this.send({ type: "agent:running", agentId: msg.agent.id, running: false });
            return;
          }
        } catch (e) {
          this.emitAgentError(
            msg.agent.id,
            `setup falhou: ${(e as Error).message}`,
            msg.projectId,
          );
          this.send({ type: "agent:running", agentId: msg.agent.id, running: false });
          return;
        }
      }
    } else if (cwdOverrideEff) {
      cwd = expandBasePath(cwdOverrideEff);
      if (!fs.existsSync(cwd)) {
        fs.mkdirSync(cwd, { recursive: true });
        if (this.dropTo) try { fs.chownSync(cwd, this.dropTo.uid, this.dropTo.gid); } catch {}
      }
    } else if (msg.repoName) {
      const legacyRepoCwd = repoCwd(expandBasePath(basePathEff), msg.repoName);
      cwd = fs.existsSync(legacyRepoCwd) ? legacyRepoCwd : autoWorkspaceCwd(basePathEff);
    } else {
      cwd = autoWorkspaceCwd(basePathEff);
      if (!fs.existsSync(cwd)) {
        fs.mkdirSync(cwd, { recursive: true });
        if (this.dropTo) try { fs.chownSync(cwd, this.dropTo.uid, this.dropTo.gid); } catch {}
      }
    }
    // Blast-radius: o cwd resolvido (incluindo cwdOverride vindo do server)
    // tem que estar dentro do THE_DUDES_WORKSPACE_ROOT, se configurado.
    try {
      assertWorkspaceScoped(cwd);
    } catch (e) {
      this.emitAgentError(msg.agent.id, (e as Error).message, msg.projectId);
      this.send({ type: "agent:running", agentId: msg.agent.id, running: false });
      return;
    }
    // Features no log: quando o agente "ignora" uma capacidade, a primeira
    // pergunta é se ela chegou até ele — sem isto não havia como saber.
    if (msg.features) {
      const f = msg.features;
      const on = Object.entries(f).filter(([, v]) => v === true).map(([k]) => k);
      this.log("info", `agent ${msg.agent.id} features: ${on.join(",") || "none"} diagram=${f.diagramLanguage ?? "mermaid"}`);
    }
    this.log("info", `agent ${msg.agent.id} cwd resolvido=${cwd}${wsRoot ? ` (root=${wsRoot})` : ""}`);
    if (!fs.existsSync(cwd)) {
      this.emitAgentError(
        msg.agent.id,
        `cwd "${cwd}" not found — set workspace and clone repos first`,
        msg.projectId,
      );
      this.send({ type: "agent:running", agentId: msg.agent.id, running: false });
      return;
    }

    // Git worktree isolation: create an isolated worktree for this agent
    // so it never shares the same working directory with other agents.
    let worktreePath: string | undefined;
    // M25 (T-448): captura o par (path, gitRoot) pro entry — o `gitRoot` local
    // do bloco não inclui a árvore do worktree (rev-parse dentro dele devolve o
    // próprio worktree).
    let agentWorktree: { path: string; gitRoot: string } | undefined;
    if (msg.agentWorktrees) {
      const gitRoot = findGitRoot(cwd);
      if (gitRoot) {
        const worktreesDir = path.join(gitRoot, "..", "worktrees");
        // Sanitiza o nome do agente ANTES de montar o path. Vinha cru aqui
        // (só branchName era limpo) — um nome com "../" colapsava via
        // path.join e o worktreePath apontava fora de worktreesDir, com
        // rmSync recursivo + git worktree add + chown rodando ANTES do
        // realpath-check (dano já feito).
        const safeName = msg.agent.name.replace(/[^a-zA-Z0-9_-]/g, "-");
        const idSuffix = msg.agent.id.slice(0, 8);
        const branchName = `agent/${safeName}-${idSuffix}`;
        worktreePath = path.join(worktreesDir, `${safeName}-${idSuffix}`);
        try {
          // Containment antes de qualquer operação destrutiva (rmSync/add/chown).
          if (!path.resolve(worktreePath).startsWith(path.resolve(worktreesDir) + path.sep)) {
            throw new Error(`worktree path escapou da base: ${worktreePath}`);
          }
          // E também dentro do workspace root permitido, se configurado.
          assertWorkspaceScoped(worktreePath);
          if (!fs.existsSync(worktreesDir)) {
            fs.mkdirSync(worktreesDir, { recursive: true });
            // chown pro user dropado — sem isso, daemon root cria dir
            // root-owned + CLI (uid=1000) não escreve dentro depois.
            if (this.dropTo) {
              try { fs.chownSync(worktreesDir, this.dropTo.uid, this.dropTo.gid); } catch {}
            }
          }
          if (fs.existsSync(worktreePath)) {
            fs.rmSync(worktreePath, { recursive: true, force: true });
          }
          // A13 (T-425): mesmo helper do graph-indexer — spawnDropped (drop
          // quando root) + env por allowlist; antes era spawnSync herdando
          // process.env inteiro e sem drop.
          const wtRes = await runGitWorktreeAdd(gitRoot, branchName, worktreePath, this.dropTo);
          if (wtRes.error || wtRes.status !== 0) {
            // Falha (branch já existe, HEAD destacado, árvore suja…). Não cair
            // silenciosamente no cwd compartilhado: avisa e mantém o cwd base.
            const detail = wtRes.error?.message ?? ((wtRes.stderr || "").trim() || `exit ${wtRes.status}`);
            this.emitAgentError(
              msg.agent.id,
              `worktree isolado falhou (${detail}) — agente roda no cwd compartilhado`,
              msg.projectId,
            );
            worktreePath = undefined;
          } else if (this.dropTo && fs.existsSync(worktreePath)) {
            // chown recursive — git worktree add criou árvore como root.
            try {
              const chownRecursive = (p: string) => {
                fs.chownSync(p, this.dropTo!.uid, this.dropTo!.gid);
                const st = fs.statSync(p);
                if (st.isDirectory()) {
                  for (const f of fs.readdirSync(p)) chownRecursive(path.join(p, f));
                }
              };
              chownRecursive(worktreePath);
            } catch {}
          }
          // Só segue se o worktree foi de fato criado (git ok acima).
          if (worktreePath) {
            // Defesa em profundidade: garantir que o worktree resolvido
            // não escapou da pasta de worktrees (symlink/race).
            const resolvedWt = fs.realpathSync(worktreePath);
            const resolvedBase = fs.realpathSync(worktreesDir);
            if (!resolvedWt.startsWith(resolvedBase + path.sep)) {
              fs.rmSync(worktreePath, { recursive: true, force: true });
              throw new Error(`worktree escapou da base: ${resolvedWt}`);
            }
            if (fs.existsSync(worktreePath)) {
              agentWorktree = { path: worktreePath, gitRoot };
              cwd = worktreePath;
              this.emitAgentError(
                msg.agent.id,
                `worktree isolado criado em ${worktreePath} (branch ${branchName})`,
                msg.projectId,
              );
            }
          }
        } catch (e) {
          // Não engolir silenciosamente: o throw aqui vem do escape-guard de
          // containment (path traversal / symlink) — é segurança, tem que
          // aparecer. Cai no cwd compartilhado depois de avisar.
          this.emitAgentError(
            msg.agent.id,
            `worktree isolado abortado: ${(e as Error).message}`,
            msg.projectId,
          );
        }
      }
    }

    const bridge = resolveBridge();
    const cliRunner = msg.agent.cliRunner ?? "claude";
    // Drop any session id that isn't valid for this runner. claude uses
    // UUIDs, opencode uses `ses_*`, codex uses opaque thread ids — passing
    // a wrong-format id makes the CLI exit immediately.
    const resumeSessionId = compatibleSessionId(cliRunner, msg.agent.sessionId);
    // Identidade do runner deste spawn. Usada no onExit pra só zerar
    // `e.runner` se ainda for ESTE runner — senão o exit tardio de um
    // runner antigo (troca de runner) zeraria o runner novo.
    let thisRunner: AgentRunner | null = null;
    const opts: AgentRunnerOptions = {
      bridgeCommand: bridge.command,
      bridgeArgs: bridge.args,
      orchestratorUrl: msg.orchUrl,
      agentToken: msg.agentToken,
      cliRunner,
      autoApprove: msg.autoApprove,
      workspaceRoot: cwd,
      resumeSessionId,
      dropTo: this.dropTo,
      bridgeSocketPath: this.bridgeSocketPath,
      extraMcpServers: msg.extraMcpServers,
      features: msg.features,
      cliCommands: this.cliCommands,
      verbose: this.verbose,
      verboseHuman: this.verboseHuman,
      verboseHumanIo: this.verboseHumanIo,
      log: this.log,
      cliLog: this.cliLog,
      onState: (state) => { this.deliver({ type: "agent:state", agentId: msg.agent.id, state }); },
      onHung: (info) => {
        this.deliver({
          type: "agent:hung",
          agentId: msg.agent.id,
          soft: info.soft,
          reason: info.reason,
          idleMs: info.idleMs,
          runner: cliRunner,
          // T-689: park (auto-continue esgotado) — o server emite o push ao
          // orquestrador. Campo ausente nos hards comuns (compat).
          ...(info.parked ? { parked: true } : {}),
        });
      },
      onAssistantText: (text) => {
        // Redact credenciais que o agente buscou (get_credential) e ecoou, ANTES
        // de cifrar — em projeto E2EE o server não vê o plaintext, então a
        // redação tem que ser aqui. Depois cifra com a project key. Sem key
        // (legacy/pre-bootstrap) cai pro plaintext já redatado.
        const red = msg.projectId ? redactCredentials(msg.projectId, text) : text;
        const enc = msg.projectId
          ? encryptForProject(red, msg.projectId, aadV2({ projectId: msg.projectId, table: E2EE_TABLE.MESSAGES, field: "content" }))
          : null;
        if (msg.projectId && isE2eeRequired(msg.projectId) && !enc) {
          this.log("error", `agent:text recusado: e2ee-required sem chave project=${msg.projectId}`);
          this.emitAgentError(msg.agent.id, "e2ee-required: sem chave do projeto — texto não enviado", msg.projectId);
          return true;
        }
        const ok = this.deliver({ type: "agent:text", agentId: msg.agent.id, text: enc ?? red });
        // Espelho Telegram: encaminha a MESMA resposta (em claro, já redatada)
        // pro chat vinculado. Server é E2EE-cego, por isso o mirror é aqui.
        const mirror = this.entries.get(msg.agent.id)?.telegramMirror;
        if (mirror && red.trim()) void this.mirrorToTelegram(mirror, red);
        return ok;
      },
      onToolUse: (toolName, input) => {
        this.deliver({
          type: "agent:tool_use",
          agentId: msg.agent.id,
          toolName,
          // tool_use.input vai cru pro server (não cifrado); redact aqui as
          // credenciais conhecidas (ex `curl -H "Authorization: Bearer <cred>"`).
          input: msg.projectId ? redactCredentialsDeep(msg.projectId, input) : input,
        });
      },
      onThinkingText: (text, thinkOpts) => {
        const red = msg.projectId ? redactCredentials(msg.projectId, text) : text;
        const enc = msg.projectId ? encryptForProject(red, msg.projectId) : null;
        if (msg.projectId && isE2eeRequired(msg.projectId) && !enc) {
          this.log("error", `agent:thinking recusado: e2ee-required sem chave project=${msg.projectId}`);
          return;
        }
        this.deliver({ type: "agent:thinking", agentId: msg.agent.id, text: enc ?? red, redacted: !!thinkOpts?.redacted });
      },
      onSessionId: (sid) => { this.deliver({ type: "agent:session", agentId: msg.agent.id, sessionId: sid }); },
      onUsageDelta: (delta) => { this.deliver({ type: "agent:usage_delta", agentId: msg.agent.id, delta }); },
      onSessionInvalid: () => {
        this.emitAgentError(
          msg.agent.id,
          "[ctx] sessão anterior não encontrada — iniciando sessão nova",
          msg.projectId,
        );
      },
      onContextUsage: (used, limit) => { this.deliver({ type: "agent:context", agentId: msg.agent.id, used, limit }); },
      onContextWarning: (used, limit) => { this.deliver({ type: "agent:context_warning", agentId: msg.agent.id, used, limit }); },
      onContextFull: () => { this.deliver({ type: "agent:context_full", agentId: msg.agent.id }); },
      projectId: msg.projectId,
      onGraphStatus: (status, info) => {
        this.deliver({
          type: "graph:status",
          projectId: msg.projectId,
          status,
          nodeCount: info?.nodeCount,
          edgeCount: info?.edgeCount,
          error: info?.error,
          progress: info?.progress,
          phase: info?.phase,
          indexMtime: info?.indexMtime,
          stale: info?.stale,
          graphifyAvailable: info?.graphifyAvailable,
          graphifyMcpAvailable: info?.graphifyMcpAvailable,
          docsPending: info?.docsPending,
          hasSemantic: info?.hasSemantic,
        });
      },
      onGraphWatch: (root, gbin) => this.onGraphWatch?.(root, gbin, msg.projectId),
      onError: (err) => {
        // T-092: redact + cifra (messages.content), paridade com agent:text.
        this.emitAgentError(msg.agent.id, String(err ?? ""), msg.projectId);
      },
      onExit: (code) => {
        const e = this.entries.get(msg.agent.id);
        // Se este runner já foi substituído (reconfig/troca de runner), seu
        // exit tardio NÃO deve mexer no estado do agente — senão derruba o
        // runner novo que acabou de subir. Só o runner ativo reporta exit.
        if (e && e.runner !== thisRunner) {
          breadcrumb("agent", "exit-superseded", { agentId: msg.agent.id, code, runner: cliRunner });
          return;
        }
        if (e) e.runner = null;
        if (this.reexecuting) {
          // T-710b: re-exec do self-update — sem exit/running false (ver `reexecuting`).
          breadcrumb("agent", "exit-reexec", { agentId: msg.agent.id, code, runner: cliRunner });
          return;
        }
        this.deliver({ type: "agent:exit", agentId: msg.agent.id, code });
        this.deliver({ type: "agent:running", agentId: msg.agent.id, running: false });
        breadcrumb("agent", "exit", { agentId: msg.agent.id, code, runner: cliRunner });
        // Exit code 0 = normal; null = signal kill (provavelmente intencional);
        // resto = crash inesperado, vale capture.
        if (code !== 0 && code !== null) {
          captureWarn(`agent runner exited code=${code}`, {
            agentId: msg.agent.id,
            agentName: msg.agent.name,
            runner: cliRunner,
            code,
          });
        }
      },
    };
    const runner = new AgentRunner(msg.agent, opts);
    thisRunner = runner;
    runner.start().catch((e) => this.log("error", `agent ${msg.agent.id} start failed: ${(e as Error).message}`));
    this.entries.set(msg.agent.id, {
      info: msg.agent,
      runner,
      autoApprove: msg.autoApprove,
      projectId: msg.projectId,
      agentToken: msg.agentToken,
      ...(agentWorktree ? { worktreePath: agentWorktree.path, gitRoot: agentWorktree.gitRoot } : {}),
    });
    this.send({ type: "agent:running", agentId: msg.agent.id, running: true });
    // T-360/T-365: seed de migração cross-runner. É o PRIMEIRO input do usuário —
    // antes do flush do buffer, senão a mensagem que originou o spawn chegaria na
    // frente do contexto migrado. O digest chega CRU (cifrado sob E2EE): abrir a
    // chave, medir o limite e escrever a tag é trabalho daqui.
    const seedResult = migratedSeedFor(msg.agent, resumeSessionId, {
      projectId: msg.projectId,
      decrypt: (blob, projectId) => decryptForProject(
        blob,
        projectId,
        aadV2({ projectId, table: E2EE_TABLE.SUMMARIES, field: "summary" }),
      ),
    });
    if (seedResult.seed) {
      runner.pushUserMessage(seedResult.seed);
      this.log(
        "info",
        `migrate seed agent=${msg.agent.id} runner=${cliRunner} bytes=${seedResult.seed.length}`
        + (seedResult.truncated ? " (digest cortado ao limite de 8 KB)" : ""),
      );
      if (seedResult.truncated) {
        this.log("warn", `[migrate:${msg.agent.name}] digest excedia ${MIGRATED_SEED_LIMIT_BYTES} bytes em plaintext — cortado antes de injetar`);
      }
    } else if (seedResult.dropped) {
      // T-370: toda queda do seed é declarada — `no_key` (injetar era alimentar
      // o runner com base64) e `resume_skips_seed` (o resume ganhou; pode ter
      // nascido noutra família de CLI). O evento vai SEMPRE sem selo (H-092):
      // metadados fixos — constante do código + ids, zero bytes de conteúdo.
      const reason = seedResult.reason;
      this.log(
        "warn",
        reason === "resume_skips_seed"
          ? `[migrate:${msg.agent.name}] sessão retomada no runner alvo — seed de migração deixado de lado`
          : `[migrate:${msg.agent.name}] seed de migração cifrado sem chave do projeto — agente arranca sem contexto migrado`,
      );
      this.deliver({
        type: "agent:error",
        agentId: msg.agent.id,
        message: reason === "resume_skips_seed" ? MIGRATE_SEED_RESUME_SKIPS_REASON : MIGRATE_SEED_DROPPED_REASON,
        errorKind: "other",
        migrationId: msg.agent.seedFrom?.migrationId,
      });
    }
    // T-037: agent:send que chegou no gap pré-spawn (self-update / auto-resume)
    this.flushInboundBuffer(msg.agent.id);
  }

  listAgentTokens(): { id: string; token: string }[] {
    const out: { id: string; token: string }[] = [];
    for (const [id, e] of this.entries) {
      if (e.runner && e.agentToken) out.push({ id, token: e.agentToken });
    }
    return out;
  }

  stop(agentId: string) {
    const e = this.entries.get(agentId);
    if (!e?.runner) return;
    e.runner.stop();
    // M25 (T-448): worktree do agente pára com ele — hoje ficava no disco.
    void this.removeWorktreeOf(e);
  }

  /** M25 (T-448): remove (1×) o worktree do entry. Limpa o campo antes pra
   *  stop/shutdown duplo não repetir. */
  private removeWorktreeOf(e: Entry): Promise<void> {
    const wt = e.worktreePath;
    const gitRoot = e.gitRoot;
    if (!wt || !gitRoot) return Promise.resolve();
    e.worktreePath = undefined;
    return runGitWorktreeRemove(gitRoot, wt, this.dropTo)
      .then((r) => this.log(r.ok ? "info" : "warn", `[worktree] ${r.ok ? "removido" : "remoção falhou"} ${wt}${r.detail ? ` (${r.detail})` : ""}`))
      .catch((err) => this.log("warn", `[worktree] remoção falhou ${wt}: ${(err as Error).message}`));
  }

  send_message(agentId: string, content: string, images?: ImageAttachment[], deliveryId?: string) {
    const e = this.entries.get(agentId);
    if (!e?.runner) {
      // T-037: em vez de dropar, buffera até o spawn (gap self-update / auto-resume).
      // Se o agente nunca subir, TTL 15min limpa. Antes: drop + agent:error e a
      // TASK_ASSIGN sumia mesmo com o server reenviando.
      this.inboundBuffer.push(agentId, {
        deliveryId,
        content,
        images,
        enqueuedAt: Date.now(),
      });
      this.log(
        "warn",
        `send_message para ${agentId} sem runner ativo (entry=${e ? "existe" : "ausente"}) — enfileirado (${this.inboundBuffer.size(agentId)} pending)`,
      );
      return;
    }
    e.runner.pushUserMessage(content, images);
  }

  /** Chamado após spawn bem-sucedido — drena fila local T-037. */
  flushInboundBuffer(agentId: string): number {
    const pending = this.inboundBuffer.drain(agentId);
    const e = this.entries.get(agentId);
    if (!e?.runner || pending.length === 0) return 0;
    for (const m of pending) {
      e.runner.pushUserMessage(m.content, m.images as ImageAttachment[] | undefined);
    }
    this.log("info", `flushInboundBuffer agent=${agentId} entregou ${pending.length} msg(s) buffered`);
    return pending.length;
  }

  async clear(agentId: string) {
    const e = this.entries.get(agentId);
    if (!e?.runner) return;
    try { await e.runner.clearContext(); } catch (err) {
      this.emitAgentError(agentId, `clear failed: ${(err as Error).message}`);
    }
  }

  async compact(agentId: string, saveMemory = true) {
    const e = this.entries.get(agentId);
    if (!e?.runner) return;
    try { await e.runner.compactContext(saveMemory); } catch (err) {
      this.emitAgentError(agentId, `compact failed: ${(err as Error).message}`);
    }
  }

  /** M25 (T-448): async — além de parar os runners, remove os worktrees
   *  (com teto de 2s; main espera 2.5s antes do re-exec). */
  /** T-710b: re-exec do self-update em curso — os CLIs morrem, mas o agente
   *  NÃO parou para o time. onExit não anuncia exit/running false ao server
   *  (ele seguiria marcando parada normal, e o hello do processo novo não
   *  teria o que religar). O server mantém running=true, a graça de offline
   *  cobre o gap e o replay do hello re-spawna. Processo novo que não volta:
   *  a graça expira e daemonWentOffline marca + auto-resume. */
  private reexecuting = false;

  /** @param opts.reexec re-exec do self-update (exit 42): não anuncia exit.
   *  Shutdown normal (SIGTERM/stop): anuncia, como sempre.
   *  @returns quantos agentes com runner foram parados (mantidos running no server se reexec). */
  async shutdown(opts: { reexec?: boolean } = {}): Promise<number> {
    if (opts.reexec) this.reexecuting = true;
    let comRunner = 0;
    const removals: Promise<void>[] = [];
    for (const e of this.entries.values()) {
      if (e.runner) comRunner++;
      if (e.runner) try { e.runner.stop(); } catch {}
      removals.push(this.removeWorktreeOf(e));
    }
    await Promise.race([
      Promise.allSettled(removals),
      new Promise<void>((r) => setTimeout(r, 2_000)),
    ]);
    return comRunner;
  }
}
