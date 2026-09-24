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

/**
 * Budget derivado T-588 (2026-09-17) — boot do fake CLI até o pid file
 * parseável; não é "mais folga".
 *
 * Medido no host (18 cpus, com a suíte de outro worktree rodando junto):
 *   - sequencial n=20: p50=901ms p100=1474ms
 *   - 12 spawns simultâneos ×3: p50=2498ms p90=3020ms p100=3219ms
 *   - suíte completa (a condição que falhou): pid file AUSENTE quando o kill
 *     de 2.5s disparou → boot > 2.5s com dezenas de ficheiros em paralelo.
 * O timeout do summarizer corre contra este boot: se o kill chega antes do
 * write, o processo morre sem escrever e o teste falha por corrida, não por
 * defeito. Teto = 2 × p100 concorrente ≈ 6.5s.
 */
// T-1088: 6,5s não bastava sob a carga da suíte (o stub nem se registrava).
const BOOT_BUDGET_MS = 20_000;

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
    // BOOT_BUDGET_MS (derivado acima): o pid file tem de existir ANTES do
    // timeout disparar — o kill mata o fake CLI e ele nunca mais escreve.
    timeoutMs: BOOT_BUDGET_MS + 3_000,  // T-1088: o CLI tem de viver MAIS que a janela de boot
  });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /timeout/);

  // FATO = JSON parseável com leader+child (T-588). Existir o ficheiro não
  // basta: sob carga da suíte o write pode ser parcial e JSON.parse(raw)
  // rebentava o teste antes de o grupo sequer ser observado.
  let parsed: { leader: number; child: number } | null = null;
  let raw = "";
  const pidDeadline = Date.now() + BOOT_BUDGET_MS;
  while (!parsed && Date.now() < pidDeadline) {
    try {
      raw = readFileSync(pidFile, "utf8");
      const j = JSON.parse(raw) as { leader?: unknown; child?: unknown };
      if (typeof j.leader === "number" && j.leader > 0 && typeof j.child === "number" && j.child > 0) {
        parsed = { leader: j.leader, child: j.child };
        break;
      }
    } catch { /* ainda não existe ou JSON parcial */ }
    await new Promise((r2) => setTimeout(r2, 50));
  }
  assert.ok(parsed, `pid file não ficou parseável em ${BOOT_BUDGET_MS}ms (último raw=${JSON.stringify(raw)})`);
  const { leader, child } = parsed;
// T-1088: janela LARGA — sob carga o pid do neto demora a aparecer/morrer e a
// janela curta virava falso vermelho ('pid file não parseável'/'neto sobreviveu').
  const deadline = Date.now() + 10_000;
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
