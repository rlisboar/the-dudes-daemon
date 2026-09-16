/**
 * T-557 (R16b/C3): docs/MCP-BRIDGE.md em sincronia com as tools registadas.
 *
 * T-577: mesmo cuidado do t469 — o módulo é um programa (o gate
 * `IS_BRIDGE_ENTRYPOINT` lá dentro impede a morte no import e o stdio pendurado).
 * Aqui a env fixada importa DUPLO: além de impedir a morte no import, ela é o
 * que faz o registry valer 48 tools e casar com o catálogo do doc. Um
 * `THE_DUDES_FEATURES` herdado do shell (o daemon local roda com
 * `board,teammates,...`) derruba o registry pra 42 e o teste acusa divergência
 * de doc que não existe.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.THE_DUDES_AGENT_ID = "agent_t557";
delete process.env.THE_DUDES_FEATURES;
delete process.env.THE_DUDES_AGENT_ROLE;

const { server } = await import("../mcp-bridge.js");

after(async () => {
  await server.close();
  process.stdin.unref?.();
});

test("T-557: toda tool registada está documentada no MCP-BRIDGE.md", () => {
  const doc = readFileSync(fileURLToPath(new URL("../../../docs/MCP-BRIDGE.md", import.meta.url)), "utf8");
  // Limita ao BLOCO do catálogo: um nome que também aparece em prosa não pode
  // mascarar a remoção da linha documental (M3 morre aqui).
  const bloco = doc.slice(doc.indexOf("## Catálogo completo das tools"));
  const names = Object.keys((server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {});
  assert.ok(names.length >= 40, `registry pequeno demais: ${names.length}`);
  const faltando = names.filter((n) => !new RegExp(`\\b${n}\\b`).test(bloco));
  assert.deepEqual(faltando, [], `tools sem doc: ${faltando.join(", ")}`);
  // Contagem de linhas do catálogo == registry: remover uma linha morre MESMO
  // se o nome sobreviver na prosa (M3) — e um heading renomeado cai aqui.
  const linhas = [...bloco.matchAll(/^- `([a-z_]+)`$/gm)];
  assert.equal(linhas.length, names.length, `catálogo com ${linhas.length} linhas para ${names.length} tools`);
});

test("T-557: nenhuma tool documentada como existente aponta pra nome morto", () => {
  const doc = readFileSync(fileURLToPath(new URL("../../../docs/MCP-BRIDGE.md", import.meta.url)), "utf8");
  const names = new Set(Object.keys((server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {}));
  const bloco = doc.slice(doc.indexOf("## Catálogo completo das tools"));
  const citadas = [...bloco.matchAll(/^- `([a-z_]+)`$/gm)].map((m) => m[1]!);
  const mortas = citadas.filter((n) => !names.has(n));
  assert.deepEqual(mortas, [], `nomes no catálogo sem tool: ${mortas.join(", ")}`);
});
