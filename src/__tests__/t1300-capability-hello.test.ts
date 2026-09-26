import assert from "node:assert/strict";
import test from "node:test";
import { validateDaemonMessage } from "@the-dudes/protocol/daemon-wire";

import { DAEMON_CAPABILITIES, withDaemonCapabilities } from "../daemon-capabilities.js";

test("T-1300: main hello builder advertises capabilities and passes the full protocol schema", () => {
  assert.deepEqual(DAEMON_CAPABILITIES, ["member-gate"]);
  const hello = withDaemonCapabilities({
    type: "daemon:hello",
    name: "member-gate-test",
    os: "darwin",
    hostname: "test-host",
    version: "test",
    daemonId: "00000000-0000-4000-8000-000000000001",
    configDirAliases: {},
    protocolVersion: 1,
    passive: true,
    updatePending: true,
    updatePendingSince: 1_700_000_000_000,
    updateDraining: false,
    binaryHash: "test-hash",
    buildTs: 1_700_000_000_000,
    cryptoPublicKey: "test-public-key",
    resumeFromSeq: 7,
    availableRunners: ["claude"],
    installedRunners: ["claude"],
    graphify: { cli: true, mcp: false },
  });
  assert.deepEqual(hello.capabilities, ["member-gate"]);
  const result = validateDaemonMessage(hello as never);
  assert.equal(result.ok, true, JSON.stringify(result));
});
