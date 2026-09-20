/**
 * T-760 (review T-759): corrida no watchdog de aceitação do claude.
 *
 * O kill do restart faz `stdin.end()`, que destrava a leitura do CLI: a
 * mensagem antiga pode ser ACEITA E RESPONDIDA dentro do grace do SIGTERM
 * (~1,5s). Sem guarda, a resposta antiga sai no chat E a mensagem é
 * re-enviada → texto duplicado. Regra nova: re-envio só se NENHUM result
 * chegou durante o kill.
 *
 * Stub: 1º processo só responde no EOF (stdin.end do kill) — é a corrida;
 * processos seguintes respondem na hora (re-envio). Modo silent_noreply: 1º
 * processo não responde nunca (nem no EOF) → re-envio é obrigatório e a
 * mensagem não pode se perder.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRunner } from "../agent-runner.js";

const STUB = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
const dir = path.dirname(url.fileURLToPath(import.meta.url));
fs.appendFileSync(path.join(dir, "spawn.log"), "1\\n");
const spawnNo = fs.readFileSync(path.join(dir, "spawn.log"), "utf8").split("\\n").filter(Boolean).length;
const mode = fs.readFileSync(path.join(dir, "mode"), "utf8").trim();
// CLI real tem handler de SIGTERM desde o start — o do daemon corre com o sina.
if (mode === "eof_reply") process.on("SIGTERM", () => {});
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let last = "";
const reply = () => {
  send({ type: "system", subtype: "init", session_id: "sess-t760", model: "stub" });
  send({ type: "assistant", session_id: "sess-t760", message: { content: [{ type: "text", text: "eco:" + last }] } });
  send({ type: "result", subtype: "success", session_id: "sess-t760", result: "eco:" + last });
};
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!l.trim()) continue;
    try { last = JSON.parse(l).message.content; } catch {}
    fs.appendFileSync(path.join(dir, "recv.log"), "1\\n");
  }
  if (spawnNo >= 2) reply();
});
process.stdin.on("end", () => {
  const primeiro = spawnNo === 1;
  if (primeiro && mode === "eof_reply") {


    setTimeout(() => { reply(); setTimeout(() => process.exit(0), 150); }, 60);
  }
});
setInterval(() => {}, 1000);
`;

interface H {
  runner: AgentRunner; texts: string[]; warns: string[];
  recv(): number; spawns(): number;
}

function harness(mode: string): H {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t760-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  writeFileSync(path.join(dir, "mode"), mode);
  const texts: string[] = [];
  const warns: string[] = [];
  const off = { command: "false", source: "override" as const, available: false };
  const info = {
    id: `agent_t760_${process.pid}_${Math.random().toString(36).slice(2, 8)}`,
    ownerUserId: "u", name: "t760", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "claude", autoApprove: true, workspaceRoot: dir,
    cliCommands: {
      claude: { command: stub, source: "override" as const, available: true },
      opencode: off, gemini: off, codex: off, crush: off,
      qwen: off, grok: off, "grok-custom": off, graphify: off, graphifyMcp: off,
    },
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: (lvl: string, msg: string) => { if (lvl === "warn") warns.push(msg); },
    cliLog: () => {}, onState: () => {}, onAssistantText: (t: string) => { texts.push(t); return true; },
    onToolUse: () => {}, onError: () => {}, onExit: () => {}, onHung: () => {},
  } as never);
  const count = (f: string) => existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).length : 0;
  return { runner, texts, warns, recv: () => count("recv.log"), spawns: () => count("spawn.log") };
}

async function until(cond: () => boolean, ms = 8000, what = "condição"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout aguardando ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;
const disparaRestart = (h: H) => {
  asAny(h.runner).claudeUnacceptedSince = Date.now() - 91_000;
  asAny(h.runner).tickHangWatch();
};

test("T-760: resposta dentro do kill NÃO é duplicada pelo re-envio (falha na base)", async () => {
  const h = harness("eof_reply");
  try {
    await h.runner.start();
    await until(() => h.spawns() === 1, 5000, "spawn");
    h.runner.pushUserMessage("R1");
    await until(() => h.recv() === 1, 5000, "stub recebeu (mudo até o kill)");
    assert.equal(h.texts.length, 0, "ainda sem resposta");
    disparaRestart(h);
    await until(() => h.spawns() === 2, 6000, "restart");
    await until(() => h.warns.some((w) => w.includes("sem re-envio")), 6000, "decisão de não re-enviar");
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(h.texts, ["eco:R1"], `texto uma única vez; recebido=${JSON.stringify(h.texts)}`);
    assert.equal(h.recv(), 1, "mensagem não foi re-enviada (já respondida no kill)");
  } finally { h.runner.stop(); }
});

test("T-760: sem resposta no kill, a mensagem é re-enviada e NÃO se perde", async () => {
  const h = harness("silent_noreply");
  try {
    await h.runner.start();
    await until(() => h.spawns() === 1, 5000, "spawn");
    h.runner.pushUserMessage("S1");
    await until(() => h.recv() === 1, 5000, "stub recebeu");
    disparaRestart(h);
    await until(() => h.spawns() === 2, 6000, "restart");
    await until(() => h.recv() === 2, 6000, "re-envio pós-restart");
    await until(() => h.texts.length === 1, 6000, "resposta do re-envio");
    assert.deepEqual(h.texts, ["eco:S1"], "entregue exatamente uma vez");
    assert.equal(h.warns.some((w) => w.includes("sem re-envio")), false, "re-enviou (nada observado no kill)");
  } finally { h.runner.stop(); }
});