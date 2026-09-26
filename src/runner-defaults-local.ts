import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RunnerConfigAliasOption, RunnerDefaultSetValue } from "./protocol.js";
import type { AgentInfo } from "@the-dudes/protocol/wire";
import type { CliRunner, EffortLevel } from "./types.js";
import { grokWireEfforts } from "./runners/model-policy.js";

export const RUNNER_DEFAULT_MODEL_MAX_LENGTH = 128;
export const DSH_MODEL_PAIR_MAX_LENGTH = RUNNER_DEFAULT_MODEL_MAX_LENGTH * 2 + 7;
const MODEL_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$/;
const EFFORTS = new Set<EffortLevel>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface LocalConfigDirAlias extends RunnerConfigAliasOption {
  /** Local only. This property is removed before serializing daemon:hello. */
  path: string;
  /** Inode identity prevents replacement between hello and child spawn. */
  device: number;
  inode: number;
}

export interface LocalRunnerConfigAliases {
  claude: LocalConfigDirAlias[];
}

export interface ResolvedRunnerSettings {
  model?: string;
  effort?: EffortLevel;
  configDir?: string;
  configAlias?: { alias: string; label: string };
  configSource: "env" | "agent" | "default" | "native";
}

export type RunnerDefaults = Partial<Record<CliRunner, RunnerDefaultSetValue>>;

function expandHome(raw: string, home: string): string {
  if (raw === "~" || raw === "$HOME") return home;
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  if (raw.startsWith("$HOME/")) return path.join(home, raw.slice(6));
  if (raw.startsWith("${HOME}/")) return path.join(home, raw.slice(8));
  return raw;
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function allowedClaudeName(name: string): boolean {
  return /^\.claude(?:$|[-_][A-Za-z0-9._-]{1,64}$)/.test(name);
}

/** Only direct, user-owned Claude profile directories under the canonical
 * local home are eligible. Remote config never supplies a filesystem path. */
export function validateClaudeConfigDir(
  raw: string,
  home: string,
  ownerUid: number | undefined = process.getuid?.(),
): string | undefined {
  if (typeof raw !== "string" || !raw.trim() || hasControl(raw) || raw.length > 4096) return undefined;
  let canonicalHome: string;
  try {
    canonicalHome = fs.realpathSync(home);
  } catch {
    return undefined;
  }
  const expanded = expandHome(raw.trim(), canonicalHome);
  if (!path.isAbsolute(expanded) || expanded.split(path.sep).includes("..")) return undefined;
  const candidate = path.resolve(expanded);
  if (path.dirname(candidate) !== canonicalHome || !allowedClaudeName(path.basename(candidate))) return undefined;
  try {
    const st = fs.lstatSync(candidate);
    if (!st.isDirectory() || st.isSymbolicLink()) return undefined;
    if (ownerUid != null && st.uid !== ownerUid) return undefined;
    const flags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(candidate, flags);
    let opened: fs.Stats;
    try { opened = fs.fstatSync(fd); } finally { fs.closeSync(fd); }
    if (!opened.isDirectory() || opened.dev !== st.dev || opened.ino !== st.ino) return undefined;
    const canonical = fs.realpathSync(candidate);
    if (canonical !== candidate || path.dirname(canonical) !== canonicalHome) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

/** Discover only the local Claude homes and explicit local additions from
 * daemon-config.json. Alias ids are stable, opaque digests; paths stay local. */
export function discoverClaudeConfigAliases(input: {
  home: string;
  ownerUid?: number;
  configuredPaths?: readonly string[];
}): LocalConfigDirAlias[] {
  let canonicalHome: string;
  try { canonicalHome = fs.realpathSync(input.home); } catch { return []; }
  const candidates = new Set<string>();
  try {
    for (const name of fs.readdirSync(canonicalHome)) {
      if (allowedClaudeName(name)) candidates.add(path.join(canonicalHome, name));
    }
  } catch { /* a missing home means no aliases */ }
  for (const configured of input.configuredPaths ?? []) {
    const checked = validateClaudeConfigDir(configured, canonicalHome, input.ownerUid);
    if (checked) candidates.add(checked);
  }

  const aliases: LocalConfigDirAlias[] = [];
  for (const candidate of [...candidates].sort()) {
    const checked = validateClaudeConfigDir(candidate, canonicalHome, input.ownerUid);
    if (!checked) continue;
    const alias = createHash("sha256")
      .update(`the-dudes:runner-config:v1\0claude\0${checked}`)
      .digest("base64url")
      .slice(0, 22);
    const st = fs.statSync(checked);
    aliases.push({ alias, label: `Claude profile ${aliases.length + 1}`, path: checked, device: st.dev, inode: st.ino });
    if (aliases.length >= 32) break;
  }
  return aliases;
}

export function revalidateClaudeConfigAlias(
  candidate: string,
  catalog: readonly LocalConfigDirAlias[],
  home: string,
  ownerUid?: number,
): string | undefined {
  const known = catalog.find((item) => item.path === candidate);
  if (!known) return undefined;
  const checked = validateClaudeConfigDir(candidate, home, ownerUid);
  if (!checked) return undefined;
  try {
    const st = fs.lstatSync(checked);
    if (st.dev !== known.device || st.ino !== known.inode) return undefined;
    return checked;
  } catch {
    return undefined;
  }
}

/** The path-bearing catalog is private to the daemon; hello only sends these
 *  opaque ids and labels. */
export function publicConfigDirAliases(catalog: LocalRunnerConfigAliases): { claude?: RunnerConfigAliasOption[] } {
  return catalog.claude.length
    ? { claude: catalog.claude.map(({ alias, label }) => ({ alias, label })) }
    : {};
}

export function isValidRunnerModel(value: unknown): value is string {
  return typeof value === "string" && value.length <= RUNNER_DEFAULT_MODEL_MAX_LENGTH && MODEL_GRAMMAR.test(value);
}

/** dsh ACP models are serialized [provider, model] pairs. Keep the existing
 *  scalar grammar for every other runner, and validate each dsh component by
 *  that same grammar before accepting the bounded JSON representation. */
export function isValidDshModel(value: unknown): value is string {
  if (typeof value !== "string" || value.length > DSH_MODEL_PAIR_MAX_LENGTH) return false;
  try {
    const pair: unknown = JSON.parse(value);
    return Array.isArray(pair)
      && pair.length === 2
      && pair.every((part) => typeof part === "string" && isValidRunnerModel(part))
      && JSON.stringify(pair) === value;
  } catch {
    return false;
  }
}

export function isValidRunnerModelFor(runner: CliRunner, value: unknown): value is string {
  return runner === "dsh" ? isValidDshModel(value) : isValidRunnerModel(value);
}

/** Matches server/src/brain-effort.ts. Defaults must be valid for both the
 *  protocol enum and the selected runner/model before they can affect spawn. */
export function isCompatibleRunnerEffort(runner: CliRunner, model: string | undefined, value: unknown): value is EffortLevel {
  if (typeof value !== "string" || !EFFORTS.has(value as EffortLevel)) return false;
  const effort = value as EffortLevel;
  if (runner === "codex") return ["low", "medium", "high", "xhigh"].includes(effort);
  if (runner === "claude") return ["low", "medium", "high", "xhigh", "max"].includes(effort);
  if (runner === "dsh") return ["none", "low", "high", "max"].includes(effort);
  if (runner === "opencode") {
    const id = (model ?? "").toLowerCase();
    if (/(^|\/)(gpt-|o\d)/.test(id) || id.includes("claude")) return ["none", "low", "medium", "high"].includes(effort);
    if (id.includes("glm-")) return ["none", "high"].includes(effort);
    return effort === "none";
  }
  if (runner === "grok" || runner === "grok-custom") {
    if (effort === "none" || effort === "minimal" || effort === "max") return true;
    return grokWireEfforts(model, runner).includes(effort as "low" | "medium" | "high" | "xhigh");
  }
  // Gemini, Qwen, Crush and Grok accept only the neutral value in the current
  // server contract. In particular this does not introduce unsupported flags.
  return effort === "none";
}

function choose<T>(values: Array<{ source: string; value: unknown }>, valid: (value: unknown) => value is T, warn: (message: string) => void, field: string, invalidReason?: string): T | undefined {
  for (const item of values) {
    if (item.value == null || item.value === "") continue;
    if (valid(item.value)) return item.value;
    warn(`runner default ${field} from ${item.source} is invalid${invalidReason ? `: ${invalidReason}` : ""}; ignoring it`);
  }
  return undefined;
}

function resolveClaudePath(input: {
  requested?: string;
  source: "env" | "agent" | "default";
  catalog: LocalConfigDirAlias[];
  home: string;
  ownerUid?: number;
  warn: (message: string) => void;
}): ResolvedRunnerSettings {
  if (!input.requested) return { configSource: "native" };
  const validated = validateClaudeConfigDir(input.requested, input.home, input.ownerUid);
  const alias = validated && input.catalog.find((entry) => entry.path === validated);
  if (!validated || !alias) {
    input.warn(`CLAUDE_CONFIG_DIR from ${input.source} is not an approved local profile; using native config`);
    return { configSource: "native" };
  }
  // Check a second time immediately before passing the path to the runner.
  const revalidated = revalidateClaudeConfigAlias(alias.path, input.catalog, input.home, input.ownerUid);
  if (revalidated !== alias.path) {
    input.warn(`Claude profile alias became invalid before spawn; using native config`);
    return { configSource: "native" };
  }
  return { configDir: revalidated, configAlias: { alias: alias.alias, label: alias.label }, configSource: input.source };
}

export function resolveRunnerSettings(input: {
  runner: CliRunner;
  agent: Pick<AgentInfo, "model" | "effort" | "claudeConfigDir">;
  defaults?: RunnerDefaultSetValue;
  configAliases: LocalRunnerConfigAliases;
  home: string;
  ownerUid?: number;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}): ResolvedRunnerSettings {
  const warn = input.warn ?? (() => {});
  const key = input.runner.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const model = choose([
    { source: "env", value: input.env?.[`THE_DUDES_${key}_MODEL`] },
    { source: "agent", value: input.agent.model },
    { source: "default", value: input.defaults?.model },
  ],
  (value): value is string => isValidRunnerModelFor(input.runner, value),
  warn,
  "model",
  input.runner === "dsh" ? `expected a compact JSON pair ["provider","model"] with two non-empty strings matching the safe model grammar (each <= ${RUNNER_DEFAULT_MODEL_MAX_LENGTH} chars; pair <= ${DSH_MODEL_PAIR_MAX_LENGTH} chars)` : undefined);
  const effort = choose([
    { source: "env", value: input.env?.[`THE_DUDES_${key}_EFFORT`] },
    { source: "agent", value: input.agent.effort },
    { source: "default", value: input.defaults?.effort },
  ], (value): value is EffortLevel => isCompatibleRunnerEffort(input.runner, model, value), warn, "effort");

  if (input.runner !== "claude") return { model, effort, configSource: "native" };
  // This operator-owned setting stays verbatim and above alias-based
  // server/agent settings; it is not constrained to a ~/.claude* alias.
  const envPath = input.env?.THE_DUDES_CLAUDE_CONFIG_DIR;
  if (envPath) {
    return { model, effort, configDir: envPath, configSource: "env" };
  }
  if (input.agent.claudeConfigDir?.trim()) {
    return { model, effort, ...resolveClaudePath({ requested: input.agent.claudeConfigDir.trim(), source: "agent", catalog: input.configAliases.claude, home: input.home, ownerUid: input.ownerUid, warn }) };
  }
  const aliasName = input.defaults?.claudeConfigDir;
  const alias = aliasName && input.configAliases.claude.find((item) => item.alias === aliasName);
  if (alias) {
    return { model, effort, ...resolveClaudePath({ requested: alias.path, source: "default", catalog: input.configAliases.claude, home: input.home, ownerUid: input.ownerUid, warn }) };
  }
  if (aliasName) warn("unknown Claude profile alias; using native config");
  return { model, effort, configSource: "native" };
}

/** Sanitizes one server update and drops every alias that was not discovered
 * locally. A malformed field cannot reach spawn even if a future schema
 * accidentally loosens validation. */
export function sanitizeRunnerDefaults(input: {
  defaults: RunnerDefaults;
  configAliases: LocalRunnerConfigAliases;
  warn?: (message: string) => void;
}): RunnerDefaults {
  const warn = input.warn ?? (() => {});
  const result: RunnerDefaults = {};
  for (const [name, value] of Object.entries(input.defaults)) {
    if (!value || typeof value !== "object") continue;
    const runner = name as CliRunner;
    const sanitized: RunnerDefaultSetValue = {};
    if (value.model !== undefined) {
      if (isValidRunnerModelFor(runner, value.model)) sanitized.model = value.model;
      else warn(`invalid ${runner} model default ignored${runner === "dsh" ? `: expected compact JSON ["provider","model"] with safe components (pair <= ${DSH_MODEL_PAIR_MAX_LENGTH} chars)` : ""}`);
    }
    if (value.effort !== undefined) {
      if (isCompatibleRunnerEffort(runner, sanitized.model, value.effort)) sanitized.effort = value.effort;
      else warn(`invalid ${runner} effort default ignored`);
    }
    if (runner === "claude" && value.claudeConfigDir !== undefined) {
      if (input.configAliases.claude.some((item) => item.alias === value.claudeConfigDir)) sanitized.claudeConfigDir = value.claudeConfigDir;
      else warn("unknown Claude profile alias ignored");
    }
    // Qwen aliases intentionally remain unsupported: QWEN_HOME contains the
    // per-agent bridge settings and token; it must stay daemon-managed/private.
    if (runner === "qwen" && value.qwenHome !== undefined) warn("qwenHome default ignored; QWEN_HOME stays private per agent");
    if (Object.keys(sanitized).length) result[runner] = sanitized;
  }
  return result;
}
