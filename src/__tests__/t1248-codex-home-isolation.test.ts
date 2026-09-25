import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunnerRuntimeFiles, codexAgentHomePath } from "../runners/runtime-files.js";

function runtime(home: string, agentId: string) {
  return new RunnerRuntimeFiles({ workspaceRoot: home, agentId, agentToken: "synthetic", home, runner: "codex" });
}

function slug(agentId: string): string {
  return createHash("sha1").update(agentId).digest("hex").slice(0, 10);
}

function within(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== "..");
}

test("T-1248: homes ficam fora de CODEX_HOME/agents e mantêm slug estável", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "t1248-path-"));
  const first = codexAgentHomePath(base, "codex-agent-a");
  assert.equal(path.basename(first), slug("codex-agent-a"), "slug T-426 não muda e preserva resume");
  assert.equal(first, codexAgentHomePath(base, "codex-agent-a"));
  assert.ok(within(base, first));
  assert.equal(within(path.join(base, "agents"), first), false);
});

test("T-1248: CODEX_HOME herdado de home antiga/aninhada resolve à base real", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "t1248-nested-"));
  const prev = process.env.CODEX_HOME;
  const daemonSlug = slug("daemon-agent");
  const nestedSlug = slug("nested-agent");
  const inheritedHome = path.join(base, "agents", daemonSlug, "agents", nestedSlug);
  process.env.CODEX_HOME = inheritedHome;
  try {
    const instance = runtime(os.homedir(), "next-agent");
    const resolvedBase = (instance as unknown as { codexBaseDir(): string }).codexBaseDir();
    assert.equal(resolvedBase, base, "unwinds every legacy agent-home level");
    assert.equal(instance.codexHomeDir(), codexAgentHomePath(base, "next-agent"));
    assert.equal(within(inheritedHome, instance.codexHomeDir()), false, "não cria agents aninhado");
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
});

test("T-1248: migra a home legada e põe agents aninhado em quarentena sem perder sessão", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "t1248-migrate-"));
  const agentId = "active-codex-agent";
  const agentSlug = slug(agentId);
  const legacy = path.join(base, "agents", agentSlug);
  const oldNested = path.join(legacy, "agents", slug("test-child"));
  const auth = path.join(base, "auth.json");
  const sessions = path.join(base, "sessions");
  mkdirSync(oldNested, { recursive: true, mode: 0o700 });
  mkdirSync(sessions, { mode: 0o700 });
  writeFileSync(auth, "synthetic auth fixture", { mode: 0o600 });
  writeFileSync(path.join(sessions, "session.jsonl"), "synthetic session", { mode: 0o600 });
  writeFileSync(path.join(legacy, "config.toml"), "[mcp_servers.the-dudes]\n", { mode: 0o600 });
  chmodSync(legacy, 0o700);
  writeFileSync(path.join(oldNested, "config.toml"), "nested test artifact", { mode: 0o600 });
  symlinkSync(auth, path.join(legacy, "auth.json"));
  symlinkSync(sessions, path.join(legacy, "sessions"));

  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = base;
  try {
    const instance = runtime(base, agentId);
    const migrated = instance.codexHomeDir();
    assert.equal(migrated, codexAgentHomePath(base, agentId));
    assert.equal(existsSync(legacy), false, "a home legada foi movida, não duplicada");
    assert.equal(readFileSync(path.join(migrated, "config.toml"), "utf8"), "[mcp_servers.the-dudes]\n");
    assert.equal(existsSync(path.join(migrated, "agents")), false, "o CLI não encontra mais o nome que varre");
    const quarantines = readdirSync(migrated).filter((name) => name.startsWith("agents.orfaos-"));
    assert.equal(quarantines.length, 1, "árvore aninhada preservada em uma quarentena listável");
    assert.equal(readFileSync(path.join(migrated, quarantines[0]!, slug("test-child"), "config.toml"), "utf8"), "nested test artifact");
    assert.equal(lstatSync(path.join(migrated, "auth.json")).isSymbolicLink(), true);
    assert.equal(readlinkSync(path.join(migrated, "auth.json")), auth);
    assert.equal(lstatSync(path.join(migrated, "sessions")).isSymbolicLink(), true);
    assert.equal(readlinkSync(path.join(migrated, "sessions")), sessions);
    assert.equal(readFileSync(path.join(migrated, "sessions", "session.jsonl"), "utf8"), "synthetic session");
    assert.equal(lstatSync(migrated).mode & 0o777, 0o700);
    assert.equal(lstatSync(path.join(migrated, "config.toml")).mode & 0o777, 0o600);
    assert.equal(instance.codexHomeDir(), migrated, "segunda chamada é idempotente");
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
});

test("T-1248: harness isola HOME/CODEX_HOME e configurações geradas ficam em tmp", () => {
  const tmpRoot = path.resolve(os.tmpdir());
  const home = process.env.HOME;
  const codexHome = process.env.CODEX_HOME;
  assert.ok(home && within(tmpRoot, home), `HOME fora de tmp: ${home}`);
  assert.ok(codexHome && within(tmpRoot, codexHome), `CODEX_HOME fora de tmp: ${codexHome}`);

  const instance = runtime(home!, "harness-agent");
  const agentHome = instance.codexHomeDir();
  assert.ok(within(tmpRoot, agentHome), `home do runner fora de tmp: ${agentHome}`);
  const config = path.join(agentHome, "config.toml");
  writeFileSync(config, "synthetic test config", { mode: 0o600 });
  assert.ok(within(tmpRoot, config), `teste gravou fora de tmp: ${config}`);
  assert.equal(lstatSync(config).mode & 0o777, 0o600);
});
