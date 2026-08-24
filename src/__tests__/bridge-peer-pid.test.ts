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

test("T-061: self-test passa → enforce", async () => {
  const on = new BridgeRelay("http://127.0.0.1:9", null, undefined, {
    peerPidSelfTest: async () => true,
  });
  await on.start();
  try {
    assert.equal(on.peerPidEnforced, true);
    assert.equal(on.peerPidAllowInsecure, false);
  } finally {
    on.stop();
  }
});

test("T-093: self-test falha → fail-CLOSED, conexão RECUSADA (503) + log acionável", async () => {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { logs.push(String(args[0])); };
  delete process.env.THE_DUDES_PEER_PID_INSECURE;
  try {
    const off = new BridgeRelay("http://127.0.0.1:9", null, undefined, {
      peerPidSelfTest: async () => false,
    });
    await off.start();
    try {
      assert.equal(off.peerPidEnforced, false);
      assert.equal(off.peerPidAllowInsecure, false);
      assert.ok(logs.some((l) => l.includes("fail-CLOSED")));
      assert.ok(logs.some((l) => l.includes("python3")));
      assert.equal(await unixStatus(off.socketPath, "/api/bridge/ag_x/tasks_list"), 503);
      assert.ok(logs.some((l) => l.includes("refusing unverifiable")));
    } finally {
      off.stop();
    }
  } finally {
    console.error = orig;
  }
});

test("T-093: self-test throw → fail-CLOSED (não fail-OPEN)", async () => {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { logs.push(String(args[0])); };
  delete process.env.THE_DUDES_PEER_PID_INSECURE;
  try {
    const boom = new BridgeRelay("http://127.0.0.1:9", null, undefined, {
      peerPidSelfTest: async () => { throw new Error("no python3"); },
    });
    await boom.start();
    try {
      assert.equal(boom.peerPidEnforced, false);
      assert.equal(boom.peerPidAllowInsecure, false);
      assert.equal(await unixStatus(boom.socketPath, "/api/bridge/ag_x/tasks_list"), 503);
      assert.ok(logs.some((l) => l.includes("fail-CLOSED")));
    } finally {
      boom.stop();
    }
  } finally {
    console.error = orig;
  }
});

test("T-093: THE_DUDES_PEER_PID_INSECURE=1 → aceita + loga downgrade por conexão", async () => {
  const logs: string[] = [];
  const origErr = console.error;
  const origWarn = console.warn;
  console.error = (...args: unknown[]) => { logs.push(String(args[0])); };
  console.warn = (...args: unknown[]) => { logs.push(String(args[0])); };
  const prev = process.env.THE_DUDES_PEER_PID_INSECURE;
  process.env.THE_DUDES_PEER_PID_INSECURE = "1";
  try {
    const insecure = new BridgeRelay("http://127.0.0.1:9", null, undefined, {
      peerPidSelfTest: async () => false,
    });
    await insecure.start();
    try {
      assert.equal(insecure.peerPidEnforced, false);
      assert.equal(insecure.peerPidAllowInsecure, true);
      assert.ok(logs.some((l) => l.includes("INSECURE override")));
      // Aceita o handle (não 503): orch fake → 502 no fetch.
      assert.equal(await unixStatus(insecure.socketPath, "/api/bridge/ag_x/tasks_list"), 502);
      assert.ok(logs.some((l) => l.includes("accepting unverifiable")));
    } finally {
      insecure.stop();
    }
  } finally {
    console.error = origErr;
    console.warn = origWarn;
    if (prev === undefined) delete process.env.THE_DUDES_PEER_PID_INSECURE;
    else process.env.THE_DUDES_PEER_PID_INSECURE = prev;
  }
});

test("T-093: self-test real no host (python3) → enforce", async () => {
  delete process.env.THE_DUDES_PEER_PID_INSECURE;
  const relay = new BridgeRelay("http://127.0.0.1:9", null);
  await relay.start();
  try {
    assert.equal(
      relay.peerPidEnforced,
      true,
      "host deve passar o self-test peer-pid (python3 ctypes/getsockopt)",
    );
  } finally {
    relay.stop();
  }
});

test("T-061: caminho feliz — agentId da URL ≠ peer → 403", async () => {
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
