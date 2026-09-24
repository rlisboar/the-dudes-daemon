/**
 * T-710b — FAIL real da T-710 (17:26Z): o self-update fazia host.shutdown()
 * com o WS aberto; cada runner.stop() disparava onExit → agent:exit +
 * agent:running false ao server, que marcava parada NORMAL. O hello do
 * processo novo não tinha o que religar (replay só religa running=true).
 *
 * Agora: re-exec do self-update (shutdown({reexec:true})) mata os CLIs mas NÃO
 * anuncia exit/running false. T-824: o shutdown por SIGTERM/SIGINT do daemon
 * também passa a flag (antes anunciava e o server deixava todo agente parado
 * depois de qualquer reinício). `host.shutdown()` sem flag segue anunciando.
 * AgentHost real + CLI stub (claude), sem mock do onExit.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const { AgentHost } = await import("../agent-host.js");

const STUB = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "stub" }) + "\\n");
setInterval(() => {}, 1000);
`;

type Out = Record<string, unknown>;
type E = { runner: { isAlive(): boolean } | null };

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function hostCom2Agentes(): Promise<{ host: InstanceType<typeof AgentHost>; outbound: Out[]; runners: Array<{ isAlive(): boolean }> }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t710b-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  const outbound: Out[] = [];
  const off = { command: "false", source: "override" as const, available: false };
  const host = new AgentHost(
    (m) => { outbound.push(m as unknown as Out); },
    null, null,
    {
      claude: { command: stub, source: "override" as const, available: true },
      opencode: off, gemini: off, codex: off, crush: off,
      qwen: off, grok: off, "grok-custom": off, graphify: off, graphifyMcp: off,
    } as never,
    false, false, false, () => {}, () => {},
  );
  for (const id of ["agent_t710b_a", "agent_t710b_b"]) {
    await host.spawn({
      agent: {
        id, ownerUserId: "u", name: id, role: "backend",
        systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
        usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
        cliRunner: "claude",
      },
      basePath: dir, autoApprove: true, agentToken: "tok",
    } as never);
  }
  const entries = (host as unknown as { entries: Map<string, E> }).entries;
  await until(() => [...entries.values()].filter((e) => e.runner?.isAlive()).length === 2);
  const runners = [...entries.values()].map((e) => e.runner!);
  return { host, outbound, runners };
}

const anunciaParada = (o: Out) => o.type === "agent:exit" || (o.type === "agent:running" && o.running === false);

test("T-710b (1): re-exec do self-update mata os CLIs e NÃO emite agent:exit / running false", async () => {
  const { host, outbound, runners } = await hostCom2Agentes();
  outbound.length = 0;
  const n = await host.shutdown({ reexec: true });
  assert.equal(n, 2, "devolve quantos agentes foram mantidos running (log do main.ts)");
  await until(() => runners.every((r) => !r.isAlive()), 8_000);
  await new Promise((r) => setTimeout(r, 500)); // exit tardio teria chegado aqui
  assert.deepEqual(outbound.filter(anunciaParada), [], `emitiu: ${JSON.stringify(outbound.filter(anunciaParada))}`);
});

test("T-710b (3) regressão: host.shutdown() sem flag (parada definitiva do uninstall, T-824) CONTINUA emitindo agent:exit + running false", async () => {
  const { host, outbound, runners } = await hostCom2Agentes();
  outbound.length = 0;
  await host.shutdown();
  await until(() => runners.every((r) => !r.isAlive()), 8_000);
  await until(() => outbound.filter((o) => o.type === "agent:exit").length === 2, 8_000);
  const exits = outbound.filter((o) => o.type === "agent:exit").map((o) => o.agentId).sort();
  const parados = outbound.filter((o) => o.type === "agent:running" && o.running === false).map((o) => o.agentId).sort();
  assert.deepEqual(exits, ["agent_t710b_a", "agent_t710b_b"]);
  assert.deepEqual(parados, ["agent_t710b_a", "agent_t710b_b"]);
});

test("T-710b (5) wiring: self-update chama prepareReexec({keepRunning:true}) e loga a contagem; T-824: SIGTERM também passa a flag", () => {
  const src = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  assert.match(src, /prepareReexec: \(\) => this\.prepareReexec\(\{ keepRunning: true \}\)/, "gate do self-update mantém running");
  assert.match(src, /\[self-update\] reexec: \$\{n\} agent\(s\) mantidos running/);
  const shutdownAt = src.indexOf("private async shutdown()");
  const bloco = src.slice(shutdownAt, src.indexOf("\n  }\n}", shutdownAt));
  assert.match(bloco, /await this\.prepareReexec\(\{ keepRunning: true, porSinal: true \}\);/, "T-824: shutdown por sinal mantém os agentes running");
  // O único anúncio de exit é a parada definitiva pedida pelo uninstall.
  const semFlag = bloco.split("await this.prepareReexec();").length - 1;
  assert.equal(semFlag, 1, "só um caminho anuncia exit");
  assert.match(bloco, /if \(pararDeVez\) \{[\s\S]*?await this\.prepareReexec\(\);/, "e ele só vale com o marcador de parar de vez");
  assert.match(src, /this\.host\.shutdown\(\{ reexec: !!opts\.keepRunning \}\)/);
});
