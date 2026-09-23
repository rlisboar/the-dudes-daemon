/**
 * T-868 — consumir `project:features { projectId, jev }` (contrato do SERVER na
 * #853) e guardar a flag por projeto, com validade até o próximo spawn.
 *
 * Este arquivo guia o DaemonClient REAL (seam THE_DUDES_DAEMON_TEST=1) pelo
 * `handleInner`: liga → a sombra das tasks posta; desliga → para na hora; sem
 * mensagem o projeto fica DESLIGADO (nenhum default ligado); mensagem
 * desconhecida não quebra; e a transição sai em info.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.THE_DUDES_DAEMON_TEST = "1";
process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `t868-key-${process.pid}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `t868-pkeys-${process.pid}.json`);
process.env.THE_DUDES_DAEMON_CONFIG = path.join(os.tmpdir(), `t868-cli-missing-${process.pid}.json`);
process.env.TYPESAFE_TASK_SHADOW = "1";
process.env.TYPESAFE_API_KEY = "k";

const { DaemonClient } = await import("../main.js");
const { resolveCliCommands } = await import("../cli-config.js");
const { isJevLigado, _resetJevProjetosForTest } = await import("../typesafe-delegate-shadow.js");
const { setTaskShadowFetch, flushTaskShadowDebounceForTests, settleTaskShadowForTests, _resetTaskShadowForTest, definirElencoProjeto } = await import("../typesafe-task-shadow.js");

const PID = "proj_t868";
const OUTRO = "proj_t868_sem_mensagem";

type Internos = {
  handleInner(msg: Record<string, unknown>): Promise<void>;
  ws: unknown;
};

function makeClient(): Internos {
  const args = {
    orch: "ws://127.0.0.1:1", token: "t868", name: "t868-test", pingMs: 30_000,
    verbose: false, verboseHuman: false, verboseHumanIo: true,
    cliConfigPath: process.env.THE_DUDES_DAEMON_CONFIG!, cliPaths: {},
  } as never;
  const client = new (DaemonClient as unknown as new (a: never, c: never) => Internos)(args, resolveCliCommands() as never);
  client.ws = { readyState: 1, bufferedAmount: 0, send: () => {} };
  return client;
}

let chamadas = 0;
let logs: string[] = [];

async function sombraComTasksAdd(projectId: string): Promise<void> {
  const { scheduleTaskShadow } = await import("../typesafe-task-shadow.js");
  scheduleTaskShadow({ op: "tasks_add", projectId, task: { id: "task_t868", title: "Título", description: "desc", assigneeAgentId: "agent_pm" }, patch: {} });
  flushTaskShadowDebounceForTests();
  await settleTaskShadowForTests();
}

test("T-868: project:features liga e desliga a sombra na hora; desconhecida não quebra", async () => {
  _resetJevProjetosForTest();
  _resetTaskShadowForTest();
  chamadas = 0;
  setTaskShadowFetch(async () => {
    chamadas++;
    return { status: 200, text: async () => JSON.stringify({ model: "jev-1.13.0", answers: {
      domain: { type: "choice", choice: "PM", probabilities: { PM: 1 }, confidence: 1 },
      complexity: { type: "choice", choice: "simple", probabilities: { simple: 1 }, confidence: 1 },
      destructive: { type: "noul", noul: 0 },
      security: { type: "noul", noul: 0 },
      acceptance: { type: "noul", noul: 1 },
    } }) };
  });
  definirElencoProjeto(() => [{ agentId: "agent_pm", name: "PM", role: "coordena" }, { agentId: "agent_web", name: "WEB", role: "web" }]);

  const client = makeClient();
  const origErr = console.error;
  logs = [];
  console.error = () => {};
  // O log do daemon entra pelo `log()` central; aqui observamos o mesmo caminho
  // pelo registrar (o client liga o logJev no start(); em teste chamamos direto).
  const { definirLogJev } = await import("../typesafe-delegate-shadow.js");
  definirLogJev((nivel, msg) => logs.push(`${nivel}:${msg}`));

  try {
    // Projeto sem mensagem: desligado (nenhum default ligado).
    assert.equal(isJevLigado(OUTRO), false, "sem mensagem = desligado");
    await sombraComTasksAdd(OUTRO);
    assert.equal(chamadas, 0, "sem flag, a sombra nem sai");

    // Mensagem ligando o projeto.
    await client.handleInner({ type: "project:features", projectId: PID, jev: true });
    assert.equal(isJevLigado(PID), true);
    assert.ok(logs.some((l) => l.startsWith("info:") && l.includes("feature LIGADA")), logs.join("\n"));

    await sombraComTasksAdd(PID);
    assert.equal(chamadas, 1, "com a flag ligada a sombra posta");

    // Desligar para na hora, sem esperar spawn.
    await client.handleInner({ type: "project:features", projectId: PID, jev: false });
    assert.equal(isJevLigado(PID), false);
    assert.ok(logs.some((l) => l.includes("feature DESLIGADA")), logs.join("\n"));
    _resetTaskShadowForTest();
    await sombraComTasksAdd(PID);
    assert.equal(chamadas, 1, "desligada, a sombra para");

    // Ligar de novo volta a valer, e a mensagem repetida não duplica o log.
    const antes = logs.filter((l) => l.includes("feature LIGADA")).length;
    await client.handleInner({ type: "project:features", projectId: PID, jev: true });
    await client.handleInner({ type: "project:features", projectId: PID, jev: true });
    assert.equal(logs.filter((l) => l.includes("feature LIGADA")).length, antes + 1, "uma linha só na transição");

    // Mensagem desconhecida não quebra e não mexe na flag.
    await client.handleInner({ type: "algo:desconhecido", projectId: PID });
    assert.equal(isJevLigado(PID), true);
  } finally {
    console.error = origErr;
  }
});

test("T-868: a mensagem desconhecida sai do switch sem default (daemon antigo ignora)", async () => {
  // O switch de handleInner não tem `default:` — o daemon antigo ignora
  // `project:features`; aqui o tratamento é ANTES do switch, então vale sempre.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const marca = src.indexOf('tipos.type === "project:features"');
  const sw = src.indexOf("switch (msg.type)");
  assert.ok(marca > 0, "trata project:features");
  assert.ok(marca < sw, "trata ANTES do switch (o tipo ainda não está no FromOrch da main)");
  assert.match(src, /registrarJevDoProjeto\(String\(tipos\.projectId \?\? ""\), tipos\.jev === true\)/);
});