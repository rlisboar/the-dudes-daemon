/**
 * T-424 (A12): endurecimento do task-workspace.
 *
 * 1. branch validada (metachar/path traversal/leading '-') antes de merge-base
 *    e `branch -D`;
 * 2. path confinado a <repoRoot>-wt (o server manda o path);
 * 3. createTaskWorktree aplica validateBasePath (base path não é confiável);
 * 4. git roda com spawnDropped + env mínimo — hook do repo NÃO vê o
 *    process.env inteiro (THE_DUDES_DAEMON_TOKEN fica de fora).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createTaskWorktree, removeTaskWorktree } from "../task-workspace.js";
import { gitMinimalEnv } from "../workspace.js";

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status !== 0) throw new Error(r.stderr || `git ${args.join(" ")} -> ${r.status}`);
  return r.stdout.trim();
}

function fixtureRepo(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "t424-repo-")));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "t424@test"]);
  git(dir, ["config", "user.name", "T424"]);
  writeFileSync(path.join(dir, "README"), "root\n");
  git(dir, ["add", "README"]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

test("T-424 remove: branch com traversal/metachar é recusada", async () => {
  const repo = fixtureRepo();
  const a = await createTaskWorktree({ workspaceRoot: repo, taskId: "t1", agentId: "ag" });
  assert.equal(a.ok, true);
  for (const branch of ["../evil", "a;rm -rf /", "-flag", "a..b", "a//b"]) {
    const r = await removeTaskWorktree({ workspaceRoot: repo, path: a.path, branch, force: true });
    assert.equal(r.ok, false, `branch "${branch}" deveria ser recusada`);
  }
  // A branch real continua removendo.
  const ok = await removeTaskWorktree({ workspaceRoot: repo, path: a.path, branch: a.branch, force: true });
  assert.equal(ok.ok, true, ok.ok ? "" : ok.error);
});

test("T-424 remove: path fora de <repoRoot>-wt é recusado", async () => {
  const repo = fixtureRepo();
  const a = await createTaskWorktree({ workspaceRoot: repo, taskId: "t2", agentId: "ag" });
  assert.equal(a.ok, true);
  const r = await removeTaskWorktree({
    workspaceRoot: repo,
    path: path.join(tmpdir(), "fora-do-wt"),
    branch: a.branch,
    force: true,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /fora de/);
  const real = await removeTaskWorktree({ workspaceRoot: repo, path: a.path, branch: a.branch, force: true });
  assert.equal(real.ok, true, real.ok ? "" : real.error);
});

test("T-424 create: validateBasePath recusa base proibida; aceita repo válido", async () => {
  const r = await createTaskWorktree({ workspaceRoot: "/", taskId: "t3", agentId: "ag" });
  assert.equal(r.ok, false);
  assert.match(r.error, /not allowed|não encontrado|not found|required/i);
});

test("T-424 env: git do worktree não herda process.env (token fora do hook)", async () => {
  const repo = fixtureRepo();
  const dump = path.join(repo, ".hook-env");
  const hook = path.join(repo, ".git", "hooks", "post-checkout");
  writeFileSync(hook, `#!/bin/sh\nenv > "${dump}"\n`);
  chmodSync(hook, 0o755);

  const prev = process.env.THE_DUDES_DAEMON_TOKEN;
  process.env.THE_DUDES_DAEMON_TOKEN = "segredo-t424";
  try {
    const r = await createTaskWorktree({ workspaceRoot: repo, taskId: "t4", agentId: "ag" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.ok(existsSync(dump), "hook post-checkout do worktree add não rodou");
    const env = readFileSync(dump, "utf8");
    assert.doesNotMatch(env, /THE_DUDES_DAEMON_TOKEN/, "token vazou pro hook do repo");
    assert.match(env, /^PATH=/m, "PATH mínimo presente");
    assert.match(env, /^GIT_TERMINAL_PROMPT=0$/m);
  } finally {
    if (prev === undefined) delete process.env.THE_DUDES_DAEMON_TOKEN;
    else process.env.THE_DUDES_DAEMON_TOKEN = prev;
  }
});

test("T-424 gitMinimalEnv: contrato do env enxuto", () => {
  const prev = process.env.THE_DUDES_DAEMON_TOKEN;
  process.env.THE_DUDES_DAEMON_TOKEN = "x";
  try {
    const env = gitMinimalEnv(null);
    assert.equal(env.THE_DUDES_DAEMON_TOKEN, undefined);
    assert.ok(env.PATH);
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  } finally {
    if (prev === undefined) delete process.env.THE_DUDES_DAEMON_TOKEN;
    else process.env.THE_DUDES_DAEMON_TOKEN = prev;
  }
});

test("T-424 wiring: spawn via spawnDropped, `--` antes de paths/refs", async () => {
  const src = readFileSync(new URL("../task-workspace.ts", import.meta.url), "utf8");
  assert.match(src, /spawnDropped\(\s*"git"/);
  assert.match(src, /gitMinimalEnv\(/);
  assert.match(src, /validateGitRef\(/);
  assert.match(src, /isInsideRoot\(/);
  assert.match(src, /validateBasePath\(/);
  assert.doesNotMatch(src, /env: \{ \.\.\.process\.env/);
  assert.match(src, /"worktree", "add", "-b", branch, "--"/);
  assert.match(src, /"worktree", "remove", "--"/);
  assert.match(src, /"branch", "-D", "--"/);
});