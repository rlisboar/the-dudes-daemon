// T-360 — seed de migração cross-runner no daemon (projeto SEM E2EE; o caso com
// chave real é o t365-migrated-seed-e2ee.test.ts).
//
// O contrato: `agent:spawn` com `agent.seedDigest` só vira input quando a sessão
// antiga foi descartada (cross-runner); na mesma runner (troca só de modelo) o
// runner nativo continua na sessão dele e o seed é dispensável. E quando vira
// input, é o PRIMEIRO — antes de qualquer mensagem bufferizada.
//
// T-365 mudou a forma: o digest chega CRU e a origem vai em `seedFrom`; o
// embrulho `<migrated-context …>` passou a ser trabalho do daemon, porque sob
// E2EE o server só tem ciphertext nas mãos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { migratedSeedFor, wrapMigratedContext } from "../migrated-seed.js";
import type { AgentInfo } from "../types.js";

const AQUI = import.meta.dirname;
const FROM = { runner: "claude", model: "sonnet", ts: Date.parse("2026-09-07T05:00:00Z") };
const DIGEST = "# Migração de contexto\n\n## Acoes recentes (sumario)\nfez X";
const TAG = `<migrated-context from-runner="claude" from-model="sonnet" ts="${new Date(FROM.ts).toISOString()}">`;

function agentWith(extra: Partial<AgentInfo>): AgentInfo {
  return { id: "a1", name: "a", usage: {}, ...extra } as unknown as AgentInfo;
}

test("T-360: cross-runner (sessão descartada) → digest vira seed embrulhado na tag", () => {
  const r = migratedSeedFor(agentWith({ seedDigest: DIGEST, seedFrom: FROM }), undefined);
  assert.equal(r.dropped, false);
  assert.equal(r.truncated, false);
  assert.equal(r.seed, `${TAG}\n${DIGEST}\n</migrated-context>`);
});

test("T-370: sessão viva com seed pendurado é queda declarada (o silencio do premain)", () => {
  // O caso que a T-360 tratava como "caminho normal": com digest pendurado,
  // o resume comeu o contexto migrado sem uma linha. Agora é queda com razão
  // — e sem digest (troca só de modelo) continua sem queda.
  const r = migratedSeedFor(agentWith({ seedDigest: DIGEST, seedFrom: FROM }), "ses_abc");
  assert.equal(r.seed, undefined);
  assert.equal(r.dropped, true);
  if (!r.dropped) throw new Error("tipo");
  assert.equal(r.reason, "resume_skips_seed");
  const soModelo = migratedSeedFor(agentWith({ seedFrom: FROM }), "ses_abc");
  assert.equal(soModelo.dropped, false, "sem digest, resume é o caminho normal");
});

test("T-360: sem digest → sem seed", () => {
  assert.equal(migratedSeedFor(agentWith({}), undefined).seed, undefined);
  assert.equal(migratedSeedFor(agentWith({ seedInstruction: "continua" }), undefined).seed, undefined);
});

test("T-360: instrução vai depois do digest, nunca antes", () => {
  const r = migratedSeedFor(
    agentWith({ seedDigest: DIGEST, seedFrom: FROM, seedInstruction: "retoma a task T-9" }),
    undefined,
  );
  assert.ok(r.seed, "seed presente");
  assert.ok(r.seed!.startsWith(TAG), "o bloco embrulhado é o primeiro");
  assert.ok(r.seed!.endsWith("retoma a task T-9"), "a instrução fecha o input");
  assert.ok(r.seed!.indexOf(DIGEST) < r.seed!.indexOf("retoma a task T-9"));
});

test("T-360: instrução em branco não fabrica separador", () => {
  const r = migratedSeedFor(
    agentWith({ seedDigest: DIGEST, seedFrom: FROM, seedInstruction: "   " }),
    undefined,
  );
  assert.equal(r.seed, wrapMigratedContext(DIGEST, FROM));
});

test("T-360: seed é empurrado antes do flush do inbound buffer", () => {
  // O host não tem runner injetável (nasce dentro de spawn), então a ordem é
  // travada na estrutura do fonte — mesmo molde de t147-context-unknown.test.ts.
  const src = readFileSync(join(AQUI, "../agent-host.ts"), "utf8");
  const seed = src.indexOf("migratedSeedFor(msg.agent, resumeSessionId");
  const flush = src.indexOf("this.flushInboundBuffer(msg.agent.id)");
  assert.ok(seed > 0, "spawn compõe o seed");
  assert.ok(flush > 0, "spawn faz flush do buffer");
  assert.ok(seed < flush, "seed precisa ser o primeiro input, antes do flush");
});
