import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import {
  QUEUE_LIVE_MAX_BYTES, QUEUE_LIVE_MAX_ITEMS, daemonWireSchemas, fromOrchSchemas, queueLiveItemBytes, validateDaemonMessage,
} from "./daemon-wire.js";

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

test("T-1135: hello reporta UUID e aliases opacos, sem caminhos", () => {
  const base = { type: "daemon:hello", name: "d", os: "mac", hostname: "h", version: "1" };
  assert.equal(validateDaemonMessage({
    ...base,
    daemonId: "f1c7a34a-98e9-4f45-94d5-7b0398eb6f06",
    configDirAliases: { claude: [{ alias: "claude-home-01", label: "Perfil pessoal" }], qwen: [] },
  }).ok, true);
  assert.equal(validateDaemonMessage({
    ...base,
    configDirAliases: { claude: [{ alias: "/Users/alice/.claude", label: "Perfil" }] },
  }).ok, false);
  assert.equal(validateDaemonMessage({
    ...base,
    configDirAliases: { claude: Array.from({ length: 33 }, (_, i) => ({ alias: `claude-${String(i).padStart(8, "0")}`, label: "Perfil" })) },
  }).ok, false);
});

test("T-1135: runner-defaults:set limita runner, effort e alias opaco", () => {
  const { success } = fromOrchSchemas["runner-defaults:set"].safeParse({
    type: "runner-defaults:set", daemonId: "f1c7a34a-98e9-4f45-94d5-7b0398eb6f06", version: 2,
    defaults: { claude: { model: "claude-sonnet-4", effort: "high", claudeConfigDir: "claude-home-01" } },
  });
  assert.equal(success, true);
  assert.equal(fromOrchSchemas["runner-defaults:set"].safeParse({
    type: "runner-defaults:set", daemonId: "d", version: 0,
    defaults: { claude: { claudeConfigDir: "/tmp/profile" } },
  }).success, false);
  assert.equal(fromOrchSchemas["runner-defaults:set"].safeParse({
    type: "runner-defaults:set", daemonId: "d", version: 0,
    defaults: { unknown: { model: "x" } },
  }).success, false);
});

test("T-594: agent:send aceita `mem` (mapa de mission scratch) e recusa valor não-string", () => {
  const schema = fromOrchSchemas["agent:send"];
  assert.ok(schema, "agent:send sumiu do contrato FromOrch");
  const base = { type: "agent:send", agentId: "a1", content: "oi" };
  assert.equal(schema.safeParse(base).success, true, "sem mem continua válido (campo opcional)");
  assert.equal(schema.safeParse({ ...base, mem: {} }).success, true);
  assert.equal(schema.safeParse({ ...base, mem: { RESULTADO: "relatorio" } }).success, true);
  assert.equal(schema.safeParse({ ...base, mem: { RESULTADO: 42 } }).success, false, "valor não-string");
});

test("T-1006 (acréscimo PM): agent:send aceita `origin`/`silent` opcionais e recusa origin fora do enum", () => {
  const schema = fromOrchSchemas["agent:send"];
  assert.ok(schema, "agent:send sumiu do contrato FromOrch");
  const base = { type: "agent:send", agentId: "a1", content: "oi" };
  assert.equal(schema.safeParse(base).success, true, "sem origin/silent segue válido (daemon antigo)");
  for (const origin of ["user", "agent", "system"]) {
    assert.equal(schema.safeParse({ ...base, origin }).success, true, `origin ${origin}`);
  }
  assert.equal(schema.safeParse({ ...base, origin: "user", silent: true }).success, true);
  assert.equal(schema.safeParse({ ...base, silent: false }).success, true);
  assert.equal(schema.safeParse({ ...base, origin: "humano" }).success, false, "origin fora do enum");
  assert.equal(schema.safeParse({ ...base, silent: "sim" }).success, false, "silent não-boolean");
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
/**
 * T-878 (Jev nas tasks): o contrato novo é ADITIVO. O daemon antigo (só
 * delegate, sem os campos) tem de continuar válido — e um campo declarado com
 * tipo errado continua derrubando a mensagem no fail-closed.
 */
test("T-878: typesafe:shadow aceita o contrato novo e o daemon antigo", () => {
  const legado = {
    type: "typesafe:shadow", projectId: "p1", at: 1, ok: true, error: null, model: "jev", latencyMs: 40,
    declaredTaskType: "coding", declaredComplexity: "simple", taskType: "review", complexity: "moderate",
    domain: "server", confidence: { task_type: 0.9, complexity: 0.4, domain: 0.8 },
    destructiveNoul: 0.1, disagreeTaskType: false, disagreeComplexity: false,
  };
  assert.equal(validateDaemonMessage(legado).ok, true, "daemon antigo segue válido");

  const novo = {
    ...legado,
    source: "task", taskId: "task_1", event: "create", declaredAssignee: "ag-server",
    probabilities: { domain: { server: 0.8, web: 0.2 }, complexity: { moderate: 0.6 } },
    securityNoul: 0.8, acceptanceNoul: 0.2, disagreeDomain: null,
    textSha256: "abc123abc123", goalSha256: "def456def456", hashKind: "hmac1",
  };
  assert.equal(validateDaemonMessage(novo).ok, true, "campos novos aceitos");
  assert.equal(validateDaemonMessage({ ...novo, disagreeDomain: true }).ok, true, "tri-estado aceita false/true");
  assert.equal(validateDaemonMessage({ ...novo, disagreeDomain: "sim" }).ok, false, "disagreeDomain não-nulo é boolean");
  assert.equal(validateDaemonMessage({ ...novo, hashKind: "md5" }).ok, false, "hashKind fora do enum");
  assert.equal(validateDaemonMessage({ ...novo, probabilities: { domain: { a: "x" } } }).ok, false, "probabilidade não-numérica");
  assert.equal(validateDaemonMessage({ ...novo, textSha256: 7 }).ok, false);
});

test("T-878: project:features existe nos dois lados do contrato e exige a flag", () => {
  assert.match(dts, /export interface ProjectFeatures\b/, "interface ausente do .d.ts");
  assert.match(dts, /type: "project:features"/);
  assert.match(dts, /\|\s*ProjectFeatures\b/, "ProjectFeatures fora do union FromOrch");
  const schema = fromOrchSchemas["project:features"];
  assert.ok(schema, "sem schema, o guard estrutural e o parse falham");
  assert.equal(schema.safeParse({ type: "project:features", projectId: "p1", jev: true }).success, true);
  assert.equal(schema.safeParse({ type: "project:features", projectId: "p1" }).success, false, "flag obrigatória");
  assert.equal(schema.safeParse({ type: "project:features", projectId: "p1", jev: "on" }).success, false);
});

/**
 * T-878 (aceite do card): o contrato novo é opcional E o schema NÃO é estrito.
 *
 * Não ser estrito é o que garante que um DAEMON NOVO falando com um SERVER ANTIGO
 * não seja rejeitado (o server antigo não declara os campos novos → eles são
 * "chave extra" → `strip`, não erro) e que o inverso também funcione. Sem isso o
 * deploy teria ordem obrigatória. `validateDaemonMessage` só olha `success` e o
 * handler usa o objeto CRU, então `strip` não perde nada.
 */
test("T-878: schema de typesafe:shadow é não-estrito (chave extra passa) e os novos campos são opcionais", () => {
  // T-974: asserção por COMPORTAMENTO (vale em qualquer zod). A introspecção do
  // `_def.unknownKeys` era do zod 3 e o lock resolve zod 4 — o teste morria
  // com o contrato certo.
  assert.equal(validateDaemonMessage(shadowBase()).ok, true, "sem os campos novos (daemon antigo) tem de passar");

  // o que um SERVER ANTIGO vê de um daemon novo: campos que o schema dele não
  // declara. Tem de passar.
  const legadoComCampoFuturo = {
    type: "typesafe:shadow", projectId: "p1", at: 1, ok: true, error: null, model: "jev", latencyMs: 40,
    declaredTaskType: "coding", declaredComplexity: "simple", taskType: "review", complexity: "moderate",
    domain: "server", confidence: null, destructiveNoul: 0.1, disagreeTaskType: false, disagreeComplexity: false,
    source: "task", taskId: "task_1", hashKind: "hmac1", probabilidadesDoFuturo: { a: 1 },
  };
  assert.equal(validateDaemonMessage(legadoComCampoFuturo).ok, true,
    "chave extra foi rejeitada: esquema ficou estrito e daemon novo x server antigo passaria a exigir ordem de deploy");
  // strip, não passthrough nem strict: a chave desconhecida some do parse (o
  // handler usa o objeto CRU, então nada se perde)
  const parsed = daemonWireSchemas["typesafe:shadow"].safeParse(legadoComCampoFuturo);
  assert.equal(parsed.success, true);
  assert.equal("probabilidadesDoFuturo" in parsed.data, false, "chave extra devia ser descartada (strip)");
});

test("T-878: vocabulário do hashKind bate com o CHECK da v22 (sha256|hmac1)", () => {
  // Fonte da verdade no server: migrations v22 (T-853),
  // CHECK (hash_kind IS NULL OR hash_kind IN ('sha256', 'hmac1')).
  // Um terceiro valor aqui (ex.: md5) passaria no pacote e morreria no INSERT.
  // T-974: `unwrap()`/`options` são API PÚBLICA (zod 3 e 4) — o `_def` não é.
  const hk = daemonWireSchemas["typesafe:shadow"].shape.hashKind;
  assert.deepEqual([...hk.unwrap().options].sort(), ["hmac1", "sha256"], "vocabulário divergiu do CHECK da v22");
  // e o comportamento, que é o que o wire vê
  for (const kind of ["sha256", "hmac1"]) {
    assert.equal(validateDaemonMessage({ ...shadowBase(), hashKind: kind }).ok, true, `${kind} é do contrato`);
  }
  for (const kind of ["md5", "SHA256", "", null, 1]) {
    assert.equal(validateDaemonMessage({ ...shadowBase(), hashKind: kind }).ok, false, `${JSON.stringify(kind)} fora do contrato`);
  }
  // ausente = daemon antigo (só delegate). `null` NÃO: o daemon nunca manda
  // (typesafe-task-shadow.ts tipa só "hmac1" | "sha256").
  assert.equal(validateDaemonMessage(shadowBase()).ok, true, "hashKind ausente é o legado");
});

test("T-878: project:features é não-estrito e exige só (projectId, jev)", () => {
  const schema = fromOrchSchemas["project:features"];
  // T-974: comportamento em vez de `_def.unknownKeys` (zod 3)
  assert.equal(schema.safeParse({ type: "project:features", projectId: "p1", jev: false, futuro: 1 }).success, true,
    "chave extra foi rejeitada: esquema ficou estrito");
  assert.equal(schema.safeParse({ type: "project:features", projectId: "p1", jev: true }).success, true);
  assert.equal(schema.safeParse({ projectId: "p1", jev: true }).success, false, "type obrigatório");
  assert.equal(schema.safeParse({ type: "project:features", jev: true }).success, false, "projectId obrigatório");
  assert.equal(schema.safeParse({ type: "project:features", projectId: "p1" }).success, false, "jev obrigatório");
});

/** Payload mínimo do shadow do daemon (só os campos obrigatórios do contrato). */
function shadowBase() {
  return {
    type: "typesafe:shadow", projectId: "p1", at: 1, ok: true, error: null, model: "jev", latencyMs: 40,
    declaredTaskType: "coding", declaredComplexity: "simple", taskType: "review", complexity: "moderate",
    domain: "server", confidence: null, destructiveNoul: 0.1, disagreeTaskType: false, disagreeComplexity: false,
  };
}

/**
 * T-1006: snapshot da fila AO VIVO. Fail-closed nos tetos que o daemon respeita
 * cortando os mais novos (`truncated`), e o comando de remover do server.
 */
function liveSnap(items, extra = {}) {
  return { type: "agent:queue_live", agentId: "a1", projectId: "p1", at: 1, items, ...extra };
}
const liveItem = (i, content = "x") => ({ deliveryId: `d${i}`, content, enqueuedAt: i, origin: "user" });

test("T-1006: agent:queue_live aceita o contrato (vazio, truncated, images, silent, origens)", () => {
  assert.equal(validateDaemonMessage(liveSnap([])).ok, true, "lista vazia = fila esvaziou");
  assert.equal(validateDaemonMessage(liveSnap([liveItem(1)], { truncated: true })).ok, true);
  for (const origin of ["user", "agent", "system"]) {
    assert.equal(validateDaemonMessage(liveSnap([{ ...liveItem(1), origin }])).ok, true, `origin ${origin}`);
  }
  assert.equal(validateDaemonMessage(liveSnap([{ ...liveItem(1), images: [{ mime: "image/png" }], silent: true }])).ok, true);
  assert.equal(validateDaemonMessage(liveSnap([liveItem(1, "e2e:v2+blob")])).ok, true, "blob e2e: passa como veio");
});

test("T-1006: agent:queue_live recusa fora do contrato (fail-closed)", () => {
  assert.equal(validateDaemonMessage(liveSnap([{ ...liveItem(1), origin: "humano" }])).ok, false, "origin fora do enum");
  assert.equal(validateDaemonMessage(liveSnap([{ ...liveItem(1), deliveryId: "" }])).ok, false, "deliveryId vazio");
  const semId = liveItem(1);
  delete semId.deliveryId;
  assert.equal(validateDaemonMessage(liveSnap([semId])).ok, false, "deliveryId obrigatório");
  assert.equal(validateDaemonMessage(liveSnap([{ ...liveItem(1), enqueuedAt: "ontem" }])).ok, false);
  assert.equal(validateDaemonMessage({ ...liveSnap([]), projectId: undefined }).ok, false, "projectId obrigatório");
  assert.equal(validateDaemonMessage({ ...liveSnap([]), items: undefined }).ok, false, "items obrigatório");
});

test("T-1006: tetos do snapshot — itens e bytes, exatamente na borda", () => {
  assert.equal(QUEUE_LIVE_MAX_ITEMS, 200);
  const cheio = Array.from({ length: QUEUE_LIVE_MAX_ITEMS }, (_, i) => liveItem(i));
  assert.equal(validateDaemonMessage(liveSnap(cheio)).ok, true, "200 itens cabe");
  assert.equal(validateDaemonMessage(liveSnap([...cheio, liveItem(999)])).ok, false, "201 itens não cabe");

  // borda de bytes: um item com content de exatamente o teto passa; +1 byte não
  const noTeto = liveItem(1, "a".repeat(QUEUE_LIVE_MAX_BYTES));
  assert.equal(queueLiveItemBytes(noTeto), QUEUE_LIVE_MAX_BYTES);
  assert.equal(validateDaemonMessage(liveSnap([noTeto])).ok, true, "exatamente no teto de bytes");
  assert.equal(validateDaemonMessage(liveSnap([liveItem(1, "a".repeat(QUEUE_LIVE_MAX_BYTES + 1))])).ok, false, "1 byte acima");
  // a soma conta: dois itens de metade + 1 estouram
  const meio = "a".repeat(QUEUE_LIVE_MAX_BYTES / 2 + 1);
  assert.equal(validateDaemonMessage(liveSnap([liveItem(1, meio), liveItem(2, meio)])).ok, false, "o teto é do snapshot, não do item");
  // bytes são UTF-8 (não .length): "é" = 2 bytes
  assert.equal(queueLiveItemBytes({ content: "é" }), 2);
  // images contam no teto
  assert.ok(queueLiveItemBytes({ content: "", images: [{ data: "x".repeat(10) }] }) > 10);
});

test("T-1006: agent:queue_live_remove (server → daemon) exige agentId e deliveryId", () => {
  const schema = fromOrchSchemas["agent:queue_live_remove"];
  assert.ok(schema, "sem schema do comando");
  assert.equal(schema.safeParse({ type: "agent:queue_live_remove", agentId: "a1", deliveryId: "d1" }).success, true);
  assert.equal(schema.safeParse({ type: "agent:queue_live_remove", agentId: "a1" }).success, false, "deliveryId obrigatório");
  assert.equal(schema.safeParse({ type: "agent:queue_live_remove", deliveryId: "d1" }).success, false, "agentId obrigatório");
  assert.equal(schema.safeParse({ type: "agent:queue_live_remove", agentId: "a1", deliveryId: "" }).success, false);
});

test("T-1135/F2b: daemon:health preserva runnerStatus e valida fields read-only", () => {
  const health = {
    ts: 1,
    uptimeS: 2,
    memRssMb: 3,
    wsRttMs: null,
    turnGate: { active: 0, queued: 0, max: 1 },
    turns: { started: 0, ok: 0, failed: 0, hardRecovers: 0, hangs: 0 },
    turnP50Ms: null,
    turnP95Ms: null,
    byRunner: {},
    agentsRunning: 0,
    e2eeProjects: 0,
    runnerStatus: {
      claude: {
        installed: true,
        version: "2.1.3",
        binary: "/usr/local/bin/claude",
        claudeConfigDir: { alias: "claude-home-01", source: "default" },
      },
      qwen: { installed: false },
    },
  };
  const frame = { type: "daemon:health", health };
  const parsed = daemonWireSchemas["daemon:health"].safeParse(frame);
  assert.equal(validateDaemonMessage(frame).ok, true);
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data.health.runnerStatus, health.runnerStatus,
    "Zod precisa reconhecer o campo para ele não ser removido do health parseado");
  assert.equal(fromOrchSchemas["runner-defaults:set"].safeParse({
    type: "runner-defaults:set",
    daemonId: "d",
    version: 1,
    defaults: { claude: { binary: "/tmp/evil" } },
  }).success, false, "binário de report não vira configuração server→daemon");

  const overVersion = structuredClone(frame);
  overVersion.health.runnerStatus.claude.version = "v".repeat(129);
  assert.equal(validateDaemonMessage(overVersion).ok, false, "versão tem teto");
  const overBinary = structuredClone(frame);
  overBinary.health.runnerStatus.claude.binary = "b".repeat(1025);
  assert.equal(validateDaemonMessage(overBinary).ok, false, "binário tem teto");
  const badSource = structuredClone(frame);
  badSource.health.runnerStatus.claude.claudeConfigDir.source = "server";
  assert.equal(validateDaemonMessage(badSource).ok, false, "origem é enum fechada");
  const badAlias = structuredClone(frame);
  badAlias.health.runnerStatus.claude.claudeConfigDir.alias = "/Users/alice/.claude";
  assert.equal(validateDaemonMessage(badAlias).ok, false, "alias nunca é caminho");
  const unknownRunner = structuredClone(frame);
  unknownRunner.health.runnerStatus.unknown = { installed: true };
  assert.equal(validateDaemonMessage(unknownRunner).ok, false, "runner precisa estar no catálogo");
});
