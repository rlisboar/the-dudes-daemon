/**
 * T-445 (M22): timeout do summarizer mata o GRUPO de processos, não só o
 * líder — antes o neto (CLI atrás do wrapper/pty) sobrevivia ao timeout.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCliText } from "../summarizer-runner.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("T-445: timeout do summarizer mata o grupo inteiro (líder + neto)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t445-"));
  const pidFile = path.join(dir, "child.pid");
  const script = path.join(dir, "fake-cli.mjs");
  writeFileSync(script, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const c = spawn("sleep", ["300"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ leader: process.pid, child: c.pid }));
setInterval(() => {}, 1000);
`);
  chmodSync(script, 0o755);

  const r = await runCliText("resume isto", {
    runner: "crush",
    cliCommands: { crush: { available: true, command: script } } as never,
    // 2.5s: boot do node script sob carga da suíte completa pode passar de
    // 700ms — o pid file tem de existir ANTES do timeout disparar.
    timeoutMs: 2_500,
  });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /timeout/);

  let raw = "";
  const pidDeadline = Date.now() + 3_000;
  while (!raw && Date.now() < pidDeadline) {
    try { raw = readFileSync(pidFile, "utf8"); } catch { await new Promise((r2) => setTimeout(r2, 50)); }
  }
  const { leader, child } = JSON.parse(raw) as { leader: number; child: number };
  assert.ok(leader > 0 && child > 0, "fake CLI registrou líder e neto");
  const deadline = Date.now() + 5_000;
  while ((alive(leader) || alive(child)) && Date.now() < deadline) await new Promise((r2) => setTimeout(r2, 50));
  assert.equal(alive(leader), false, "líder morto");
  assert.equal(alive(child), false, `neto (pid ${child}) sobreviveu ao timeout — kill só no líder`);
});

test("T-445 wiring: ambos os kill usam killProcess (grupo), não proc.kill", () => {
  const src = readFileSync(new URL("../summarizer-runner.ts", import.meta.url), "utf8");
  assert.match(src, /import \{ killProcess \} from "\.\/runners\/process-lifecycle\.js"/);
  assert.equal(src.includes('proc.kill("SIGKILL")'), false, "nenhum kill só-líder restante");
  assert.equal((src.match(/killProcess\(proc\)/g) ?? []).length, 2, "cleanup do opencode + timeout do runCliText");
});
