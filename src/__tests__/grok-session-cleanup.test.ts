/**
 * T-051: limpeza seletiva de ~/.grok/sessions/the-dudes-cli-*.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  utimesSync,
  existsSync,
  rmSync,
  readdirSync,
  statSync as fsStatSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanGrokTempSessions,
  DEFAULT_GROK_SESSION_TTL_MS,
  dirByteSize,
  formatCleanupSummary,
  isPathInsideSessionsRoot,
  isTheDudesCliSessionDir,
  resolveGrokSessionRoots,
  scheduleGrokSessionCleanup,
  type GrokSessionCleanupFs,
  type GrokSessionCleanupResult,
} from "../grok-session-cleanup.js";

function enc(cwd: string): string {
  return encodeURIComponent(cwd);
}

test("isTheDudesCliSessionDir: componente the-dudes-cli-*", () => {
  assert.equal(
    isTheDudesCliSessionDir(enc("/private/var/folders/xx/T/the-dudes-cli-abc123")),
    true,
  );
  assert.equal(
    isTheDudesCliSessionDir(enc("/var/folders/xx/T/the-dudes-cli-xyz")),
    true,
  );
  // path real do campo (componente intermediário the-dudes? basename the-dudes-cli)
  assert.equal(
    isTheDudesCliSessionDir(
      enc("/private/var/folders/5y/xxx/T/the-dudes-cli-0DcwwF"),
    ),
    true,
  );
  // outros prefixes de tmp — NUNCA
  assert.equal(
    isTheDudesCliSessionDir(enc("/private/var/folders/xx/T/alertai-ia-MnX9li")),
    false,
  );
  // sessão de projeto real
  assert.equal(
    isTheDudesCliSessionDir(enc("/Users/lisboa/Documents/eonf/projects/claudinhos")),
    false,
  );
  // componente engana: "the-dudes-cli-notes" é prefixo+resto sem random típico —
  // ainda matches startsWith+length; mas path de projeto com isso no meio:
  // se o basename for "repo", não casa. Se o componente for the-dudes-cli-notes:
  assert.equal(
    isTheDudesCliSessionDir(enc("/Users/x/docs/the-dudes-cli-notes/repo")),
    true, // componente the-dudes-cli-notes — contém o prefixo do mkdtemp
  );
  // prefixo exato sem sufixo aleatório
  assert.equal(isTheDudesCliSessionDir(enc("/tmp/the-dudes-cli-")), false);
});

test("nome não decodificável / entrada estranha → ignorada sem crash", () => {
  assert.equal(isTheDudesCliSessionDir("%E0%A4%A"), false);
  assert.equal(isTheDudesCliSessionDir("%"), false);
  assert.equal(isTheDudesCliSessionDir(""), false);
  assert.equal(isTheDudesCliSessionDir("not%2Fencoded%ZZ"), false);

  const root = "/home/u/.grok/sessions";
  const r = cleanGrokTempSessions({
    roots: [root],
    skipDryRunLog: true,
    fs: {
      readdirSync: () => ["%E0%A4%A", "%%%", "ok"],
      statSync: () => {
        throw new Error("não deve stat entradas inválidas se isTheDudes false");
      },
      rmSync: () => {
        throw new Error("não deve rm");
      },
    },
  });
  // "ok" sem the-dudes-cli → kept; inválidos → kept; zero crash
  assert.equal(r.errors, 0);
  assert.equal(r.removed, 0);
  assert.equal(r.scanned, 3);
  assert.equal(r.kept, 3);
});

test("resolveGrokSessionRoots: dedup home + dropTo + GROK_HOME", () => {
  const roots = resolveGrokSessionRoots({
    home: "/Users/me",
    dropToHome: "/Users/me",
    grokHomeEnv: null,
  });
  assert.deepEqual(roots, ["/Users/me/.grok/sessions", "/Users/me/.grok-custom/sessions"]);

  const withDrop = resolveGrokSessionRoots({
    home: "/root",
    dropToHome: "/Users/me",
    grokHomeEnv: "/opt/grok-home",
  });
  assert.ok(withDrop.includes("/root/.grok/sessions"));
  assert.ok(withDrop.includes("/root/.grok-custom/sessions"));
  assert.ok(withDrop.includes("/Users/me/.grok/sessions"));
  assert.ok(withDrop.includes("/Users/me/.grok-custom/sessions"));
  assert.ok(withDrop.includes("/opt/grok-home/sessions"));
  assert.equal(withDrop.length, 5);
});

test("isPathInsideSessionsRoot: só sob o root", () => {
  const root = "/Users/me/.grok/sessions";
  assert.equal(isPathInsideSessionsRoot(`${root}/foo`, root), true);
  assert.equal(isPathInsideSessionsRoot(root, root), false);
  assert.equal(isPathInsideSessionsRoot("/Users/me/.grok/other", root), false);
  assert.equal(isPathInsideSessionsRoot("/etc/passwd", root), false);
});

function memFs(dirs: Record<string, { mtimeMs: number; isDir?: boolean; size?: number; children?: string[] }>): {
  fs: GrokSessionCleanupFs;
  removed: string[];
} {
  const removed: string[] = [];
  const rootEntries = new Map<string, string[]>();
  for (const full of Object.keys(dirs)) {
    const parent = full.slice(0, full.lastIndexOf("/"));
    const name = full.slice(full.lastIndexOf("/") + 1);
    const list = rootEntries.get(parent) ?? [];
    list.push(name);
    rootEntries.set(parent, list);
    if (dirs[full]!.children) {
      rootEntries.set(full, [...dirs[full]!.children!]);
    }
  }
  const fs: GrokSessionCleanupFs = {
    readdirSync: (dir) => {
      const list = rootEntries.get(dir);
      if (!list) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return [...list];
    },
    statSync: (p) => {
      const st = dirs[p];
      if (!st) {
        // arquivos filhos sintéticos
        return { isDirectory: () => false, mtimeMs: 0, size: 100 };
      }
      return {
        isDirectory: () => st.isDir !== false,
        mtimeMs: st.mtimeMs,
        size: st.size ?? 0,
      };
    },
    rmSync: (p) => {
      removed.push(p);
      delete dirs[p];
      const parent = p.slice(0, p.lastIndexOf("/"));
      const name = p.slice(p.lastIndexOf("/") + 1);
      const list = rootEntries.get(parent);
      if (list) rootEntries.set(parent, list.filter((n) => n !== name));
    },
  };
  return { fs, removed };
}

test("cleanGrokTempSessions: remove só the-dudes-cli-* com mtime > TTL", () => {
  const root = "/home/u/.grok/sessions";
  const now = 1_000_000_000_000;
  const ttl = DEFAULT_GROK_SESSION_TTL_MS;
  const old = now - ttl - 1;
  const fresh = now - 60_000;

  const cliOld = enc("/tmp/the-dudes-cli-oldAAA");
  const cliFresh = enc("/tmp/the-dudes-cli-freshBB");
  const project = enc("/Users/u/projects/claudinhos");
  const alertai = enc("/tmp/alertai-ia-xyz");

  const { fs, removed } = memFs({
    [`${root}/${cliOld}`]: { mtimeMs: old, children: ["a.json"] },
    [`${root}/${cliFresh}`]: { mtimeMs: fresh },
    [`${root}/${project}`]: { mtimeMs: old },
    [`${root}/${alertai}`]: { mtimeMs: old },
  });

  const logs: string[] = [];
  const r = cleanGrokTempSessions({
    roots: [root],
    nowMs: now,
    ttlMs: ttl,
    fs,
    log: (_l, m) => logs.push(m),
  });

  assert.equal(r.removed, 1);
  assert.equal(r.scanned, 4);
  assert.equal(r.kept, 3);
  assert.equal(r.errors, 0);
  assert.ok(r.bytesFreed >= 100);
  assert.deepEqual(removed, [`${root}/${cliOld}`]);
  // dry-run logado antes do apply + resumo final
  assert.ok(logs.some((l) => l.includes("dry-run") && l.includes("candidates=1")));
  assert.ok(logs.some((l) => l.includes("[apply]") && l.includes("removed=1")));
});

test("dry-run: lista candidatos sem rm", () => {
  const root = "/home/u/.grok/sessions";
  const now = Date.now();
  const name = enc("/tmp/the-dudes-cli-dry");
  const { fs, removed } = memFs({
    [`${root}/${name}`]: {
      mtimeMs: now - DEFAULT_GROK_SESSION_TTL_MS - 1,
      children: ["x"],
    },
  });
  const logs: string[] = [];
  const r = cleanGrokTempSessions({
    roots: [root],
    nowMs: now,
    dryRun: true,
    fs,
    log: (_l, m) => logs.push(m),
  });
  assert.equal(r.dryRun, true);
  assert.equal(r.removed, 1);
  assert.equal(removed.length, 0);
  assert.ok(logs.some((l) => l.includes("dry-run")));
  assert.ok(formatCleanupSummary(r).includes("dry-run"));
});

test("cleanGrokTempSessions: root ausente não explode", () => {
  const r = cleanGrokTempSessions({
    roots: ["/no/such/sessions"],
    skipDryRunLog: true,
    fs: {
      readdirSync: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      statSync: () => {
        throw new Error("should not");
      },
      rmSync: () => {
        throw new Error("should not");
      },
    },
  });
  assert.equal(r.scanned, 0);
  assert.equal(r.removed, 0);
});

test("rm falha isolada não derruba (errors++, continua)", () => {
  const root = "/h/.grok/sessions";
  const now = Date.now();
  const a = enc("/tmp/the-dudes-cli-a");
  const b = enc("/tmp/the-dudes-cli-b");
  const { fs } = memFs({
    [`${root}/${a}`]: { mtimeMs: now - DEFAULT_GROK_SESSION_TTL_MS - 1 },
    [`${root}/${b}`]: { mtimeMs: now - DEFAULT_GROK_SESSION_TTL_MS - 1 },
  });
  let calls = 0;
  const wrapped: GrokSessionCleanupFs = {
    ...fs,
    rmSync: (p, opts) => {
      calls += 1;
      if (calls === 1) throw new Error("EACCES");
      fs.rmSync(p, opts);
    },
  };
  const r = cleanGrokTempSessions({
    roots: [root],
    nowMs: now,
    skipDryRunLog: true,
    fs: wrapped,
  });
  assert.equal(r.errors, 1);
  assert.equal(r.removed, 1);
});

test("fixture real no disco: old removido, fresh+projeto intactos", () => {
  const base = path.join(os.tmpdir(), `td-grok-sess-test-${process.pid}-${Date.now()}`);
  const sessions = path.join(base, ".grok", "sessions");
  mkdirSync(sessions, { recursive: true });

  const oldName = enc(path.join(os.tmpdir(), "the-dudes-cli-oldFix"));
  const freshName = enc(path.join(os.tmpdir(), "the-dudes-cli-freshFix"));
  const projectName = enc("/Users/lisboa/Documents/eonf/projects/claudinhos");

  const oldDir = path.join(sessions, oldName);
  const freshDir = path.join(sessions, freshName);
  const projectDir = path.join(sessions, projectName);

  mkdirSync(oldDir, { recursive: true });
  mkdirSync(freshDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(oldDir, "chat.json"), "x".repeat(2048));
  writeFileSync(path.join(freshDir, "chat.json"), "fresh");
  writeFileSync(path.join(projectDir, "chat.json"), "project-session");

  const now = Date.now() / 1000;
  const oldSec = now - (DEFAULT_GROK_SESSION_TTL_MS / 1000) - 10;
  utimesSync(oldDir, oldSec, oldSec);
  utimesSync(projectDir, oldSec, oldSec); // mtime antigo mas projeto → INTOCADO

  const logs: string[] = [];
  try {
    // dry-run primeiro (evidência)
    const dry = cleanGrokTempSessions({
      roots: [sessions],
      dryRun: true,
      log: (_l, m) => logs.push(m),
    });
    assert.equal(dry.removed, 1);
    assert.ok(dry.bytesFreed >= 2048);
    assert.ok(existsSync(oldDir), "dry-run não remove");

    const apply = cleanGrokTempSessions({
      roots: [sessions],
      log: (_l, m) => logs.push(m),
    });
    assert.equal(apply.removed, 1);
    assert.ok(apply.bytesFreed >= 2048);
    assert.equal(existsSync(oldDir), false);
    assert.equal(existsSync(freshDir), true, "fresh dentro do TTL");
    assert.equal(existsSync(projectDir), true, "projeto real INTOCADO");
    assert.ok(logs.some((l) => /removed=\d+ kept=\d+ bytesFreed=\d+/.test(l)));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("scheduleGrokSessionCleanup: boot chama run + stop limpa timer", () => {
  let calls = 0;
  const empty: GrokSessionCleanupResult = {
    scanned: 0,
    removed: 0,
    kept: 0,
    errors: 0,
    bytesFreed: 0,
    candidates: [],
    roots: [],
    dryRun: false,
  };
  const sched = scheduleGrokSessionCleanup({
    intervalMs: 60_000,
    run: () => {
      calls += 1;
      return empty;
    },
  });
  assert.equal(calls, 1);
  sched.runNow();
  assert.equal(calls, 2);
  sched.stop();
});

test("dirByteSize soma arquivos", () => {
  const base = path.join(os.tmpdir(), `td-bytes-${process.pid}-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  writeFileSync(path.join(base, "a"), "12345");
  try {
    const realFs: GrokSessionCleanupFs = {
      readdirSync: (d) => readdirSync(d),
      statSync: (p) => {
        const s = fsStatSync(p);
        return { isDirectory: () => s.isDirectory(), mtimeMs: s.mtimeMs, size: s.size };
      },
      rmSync: () => {},
    };
    assert.equal(dirByteSize(base, realFs), 5);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
