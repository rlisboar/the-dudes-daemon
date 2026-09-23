/**
 * T-824: 23/09 o dono viu o agente "travado" na UI (era o dreno do
 * self-update segurando mensagens até os turnos em curso terminarem) e
 * reiniciou o daemon. O SIGTERM caía no shutdown que anuncia exit de cada
 * agente, e o time inteiro do alertai ficou parado no server até alguém dar
 * Start. Agora:
 *  - SIGTERM/SIGINT sai como o re-exec (sem anunciar exit): o server mantém
 *    os agentes running e o hello do processo novo os religa (T-710);
 *  - durante o dreno, o chat do agente recebe UM aviso explicando a espera.
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

async function hostCom(ids: string[]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t824-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  const outbound: Out[] = [];
  const off = { command: "false", source: "override" as const, available: false };
  const host = new AgentHost(
    (m) => { outbound.push(m as Out); },
    null, null,
    {
      claude: { command: stub, source: "override" as const, available: true },
      opencode: off, gemini: off, codex: off, crush: off,
      qwen: off, grok: off, "grok-custom": off, graphify: off, graphifyMcp: off,
    } as never,
    false, false, false, () => {}, () => {},
  );
  for (const id of ids) {
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
  await until(() => [...entries.values()].filter((e) => e.runner?.isAlive()).length === ids.length);
  return { host, outbound };
}

const avisos = (out: Out[], id: string) =>
  out.filter((o) => o.type === "agent:error" && o.agentId === id).map((o) => String(o.message));

test("T-824: dreno do update avisa no chat do agente UMA vez e retém as mensagens", async () => {
  const { host, outbound } = await hostCom(["agent_t824_a", "agent_t824_b"]);
  try {
    outbound.length = 0;
    host.startDrain();
    host.send_message("agent_t824_a", "primeira");
    host.send_message("agent_t824_a", "segunda");
    host.send_message("agent_t824_b", "outra");
    const a = avisos(outbound, "agent_t824_a");
    assert.equal(a.length, 1, `um aviso por agente por dreno: ${a.join(" | ")}`);
    assert.match(a[0]!, /atualização do daemon pendente.*Não precisa reiniciar/);
    assert.equal(avisos(outbound, "agent_t824_b").length, 1, "cada agente recebe o seu");
    const held = (host as unknown as { drainHeld: Map<string, unknown[]> }).drainHeld;
    assert.equal(held.get("agent_t824_a")?.length, 2, "as mensagens ficam retidas para o spool");
  } finally {
    await host.shutdown({ reexec: true });
  }
});

test("T-824: dreno do shutdown por sinal usa o aviso de reinício", async () => {
  const { host, outbound } = await hostCom(["agent_t824_c"]);
  try {
    outbound.length = 0;
    host.startDrain("shutdown");
    host.send_message("agent_t824_c", "durante o reinício");
    const c = avisos(outbound, "agent_t824_c");
    assert.equal(c.length, 1);
    assert.match(c[0]!, /daemon reiniciando/);
  } finally {
    await host.shutdown({ reexec: true });
  }
});

test("T-824: shutdown por sinal do daemon mantém os agentes (wiring do main.ts)", () => {
  const src = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  assert.match(src, /process\.on\("SIGTERM", \(\) => this\.shutdown\(\)\)/);
  const ini = src.indexOf("private async shutdown()");
  const bloco = src.slice(ini, src.indexOf("\n  }\n}", ini));
  assert.match(bloco, /prepareReexec\(\{ keepRunning: true, porSinal: true \}\)/);
  assert.match(src, /startDrain\(opts\.porSinal \? "shutdown" : "update"\)/, "o dreno do sinal avisa como reinício");
});
