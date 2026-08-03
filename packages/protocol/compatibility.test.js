import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Antes daqui saía uma comparação por regex entre `server/src/types.ts` e
 * `web/src/protocol.ts`: extraía os literais `type: "..."` dos dois e exigia
 * listas iguais, com a contagem cravada no assert.
 *
 * Ela falhava em duas frentes:
 *  - via NOMES de comando, não CAMPOS. `add_task` existia dos dois lados, mas
 *    só o web declarava `goalId`; `update_project` só declarava
 *    `collectThinking` no web. O teste passava mesmo assim.
 *  - a contagem cravada (157 comandos / 114 eventos) envelheceu pra 191/125,
 *    então o teste estava VERMELHO no main e treinava a ignorar.
 *
 * Com o contrato num módulo só, divergir virou impossível — quem garante é o
 * compilador. O que sobra pra testar é que a duplicação não volte.
 */

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const serverTypes = readFileSync(resolve(root, "server/src/types.ts"), "utf8");
const webTypes = readFileSync(resolve(root, "web/src/protocol.ts"), "utf8");
const wire = readFileSync(resolve(root, "packages/protocol/wire.d.ts"), "utf8");

test("o contrato de fio é declarado uma vez só, no pacote", () => {
  for (const [nome, src] of [["server", serverTypes], ["web", webTypes]]) {
    assert.match(src, /from "@the-dudes\/protocol\/wire"/, `${nome} deveria importar o contrato`);
    // Redeclarar qualquer uma das uniões localmente traz a duplicata de volta.
    assert.doesNotMatch(src, /export type ServerEvent\s*=/, `${nome} redeclarou ServerEvent`);
    assert.doesNotMatch(src, /export type ClientCommand\s*=/, `${nome} redeclarou ClientCommand`);
  }
  assert.match(wire, /export type ServerEvent\s*=/);
  assert.match(wire, /export type ClientCommand\s*=/);
});

test("nenhum tipo de domínio do fio é redeclarado nos arquivos locais", () => {
  const doWire = new Set(
    [...wire.matchAll(/^export (?:interface|type) ([A-Za-z0-9_]+)\b/gm)].map((m) => m[1]),
  );
  assert.ok(doWire.size > 50, `wire.d.ts deveria trazer o contrato inteiro, achei ${doWire.size}`);
  for (const [nome, src] of [["server", serverTypes], ["web", webTypes]]) {
    const locais = [...src.matchAll(/^export (?:interface|type) ([A-Za-z0-9_]+)\b/gm)].map((m) => m[1]);
    const colisao = locais.filter((n) => doWire.has(n));
    assert.deepEqual(colisao, [], `${nome} redeclara tipos que já vêm do pacote: ${colisao.join(", ")}`);
  }
});

test("os campos que tinham divergido continuam no contrato", () => {
  // Regressão nominal: cada um destes existia só de um lado antes da unificação.
  assert.match(wire, /goalId\?: string \| null/, "add_task/update_task perderam goalId");
  assert.match(wire, /collectThinking\?: boolean/, "update_project perdeu collectThinking");
  assert.match(wire, /title\?: string;\s*\n\s*body\?: string;/, "MemoryEntry perdeu title/body");
});

test("primitivos continuam vindo do index, não redeclarados", () => {
  for (const src of [serverTypes, webTypes]) {
    assert.match(src, /from "@the-dudes\/protocol"/);
    assert.doesNotMatch(src, /export type CliRunner\s*=/);
    assert.doesNotMatch(src, /export type EffortLevel\s*=/);
    assert.doesNotMatch(src, /export type AgentRuntimeState\s*=/);
  }
});
