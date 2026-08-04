/**
 * Self-update assinado do daemon.
 *
 * O deploy virou canal único (push → CI publica o release assinado em
 * /install), mas o daemon local continuava atualizando NA MÃO: copiar o
 * bundle, matar o processo, relançar — três vezes num dia. Este módulo fecha
 * o passo que faltava.
 *
 * Fluxo, fail-closed em cada etapa:
 *  1. baixa /install/daemon.cjs.sha256 do orchestrator e compara com o hash
 *     do binário em execução — igual = nada a fazer;
 *  2. baixa bundle + .sig (e o par mcp-bridge) — tamanho limitado;
 *  3. verifica a assinatura Ed25519 contra a CHAVE PÚBLICA EMBUTIDA (a mesma
 *     do docker-entrypoint). Um orchestrator comprometido não consegue
 *     empurrar binário forjado: ele não tem a chave privada;
 *  4. confere o sha256 anunciado;
 *  5. escreve ao lado do binário atual e troca com rename atômico;
 *  6. sai com código 42 — o launcher (run-daemon.sh) relança com o novo.
 *
 * Sem launcher (exit 42 mataria o daemon sem volta), o update só troca o
 * arquivo e avisa que o restart ficou pendente — comportamento seguro para
 * quem ainda roda com nohup puro.
 */

import { verify as edVerify, createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Mesma pubkey Ed25519 do docker-entrypoint.sh — par da .signing/sign.key. */
const SIGN_PUB = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAhnydRabRqG76LrgUBsx+1Wk5HcojzeYcr3CB/EkglaI=
-----END PUBLIC KEY-----`;

const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;

export interface SelfUpdateDeps {
  orchBase: string;
  /** Caminho do binário em execução (process.argv[1]). */
  selfPath: string;
  runningHash: string | undefined;
  log: (level: "info" | "warn" | "error", msg: string) => void;
  /** true quando o launcher supervisiona (THE_DUDES_LAUNCHER=1). */
  underLauncher: boolean;
  /** Injetável no teste. */
  fetchFn?: typeof fetch;
  exitFn?: (code: number) => void;
}

async function fetchBytes(f: typeof fetch, url: string, maxBytes: number): Promise<Buffer> {
  const r = await f(url, { redirect: "error" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length === 0 || buf.length > maxBytes) throw new Error(`${url}: tamanho inválido (${buf.length})`);
  return buf;
}

/** Valida assinatura + checksum de um bundle. Lança se qualquer etapa falhar. */
export function verifyBundle(bundle: Buffer, sigB64: string, expectedSha256: string): void {
  const ok = edVerify(null, bundle, SIGN_PUB, Buffer.from(sigB64.trim(), "base64"));
  if (!ok) throw new Error("assinatura Ed25519 inválida — bundle recusado");
  const sha = createHash("sha256").update(bundle).digest("hex");
  if (sha !== expectedSha256.toLowerCase()) {
    throw new Error(`sha256 divergente (anunciado ${expectedSha256.slice(0, 12)}, real ${sha.slice(0, 12)})`);
  }
}

/**
 * Checa e aplica update. Retorna o que aconteceu (pra teste e pro log):
 * "current" | "updated" | "updated-restart-pending" | "failed".
 */
export async function checkAndApplyUpdate(deps: SelfUpdateDeps): Promise<string> {
  const f = deps.fetchFn ?? fetch;
  try {
    const shaLine = (await fetchBytes(f, `${deps.orchBase}/install/daemon.cjs.sha256`, 4096)).toString("utf8");
    const published = shaLine.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!/^[a-f0-9]{64}$/.test(published)) throw new Error("sha256 publicado malformado");
    if (deps.runningHash && published === deps.runningHash.toLowerCase()) return "current";

    deps.log("info", `[self-update] release ${published.slice(0, 12)} ≠ rodando ${String(deps.runningHash).slice(0, 12)} — baixando`);

    const dir = dirname(deps.selfPath);
    const pares: Array<{ nome: string; destino: string; sha: string }> = [];
    for (const nome of ["daemon.cjs", "mcp-bridge.cjs"]) {
      const bundle = await fetchBytes(f, `${deps.orchBase}/install/${nome}`, MAX_BUNDLE_BYTES);
      const sig = (await fetchBytes(f, `${deps.orchBase}/install/${nome}.sig`, 4096)).toString("utf8");
      const shaPub = (await fetchBytes(f, `${deps.orchBase}/install/${nome}.sha256`, 4096)).toString("utf8").trim().split(/\s+/)[0] ?? "";
      verifyBundle(bundle, sig, shaPub);
      const tmp = join(dir, `.${nome}.new`);
      writeFileSync(tmp, bundle, { mode: 0o755 });
      pares.push({ nome, destino: join(dir, nome === "daemon.cjs" ? basename2(deps.selfPath) : nome), sha: shaPub });
      // rename só depois que TODOS verificaram — troca parcial é pior que nada
      void tmp;
    }
    for (const p of pares) {
      renameSync(join(dir, `.${p.nome}.new`), p.destino);
    }
    deps.log("info", `[self-update] binários trocados (release ${published.slice(0, 12)}) — assinatura e sha256 verificados`);

    if (deps.underLauncher) {
      deps.log("info", "[self-update] saindo com código 42 — o launcher relança com o binário novo");
      (deps.exitFn ?? process.exit)(42);
      return "updated";
    }
    deps.log("warn", "[self-update] binário atualizado, mas SEM launcher — o novo código só vale após restart manual");
    return "updated-restart-pending";
  } catch (e) {
    deps.log("warn", `[self-update] falhou (mantendo o binário atual): ${(e as Error).message}`);
    return "failed";
  }
}

/** O daemon pode rodar como daemon.cjs OU outro nome (dist/daemon.cjs). */
function basename2(p: string): string {
  const b = p.split("/").pop() ?? "daemon.cjs";
  return b.endsWith(".cjs") || b.endsWith(".js") ? b : "daemon.cjs";
}
