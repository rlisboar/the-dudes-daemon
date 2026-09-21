/**
 * T-768: proxy MCP que filtra tools/list por allowlist de FERRAMENTA, no
 * ponto de injeção. Os CLIs do time não filtram visibilidade por conta própria
 * (medido: `--allowed-tools` e `allowedTools` no mcp.json não removem a tool do
 * tools/list), então o daemon troca o servidor por ESTE proxy quando o agente
 * declara ferramentas: o CLI conecta no proxy (stdio) e o proxy fala com o
 * servidor real (stdio ou http/sse), devolvendo só as tools permitidas.
 *
 * Sem spec de tools = passthrough (não é usado, mas serve de fallback).
 * Não loga env/headers.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface ProxySpec {
  /** Ferramentas visíveis; nomes exatos. Vazio = nenhuma. Ausente = todas. */
  tools?: string[];
  upstream:
    | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
    | { transport: "http" | "sse"; url: string; headers?: Record<string, string> };
}

type Json = Record<string, unknown>;

interface Upstream {
  send(msg: Json): void;
  close(): void;
}

function writeLine(msg: Json): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

/** Upstream stdio: fala JSON-RPC por linhas no stdin/stdout do processo filho. */
function openStdioUpstream(spec: Extract<ProxySpec["upstream"], { transport: "stdio" }>, onMessage: (m: Json) => void, onExit: () => void): Upstream {
  const child: ChildProcess = spawn(spec.command, spec.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(spec.env ?? {}) },
  });
  let buf = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (c: string) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { onMessage(JSON.parse(line)); } catch { /* linha parcial/ruído */ }
    }
  });
  child.on("exit", onExit);
  child.on("error", onExit);
  return {
    send: (m) => { try { child.stdin!.write(JSON.stringify(m) + "\n"); } catch { /* morreu */ } },
    close: () => { try { child.kill("SIGTERM"); } catch { /* noop */ } },
  };
}

/** Upstream streamable HTTP: POST por mensagem; resposta JSON ou SSE. */
function openHttpUpstream(spec: Extract<ProxySpec["upstream"], { transport: "http" | "sse" }>, onMessage: (m: Json) => void, onExit: () => void): Upstream {
  let sessionId: string | undefined;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(spec.headers ?? {}),
  };
  return {
    send: (m) => {
      void (async () => {
        try {
          if (sessionId) headers["mcp-session-id"] = sessionId;
          const res = await fetch(spec.url, { method: "POST", headers, body: JSON.stringify(m) });
          const sid = res.headers.get("mcp-session-id");
          if (sid) sessionId = sid;
          const ctype = res.headers.get("content-type") ?? "";
          if (ctype.includes("text/event-stream")) {
            const reader = res.body?.getReader();
            if (!reader) return;
            const dec = new TextDecoder();
            let buf = "";
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let idx: number;
              while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line.startsWith("data:")) continue;
                const payload = line.slice(5).trim();
                if (!payload) continue;
                try { onMessage(JSON.parse(payload)); } catch { /* evento não-JSON */ }
              }
            }
            return;
          }
          const text = await res.text();
          if (text.trim()) { try { onMessage(JSON.parse(text)); } catch { /* corpo vazio */ } }
        } catch {
          onExit();
        }
      })();
    },
    close: () => { /* POSTs são stateless no cliente */ },
  };
}

export function runToolProxy(spec: ProxySpec): Promise<void> {
  return new Promise((resolve) => {
    const allowed = spec.tools == null ? null : new Set(spec.tools);
    const listIds = new Set<string | number>();
    let upstream: Upstream;
    const onUpstreamMessage = (msg: Json) => {
      // Resposta de tools/list pedida pelo CLI: filtra nomes não declarados.
      if (allowed && msg.id != null && listIds.has(msg.id as string | number)) {
        listIds.delete(msg.id as string | number);
        const result = msg.result as { tools?: Array<{ name?: string }> } | undefined;
        if (result && Array.isArray(result.tools)) {
          result.tools = result.tools.filter((t) => t?.name != null && allowed.has(String(t.name)));
        }
      }
      writeLine(msg);
    };
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      try { upstream?.close(); } catch { /* noop */ }
      resolve();
      // O proxy é dono do próprio ciclo de vida: sem isto o stdin/filhos
      // seguravam o event loop do CLI/teste para sempre.
      setImmediate(() => process.exit(0));
    };
    process.on("SIGTERM", done);
    process.on("SIGINT", done);
    upstream = spec.upstream.transport === "stdio"
      ? openStdioUpstream(spec.upstream, onUpstreamMessage, done)
      : openHttpUpstream(spec.upstream, onUpstreamMessage, done);

    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: Json;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method === "tools/list" && msg.id != null) listIds.add(msg.id as string | number);
        upstream.send(msg);
      }
    });
    process.stdin.on("end", done);
  });
}

// Entry direto (testes/dev): node --import tsx mcp-tool-proxy.ts '<json>'
const IS_PROXY_ENTRY = /[/\\]mcp-tool-proxy\.(?:cjs|js|ts)$/.test(process.argv[1] ?? "");
if (IS_PROXY_ENTRY) {
  const spec = JSON.parse(process.argv[2] ?? "{}") as ProxySpec;
  void runToolProxy(spec);
}