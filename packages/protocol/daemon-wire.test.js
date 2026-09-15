import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonWireSchemas, fromOrchSchemas, validateDaemonMessage } from "./daemon-wire.js";

/**
 * T-423 (A6): guarda estrutural do contrato FromDaemon.
 *
 * Lê o .d.ts (fonte do union) e cobra schema para CADA membro — um type novo
 * no union sem schema é recusado em runtime pelo fail-closed; este teste
 * transforma isso em build vermelho antes de chegar em produção.
 */

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const dts = readFileSync(resolve(root, "packages/protocol/daemon-wire.d.ts"), "utf8");

/** Nome do membro → type literal, direto dos unions do contrato. */
function typesDoUnion(nomeUnion) {
  const from = dts.indexOf(`export type ${nomeUnion}`);
  assert.notEqual(from, -1, `union ${nomeUnion} sumiu do daemon-wire.d.ts`);
  const fim = dts.indexOf("export type ", from + 10);
  const block = dts.slice(from, fim > 0 ? fim : dts.length);
  const nomes = [...block.matchAll(/\|\s*(\w+)/g)].map((m) => m[1]);
  const mapa = new Map();
  for (const nome of nomes) {
    const re = new RegExp(`export interface ${nome}\\b[\\s\\S]*?type:\\s*"([^"]+)"`);
    const m = re.exec(dts);
    assert.ok(m, `interface ${nome} sem type literal`);
    mapa.set(nome, m[1]);
  }
  return mapa;
}

const fromDaemonTypes = () => typesDoUnion("FromDaemon");

test("T-423: todo type de FromDaemon tem schema (e nenhum schema órfão)", () => {
  const mapa = fromDaemonTypes();
  assert.ok(mapa.size >= 40, `esperava ≥40 mensagens FromDaemon, achei ${mapa.size}`);
  const sem = [...mapa.values()].filter((t) => !(t in daemonWireSchemas));
  assert.deepEqual(sem, [], `mensagem FromDaemon sem schema: ${sem.join(", ")}`);
  const orfaos = Object.keys(daemonWireSchemas).filter((t) => ![...mapa.values()].includes(t));
  assert.deepEqual(orfaos, [], `schema sem type FromDaemon correspondente: ${orfaos.join(", ")}`);
});

test("T-423: 97 mensagens do contrato têm schema (FromDaemon + FromOrch)", () => {
  const orch = typesDoUnion("FromOrch");
  assert.ok(orch.size >= 50, `esperava ≥50 mensagens FromOrch, achei ${orch.size}`);
  const sem = [...orch.values()].filter((t) => !(t in fromOrchSchemas));
  assert.deepEqual(sem, [], `mensagem FromOrch sem schema: ${sem.join(", ")}`);
  const orfaos = Object.keys(fromOrchSchemas).filter((t) => ![...orch.values()].includes(t));
  assert.deepEqual(orfaos, [], `schema sem type FromOrch correspondente: ${orfaos.join(", ")}`);
  const total = new Set([...fromDaemonTypes().values(), ...orch.values()]);
  assert.ok(total.size >= 97, `contrato com ${total.size} mensagens tipadas (esperava ≥97)`);
});

test("T-423: fail-closed — mensagem sem schema é recusada", () => {
  assert.equal(validateDaemonMessage({ type: "daemon:nao_existe" }).ok, false);
  assert.match(validateDaemonMessage({ type: "daemon:nao_existe" }).error, /sem schema/);
  assert.equal(validateDaemonMessage({}).ok, false);
});

test("T-423: payload válido conhecido passa; campo errado recusa", () => {
  assert.equal(validateDaemonMessage({ type: "daemon:ping", ts: 1 }).ok, true);
  assert.equal(
    validateDaemonMessage({ type: "agent:text", agentId: "a1", text: "oi" }).ok,
    true,
  );
  assert.equal(validateDaemonMessage({ type: "daemon:hello", name: "d", os: "mac", hostname: "h", version: "1" }).ok, true);
  assert.equal(
    validateDaemonMessage({
      type: "agent:state", agentId: "a1", state: "idle",
    }).ok,
    true,
  );
  // tipo errado em campo obrigatório
  assert.equal(validateDaemonMessage({ type: "daemon:ping", ts: "agora" }).ok, false);
  assert.equal(validateDaemonMessage({ type: "agent:exit", agentId: "a1", code: "0" }).ok, false);
  // campo obrigatório ausente
  assert.equal(validateDaemonMessage({ type: "agent:text", agentId: "a1" }).ok, false);
  // erro aponta o campo
  assert.match(validateDaemonMessage({ type: "agent:text", agentId: 7, text: "x" }).error, /agentId/);
});

test("T-423: scanner aninhado tolera campo novo (passthrough) mas exige o núcleo", () => {
  assert.equal(
    validateDaemonMessage({
      type: "skills:scan",
      skills: [{ name: "s", source: "workspace", path: "/p", body: "b", contentHash: "h", frontmatter: { name: "s", description: "d", futuro: true } }],
      scannedSources: ["/a"],
      ts: 1,
    }).ok,
    true,
  );
  assert.equal(
    validateDaemonMessage({ type: "skills:scan", skills: [{ name: "s", source: "workspace" }], scannedSources: [], ts: 1 }).ok,
    false,
  );
});