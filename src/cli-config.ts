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
  const state = resolved.available ? "ok" : "missing";
  const source = resolved.source === "override" ? "manual" : resolved.source === "detected" ? "auto" : "fallback";
  return `${label}: ${resolved.command} [${state}, ${source}]`;
}

function resolveOne(label: CliRunner | string, override?: string, extraDirs?: string[]): ResolvedCliCommand {
  const manual = normalizePath(override);
  if (manual) {
    return {
      command: manual,
      source: "override",
      available: isExecutable(manual),
      resolvedPath: manual,
    };
  }
  const detected = detectOnPath(label);
  if (detected) {
    return {
      command: detected,
      source: "detected",
      available: true,
      resolvedPath: detected,
    };
  }
  // Fallback: varre dirs extras (ex: dirs de script do pip fora do PATH).
  for (const dir of extraDirs ?? []) {
    const cand = path.join(dir, label);
    if (isExecutable(cand)) {
      return { command: cand, source: "detected", available: true, resolvedPath: cand };
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
