/**
 * T-770: MCP morto não pode subir em silêncio.
 * - comando stdio que não existe (absoluto, relativo com barra ou nome fora do
 *   PATH) → warning com NOME do servidor e o COMANDO (nunca args/env);
 * - <ws>/.gemini/settings.json passa a ser escaneado (o Gemini CLI o lê).
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mcpCommandExists, scanMCPs } from "../mcps-scanner.js";

function workspaceCom(servers: Record<string, unknown>, onde: ".mcp.json" | ".gemini/settings.json" = ".mcp.json"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t770-"));
  const file = path.join(dir, onde);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  return dir;
}

test("T-770: comando absoluto inexistente, relativo não resolvido e válido", async () => {
  const dir = workspaceCom({
    mortoAbsoluto: { command: "/nao/existe/mcp-server", args: ["--x"], env: { TOKEN: "s3cr3t" } },
    mortoRelativo: { command: "bin/que-nao-existe" },
    mortoPath: { command: "comando-que-nao-existe-xyz" },
    vivo: { command: process.execPath },
    remoto: { url: "http://127.0.0.1:1/mcp" },
  });
  const r = await scanMCPs({ workspaceRoot: dir });
  const razões = r.warnings.map((w) => w.reason).join("\n");
  assert.match(razões, /MCP "mortoAbsoluto" \(workspace\): comando não encontrado no disco\/PATH: "\/nao\/existe\/mcp-server"/);
  assert.match(razões, /MCP "mortoRelativo" .*comando não encontrado/);
  assert.match(razões, /MCP "mortoPath" .*comando não encontrado/);
  assert.doesNotMatch(razões, /"vivo"/, "comando válido não avisa");
  assert.doesNotMatch(razões, /"remoto"/, "http/sse não tem command");
  assert.doesNotMatch(razões, /s3cr3t|--x/, "warning só com nome+comando (sem env/args)");
  assert.equal(r.mcps.length, 5, "servidores mortos continuam listados");
});

test("T-770: .gemini/settings.json do workspace entra no scan (fonte gemini-project)", async () => {
  const dir = workspaceCom({ vivoGemini: { command: process.execPath } }, ".gemini/settings.json");
  const r = await scanMCPs({ workspaceRoot: dir });
  assert.ok(r.mcps.some((m) => m.name === "vivoGemini" && m.source === "gemini-project"), JSON.stringify(r.mcps));
  assert.ok(r.scannedSources.some((p) => p.endsWith(".gemini/settings.json")));
  assert.doesNotMatch(r.warnings.map((w) => w.reason).join("\n"), /vivoGemini/);
});

test("T-770: mcpCommandExists cobre absoluto/relativo/PATH e rejeita diretório", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t770x-"));
  const arquivo = path.join(dir, "bin", "x");
  mkdirSync(path.dirname(arquivo), { recursive: true });
  writeFileSync(arquivo, "#!/bin/sh\n");
  assert.equal(mcpCommandExists(arquivo), true);
  assert.equal(mcpCommandExists("bin/x", dir), true, "relativo resolve no workspace");
  assert.equal(mcpCommandExists("bin/x"), false, "sem workspaceRoot, relativo não acha");
  assert.equal(mcpCommandExists("node", undefined, { PATH: process.env.PATH }), true);
  assert.equal(mcpCommandExists("nao-existe-xyz", undefined, { PATH: process.env.PATH }), false);
  assert.equal(mcpCommandExists(dir, undefined, {}), false, "diretório não conta");
});