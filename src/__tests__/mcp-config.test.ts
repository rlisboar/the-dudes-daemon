import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBridgeEnv, buildClaudeMcpConfig, buildCodexMcpArgs, buildCrushMcpConfig, buildGeminiMcpServers, buildGrokMcpToml, buildOpenCodeMcpConfig } from "../runners/mcp-config.js";

const bridge = { command: "node", args: ["bridge.js"], env: { TOKEN: "file" } };

test("bridge env contains identity, token file, features and optional socket", () => {
  assert.deepEqual(buildBridgeEnv({ agentId: "a", agentName: "A", orchestratorUrl: "https://o", tokenFile: "/t", features: { THE_DUDES_FEATURES: "tasks" }, socketPath: "/s" }), {
    THE_DUDES_AGENT_ID: "a", THE_DUDES_AGENT_NAME: "A", THE_DUDES_ORCH_URL: "https://o", THE_DUDES_AGENT_TOKEN_FILE: "/t", THE_DUDES_FEATURES: "tasks", THE_DUDES_BRIDGE_SOCKET: "/s",
  });
});

test("Gemini preserves remote servers but reserves the internal bridge name", () => {
  const servers = buildGeminiMcpServers({ remote: { type: "http", url: "https://mcp" }, "the-dudes": { command: "evil" } }, bridge);
  assert.deepEqual(servers.remote, { url: "https://mcp" });
  assert.deepEqual(servers["the-dudes"], bridge);
});

test("Claude preserves native server shapes and reserves the internal bridge", () => {
  const config = buildClaudeMcpConfig({ remote: { type: "sse", url: "https://mcp" }, "the-dudes": { command: "evil" } }, bridge);
  assert.deepEqual(config.mcpServers.remote, { type: "sse", url: "https://mcp" });
  assert.deepEqual(config.mcpServers["the-dudes"], { type: "stdio", ...bridge });
});

test("Crush supports local and remote servers and reports incomplete entries", () => {
  const result = buildCrushMcpConfig({
    local: { command: "tool", args: ["--x"], env: { A: "1" } },
    remote: { type: "http", url: "https://mcp", headers: { Authorization: "token" } },
    broken: { type: "sse" },
  }, bridge);
  const mcp = result.config.mcp as Record<string, unknown>;
  assert.deepEqual(mcp.local, { type: "stdio", command: "tool", args: ["--x"], env: { A: "1" } });
  assert.deepEqual(mcp.remote, { type: "http", url: "https://mcp", headers: { Authorization: "token" } });
  assert.equal(result.warnings.length, 1);
});

test("Grok emits escaped TOML for local, remote and interpolated bridge entries", () => {
  const result = buildGrokMcpToml({
    "local.tool": { command: "a\"b", args: ["$HOME"], env: { KEY: "value" } },
    remote: { type: "sse", url: "https://mcp", headers: { "X-Key": "secret" } },
    broken: { type: "http" },
  }, { command: "node", args: [], env: { AGENT: "${AGENT}" } });
  assert.match(result.toml, /\[mcp_servers\.local-tool\]/);
  assert.ok(result.toml.includes('command = "a\\"b"'));
  assert.ok(result.toml.includes('"X-Key" = "secret"'));
  assert.ok(result.toml.includes('"AGENT" = "${AGENT}"'));
  assert.equal(result.warnings.length, 1);
});

test("OpenCode keeps stdio only and returns actionable warnings", () => {
  const result = buildOpenCodeMcpConfig({ local: { command: "tool", args: ["--x"] }, remote: { type: "http", url: "https://mcp" } }, bridge, false);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual((result.config.mcp as Record<string, unknown>).local, { type: "local", enabled: true, command: ["tool", "--x"] });
  assert.deepEqual(result.config.permission, { edit: "ask", bash: "ask", webfetch: "ask", external_directory: "ask" });
});

test("Codex TOML args escape quoted names and values without shell interpolation", () => {
  const result = buildCodexMcpArgs({ "odd.name": { command: "a\"b", args: ["$HOME"] }, remote: { type: "sse", url: "https://mcp" } }, bridge);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.args.some((arg) => arg.includes('mcp_servers."odd.name".command="a\\"b"')));
  assert.ok(result.args.some((arg) => arg.includes('["$HOME"]')));
});
