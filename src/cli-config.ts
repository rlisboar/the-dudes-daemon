import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import type { CliRunner } from "./types.js";

export interface CliPathConfig {
  claude?: string;
  opencode?: string;
  gemini?: string;
  qwen?: string;
  codex?: string;
  crush?: string;
  grok?: string;
  /** T-150: binário do runner grok-custom (apontado pelo dono). */
  "grok-custom"?: string;
  graphify?: string;
  graphifyMcp?: string;
}

export interface DaemonCliConfig {
  cliPaths?: CliPathConfig;
}

export interface ResolvedCliCommand {
  command: string;
  source: "override" | "detected" | "fallback";
  available: boolean;
  resolvedPath?: string;
  /** T-375: quando disponível, o que a sonda viu; quando negada, porquê.
   *  String local (logs/diagnóstico) — não vai ao wire. */
  probeReason?: string;
}

export interface ResolvedCliCommands {
  claude: ResolvedCliCommand;
  opencode: ResolvedCliCommand;
  gemini: ResolvedCliCommand;
  /** Qwen Code CLI (QwenLM) — headless (prompt via stdin) com stream-json estilo Claude. */
  qwen: ResolvedCliCommand;
  codex: ResolvedCliCommand;
  crush: ResolvedCliCommand;
  /** Grok Build CLI (xAI) — headless `grok -p` / resume. */
  grok: ResolvedCliCommand;
  /** T-150: binário do runner grok-custom (semântica grok, executável do dono). */
  "grok-custom": ResolvedCliCommand;
  /** graphify CLI (build/index do knowledge graph) — opcional, só usado
   *  quando a feature graph está ligada no projeto. */
  graphify: ResolvedCliCommand;
  /** graphify-mcp (serve o graph.json via MCP stdio). */
  graphifyMcp: ResolvedCliCommand;
}

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".the-dudes", "daemon-config.json");

export function defaultDaemonConfigPath(): string {
  return DEFAULT_CONFIG_PATH;
}

export function loadDaemonCliConfig(configPath = DEFAULT_CONFIG_PATH): DaemonCliConfig {
  const resolved = expandHome(configPath);
  try {
    if (!fs.existsSync(resolved)) return {};
    const raw = fs.readFileSync(resolved, "utf8");
    const json = JSON.parse(raw) as DaemonCliConfig;
    return sanitizeCliConfig(json);
  } catch {
    return {};
  }
}

export function mergeCliConfig(...configs: Array<DaemonCliConfig | undefined | null>): DaemonCliConfig {
  const merged: DaemonCliConfig = {};
  for (const cfg of configs) {
    if (!cfg) continue;
    merged.cliPaths = { ...(merged.cliPaths ?? {}), ...(cfg.cliPaths ?? {}) };
  }
  return sanitizeCliConfig(merged);
}

export function resolveCliCommands(config: DaemonCliConfig = {}): ResolvedCliCommands {
  // Launchd / nohup herdam PATH mínimo — CLIs de usuário vivem fora dele
  // (~/.local/bin, ~/.grok/bin). Sempre varrer userRunnerBinDirs (T-031).
  const userDirs = userRunnerBinDirs();
  const resolved: ResolvedCliCommands = {
    claude: resolveOne("claude", config.cliPaths?.claude, userDirs),
    opencode: resolveOne("opencode", config.cliPaths?.opencode, userDirs),
    gemini: resolveOne("gemini", config.cliPaths?.gemini, userDirs),
    qwen: resolveOne("qwen", config.cliPaths?.qwen, userDirs),
    codex: resolveOne("codex", config.cliPaths?.codex, userDirs),
    // crush (charmbracelet) instala via brew/go install em ~/.local/bin ou
    // /opt/homebrew/bin — dirs que o PATH herdado pelo daemon nem sempre tem.
    crush: resolveOne("crush", config.cliPaths?.crush, userDirs),
    // grok (xAI Grok Build) instala em ~/.grok/bin (installer oficial) e às
    // vezes em ~/.local/bin / homebrew — fora do PATH do daemon.
    grok: resolveOne("grok", config.cliPaths?.grok, userDirs),
    // T-150: grok-custom — semântica grok, binário apontado pelo dono
    // (cliPaths["grok-custom"] ou binário `grok-custom` em userRunnerBinDirs).
    "grok-custom": resolveOne("grok-custom", config.cliPaths?.["grok-custom"], userDirs),
    // graphify/graphify-mcp costumam ser instalados via pip --user/pipx em
    // dirs FORA do PATH herdado pelo daemon (ex: ~/Library/Python/X.Y/bin,
    // ~/.local/bin). Além do `which`, varre esses dirs de script do pip.
    graphify: resolveOne("graphify", config.cliPaths?.graphify, pythonBinDirs()),
    graphifyMcp: resolveOne("graphify-mcp", config.cliPaths?.graphifyMcp, pythonBinDirs()),
  };
  return resolved;
}

/**
 * Dirs onde runners de usuário costumam morar sob launchd (PATH esparso).
 * Exportado para testes e para o install-launchagent espelhar o mesmo conjunto.
 * Ordem: dirs de usuário primeiro, depois homebrew/system.
 */
export function userRunnerBinDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".grok", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

/** Dirs comuns onde pip/pipx instalam console scripts, fora do PATH padrão. */
function pythonBinDirs(): string[] {
  const home = os.homedir();
  const dirs: string[] = [
    ...userRunnerBinDirs(),
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  // macOS pip --user: ~/Library/Python/X.Y/bin
  collectVersionedBins(path.join(home, "Library", "Python"), dirs);
  // python.org framework: /Library/Frameworks/Python.framework/Versions/X.Y/bin
  collectVersionedBins("/Library/Frameworks/Python.framework/Versions", dirs);
  // dedupe preserving order
  return [...new Set(dirs)];
}

function collectVersionedBins(base: string, out: string[]): void {
  try {
    for (const v of fs.readdirSync(base)) out.push(path.join(base, v, "bin"));
  } catch {
    /* dir não existe — ignora */
  }
}

export function formatCliStatus(label: CliRunner, resolved: ResolvedCliCommand): string {
  // T-375: "encontrado mas não executa" é um estado próprio — distincto de
  // "missing" (nem existe) e de "ok" (provado pela sonda). O timeout é o
  // QUARTO estado: o binário arrancou mas não respondeu — "não consegui
  // provar", nunca "provei que sim" (ruling PM).
  const reason = resolved.probeReason ?? "";
  const state = resolved.available
    ? "ok"
    : !resolved.resolvedPath
      ? "missing"
      : reason.startsWith("timeout")
        ? "timeout"
        : `broken (${reason || "sonda falhou"})`;
  const source = resolved.source === "override" ? "manual" : resolved.source === "detected" ? "auto" : "fallback";
  return `${label}: ${resolved.command} [${state}, ${source}]`;
}

/* ---------- T-375: sonda funcional de executabilidade ----------
 * `isExecutable` (statSync + X_OK) prova que o ficheiro existe e tem bit de
 * exec — não prova que EXECUTA. O premain do DEVOPS mediu o caso real: um
 * bundle cujo módulo nativo rebenta ao carregar (exec-under-musl) passa em
 * X_OK e morre no primeiro uso; a UI oferecia-o como "ok". A partir daqui
 * `available` só com PROVA de execução: `--version`, senão `--help`, com
 * timeout curto. Convenções universais (cobra/clap/yargs/click geram-nas),
 * por isso a sonda raramente mente. RULING PM: timeout NÃO é prova — um
 * binário que pendura no `--version` (auth interativo, montagem lenta, FS
 * bloqueado) é o verde incondicional da linha 164 com um cronómetro à
 * frente, por isso timeout ⇒ indisponível com razão própria (`timeout`,
 * distinguível de `broken`). Mitigações do falso negativo: (1) a cache por
 * (path, tamanho, mtime) confina a sonda ao primeiro boot pós-instalação;
 * (2) um spawn que estoura o timeout tem DIREITO a um retry único com
 * orçamento maior (cobre picos de carga antes de concluir); (3) o negativo
 * por timeout é INCONCLUSIVE e por isso não é cacheado — "não consegui
 * provar" volta a ser tentado no próximo boot, ao contrário de um
 * `exit != 0` limpo, que é resposta. */

/* Orçamentos lado a lado (padrão soft/hard da T-371), ruling PM 2026-09-07:
 * 1.5s inicial / 6s retry único. O retry só se gasta quando a 1ª tentativa
 * não respondeu; binário que pendura paga 1.5+6 e fica `timeout`
 * (inconclusivo, não cacheado). Mudar números exige medição declarada —
 * ver daemon/medir-boot-375.ts e a entrega da task_28d9976d.
 * TETO MULTI-PENDURA: as sondas correm SERIÁIS por runner dentro de
 * resolveCliCommands, N binários pendurados custam (1.5+6)×N ms de boot e
 * pagam-se em CADA boot (inconclusivo não se cacheia). Medido: 3 penduras
 * em série = 22 552ms ≈ 7.5s×3, linear. Com N grande o teto é real — se um
 * dia doer, a mitigação é paralelizar as sondas (a série é escolha, não
 * necessidade), não encurtar orçamentos. */
export const PROBE_TIMEOUT_MS = 1_500;
export const PROBE_RETRY_TIMEOUT_MS = 6_000;

export interface RunnerProbeResult {
  ok: boolean;
  reason: string;
  /** true quando a sonda não conseguiu nem provar nem negar (timeout, ou
   * spawn negado pelo SO). Resultados inconclusivos nunca entram na cache. */
  inconclusive?: boolean;
}

/** Cache em disco: um reboot a quente não paga de novo as sondas (~5s com
 * muitos runners instalados). Chave = path:tamanho:mtime, portanto um binário
 * atualizado invalida a entrada dele sozinho. */
export const PROBE_CACHE_PATH = path.join(os.homedir(), ".the-dudes", "runner-probe-cache.json");
const PROBE_CACHE_MAX = 256;

const probeCache = new Map<string, RunnerProbeResult>();

function loadProbeCache(): void {
  try {
    const raw = fs.readFileSync(PROBE_CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, RunnerProbeResult>;
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v.ok === "boolean" && typeof v.reason === "string") probeCache.set(k, v);
    }
  } catch {
    /* primeiro boot ou cache corrompido: começa vazio */
  }
}

function persistProbeCache(): void {
  try {
    // merge-on-write: outro processo daemon (ou teste em paralelo) pode ter
    // entradas que nós não carregámos — perdermos as dele estraga o boot dele.
    const merged: Record<string, RunnerProbeResult> = {};
    try {
      Object.assign(merged, JSON.parse(fs.readFileSync(PROBE_CACHE_PATH, "utf8")));
    } catch {
      /* ficheiro ainda não existe ou estava a meio de uma escrita */
    }
    Object.assign(merged, Object.fromEntries(probeCache));
    const keys = Object.keys(merged);
    for (let i = 0; i < keys.length - PROBE_CACHE_MAX; i++) delete merged[keys[i]];
    fs.mkdirSync(path.dirname(PROBE_CACHE_PATH), { recursive: true });
    fs.writeFileSync(PROBE_CACHE_PATH, JSON.stringify(merged));
  } catch {
    /* escrever nunca trava o boot */
  }
}

loadProbeCache();

export function probeRunnerExecutable(
  binPath: string,
  timeoutMs = PROBE_TIMEOUT_MS,
  retryTimeoutMs = PROBE_RETRY_TIMEOUT_MS,
): RunnerProbeResult {
  let key: string;
  try {
    const st = fs.statSync(binPath);
    key = `${binPath}:${st.size}:${st.mtimeMs}`;
  } catch {
    return { ok: false, reason: "inexistente" };
  }
  const cached = probeCache.get(key);
  if (cached) return cached;
  const res = runProbe(binPath, timeoutMs, retryTimeoutMs);
  // "não consegui provar" não vira verdade permanente: o inconclusivo
  // (timeout, spawn negado pelo SO) é re-sondado no próximo boot; um
  // `exit != 0` limpo É resposta e fica.
  if (!res.inconclusive) {
    probeCache.set(key, res);
    persistProbeCache();
  }
  return res;
}

type ProbeAttempt =
  | { kind: "timeout" }
  | { kind: "errno"; code: string }
  | { kind: "status"; status: number | null; signal: string | null };

function spawnAttempt(binPath: string, args: string[], timeoutMs: number): ProbeAttempt {
  let r: ReturnType<typeof spawnSync>;
  try {
    // stdio "ignore": a sonda não lê output; pipes só acrescentam órfãos e
    // envenenam medições. (NOTA: o "spawn fantasma" que aqui se suspeitou
    // ser órfão é na verdade o PRIMEIRO exec de ficheiro recém-criado no
    // macOS — ~0.3-1s de avaliação ANTES do corpo correr; os testes tratam
    // isso com um spawn de aquecimento, ver t375-runner-probe.)
    r = spawnSync(binPath, args, { timeout: timeoutMs, stdio: "ignore" });
  } catch (e) {
    return { kind: "errno", code: (e as NodeJS.ErrnoException).code ?? "SPAWN_THROW" };
  }
  const errno = (r?.error as NodeJS.ErrnoException | undefined)?.code;
  // Timeout do spawnSync chega como error=ETIMEDOUT *com* signal de kill.
  if (r.signal || errno === "ETIMEDOUT") return { kind: "timeout" };
  if (errno) return { kind: "errno", code: errno };
  return { kind: "status", status: r.status, signal: r.signal };
}

function runProbe(binPath: string, timeoutMs: number, retryTimeoutMs: number): RunnerProbeResult {
  let lastReason = "sem args executáveis";
  let retryLeft = retryTimeoutMs;
  // Ponto 3 do ruling (QA): "não consegui provar" nunca é persistido. Sem
  // resposta limpa em NENHUM arg (ex: EAGAIN/EMFILE sob tabela de processos
  // esgotada), o veredicto é inconclusivo como o timeout — a chave
  // path:size:mtime serviria o falso até o binário mudar ou a cache morrer.
  let sawAnswer = false;
  for (const args of [["--version"], ["--help"]]) {
    let a = spawnAttempt(binPath, args, timeoutMs);
    if (a.kind === "timeout" && retryLeft > 0) {
      // Retry único com orçamento maior (ruling PM): um pico de carga não
      // pode negar um runner são; mas o orçamento extra só se gasta UMA vez.
      const extra = retryLeft;
      retryLeft = 0;
      a = spawnAttempt(binPath, args, extra);
    }
    if (a.kind === "timeout") {
      // Ruling PM: timeout NÃO é prova. O binário pode estar à espera de
      // auth, com montagem lenta ou FS bloqueado — é o verde incondicional
      // com um cronómetro à frente. Não se passa ao arg seguinte: se não
      // respondeu num orçamento de 5s, o segundo arg também não responde.
      return {
        ok: false,
        inconclusive: true,
        reason:
          `timeout — arrancou mas não respondeu a ${args[0]} ` +
          `(orçamento ${timeoutMs}ms${retryTimeoutMs > 0 ? ` + retry ${retryTimeoutMs}ms` : ""} esgotados)`,
      };
    }
    if (a.kind === "errno") {
      if (a.code === "ENOENT" || a.code === "EACCES" || a.code === "ENOEXEC") {
        return { ok: false, reason: `exec falhou: ${a.code}` };
      }
      lastReason = `spawn erro: ${a.code}`;
      continue;
    }
    if (a.signal) {
      sawAnswer = true;
      lastReason = `executou mas morreu por ${a.signal} em ${args.join("/")}`;
      continue;
    }
    if (a.status === 0) return { ok: true, reason: `executou (${args[0]} status 0)` };
    sawAnswer = true;
    lastReason = `executou mas saiu com status ${a.status} em ${args.join("/")}`;
  }
  return { ok: false, reason: lastReason, inconclusive: !sawAnswer };
}

/** probeTimeoutMs: injectável para testes (sob carga do suite completo um
 * spawn pode inchar para além do timeout e cair no estado `timeout`
 * — inconclusivo — onde o teste esperava um veredicto; os casos negativos
 * pedem orçamento folgado). Produção usa os defaults: 1.5s + retry 5s. */
export function resolveCliCommand(
  label: CliRunner | string,
  override?: string,
  extraDirs?: string[],
  probeTimeoutMs?: number,
): ResolvedCliCommand {
  return resolveOne(label, override, extraDirs, probeTimeoutMs);
}

function resolveOne(
  label: CliRunner | string,
  override?: string,
  extraDirs?: string[],
  probeTimeoutMs?: number,
): ResolvedCliCommand {
  const manual = normalizePath(override);
  if (manual) {
    // T-375: override manual — X_OK já não basta; o binário tem de EXECUTAR.
    const exists = fs.existsSync(manual);
    const exec = exists && isExecutable(manual) ? { ok: true, reason: "executável" } : { ok: false, reason: exists ? "sem bit de execução" : "inexistente" };
    const probe = exec.ok ? probeRunnerExecutable(manual, probeTimeoutMs) : exec;
    return {
      command: manual,
      source: "override",
      available: probe.ok,
      // resolvedPath só para caminhos que EXISTEM — um override apontado pro
      // nada é "missing", não "broken".
      resolvedPath: exists ? manual : undefined,
      probeReason: probe.reason,
    };
  }
  const detected = detectOnPath(label);
  if (detected) {
    // T-375: o caminho PATH detectado devolvia `available: true` INCONDICIONAL
    // — existia um binário no PATH e era oferecido sem qualquer prova. Agora,
    // igual ao override: executado pela sonda.
    const probe = probeRunnerExecutable(detected, probeTimeoutMs);
    return {
      command: detected,
      source: "detected",
      available: probe.ok,
      resolvedPath: detected,
      probeReason: probe.reason,
    };
  }
  // Fallback: varre dirs extras (ex: dirs de script do pip fora do PATH).
  for (const dir of extraDirs ?? []) {
    const cand = path.join(dir, label);
    if (isExecutable(cand)) {
      const probe = probeRunnerExecutable(cand, probeTimeoutMs);
      return { command: cand, source: "detected", available: probe.ok, resolvedPath: cand, probeReason: probe.reason };
    }
  }
  return {
    command: label,
    source: "fallback",
    available: false,
  };
}

/** Resolve python3 a um path ABSOLUTO (o wrapper PTY do opencode era
 *  spawnado por nome cru "python3", resolvido do PATH no exec — PATH hijack
 *  rodava um python3 malicioso como o usuário dropado). Tenta paths fixos
 *  comuns primeiro, depois o which endurecido. null se não achar (caller
 *  deve falhar explícito em vez de cair no nome cru). */
export function resolvePython3(): string | null {
  for (const p of ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3", "/bin/python3"]) {
    if (isExecutable(p)) return p;
  }
  return detectOnPath("python3");
}

function detectOnPath(command: string): string | null {
  // Usa path absoluto /usr/bin/which (com fallback) e timeout pra evitar
  // PATH hijack (user com diretório attacker-writable antes em PATH).
  const whichBin = ["/usr/bin/which", "/bin/which"].find((p) => {
    try { accessSync(p, fsConstants.X_OK); return true; } catch { return false; }
  }) ?? "which";
  const res = spawnSync(whichBin, [command], { encoding: "utf8", timeout: 5_000 });
  const out = typeof res.stdout === "string" ? res.stdout.trim() : "";
  if (res.status === 0 && out) return out.split("\n")[0].trim();
  return null;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.statSync(filePath);
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizePath(input?: string): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  return expandHome(trimmed);
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function sanitizeCliConfig(cfg: DaemonCliConfig): DaemonCliConfig {
  const cliPaths = cfg.cliPaths ?? {};
  return {
    cliPaths: {
      claude: normalizePath(cliPaths.claude),
      opencode: normalizePath(cliPaths.opencode),
      gemini: normalizePath(cliPaths.gemini),
      qwen: normalizePath(cliPaths.qwen),
      codex: normalizePath(cliPaths.codex),
      crush: normalizePath(cliPaths.crush),
      grok: normalizePath(cliPaths.grok),
      "grok-custom": normalizePath(cliPaths["grok-custom"]),
      graphify: normalizePath(cliPaths.graphify),
      graphifyMcp: normalizePath(cliPaths.graphifyMcp),
    },
  };
}
