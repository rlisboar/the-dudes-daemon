/**
 * T-597 repro: mede o que um segundo spawn com projectId DIFERENTE faz no
 * AgentHost (caminho reconnect).
 *
 * MEDIÇÃO ORIGINAL (pré-fix): o reconnect puro NÃO atualizava
 * `existing.projectId` nem trocava o runner — os dois ficavam no pid velho.
 * Isso excluiu o daemon como causa do incidente da daa1b1e6 (o selo do relay
 * e a closure do runner nunca divergem: um incidente de UMA mensagem não
 * nasce aqui) e expôs o bug latente.
 *
 * COM O FIX F1 (T-597): pid diferente = reconfig → re-spawn completo; entry e
 * closure nascem JUNTOS no pid novo. Pid igual continua reconnect puro (não
 * reinicia o runner).
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, publicEncrypt, createPublicKey, constants, createDecipheriv } from "node:crypto";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t597-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t597-pkeys-${process.pid}-${Date.now()}.json`);

const { getDaemonPublicKey, rememberProjectKey, forgetProjectKey } = await import("../daemon-crypto.js");
const { AgentHost } = await import("../agent-host.js");

const STUB = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "stub" }) + "\\n");
setInterval(() => {}, 1000);
`;

function withProjectKey(projectId: string): Buffer {
  const k = randomBytes(32);
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrapped = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, k);
  if (!rememberProjectKey(projectId, wrapped.toString("base64"))) throw new Error("rememberProjectKey falhou");
  return k;
}

function dec(key: Buffer, stored: string, aad: string): string | null {
  try {
    const all = Buffer.from(stored.slice(7), "base64");
    const d = createDecipheriv("aes-256-gcm", key, all.subarray(0, 12));
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(all.subarray(all.length - 16));
    return Buffer.concat([d.update(all.subarray(12, all.length - 16)), d.final()]).toString("utf8");
  } catch { return null; }
}

/** Com qual projectId ESTE runner sela (via closure onAssistantText). */
function quemSelou(cipher: string, P1: string, P2: string, K1: Buffer, K2: Buffer): string {
  if (dec(K1, cipher, `v2|${P1}|messages|content`) !== null) return P1;
  if (dec(K2, cipher, `v2|${P2}|messages|content`) !== null) return P2;
  return "???";
}

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 30));
  }
}

test("T-597 F1: reconnect com projectId diferente re-spawna e entry+closure nascem no pid novo", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t597-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);

  const P1 = "proj_P1t597";
  const P2 = "proj_P2t597";
  const K1 = withProjectKey(P1);
  const K2 = withProjectKey(P2);

  const outbound: Array<Record<string, unknown>> = [];
  const off = { command: "false", source: "override" as const, available: false };
  const host = new AgentHost(
    (m) => outbound.push(m as Record<string, unknown>),
    null,
    null,
    {
      claude: { command: stub, source: "override" as const, available: true },
      opencode: off, gemini: off, codex: off, crush: off,
      qwen: off, grok: off, "grok-custom": off, graphify: off, graphifyMcp: off,
    } as never,
    false, false, false, () => {}, () => {},
  );

  const agentId = "agent_t597repro";
  const mkMsg = (projectId: string) => ({
    agent: {
      id: agentId, ownerUserId: "u", name: "t597", role: "backend",
      systemPrompt: "", color: "#7aa2ff", state: "idle", running: true,
      usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
      cliRunner: "claude",
    },
    projectId,
    basePath: dir,
    autoApprove: true,
    agentToken: "tok",
  }) as never;

  await host.spawn(mkMsg(P1));
  await until(() => host.agentCount() > 0);

  type E = { projectId?: string; runner: { isAlive(): boolean; opts: Record<string, unknown> } };
  const entriesOf = () => (host as unknown as { entries: Map<string, E> }).entries;
  const entry1 = entriesOf().get(agentId)!;
  const runner1 = entry1.runner;
  console.log("[repro] após spawn P1: entry.projectId =", entry1.projectId, "runnerAlive =", runner1.isAlive());
  assert.equal(entry1.projectId, P1);
  (runner1.opts.onAssistantText as (t: string) => void)("texto-do-runner");
  const cipher1 = String((outbound.filter((m) => m.type === "agent:text").pop()! as { text: string }).text);
  assert.equal(quemSelou(cipher1, P1, P2, K1, K2), P1, "closure do runner sela com P1");

  // Reconnect com MESMO pid: não reinicia o runner (reconnect puro segue puro).
  await host.spawn(mkMsg(P1));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(entriesOf().get(agentId)!.runner, runner1, "mesmo pid mantém o runner");

  // Spawn com pid DIFERENTE: F1 manda reconfig → re-spawn completo.
  await host.spawn(mkMsg(P2));
  await new Promise((r) => setTimeout(r, 300));

  const entry2 = entriesOf().get(agentId)!;
  console.log("[repro] após spawn P2: entry.projectId =", entry2.projectId);
  console.log("[repro] getAgentProjectId (lookup do relay) =", host.getAgentProjectId(agentId));

  assert.equal(entry2.projectId, P2, "pid novo atualiza o entry (re-spawn)");
  assert.equal(host.getAgentProjectId(agentId), P2, "lookup do relay no pid novo");
  assert.notEqual(entry2.runner, runner1, "runner antigo é substituído");
  (entry2.runner.opts.onAssistantText as (t: string) => void)("texto-pos-P2");
  const cipher2 = String((outbound.filter((m) => m.type === "agent:text").pop()! as { text: string }).text);
  assert.equal(quemSelou(cipher2, P1, P2, K1, K2), P2, "closure do runner novo sela com P2");

  // Consistência: relay (entry) e closure nunca divergem.
  assert.equal(entry2.projectId, quemSelou(cipher2, P1, P2, K1, K2));

  await host.shutdown();
  forgetProjectKey(P1);
  forgetProjectKey(P2);
});