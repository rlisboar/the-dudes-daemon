/**
 * T-448 (M25): worktree por agente é removido em stop/shutdown (antes
 * acumulava em <repo>/../worktrees para sempre).
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGitWorktreeAdd, runGitWorktreeRemove, AgentHost } from "../agent-host.js";

function makeRepo(): { repo: string; wtBase: string } {
  const base = mkdtempSync(path.join(os.tmpdir(), "t448-"));
  const repo = path.join(base, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(path.join(repo, "a.txt"), "a");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { repo, wtBase: path.join(base, "worktrees") };
}

test("T-448: runGitWorktreeRemove limpa disco e metadata (.git/worktrees)", async () => {
  const { repo, wtBase } = makeRepo();
  mkdirSync(wtBase, { recursive: true });
  const wt = path.join(wtBase, "ag1");
  const added = await runGitWorktreeAdd(repo, "agent/ag1-abc12345", wt);
  assert.equal(added.status, 0, added.stderr);
  assert.ok(existsSync(path.join(wt, "a.txt")));
  assert.ok(existsSync(path.join(repo, ".git", "worktrees")));

  const out = await runGitWorktreeRemove(repo, wt);
  assert.equal(out.ok, true, out.detail);
  assert.equal(existsSync(wt), false, "diretório do worktree removido");
  const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" });
  assert.equal(list.includes(wt), false, "metadata do worktree limpa");
  // branch preservada (commits do agente não se perdem na remoção)
  const branches = execFileSync("git", ["branch", "--list"], { cwd: repo, encoding: "utf8" });
  assert.match(branches, /agent\/ag1-abc12345/);
});

test("T-448: remove de worktree já apagado cai no fallback rm+prune (não trava)", async () => {
  const { repo, wtBase } = makeRepo();
  mkdirSync(wtBase, { recursive: true });
  const wt = path.join(wtBase, "ag2");
  await runGitWorktreeAdd(repo, "agent/ag2-x", wt);
  execFileSync("rm", ["-rf", wt]);
  const out = await runGitWorktreeRemove(repo, wt);
  // Dir ausente: o git resolve (remove --force aceita) e/ou o fallback limpa —
  // o contrato é não travar e não deixar sujeira.
  assert.equal(out.ok, true, out.detail);
  assert.equal(existsSync(wt), false);
});

test("T-543: git remove falhando com dir presente → fallback limpa e prune", async () => {
  const { repo, wtBase } = makeRepo();
  mkdirSync(wtBase, { recursive: true });
  const wt = path.join(wtBase, "ag3");
  await runGitWorktreeAdd(repo, "agent/ag3-y", wt);
  assert.ok(existsSync(path.join(wt, "a.txt")));
  // Quebra a metadata do git pro worktree (rm do dir .git/worktrees/<slug>):
  // `git worktree remove` falha, mas o diretório continua no disco — é o
  // cenário do fallback (rmSync + prune), que TEM de limpar e não travar.
  const metaDir = path.join(repo, ".git", "worktrees");
  for (const d of readdirSync(metaDir)) {
    execFileSync("rm", ["-rf", path.join(metaDir, d)]);
  }
  const out = await runGitWorktreeRemove(repo, wt);
  assert.equal(out.ok, true, out.detail);
  assert.equal(existsSync(wt), false, "dir removido pelo fallback");
  const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" });
  assert.equal(list.includes(wt), false, "prune limpou a metadata");
});

test("T-448 wiring: stop e shutdown removem o worktree do entry", () => {
  const src = readFileSync(new URL("../agent-host.ts", import.meta.url), "utf8");
  assert.match(src, /worktreePath\?: string;/);
  assert.match(src, /gitRoot\?: string;/);
  assert.match(src, /agentWorktree = \{ path: worktreePath, gitRoot \};/);
  assert.match(src, /\.\.\.\(agentWorktree \? \{ worktreePath: agentWorktree\.path, gitRoot: agentWorktree\.gitRoot \} : \{\}\)/);
  const stopIdx = src.indexOf("  stop(agentId: string) {");
  assert.match(src.slice(stopIdx, stopIdx + 300), /void this\.removeWorktreeOf\(e\)/);
  // T-710b: shutdown ganhou opts.reexec e devolve a contagem de runners.
  const shutdownIdx = src.indexOf("  async shutdown(opts: { reexec?: boolean } = {}): Promise<number> {");
  assert.ok(shutdownIdx > 0, "shutdown async");
  assert.match(src.slice(shutdownIdx, shutdownIdx + 600), /removals\.push\(this\.removeWorktreeOf\(e\)\)/);
  const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  assert.match(main, /await this\.host\.shutdown\(\{ reexec: !!opts\.keepRunning \}\)/);
});

test("T-448: AgentHost.shutdown existe e é async", async () => {
  const host = new AgentHost(() => {}, null, null, { } as never, false, false, false, () => {}, () => {});
  await host.shutdown();
});
