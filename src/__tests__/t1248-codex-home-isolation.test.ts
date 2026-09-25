import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("T-1248: migra a home legada e põe agents aninhado em quarentena sem perder sessão", (t) => {
  const base = mkdtempSync(path.join(os.tmpdir(), "t1248-migrate-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const agentId = "active-codex-agent";
  const agentSlug = slug(agentId);
  const legacy = path.join(base, "agents", agentSlug);
  const oldNested = path.join(legacy, "agents", slug("test-child"));
  const auth = path.join(base, "auth.json");
  const sessions = path.join(base, "sessions");
  const rollout = path.join(sessions, "2026", "09", "25", "rollout-fixture.jsonl");
  mkdirSync(oldNested, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(rollout), { recursive: true, mode: 0o700 });
  writeFileSync(auth, "synthetic auth fixture", { mode: 0o600 });
  writeFileSync(rollout, "synthetic session rollout", { mode: 0o600 });
  writeFileSync(path.join(legacy, "config.toml"), "[mcp_servers.the-dudes]\n", { mode: 0o600 });
  chmodSync(legacy, 0o700);
  writeFileSync(path.join(oldNested, "config.toml"), "nested test artifact", { mode: 0o600 });
  symlinkSync(auth, path.join(legacy, "auth.json"));
  symlinkSync(sessions, path.join(legacy, "sessions"));
  const fakeStateDb = path.join(legacy, "state_5.sqlite.fixture");
  writeFileSync(fakeStateDb, path.join(legacy, "sessions", "2026", "09", "25", "rollout-fixture.jsonl"));

  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = base;
  try {
    const instance = runtime(base, agentId);
    const migrated = instance.codexHomeDir();
    assert.equal(migrated, codexAgentHomePath(base, agentId));
    assert.equal(lstatSync(legacy).isSymbolicLink(), true, "o caminho absoluto antigo fica compatível via symlink");
    assert.equal(path.resolve(path.dirname(legacy), readlinkSync(legacy)), path.resolve(migrated));
    assert.equal(readFileSync(path.join(migrated, "config.toml"), "utf8"), "[mcp_servers.the-dudes]\n");
    assert.equal(existsSync(path.join(migrated, "agents")), false, "o CLI não encontra mais o nome que varre");
    const quarantineRoot = path.join(base, ".the-dudes-agent-homes-orfaos");
    const quarantines = readdirSync(quarantineRoot).filter((name) => name.startsWith(`${agentSlug}-agents.orfaos-`));
    assert.equal(quarantines.length, 1, "árvore aninhada fica preservada fora da home e da varredura do CLI");
    assert.equal(readFileSync(path.join(quarantineRoot, quarantines[0]!, slug("test-child"), "config.toml"), "utf8"), "nested test artifact");
    const staleRolloutPath = readFileSync(path.join(migrated, "state_5.sqlite.fixture"), "utf8");
    assert.equal(staleRolloutPath, path.join(legacy, "sessions", "2026", "09", "25", "rollout-fixture.jsonl"));
    assert.equal(readFileSync(staleRolloutPath, "utf8"), "synthetic session rollout", "caminho absoluto antigo da state DB continua resolvendo após migração");
    assert.equal(lstatSync(path.join(migrated, "auth.json")).isSymbolicLink(), true);
    assert.equal(readlinkSync(path.join(migrated, "auth.json")), auth);
    assert.equal(lstatSync(path.join(migrated, "sessions")).isSymbolicLink(), true);
    assert.equal(readlinkSync(path.join(migrated, "sessions")), sessions);
    assert.equal(readFileSync(path.join(migrated, "sessions", "2026", "09", "25", "rollout-fixture.jsonl"), "utf8"), "synthetic session rollout");
    assert.equal(lstatSync(migrated).mode & 0o777, 0o700);
    assert.equal(lstatSync(path.join(migrated, "config.toml")).mode & 0o777, 0o600);
    assert.equal(instance.codexHomeDir(), migrated, "segunda chamada é idempotente");
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
});

test("T-1265: quarentenas antigas de homes já migradas saem antes do symlink de compatibilidade", (t) => {
  const base = mkdtempSync(path.join(os.tmpdir(), "t1265-old-quarantine-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const agentId = "already-migrated-agent";
  const agentSlug = slug(agentId);
  const home = codexAgentHomePath(base, agentId);
  const nested = path.join(home, "agents.orfaos-20260924", slug("old-child"));
  mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(nested, "config.toml"), "old synthetic role");

  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = base;
  t.after(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });
  const migrated = runtime(base, agentId).codexHomeDir();
  assert.equal(migrated, home);
  assert.equal(existsSync(path.join(home, "agents.orfaos-20260924")), false);
  const outside = path.join(base, ".the-dudes-agent-homes-orfaos");
  const moved = readdirSync(outside).find((name) => name.startsWith(`${agentSlug}-agents.orfaos-20260924`));
  assert.ok(moved, "quarentena existente foi movida para fora da home antes do alias");
  assert.equal(readFileSync(path.join(outside, moved!, slug("old-child"), "config.toml"), "utf8"), "old synthetic role");
  assert.equal(lstatSync(path.join(base, "agents", agentSlug)).isSymbolicLink(), true);
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
  assert.equal(existsSync(path.join(codexHome!, "agents", slug("harness-agent"))), false,
    "home criada depois da correção não precisa de alias de compatibilidade");
  const config = path.join(agentHome, "config.toml");
  writeFileSync(config, "synthetic test config", { mode: 0o600 });
  assert.ok(within(tmpRoot, config), `teste gravou fora de tmp: ${config}`);
  assert.equal(lstatSync(config).mode & 0o777, 0o600);
});
