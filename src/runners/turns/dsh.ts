/**
 * T-690: cliente ACP v1 (Agent Client Protocol) sobre stdio NDJSON para o
 * runner `dsh` (DeepSeek Harness, `dsh --profile acp`).
 *
 * Contrato (README do dsh-acp, doc-fonte no host):
 *  - stdout é SÓ protocolo (JSON-RPC 2.0 por linha); logs vão p/ stderr.
 *  - Fluxo: initialize → session/new{cwd, mcpServers} → set_config_option
 *    (model; reasoning_effort quando setado) → session/prompt por turno.
 *  - Restart do daemon → session/resume(sessionId) SEM replay (o log é durável
 *    e o system prompt NÃO é re-injetado).
 *  - Updates: session/update com update.sessionUpdate = agent_message_chunk
 *    (texto), agent_thought_chunk (thinking), tool_call/tool_call_update
 *    (tool), usage_update, config_option_update.
 *  - session/request_permission (request do server) é auto-respondido com
 *    allow_once.
 *
 * Este módulo é o transporte puro (sem política de turno): o turn handler
 * decide o que fazer com cada evento.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { accessSync, constants as fsConstants } from "node:fs";
import { spawnDropped } from "../../privileges.js";
import { appendPathAttachmentPrompt } from "../attachments.js";
import { compatibleSessionId } from "../index.js";
import type { AgentUsage, ImageAttachment } from "../../types.js";
import { acpPermissionDecisionForTurn, markNonOwnerMessage, type InboundTurnPrincipal } from "../turn-security.js";

/** Args de spawn do binário dsh (contrato: `dsh --profile acp`). */
export const DSH_ACP_ARGS = ["--profile", "acp"] as const;

/** Default do runner: a rota `deepseek-official` falha sem API key (-32603). */
export const DSH_DEFAULT_MODEL = '["dsflash","deepseek-flash-41"]';

/** T-796: rota SEM chave neste host. A credencial presente é DSFLASH_API_KEY
 *  (docs/DAEMON.md) — `deepseek-official` responde `-32603: no API key for
 *  provider route "deepseek-official"` no prompt. */
export const DSH_KEYLESS_ROUTE = "deepseek-official";

/** Rota (1º elemento do par opaco `["rota","modelo"]`) ou null se o value não
 *  segue o formato de par. */
export function dshModelRoute(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && typeof parsed[0] === "string") return parsed[0];
  } catch { /* value opaco fora do formato par */ }
  return null;
}

/**
 * T-796: modelo que o TURNO usa. O catálogo ACP do dsh marca o par
 * `["deepseek-official","deepseek-v4-flash"]` como default (medido no host
 * 2026-09-22) — um agente criado a partir do catálogo chega com esse model
 * preenchido e o prompt ia para a rota sem chave, falhando em ~180ms com
 * `-32603` (os 8 agentes de 15:07:23Z). Sem model OU em rota sem chave →
 * dsflash; model explícito de rota com chave é preservado.
 */
export function dshModelForTurn(model?: string): string {
  const m = typeof model === "string" ? model.trim() : "";
  if (!m) return DSH_DEFAULT_MODEL;
  return dshModelRoute(m) === DSH_KEYLESS_ROUTE ? DSH_DEFAULT_MODEL : m;
}

export interface DshConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: unknown[];
}

export interface DshMcpServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** Par name/value do wire ACP (EnvVariable / HttpHeader). */
export interface AcpNameValue {
  name: string;
  value: string;
}

/**
 * Forma no fio ACP v1. O schema do SDK (`x-deserialize-skip-invalid-items`)
 * DESCARTA silenciosamente itens inválidos — env Record ou command relativo
 * some da sessão e o modelo nunca vê as tools. dsh-acp ainda exige command
 * absoluto depois da deserialização.
 */
export type AcpMcpServerWire =
  | { name: string; command: string; args: string[]; env: AcpNameValue[] }
  | { type: "http"; name: string; url: string; headers: AcpNameValue[] };

function recordToNameValues(rec?: Record<string, string>): AcpNameValue[] {
  if (!rec) return [];
  const out: AcpNameValue[] = [];
  for (const [name, value] of Object.entries(rec)) {
    if (typeof value !== "string") continue;
    if (!name || name.includes("=") || name.includes("\0") || value.includes("\0")) continue;
    out.push({ name, value });
  }
  return out;
}

/** T-726 (a): o ACP do dsh exige command ABSOLUTO. Antes um comando relativo
 *  lançava e derrubava o handshake inteiro — o MCP playwright do projeto é
 *  `npx -y @playwright/mcp` e nenhum agente dsh subia. Agora resolve pelo PATH
 *  do processo do daemon (mesmo PATH que o dsh herdaria) e devolve null se não
 *  achar; quem chama decide (extra some, bridge é fatal). */
export function resolveAcpCommand(command: string | undefined): string | null {
  if (!command) return null;
  if (isAbsolute(command)) return command;
  if (command === "node" || command === "nodejs") return process.execPath;
  if (command.includes("/")) return null; // relativo ao cwd: ambíguo no ACP
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const cand = join(dir, command);
    try {
      accessSync(cand, fsConstants.X_OK);
      return cand;
    } catch { /* próximo dir */ }
  }
  return null;
}

export interface AcpMcpConversion {
  servers: AcpMcpServerWire[];
  /** MCPs deixados de fora (command não resolvido): nome + motivo, para o chat. */
  skipped: Array<{ name: string; reason: string }>;
}

/** Converte a forma interna (Record) para o wire ACP (arrays + command absoluto).
 *  T-726: comando relativo é resolvido pelo PATH; o que não resolve sai da lista
 *  (o caller decide se é fatal) em vez de derrubar o handshake. */
export function toAcpMcpServers(servers: DshMcpServer[]): AcpMcpConversion {
  const out: AcpMcpServerWire[] = [];
  const skipped: AcpMcpConversion["skipped"] = [];
  for (const s of servers) {
    if (s.url) {
      out.push({ type: "http", name: s.name, url: s.url, headers: recordToNameValues(s.headers) });
      continue;
    }
    const resolved = resolveAcpCommand(s.command);
    if (!resolved) {
      skipped.push({
        name: s.name,
        reason: s.command
          ? `comando ${JSON.stringify(s.command)} não encontrado no PATH (o ACP do dsh exige path absoluto)`
          : "sem command",
      });
      continue;
    }
    out.push({
      name: s.name,
      command: resolved,
      args: Array.isArray(s.args) ? s.args : [],
      env: recordToNameValues(s.env),
    });
  }
  return { servers: out, skipped };
}

export interface DshSession {
  sessionId: string;
  configOptions: DshConfigOption[];
}

export interface DshHandlers {
  onText(text: string): void;
  onThought(text: string): void;
  /** T-827: `input` = `rawInput` do ACP (argumentos da tool), quando vier objeto. */
  onTool(ev: { id: string; title?: string; status?: string; kind?: string; phase: "call" | "update"; input?: Record<string, unknown> }): void;
  onUsage(used: number, size: number): void;
  onConfig(options: DshConfigOption[]): void;
  onStderr(line: string): void;
  onExit(code: number | null): void;
  onPermissionRequest?(params: unknown): "allow" | "deny";
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Timeout de requests de controle (boot+compose mede ~13-19s; margem 3×). */
const CONTROL_TIMEOUT_MS = 60_000;
/** T-726 (c): o session/new espera os mcpServers conectarem e o próprio dsh
 *  só desiste por volta dos 63s (medido: -32603 "mcp-client(X): initial
 *  connection or tool synchronization failed" aos 63s). Com o teto de controle
 *  em 60s o runner cortava ANTES e o chat mostrava "timeout 60s", escondendo
 *  o nome do MCP culpado. 120s = ~2× o teto interno medido. */
export const SESSION_TIMEOUT_MS = 120_000;
/** T-726: nome do MCP culpado no erro do dsh (-32603 mcp-client(<nome>)). */
export function mcpNameFromAcpError(message: string): string | null {
  return /mcp-client\(([^)]+)\)/.exec(message)?.[1] ?? null;
}
/** Teto de segurança do prompt (o turno é longo; o watchdog do daemon cobre). */
const PROMPT_TIMEOUT_MS = 60 * 60_000;

export class DshAcpError extends Error {}

/** Injetável para testes/dropTo (spawnDropped no driver). */
export type DshSpawnLike = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }) => ChildProcess;

export class DshClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private stopping = false;
  private sessionId: string | null = null;

  constructor(private readonly handlers: DshHandlers) {}

  get alive(): boolean {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  start(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }, spawnImpl?: DshSpawnLike): void {
    if (this.proc) throw new DshAcpError("dsh já iniciado");
    const impl = spawnImpl ?? (spawn as unknown as DshSpawnLike);
    const proc = impl(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    let stderrBuf = "";
    proc.stderr!.on("data", (chunk: string) => {
      stderrBuf += chunk;
      let idx: number;
      while ((idx = stderrBuf.indexOf("\n")) >= 0) {
        const line = stderrBuf.slice(0, idx);
        stderrBuf = stderrBuf.slice(idx + 1);
        if (line.trim()) this.handlers.onStderr(line);
      }
    });
    proc.on("exit", (code) => {
      this.failAll(new DshAcpError(`dsh saiu (code=${code})`));
      this.handlers.onExit(code);
    });
    proc.on("error", (err) => {
      this.failAll(err instanceof Error ? err : new DshAcpError(String(err)));
    });
  }

  /** Encerra o processo (SIGTERM → SIGKILL em 3s). */
  kill(): void {
    this.stopping = true;
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    const t = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* já morreu */ }
    }, 3_000);
    t.unref?.();
  }

  /** initialize — handshake; devolve as capabilities do agente. */
  async initialize(): Promise<{ protocolVersion: number }> {
    return (await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }, CONTROL_TIMEOUT_MS)) as { protocolVersion: number };
  }

  async newSession(cwd: string, mcpServers: DshMcpServer[]): Promise<DshSession> {
    const res = (await this.request("session/new", { cwd, mcpServers: toAcpMcpServers(mcpServers).servers }, SESSION_TIMEOUT_MS)) as DshSession;
    this.sessionId = res.sessionId;
    if (Array.isArray(res.configOptions)) this.handlers.onConfig(res.configOptions);
    return res;
  }

  /** Resume pós-restart: mesmo sessionId, sem replay de updates. */
  async resumeSession(sessionId: string, cwd: string, mcpServers: DshMcpServer[]): Promise<DshSession> {
    const res = (await this.request("session/resume", { sessionId, cwd, mcpServers: toAcpMcpServers(mcpServers).servers }, SESSION_TIMEOUT_MS)) as DshSession;
    this.sessionId = res.sessionId ?? sessionId;
    if (Array.isArray(res.configOptions)) this.handlers.onConfig(res.configOptions);
    return { sessionId: this.sessionId!, configOptions: res.configOptions ?? [] };
  }

  async setConfigOption(configId: string, value: string): Promise<DshConfigOption[]> {
    if (!this.sessionId) throw new DshAcpError("sem sessão");
    const res = (await this.request("session/set_config_option", { sessionId: this.sessionId, configId, value }, CONTROL_TIMEOUT_MS)) as { configOptions?: DshConfigOption[] };
    if (Array.isArray(res.configOptions)) this.handlers.onConfig(res.configOptions);
    return res.configOptions ?? [];
  }

  /** Envia um turno; resolve no settle (stopReason). Updates fluem por handlers. */
  async prompt(text: string): Promise<string> {
    if (!this.sessionId) throw new DshAcpError("sem sessão");
    const res = (await this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    }, PROMPT_TIMEOUT_MS)) as { stopReason?: string };
    return res.stopReason ?? "end_turn";
  }

  /** Cancelamento do prompt em voo (notification, sem resposta). */
  cancel(): void {
    if (!this.sessionId || !this.proc) return;
    this.notify("session/cancel", { sessionId: this.sessionId });
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    const sid = this.sessionId;
    this.sessionId = null;
    try {
      await this.request("session/close", { sessionId: sid }, CONTROL_TIMEOUT_MS);
    } catch {
      /* close é best-effort; kill cobre */
    }
  }

  /* ------------------------------ transporte ------------------------------ */

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.handlers.onStderr(`[frame inválido] ${line.slice(0, 200)}`);
        continue;
      }
      this.route(msg);
    }
  }

  private route(msg: Record<string, unknown>): void {
    if (typeof msg.id === "number" && ("result" in msg || "error" in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        // T-726: `data.details` é onde o dsh diz QUAL mcp-client falhou
        // ("mcp-client(<nome>): initial connection…"). Sem ele o chat só via
        // "Internal error" e ninguém sabia o culpado.
        const err = msg.error as { code?: number; message?: string; data?: { details?: string } };
        const detalhe = typeof err.data?.details === "string" ? ` — ${err.data.details}` : "";
        p.reject(new DshAcpError(`acp ${err.code ?? "?"}: ${err.message ?? "erro"}${detalhe}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    const method = typeof msg.method === "string" ? msg.method : "";
    if (method === "session/update") {
      const params = msg.params as { update?: Record<string, unknown> } | undefined;
      const update = params?.update;
      if (!update) return;
      const kind = String(update.sessionUpdate ?? "");
      if (kind === "agent_message_chunk") {
        const c = update.content as { type?: string; text?: string } | undefined;
        if (c?.type === "text" && typeof c.text === "string") this.handlers.onText(c.text);
      } else if (kind === "agent_thought_chunk") {
        const c = update.content as { type?: string; text?: string } | undefined;
        if (c?.type === "text" && typeof c.text === "string") this.handlers.onThought(c.text);
      } else if (kind === "tool_call" || kind === "tool_call_update") {
        this.handlers.onTool({
          id: String(update.toolCallId ?? ""),
          title: typeof update.title === "string" ? update.title : undefined,
          status: typeof update.status === "string" ? update.status : undefined,
          kind: typeof update.kind === "string" ? update.kind : undefined,
          phase: kind === "tool_call" ? "call" : "update",
          input: dshToolInput(update.rawInput),
        });
      } else if (kind === "usage_update") {
        this.handlers.onUsage(Number(update.used) || 0, Number(update.size) || 0);
      } else if (kind === "config_option_update") {
        const opts = update.configOptions;
        if (Array.isArray(opts)) this.handlers.onConfig(opts as DshConfigOption[]);
      }
      return;
    }
    if (typeof msg.id === "number" && method) {
      // ACP permission is a pre-execution hook. A member turn must never
      // inherit the owner's auto-allow decision.
      if (method === "session/request_permission") {
        const params = msg.params as { options?: Array<{ optionId?: string; kind?: string; name?: string }> } | undefined;
        const opts = params?.options ?? [];
        if ((this.handlers.onPermissionRequest?.(msg.params) ?? "deny") === "deny") {
          const reject = opts.find((o) => o.kind === "reject_once" || /reject|deny/i.test(`${o.optionId ?? ""} ${o.name ?? ""}`));
          if (reject?.optionId) this.respond(msg.id, { outcome: { outcome: "selected", optionId: reject.optionId } });
          else this.respondError(msg.id, "permission denied by daemon security policy");
          return;
        }
        const allow = opts.find((o) => o.kind === "allow_once") ?? opts.find((o) => (o.optionId ?? "").includes("allow")) ?? opts[0];
        if (allow?.optionId) this.respond(msg.id, { outcome: { outcome: "selected", optionId: allow.optionId } });
        else this.respondError(msg.id, "permission request has no supported allow option");
        return;
      }
      // Métodos desconhecidos: resposta vazia evita o server pendurar.
      this.respond(msg.id, {});
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.proc || !this.alive) return Promise.reject(new DshAcpError("dsh não está vivo"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DshAcpError(`${method} timeout após ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private respond(id: number, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code: -32000, message } });
  }

  private write(obj: unknown): void {
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(JSON.stringify(obj) + "\n");
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

/** `reasoning_effort` do ACP aceita off/low/high/max; EffortLevel→valor. */
export function dshEffortValue(effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  if (effort === "none" || effort === "minimal") return "off";
  if (effort === "low") return "low";
  if (effort === "high") return "high";
  if (effort === "max" || effort === "xhigh") return "max";
  return undefined;
}

/* ---------------------- driver do AgentRunner (self) ---------------------- */

const MAX_DSH_QUEUE = 20;
/** Backoff do restart pós-exit inesperado (resume da mesma sessão). */
const DSH_RESTART_DELAY_MS = 500;
/** T-726 (d): handshake que falha em série vira backoff (500ms → 30s) e PARA
 *  em 5 tentativas, com motivo no chat. Antes era restart fixo de 500ms para
 *  sempre: com um MCP quebrado o agente ficava em loop cego, sem mensagem útil. */
export const DSH_HANDSHAKE_MAX_TRIES = 5;
const DSH_BACKOFF_CAP_MS = 30_000;
/** Nome do bridge do the-dudes: sem ele o agente não fala com o time (fatal). */
const BRIDGE_MCP_NAME = "the-dudes";

interface DshQueued { content: string; deliveryId?: string; principal?: InboundTurnPrincipal }

/** mcpServers do session/new: bridge the-dudes + extras (stdio ou http). */
function dshMcpServers(self: any): DshMcpServer[] {
  const servers: DshMcpServer[] = [{
    name: "the-dudes",
    command: self.opts.bridgeCommand,
    args: self.opts.bridgeArgs,
    env: self.bridgeEnv(),
  }];
  // harness antigo chama startDsh com self FAKE (sem o metodo) — fallback defensivo.
  for (const [name, def] of Object.entries(self.mcpServersForSpawn?.() ?? self.opts.extraMcpServers ?? {})) {
    const d = def as { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
    if (d?.command) servers.push({ name, command: d.command, args: d.args ?? [], env: d.env });
    else if (d?.url) servers.push({ name, url: d.url, headers: d.headers });
  }
  return servers;
}

/** Keep runner errors visible in the local daemon log as well as the chat. */
function dshReportError(self: any, message: string): void {
  self.opts.log("warn", `[cli:${self.info.id}:dsh] ${message}`);
  self.opts.onError(message);
}

/**
 * Sobe o servidor ACP, faz o handshake (initialize → session/new|resume →
 * set_config_option) e drena a fila. Espelha o startClaude: proc em `self.proc`
 * (o stop/kill do runner alcança), identidade `self.dsh` guarda chunks tardios.
 */
export function startDsh(self: any): void {
  const bootStartedAt = performance.now();
  let handshakePending = true;
  let pendingExit: { code: number | null } | undefined;
  const finishExit = (code: number | null) => {
    if (self.dsh !== client) return;
    if (self.dshReady) self.turnLatency?.current?.finish("process-exit");
    self.dsh = null;
    self.dshReady = false;
    self.dshPromptInFlight = false;
    self.zerarToolsEmVoo();
    if (self.stopped || self.recoveringHung) return;
    // T-726 (d): só o handshake conta para o backoff — saída normal pós-turno
    // (dshHandshakeFails zerado no sucesso) segue com o restart rápido.
    const falhas = Number(self.dshHandshakeFails ?? 0);
    if (falhas >= DSH_HANDSHAKE_MAX_TRIES) {
      dshReportError(self,
        `[dsh] handshake falhou ${falhas}x seguidas — agente PARADO (sem restart). ` +
        `Último motivo: ${String(self.dshLastHandshakeError ?? "desconhecido")}. Corrija e reinicie o agente.`,
      );
      self.opts.log("warn", `[cli:${self.info.id}:dsh] handshake falhou ${falhas}x — parado (sem loop)`);
      self.emitExit(code ?? 1);
      return;
    }
    const delay = falhas > 0
      ? Math.min(DSH_RESTART_DELAY_MS * 2 ** falhas, DSH_BACKOFF_CAP_MS)
      : DSH_RESTART_DELAY_MS;
    self.opts.log("warn", `[cli:${self.info.id}:dsh] processo saiu (code=${code}) — restart com resume em ${delay}ms${falhas ? ` (falha ${falhas}/${DSH_HANDSHAKE_MAX_TRIES})` : ""}`);
    self.dshRestartTimer = setTimeout(() => {
      if (!self.stopped && !self.recoveringHung) startDsh(self);
    }, delay);
    self.dshRestartTimer?.unref?.();
  };
  const client = new DshClient({
    onText: (t) => {
      if (self.dsh !== client) return;
      if (self.dshPromptInFlight) {
        self.dshTurnOutputChars = Number(self.dshTurnOutputChars ?? 0) + t.length;
      }
      self.touchActivity();
      self.setState("speaking");
      if (t) self.turnLatency?.current?.semantic("text");
      self.opts.onAssistantText(t);
    },
    onThought: (t) => {
      if (self.dsh !== client) return;
      self.touchActivity();
      if (t) self.turnLatency?.current?.semantic("thinking");
      if (self.info.collectThinking && t) self.opts.onThinkingText?.(t);
      if (self.currentState !== "speaking") self.setState("thinking");
    },
    onTool: (ev) => {
      if (self.dsh !== client) return;
      self.touchActivity();
      if (ev.phase === "call") {
        self.turnLatency?.current?.semantic("tool");
        // T-819: por ID (o ACP reemite `tool_call` do mesmo id — não é tool nova).
        self.noteGrokToolInFlight(ev.id);
        // T-827: o dsh manda os argumentos no `rawInput` do tool_call (medido
        // no dsh 0.1.5: bash {command, description}, read {file_path, limit});
        // antes ia `{}` e os RUNS ficavam vazios.
        self.opts.onToolUse(ev.title ?? ev.id, ev.input ?? {});
        self.setState((ev.title ?? "").includes("send_message") ? "sending" : "thinking");
      } else if (ev.status === "completed" || ev.status === "failed") {
        self.noteToolFechada(ev.id);
      }
    },
    onPermissionRequest: () => acpPermissionDecisionForTurn(self.currentTurn?.principal),
    onUsage: (used, size) => {
      if (self.dsh !== client) return;
      self.touchActivity();
      self.opts.onContextUsage?.(used, size);
    },
    onConfig: (opts) => { if (self.dsh === client) self.dshConfig = opts; },
    onStderr: (line) => {
      if (self.dsh !== client) return;
      self.traceCli("dsh", "stderr", line);
      dshReportError(self, line);
    },
    onExit: (code) => {
      if (self.dsh !== client) return;
      // failAll rejects promises before this synchronous callback. Let the
      // handshake catch record the cause before clearing the current identity.
      if (handshakePending) {
        pendingExit = { code };
        return;
      }
      finishExit(code);
    },
  });
  self.dsh = client;
  self.dshReady = false;
  self.dshPromptInFlight = false;
  self.dshQueue = (self.dshQueue as DshQueued[] | undefined) ?? [];
  const args = [...DSH_ACP_ARGS];
  self.traceSpawn?.("dsh", args);
  try {
    client.start(self.runnerCommand("dsh"), args, { cwd: self.opts.workspaceRoot, env: self.buildEnv() },
      (cmd, a, o) => spawnDropped(cmd, a, o, self.opts.dropTo ?? null) as unknown as ChildProcess);
  } catch (e) {
    dshReportError(self, `[dsh] spawn error: ${(e as Error).message}`);
    self.dsh = null;
    self.emitExit(1);
    return;
  }

  void (async () => {
    const resumeId = compatibleSessionId("dsh", self.opts.resumeSessionId ?? self.info.sessionId);
    try {
      await client.initialize();
      if (self.dsh !== client) return;
      const mcp = dshMcpServers(self);
      // T-726 (a)/(b): comando relativo é resolvido pelo PATH; o que não
      // resolve sai da lista. Bridge fora = fatal; MCP extra fora = aviso.
      const conv = toAcpMcpServers(mcp);
      for (const s2 of conv.skipped) {
        if (s2.name === BRIDGE_MCP_NAME) throw new DshAcpError(`bridge ${BRIDGE_MCP_NAME} indisponível: ${s2.reason}`);
        dshReportError(self, `[dsh] MCP "${s2.name}" ficou de fora: ${s2.reason} — o agente sobe sem ele`);
        self.opts.log("warn", `[cli:${self.info.id}:dsh] MCP ${s2.name} ignorado: ${s2.reason}`);
      }
      for (const srv of conv.servers) {
        if ("command" in srv) self.opts.log("info", `[cli:${self.info.id}:dsh] MCP ${srv.name} → ${srv.command}`);
      }
      const usaveis = mcp.filter((m) => !conv.skipped.some((s2) => s2.name === m.name));
      const abrir = (lista: typeof usaveis) => (resumeId
        ? client.resumeSession(resumeId, self.opts.workspaceRoot, lista)
        : client.newSession(self.opts.workspaceRoot, lista));
      let sess: DshSession;
      try {
        sess = await abrir(usaveis);
      } catch (e) {
        // T-726 (b)/(c): o dsh só descobre no session/new que um MCP não
        // conecta (-32603 mcp-client(<nome>), ~63s). Tira o culpado (se for
        // EXTRA) e sobe sem ele, em vez de matar a sessão.
        if (self.dsh !== client) return;
        const msg = (e as Error).message;
        const culpado = mcpNameFromAcpError(msg);
        if (!culpado || culpado === BRIDGE_MCP_NAME) throw e;
        dshReportError(self, `[dsh] MCP "${culpado}" não conectou (${msg}) — o agente sobe sem ele`);
        self.opts.log("warn", `[cli:${self.info.id}:dsh] MCP ${culpado} não conectou — retry sem ele`);
        sess = await abrir(usaveis.filter((m) => m.name !== culpado));
      }
      if (self.dsh !== client) return;
      self.opts.onSessionId?.(sess.sessionId);
      self.info.sessionId = sess.sessionId;
      // Espelha no messageSession e marca se a sessão é NOVA (first-turn leva
      // system+contexto; resume NÃO re-injeta — o log é durável).
      self.messageSession.sessionId = sess.sessionId;
      self.dshFreshSession = !resumeId;
      // T-796: rota sem chave (default do catálogo = par official) cai no
      // dsflash; só model explícito de rota COM chave é preservado.
      const model = dshModelForTurn(self.info.model);
      const aplicados = await client.setConfigOption("model", model);
      // O value é opaco: confere o que o servidor APLICOU. Se a sessão ficou
      // em rota sem chave o prompt falha em ~180ms com -32603 sem UMA linha
      // explicando o set — repete uma vez e loga o desfecho.
      const efetivo = aplicados.find((o) => o?.id === "model")?.currentValue;
      if (efetivo && efetivo !== model) {
        self.opts.log(
          "warn",
          `[cli:${self.info.id}:dsh] set_config_option model=${model} não pegou (sessão em ${efetivo}) — repetindo`,
        );
        const repetido = await client.setConfigOption("model", model);
        const ficou = repetido.find((o) => o?.id === "model")?.currentValue;
        if (ficou && dshModelRoute(ficou) === DSH_KEYLESS_ROUTE) {
          self.opts.log("warn", `[cli:${self.info.id}:dsh] sessão segue na rota sem chave (${ficou}) — prompt deve falhar com -32603`);
        }
      }
      const effort = dshEffortValue(self.info.effort);
      if (effort) await client.setConfigOption("reasoning_effort", effort);
      if (self.dsh !== client) return;
      self.turnLatency?.bootReady(performance.now() - bootStartedAt);
      self.dshReady = true;
      self.dshHandshakeFails = 0; // T-726 (d): sucesso zera o backoff
      self.dshLastHandshakeError = undefined;
      self.setState("idle");
      dshPump(self);
    } catch (e) {
      if (self.dsh !== client) return;
      self.dshHandshakeFails = Number(self.dshHandshakeFails ?? 0) + 1;
      self.dshLastHandshakeError = (e as Error).message;
      dshReportError(self, `[dsh] handshake: ${(e as Error).message}`);
      // Resume inválido: próxima subida faz session/new (não loopa no mesmo id).
      if (resumeId) {
        self.opts.resumeSessionId = undefined;
        self.info.sessionId = undefined;
      }
      client.kill();
    } finally {
      handshakePending = false;
      if (pendingExit) finishExit(pendingExit.code);
    }
  })();
}

/** T-720: dreno do self-update — devolve e esvazia a fila de prompts ainda
 *  NÃO enviados (o prompt em voo não está nela). Só leitura/limpeza. */
export function dshTakeQueue(self: any): Array<{ content: string; deliveryId?: string; principal?: InboundTurnPrincipal }> {
  const queue = (self.dshQueue as DshQueued[] | undefined) ?? [];
  for (const q of queue) self.turnLatency?.discard(q, "drained");
  self.dshQueue = [];
  return queue.map((q) => ({ content: q.content, deliveryId: q.deliveryId, principal: q.principal }));
}

/** T-1005: fila ao vivo — prompts ainda NÃO enviados, sem consumir. */
export function dshPeekQueue(self: any): Array<{ content: string; deliveryId?: string }> {
  const queue = (self.dshQueue as DshQueued[] | undefined) ?? [];
  return queue.map((q) => ({ content: q.content, deliveryId: q.deliveryId }));
}

/** T-1005: tira da fila o prompt ainda não enviado desta entrega. */
export function dshRemoveQueued(self: any, deliveryId: string): boolean {
  const queue = (self.dshQueue as DshQueued[] | undefined) ?? [];
  const i = queue.findIndex((q) => q.deliveryId === deliveryId);
  if (i < 0) return false;
  const [q] = queue.splice(i, 1);
  self.turnLatency?.discard(q, "queue-cleared");
  self.dshQueue = queue;
  return true;
}

/** T-827: `rawInput` do ACP só vale como objeto (é o que os RUNS mostram). */
export function dshToolInput(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
}

/** Enfileira mensagem do usuário; o pump serializa (ACP: 1 prompt por vez). */
export function dshPushUserMessage(self: any, content: string, images?: ImageAttachment[], deliveryId?: string, principal?: InboundTurnPrincipal): boolean {
  const queue = (self.dshQueue as DshQueued[] | undefined) ?? [];
  if (queue.length >= MAX_DSH_QUEUE) {
    if (deliveryId) {
      self.opts.log("warn", `[cli:${self.info.id}:dsh] fila cheia (${queue.length}) — queue_deliver não aceito; item permanece retido no server`);
    } else {
      self.opts.log("warn", `[cli:${self.info.id}:dsh] fila cheia (${queue.length}) — drop mensagem`);
      // T-818: descarte declarado a quem vê o chat (uma vez por rajada) —
      // antes era só log.
      if (!self.dshDropNoticeSent) {
        self.dshDropNoticeSent = true;
        self.opts.onError?.(`[fila] mensagem descartada: a fila do dsh está cheia (${queue.length}) — reenvie quando ela baixar (próximos descartes só no log)`);
      }
    }
    return false;
  }
  if (queue.length < MAX_DSH_QUEUE / 2) self.dshDropNoticeSent = false;
  let message = content;
  if (images && images.length) {
    const { files, cleanup } = self.writeAttachmentFiles(images);
    self.scheduleAttachmentCleanup(cleanup);
    message = appendPathAttachmentPrompt(message, files, "dsh");
  }
  const queued = { content: message, deliveryId, principal };
  self.turnLatency?.enqueue(queued);
  queue.push(queued);
  self.dshQueue = queue;
  self.queueChanged?.();
  dshPump(self);
  return true;
}

/** ACP dsh v1 exposes context occupancy, not turn token counts. Match the
 *  one-shot fallback (~4 UTF-16 chars/token) and tag it in local logs. */
function estimateDshTurnUsage(promptChars: number, outputChars: number): AgentUsage {
  return {
    input: Math.ceil(promptChars / 4),
    output: Math.ceil(outputChars / 4),
    cacheCreate: 0,
    cacheRead: 0,
  };
}

function dshPump(self: any): void {
  const client = self.dsh as DshClient | null;
  if (!client || !self.dshReady || self.dshPromptInFlight) return;
  const queue = (self.dshQueue as DshQueued[] | undefined) ?? [];
  const next = queue.shift();
  if (!next) return;
  self.dshQueue = queue;
  self.queueChanged?.();
  const timing = self.turnLatency?.activate(next, self.dshFreshSession ? "cold" : "resume");
  timing?.start();
  self.dshPromptInFlight = true;
  self.currentTurn = { content: next.content, deliveryId: next.deliveryId, principal: next.principal };
  self.currentTurnSettled = false;
  self.setState("thinking");
  void (async () => {
    try {
      // First-turn de sessão NOVA leva system+contexto; resume NÃO re-injeta
      // (contrato: o log é durável).
      let text = markNonOwnerMessage(next.content, next.principal);
      if (self.messageSession.firstTurn && self.dshFreshSession) {
        self.messageSession.consumeFirstTurn();
        text = self.initialMessage(text, self.messageSession.pendingSummary);
      } else if (self.messageSession.firstTurn) {
        self.messageSession.firstTurn = false; // resume: só avança a flag
      }
      self.dshTurnOutputChars = 0;
      const stop = await client.prompt(text);
      if (self.dsh !== client) return;
      const usage = estimateDshTurnUsage(text.length, Number(self.dshTurnOutputChars ?? 0));
      if (usage.input > 0 || usage.output > 0) {
        self.opts.onUsageDelta?.(usage);
        self.opts.log(
          "info",
          `[cli:${self.info.id}:dsh] uso estimado (heurística ACP ~4 chars/token): input=${usage.input} output=${usage.output}`,
        );
      }
      timing?.finish(stop === "cancelled" ? "cancelled" : "completed");
      self.dshFreshSession = false;
      self.dshPromptInFlight = false;
      if (stop !== "cancelled") self.setState("idle");
      self.touchActivity();
      dshPump(self);
    } catch (e) {
      if (self.dsh !== client) return;
      self.dshPromptInFlight = false;
      timing?.finish("error");
      self.turnLatency?.enqueue(next, true);
      dshReportError(self, `[dsh] prompt: ${(e as Error).message}`);
      // Prompt falhou com processo vivo (ex.: timeout de controle): devolve a
      // mensagem e tenta de novo no próximo pump.
      queue.unshift(next);
      self.dshQueue = queue;
    }
  })();
}

export function dshIsInTurn(self: any): boolean {
  return !!self.dshPromptInFlight;
}

/** Stop/kill: fecha a sessão (best-effort) e mata o processo. */
export function dshStop(self: any): void {
  if (self.dshRestartTimer) {
    clearTimeout(self.dshRestartTimer);
    self.dshRestartTimer = null;
  }
  const client = self.dsh as DshClient | null;
  self.dsh = null;
  self.dshReady = false;
  self.dshPromptInFlight = false;
  self.dshQueue = [];
  if (!client) return;
  void client.close().finally(() => client.kill());
  // Kill imediato garante o exit mesmo se o close pendurar.
  client.kill();
}

/** clearContext/compact: mata e ressobe com sessão nova (caller zera ids). */
export async function dshKillForRestart(self: any): Promise<void> {
  self.turnLatency?.current?.finish("reset", "context-reset");
  if (self.dshRestartTimer) {
    clearTimeout(self.dshRestartTimer);
    self.dshRestartTimer = null;
  }
  const client = self.dsh as DshClient | null;
  self.dsh = null;
  self.dshReady = false;
  self.dshPromptInFlight = false;
  if (!client) return;
  await client.close().catch(() => { /* best-effort */ });
  client.kill();
}
