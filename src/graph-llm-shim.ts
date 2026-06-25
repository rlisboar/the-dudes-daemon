/**
 * Shim OpenAI-compat (loopback) que deixa o graphify usar opencode/codex/gemini
 * CLI como backend semântico.
 *
 * O graphify só tem `claude-cli` como backend CLI real; os outros backends
 * (openai/gemini/deepseek/…) falam HTTP OpenAI-compat e exigem API key. Mas o
 * backend `openai` aceita um `OPENAI_BASE_URL` custom — então subimos um servidor
 * HTTP mínimo em 127.0.0.1:<porta aleatória> que implementa
 * `POST /v1/chat/completions`, e por dentro roda o CLI escolhido (one-shot, via
 * runCliText, mesmo caminho do TTS summarizer — dropa privilégios, scrub de
 * secrets). O graphify roda com `--backend openai`, `OPENAI_BASE_URL` apontando
 * pro shim e `OPENAI_API_KEY` = token aleatório (autoriza só o graphify local).
 *
 * Vida curta: sobe antes do `graphify extract`, derruba no fim do build. Bind
 * exclusivo no loopback + bearer token aleatório → outros processos locais não
 * conseguem gastar a assinatura do CLI durante a janela do build.
 */

import http from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ResolvedCliCommands } from "./cli-config.js";
import type { DropTarget } from "./privileges.js";
import type { CliRunner } from "./types.js";
import { runCliText } from "./summarizer-runner.js";

export interface CliShim {
  /** base URL p/ OPENAI_BASE_URL (já com /v1). */
  baseUrl: string;
  /** token p/ OPENAI_API_KEY — o shim só aceita Authorization: Bearer <token>. */
  token: string;
  /** label de modelo p/ OPENAI_MODEL (o modelo real é forçado pelo CLI). */
  model: string;
  stop(): void;
}

export interface CliShimOpts {
  /** CLI que fulfila as requisições (claude tem backend nativo no graphify). */
  runner: CliRunner;
  model?: string;
  effort?: string;
  cliCommands: ResolvedCliCommands;
  dropTo?: DropTarget | null;
  claudeConfigDir?: string;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
  /** timeout por requisição do CLI (default 240s — chunk do grafo é maior). */
  reqTimeoutMs?: number;
  /** quantas chamadas de CLI rodar em paralelo (default 2). */
  maxConcurrent?: number;
}

/** Achata os `messages` da ChatCompletion num único prompt pro CLI. */
function flattenMessages(messages: unknown[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const msg = m as { content?: unknown };
    const c = msg?.content;
    let txt = "";
    if (typeof c === "string") txt = c;
    else if (Array.isArray(c)) txt = c.map((p) => (typeof p === "string" ? p : ((p as { text?: string })?.text ?? ""))).join("");
    if (txt.trim()) parts.push(txt);
  }
  return parts.join("\n\n");
}

function readBody(req: http.IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); reject(new Error("body grande demais")); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e as Error); }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

/** Resposta em SSE (chat.completion.chunk) — alguns clientes pedem stream:true. */
function sendStream(res: http.ServerResponse, model: string, text: string, usage?: { input: number; output: number }, includeUsage?: boolean): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const id = "chatcmpl-shim";
  const base = { id, object: "chat.completion.chunk", created: 0, model };
  const write = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  write({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
  write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  if (includeUsage && usage) {
    write({ ...base, choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output } });
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

/** Sobe o shim. Resolve quando está escutando no loopback. */
export async function startCliShim(opts: CliShimOpts): Promise<CliShim> {
  const reqTimeout = opts.reqTimeoutMs ?? 240_000;
  const max = Math.max(1, opts.maxConcurrent ?? 2);
  const token = randomBytes(24).toString("hex");
  const modelLabel = opts.model || `the-dudes-${opts.runner}`;

  // Limita concorrência das chamadas de CLI (cada uma sobe processo/serve).
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = () => new Promise<void>((res) => {
    if (active < max) { active++; res(); } else waiters.push(() => { active++; res(); });
  });
  const release = () => { active--; const n = waiters.shift(); if (n) n(); };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = req.url || "";
    // Auth: só o graphify local (com o token) pode gastar o CLI. Aceita o token
    // com ou sem prefixo "Bearer " (clientes OpenAI-compat variam).
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (auth !== token) { sendJson(res, 401, { error: { message: "unauthorized" } }); return; }
    // GET /models (alguns SDKs sondam).
    if (req.method === "GET" && /\/models\/?$/.test(url)) {
      sendJson(res, 200, { object: "list", data: [{ id: modelLabel, object: "model", owned_by: "the-dudes" }] });
      return;
    }
    if (req.method !== "POST" || !/\/chat\/completions\/?$/.test(url)) {
      sendJson(res, 404, { error: { message: "not found" } });
      return;
    }
    let body: any;
    try { body = await readBody(req); } catch (e) { sendJson(res, 400, { error: { message: (e as Error).message } }); return; }
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const prompt = flattenMessages(messages);
    if (!prompt.trim()) { sendJson(res, 400, { error: { message: "prompt vazio" } }); return; }

    await acquire();
    let r;
    try {
      r = await runCliText(prompt, {
        runner: opts.runner,
        model: opts.model,
        effort: opts.effort,
        cliCommands: opts.cliCommands,
        dropTo: opts.dropTo,
        claudeConfigDir: opts.claudeConfigDir,
        timeoutMs: reqTimeout,
      });
    } finally { release(); }

    if (!r.ok || !r.text) {
      opts.log?.("warn", `[graph-shim] ${opts.runner} falhou: ${r.error ?? "sem texto"}`);
      sendJson(res, 502, { error: { message: r.error || "cli sem texto" } });
      return;
    }
    if (body?.stream === true) {
      sendStream(res, modelLabel, r.text, r.usage, body?.stream_options?.include_usage === true);
      return;
    }
    sendJson(res, 200, {
      id: "chatcmpl-shim",
      object: "chat.completion",
      created: 0,
      model: modelLabel,
      choices: [{ index: 0, message: { role: "assistant", content: r.text }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: r.usage?.input ?? 0,
        completion_tokens: r.usage?.output ?? 0,
        total_tokens: (r.usage?.input ?? 0) + (r.usage?.output ?? 0),
      },
    });
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      try { sendJson(res, 500, { error: { message: (e as Error).message } }); } catch { /* res já enviado */ }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}/v1`;
  opts.log?.("info", `[graph-shim] ${opts.runner} CLI em ${baseUrl} (modelo: ${modelLabel})`);

  return {
    baseUrl,
    token,
    model: modelLabel,
    stop() { try { server.close(); } catch { /* noop */ } },
  };
}
