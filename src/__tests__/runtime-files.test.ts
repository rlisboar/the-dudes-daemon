import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunnerRuntimeFiles } from "../runners/runtime-files.js";

const mode = (filePath: string) => statSync(filePath).mode & 0o777;

test("runtime files isolate agent temp data and enforce private modes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "runtime-files-test-"));
  const files = new RunnerRuntimeFiles({ workspaceRoot: root, agentId: "agent-a", agentToken: "secret", tempRoot: root });
  try {
    const tempDir = files.tempDir();
    const tokenFile = files.tokenFile();
    assert.equal(files.tempDir(), tempDir);
    assert.match(path.basename(tempDir), /^ag-/);
    assert.equal(mode(tempDir), 0o700);
    assert.equal(mode(tokenFile), 0o600);
    assert.equal(readFileSync(tokenFile, "utf8"), "secret");
    assert.equal(mode(files.geminiConfigDir()), 0o700);
    assert.equal(files.openCodeConfigPath(), path.join(tempDir, "opencode.json"));
  } finally {
    files.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime files provide stable runner homes and clean temporary images", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "runtime-files-test-"));
  const home = path.join(root, "home");
  const files = new RunnerRuntimeFiles({ workspaceRoot: root, agentId: "../b", agentToken: "token", home, tempRoot: root });
  try {
    assert.equal(files.grokHome(), path.join(home, ".grok"));
    assert.equal(files.crushDataDir(), path.join(root, ".crush", "agents", "%2E%2E%2Fb"));
    assert.equal(readFileSync(path.join(root, ".crush", ".gitignore"), "utf8"), "*\n");
    const first = files.writeImages([{ mimeType: "image/png", base64: "aGk=" }], () => "png");
    const second = files.writeImages([{ mimeType: "image/png", base64: "aGk=" }], () => "png");
    assert.notEqual(first.paths[0], second.paths[0]);
    assert.equal(mode(first.paths[0]), 0o600);
    first.cleanup();
    assert.equal(first.paths.length, 1);
    assert.throws(() => statSync(first.paths[0]));
  } finally {
    files.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
