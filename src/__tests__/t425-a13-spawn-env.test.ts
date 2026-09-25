/**
 * T-425 (A13): graphify e git worktree add do agent-host NÃO herdam
 * process.env inteiro nem correm sem drop.
 *
 * Evidência:
 *  1. graph-indexer: fake graphify imprime o próprio env (o graphify é o NETO
 *     do daemon — spawna o claude/CLI por baixo) → token/encryption key fora;
 *  2. agent-host: `runGitWorktreeAdd` via fake git no PATH que dumpa env e
 *     delega pro git real → idem, e o worktree é criado de fato;
 *  3. wiring: ambos usam spawnDropped + buildSummarizerEnv.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildGraph } from "../graph-indexer.js";
import { runGitWorktreeAdd } from "../agent-host.js";

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status !== 0) throw new Error(r.stderr || `git ${args.join(" ")} -> ${r.status}`);
  return r.stdout.trim();
}

const SEGREDOS = {
  THE_DUDES_DAEMON_TOKEN: "dtok-t425",
  THE_DUDES_ENCRYPTION_KEY: "ek-t425",
  ANTHROPIC_API_KEY: ["sk", "-ant-t425"].join(""),
  DATABASE_URL: "postgres://u:p@h/db",
} as const;

function comSegredos<T>(fn: () => Promise<T>): Promise<T> {
  const antes: Record<string, string | undefined> = {};
  for (const k of Object.keys(SEGREDOS)) {
    antes[k] = process.env[k];
    process.env[k] = SEGREDOS[k as keyof typeof SEGREDOS];
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function assertSemSegredos(env: string, onde: string) {
  for (const k of Object.keys(SEGREDOS)) {
    assert.doesNotMatch(env, new RegExp(`^${k}=`, "m"), `${k} vazou no env do ${onde}`);
  }
  assert.match(env, /^PATH=/m, `PATH mínimo ausente no env do ${onde}`);
}

test("T-425 graphify: env do neto não leva token/key do daemon", async () => {
  await comSegredos(async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "t425-graph-")));
    const dump = path.join(dir, "env.txt");
    const bin = path.join(dir, "fake-graphify");
    writeFileSync(bin, `#!/bin/sh\nenv > "${dump}"\necho "Rebuilt: 0 nodes, 0 edges"\nexit 0\n`);
    chmodSync(bin, 0o755);

    const r = await buildGraph(dir, bin, {});
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.ok(existsSync(dump), "fake graphify não rodou");
    assertSemSegredos(readFileSync(dump, "utf8"), "graphify");
  });
});

test("T-425 graphify: passthrough opt-in continua chegando", async () => {
  const prevPass = process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH;
  const prevTz = process.env.TZ;
  process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH = "TZ";
  process.env.TZ = "UTC";
  try {
    await comSegredos(async () => {
      const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "t425-graph-pass-")));
      const dump = path.join(dir, "env.txt");
      const bin = path.join(dir, "fake-graphify");
      writeFileSync(bin, `#!/bin/sh\nenv > "${dump}"\necho "Rebuilt: 0 nodes, 0 edges"\nexit 0\n`);
      chmodSync(bin, 0o755);
      const r = await buildGraph(dir, bin, {});
      assert.equal(r.ok, true, r.ok ? "" : r.error);
      const env = readFileSync(dump, "utf8");
      assert.match(env, /^TZ=UTC$/m, "passthrough TZ deveria chegar ao graphify");
      assertSemSegredos(env, "graphify (passthrough)");
    });
  } finally {
    if (prevPass === undefined) delete process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH;
    else process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH = prevPass;
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  }
});

test("T-425 agent-host: git worktree add com env por allowlist e worktree criado", async () => {
  await comSegredos(async () => {
    const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "t425-wt-")));
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "t425@test"]);
    git(repo, ["config", "user.name", "T425"]);
    writeFileSync(path.join(repo, "README"), "root\n");
    git(repo, ["add", "README"]);
    git(repo, ["commit", "-m", "init"]);

    // Fake git no PATH: dumpa o env (o que o hook/config do repo veria) e
    // delega pro git real (PATH do shim continua valendo pro exec? não —
    // usamos o caminho absoluto do git real).
    const realGit = (spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout ?? "").trim();
    assert.ok(realGit, "git real não encontrado");
    const shimDir = mkdtempSync(path.join(tmpdir(), "t425-shim-"));
    const dump = path.join(shimDir, "env.txt");
    const shim = path.join(shimDir, "git");
    writeFileSync(shim, `#!/bin/sh\nenv > "${dump}"\nexec "${realGit}" "$@"\n`);
    chmodSync(shim, 0o755);
    const prevPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${prevPath ?? ""}`;
    try {
      const wt = path.join(tmpdir(), `t425-wt-out-${process.pid}`);
      const res = await runGitWorktreeAdd(repo, "agent/t425", wt, null);
      assert.equal(res.status, 0, res.stderr);
      assert.ok(existsSync(dump), "shim do git não rodou");
      assertSemSegredos(readFileSync(dump, "utf8"), "git worktree add");
      assert.ok(existsSync(path.join(wt, "README")), "worktree não foi criado");
      git(repo, ["worktree", "remove", "--force", "--", wt]);
      git(repo, ["branch", "-D", "--", "agent/t425"]);
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });
});

test("T-425 wiring: graph-indexer e agent-host usam spawnDropped + buildSummarizerEnv", () => {
  const gia = readFileSync(new URL("../graph-indexer.ts", import.meta.url), "utf8");
  assert.match(gia, /spawnDropped\(/);
  assert.match(gia, /buildSummarizerEnv\(process\.env\)/);
  assert.doesNotMatch(gia, /env: \{ \.\.\.process\.env \}/);
  assert.doesNotMatch(gia, /spawn\(graphifyBin/);
  const ah = readFileSync(new URL("../agent-host.ts", import.meta.url), "utf8");
  assert.match(ah, /export function runGitWorktreeAdd/);
  assert.match(ah, /runGit\(/); // R8 (T-463): worktree add/remove via helper central
  assert.match(readFileSync(new URL("../runners/run-git.ts", import.meta.url), "utf8"), /spawnDropped\(\s*"git"/);
  assert.match(readFileSync(new URL("../runners/run-git.ts", import.meta.url), "utf8"), /gitMinimalEnv\(/); // R8: env mínimo no helper
  assert.doesNotMatch(ah, /spawnSync\(/);
});
