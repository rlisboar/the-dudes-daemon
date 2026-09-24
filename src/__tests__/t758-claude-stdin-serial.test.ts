/**
 * T-758 (P1): mensagem no stdin do claude contínuo não pode ficar parada sem
 * ninguém apanhar.
 *
 * Stub FIEL ao comportamento medido do CLI real (T-755/T-757):
 *  - se um chunk de stdin traz mais de uma linha JSON, só a ÚLTIMA vale
 *    (repro real: A1 ok, B2+C3 no mesmo chunk → B2 some);
 *  - não lê stdin enquanto um turno roda.
 * Base (sem serialização) perde mensagem; com serialização passam as 3.
 *
 * O stub aceita a mensagem emitindo `system/init` (marco acceptMs da T-755);
 * no modo "mute" nunca emite → watchdog de aceitação tem de aparecer.
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
fs.appendFileSync(path.join(dir, "spawn.log"), String(Date.now()) + "\\n");
const mode = fs.readFileSync(path.join(dir, "mode"), "utf8").trim();
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (mode === "mute") setInterval(() => {}, 1000);
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString();
  const lines = [];
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1);
    if (l.trim()) lines.push(l);
  }
  // CLI real: chunk com N linhas → só a última sobrevive.
  const valid = lines.filter((l) => l.trim().startsWith("{"));
  if (valid.length === 0) return;
  const kept = valid.at(-1);
  let text = "";
  try { const c = JSON.parse(kept).message.content; text = typeof c === "string" ? c : (c?.[0]?.text ?? ""); } catch {}
  fs.appendFileSync(path.join(dir, "recv.log"), Date.now() + " " + text + "\\n");
  setTimeout(() => {
    send({ type: "system", subtype: "init", session_id: "sess-t758", model: "stub" });
    send({ type: "assistant", session_id: "sess-t758", message: { content: [{ type: "text", text: "eco:" + text }] } });
    send({ type: "result", subtype: "success", session_id: "sess-t758", result: "eco:" + text });
  }, 150);
});
setInterval(() => {}, 1000);
`;

interface H {
  runner: AgentRunner; dir: string; warns: string[]; errors: string[];
  recv(): Array<{ at: number; text: string }>; spawns(): number; latencies(): any[];
}

function harness(mode: string): H {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t758-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  writeFileSync(path.join(dir, "mode"), mode);
  const warns: string[] = [];
  const errors: string[] = [];
  const off = { command: "false", source: "override" as const, available: false };
  const info = {
    id: `agent_t758_${process.pid}_${Math.random().toString(36).slice(2, 8)}`,
    ownerUserId: "u", name: "t758", role: "backend",
    systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const latencies: any[] = [];
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "claude", autoApprove: true, workspaceRoot: dir,
    cliCommands: {
      claude: { command: stub, source: "override" as const, available: true },
      opencode: off, gemini: off, codex: off, crush: off,
      qwen: off, grok: off, "grok-custom": off, graphify: off, graphifyMcp: off,
    },
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: (lvl: string, msg: string) => {
      if (lvl === "warn") warns.push(msg);
      if (lvl === "info" && msg.startsWith("[turn-latency] ")) latencies.push(JSON.parse(msg.slice(15)));
    },
    cliLog: () => {}, onState: () => {}, onAssistantText: () => true, onToolUse: () => {},
    onError: (m: string) => { errors.push(m); }, onExit: () => {}, onHung: () => {},
  } as never);
  return {
    runner, dir, warns, errors,
    recv: () => existsSync(path.join(dir, "recv.log"))
      ? readFileSync(path.join(dir, "recv.log"), "utf8").split("\n").filter(Boolean).map((l) => { const i = l.indexOf(" "); return { at: Number(l.slice(0, i)), text: l.slice(i + 1) }; })
      : [],
    spawns: () => existsSync(path.join(dir, "spawn.log")) ? readFileSync(path.join(dir, "spawn.log"), "utf8").split("\n").filter(Boolean).length : 0,
    latencies: () => latencies,
  };
}

async function until(cond: () => boolean, ms = 8000, what = "condição"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout aguardando ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;

test("T-758: 3 pushes seguidos são serializados (stub que descarta linha em chunk múltiplo perde na base)", async () => {
  const h = harness("echo");
  try {
    await h.runner.start();
    await until(() => h.spawns() === 1, 20_000, "spawn");
    h.runner.pushUserMessage("A1");
    h.runner.pushUserMessage("B2");
    h.runner.pushUserMessage("C3");
    await until(() => h.recv().length === 3, 8000, "3 mensagens consumidas");
    const texts = h.recv().map((r) => r.text);
    assert.deepEqual(texts, ["A1", "B2", "C3"], `ordem/sem perda; recebido=${texts}`);
    const gaps = h.recv().slice(1).map((r, i) => r.at - h.recv()[i]!.at);
    assert.ok(gaps.every((g) => g >= 100), `escritas separadas (não no mesmo chunk): gaps=${gaps}`);
    // Critério 5: acceptMs segue medindo (init do stub) e é curto.
    await until(() => h.latencies().length === 3, 5000, "3 linhas turn-latency");
    for (const l of h.latencies()) {
      assert.equal(typeof l.acceptMs, "number", "acceptMs presente");
      assert.ok(l.acceptMs < 500, `acceptMs curto (${l.acceptMs}) — watchdog não dispara em operação normal`);
      assert.equal(l.endReason, "completed");
    }
    assert.equal(h.warns.some((w) => w.includes("não foi aceita")), false, "sem falso positivo do watchdog");
  } finally {
    h.runner.stop();
  }
});

test("T-758: mensagem não aceita vira evento visível em 30s e restart+re-envio em 90s", async () => {
  const h = harness("mute");
  try {
    await h.runner.start();
    await until(() => h.spawns() === 1, 20_000, "spawn");
    h.runner.pushUserMessage("M1");
    await until(() => h.recv().length === 1, 5000, "stub recebeu (mudo, sem init)");
    assert.equal(h.warns.some((w) => w.includes("não foi aceita")), false, "antes do X nada");

    asAny(h.runner).claudeUnacceptedSince = Date.now() - 31_000;
    asAny(h.runner).tickHangWatch();
    assert.ok(h.warns.some((w) => w.includes("não foi aceita") && /há 3[0-9]s/.test(w)), `warn visível: ${h.warns.join(" | ")}`);
    assert.ok(h.errors.some((e) => e.includes("não foi aceita")), "chat também recebe");

    asAny(h.runner).claudeUnacceptedSince = Date.now() - 91_000;
    asAny(h.runner).tickHangWatch();
    await until(() => h.spawns() === 2, 6000, "restart do claude");
    await until(() => h.recv().length === 2, 6000, "re-envio pós-restart");
    assert.equal(h.recv()[1]!.text, "M1", "mesma mensagem re-enviada, sem duplicar");
    assert.ok(h.warns.some((w) => w.includes("reiniciando com resume")), "restart declarado");
  } finally {
    h.runner.stop();
  }
});