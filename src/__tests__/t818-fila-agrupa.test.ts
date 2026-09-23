/**
 * T-818: com a fila per-message no teto (20), a mensagem nova era DESCARTADA
 * em silêncio — 59 descartes em 7 dias nos dois perfis do dono (PM 46 num
 * turno longo do grok-custom; infra-doc 8). Quem mandou nunca soube. Agora a
 * mensagem entra no fim da última da fila (nada se perde, ordem mantida) e o
 * chat recebe UM aviso por rajada; só o flood acima de 64 KiB agrupados (em
 * bytes: argv do Linux) é descartado, e com aviso.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { COALESCE_SEPARATOR, PerMessageSessionState } from "../runners/message-session.js";

const { AgentRunner } = await import("../agent-runner.js");

test("T-818: fila no teto agrupa na última mensagem, na ordem, sem perder nada", () => {
  const s = new PerMessageSessionState();
  assert.equal(s.enqueueOrCoalesce({ content: "m1" }, 2, 1_000), "queued");
  assert.equal(s.enqueueOrCoalesce({ content: "m2" }, 2, 1_000), "queued");
  assert.equal(s.enqueueOrCoalesce({ content: "m3", images: [{ mediaType: "image/png", data: "x" }] as never }, 2, 1_000), "coalesced");
  assert.equal(s.enqueueOrCoalesce({ content: "m4" }, 2, 1_000), "coalesced");
  assert.equal(s.queuedCount(), 2, "a fila continua com no máximo 2 turnos");
  const [a, b] = s.takeAllForDrain();
  assert.equal(a!.content, "m1");
  assert.equal(b!.content, ["m2", "m3", "m4"].join(COALESCE_SEPARATOR));
  assert.equal(b!.images?.length, 1, "imagem da agrupada vai junto");
});

test("T-818: mensagem de usuário não entra na sintética (hang-recover fica fora do dreno)", () => {
  const s = new PerMessageSessionState();
  s.enqueue({ content: "u1" }, 5);
  s.enqueue({ content: "nudge", synthetic: "hang-recover" }, 5);
  assert.equal(s.enqueueOrCoalesce({ content: "u2" }, 2, 1_000), "coalesced");
  assert.deepEqual(s.takeAllForDrain().map((m) => m.content), [["u1", "u2"].join(COALESCE_SEPARATOR)]);
});

test("T-818: passou do teto de BYTES → descarta e não mexe no que já estava na fila", () => {
  const s = new PerMessageSessionState();
  s.enqueue({ content: "a".repeat(60) }, 1);
  assert.equal(s.enqueueOrCoalesce({ content: "b".repeat(60) }, 1, 100), "dropped");
  assert.equal(s.takeAllForDrain()[0]!.content, "a".repeat(60));
  // Revisão: o teto é em bytes UTF-8 (argv do Linux) — 30 "é" são 30 chars
  // mas 60 bytes. Com o teto exato cabe; 1 byte a menos, não.
  const sep = Buffer.byteLength(COALESCE_SEPARATOR, "utf8");
  const utf8 = new PerMessageSessionState();
  utf8.enqueue({ content: "x".repeat(20) }, 1);
  assert.equal(utf8.enqueueOrCoalesce({ content: "é".repeat(30) }, 1, 20 + sep + 60), "coalesced", "cabe em bytes com o separador");
  const utf8b = new PerMessageSessionState();
  utf8b.enqueue({ content: "x".repeat(20) }, 1);
  assert.equal(utf8b.enqueueOrCoalesce({ content: "é".repeat(30) }, 1, 20 + sep + 59), "dropped", "59 bytes não cabem 30 é (60 bytes)");
  const soSinteticas = new PerMessageSessionState();
  soSinteticas.enqueue({ content: "nudge", synthetic: "hang-recover" }, 1);
  assert.equal(soSinteticas.enqueueOrCoalesce({ content: "u" }, 1, 1_000), "dropped", "sem alvo de usuário não agrupa");
});

function runnerComTurnoEmCurso(cliRunner: string) {
  const logs: string[] = [];
  const avisos: string[] = [];
  const info = {
    id: `agent_t818_${cliRunner}`, ownerUserId: "u", name: cliRunner, role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner, autoApprove: true, workspaceRoot: os.tmpdir(),
    cliCommands: {}, verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: (_l: string, m: string) => logs.push(m), cliLog: () => {}, onState: () => {},
    onAssistantText: () => true, onToolUse: () => {},
    onError: (m: string) => avisos.push(m), onHung: () => {}, onExit: () => {},
  } as never);
  const a = runner as unknown as Record<string, any>;
  a.drainOcQueue = () => {}; // turno longo em curso: nada sai da fila
  a.messageSession.busy = true;
  return { runner, a, logs, avisos };
}

test("T-818: runner per-message com 25 mensagens num turno longo não descarta nenhuma e avisa UMA vez", () => {
  const { runner, a, logs, avisos } = runnerComTurnoEmCurso("grok-custom");
  for (let i = 1; i <= 25; i++) runner.pushUserMessage(`notificação ${i}`);
  assert.equal(a.messageSession.queuedCount(), 20, "a fila segura 20 turnos");
  const conteudo = runner.takeQueuedForDrain().map((m) => m.content).join("\n");
  for (let i = 1; i <= 25; i++) assert.ok(conteudo.includes(`notificação ${i}`), `notificação ${i} não pode sumir`);
  assert.deepEqual(logs.filter((m) => m.includes("drop mensagem")), [], "nada descartado");
  assert.equal(logs.filter((m) => m.includes("mensagem agrupada")).length, 5);
  assert.equal(avisos.length, 1, `um aviso por rajada: ${avisos.join(" | ")}`);
  assert.match(avisos[0]!, /^\[fila\] 20 mensagens esperando: .*nada se perde até 64 KiB/);
});

test("T-818: o aviso volta a valer só depois de a fila cair abaixo da metade", () => {
  const { runner, a, avisos } = runnerComTurnoEmCurso("grok");
  for (let i = 0; i < 21; i++) runner.pushUserMessage(`r1-${i}`);
  assert.equal(avisos.length, 1);
  // Sai 1 turno, entra 1 mensagem, estoura de novo: rondando o teto, sem novo aviso.
  a.messageSession.dequeue();
  runner.pushUserMessage("r1-cabe");
  runner.pushUserMessage("r1-agrupa");
  assert.equal(avisos.length, 1, "rondando o teto não repete o aviso");
  // Esvazia até 5, enche de novo e estoura: nova rajada, novo aviso.
  while (a.messageSession.queuedCount() > 5) a.messageSession.dequeue();
  for (let i = 0; i < 16; i++) runner.pushUserMessage(`r2-${i}`);
  assert.equal(avisos.length, 2, `nova rajada avisa de novo: ${avisos.join(" | ")}`);
});

test("T-818: flood acima do teto de 64 KiB é descartado COM aviso no chat — um aviso por rajada", () => {
  const { runner, logs, avisos } = runnerComTurnoEmCurso("opencode");
  const grande = "x".repeat(40_000);
  for (let i = 0; i < 20; i++) runner.pushUserMessage(`q${i}`);
  for (let i = 0; i < 4; i++) runner.pushUserMessage(grande);
  // A 1ª grande cabe no agrupamento (~40 KB); da 2ª em diante passa de 64 KiB.
  assert.equal(logs.filter((m) => m.includes("mensagem agrupada")).length, 1);
  assert.equal(logs.filter((m) => m.includes("ocQueue cheia") && m.includes("drop mensagem")).length, 3, "cada descarte fica no log");
  assert.equal(avisos.filter((m) => m.startsWith("[fila] mensagem descartada")).length, 1, `um aviso de descarte por rajada: ${avisos.join(" | ")}`);
});

test("T-818: descarte do buffer de restart do claude e da fila do dsh também é declarado", () => {
  const claude = runnerComTurnoEmCurso("claude");
  claude.a.restarting = true;
  for (let i = 0; i < 21; i++) claude.runner.pushUserMessage(`c${i}`);
  assert.equal(claude.avisos.filter((m) => m.startsWith("[fila] mensagem descartada")).length, 1);

  const dsh = runnerComTurnoEmCurso("dsh");
  dsh.a.dshReady = false;
  for (let i = 0; i < 60; i++) dsh.runner.pushUserMessage(`d${i}`);
  const descartes = dsh.logs.filter((m) => m.includes("fila cheia")).length;
  assert.ok(descartes > 1, "o flood gera vários descartes no log");
  assert.equal(dsh.avisos.filter((m) => m.startsWith("[fila] mensagem descartada")).length, 1, "um aviso por rajada");
});
