/**
 * T-875 — diretório temporário que AGUENTA um `TMPDIR` hostil.
 *
 * `os.tmpdir()` confia na variável: se o `TMPDIR` do ambiente existir e negar
 * escrita (ex.: `dr-x------`), todo `mkdtemp`/`writeFile` embaixo dele estoura
 * EACCES — e a suíte inteira cai por um motivo de ambiente, não de código.
 *
 * A escolha é por TENTATIVA REAL (mkdtemp é a prova, não a variável): TMPDIR →
 * `os.tmpdir()` → `/tmp` → `cwd`. O primeiro que aceitar `mkdtemp` é a base.
 *
 * Limpeza: ao contrário do helper equivalente do SERVER, aqui os diretórios
 * criados por `tmpdir()` são removidos no fim do processo (best-effort) — sem
 * isso o fallback para `cwd` deixaria lixo não rastreado na worktree.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let base: string | null = null;
const criados: string[] = [];
let limpezaArmada = false;

function tentar(candidato: string | undefined): string | null {
  if (!candidato) return null;
  try {
    const dir = mkdtempSync(path.join(candidato, "td-probe-"));
    rmSync(dir, { recursive: true, force: true });
    return candidato;
  } catch {
    return null;
  }
}

/** Base gravável (a mesma durante todo o processo). */
export function baseTmp(): string {
  if (base) return base;
  for (const candidato of [process.env.TMPDIR, os.tmpdir(), "/tmp", process.cwd()]) {
    const ok = tentar(candidato);
    if (ok) { base = ok; return ok; }
  }
  throw new Error("nenhum diretório temporário gravável (TMPDIR, /tmp, cwd)");
}

/** `mkdtemp` na base escolhida, com limpeza automática no fim do processo. */
export function tmpdir(prefixo: string): string {
  const dir = mkdtempSync(path.join(baseTmp(), prefixo));
  criados.push(dir);
  if (!limpezaArmada) {
    limpezaArmada = true;
    process.once("exit", () => {
      for (const d of criados) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    });
  }
  return dir;
}

/** Caminho de ARQUIVO na base (para os `process.env.*_PATH` dos testes). */
export function tmpPath(nome: string): string {
  return path.join(baseTmp(), nome);
}

/** Testes: esquece a base (e o que foi criado). */
export function _resetBaseTmpForTest(): void {
  base = null;
}