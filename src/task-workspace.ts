/**
 * T-098: worktree+branch por task. Git ops locais, fail-closed em colisão.
 * Server persiste o vínculo; este módulo só mexe no disco.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export type WorkspaceOpOk = {
  ok: true;
  path: string;
  branch: string;
  repoRoot: string;
};

export type WorkspaceOpErr = {
  ok: false;
  error: string;
  pendingCommits?: string[];
  path?: string;
  branch?: string;
};

export type WorkspaceOpResult = WorkspaceOpOk | WorkspaceOpErr;

function git(repo: string, args: string[]): { ok: boolean; stdout: string; stderr: string; status: number } {
  const res = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
  });
  return {
    ok: (res.status ?? 1) === 0,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
    status: res.status ?? 1,
  };
}

export function slug(s: string): string {
  const v = String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return v || "x";
}

export function namesFor(taskId: string, agentId: string): { branch: string; dirName: string } {
  const t = slug(taskId);
  const a = slug(agentId);
  return { branch: `${a}/${t}`, dirName: `${t}-${a}` };
}

export function findRepoRoot(workspaceRoot: string): string | null {
  if (!existsSync(workspaceRoot)) return null;
  const r = git(workspaceRoot, ["rev-parse", "--show-toplevel"]);
  return r.ok && r.stdout ? path.resolve(r.stdout) : null;
}

export function siblingWtRoot(repoRoot: string): string {
  const abs = path.resolve(repoRoot);
  return path.join(path.dirname(abs), `${path.basename(abs)}-wt`);
}

export function resolveMainRef(repoRoot: string): string {
  for (const ref of ["refs/heads/main", "refs/remotes/origin/main", "refs/heads/master"]) {
    if (git(repoRoot, ["show-ref", "--verify", "--quiet", ref]).ok) {
      return ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
    }
  }
  return "HEAD";
}

function branchExists(repoRoot: string, branch: string): boolean {
  return git(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

function worktreeListed(repoRoot: string, wtPath: string): boolean {
  const r = git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!r.ok) return false;
  const abs = path.resolve(wtPath);
  return r.stdout.split("\n").some((line) => {
    if (!line.startsWith("worktree ")) return false;
    return path.resolve(line.slice("worktree ".length)) === abs;
  });
}

export function createTaskWorktree(input: {
  workspaceRoot: string;
  taskId: string;
  agentId: string;
}): WorkspaceOpResult {
  const repoRoot = findRepoRoot(input.workspaceRoot);
  if (!repoRoot) return { ok: false, error: "repo git não encontrado no workspace" };
  const { branch, dirName } = namesFor(input.taskId, input.agentId);
  const wtPath = path.join(siblingWtRoot(repoRoot), dirName);
  if (branchExists(repoRoot, branch)) {
    return { ok: false, error: `colisão: branch '${branch}' já existe`, branch, path: wtPath };
  }
  if (existsSync(wtPath) || worktreeListed(repoRoot, wtPath)) {
    return { ok: false, error: `colisão: worktree '${wtPath}' já existe`, branch, path: wtPath };
  }
  mkdirSync(path.dirname(wtPath), { recursive: true });
  const main = resolveMainRef(repoRoot);
  const add = git(repoRoot, ["worktree", "add", "-b", branch, wtPath, main]);
  if (!add.ok) {
    return { ok: false, error: add.stderr || "git worktree add falhou", branch, path: wtPath };
  }
  return { ok: true, path: wtPath, branch, repoRoot };
}

export function pendingCommits(repoRoot: string, branch: string, mainRef: string): string[] {
  const r = git(repoRoot, ["log", "--format=%h %s", `${mainRef}..${branch}`]);
  if (!r.ok || !r.stdout) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

export function isMergedIntoMain(repoRoot: string, branch: string, mainRef: string): boolean {
  return git(repoRoot, ["merge-base", "--is-ancestor", branch, mainRef]).ok;
}

export function removeTaskWorktree(input: {
  workspaceRoot: string;
  path: string;
  branch: string;
  force?: boolean;
}): WorkspaceOpResult {
  const repoRoot = findRepoRoot(input.workspaceRoot);
  if (!repoRoot) return { ok: false, error: "repo git não encontrado no workspace" };
  const main = resolveMainRef(repoRoot);
  const commits = pendingCommits(repoRoot, input.branch, main);
  const merged = isMergedIntoMain(repoRoot, input.branch, main);
  if (!input.force && !merged && commits.length > 0) {
    return {
      ok: false,
      error: `worktree não mergeada (${commits.length} commit(s) pendente(s)) — passe force para remover`,
      pendingCommits: commits,
      path: input.path,
      branch: input.branch,
    };
  }
  const rmArgs = input.force
    ? ["worktree", "remove", "--force", input.path]
    : ["worktree", "remove", input.path];
  const rm = git(repoRoot, rmArgs);
  if (!rm.ok && existsSync(input.path)) {
    return { ok: false, error: rm.stderr || "git worktree remove falhou", path: input.path, branch: input.branch };
  }
  const brArgs = input.force ? ["branch", "-D", input.branch] : ["branch", "-d", input.branch];
  git(repoRoot, brArgs);
  return { ok: true, path: input.path, branch: input.branch, repoRoot };
}

export function listLocalWorktrees(workspaceRoot: string): Array<{ path: string; branch: string | null }> {
  const repoRoot = findRepoRoot(workspaceRoot);
  if (!repoRoot) return [];
  const r = git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!r.ok) return [];
  const out: Array<{ path: string; branch: string | null }> = [];
  let cur: { path?: string; branch: string | null } = { branch: null };
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) cur.path = line.slice("worktree ".length);
    else if (line.startsWith("branch ")) cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    else if (line === "" && cur.path) {
      out.push({ path: cur.path, branch: cur.branch });
      cur = { branch: null };
    }
  }
  if (cur.path) out.push({ path: cur.path, branch: cur.branch });
  return out;
}
