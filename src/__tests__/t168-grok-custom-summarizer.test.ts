/**
 * T-168 — summarizer/reply-suggester grok-custom usa ~/.grok-custom
 * (home helper T-166, xhigh T-162, cleanup T-051).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { grokHomePath } from "../runners/runtime-files.js";
import { applyGrokFamilySummarizerEnv } from "../summarizer-runner.js";
import { normalizeGrokEffort } from "../runners/model-policy.js";
import { cleanGrokTempSessions, DEFAULT_GROK_SESSION_TTL_MS, resolveGrokSessionRoots } from "../grok-session-cleanup.js";
import { buildGrokEnv } from "../runners/env.js";
import type { GrokSessionCleanupFs } from "../grok-session-cleanup.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const SUM_SRC = readFileSync(join(AQUI, "../summarizer-runner.ts"), "utf8");
const MAIN_SRC = readFileSync(join(AQUI, "../main.ts"), "utf8");

test("T-168 A1: summarizer grok-custom NÃO seta GROK_HOME=~/.grok", () => {
  const env = applyGrokFamilySummarizerEnv(
    { PATH: "/usr/bin", HOME: "/home/u", GROK_HOME: "/home/u/.grok" },
    "grok-custom",
  );
  assert.notEqual(env.GROK_HOME, join("/home/u", ".grok"));
  assert.equal(env.GROK_HOME, grokHomePath("/home/u", "grok-custom"));
  assert.equal(env.GROK_HOME, join("/home/u", ".grok-custom"));
  assert.equal(env.HOME, "/home/u");
  assert.equal(env.GROK_DISABLE_AUTOUPDATER, "1");

  const official = applyGrokFamilySummarizerEnv(
    { PATH: "/usr/bin", HOME: "/home/u" },
    "grok",
  );
  assert.equal(official.GROK_HOME, join("/home/u", ".grok"));
  assert.equal(official.GROK_HOME, grokHomePath("/home/u", "grok"));
});

test("T-168 A2: summarizer passa runner ao normalizeGrokEffort; grok-custom+glm → xhigh", () => {
  assert.match(SUM_SRC, /normalizeGrokEffort\(args\.effort,\s*args\.model,\s*args\.runner\)/);
  assert.equal(
    normalizeGrokEffort("xhigh", "rezulto:rezulto/glm5.3-flash", "grok-custom"),
    "xhigh",
  );
  assert.equal(normalizeGrokEffort("xhigh", "rezulto:rezulto/glm5.3-flash", "grok"), "high");
});

test("T-168 A3: resolveGrokSessionRoots inclui ~/.grok-custom; tmp é candidato, sessão real intocada", () => {
  const roots = resolveGrokSessionRoots({ home: "/home/u", grokHomeEnv: null });
  assert.ok(roots.includes("/home/u/.grok/sessions"));
  assert.ok(roots.includes("/home/u/.grok-custom/sessions"));

  const customRoot = "/home/u/.grok-custom/sessions";
  const enc = (cwd: string) => encodeURIComponent(cwd);
  const now = 1_000_000_000_000;
  const ttl = DEFAULT_GROK_SESSION_TTL_MS;
  const old = now - ttl - 1;
  const cliOld = enc("/tmp/the-dudes-cli-oldCustom");
  const project = enc("/Users/u/projects/claudinhos");
  const dirs: Record<string, { mtimeMs: number; isDir?: boolean }> = {
    [`${customRoot}/${cliOld}`]: { mtimeMs: old },
    [`${customRoot}/${project}`]: { mtimeMs: old },
  };
  const removed: string[] = [];
  const rootEntries = new Map<string, string[]>([[customRoot, [cliOld, project]]]);
  const fs: GrokSessionCleanupFs = {
    readdirSync: (dir) => {
      const list = rootEntries.get(dir);
      if (!list) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return [...list];
    },
    statSync: (p) => {
      const st = dirs[p];
      if (!st) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isDirectory: () => st.isDir !== false, mtimeMs: st.mtimeMs };
    },
    rmSync: (p) => {
      removed.push(p);
      delete dirs[p];
    },
  };
  const r = cleanGrokTempSessions({ roots: [customRoot], nowMs: now, ttlMs: ttl, fs });
  assert.equal(r.removed, 1);
  assert.equal(r.scanned, 2);
  assert.equal(r.kept, 1);
  assert.deepEqual(removed, [`${customRoot}/${cliOld}`]);
  assert.ok(dirs[`${customRoot}/${project}`], "sessão real intocada");
});

test("T-168 A4: grok oficial continua ~/.grok; T-164 buildGrokEnv intacto", () => {
  const official = applyGrokFamilySummarizerEnv({ HOME: "/home/u" }, "grok");
  assert.equal(official.GROK_HOME, join("/home/u", ".grok"));

  const env = buildGrokEnv({
    base: { PATH: "/usr/bin", HOME: "/home/u" },
    tokenFile: "/tmp/token",
    features: {},
    grokHome: grokHomePath("/home/u", "grok-custom"),
    runner: "grok-custom",
  });
  assert.equal("GROK_HOME" in env, false);
  assert.notEqual(env.GROK_HOME, join("/home/u", ".grok"));
});

test("T-168 residual QA: buildGrokEnv apaga GROK_HOME herdado p/ grok-custom", () => {
  const env = buildGrokEnv({
    base: { PATH: "/usr/bin", HOME: "/home/u", GROK_HOME: join("/home/u", ".grok") },
    tokenFile: "/tmp/token",
    features: {},
    grokHome: grokHomePath("/home/u", "grok-custom"),
    runner: "grok-custom",
  });
  assert.equal("GROK_HOME" in env, false);
  assert.notEqual(env.GROK_HOME, join("/home/u", ".grok"));
});

test("T-168: log de CLI status lista grok-custom (POLICY_GATED_RUNNERS)", () => {
  assert.match(MAIN_SRC, /POLICY_GATED_RUNNERS\.forEach/);
  assert.doesNotMatch(
    MAIN_SRC,
    /\(\["claude", "opencode", "gemini", "codex", "crush", "grok"\] as const\)\.forEach/,
  );
});
