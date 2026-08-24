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
 *  3. verifica a assinatura Ed25519 contra o conjunto de chaves públicas
 *     confiáveis (dual-trust durante rotação — ver docs/ED25519-KEY-ROTATION.md).
 *     Um orchestrator comprometido não consegue empurrar binário forjado: ele
 *     não tem nenhuma privada do conjunto;
 *  4. confere o sha256 anunciado;
 *  5. escreve ao lado do binário atual e troca com rename atômico;
 *  6. sai com código 42 — o launcher (run-daemon.sh) relança com o novo.
 *
 * Sem launcher (exit 42 mataria o daemon sem volta), o update só troca o
 * arquivo e avisa que o restart ficou pendente — comportamento seguro para
 * quem ainda roda com nohup puro.
 */

import { verify as edVerify, createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DAEMON_BUILD_TS } from "./daemon-build-ts.js";

/**
 * Conjunto de pubkeys Ed25519 confiáveis.
 *
 * Estágio N+3 (T-035): SÓ a chave NOVA. A ANTIGA (comprometida / exposta a
 * agentes no worktree legado) foi removida do trust set. Releases assinados
 * com a antiga são rejeitados fail-closed.
 *
 * Histórico: dual-trust (antiga+nova) nos estágios N…N+2 — ver
 * docs/ED25519-KEY-ROTATION.md. Privada da NOVA: ~/.the-dudes-signing/sign-new.key
 * (FORA do repo, chmod 600).
 */
export const TRUSTED_SIGN_PUBS: readonly string[] = [
  // NOVA (T-006 — par em ~/.the-dudes-signing/sign-new.{key,pub})
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAyOfZNGAQ8udECo/9GauS2CG7jBZM/nIcrry4dd7atXY=
-----END PUBLIC KEY-----`,
];

/** @deprecated use TRUSTED_SIGN_PUBS[0] — mantido só se algum import legar. */
export const SIGN_PUB = TRUSTED_SIGN_PUBS[0]!;

const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
/** Recheck de idle pós-swap. Injetável nos testes. */
export const IDLE_RECHECK_MS = 15_000;

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
  /** Trust set (teste injeta par efêmero). Default: TRUSTED_SIGN_PUBS. */
  trustedPubs?: readonly string[];
  /** Epoch do processo vivo. Default: DAEMON_BUILD_TS do bundle. */
  runningBuildTs?: number;
  /** 0 turnos (main+bg ativos+fila). Default: true (sem hook = trata como idle). */
  isIdle?: () => boolean;
  idleRecheckMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  /**
   * T-100: antes do exit 42, mata CLIs filhos (host.shutdown / runner.stop).
   * Só corre COM launcher. Sem launcher o caminho pending NÃO chama isto.
   */
  prepareReexec?: () => void | Promise<void>;
  /** Teto do prepareReexec. Estouro → exit 42 mesmo assim. Default 10s. */
  reexecTimeoutMs?: number;
}

/** Teto de segurança: idle-restart não pode travar esperando filho zumbi. */
export const REEXEC_SHUTDOWN_MS = 10_000;

/** Extrai DAEMON_BUILD_TS do .cjs sem executar. Null se ausente/lixo. */
export function extractBuildTs(bundle: Buffer): number | null {
  const s = bundle.toString("utf8");
  const m = s.match(/DAEMON_BUILD_TS\s*=\s*Number\(\s*"(\d{10,16})"/)
    ?? s.match(/DAEMON_BUILD_TS\s*=\s*(\d{10,16})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchBytes(f: typeof fetch, url: string, maxBytes: number): Promise<Buffer> {
  const r = await f(url, { redirect: "error" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length === 0 || buf.length > maxBytes) throw new Error(`${url}: tamanho inválido (${buf.length})`);
  return buf;
}

/**
 * True se a assinatura for válida sob pelo menos uma pubkey do conjunto.
 * Exportada para testes de dual-trust com pubs injetáveis.
 */
export function signatureAccepted(
  bundle: Buffer,
  sigB64: string,
  pubs: readonly string[] = TRUSTED_SIGN_PUBS,
): boolean {
  let sig: Buffer;
  try {
    sig = Buffer.from(sigB64.trim(), "base64");
  } catch {
    return false;
  }
  if (sig.length === 0) return false;
  for (const pub of pubs) {
    try {
      if (edVerify(null, bundle, pub, sig)) return true;
    } catch {
      // pubkey malformada no conjunto — ignora e tenta a próxima
    }
  }
  return false;
}

/** Valida assinatura (dual-trust) + checksum de um bundle. Lança se falhar. */
export function verifyBundle(
  bundle: Buffer,
  sigB64: string,
  expectedSha256: string,
  pubs: readonly string[] = TRUSTED_SIGN_PUBS,
): void {
  if (!signatureAccepted(bundle, sigB64, pubs)) {
    throw new Error("assinatura Ed25519 inválida — bundle recusado");
  }
  const sha = createHash("sha256").update(bundle).digest("hex");
  if (sha !== expectedSha256.toLowerCase()) {
    throw new Error(`sha256 divergente (anunciado ${expectedSha256.slice(0, 12)}, real ${sha.slice(0, 12)})`);
  }
}

let idleRestartArmed = false;
/** Swap aplicado; processo ainda na imagem do boot. */
let updatePending = false;
/** SHA publicado do último swap bem-sucedido neste processo. */
let appliedReleaseHash: string | undefined;
/** SHA da imagem carregada — capturado uma vez, nunca re-lê o arquivo. */
let bootBinaryHash: string | undefined;
let bootHashCaptured = false;

/**
 * Hash do arquivo no boot (proxy da imagem em memória). Chamado uma vez;
 * self-update posterior NÃO atualiza o valor — o processo segue na imagem velha.
 */
export function captureBootBinaryHash(selfPath: string): string | undefined {
  if (bootHashCaptured) return bootBinaryHash;
  try {
    bootBinaryHash = createHash("sha256").update(readFileSync(selfPath)).digest("hex");
  } catch {
    bootBinaryHash = undefined;
  }
  bootHashCaptured = true;
  return bootBinaryHash;
}

/** Campos do hello/health: versão REAL em execução + pending. */
export function runningReleaseInfo(): {
  binaryHash: string | undefined;
  buildTs: number;
  updatePending: boolean;
} {
  return {
    binaryHash: bootBinaryHash,
    buildTs: DAEMON_BUILD_TS,
    updatePending,
  };
}

/** Testes: limpa waiter de idle + identidade de boot entre casos. */
export function _resetIdleRestartForTest(): void {
  idleRestartArmed = false;
  updatePending = false;
  appliedReleaseHash = undefined;
  bootBinaryHash = undefined;
  bootHashCaptured = false;
}

function racePrepareReexec(deps: SelfUpdateDeps, timeoutMs: number): Promise<void> {
  const prep = deps.prepareReexec;
  if (!prep) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const later = deps.setTimeoutFn ?? setTimeout;
    const timer = later(() => finish("timeout"), timeoutMs);
    function finish(why: "ok" | "timeout" | "error", err?: unknown) {
      if (done) return;
      done = true;
      try { clearTimeout(timer as NodeJS.Timeout); } catch { /* timer fake */ }
      if (why === "timeout") {
        deps.log("warn", `[self-update] shutdown de filhos estourou ${timeoutMs}ms — saindo mesmo assim`);
      } else if (why === "error") {
        deps.log("warn", `[self-update] prepareReexec falhou: ${(err as Error).message} — saindo mesmo assim`);
      }
      resolve();
    }
    try {
      Promise.resolve(prep()).then(() => finish("ok"), (e) => finish("error", e));
    } catch (e) {
      finish("error", e);
    }
  });
}

async function requestReexec(deps: SelfUpdateDeps): Promise<"updated" | "updated-restart-pending"> {
  if (!deps.underLauncher) {
    deps.log("warn", "[self-update] binário atualizado, mas SEM launcher — o novo código só vale após restart manual");
    return "updated-restart-pending";
  }
  // T-100: filhos ANTES do exit 42. Sem prepareReexec (testes antigos) o
  // exit continua síncrono — nenhum await no caminho quente.
  if (deps.prepareReexec) {
    deps.log("info", "[self-update] encerrando filhos antes do re-exec (exit 42)");
    await racePrepareReexec(deps, deps.reexecTimeoutMs ?? REEXEC_SHUTDOWN_MS);
  }
  deps.log("info", "[self-update] saindo com código 42 — o launcher relança com o binário novo");
  (deps.exitFn ?? process.exit)(42);
  return "updated";
}

/**
 * T-088: após o swap, re-exec SÓ com 0 turnos. Ocupado → pending + recheck.
 * Não mata turno no meio (exit 42 derruba sessões).
 */
function planRestartWhenIdle(deps: SelfUpdateDeps): Promise<"updated" | "updated-awaiting-idle" | "updated-restart-pending"> | "updated-awaiting-idle" {
  const idle = deps.isIdle ?? (() => true);
  if (idle()) return requestReexec(deps);
  if (idleRestartArmed) return "updated-awaiting-idle";
  idleRestartArmed = true;
  deps.log("info", "[self-update] update aplicado, aguardando idle");
  const ms = deps.idleRecheckMs ?? IDLE_RECHECK_MS;
  const later = deps.setTimeoutFn ?? setTimeout;
  const tick = () => {
    if (idle()) {
      idleRestartArmed = false;
      void requestReexec(deps);
      return;
    }
    later(tick, ms);
  };
  later(tick, ms);
  return "updated-awaiting-idle";
}

/**
 * Checa e aplica update. Retorna o que aconteceu (pra teste e pro log):
 * "current" | "updated" | "updated-awaiting-idle" | "updated-restart-pending" | "failed".
 */
export async function checkAndApplyUpdate(deps: SelfUpdateDeps): Promise<string> {
  const f = deps.fetchFn ?? fetch;
  const pubs = deps.trustedPubs ?? TRUSTED_SIGN_PUBS;
  try {
    const shaLine = (await fetchBytes(f, `${deps.orchBase}/install/daemon.cjs.sha256`, 4096)).toString("utf8");
    const published = shaLine.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!/^[a-f0-9]{64}$/.test(published)) throw new Error("sha256 publicado malformado");
    if (deps.runningHash && published === deps.runningHash.toLowerCase()) return "current";
    // Já trocamos o arquivo neste processo: não re-baixar; só rechecar idle.
    if (updatePending && appliedReleaseHash === published) {
      return planRestartWhenIdle(deps);
    }

    deps.log("info", `[self-update] release ${published.slice(0, 12)} ≠ rodando ${String(deps.runningHash).slice(0, 12)} — baixando`);

    const dir = dirname(deps.selfPath);
    const pares: Array<{ nome: string; destino: string; sha: string }> = [];
    for (const nome of ["daemon.cjs", "mcp-bridge.cjs"]) {
      const bundle = await fetchBytes(f, `${deps.orchBase}/install/${nome}`, MAX_BUNDLE_BYTES);
      const sig = (await fetchBytes(f, `${deps.orchBase}/install/${nome}.sig`, 4096)).toString("utf8");
      const shaPub = (await fetchBytes(f, `${deps.orchBase}/install/${nome}.sha256`, 4096)).toString("utf8").trim().split(/\s+/)[0] ?? "";
      verifyBundle(bundle, sig, shaPub, pubs);
      if (nome === "daemon.cjs") {
        const incoming = extractBuildTs(bundle);
        const running = deps.runningBuildTs ?? DAEMON_BUILD_TS;
        if (incoming == null || incoming <= running) {
          throw new Error(
            `BUILD_TS recusado (${incoming ?? "ausente"} <= rodando ${running}) — anti-rollback, binário atual mantido`,
          );
        }
      }
      const tmp = join(dir, `.${nome}.new`);
      writeFileSync(tmp, bundle, { mode: 0o755 });
      pares.push({ nome, destino: join(dir, nome === "daemon.cjs" ? basename2(deps.selfPath) : nome), sha: shaPub });
      void tmp;
    }
    for (const p of pares) {
      renameSync(join(dir, `.${p.nome}.new`), p.destino);
    }
    deps.log("info", `[self-update] binários trocados (release ${published.slice(0, 12)}) — assinatura e sha256 verificados`);
    appliedReleaseHash = published;
    updatePending = true;

    return planRestartWhenIdle(deps);
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
