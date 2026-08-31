/**
 * T-051: limpeza seletiva de ~/.grok/sessions/the-dudes-cli-*.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanGrokTempSessions,
  DEFAULT_GROK_SESSION_TTL_MS,
  isTheDudesCliSessionDir,
  resolveGrokSessionRoots,
  scheduleGrokSessionCleanup,
  type GrokSessionCleanupFs,
} from "../grok-session-cleanup.js";

function enc(cwd: string): string {
  return encodeURIComponent(cwd);
}

test("isTheDudesCliSessionDir: só basename the-dudes-cli-*", () => {
  assert.equal(
    isTheDudesCliSessionDir(enc("/private/var/folders/xx/T/the-dudes-cli-abc123")),
    true,
  );
  assert.equal(
    isTheDudesCliSessionDir(enc("/var/folders/xx/T/the-dudes-cli-xyz")),
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
  // basename engana no meio do path, não no final
  assert.equal(
    isTheDudesCliSessionDir(enc("/Users/x/docs/the-dudes-cli-notes/repo")),
    false,
  );
  // prefixo exato sem sufixo aleatório
  assert.equal(isTheDudesCliSessionDir(enc("/tmp/the-dudes-cli-")), false);
  // lixo de encode
  assert.equal(isTheDudesCliSessionDir("%E0%A4%A"), false);
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

function memFs(dirs: Record<string, { mtimeMs: number; isDir?: boolean }>): {
  fs: GrokSessionCleanupFs;
  removed: string[];
  rootEntries: Map<string, string[]>;
} {
  const removed: string[] = [];
  const rootEntries = new Map<string, string[]>();
  for (const full of Object.keys(dirs)) {
    const parent = full.slice(0, full.lastIndexOf("/"));
    const name = full.slice(full.lastIndexOf("/") + 1);
    const list = rootEntries.get(parent) ?? [];
    list.push(name);
    rootEntries.set(parent, list);
  }
  const fs: GrokSessionCleanupFs = {
    readdirSync: (dir) => {
      const list = rootEntries.get(dir);
      if (!list) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return [...list];
    },
    statSync: (p) => {
      const st = dirs[p];
      if (!st) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return {
        isDirectory: () => st.isDir !== false,
        mtimeMs: st.mtimeMs,
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
  return { fs, removed, rootEntries };
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
    [`${root}/${cliOld}`]: { mtimeMs: old },
    [`${root}/${cliFresh}`]: { mtimeMs: fresh },
    [`${root}/${project}`]: { mtimeMs: old },
    [`${root}/${alertai}`]: { mtimeMs: old },
  });

  const r = cleanGrokTempSessions({
    roots: [root],
    nowMs: now,
    ttlMs: ttl,
    fs,
  });

  assert.equal(r.removed, 1);
  assert.equal(r.scanned, 4);
  assert.equal(r.skipped, 3);
  assert.equal(r.errors, 0);
  assert.deepEqual(removed, [`${root}/${cliOld}`]);
});

test("cleanGrokTempSessions: root ausente não explode", () => {
  const r = cleanGrokTempSessions({
    roots: ["/no/such/sessions"],
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

test("cleanGrokTempSessions: 5 sweeps não re-remove (idempotente)", () => {
  const root = "/h/.grok/sessions";
  const now = Date.now();
  const name = enc("/tmp/the-dudes-cli-once");
  const { fs, removed } = memFs({
    [`${root}/${name}`]: { mtimeMs: now - DEFAULT_GROK_SESSION_TTL_MS - 10 },
  });
  for (let i = 0; i < 5; i++) {
    cleanGrokTempSessions({ roots: [root], nowMs: now, fs });
  }
  assert.equal(removed.length, 1);
});

test("scheduleGrokSessionCleanup: boot chama run + stop limpa timer", () => {
  let calls = 0;
  const sched = scheduleGrokSessionCleanup({
    intervalMs: 60_000,
    run: () => {
      calls += 1;
      return { scanned: 0, removed: 0, skipped: 0, errors: 0, roots: [] };
    },
  });
  assert.equal(calls, 1);
  sched.runNow();
  assert.equal(calls, 2);
  sched.stop();
});
