import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BridgeRelay } from "../bridge-relay.js";
import {
  clearAgentPidRegistry,
  registerAgentPid,
  resolveAgentIdFromPid,
  setParentPidReader,
  setUnixPeerPidReader,
  spawnDropped,
} from "../privileges.js";
import { RunnerRuntimeFiles } from "../runners/runtime-files.js";

afterEach(() => {
  clearAgentPidRegistry();
  setParentPidReader(null);
  setUnixPeerPidReader(null);
});

function unixStatus(socketPath: string, urlPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: urlPath, method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

test("T-061: resolveAgentIdFromPid sobe a cadeia de pais", () => {
  registerAgentPid("ag_a", 100);
  setParentPidReader((pid) => ({ 300: 200, 200: 100, 100: 1 }[pid] ?? 0));
  assert.equal(resolveAgentIdFromPid(300), "ag_a");
  assert.equal(resolveAgentIdFromPid(200), "ag_a");
  assert.equal(resolveAgentIdFromPid(100), "ag_a");
  assert.equal(resolveAgentIdFromPid(50), null);
});

test("T-061: spawnDropped registra THE_DUDES_AGENT_ID; bindProcess também", () => {
  const child = spawnDropped(
    process.execPath,
    ["-e", "setInterval(()=>{}, 1000)"],
    { env: { ...process.env, THE_DUDES_AGENT_ID: "ag_spawn" }, stdio: "ignore" },
    null,
  );
  assert.ok(child.pid);
  assert.equal(resolveAgentIdFromPid(child.pid!), "ag_spawn");
  child.kill();
  const files = new RunnerRuntimeFiles({
    workspaceRoot: process.cwd(),
    agentId: "ag_bound",
    agentToken: "tok",
  });
  files.bindProcess(5555);
  assert.equal(resolveAgentIdFromPid(5555), "ag_bound");
  files.cleanup();
});

test("T-061: self-test passa → enforce; falha → fail-open + ERROR", async () => {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { logs.push(String(args[0])); };
  try {
    const on = new BridgeRelay("http://127.0.0.1:9", null, undefined, {
      peerPidSelfTest: async () => true,
    });
    await on.start();
    assert.equal(on.peerPidEnforced, true);
    on.stop();

    const off = new BridgeRelay("http://127.0.0.1:9", null, undefined, {
      peerPidSelfTest: async () => false,
    });
    await off.start();
    assert.equal(off.peerPidEnforced, false);
    assert.ok(logs.some((l) => l.includes("fail-OPEN")));
    off.stop();
  } finally {
    console.error = orig;
  }
});

test("T-061: agentId da URL ≠ peer → 403", async () => {
  registerAgentPid("ag_victim", 4242);
  registerAgentPid("ag_thief", 7777);
  setUnixPeerPidReader(() => 7777);
  setParentPidReader(() => 1);
  const relay = new BridgeRelay("http://127.0.0.1:9", null, undefined, {
    peerPidSelfTest: async () => true,
  });
  await relay.start();
  try {
    assert.equal(await unixStatus(relay.socketPath, "/api/bridge/ag_victim/tasks_list"), 403);
    assert.equal(await unixStatus(relay.socketPath, "/api/bridge/ag_thief/get_credential"), 502);
  } finally {
    relay.stop();
  }
});
