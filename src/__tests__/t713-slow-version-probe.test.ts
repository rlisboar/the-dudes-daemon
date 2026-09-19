import "./scratch-home.js";

/**
 * T-713: `opencode --version` 1.18.31 leva 7.3-8.8s neste host (I/O, ~1s de
 * CPU). Com 1.5s + retry 6s, o opencode instalado ficava available=false
 * ('timeout — inconclusivo') e o runner dizia 'opencode not found'. O retry
 * único agora é de 20s. O ruling T-375 continua: timeout não é prova,
 * inconclusivo não é cacheado, só exit 0 dá available.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  PROBE_CACHE_PATH,
  PROBE_RETRY_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  probeRunnerExecutable,
  resolveCliCommand,
} from "../cli-config.js";

function fakeBin(body: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t713-"));
  const p = path.join(dir, "opencode");
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  // Primeiro exec de ficheiro novo no macOS paga avaliação fora da medição (ver T-375).
  spawnSync(p, ["--warmup"], { stdio: "ignore" });
  return p;
}

// Responde --version em 9s (acima do pior medido, 8.83s) e sai 0.
const SLOW_9S = `#!/bin/sh\ncase "$1" in --version) sleep 9; echo 1.18.31; exit 0;; --warmup) exit 0;; esac\nexit 2\n`;

test("T-713: binário que responde --version em 9s fica available=true com os orçamentos de produção (e é cacheado)", () => {
  const bin = fakeBin(SLOW_9S);
  const t0 = Date.now();
  const r = resolveCliCommand("opencode", bin);
  const elapsed = Date.now() - t0;
  assert.equal(r.available, true, `razão: ${r.probeReason}`);
  assert.match(r.probeReason ?? "", /--version status 0/);
  assert.ok(elapsed >= 9_000 && elapsed < PROBE_TIMEOUT_MS + PROBE_RETRY_TIMEOUT_MS, `levou ${elapsed}ms`);

  // Positivo cacheado: o boot seguinte não paga os 9s de novo.
  const st = statSync(bin);
  const onDisk = JSON.parse(readFileSync(PROBE_CACHE_PATH, "utf8")) as Record<string, { ok: boolean }>;
  assert.equal(onDisk[`${bin}:${st.size}:${st.mtimeMs}`]?.ok, true);
  const t1 = Date.now();
  assert.equal(probeRunnerExecutable(bin).ok, true);
  assert.ok(Date.now() - t1 < 1_000, "servido da cache");
});

test("T-713: binário ausente continua available=false (missing)", () => {
  const missing = path.join(mkdtempSync(path.join(os.tmpdir(), "t713-")), "opencode");
  const r = resolveCliCommand("opencode", missing);
  assert.equal(r.available, false);
  assert.equal(r.resolvedPath, undefined, "override para o nada é missing, não broken");
  assert.match(r.probeReason ?? "", /inexistente/);
});

test("T-713: ruling T-375 mantido — o que pendura segue indisponível, inconclusivo e fora da cache", () => {
  const bin = fakeBin(`#!/bin/sh\ncase "$1" in --warmup) exit 0;; esac\nsleep 5\nexit 0\n`);
  const r = probeRunnerExecutable(bin, 200, 300);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^timeout/);
  assert.equal(r.inconclusive, true);
  const st = statSync(bin);
  let onDisk: Record<string, unknown> = {};
  try { onDisk = JSON.parse(readFileSync(PROBE_CACHE_PATH, "utf8")); } catch { /* sem ficheiro */ }
  assert.ok(!(`${bin}:${st.size}:${st.mtimeMs}` in onDisk));
});

test("T-713: orçamentos de produção — 1ª tentativa 1.5s (inalterada), retry cobre o pior medido com folga", () => {
  assert.equal(PROBE_TIMEOUT_MS, 1_500);
  assert.ok(PROBE_RETRY_TIMEOUT_MS >= 2 * 8_830, `retry=${PROBE_RETRY_TIMEOUT_MS}`);
});
