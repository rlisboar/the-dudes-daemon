/**
 * T-1054 (passo 2 do #714): GROK por ACP persistente (`grok agent stdio`).
 *
 * O caminho headless (`grok -p …`) spawna um processo POR TURNO e cada spawn
 * paga o boot inteiro — fetch de modelos, announcements, bootstrap da busca de
 * sessões, etag, handshake ACP (~5,4s dos 9,95s de `firstEventMs` p50 medidos
 * em produção no #714). `grok agent stdio` mantém UM processo: o boot é pago no
 * primeiro turno e os seguintes pagam só o modelo (probe real, grok 1.0.41:
 * handshake 0,33s; turno 1 3,08s; turno 2 1,63s, contra 2,1–3,0s POR TURNO no
 * headless).
 *
 * Dialecto: ACP v1 stdio — o MESMO que o dsh já fala no runner (frames
 * initialize → session/new|session/load → session/set_config_option →
 * session/prompt; updates em `session/update`; approval por
 * `session/request_permission`). Confirmado no handshake real: o grok anuncia
 * `loadSession: true` e devolve `configOptions=[model, reasoning_effort]`.
 * Ele grava os MESMOS artefatos de sessão do headless sob
 * `<GROK_HOME>/sessions/<cwd>/<sessionId>/{chat_history.jsonl,signals.json,
 * updates.jsonl}` — então sweep de tools e contexto/billing seguem valendo.
 *
 * Ligado por `THE_DUDES_GROK_ACP=1` (o headless fica como rollback no 1º
 * deploy). Nada aqui muda o contrato do runner: gate, watchdog, hang, spool,
 * E2EE e turn-latency continuam vindo do `self`.
 */

import { spawnDropped } from "../../privileges.js";
import type { ChildProcess } from "node:child_process";

const CONTROL_TIMEOUT_MS = 20_000;
const SESSION_TIMEOUT_MS = 60_000;

export function grokAcpHabilitado(): boolean {
  return process.env.THE_DUDES_GROK_ACP === "1";
}

/** Fecha o cliente ACP do grok no stop do runner (o processo é persistente e
 *  não vive em `self.proc`, então o kill genérico do agent-runner não o vê). */
export function grokAcpStop(self: Record<string, unknown>): void {
  const c = self.grokAcp as GrokAcpClient | null | undefined;
  if (!c) return;
  try { c.matar(); } catch { /* best-effort */ }
  self.grokAcp = null;
}

export interface GrokAcpHandlers {
  onText(text: string): void;
  onThought(text: string): void;
  /** tool_call: id/título/kind + rawInput (mesmo shape do dsh). */
  onTool(ev: { id: string; title?: string; status?: string; kind?: string; phase: "call" | "update"; input?: Record<string, unknown> }): void;
  onUsage(used: number, size: number): void;
  onConfig(options: Array<{ id: string; currentValue?: string }>): void;
  onStderr(line: string): void;
  onExit(code: number | null): void;
}

interface Pedido {
  res: (v: unknown) => void;
  rej: (e: Error) => void;
  method: string;
  timer: NodeJS.Timeout;
}

/** Cliente ACP stdio do grok (um processo vivo por runner). */
export class GrokAcpClient {
  private proc: ChildProcess | null = null;
  private buf = "";
  private seq = 0;
  private pend = new Map<number, Pedido>();
  private encerrado = false;
  sessionId: string | null = null;

  constructor(private readonly handlers: GrokAcpHandlers) {}

  vivo(): boolean {
    return this.proc !== null && !this.encerrado;
  }

  start(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; dropTo: unknown }): void {
    const proc = spawnDropped(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] }, opts.dropTo as never);
    this.proc = proc;
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => { this.alimentar(chunk); });
    proc.stderr?.on("data", (chunk: string) => {
      const t = chunk.trim();
      if (t) this.handlers.onStderr(t);
    });
    proc.on("close", (code) => { this.encerrado = true; this.rejeitarPendentes("processo saiu"); this.handlers.onExit(code); });
    proc.on("error", () => { this.encerrado = true; this.rejeitarPendentes("erro de spawn"); });
  }

  pid(): number | undefined { return this.proc?.pid; }

  /** NDJSON: uma linha = uma mensagem JSON-RPC. */
  private alimentar(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const linha = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      if (!linha.trim()) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(linha) as Record<string, unknown>; } catch { continue; }
      this.receber(msg);
    }
  }

  private receber(msg: Record<string, unknown>): void {
    const id = typeof msg.id === "number" ? msg.id : null;
    if (id !== null && this.pend.has(id)) {
      const p = this.pend.get(id)!;
      this.pend.delete(id);
      clearTimeout(p.timer);
      const err = msg.error as { message?: string } | undefined;
      if (err) p.rej(new Error(`${p.method}: ${String(err.message ?? JSON.stringify(err)).slice(0, 300)}`));
      else p.res(msg.result);
      return;
    }
    // Request DO SERVIDOR (ex.: approval) — resposta obrigatória.
    const method = typeof msg.method === "string" ? msg.method : "";
    if (id !== null && method) {
      if (method === "session/request_permission") {
        const params = msg.params as { options?: Array<{ optionId?: string; kind?: string }> } | undefined;
        const opts = params?.options ?? [];
        const allow = opts.find((o) => o.kind === "allow_once") ?? opts.find((o) => o.kind === "allow_always") ?? opts[0];
        this.responder(id, { outcome: { outcome: "selected", optionId: allow?.optionId ?? "allow_once" } });
        return;
      }
      this.responder(id, {});
      return;
    }
    if (method === "session/update") {
      const u = (msg.params as { update?: Record<string, unknown> } | undefined)?.update;
      if (!u) return;
      const kind = String(u.sessionUpdate ?? "");
      if (kind === "agent_message_chunk") {
        const c = u.content as { type?: string; text?: string } | undefined;
        if (c?.type === "text" && typeof c.text === "string") this.handlers.onText(c.text);
        return;
      }
      if (kind === "agent_thought_chunk") {
        const c = u.content as { type?: string; text?: string } | undefined;
        if (c?.type === "text" && typeof c.text === "string") this.handlers.onThought(c.text);
        return;
      }
      if (kind === "tool_call" || kind === "tool_call_update") {
        const raw = u.rawInput;
        this.handlers.onTool({
          id: String(u.toolCallId ?? ""),
          title: typeof u.title === "string" ? u.title : undefined,
          status: typeof u.status === "string" ? u.status : undefined,
          kind: typeof u.kind === "string" ? u.kind : undefined,
          phase: kind === "tool_call" ? "call" : "update",
          input: raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined,
        });
        return;
      }
      if (kind === "usage_update") { this.handlers.onUsage(Number(u.used) || 0, Number(u.size) || 0); return; }
      if (kind === "config_option_update") {
        const opts = u.configOptions;
        if (Array.isArray(opts)) this.handlers.onConfig(opts as Array<{ id: string; currentValue?: string }>);
      }
    }
  }

  private responder(id: number, result: unknown): void {
    try { this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); } catch { /* canal morto */ }
  }

  private rejeitarPendentes(motivo: string): void {
    for (const [, p] of this.pend) { clearTimeout(p.timer); p.rej(new Error(`acp: ${motivo}`)); }
    this.pend.clear();
  }

  pedir(method: string, params: Record<string, unknown>, timeoutMs = CONTROL_TIMEOUT_MS): Promise<unknown> {
    if (!this.proc || this.encerrado) return Promise.reject(new Error("acp: canal fechado"));
    const id = ++this.seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pend.delete(id); rej(new Error(`acp: ${method} sem resposta em ${timeoutMs}ms`)); }, timeoutMs);
      timer.unref?.();
      this.pend.set(id, { res, rej, method, timer });
      try { this.proc!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }
      catch (e) { clearTimeout(timer); this.pend.delete(id); rej(e as Error); }
    });
  }

  /** Handshake. Devolve as capabilities do AGENTE (o grok anuncia
   *  `loadSession`; o fake do dsh anuncia `sessionCapabilities.resume`) — é o
   *  que decide se o resume é por load, resume ou sessão nova. */
  async initialize(): Promise<{ loadSession: boolean; resume: boolean }> {
    const res = await this.pedir("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }) as { agentCapabilities?: { loadSession?: boolean; sessionCapabilities?: { resume?: unknown } } };
    const caps = res?.agentCapabilities ?? {};
    return { loadSession: !!caps.loadSession, resume: !!caps.sessionCapabilities?.resume };
  }

  /** O ChildProcess (o runner guarda em `ocActiveProc` para os kills). */
  procRef(): ChildProcess | null { return this.proc; }

  async novaSessao(cwd: string, mcpServers: unknown[]): Promise<{ sessionId: string; configOptions?: Array<{ id: string; currentValue?: string }> }> {
    const res = await this.pedir("session/new", { cwd, mcpServers }, SESSION_TIMEOUT_MS) as { sessionId?: string; configOptions?: Array<{ id: string; currentValue?: string }> };
    if (!res?.sessionId) throw new Error("acp: session/new sem sessionId");
    this.sessionId = res.sessionId;
    return { sessionId: res.sessionId, configOptions: res.configOptions };
  }

  /** Resume pós-restart. `metodo` vem da capability anunciada no handshake
   *  (`loadSession` no grok; `sessionCapabilities.resume` em peers que só têm
   *  esse) — antes o `resume` era calculado e ignorado. Só marca `sessionId`
   *  quando o pedido PASSA (falha deixa null para o chamador decidir). */
  async carregarSessao(
    sessionId: string,
    cwd: string,
    mcpServers: unknown[],
    metodo: "session/load" | "session/resume" = "session/load",
  ): Promise<{ configOptions?: Array<{ id: string; currentValue?: string }> }> {
    const res = await this.pedir(metodo, { sessionId, cwd, mcpServers }, SESSION_TIMEOUT_MS) as { configOptions?: Array<{ id: string; currentValue?: string }> };
    this.sessionId = sessionId;
    return { configOptions: res?.configOptions };
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    if (!this.sessionId) return;
    await this.pedir("session/set_config_option", { sessionId: this.sessionId, configId, value });
  }

  prometer(texto: string, timeoutMs = 90 * 60_000): Promise<unknown> {
    if (!this.sessionId) return Promise.reject(new Error("acp: sem sessão"));
    return this.pedir("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: texto }] }, timeoutMs);
  }

  matar(sinal: NodeJS.Signals = "SIGKILL"): void {
    const p = this.proc;
    this.proc = null;
    this.encerrado = true;
    this.rejeitarPendentes("cliente morto");
    if (!p) return;
    try {
      // Grupo primeiro (spawnDropped usa detached: o filho é líder do próprio grupo).
      if (p.pid) { try { process.kill(-p.pid, sinal); } catch { /* sem grupo */ } }
      p.kill(sinal);
    } catch { /* já morto */ }
  }
}