/**
 * T-469 (R15): mcp-bridge — tools registadas + contrato do postJSON.
 *
 * T-577: `mcp-bridge.ts` é um PROGRAMA, não uma lib. O gate `IS_BRIDGE_ENTRYPOINT`
 * lá dentro resolveu os dois efeitos de processo no import (o `process.exit(1)`
 * sem `THE_DUDES_AGENT_ID`, que matava este arquivo no CI, e o stdio ligado, que
 * pendurava o event loop). O que sobra AQUI é determinismo: o registry é
 * filtrado no import por `THE_DUDES_FEATURES` (grupos do projeto) e
 * `THE_DUDES_AGENT_ROLE` (papel do agente), então a env é fixada antes do import
 * dinâmico — FEATURES ausente = registra tudo; ROLE vazio = as 4 tools de
 * controller ficam de fora. Sem isto o teste mede o shell de quem roda.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.THE_DUDES_AGENT_ID = "agent_t469";
delete process.env.THE_DUDES_FEATURES;
delete process.env.THE_DUDES_AGENT_ROLE;

const { server } = await import("../mcp-bridge.js");

after(async () => {
  await server.close();
  // Defensivo: com o gate, o import não conecta nada. Se ele for revertido, o
  // unref devolve o loop ao runner em vez de pendurar o job por 25 min.
  process.stdin.unref?.();
});

test("T-469 mcp-bridge: tools essenciais registadas", () => {
  const reg = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
  const names = Object.keys(reg);
  assert.ok(names.length >= 10, `tools registadas: ${names.length}`);
  for (const t of ["board_clear_drawings", "board_get", "send_message", "add_task"]) {
    assert.ok(names.includes(t), `tool ${t} registada`);
  }
});

test("T-469 mcp-bridge: postJSON usa orchestrator + bearer do token", () => {
  const src = readFileSync(fileURLToPath(new URL("../mcp-bridge.ts", import.meta.url)), "utf8");
  assert.match(src, /"Authorization": `Bearer \$\{/);
  assert.match(src, /\/api\/bridge\/\$\{/);
});
