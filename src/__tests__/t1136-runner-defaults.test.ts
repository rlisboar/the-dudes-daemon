import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RUNNERS } from "@the-dudes/protocol";
import { AgentHost } from "../agent-host.js";
import { DSH_DEFAULT_MODEL, dshModelForTurn } from "../runners/turns/dsh.js";
import { validateDaemonMessage } from "../protocol.js";
import { loadOrCreateDaemonId } from "../daemon-id.js";
import { loadDaemonCliConfig } from "../cli-config.js";
import { buildEnv } from "../runners/bootstrap.js";
import { buildRunnerStatusMap, parseRunnerVersion, probeRunnerVersion } from "../runner-status.js";
import type { ResolvedCliCommands } from "../cli-config.js";
import type { InstalledRunnerAvailability } from "../runner-policy.js";
import {
  discoverClaudeConfigAliases,
  isValidDshModel,
  isCompatibleRunnerEffort,
  isValidRunnerModel,
  isValidRunnerModelFor,
  publicConfigDirAliases,
  revalidateClaudeConfigAlias,
  resolveRunnerSettings,
  sanitizeRunnerDefaults,
  validateClaudeConfigDir,
} from "../runner-defaults-local.js";

const uid = process.getuid?.();

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("T-1136: daemonId is a persisted UUID v4 in a private regular file", () => {
  const profile = tempDir("t1136-id-");
  try {
    const first = loadOrCreateDaemonId(profile, uid);
    const second = loadOrCreateDaemonId(profile, uid);
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(second, first);
    const st = fs.statSync(path.join(profile, "daemon-id"));
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(st.isFile(), true);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test("T-1136: local daemon-config accepts explicit Claude candidates without resolving against root HOME", () => {
  const home = tempDir("t1136-local-config-");
  try {
    const configPath = path.join(home, "daemon-config.json");
    fs.writeFileSync(configPath, JSON.stringify({ runnerConfigDirs: { claude: ["~/.claude-personal"] } }));
    const config = loadDaemonCliConfig(configPath);
    assert.deepEqual(config.runnerConfigDirs, { claude: ["~/.claude-personal"] });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("T-1136: Claude aliases expose only opaque ids and labels for approved local homes", () => {
  const home = tempDir("t1136-home-");
  try {
    fs.mkdirSync(path.join(home, ".claude"));
    fs.mkdirSync(path.join(home, ".claude-work"));
    fs.mkdirSync(path.join(home, ".not-claude"));
    const aliases = discoverClaudeConfigAliases({ home, ownerUid: uid });
    assert.equal(aliases.length, 2);
    assert.ok(aliases.every((item) => /^[A-Za-z0-9_-]{8,64}$/.test(item.alias)));
    assert.ok(aliases.every((item) => !item.label.includes(home) && !item.label.includes(path.sep)));
    const publicReport = publicConfigDirAliases({ claude: aliases });
    assert.equal(JSON.stringify(publicReport).includes(home), false);
    assert.equal(JSON.stringify(publicReport).includes("path"), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("T-1136: reject relative, traversal, outside-root, control-char and symlink Claude config paths", () => {
  const home = tempDir("t1136-path-");
  const outside = tempDir("t1136-outside-");
  try {
    fs.mkdirSync(path.join(home, ".claude"));
    fs.mkdirSync(path.join(home, ".claude-real"));
    fs.symlinkSync(path.join(home, ".claude-real"), path.join(home, ".claude-link"));
    for (const invalid of [
      ".claude",
      path.join(home, "..", path.basename(outside)),
      path.join(outside, ".claude"),
      path.join(home, ".claude\nunsafe"),
      path.join(home, ".claude-link"),
    ]) assert.equal(validateClaudeConfigDir(invalid, home, uid), undefined, invalid);
    assert.equal(validateClaudeConfigDir("~/.claude", home, uid), path.join(fs.realpathSync(home), ".claude"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("T-1136: model precedence is env > saved agent > daemon default > native", () => {
  const home = tempDir("t1136-model-");
  const aliases = { claude: [] };
  const common = { runner: "claude" as const, agent: {}, configAliases: aliases, home, ownerUid: uid, warn: () => {} };
  try {
    assert.equal(resolveRunnerSettings({ ...common, defaults: { model: "claude-sonnet-4" } }).model, "claude-sonnet-4");
    assert.equal(resolveRunnerSettings({ ...common, agent: { model: "claude-opus-4-6" }, defaults: { model: "claude-sonnet-4" } }).model, "claude-opus-4-6");
    assert.equal(resolveRunnerSettings({ ...common, agent: { model: "claude-opus-4-6" }, defaults: { model: "claude-sonnet-4" }, env: { THE_DUDES_CLAUDE_MODEL: "claude-haiku-4-5" } }).model, "claude-haiku-4-5");
    assert.equal(resolveRunnerSettings({ ...common }).model, undefined);
    assert.equal(resolveRunnerSettings({ ...common, agent: { model: "saved-model" }, defaults: { model: "default-model" }, env: { THE_DUDES_CLAUDE_MODEL: "-x" } }).model, "saved-model");
    assert.equal(isValidRunnerModel("-x"), false);
    assert.equal(isValidRunnerModel("x".repeat(129)), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("T-1336: dsh accepts only a bounded canonical provider/model pair; other runners keep scalar grammar", () => {
  const home = tempDir("t1336-dsh-model-");
  const pair = '["openrouter","meta/muse-spark-1.3-contributor"]';
  const warnings: string[] = [];
  try {
    const common = { runner: "dsh" as const, configAliases: { claude: [] }, home, ownerUid: uid, warn: (message: string) => warnings.push(message) };
    const resolved = resolveRunnerSettings({ ...common, agent: { model: pair } });
    assert.equal(resolved.model, pair, "model configurado chega intacto à resolução");
    assert.equal(isValidDshModel(pair), true);
    assert.equal(isValidRunnerModelFor("dsh", pair), true);
    assert.equal(isValidRunnerModel(pair), false, "a gramática escalar continua rejeitando o par");

    for (const invalid of [
      '["openrouter"]',
      '["openrouter","model","extra"]',
      '["open router","model"]',
      JSON.stringify(["openrouter", "x".repeat(129)]),
      '[ "openrouter", "model" ]',
      '["openrouter",9]',
      '["openrouter","model"] trailing',
    ]) assert.equal(isValidDshModel(invalid), false, invalid);
    assert.equal(isValidRunnerModelFor("claude", pair), false, "structured models stay invalid for non-dsh runners");

    const rejected = resolveRunnerSettings({ ...common, agent: { model: '["bad route","model"]' } });
    assert.equal(rejected.model, undefined);
    assert.ok(warnings.some((message) => /from agent is invalid: expected a compact JSON pair/.test(message)), warnings.join("\n"));

    const sanitized = sanitizeRunnerDefaults({ defaults: { dsh: { model: pair }, claude: { model: pair } }, configAliases: { claude: [] } });
    assert.equal(sanitized.dsh?.model, pair);
    assert.equal(sanitized.claude, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("T-1336: debug status reports the dsh effective model after rejecting an invalid configured value", () => {
  const resolved = resolveRunnerSettings({
    runner: "dsh",
    agent: { model: '["bad route","model"]' },
    configAliases: { claude: [] },
    home: os.homedir(),
  });
  assert.equal(resolved.model, undefined, "invalid agent config is rejected");
  const effectiveModel = dshModelForTurn(resolved.model);
  assert.equal(effectiveModel, DSH_DEFAULT_MODEL);
  const host = new AgentHost(() => true, null, null, {} as never);
  const entries = (host as unknown as { entries: Map<string, unknown> }).entries;
  entries.set("dsh-agent", {
    info: { id: "dsh-agent", name: "dsh", role: "test", cliRunner: "dsh", model: '["bad route","model"]' },
    effectiveModel,
    runner: null,
    autoApprove: false,
  });
  assert.equal(host.debugSnapshot()[0]?.model, DSH_DEFAULT_MODEL, "dashboard status uses the model the dsh runner will actually set");
});

test("T-1136: agent effort beats default and runner/model compatibility is rechecked", () => {
  const home = tempDir("t1136-effort-");
  try {
    const common = { runner: "codex" as const, configAliases: { claude: [] }, home, ownerUid: uid, warn: () => {} };
    assert.equal(resolveRunnerSettings({ ...common, agent: { effort: "medium" }, defaults: { effort: "high" } }).effort, "medium");
    assert.equal(resolveRunnerSettings({ ...common, agent: { effort: "max" }, defaults: { effort: "high" } }).effort, "high");
    assert.equal(isCompatibleRunnerEffort("grok", "grok-4.6", "xhigh"), true);
    assert.equal(isCompatibleRunnerEffort("grok", "grok-4.5", "xhigh"), false);
    assert.equal(isCompatibleRunnerEffort("dsh", undefined, "medium"), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("T-1136: invalid or stale config aliases fail closed to Claude native config", () => {
  const home = tempDir("t1136-alias-");
  try {
    fs.mkdirSync(path.join(home, ".claude"));
    const aliases = discoverClaudeConfigAliases({ home, ownerUid: uid });
    const valid = aliases[0]!;
    const common = { runner: "claude" as const, agent: {}, configAliases: { claude: aliases }, home, ownerUid: uid, warn: () => {} };
    const selected = resolveRunnerSettings({ ...common, defaults: { claudeConfigDir: valid.alias } });
    assert.equal(selected.configDir, valid.path);
    assert.deepEqual(selected.configAlias, { alias: valid.alias, label: valid.label });
    assert.equal(selected.configSource, "default");
    assert.equal(resolveRunnerSettings({ ...common, defaults: { claudeConfigDir: "unknown-alias-123" } }).configSource, "native");
    const envSelected = resolveRunnerSettings({ ...common, agent: { claudeConfigDir: path.join(home, ".claude") }, defaults: { claudeConfigDir: "unknown-alias-123" }, env: { THE_DUDES_CLAUDE_CONFIG_DIR: "~/.claude" } });
    assert.equal(envSelected.configDir, "~/.claude", "operator env path is preserved verbatim");
    assert.equal(envSelected.configSource, "env");
    assert.equal(revalidateClaudeConfigAlias(valid.path, aliases, home, uid), valid.path);
    fs.renameSync(valid.path, `${valid.path}-old`);
    fs.symlinkSync(`${valid.path}-old`, valid.path);
    assert.equal(revalidateClaudeConfigAlias(valid.path, aliases, home, uid), undefined);
    assert.equal(resolveRunnerSettings({ ...common, defaults: { claudeConfigDir: valid.alias } }).configSource, "native");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("T-1136: operator Claude config env applies verbatim outside HOME through the spawn env", () => {
  const home = tempDir("t1136-env-home-");
  const configRoot = tempDir("t1136-env-config-");
  const configuredDir = path.join(configRoot, ".config", "claude");
  fs.mkdirSync(configuredDir, { recursive: true });
  const warnings: string[] = [];
  try {
    fs.mkdirSync(path.join(home, ".claude"));
    const aliases = discoverClaudeConfigAliases({ home, ownerUid: uid });
    const selected = resolveRunnerSettings({
      runner: "claude",
      agent: { claudeConfigDir: path.join(home, ".claude") },
      defaults: { claudeConfigDir: aliases[0]?.alias ?? "unknown-alias" },
      configAliases: { claude: aliases },
      home,
      ownerUid: uid,
      env: { THE_DUDES_CLAUDE_CONFIG_DIR: configuredDir },
      warn: (message) => warnings.push(message),
    });
    assert.equal(selected.configDir, configuredDir);
    assert.equal(selected.configSource, "env");
    assert.equal(selected.configAlias, undefined);

    const childEnv = buildEnv({
      opts: {
        cliRunner: "claude",
        resolvedClaudeConfigDir: selected.configDir,
        resolvedClaudeConfigFromEnv: selected.configSource === "env",
        approvedClaudeConfigAliases: aliases,
        claudeConfigHome: home,
        claudeConfigOwnerUid: uid,
        orchestratorUrl: "http://127.0.0.1:1",
        log: (_level: string, message: string) => warnings.push(message),
      },
      info: { id: "agent-test", name: "test" },
    });
    assert.equal(childEnv.CLAUDE_CONFIG_DIR, configuredDir);
    assert.deepEqual(warnings, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configRoot, { recursive: true, force: true });
  }
});

test("T-1136: Docker Claude env path is preserved exactly and warns instead of silently falling back", () => {
  const home = tempDir("t1136-docker-home-");
  const configuredDir = "/home/node/.config/claude";
  const warnings: string[] = [];
  try {
    const selected = resolveRunnerSettings({
      runner: "claude",
      agent: {},
      defaults: { claudeConfigDir: "unknown-alias" },
      configAliases: { claude: [] },
      home,
      ownerUid: uid,
      env: { THE_DUDES_CLAUDE_CONFIG_DIR: configuredDir },
    });
    assert.equal(selected.configDir, configuredDir);
    assert.equal(selected.configSource, "env");
    const childEnv = buildEnv({
      opts: {
        cliRunner: "claude",
        resolvedClaudeConfigDir: selected.configDir,
        resolvedClaudeConfigFromEnv: selected.configSource === "env",
        approvedClaudeConfigAliases: [],
        claudeConfigHome: home,
        claudeConfigOwnerUid: uid,
        orchestratorUrl: "http://127.0.0.1:1",
        log: (_level: string, message: string) => warnings.push(message),
      },
      info: { id: "agent-test", name: "test" },
    });
    assert.equal(childEnv.CLAUDE_CONFIG_DIR, configuredDir);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /passing the operator value through unchanged/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("T-1136: Qwen aliases are ignored even if present in a received defaults object", () => {
  const warnings: string[] = [];
  const sanitized = sanitizeRunnerDefaults({
    configAliases: { claude: [] },
    defaults: { qwen: { model: "qwen3-coder-plus", qwenHome: "qwen-home-01" } },
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(sanitized, { qwen: { model: "qwen3-coder-plus" } });
  assert.equal(warnings.some((message) => /qwenHome/i.test(message)), true);
});

test("T-1136: server-provided binary paths are discarded", () => {
  const sanitized = sanitizeRunnerDefaults({
    configAliases: { claude: [] },
    defaults: { claude: { model: "claude-sonnet-4", binary: "/tmp/untrusted-runner" } } as never,
  });
  assert.deepEqual(sanitized, { claude: { model: "claude-sonnet-4" } });
});

test("T-1136: runner version status extracts only a bounded semver token", () => {
  assert.equal(parseRunnerVersion("Claude Code 2.1.7 (secret-token-should-not-escape)"), "2.1.7");
  assert.equal(parseRunnerVersion("invalid executable output"), undefined);
  assert.equal(parseRunnerVersion("".padEnd(3_000, "x") + "9.9.9"), undefined);
});

test("T-1136: version probe invokes the detected binary and returns no raw output", async () => {
  const dir = tempDir("t1136-version-");
  try {
    const binary = path.join(dir, "fake-claude");
    fs.writeFileSync(binary, "#!/usr/bin/env node\nprocess.stdout.write('Claude Code 2.4.6 private-output-canary')\n", { mode: 0o700 });
    const version = await probeRunnerVersion({
      command: binary,
      source: "detected",
      available: true,
      resolvedPath: binary,
    }, null, dir, 5_000);
    assert.equal(version, "2.4.6");
    assert.equal(JSON.stringify({ version }).includes("private-output-canary"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("T-1136: health reports every runner using the SERVER runnerStatus schema", () => {
  const commands = Object.fromEntries(RUNNERS.map((runner) => [runner, {
    command: `/opt/runners/${runner}`,
    source: "detected" as const,
    available: false,
    resolvedPath: `/opt/runners/${runner}`,
  }])) as unknown as ResolvedCliCommands;
  const installed = Object.fromEntries(RUNNERS.map((runner) => [runner, runner === "claude" || runner === "codex"])) as InstalledRunnerAvailability;
  const runnerStatus = buildRunnerStatusMap({
    commands,
    installed,
    versions: { codex: "0.41.0" },
    claudeConfigDir: { alias: "claude-alias-01", source: "default" },
  });
  assert.deepEqual(Object.keys(runnerStatus).sort(), [...RUNNERS].sort());
  assert.deepEqual(runnerStatus.codex, { installed: true, version: "0.41.0", binary: "/opt/runners/codex" });
  assert.deepEqual(runnerStatus.claude, {
    installed: true,
    binary: "/opt/runners/claude",
    claudeConfigDir: { alias: "claude-alias-01", source: "default" },
  });
  assert.deepEqual(runnerStatus.qwen, { installed: false });

  const frame = {
    type: "daemon:health",
    health: {
      ts: 1,
      uptimeS: 1,
      memRssMb: 1,
      wsRttMs: null,
      turnGate: { active: 0, queued: 0, max: 1 },
      turns: { started: 0, ok: 0, failed: 0, hardRecovers: 0, hangs: 0 },
      turnP50Ms: null,
      turnP95Ms: null,
      byRunner: {},
      agentsRunning: 0,
      e2eeProjects: 0,
      runnerStatus,
    },
  };
  assert.deepEqual(validateDaemonMessage(JSON.parse(JSON.stringify(frame))), { ok: true });
});
