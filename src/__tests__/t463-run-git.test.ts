/**
 * T-463 (R8): runGit central — timeout com kill de grupo, env mínimo,
 * validação de refs e sucesso em repo real.
 */
import "./scratch-home.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { runGit, validateGitRef } from "../runners/run-git.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function makeRepo(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), "t463-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(path.join(repo, "a.txt"), "a");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return repo;
}

test("T-463: runGit roda git real e capa o stderr", async () => {
  const repo = makeRepo();
  const r = await runGit(repo, ["status", "--porcelain"]);
  assert.equal(r.ok, true, r.stderr);
  const bad = await runGit(repo, ["rev-parse", "nao-existe"]);
  assert.equal(bad.ok, false);
  assert.ok(bad.status !== 0);
});

test("T-463: timeout mata o GRUPO (shim + neto)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t463-shim-"));
  const pidFile = path.join(dir, "child.pid");
  const shim = path.join(dir, "git");
  writeFileSync(shim, `#!/bin/sh\nsleep 300 &\necho $! > ${pidFile}\nsleep 300\nwait\n`);
  chmodSync(shim, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    // T-1088: 1,2s não dava tempo de o SHIM nem começar sob carga (o pid do neto
    // nunca aparecia e o caso virava "neto 0 sobreviveu"). 5s mantém o teste
    // (timeout → kill do grupo) com folga para o shim se registrar.
    const r = await runGit(process.cwd(), ["status"], { timeoutMs: 10_000 });
    assert.equal(r.timedOut, true, JSON.stringify(r));
    assert.equal(r.ok, false);
    let raw = "";
// T-1088: janela LARGA — sob carga o pid do neto demora a aparecer/morrer e a
// janela curta virava falso vermelho ('pid file não parseável'/'neto sobreviveu').
    const pidDeadline = Date.now() + 15_000;
    while (!raw && Date.now() < pidDeadline) { try { raw = readFileSync(pidFile, "utf8"); } catch { await new Promise((res) => setTimeout(res, 50)); } }
    assert.ok(raw.trim(), "pid do neto não apareceu no arquivo (shim morto antes de escrever?)");
    const child = Number(raw.trim());
    const deadline = Date.now() + 10_000;
    while (alive(child) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    assert.equal(alive(child), false, `neto ${child} sobreviveu ao timeout`);
  } finally {
    process.env.PATH = oldPath!;
  }
});

test("T-463: env mínimo — secrets do daemon não vão pro hook/child", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t463-env-"));
  const shim = path.join(dir, "git");
  writeFileSync(shim, `#!/bin/sh\nenv > "$(dirname $0)/env.dump"\nexit 0\n`);
  chmodSync(shim, 0o755);
  const oldPath = process.env.PATH; const oldTok = process.env.THE_DUDES_DAEMON_TOKEN;
  process.env.PATH = `${dir}:${oldPath}`;
  process.env.THE_DUDES_DAEMON_TOKEN = "segredo-do-daemon";
  try {
    const r = await runGit(process.cwd(), ["status"]);
    assert.equal(r.ok, true, r.stderr);
    const dump = readFileSync(path.join(dir, "env.dump"), "utf8");
    assert.match(dump, /^PATH=/m, "PATH vai");
    assert.doesNotMatch(dump, /THE_DUDES_DAEMON_TOKEN/, "token do daemon fica de fora");
  } finally {
    process.env.PATH = oldPath!;
    if (oldTok === undefined) delete process.env.THE_DUDES_DAEMON_TOKEN; else process.env.THE_DUDES_DAEMON_TOKEN = oldTok;
  }
});

test("T-463: validateGitRef recusa leading '-' e separadores", () => {
  assert.throws(() => validateGitRef("-upload-pack=evil"), /começar com|-/);
  assert.throws(() => validateGitRef("a..b"), /git|inválido|regras/);
  validateGitRef("backend/T-463");
});

test("T-463 wiring: call sites usam runGit (sem spawnDropped cru de git)", async () => {
  const { readFileSync: rf } = await import("node:fs");
  const here = path.dirname(new URL(import.meta.url).pathname);
  const files = ["../task-workspace.ts", "../workspace.ts", "../agent-host.ts"];
  for (const f of files) {
    const src = rf(path.join(here, f), "utf8");
    assert.match(src, /from "\.\/runners\/run-git\.js"|from "\.\.\/runners\/run-git\.js"/, `${f} importa runGit`);
    assert.doesNotMatch(src, /spawnDropped\(\s*"git"/, `${f}: git cru`);
  }
  assert.ok(existsSync(path.join(here, "../runners/run-git.ts")));
});

test("T-554: validador exposto é o ESTRITO (allowlist) — a.lock e não-ASCII recusados", () => {
  // M2 (voltar à cópia frouxa denylist) MORRE aqui.
  assert.throws(() => validateGitRef("release.lock"), /regras|inválido/, "a.lock");
  assert.throws(() => validateGitRef("ação"), /inválido/, "não-ASCII");
  assert.throws(() => validateGitRef("a b"), /inválido/, "espaço");
  assert.throws(() => validateGitRef("a//b"), /regras|inválido/, "barra dupla");
  assert.throws(() => validateGitRef("x".repeat(201)), /longo/, "teto de tamanho");
  assert.doesNotThrow(() => validateGitRef("feature/x-1.2"));
  assert.doesNotThrow(() => validateGitRef("v1.2.3_rc-1/x"));
});
