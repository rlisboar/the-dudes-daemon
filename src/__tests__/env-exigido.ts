/**
 * T-897 — o que a suíte do daemon precisa do AMBIENTE, e como dizer isso.
 *
 * Dois testes legítimos dependem de coisas que um sandbox nega:
 *  - `/bin/ps` (o leitor de peer-pid e o suite-park leem a tabela de processos);
 *  - `~/.codex` gravável (o runner codex escreve o config.toml no home real).
 *
 * Sem isto, "suíte verde" perde valor como evidência: os arquivos caem por
 * ambiente e viram "flakes" no relatório de quem entrega.
 *
 * A regra aqui é EXPLÍCITA: quem depende, checa e dá `skip` com motivo — nunca
 * passa em silêncio e nunca falha por ambiente.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cachePs: boolean | null = null;
let cacheCodex: boolean | null = null;

/** `ps` roda e devolve a tabela? (sandbox do agente nega com EPERM). */
export function psDisponivel(): boolean {
  if (cachePs != null) return cachePs;
  try {
    const r = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 10_000 });
    cachePs = !r.error && r.status === 0 && (r.stdout ?? "").trim().length > 0;
  } catch {
    cachePs = false;
  }
  return cachePs;
}

/** Motivo do skip (o rótulo aparece no relatório do `node --test`). */
export function semPs(): string | false {
  return psDisponivel() ? false : "ps negado neste ambiente (sandbox do agente) — T-897";
}

/** O home real aceita escrita em `.codex`? (o runner grava config.toml lá). */
export function codexHomeEscrevivel(): boolean {
  if (cacheCodex != null) return cacheCodex;
  const dir = path.join(os.homedir(), ".codex");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const alvo = path.join(dir, `.probe-${process.pid}`);
    fs.writeFileSync(alvo, "x");
    fs.rmSync(alvo, { force: true });
    cacheCodex = true;
  } catch {
    cacheCodex = false;
  }
  return cacheCodex;
}

export function semCodexHome(): string | false {
  return codexHomeEscrevivel() ? false : "~/.codex não é gravável neste ambiente — T-897";
}