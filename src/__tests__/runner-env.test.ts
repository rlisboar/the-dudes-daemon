import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliRunner } from "../types.js";
import { buildBaseRunnerEnv, buildBridgeAwareEnv, buildGeminiEnv, buildGrokEnv } from "../runners/env.js";

const RUNNERS: CliRunner[] = ["claude", "codex", "grok", "opencode", "gemini", "crush"];

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

test("T-064: AWS_*/GITHUB_TOKEN/*_SECRET não chegam; PATH/HOME nos 6 runners", () => {
  const inherited = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
    USER: "lisboa",
    LOGNAME: "lisboa",
    AWS_ACCESS_KEY_ID: "AKIAxxx",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    AWS_SESSION_TOKEN: "sess",
    GITHUB_TOKEN: "ghp_xxx",
    OPENAI_API_KEY: "sk-xxx",
    DATABASE_SECRET: "dsn",
    NPM_TOKEN: "npm_xxx",
    THE_DUDES_DAEMON_TOKEN: "daemon",
    THE_DUDES_TOKEN: "legacy",
    THE_DUDES_ENCRYPTION_KEY: "enc",
    SSH_AUTH_SOCK: "/tmp/ssh.sock",
  };
  for (const runner of RUNNERS) {
    const env = buildBaseRunnerEnv({ ...baseInput, inherited, runner });
    assert.equal(env.PATH, "/usr/bin", runner);
    assert.equal(env.HOME, "/home/u", runner);
    assert.equal(env.LANG, "C.UTF-8", runner);
    assert.equal(env.TERM, "xterm-256color", runner);
    assert.equal(env.USER, "lisboa", runner);
    assert.equal(env.LOGNAME, "lisboa", runner);
    assert.equal(env.THE_DUDES_AGENT_ID, "a1", runner);
    assert.equal(env.THE_DUDES_AGENT_NAME, "Agent One", runner);
    assert.equal(env.THE_DUDES_ORCH_URL, "https://orch.example", runner);
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined, runner);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, runner);
    assert.equal(env.AWS_SESSION_TOKEN, undefined, runner);
    assert.equal(env.GITHUB_TOKEN, undefined, runner);
    assert.equal(env.OPENAI_API_KEY, undefined, runner);
    assert.equal(env.DATABASE_SECRET, undefined, runner);
    assert.equal(env.NPM_TOKEN, undefined, runner);
    assert.equal(env.THE_DUDES_DAEMON_TOKEN, undefined, runner);
    assert.equal(env.THE_DUDES_TOKEN, undefined, runner);
    assert.equal(env.THE_DUDES_ENCRYPTION_KEY, undefined, runner);
    assert.equal(env.SSH_AUTH_SOCK, undefined, runner);
  }
});

test("T-064: USER na allowlist — claude sem USER vs com USER", () => {
  const sem = buildBaseRunnerEnv({
    ...baseInput,
    runner: "claude",
    inherited: { PATH: "/bin", HOME: "/home/u", LANG: "C", TERM: "xterm" },
  });
  assert.equal(sem.USER, undefined);
  assert.equal(sem.LOGNAME, undefined);
  const com = buildBaseRunnerEnv({
    ...baseInput,
    runner: "claude",
    inherited: { PATH: "/bin", HOME: "/home/u", LANG: "C", TERM: "xterm", USER: "lisboa", LOGNAME: "lisboa" },
  });
  assert.equal(com.USER, "lisboa");
  assert.equal(com.LOGNAME, "lisboa");
});

test("T-064: passthrough opt-in copia só as chaves pedidas", () => {
  const inherited = {
    PATH: "/bin",
    TZ: "UTC",
    TMPDIR: "/tmp/agent",
    AWS_ACCESS_KEY_ID: "AKIA",
    THE_DUDES_AGENT_ENV_PASSTHROUGH: "TZ,TMPDIR",
  };
  const env = buildBaseRunnerEnv({ ...baseInput, inherited });
  assert.equal(env.TZ, "UTC");
  assert.equal(env.TMPDIR, "/tmp/agent");
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(env.THE_DUDES_AGENT_ENV_PASSTHROUGH, undefined);
});

test("T-064: passthrough não consegue forçar secrets do daemon", () => {
  const inherited = {
    PATH: "/bin",
    THE_DUDES_DAEMON_TOKEN: "secret",
    THE_DUDES_ENCRYPTION_KEY: "enc",
    THE_DUDES_AGENT_TOKEN: "agent-tok",
    THE_DUDES_AGENT_ENV_PASSTHROUGH: "THE_DUDES_DAEMON_TOKEN,THE_DUDES_ENCRYPTION_KEY,THE_DUDES_AGENT_TOKEN",
  };
  const env = buildBaseRunnerEnv({
    ...baseInput,
    inherited,
    passthrough: ["THE_DUDES_DAEMON_TOKEN"],
  });
  assert.equal(env.THE_DUDES_DAEMON_TOKEN, undefined);
  assert.equal(env.THE_DUDES_ENCRYPTION_KEY, undefined);
  assert.equal(env.THE_DUDES_AGENT_TOKEN, undefined);
});
