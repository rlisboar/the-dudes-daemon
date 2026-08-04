import http from "node:http";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { chmodSync, chownSync, existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import type { DropTarget } from "./privileges.js";
import { decryptForProject, encryptForProject, isE2eEncrypted, rememberCredentialPlaintext } from "./daemon-crypto.js";

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
export function encryptBridgePayload(
  kind: "send" | "memory_add" | "board",
  json: Record<string, unknown>,
  projectId: string,
): Record<string, unknown> {
  const cifra = (v: unknown): unknown => {
    if (typeof v !== "string" || !v || isE2eEncrypted(v)) return v;
    return encryptForProject(v, projectId) ?? v;
  };
  if (kind === "send") {
    if (typeof json.content === "string") json.content = cifra(json.content);
    return json;
  }
  if (kind === "memory_add") {
    if (typeof json.title === "string" && typeof json.body === "string" && !json.contentHash) {
      const norm = (s2: string) => s2.trim().toLowerCase().replace(/\s+/g, " ");
      json.contentHash = createHash("sha256").update(`${norm(json.title)}\n${norm(json.body)}`).digest("hex");
    }
    if (typeof json.title === "string" && !isE2eEncrypted(json.title)) {
      const enc = encryptForProject(json.title, projectId);
      if (enc) { json.titleCipher = enc; delete json.title; }
    }
    if (typeof json.body === "string" && !isE2eEncrypted(json.body)) {
      const enc = encryptForProject(json.body, projectId);
      if (enc) { json.bodyCipher = enc; delete json.body; }
    }
    return json;
  }
  // board_*
  for (const campo of ["title", "body", "say", "text", "label"]) {
    if (campo in json) json[campo] = cifra(json[campo]);
  }
  if (Array.isArray(json.steps)) {
    json.steps = (json.steps as Record<string, unknown>[]).map((st) =>
      st && typeof st === "object" ? { ...st, label: cifra(st.label), detail: cifra(st.detail) } : st,
    );
  }
  if (json.chart && typeof json.chart === "object") {
    const c = json.chart as { labels?: unknown[]; series?: Record<string, unknown>[] };
    if (Array.isArray(c.labels)) c.labels = c.labels.map(cifra);
    if (Array.isArray(c.series)) {
      c.series = c.series.map((se) =>
        se && typeof se === "object" ? { ...se, name: cifra(se.name) } : se,
      );
    }
  }
  return json;
}

export class BridgeRelay {
  public readonly socketPath: string;
  private server: http.Server;
  private orchUrl: string;
  private dropTo: DropTarget | null;
  /** Lookup the project this agent belongs to, so we can E2EE-encrypt
   *  agent-to-agent message bodies before letting them traverse the
   *  server. Wired by the daemon at startup. */
  private agentProjectLookup?: (agentId: string) => string | null;

  private socketDir: string;

  constructor(orchUrl: string, dropTo: DropTarget | null, agentProjectLookup?: (agentId: string) => string | null) {
    this.orchUrl = orchUrl.replace(/\/$/, "");
    this.dropTo = dropTo;
    this.agentProjectLookup = agentProjectLookup;
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
  }

  setAgentProjectLookup(fn: (agentId: string) => string | null) {
    this.agentProjectLookup = fn;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      // Defesa em depth: seta umask 0o007 ANTES de listen pra que o
      // socket seja criado com mode 0o660 direto (sem janela TOCTOU
      // entre listen e chmodSync). chmodSync depois é redundância.
      const prevUmask = process.umask(0o007);
      this.server.listen(this.socketPath, () => {
        process.umask(prevUmask);
        try {
          chmodSync(this.socketPath, 0o660);
          if (this.dropTo) chownSync(this.socketPath, this.dropTo.uid, this.dropTo.gid);
        } catch (e) {
          reject(e);
          return;
        }
        this.server.removeListener("error", reject);
        resolve();
      });
    });
  }

  stop() {
    try { this.server.close(); } catch {}
    try { if (existsSync(this.socketPath)) unlinkSync(this.socketPath); } catch {}
    // Limpa dir random criado por mkdtempSync no shutdown.
    try { rmSync(this.socketDir, { recursive: true, force: true }); } catch {}
  }

  /** Cap defensivo no body relayed pelo Unix socket. Qualquer processo do
   *  user (group SUDO_USER) pode falar com o socket; sem cap, atacante
   *  local manda body de gigabytes e derruba daemon por OOM. 10MB cobre
   *  com folga payloads MCP (tasks list, send_message com anexos). */
  private static readonly MAX_BODY_BYTES = 10 * 1024 * 1024;

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
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
    // Reconstrói o upstream a partir do pathname normalizado + search,
    // não da string crua, pra não reintroduzir o que acabamos de validar.
    const path = parsed.pathname + parsed.search;
    const url = `${this.orchUrl}${path}`;
    let body: Buffer | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks: Buffer[] = [];
      let total = 0;
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
      body = Buffer.concat(chunks);
    }
    // E2EE: agent_to_agent send goes through /api/bridge/<agentId>/send.
    // Encrypt the `content` field with the source agent's project key so
    // the server only forwards ciphertext. Target daemon decrypts on the
    // agent:send path. If we don't hold the key, fall through to plain.
    if (body && body.length > 0 && this.agentProjectLookup) {
      const m = parsed.pathname.match(/^\/api\/bridge\/([^/]+)\/send$/);
      if (m) {
        const agentId = m[1];
        const projectId = this.agentProjectLookup(agentId);
        if (projectId) {
          try {
            const json = JSON.parse(body.toString("utf8"));
            if (json && typeof json === "object") {
              body = Buffer.from(JSON.stringify(encryptBridgePayload("send", json, projectId)), "utf8");
            }
          } catch { /* not JSON or not the shape we expect; leave alone */ }
        }
      }
      // E2EE: memory_add carrega title/body em plaintext do agente. Cifra
      // com a project key antes de subir, igual ao `send` — server guarda
      // só ciphertext (titleCipher/bodyCipher). Mantém a memória de agente
      // no mesmo formato cipher que a memória criada pelo user na UI.
      const mm = parsed.pathname.match(/^\/api\/bridge\/([^/]+)\/memory_add$/);
      if (mm) {
        const projectId = this.agentProjectLookup(mm[1]);
        if (projectId) {
          try {
            const json = JSON.parse(body.toString("utf8"));
            if (json && typeof json === "object") {
              body = Buffer.from(JSON.stringify(encryptBridgePayload("memory_add", json, projectId)), "utf8");
            }
          } catch { /* leave alone */ }
        }
      }
      const bm = parsed.pathname.match(/^\/api\/bridge\/([^/]+)\/(board_[a-z_]+)$/);
      if (bm) {
        const projectId = this.agentProjectLookup(bm[1]);
        if (projectId) {
          try {
            const json = JSON.parse(body.toString("utf8"));
            if (json && typeof json === "object") {
              body = Buffer.from(JSON.stringify(encryptBridgePayload("board", json, projectId)), "utf8");
            }
          } catch { /* leave alone */ }
        }
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
      const upstream = await fetch(url, {
        method: req.method,
        headers: fwd,
        body: body && body.length ? new Uint8Array(body) : undefined,
      });
      let buf = Buffer.from(await upstream.arrayBuffer());
      // E2EE: decrypt cipher fields in list-style responses so the LLM sees
      // plaintext. Server stores ciphertext per project; daemon holds the
      // project key and rewrites the response body in place before handing
      // it to the MCP bridge child.
      const m2 = parsed.pathname.match(/^\/api\/bridge\/([^/]+)\/(tasks_list|tasks_comment_list|goals_list|memory_list|plans_list|plans_get)$/);
      if (m2 && this.agentProjectLookup && upstream.status === 200) {
        const agentId = m2[1];
        const op = m2[2];
        const projectId = this.agentProjectLookup(agentId);
        if (projectId) {
          try {
            const json = JSON.parse(buf.toString("utf8"));
            const dec = (s: unknown): unknown => {
              if (typeof s !== "string" || !isE2eEncrypted(s)) return s;
              return decryptForProject(s, projectId) ?? s;
            };
            const decryptPlanTasks = (tasks: any[]) => {
              for (const t of tasks) {
                if (t.title) t.title = dec(t.title);
                if (t.prompt) t.prompt = dec(t.prompt);
                if (t.output) t.output = dec(t.output);
              }
            };
            if (op === "tasks_list" && Array.isArray(json.tasks)) {
              for (const t of json.tasks) {
                if (t.title) t.title = dec(t.title);
                if (t.description) t.description = dec(t.description);
              }
            } else if (op === "tasks_comment_list" && Array.isArray(json.comments)) {
              for (const c of json.comments) {
                if (c.content) c.content = dec(c.content);
              }
            } else if (op === "goals_list" && Array.isArray(json.goals)) {
              for (const g of json.goals) {
                if (g.title) g.title = dec(g.title);
                if (g.description) g.description = dec(g.description);
              }
            } else if (op === "memory_list" && Array.isArray(json.memories)) {
              // entrega title/body em plaintext pro agente (a tool recall
              // filtra query/substring sobre isto). Mantém os campos cipher.
              for (const e of json.memories) {
                if (e.titleCipher) e.title = dec(e.titleCipher);
                if (e.bodyCipher) e.body = dec(e.bodyCipher);
              }
            } else if (op === "plans_list" && Array.isArray(json.plans)) {
              for (const p of json.plans) {
                if (p.title) p.title = dec(p.title);
                if (p.description) p.description = dec(p.description);
                if (Array.isArray(p.tasks)) decryptPlanTasks(p.tasks);
              }
            } else if (op === "plans_get" && json.plan) {
              if (json.plan.title) json.plan.title = dec(json.plan.title);
              if (json.plan.description) json.plan.description = dec(json.plan.description);
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
                const dec = decryptForProject(json.value, projectId);
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
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `relay failed: ${(e as Error).message}` }));
    }
  }
}
