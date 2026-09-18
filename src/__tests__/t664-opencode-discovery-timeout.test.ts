/**
 * T-664 — discovery do opencode contra CLI LENTA: os tetos derivados do
 * medido (verbose 40s / fallback 35s) deixam o catálogo real passar, e um CLI
 * além do teto cai em comportamento controlado (fallback ou erro) SEM travar
 * o lote. Antes (8s/12s) o caminho feliz estourava os dois caminhos → catálogo
 * vazio com "timeout consultando modelos".
 *
 * Harness: stub CLI com sono configurável por subcomando (sleep-verbose /
 * sleep-simple) + ModelDiscovery REAL.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelDiscovery } from "../model-discovery.js";

const STUB = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
const dir = path.dirname(url.fileURLToPath(import.meta.url));
const verbose = process.argv.includes("--verbose");
const ms = Number(fs.readFileSync(path.join(dir, verbose ? "sleep-verbose" : "sleep-simple"), "utf8").trim()) || 0;
if (ms > 0) await new Promise((r) => setTimeout(r, ms));
if (verbose) {
  process.stdout.write("zen/fake-a\\n{ \\"variants\\": { \\"low\\": {}, \\"xhigh\\": {} } }\\nzen/fake-b\\n{ \\"variants\\": {} }\\n");
} else {
  process.stdout.write("zen/fake-a\\nzen/fake-b\\n");
}
`;

function makeHarness(sleepVerboseMs: number, sleepSimpleMs: number): ModelDiscovery {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t664-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  writeFileSync(path.join(dir, "sleep-verbose"), String(sleepVerboseMs));
  writeFileSync(path.join(dir, "sleep-simple"), String(sleepSimpleMs));
  const on = { command: stub, source: "override" as const, available: true };
  const off = { command: "false", source: "override" as const, available: false };
  const cliCommands = {
    claude: off, opencode: on, gemini: off, codex: off, crush: off, qwen: off,
    grok: off, "grok-custom": off, graphify: off, graphifyMcp: off,
  };
  return new ModelDiscovery(cliCommands as never, null);
}

/* ---------- C2: CLI lenta (16s > tetos antigos 8s/12s) ainda entrega ---------- */

test("T-664 (C2): CLI que demora 16s no verbose → discovery espera e devolve modelos COM efforts", async () => {
  const md = makeHarness(16_000, 16_000);
  const t0 = Date.now();
  const cat = await md.discover("opencode", true);
  const ms = Date.now() - t0;

  assert.equal(cat.error, undefined, `sem erro: ${cat.error ?? ""}`);
  assert.ok(cat.models.length >= 2, `catálogo veio vazio (${cat.models.length})`);
  assert.ok(ms >= 15_000, `esperou a CLI de verdade (${ms}ms)`);
  assert.ok(ms < 39_000, `dentro do teto novo de 40s (${ms}ms)`);
  // variants reais do verbose chegam como efforts (fonte do /variants)
  const fakeA = cat.models.find((m) => m.id === "zen/fake-a");
  assert.ok(fakeA?.efforts?.includes("xhigh"), `efforts do verbose perdidos: ${JSON.stringify(fakeA?.efforts)}`);
});

/* ---------- C2 contraprova: além do teto → fallback controlado ---------- */

test("T-664 (C2 contraprova): verbose além do novo teto (41s) cai no fallback simples SEM travar o lote", async () => {
  const md = makeHarness(41_000, 0);
  const t0 = Date.now();
  const cat = await md.discover("opencode", true);
  const ms = Date.now() - t0;

  assert.equal(cat.error, undefined, `fallback simples tem de salvar o catálogo: ${cat.error ?? ""}`);
  assert.ok(cat.models.length >= 2, "modelos vieram da lista simples");
  assert.ok(ms < 60_000, `corte do verbose (40s) + fallback instantâneo, sem travar (${ms}ms)`);
});

/* ---------- C2 contraprova: ambos além → erro controlado, sem throw ---------- */

test("T-664 (C2 contraprova): verbose E fallback além dos tetos → catálogo com erro controlado", async () => {
  const md = makeHarness(41_000, 36_000);
  const t0 = Date.now();
  const cat = await md.discover("opencode", true); // não pode lançar
  const ms = Date.now() - t0;

  assert.equal(cat.models.length, 0);
  assert.match(String(cat.error), /timeout consultando modelos/);
  assert.ok(ms >= 74_000, `pior caso = 40s + 35s (${ms}ms)`);
  assert.ok(ms < 90_000, `pior caso dentro do TTL do server (${ms}ms)`);
});

/* ---------- C4: tetos derivados + limites preservados (contrato estático) ---------- */

test("T-664 (C4): tetos derivados declarados; cache 5min e limites preservados", () => {
  const src = readFileSync(new URL("../model-discovery.ts", import.meta.url), "utf8");
  assert.match(src, /OPENCODE_VERBOSE_TIMEOUT_MS\s*=\s*40_000/, "teto do verbose (medido 30s + ~1/3)");
  assert.match(src, /OPENCODE_SIMPLE_TIMEOUT_MS\s*=\s*35_000/, "teto do fallback simples (medido 27.7s + ~1/3)");
  assert.match(src, /\["models"\], this\.dropTo, OPENCODE_SIMPLE_TIMEOUT_MS/, "fallback com teto próprio");
  assert.match(src, /CACHE_TTL_MS\s*=\s*5 \* 60_000/, "cache de 5min preservado");
  assert.match(src, /MAX_OUTPUT_BYTES\s*=\s*2 \* 1024 \* 1024/, "limite de saída preservado (545KB < 2MB)");
  assert.match(src, /MAX_MODELS\s*=\s*2_000/, "teto de modelos preservado");
});