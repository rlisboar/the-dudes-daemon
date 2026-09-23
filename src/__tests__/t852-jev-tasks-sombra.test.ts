/**
 * T-852 — sombra do Jev nas tasks (fase 1: só observa).
 *
 * Cobre o aceite do card e os 10 itens do parecer do SECURITY (#855): dispara
 * em created/reassigned/edited e não em status-only; skip com motivo; corpo com
 * as 5 perguntas e o elenco dinâmico; evento com o contrato (agentId, nunca
 * rótulo); dedup last-wins e teto de POSTs em voo; rótulos seguros; whitelist
 * do elenco; hash HMAC igual entre daemons e sha256 sem chave; kill-switch e
 * desligamento imediato pelo `project:features`.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { constants, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t852-key-${process.pid}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t852-pkeys-${process.pid}.json`);

const {
  scheduleTaskShadow, flushTaskShadowDebounceForTests, settleTaskShadowForTests,
  setTaskShadowFetch, _resetTaskShadowForTest, classificarEvento, definirElencoProjeto,
} = await import("../typesafe-task-shadow.js");
const { getDaemonPublicKey, rememberProjectKey, forgetProjectKey } = await import("../daemon-crypto.js");
const { registrarJevDoProjeto } = await import("../typesafe-delegate-shadow.js");

const PROJ = "proj_t852";
const PROJ_SEM_CHAVE = "proj_t852_sem_chave";

{
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrap = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, randomBytes(32));
  assert.equal(rememberProjectKey(PROJ, wrap.toString("base64")), true);
}

type Chamada = { url: string; init: { body: string }; opts: { timeoutMs: number; maxRedirects: number } };
let chamadas: Chamada[] = [];
let responder: (c: Chamada, n: number) => { status: number; texto: string };
let emitidos: Array<Record<string, unknown>> = [];

function armar() {
  chamadas = [];
  emitidos = [];
  responder = () => ({ status: 200, texto: corpoOk() });
  setTaskShadowFetch(async (url, init, opts) => {
    const c = { url, init, opts } as Chamada;
    chamadas.push(c);
    const r = responder(c, chamadas.length);
    return { status: r.status, text: async () => r.texto };
  });
  _resetTaskShadowForTest();
}

let emissorAntigo: unknown;

function corpoOk(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: "jev-1.13.0",
    answers: {
      domain: { type: "choice", choice: "PM", probabilities: { PM: 0.7, WEB: 0.3 }, confidence: 0.7 },
      complexity: { type: "choice", choice: "moderate", probabilities: { moderate: 0.6, simple: 0.4 }, confidence: 0.6 },
      destructive: { type: "noul", noul: 0.1 },
      security: { type: "noul", noul: 0.2 },
      acceptance: { type: "noul", noul: 0.8 },
      ...over,
    },
  });
}

const ELENCO = [
  { agentId: "agent_pm", name: "PM", role: "Product Manager e coordenador" },
  { agentId: "agent_web", name: "WEB", role: "Responsável por web/**" },
  { agentId: "agent_qa_b", name: "QA-B", role: "Revisor de web/**" },
];

function preparar(opts: { jev?: boolean; flag?: boolean; chave?: boolean; projectId?: string } = {}) {
  const proj = opts.projectId ?? PROJ;
  if (opts.flag === false) delete process.env.TYPESAFE_TASK_SHADOW; else process.env.TYPESAFE_TASK_SHADOW = "1";
  if (opts.chave === false) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = "k";
  registrarJevDoProjeto(proj, opts.jev !== false);
  definirElencoProjeto(() => ELENCO);
  armar();
  return proj;
}

function tarefa(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "task_852", title: "Arrumar o board", description: "ver aceite", status: "todo", assigneeAgentId: "agent_pm", ...over };
}

async function rodar(op: "tasks_add" | "tasks_update", patch: Record<string, boolean>, task = tarefa(), proj = PROJ) {
  scheduleTaskShadow({ op, projectId: proj, task, patch });
  flushTaskShadowDebounceForTests();
  await settleTaskShadowForTests();
}

test("T-852: created/reassigned/edited disparam; status-only não", () => {
  assert.equal(classificarEvento("tasks_add", {}), "created");
  assert.equal(classificarEvento("tasks_update", { assignee: true }), "reassigned");
  assert.equal(classificarEvento("tasks_update", { title: true }), "edited");
  assert.equal(classificarEvento("tasks_update", { description: true }), "edited");
  assert.equal(classificarEvento("tasks_update", { assignee: true, title: true }), "reassigned");
  assert.equal(classificarEvento("tasks_update", {}), "no-change");
});

test("T-852: skip com motivo (disabled por flag, por jev-off, e2e, no-change)", async () => {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (l: string) => { logs.push(l); };
  try {
    // flag desligada
    preparar({ flag: false });
    await rodar("tasks_add", {});
    assert.equal(chamadas.length, 0);
    assert.ok(logs.some((l) => l.includes('"skip":"disabled"')), logs.join("\n"));

    // projeto sem Jev
    logs.length = 0;
    preparar({ jev: false });
    await rodar("tasks_add", {});
    assert.equal(chamadas.length, 0);
    assert.ok(logs.some((l) => l.includes("jev-off")), logs.join("\n"));

    // campo cifrado que não abre com a chave do projeto
    logs.length = 0;
    preparar();
    await rodar("tasks_add", {}, tarefa({ title: "e2e:blob-que-nao-abre" }));
    assert.equal(chamadas.length, 0);
    assert.ok(logs.some((l) => l.includes('"skip":"e2e"')), logs.join("\n"));

    // status-only
    logs.length = 0;
    preparar();
    await rodar("tasks_update", {});
    assert.equal(chamadas.length, 0);
    assert.ok(logs.some((l) => l.includes("status-only")), logs.join("\n"));

    // mesmo texto e mesmo responsável de novo
    logs.length = 0;
    preparar();
    await rodar("tasks_add", {});
    assert.equal(chamadas.length, 1);
    await rodar("tasks_update", { title: true });
    assert.equal(chamadas.length, 1, "sem mudança de hash/responsável: não reposta");
    assert.ok(logs.some((l) => l.includes('"skip":"no-change"')), logs.join("\n"));
  } finally {
    console.error = orig;
  }
});

test("T-852: o corpo tem as 5 perguntas e o elenco dinâmico com rótulos seguros", async () => {
  const proj = preparar();
  definirElencoProjeto(() => [
    { agentId: "agent_pm", name: "PM", role: "Product Manager" },
    { agentId: "agent_web", name: "WEB QA", role: "Revisor de web/** e CI" },
    { agentId: "agent_x", name: "WEB QA", role: "outro" }, // colisão de rótulo
    { agentId: "agent_y", name: "NONE", role: "reservado" },
  ]);
  await rodar("tasks_add", {}, tarefa(), proj);
  assert.equal(chamadas.length, 1);
  const corpo = JSON.parse(chamadas[0]!.init.body) as {
    model: string;
    state: Record<string, unknown>;
    questions: Record<string, { type: string; criteria: Record<string, string> }>;
  };
  assert.equal(corpo.model, "jev-1.13.0", "modelo pinado");
  assert.deepEqual(Object.keys(corpo.questions).sort(), ["acceptance", "complexity", "destructive", "domain", "security"]);
  assert.equal(corpo.questions.domain!.type, "choice");
  assert.equal(corpo.questions.security!.type, "noul");
  assert.equal(corpo.questions.acceptance!.type, "noul");
  assert.match(corpo.questions.security!.instructions, /authentication|encryption|credentials|permissions/i);
  assert.match(corpo.questions.acceptance!.instructions, /acceptance criteria, tests, or an observable result/);

  const rotulos = Object.keys(corpo.questions.domain!.criteria);
  for (const r of rotulos) assert.match(r, /^[A-Za-z0-9_.-]{1,64}$/, `rótulo seguro: ${r}`);
  assert.equal(rotulos[rotulos.length - 1], "NONE", "NONE por último");
  assert.ok(rotulos.includes("WEB_QA"), "nome higienizado");
  assert.ok(rotulos.includes("WEB_QA-2"), "colisão ganha sufixo");
  assert.ok(rotulos.includes("NONE-2"), "NONE é reservado: colisão vira NONE-2");
  assert.match(corpo.questions.domain!.criteria.PM!, /PM — Product Manager/);

  const estado = corpo.state as { task: Record<string, unknown>; declaredAssignee: string };
  assert.equal(estado.task.title, "Arrumar o board");
  assert.equal(estado.task.description, "ver aceite");
  assert.equal(estado.declaredAssignee, "agent_pm", "declarado vai como agentId");
  assert.equal(chamadas[0]!.opts.maxRedirects, 0);
  assert.ok(chamadas[0]!.opts.timeoutMs <= 2500);
});

test("T-852: o evento sai com o contrato e nunca com o rótulo", async () => {
  const proj = preparar();
  definirElencoProjeto(() => ELENCO);
  const { definirEmissorSombra } = await import("../typesafe-delegate-shadow.js");
  definirEmissorSombra((m) => emitidos.push(m as unknown as Record<string, unknown>));
  await rodar("tasks_update", { assignee: true }, tarefa({ assigneeAgentId: "agent_web" }), proj);

  assert.equal(emitidos.length, 1);
  const ev = emitidos[0]!;
  assert.equal(ev.type, "typesafe:shadow");
  assert.equal(ev.source, "task");
  assert.equal(ev.taskId, "task_852");
  assert.equal(ev.event, "reassigned");
  assert.equal(ev.declaredAssignee, "agent_web");
  assert.equal(ev.domain, "agent_pm", "agentId, não o rótulo PM");
  assert.equal(ev.complexity, "moderate");
  assert.equal(ev.ok, true);
  assert.equal(ev.disagreeDomain, true, "agent_pm != agent_web");
  assert.equal(ev.securityNoul, 0.2);
  assert.equal(ev.acceptanceNoul, 0.8);
  assert.equal(typeof ev.textSha256, "string");
  assert.equal((ev.textSha256 as string).length, 12);
  assert.equal(ev.hashKind, "hmac1");
  assert.ok(ev.probabilities);
  void emissorAntigo;
});

test("T-852: disagreeDomain é null quando o responsável não está no elenco deste daemon", async () => {
  const proj = preparar();
  definirElencoProjeto(() => ELENCO);
  const { definirEmissorSombra } = await import("../typesafe-delegate-shadow.js");
  definirEmissorSombra((m) => emitidos.push(m as unknown as Record<string, unknown>));
  await rodar("tasks_add", {}, tarefa({ assigneeAgentId: "agent_de_outro_host" }), proj);
  assert.equal(emitidos[0]!.disagreeDomain, null);
});

test("T-852: dedup last-wins (um POST por burst) e teto de POSTs em voo", async () => {
  const proj = preparar();
  scheduleTaskShadow({ op: "tasks_update", projectId: proj, task: tarefa({ title: "v1" }), patch: { title: true } });
  scheduleTaskShadow({ op: "tasks_update", projectId: proj, task: tarefa({ title: "v2" }), patch: { title: true } });
  scheduleTaskShadow({ op: "tasks_update", projectId: proj, task: tarefa({ title: "v3" }), patch: { title: true } });
  flushTaskShadowDebounceForTests();
  await settleTaskShadowForTests();
  assert.equal(chamadas.length, 1, "burst = 1 POST");
  assert.match(JSON.parse(chamadas[0]!.init.body).state.task.title, /v3/, "last-wins");

  // Teto em voo: com 3 POSTs pendurados, o quarto é pulado.
  preparar();
  const pendentes: Array<(v: { status: number; texto: string }) => void> = [];
  setTaskShadowFetch((_u, _i, _o) => new Promise((r) => pendentes.push(r)) as never);
  for (const id of ["t1", "t2", "t3", "t4"]) {
    scheduleTaskShadow({ op: "tasks_add", projectId: proj, task: tarefa({ id }), patch: {} });
    flushTaskShadowDebounceForTests();
  }
  assert.equal(pendentes.length, 3, "teto de 3 em voo");
  for (const r of pendentes) r({ status: 200, texto: corpoOk() });
  await settleTaskShadowForTests();
});

test("T-852: falha, timeout e 429 não afetam a task e emitem ok:false", async () => {
  const proj = preparar();
  const { definirEmissorSombra } = await import("../typesafe-delegate-shadow.js");
  definirEmissorSombra((m) => emitidos.push(m as unknown as Record<string, unknown>));
  const orig = console.error;
  console.error = () => {};

  responder = () => { throw Object.assign(new Error("boom"), { name: "TimeoutError" }); };
  await rodar("tasks_add", {}, tarefa({ id: "t-timeout" }), proj);
  assert.equal(emitidos.at(-1)!.ok, false);
  assert.equal(emitidos.at(-1)!.error, "timeout");

  responder = () => ({ status: 429, texto: "{}" });
  await rodar("tasks_add", {}, tarefa({ id: "t-429" }), proj);
  assert.equal(emitidos.at(-1)!.ok, false);
  assert.equal(emitidos.at(-1)!.error, "http_429");

  responder = () => ({ status: 500, texto: "{}" });
  await rodar("tasks_add", {}, tarefa({ id: "t-500" }), proj);
  assert.equal(emitidos.at(-1)!.error, "http_500");

  console.error = orig;
  // O pedido não foi mutado pelo caminho.
  const pedido = { task: tarefa() };
  const antes = JSON.stringify(pedido);
  scheduleTaskShadow({ op: "tasks_add", projectId: proj, task: pedido.task, patch: {} });
  flushTaskShadowDebounceForTests();
  await settleTaskShadowForTests();
  assert.equal(JSON.stringify(pedido), antes);
});

test("T-852: elenco — teto de 24, declarado sempre presente e role higienizado/truncado", async () => {
  const proj = preparar();
  const grande = Array.from({ length: 30 }, (_, i) => ({ agentId: `agent_${String(i).padStart(2, "0")}`, name: `Agente ${i}`, role: `role ${i}` }));
  grande.push({ agentId: "agent_alvo", name: "Alvo", role: "  muito   espaçado  " + "x".repeat(200) });
  definirElencoProjeto(() => grande);
  await rodar("tasks_add", {}, tarefa({ assigneeAgentId: "agent_alvo" }), proj);
  const corpo = JSON.parse(chamadas[0]!.init.body) as { questions: { domain: { criteria: Record<string, string> } } };
  const rotulos = Object.keys(corpo.questions.domain.criteria).filter((r) => r !== "NONE");
  assert.equal(rotulos.length, 24, "teto de 24");
  assert.ok(rotulos.includes("Alvo"), "declarado entra mesmo fora do topo");
  const texto = corpo.questions.domain.criteria.Alvo!;
  assert.ok(!texto.includes("  "), "espaços colapsados");
  assert.ok(texto.length <= 70 + 160, "role truncado");
  assert.match(texto, /…$/);
});

test("T-852: hash igual entre daemons com a mesma chave; sha256 estável sem chave", async () => {
  const proj = preparar();
  const { definirEmissorSombra } = await import("../typesafe-delegate-shadow.js");
  definirEmissorSombra((m) => emitidos.push(m as unknown as Record<string, unknown>));

  await rodar("tasks_add", {}, tarefa({ id: "t-h1" }), proj);
  const h1 = emitidos.at(-1)!.textSha256;
  assert.equal(emitidos.at(-1)!.hashKind, "hmac1");

  // Segundo "host": mesmo projectId, mesma chave, task igual → mesmo hash.
  _resetTaskShadowForTest();
  await rodar("tasks_add", {}, tarefa({ id: "t-h2" }), proj);
  const h2 = emitidos.at(-1)!.textSha256;
  assert.equal(h2, h1, "dois hosts com a mesma chave dão o mesmo hash");

  // Texto diferente muda o hash.
  await rodar("tasks_add", {}, tarefa({ id: "t-h3", title: "outro título" }), proj);
  assert.notEqual(emitidos.at(-1)!.textSha256, h1);

  // Projeto sem chave: sha256, determinístico, nunca hmac1.
  forgetProjectKey(PROJ_SEM_CHAVE);
  registrarJevDoProjeto(PROJ_SEM_CHAVE, true);
  await rodar("tasks_add", {}, tarefa({ id: "t-s1" }), PROJ_SEM_CHAVE);
  assert.equal(emitidos.at(-1)!.hashKind, "sha256");
  const s1 = emitidos.at(-1)!.textSha256;
  _resetTaskShadowForTest();
  await rodar("tasks_add", {}, tarefa({ id: "t-s2" }), PROJ_SEM_CHAVE);
  assert.equal(emitidos.at(-1)!.textSha256, s1, "sha256 consistente");
});

test("T-852: desligar o Jev vale na hora, sem esperar o próximo spawn", async () => {
  const proj = preparar({ jev: true });
  await rodar("tasks_add", {}, tarefa({ id: "t-on" }), proj);
  assert.equal(chamadas.length, 1);

  // É o que o `project:features` chama no main.
  registrarJevDoProjeto(proj, false);
  await rodar("tasks_add", {}, tarefa({ id: "t-off" }), proj);
  assert.equal(chamadas.length, 1, "sem POST depois de desligar");

  registrarJevDoProjeto(proj, true);
  await rodar("tasks_add", {}, tarefa({ id: "t-on2" }), proj);
  assert.equal(chamadas.length, 2);
});

test("T-852: campo cifrado é decifrado localmente antes de desistir", async () => {
  const proj = preparar();
  const { encryptForProject } = await import("../daemon-crypto.js");
  const { aadV2, E2EE_TABLE } = await import("@the-dudes/protocol/e2ee-fields");
  const cifrado = encryptForProject("Título cifrado", proj, aadV2({ projectId: proj, table: E2EE_TABLE.TASKS, field: "title" }));
  assert.ok(cifrado && cifrado.startsWith("e2e:"));
  await rodar("tasks_add", {}, tarefa({ id: "t-cifrado", title: cifrado }), proj);
  assert.equal(chamadas.length, 1, "não pula: decifrou com a chave local");
  const corpo = JSON.parse(chamadas[0]!.init.body) as { state: { task: { title: string } } };
  assert.equal(corpo.state.task.title, "Título cifrado");
});

test("T-852: menos de 2 agentes conhecidos cai na lista fixa (no-roster)", async () => {
  const proj = preparar();
  const logs: string[] = [];
  const orig = console.error;
  console.error = (l: string) => { logs.push(l); };
  definirElencoProjeto(() => [{ agentId: "agent_solo", name: "SOLO", role: "sozinho" }]);
  const { definirEmissorSombra } = await import("../typesafe-delegate-shadow.js");
  definirEmissorSombra((m) => emitidos.push(m as unknown as Record<string, unknown>));
  responder = () => ({ status: 200, texto: corpoOk({ domain: { type: "choice", choice: "WEB", probabilities: { WEB: 0.9, NONE: 0.1 }, confidence: 0.9 } }) });
  await rodar("tasks_add", {}, tarefa({ id: "t-fixo" }), proj);
  console.error = orig;

  const corpo = JSON.parse(chamadas[0]!.init.body) as { questions: { domain: { criteria: Record<string, string> } } };
  assert.ok(corpo.questions.domain.criteria.DAEMON, "lista fixa");
  assert.ok(corpo.questions.domain.criteria.NONE, "NONE presente");
  assert.equal(emitidos.length, 1, "segue disparando (fallback, não skip)");
  assert.equal(emitidos[0]!.domain, "WEB", "sem elenco, o veredito é o papel");
  assert.ok(logs.some((l) => l.includes("no-roster")), logs.join("\n"));
});

test("T-852: camposDoPatch lê só a presença e tolera corpo não-JSON", async () => {
  const { camposDoPatch } = await import("../bridge-relay.js");
  assert.deepEqual(camposDoPatch(Buffer.from(JSON.stringify({ id: "x", title: "t" }))), { title: true, description: false, assignee: false });
  assert.deepEqual(camposDoPatch(Buffer.from(JSON.stringify({ patch: { assignee: "PM" } }))), { title: false, description: false, assignee: true });
  assert.deepEqual(camposDoPatch(Buffer.from("nada")), { title: false, description: false, assignee: false });
  assert.deepEqual(camposDoPatch(null), { title: false, description: false, assignee: false });
});