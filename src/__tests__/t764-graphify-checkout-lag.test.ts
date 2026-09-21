/**
 * T-764 (review T-763): o graphify indexa a ÁRVORE do workspace; se o checkout
 * de indexação fica para trás do origin, o grafo envelhece sem ninguém ver. O
 * aviso agora declara o atraso (HEAD vs origin/main). Teste com repo git real
 * temporário; caminho não-repo devolve null (nunca derruba o agente).
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkoutLagWarning, indexCheckoutLagMs } from "../graph-indexer.js";

function git(dir: string, args: string[], date?: string): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
      : { ...process.env, GIT_AUTHOR_DATE: new Date().toISOString(), GIT_COMMITTER_DATE: new Date().toISOString() },
  }).trim();
}

function repoComAtraso(dias: number): { dir: string; headAtrasado: string; headNovo: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t764-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t764@local"]);
  git(dir, ["config", "user.name", "t764"]);
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "antigo"], new Date(Date.now() - dias * 86_400_000).toISOString());
  const headAtrasado = git(dir, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(dir, "b.txt"), "b\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "novo"]);
  const headNovo = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["update-ref", "refs/remotes/origin/main", headNovo]);
  return { dir, headAtrasado, headNovo };
}

test("T-764: checkout atrás do origin/main gera aviso com as duas datas", () => {
  const { dir, headAtrasado } = repoComAtraso(10);
  git(dir, ["checkout", "-q", "--detach", headAtrasado]);
  const lag = indexCheckoutLagMs(dir);
  assert.ok(lag && lag.lagMs >= 9 * 86_400_000, `atraso ~10d medido: ${JSON.stringify(lag)}`);
  const aviso = checkoutLagWarning(dir);
  assert.ok(aviso && aviso.includes("CHECKOUT DE INDEXAÇÃO atrasado"), `aviso declarado: ${aviso}`);
  assert.match(aviso!, /HEAD de .* vs origin\/main de .*/);
  // Menos de 24h de atraso (HEAD no topo) → sem aviso.
  git(dir, ["checkout", "-q", "--detach", "origin/main"]);
  assert.equal(checkoutLagWarning(dir), null);
  assert.equal(indexCheckoutLagMs(dir)?.lagMs, 0);
});

test("T-764: diretório não-repo devolve null (não derruba o agente)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t764-norepo-"));
  assert.equal(indexCheckoutLagMs(dir), null);
  assert.equal(checkoutLagWarning(dir), null);
});