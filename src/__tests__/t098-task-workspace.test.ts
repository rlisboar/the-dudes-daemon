/**
 * T-098: create / colisão / remove-guard / list em repo git de fixture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createTaskWorktree,
  removeTaskWorktree,
  listLocalWorktrees,
  namesFor,
  siblingWtRoot,
} from "../task-workspace.js";

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.status !== 0) throw new Error(r.stderr || `git ${args.join(" ")} -> ${r.status}`);
  return r.stdout.trim();
}

function fixtureRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "t098-repo-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "t098@test"]);
  git(dir, ["config", "user.name", "T098"]);
  writeFileSync(path.join(dir, "README"), "root\n");
  git(dir, ["add", "README"]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

test("T-098 names: branch agente/task e dir task-agente", () => {
  const n = namesFor("task_abc", "ag_BE");
  assert.equal(n.branch, "ag_be/task_abc");
  assert.equal(n.dirName, "task_abc-ag_be");
});

test("T-098 create: worktree+branch a partir de main", () => {
  const repo = fixtureRepo();
  const r = createTaskWorktree({ workspaceRoot: repo, taskId: "task_1", agentId: "ag_be" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(existsSync(path.join(r.path, "README")));
  assert.equal(git(r.path, ["branch", "--show-current"]), "ag_be/task_1");
  assert.equal(path.dirname(realpathSync(r.path)), realpathSync(siblingWtRoot(repo)));
  const listed = listLocalWorktrees(repo);
  assert.ok(listed.some((w) => w.path === r.path && w.branch === "ag_be/task_1"));
});

test("T-098 colisão: branch existe → erro, nada sobrescrito", () => {
  const repo = fixtureRepo();
  const a = createTaskWorktree({ workspaceRoot: repo, taskId: "task_1", agentId: "ag_be" });
  assert.equal(a.ok, true);
  const readme = a.ok ? path.join(a.path, "README") : "";
  writeFileSync(readme, "keep-me\n");
  const b = createTaskWorktree({ workspaceRoot: repo, taskId: "task_1", agentId: "ag_be" });
  assert.equal(b.ok, false);
  if (b.ok) return;
  assert.match(b.error, /colisão/);
  assert.equal(readFileSync(readme, "utf8"), "keep-me\n");
});

test("T-098 remove: mergeada (sem commits extra) remove worktree+branch", () => {
  const repo = fixtureRepo();
  const a = createTaskWorktree({ workspaceRoot: repo, taskId: "task_2", agentId: "ag_qa" });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  const rm = removeTaskWorktree({ workspaceRoot: repo, path: a.path, branch: a.branch });
  assert.equal(rm.ok, true, rm.ok ? "" : rm.error);
  assert.equal(existsSync(a.path), false);
  const branches = git(repo, ["branch", "--list", "ag_qa/task_2"]);
  assert.equal(branches, "");
});

test("T-098 remove: NÃO-mergeada recusa e lista commits; force remove", () => {
  const repo = fixtureRepo();
  const a = createTaskWorktree({ workspaceRoot: repo, taskId: "task_3", agentId: "ag_fe" });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  writeFileSync(path.join(a.path, "feat.txt"), "x\n");
  git(a.path, ["add", "feat.txt"]);
  git(a.path, ["commit", "-m", "feat pendente"]);
  const deny = removeTaskWorktree({ workspaceRoot: repo, path: a.path, branch: a.branch });
  assert.equal(deny.ok, false);
  if (deny.ok) return;
  assert.match(deny.error, /não mergeada/);
  assert.ok((deny.pendingCommits ?? []).some((c) => /feat pendente/.test(c)));
  assert.equal(existsSync(a.path), true);
  const forced = removeTaskWorktree({ workspaceRoot: repo, path: a.path, branch: a.branch, force: true });
  assert.equal(forced.ok, true, forced.ok ? "" : forced.error);
  assert.equal(existsSync(a.path), false);
});

test("T-098 list devolve worktrees locais", () => {
  const repo = fixtureRepo();
  createTaskWorktree({ workspaceRoot: repo, taskId: "task_l", agentId: "ag_x" });
  const list = listLocalWorktrees(repo);
  assert.ok(list.length >= 2); // main + nova
  assert.ok(list.some((w) => w.branch === "ag_x/task_l"));
  rmSync(siblingWtRoot(repo), { recursive: true, force: true });
});
