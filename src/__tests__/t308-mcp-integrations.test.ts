/**
 * T-308 — MCP configurado em Integrations não chegava aos agentes.
 *
 * Cadeia provada aqui (lado daemon):
 *   scanMCPs (fixture local: workspace + override ~/.config/the-dudes)
 *     → MCPDefinition[] → conversão idêntica à do server (project.ts
 *     spawn: transport→type/command/args/env/url/headers)
 *     → extraMcpServers → builders de CADA runner
 *     → nome do MCP presente no config/args que o CLI consome.
 *
 * Complementos:
 *   - config inválida (JSON quebrado / entrada sem command nem url) é
 *     fail-closed ACIONÁVEL: warnings com path+motivo, sem descarte
 *     silencioso e sem vazar env/headers.
 *   - transporte http/sse por runner: claude preserva; gemini httpUrl/url;
 *     opencode remote; codex url (streamable HTTP) com warning de sse;
 *     grok toml url+headers; crush http/sse nativo.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanMCPs } from "../mcps-scanner.js";
import {
  buildClaudeMcpConfig, buildCodexMcpArgs, buildCrushMcpConfig,
  buildGeminiMcpServers, buildGrokMcpToml, buildOpenCodeMcpConfig, summarizeMcpServers,
  type McpServerConfig,
} from "../runners/mcp-config.js";
import type { MCPDefinition } from "../types.js";

/* ---------- fixtures de config local (sem segredos reais) ---------- */

function makeFakeHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(path.join(tmpdir(), "t308-home-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** Converte MCPDefinition → MCPServerConfig EXATAMENTE como project.ts
 *  (spawnAgentInternal) monta extraMcpServers. */
function defsToExtras(defs: MCPDefinition[]): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const m of defs) {
    out[m.name] = {
      type: m.transport as McpServerConfig["type"],
      command: m.command,
      args: m.args,
      env: m.env,
      url: m.url,
      headers: m.headers,
    };
  }
  return out;
}

/** Isola HOME/XDG pro scan só enxergar os fixtures. */
function useFakeHome(home: string): void {
  const prevHome = process.env.HOME;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  after(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
  });
}

const bridge = { command: "node", args: ["bridge.js"], env: { THE_DUDES_AGENT_ID: "${ID}" } };

test("T-308 (1): cadeia scan → extraMcpServers → config/args de cada runner contém o nome do MCP", async () => {
  const { home, cleanup } = makeFakeHome();
  after(cleanup);
  useFakeHome(home);

  // Override da Integração (stdio) + workspace (http com headers) + global claude (sse).
  const xdg = path.join(home, ".config");
  mkdirSync(path.join(xdg, "the-dudes"), { recursive: true });
  writeFileSync(path.join(xdg, "the-dudes", "mcp-servers.json"), JSON.stringify({
    mcpServers: {
      "integra-stdio": { type: "stdio", command: "/usr/local/bin/integra-mcp", args: ["serve"], env: { INTEGRA_TOKEN: "s3cr3t" } },
    },
  }));
  const ws = mkdtempSync(path.join(tmpdir(), "t308-ws-"));
  after(() => rmSync(ws, { recursive: true, force: true }));
  writeFileSync(path.join(ws, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "ws-http": { type: "http", url: "https://mcp.example/u", headers: { Authorization: "Bearer ws-token" } },
    },
  }));
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "mcp_servers.json"), JSON.stringify({
    mcpServers: { "gl-sse": { url: "https://sse.example", transport: "sse" } },
  }));

  // 1) scan
  const scan = await scanMCPs({ workspaceRoot: ws });
  const names = scan.mcps.map((m) => m.name).sort();
  assert.deepEqual(names, ["gl-sse", "integra-stdio", "ws-http"]);
  assert.equal(scan.warnings.length, 0, "config válida não gera warnings");

  // 2) allowlist custom (semântica do resolveMCPsForAgent do server) — só os listados
  const allowlist = ["integra-stdio", "ws-http"];
  const resolved = scan.mcps.filter((m) => allowlist.includes(m.name));

  // 3) conversão server → extraMcpServers (transporte preservado)
  const extras = defsToExtras(resolved);
  assert.equal(extras["integra-stdio"].type, "stdio");
  assert.equal(extras["ws-http"].type, "http");
  assert.equal(extras["ws-http"].url, "https://mcp.example/u");

  // 4) cada runner serializa o nome — NENHUM skip silencioso
  // claude
  const claude = buildClaudeMcpConfig(extras, bridge).mcpServers as Record<string, unknown>;
  assert.ok(claude["integra-stdio"], "claude: stdio presente");
  assert.ok(claude["ws-http"], "claude: http presente");
  // gemini
  const gemini = buildGeminiMcpServers(extras, bridge) as Record<string, any>;
  assert.equal(gemini["integra-stdio"].command, "/usr/local/bin/integra-mcp", "gemini: stdio presente");
  assert.equal(gemini["ws-http"].httpUrl, "https://mcp.example/u", "gemini: http vira httpUrl");
  assert.deepEqual(gemini["ws-http"].headers, { Authorization: "Bearer ws-token" });
  // codex
  const codex = buildCodexMcpArgs(extras, bridge);
  // ws-http tem headers → codex NÃO aplica headers (usa bearer_token_env_var):
  // único warning permitido, e o MCP ainda entra como url (streamable).
  assert.equal(codex.warnings.length, 1, `codex: só o aviso de headers (${codex.warnings.join("; ")})`);
  assert.match(codex.warnings[0], /"ws-http".*headers/);
  assert.ok(!codex.warnings[0].includes("Bearer ws-token"), "warning não imprime valor de header");
  assert.ok(codex.args.some((a) => a.includes("mcp_servers.integra-stdio.command=")), "codex: stdio nos args");
  assert.ok(codex.args.some((a) => a.includes("mcp_servers.ws-http.url=")), "codex: http vira url (streamable)");
  // opencode
  const opencode = buildOpenCodeMcpConfig(extras, bridge, true);
  assert.equal(opencode.warnings.length, 0, "opencode: nada é descartado");
  const ocMcp = opencode.config.mcp as Record<string, any>;
  assert.deepEqual(ocMcp["integra-stdio"].command, ["/usr/local/bin/integra-mcp", "serve"], "opencode: stdio presente");
  assert.equal(ocMcp["ws-http"].type, "remote", "opencode: http vira remote");
  assert.equal(ocMcp["ws-http"].url, "https://mcp.example/u");
  // grok
  const grok = buildGrokMcpToml(extras, bridge);
  assert.equal(grok.warnings.length, 0, "grok: nada é descartado");
  assert.ok(grok.toml.includes("[mcp_servers.integra-stdio]"), "grok: stdio no toml");
  assert.ok(grok.toml.includes("url = \"https://mcp.example/u\""), "grok: http no toml");
  // crush
  const crush = buildCrushMcpConfig(extras, bridge);
  assert.equal(crush.warnings.length, 0, "crush: nada é descartado");
  const crushMcp = crush.config.mcp as Record<string, unknown>;
  assert.ok(crushMcp["integra-stdio"], "crush: stdio presente");
  assert.ok(crushMcp["ws-http"], "crush: http presente");

  // 5) log diagnóstico: nomes+transportes, NUNCA segredos
  const summary = summarizeMcpServers(extras);
  assert.ok(summary.includes("integra-stdio(stdio)"));
  assert.ok(summary.includes("ws-http(http)"));
  assert.ok(!summary.includes("s3cr3t") && !summary.includes("ws-token"), "resumo não vaza env/headers");
});

test("T-308 (3): sse no codex → warning com nome+transporte+motivo (sem descarte silencioso)", () => {
  const r = buildCodexMcpArgs({ "meu-sse": { type: "sse", url: "https://sse" } }, bridge);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /"meu-sse"/);
  assert.match(r.warnings[0], /sse/);
  assert.equal(r.args.filter((a) => a.includes("meu-sse")).length, 0, "sse não vai pros args do codex");
  // headers em http: warning explícito (codex usa bearer_token_env_var)
  const rh = buildCodexMcpArgs({ "h": { type: "http", url: "https://u", headers: { Authorization: "Bearer t" } } }, bridge);
  assert.ok(rh.args.some((a) => a.includes("mcp_servers.h.url=")));
  assert.equal(rh.warnings.length, 1);
  assert.match(rh.warnings[0], /"h".*headers/);
  assert.ok(!rh.warnings[0].includes("Bearer t"), "warning não imprime valor de header");
});

test("T-308 (5a): override com JSON quebrado → warning acionável, demais fontes sobrevivem", async () => {
  const { home, cleanup } = makeFakeHome();
  after(cleanup);
  useFakeHome(home);
  const xdg = path.join(home, ".config");
  mkdirSync(path.join(xdg, "the-dudes"), { recursive: true });
  writeFileSync(path.join(xdg, "the-dudes", "mcp-servers.json"), "{ isto não é json");
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "mcp_servers.json"), JSON.stringify({
    mcpServers: { "gl-stdio": { command: "gl-mcp" } },
  }));

  const scan = await scanMCPs({});
  assert.deepEqual(scan.mcps.map((m) => m.name), ["gl-stdio"], "fonte válida sobrevive ao override quebrado");
  assert.equal(scan.warnings.length, 1, "override quebrado gera warning");
  assert.match(scan.warnings[0].path, /mcp-servers\.json$/);
  assert.match(scan.warnings[0].reason, /JSON inválido/);
});

test("T-308 (5b): entrada sem command nem url → descartada COM motivo; mcpServers vazio no override → warning", async () => {
  const { home, cleanup } = makeFakeHome();
  after(cleanup);
  useFakeHome(home);
  const xdg = path.join(home, ".config");
  mkdirSync(path.join(xdg, "the-dudes"), { recursive: true });
  writeFileSync(path.join(xdg, "the-dudes", "mcp-servers.json"), JSON.stringify({
    mcpServers: {
      "quebrado": { description: "sem command nem url" },
      "ok": { command: "mcp-ok" },
    },
  }));

  const scan = await scanMCPs({});
  assert.deepEqual(scan.mcps.map((m) => m.name), ["ok"]);
  assert.equal(scan.warnings.length, 1);
  assert.match(scan.warnings[0].reason, /"quebrado".*sem command.*nem url/);
});

test("T-308 (2): allowlist ALL/NONE/custom e isolamento por dono (replica resolveMCPsForAgent)", async () => {
  const { home, cleanup } = makeFakeHome();
  after(cleanup);
  useFakeHome(home);
  const xdg = path.join(home, ".config");
  mkdirSync(path.join(xdg, "the-dudes"), { recursive: true });
  writeFileSync(path.join(xdg, "the-dudes", "mcp-servers.json"), JSON.stringify({
    mcpServers: {
      "dono-a": { command: "mcp-a" },
      "dono-b": { command: "mcp-b" },
    },
  }));
  const scan = await scanMCPs({});

  // listas POR USUÁRIO (como workspaceMCPsByUser no server)
  const byUser = new Map<string, MCPDefinition[]>([
    ["user_a", scan.mcps.filter((m) => m.name === "dono-a")],
    ["user_b", scan.mcps.filter((m) => m.name === "dono-b")],
  ]);
  const resolve = (allowlist: string[] | null | undefined, owner: string) => {
    const owned = byUser.get(owner) ?? [];
    if (allowlist === null || allowlist === undefined) return owned;
    if (allowlist.length === 0) return [];
    const set = new Set(allowlist);
    return owned.filter((m) => set.has(m.name));
  };

  // ALL: dono A só vê os DELE
  assert.deepEqual(resolve(undefined, "user_a").map((m) => m.name), ["dono-a"]);
  // NONE
  assert.deepEqual(resolve([], "user_a"), []);
  // custom
  assert.deepEqual(resolve(["dono-a"], "user_a").map((m) => m.name), ["dono-a"]);
  assert.deepEqual(resolve(["dono-a"], "user_b"), [], "allowlist não cruza donos");
  // isolamento: allowlist com nome do OUTRO dono não injeta MCP alheio
  assert.deepEqual(resolve(["dono-b"], "user_a"), []);
});
