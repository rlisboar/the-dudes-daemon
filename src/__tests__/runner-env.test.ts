import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBaseRunnerEnv, buildBridgeAwareEnv, buildGeminiEnv, buildGrokEnv } from "../runners/env.js";

const baseInput = {
  inherited: { PATH: "/usr/bin", THE_DUDES_DAEMON_TOKEN: "daemon-secret", THE_DUDES_ENCRYPTION_KEY: "db-secret" },
  runner: "claude" as const,
  agentId: "a1",
  agentName: "Agent One",
  orchestratorUrl: "https://orch.example",
};

test("base runner env scrubs daemon/server secrets and injects identity", () => {
  const env = buildBaseRunnerEnv(baseInput);
  assert.equal(env.THE_DUDES_DAEMON_TOKEN, undefined);
  assert.equal(env.THE_DUDES_ENCRYPTION_KEY, undefined);
  assert.equal(env.THE_DUDES_AGENT_ID, "a1");
  assert.equal(env.PATH, "/usr/bin");
});

test("runner-specific config variables do not leak across providers", () => {
  const inherited = { CLAUDE_CONFIG_DIR: "stale", OPENCODE_CONFIG: "stale" };
  const claude = buildBaseRunnerEnv({ ...baseInput, inherited, runner: "claude", claudeConfigDir: "/claude" });
  const opencode = buildBaseRunnerEnv({ ...baseInput, inherited, runner: "opencode", opencodeConfigPath: "/oc.json" });
  assert.equal(claude.CLAUDE_CONFIG_DIR, "/claude");
  const claudeNative = buildBaseRunnerEnv({ ...baseInput, inherited, runner: "claude" });
  assert.equal(claudeNative.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(claude.OPENCODE_CONFIG, undefined);
  assert.equal(opencode.OPENCODE_CONFIG, "/oc.json");
  assert.equal(opencode.CLAUDE_CONFIG_DIR, undefined);
});

test("bridge-aware env adds token file while ordinary base env does not", () => {
  const base = buildBaseRunnerEnv(baseInput);
  assert.equal(base.THE_DUDES_AGENT_TOKEN_FILE, undefined);
  const bridge = buildBridgeAwareEnv(base, "/tmp/token", { THE_DUDES_FEATURES: "tasks" });
  assert.equal(bridge.THE_DUDES_AGENT_TOKEN_FILE, "/tmp/token");
  assert.equal(bridge.THE_DUDES_FEATURES, "tasks");
});

test("Gemini and Grok receive only their required overrides", () => {
  const base = buildBaseRunnerEnv(baseInput);
  assert.equal(buildGeminiEnv(base).GEMINI_CLI_TRUST_WORKSPACE, "true");
  const grok = buildGrokEnv({
    base,
    tokenFile: "/tmp/token",
    features: {},
    grokHome: "/home/u/.grok",
    dropTo: { uid: 1, gid: 1, user: "u", home: "/home/u", path: "/bin" },
  });
  assert.equal(grok.HOME, "/home/u");
  assert.equal(grok.GROK_HOME, "/home/u/.grok");
  assert.equal(grok.GROK_DISABLE_AUTOUPDATER, "1");
});
