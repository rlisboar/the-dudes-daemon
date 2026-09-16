/**
 * T-506 (micro): em ROOT+drop, CODEX_HOME herdado do env apontando pro home do
 * ROOT não pode ser a base (o user dropado não atravessa /root 0700).
 */
import "./scratch-home.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { RunnerRuntimeFiles } from "../runners/runtime-files.js";

function files(home: string) {
  return new RunnerRuntimeFiles({
    workspaceRoot: os.tmpdir(),
    agentId: "a1",
    agentToken: "t",
    home,
    runner: "codex",
  } as never);
}

test("T-506: CODEX_HOME=/root/.codex com drop p/ user vai pro home do user", () => {
  const prev = process.env.CODEX_HOME;
  const daemonHome = os.homedir();
  const dropHome = path.join(os.tmpdir(), "t506-home");
  process.env.CODEX_HOME = path.join(daemonHome, ".codex");
  try {
    const dir = (files(dropHome) as unknown as { codexBaseDir(): string }).codexBaseDir();
    assert.equal(dir, path.join(dropHome, ".codex"));
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
});

test("T-506: override acessível (fora do home do daemon) vence", () => {
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = "/opt/codex-home";
  try {
    const dir = (files(path.join(os.tmpdir(), "t506-home2")) as unknown as { codexBaseDir(): string }).codexBaseDir();
    assert.equal(dir, "/opt/codex-home");
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
});

test("T-506: sem drop (home == daemon home) o env continua vencendo", () => {
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(os.homedir(), ".codex");
  try {
    const dir = (files(os.homedir()) as unknown as { codexBaseDir(): string }).codexBaseDir();
    assert.equal(dir, path.join(os.homedir(), ".codex"));
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
});
