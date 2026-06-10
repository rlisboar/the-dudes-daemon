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
  codex?: string;
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
  codex: ResolvedCliCommand;
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
  return {
    claude: resolveOne("claude", config.cliPaths?.claude),
    opencode: resolveOne("opencode", config.cliPaths?.opencode),
    gemini: resolveOne("gemini", config.cliPaths?.gemini),
    codex: resolveOne("codex", config.cliPaths?.codex),
  };
}

export function formatCliStatus(label: CliRunner, resolved: ResolvedCliCommand): string {
  const state = resolved.available ? "ok" : "missing";
  const source = resolved.source === "override" ? "manual" : resolved.source === "detected" ? "auto" : "fallback";
  return `${label}: ${resolved.command} [${state}, ${source}]`;
}

function resolveOne(label: CliRunner, override?: string): ResolvedCliCommand {
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
      codex: normalizePath(cliPaths.codex),
    },
  };
}
