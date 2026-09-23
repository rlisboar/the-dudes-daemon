/**
 * T-812: servidor HTTP do dashboard de debug — SÓ loopback.
 *
 * Segurança (o daemon segura chaves E2EE e tokens de agente):
 *  - bind 127.0.0.1, sem override: nada disto sai da máquina;
 *  - token aleatório por perfil (arquivo 0600 no home do perfil) exigido em
 *    TODA rota: `?token=` (troca por cookie HttpOnly e redireciona para tirar o
 *    token da barra), cookie por porta ou `Authorization: Bearer`;
 *  - Host header conferido (DNS rebinding) e, em POST, Origin + header próprio
 *    (form/fetch cross-site não passam sem preflight, que não respondemos);
 *  - CSP com nonce por resposta, sem recurso externo; no-store; no-referrer.
 */

import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";

export interface Route {
  method: "GET" | "POST";
  path: string;
  /** Devolve JSON (objeto) ou uma resposta crua já escrita (retorne `undefined`). */
  handler: (ctx: RouteCtx) => unknown | Promise<unknown>;
}

export interface RouteCtx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  body: () => Promise<Record<string, unknown>>;
}

export interface DebugHttpOptions {
  port: number;
  /** Portas tentadas a partir de `port` se ocupada. */
  portScan: number;
  token: string;
  routes: Route[];
  html: (nonce: string) => string;
  log: (level: "info" | "warn" | "error", msg: string) => void;
  onRequest?: () => void;
}

export interface DebugHttpHandle {
  port: number;
  url: string;
  stop: () => void;
}

const HOST = "127.0.0.1";
const MAX_BODY = 64 * 1024;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function newDebugToken(): string {
  return randomBytes(24).toString("base64url");
}

function baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...extra,
  };
}

export function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  let body: string;
  try {
    body = JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
  } catch (e) {
    status = 500;
    body = JSON.stringify({ error: `serialização falhou: ${(e as Error).message}` });
  }
  res.writeHead(status, baseHeaders({ "Content-Type": "application/json; charset=utf-8", "Content-Length": String(Buffer.byteLength(body)) }));
  res.end(body);
}

function unauthorizedPage(port: number): string {
  return `<!doctype html><meta charset="utf-8"><title>the-dudes daemon · debug</title>
<body style="font:14px system-ui;background:#111;color:#ddd;padding:40px">
<h2>Dashboard de debug do daemon</h2>
<p>Falta o token. Abra a URL completa gravada no home do perfil do daemon:</p>
<pre style="background:#222;padding:12px;border-radius:6px">cat ~/.the-dudes/debug-dashboard.url   # perfil padrão
cat ~/.the-dudes-&lt;perfil&gt;/debug-dashboard.url</pre>
<p>Porta desta instância: ${port}.</p></body>`;
}

export function startDebugHttpServer(opts: DebugHttpOptions): Promise<DebugHttpHandle> {
  const cookieName = () => `td_debug_${currentPort}`;
  let currentPort = opts.port;
  const routes = new Map(opts.routes.map((r) => [`${r.method} ${r.path}`, r]));

  const allowedHosts = () => new Set([`127.0.0.1:${currentPort}`, `localhost:${currentPort}`, `[::1]:${currentPort}`]);

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e) => {
      try { if (!res.headersSent) sendJson(res, 500, { error: (e as Error).message }); else res.end(); } catch { /* */ }
    });
  });
  // Um dashboard aberto por horas não pode segurar o shutdown do daemon.
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const host = String(req.headers.host ?? "");
    if (!allowedHosts().has(host)) {
      res.writeHead(421, baseHeaders({ "Content-Type": "text/plain" }));
      res.end("host não permitido");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${host}`);
    const cookies = parseCookies(req.headers.cookie);
    const auth = String(req.headers.authorization ?? "");
    const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    const queryToken = url.searchParams.get("token") ?? "";
    const cookieToken = cookies[cookieName()] ?? "";
    const ok = [cookieToken, bearer, queryToken].some((t) => t && safeEqual(t, opts.token));
    if (!ok) {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(401, baseHeaders({ "Content-Type": "text/html; charset=utf-8" }));
        res.end(unauthorizedPage(currentPort));
      } else {
        sendJson(res, 401, { error: "token ausente ou inválido" });
      }
      return;
    }
    // Token na query da página: vira cookie e some da barra/histórico.
    if (queryToken && req.method === "GET" && url.pathname === "/") {
      res.writeHead(302, baseHeaders({
        "Set-Cookie": `${cookieName()}=${encodeURIComponent(opts.token)}; HttpOnly; SameSite=Strict; Path=/`,
        Location: "/",
      }));
      res.end();
      return;
    }
    if (req.method === "POST") {
      const origin = req.headers.origin;
      if (origin && !allowedHosts().has(origin.replace(/^https?:\/\//, ""))) {
        sendJson(res, 403, { error: "origin não permitida" });
        return;
      }
      if (req.headers["x-td-debug"] !== "1") {
        sendJson(res, 403, { error: "header x-td-debug ausente" });
        return;
      }
    }
    opts.onRequest?.();
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const nonce = randomBytes(16).toString("base64");
      const html = opts.html(nonce);
      res.writeHead(200, baseHeaders({
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": [
          "default-src 'none'",
          `script-src 'nonce-${nonce}'`,
          `style-src 'nonce-${nonce}'`,
          "img-src 'self' data:",
          "connect-src 'self'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join("; "),
      }));
      res.end(html);
      return;
    }
    const route = routes.get(`${req.method} ${url.pathname}`);
    if (!route) {
      sendJson(res, 404, { error: "rota inexistente" });
      return;
    }
    const ctx: RouteCtx = {
      req,
      res,
      url,
      body: () => readBody(req),
    };
    const out = await route.handler(ctx);
    if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
  }

  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = () => {
      currentPort = opts.port + attempt;
      const onError = (e: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        if ((e.code === "EADDRINUSE" || e.code === "EACCES") && attempt < opts.portScan) {
          attempt++;
          tryListen();
          return;
        }
        reject(e);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        // Porta 0 (testes): o SO escolhe — o Host permitido segue a porta real.
        const addr = server.address();
        if (addr && typeof addr === "object") currentPort = addr.port;
        server.on("error", (e) => opts.log("warn", `[debug-http] erro no servidor: ${(e as Error).message}`));
        server.unref();
        resolve({
          port: currentPort,
          url: `http://${HOST}:${currentPort}/`,
          stop: () => {
            try { server.closeAllConnections?.(); } catch { /* */ }
            try { server.close(); } catch { /* */ }
          },
        });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(currentPort, HOST);
    };
    tryListen();
  });
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY) { reject(new Error("body grande demais")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) { resolve({}); return; }
      try {
        const v = JSON.parse(text);
        resolve(v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
      } catch { reject(new Error("JSON inválido")); }
    });
    req.on("error", reject);
  });
}
