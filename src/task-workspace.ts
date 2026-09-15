/**
 * T-098: worktree+branch por task. Git ops locais, fail-closed em colisão.
 * Server persiste o vínculo; este módulo só mexe no disco.
 *
 * T-424 (A12): toda invocação de git passa por `spawnDropped` + env mínimo
 * (`gitMinimalEnv`) — repo malicioso com hook não vê o process.env inteiro —
 * e branch/paths são re-validados (`validateGitRef`/`isInsideRoot`) com `--`
 * antes de refs/paths.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnDropped, type DropTarget } from "./privileges.js";
import { gitMinimalEnv, isInsideRoot, validateBasePath, validateGitRef } from "./workspace.js";

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

async function git(
  repo: string,
  args: string[],
  drop: DropTarget | null = null,
): Promise<{ ok: boolean; stdout: string; stderr: string; status: number }> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawnDropped(
        "git",
        args,
        { cwd: repo, env: gitMinimalEnv(drop), stdio: ["ignore", "pipe", "pipe"] },
        drop,
      );
    } catch (e) {
      resolve({ ok: false, stdout: "", stderr: (e as Error).message, status: 1 });
      return;
    }
    let stdout = "";
    let stderr = "";
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (c: string) => { stdout += c; });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (c: string) => { stderr += c; });
    proc.on("close", (code) => {
      const status = code ?? 1;
      resolve({ ok: status === 0, stdout: stdout.trim(), stderr: stderr.trim(), status });
    });
    proc.on("error", (e) => resolve({ ok: false, stdout: "", stderr: e.message, status: 1 }));
  });
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

export async function findRepoRoot(workspaceRoot: string, drop: DropTarget | null = null): Promise<string | null> {
  if (!existsSync(workspaceRoot)) return null;
  const r = await git(workspaceRoot, ["rev-parse", "--show-toplevel"], drop);
  return r.ok && r.stdout ? path.resolve(r.stdout) : null;
}

export function siblingWtRoot(repoRoot: string): string {
  const abs = path.resolve(repoRoot);
  return path.join(path.dirname(abs), `${path.basename(abs)}-wt`);
}

async function resolveMainRef(repoRoot: string, drop: DropTarget | null = null): Promise<string> {
  for (const ref of ["refs/heads/main", "refs/remotes/origin/main", "refs/heads/master"]) {
    if ((await git(repoRoot, ["show-ref", "--verify", "--quiet", "--", ref], drop)).ok) {
      return ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
    }
  }
  return "HEAD";
}

async function branchExists(repoRoot: string, branch: string, drop: DropTarget | null = null): Promise<boolean> {
  return (await git(repoRoot, ["show-ref", "--verify", "--quiet", "--", `refs/heads/${branch}`], drop)).ok;
}

async function worktreeListed(repoRoot: string, wtPath: string, drop: DropTarget | null = null): Promise<boolean> {
  const r = await git(repoRoot, ["worktree", "list", "--porcelain"], drop);
  if (!r.ok) return false;
  const abs = path.resolve(wtPath);
  return r.stdout.split("\n").some((line) => {
    if (!line.startsWith("worktree ")) return false;
    return path.resolve(line.slice("worktree ".length)) === abs;
  });
}

export async function createTaskWorktree(input: {
  workspaceRoot: string;
  taskId: string;
  agentId: string;
}, drop: DropTarget | null = null): Promise<WorkspaceOpResult> {
  // T-424: base path do server não é confiável — rejeita relativo/proibido.
  let root: string;
  try {
    root = validateBasePath(input.workspaceRoot);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const repoRoot = await findRepoRoot(root, drop);
  if (!repoRoot) return { ok: false, error: "repo git não encontrado no workspace" };
  const { branch, dirName } = namesFor(input.taskId, input.agentId);
  try {
    validateGitRef(branch, "branch");
  } catch (e) {
    return { ok: false, error: (e as Error).message, branch };
  }
  const wtPath = path.join(siblingWtRoot(repoRoot), dirName);
  if (!isInsideRoot(wtPath, siblingWtRoot(repoRoot))) {
    return { ok: false, error: `worktree "${wtPath}" fora de ${siblingWtRoot(repoRoot)}`, branch, path: wtPath };
  }
  if (await branchExists(repoRoot, branch, drop)) {
    return { ok: false, error: `colisão: branch '${branch}' já existe`, branch, path: wtPath };
  }
  if (existsSync(wtPath) || (await worktreeListed(repoRoot, wtPath, drop))) {
    return { ok: false, error: `colisão: worktree '${wtPath}' já existe`, branch, path: wtPath };
  }
  mkdirSync(path.dirname(wtPath), { recursive: true });
  const main = await resolveMainRef(repoRoot, drop);
  // `--` antes do path: path/ref com cara de flag não vira opção do git.
  const add = await git(repoRoot, ["worktree", "add", "-b", branch, "--", wtPath, main], drop);
  if (!add.ok) {
    return { ok: false, error: add.stderr || "git worktree add falhou", branch, path: wtPath };
  }
  return { ok: true, path: wtPath, branch, repoRoot };
}

export async function pendingCommits(repoRoot: string, branch: string, mainRef: string, drop: DropTarget | null = null): Promise<string[]> {
  // Range de revisão vem ANTES do `--`: depois dele o git log trata o token
  // como pathspec (range vazio → nenhum commit pendente → remove frouxo).
  const r = await git(repoRoot, ["log", "--format=%h %s", `${mainRef}..${branch}`], drop);
  if (!r.ok || !r.stdout) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

export async function isMergedIntoMain(repoRoot: string, branch: string, mainRef: string, drop: DropTarget | null = null): Promise<boolean> {
  return (await git(repoRoot, ["merge-base", "--is-ancestor", "--", branch, mainRef], drop)).ok;
}

export async function removeTaskWorktree(input: {
  workspaceRoot: string;
  path: string;
  branch: string;
  force?: boolean;
}, drop: DropTarget | null = null): Promise<WorkspaceOpResult> {
  let root: string;
  try {
    root = validateBasePath(input.workspaceRoot);
    validateGitRef(input.branch, "branch");
  } catch (e) {
    return { ok: false, error: (e as Error).message, path: input.path, branch: input.branch };
  }
  const repoRoot = await findRepoRoot(root, drop);
  if (!repoRoot) return { ok: false, error: "repo git não encontrado no workspace" };
  const wtRoot = siblingWtRoot(repoRoot);
  // T-424: o server manda o path; um path fora de <repoRoot>-wt removia
  // worktree alheio (ou nada) em silêncio.
  if (!isInsideRoot(input.path, wtRoot)) {
    return { ok: false, error: `worktree "${input.path}" fora de ${wtRoot}`, path: input.path, branch: input.branch };
  }
  const main = await resolveMainRef(repoRoot, drop);
  const commits = await pendingCommits(repoRoot, input.branch, main, drop);
  const merged = await isMergedIntoMain(repoRoot, input.branch, main, drop);
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
    ? ["worktree", "remove", "--force", "--", input.path]
    : ["worktree", "remove", "--", input.path];
  const rm = await git(repoRoot, rmArgs, drop);
  if (!rm.ok && existsSync(input.path)) {
    return { ok: false, error: rm.stderr || "git worktree remove falhou", path: input.path, branch: input.branch };
  }
  const brArgs = input.force ? ["branch", "-D", "--", input.branch] : ["branch", "-d", "--", input.branch];
  await git(repoRoot, brArgs, drop);
  return { ok: true, path: input.path, branch: input.branch, repoRoot };
}

export async function listLocalWorktrees(workspaceRoot: string, drop: DropTarget | null = null): Promise<Array<{ path: string; branch: string | null }>> {
  const repoRoot = await findRepoRoot(workspaceRoot, drop);
  if (!repoRoot) return [];
  const r = await git(repoRoot, ["worktree", "list", "--porcelain"], drop);
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