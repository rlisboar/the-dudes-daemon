import os from "node:os";
import type { ChildProcess } from "node:child_process";
import type { CliRunner } from "./types.js";
import type { ResolvedCliCommands } from "./cli-config.js";
import { spawnDropped, type DropTarget } from "./privileges.js";
import type { DiscoveredRunnerModel, RunnerModelCatalog } from "./protocol.js";
import { killProcess } from "./runners/process-lifecycle.js";
import { openCodeEffortsFor } from "./runners/opencode-effort.js";

const CACHE_TTL_MS = 5 * 60_000;
const COMMAND_TIMEOUT_MS = 12_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 2_000;
const RUNNERS: CliRunner[] = ["claude", "opencode", "gemini", "codex", "crush", "grok"];
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,199}$/;

function cleanLine(value: string): string {
  return value.replace(ANSI_RE, "").trim();
}

function safeDiscoveryEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["THE_DUDES_DAEMON_TOKEN", "THE_DUDES_TOKEN", "THE_DUDES_ENCRYPTION_KEY"]) delete env[key];
  env.NO_COLOR = "1";
  env.CI = "1";
  return env;
}

export function parseLineModelCatalog(output: string, runner: "opencode" | "crush" | "grok"): DiscoveredRunnerModel[] {
  const models: DiscoveredRunnerModel[] = [];
  const seen = new Set<string>();
  let advertisedDefault = "";
  for (const raw of output.split(/\r?\n/)) {
    const line = cleanLine(raw);
    const defaultHeader = line.match(/^Default model:\s*(\S+)/i);
    if (defaultHeader) advertisedDefault = defaultHeader[1];
    let id = line;
    let isDefault = false;
    if (runner === "grok") {
      const bullet = line.match(/^\*\s+([^\s]+)(?:\s+\(default\))?$/i);
      if (!bullet) continue;
      id = bullet[1];
      isDefault = /\(default\)$/i.test(line);
    }
    if (!MODEL_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: id,
      isDefault: isDefault || id === advertisedDefault || undefined,
      ...(runner === "opencode" ? { efforts: openCodeEffortsFor(id) } : {}),
    });
    if (models.length >= MAX_MODELS) break;
  }
  if (advertisedDefault && models.every((model) => !model.isDefault)) {
    const match = models.find((model) => model.id === advertisedDefault);
    if (match) match.isDefault = true;
  }
  return models;
}

export function parseCodexModelList(message: unknown): DiscoveredRunnerModel[] {
  const data = (message as { result?: { data?: unknown } })?.result?.data;
  if (!Array.isArray(data)) return [];
  const models: DiscoveredRunnerModel[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.model === "string" ? item.model : typeof item.id === "string" ? item.id : "";
    if (!MODEL_ID_RE.test(id) || seen.has(id) || item.hidden === true) continue;
    seen.add(id);
    const efforts = Array.isArray(item.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts
        .map((entry) => entry && typeof entry === "object" ? (entry as Record<string, unknown>).reasoningEffort : undefined)
        .filter((value): value is string => typeof value === "string" && value.length <= 32)
      : undefined;
    const inputModalities = Array.isArray(item.inputModalities)
      ? item.inputModalities.filter((value): value is string => typeof value === "string" && value.length <= 32)
      : undefined;
    models.push({
      id,
      label: typeof item.displayName === "string" ? item.displayName.slice(0, 120) : id,
      description: typeof item.description === "string" ? item.description.slice(0, 500) : undefined,
      isDefault: item.isDefault === true || undefined,
      efforts: efforts?.length ? efforts : undefined,
      inputModalities: inputModalities?.length ? inputModalities : undefined,
    });
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

function runCommand(command: string, args: string[], dropTo: DropTarget | null): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnDropped(command, args, {
        cwd: dropTo?.home ?? os.homedir(),
        env: safeDiscoveryEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }, dropTo);
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let size = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(stdout);
    };
    const append = (kind: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = String(chunk);
      size += Buffer.byteLength(text);
      if (size > MAX_OUTPUT_BYTES) {
        killProcess(child, "SIGKILL");
        finish(new Error("saída do catálogo excedeu o limite"));
        return;
      }
      if (kind === "stdout") stdout += text; else stderr += text;
    };
    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
    child.once("error", () => finish(new Error("não foi possível iniciar o CLI")));
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(cleanLine(stderr).slice(-300) || `CLI encerrou com código ${code ?? "?"}`));
    });
    const timer = setTimeout(() => {
      killProcess(child, "SIGKILL");
      finish(new Error("timeout consultando modelos"));
    }, COMMAND_TIMEOUT_MS);
  });
}

function discoverCodex(command: string, dropTo: DropTarget | null): Promise<DiscoveredRunnerModel[]> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnDropped(command, ["app-server", "--stdio"], {
        cwd: dropTo?.home ?? os.homedir(),
        env: safeDiscoveryEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      }, dropTo);
    } catch (error) {
      reject(error);
      return;
    }
    let buffer = "";
    let stderr = "";
    let size = 0;
    let settled = false;
    const finish = (models?: DiscoveredRunnerModel[], error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcess(child, "SIGKILL");
      if (error) reject(error); else resolve(models ?? []);
    };
    const write = (message: object) => child.stdin?.write(`${JSON.stringify(message)}\n`);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      size += Buffer.byteLength(text);
      if (size > MAX_OUTPUT_BYTES) {
        finish(undefined, new Error("saída do catálogo excedeu o limite"));
        return;
      }
      buffer += text;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          write({ method: "initialized", params: {} });
          write({ method: "model/list", id: 2, params: { limit: 100 } });
        } else if (message.id === 2) {
          const models = parseCodexModelList(message);
          if (models.length === 0) finish(undefined, new Error("Codex retornou catálogo vazio"));
          else finish(models);
        }
      }
    });
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-2_000); });
    child.once("error", () => finish(undefined, new Error("não foi possível iniciar o Codex app-server")));
    child.once("close", (code) => {
      if (!settled) finish(undefined, new Error(cleanLine(stderr).slice(-300) || `Codex encerrou com código ${code ?? "?"}`));
    });
    const timer = setTimeout(() => finish(undefined, new Error("timeout consultando modelos do Codex")), COMMAND_TIMEOUT_MS);
    write({
      method: "initialize",
      id: 1,
      params: { clientInfo: { name: "the-dudes-daemon", version: "0.1.0" }, capabilities: {} },
    });
  });
}

export class ModelDiscovery {
  private readonly cache = new Map<CliRunner, RunnerModelCatalog>();
  private readonly inFlight = new Map<CliRunner, Promise<RunnerModelCatalog>>();

  constructor(
    private readonly commands: ResolvedCliCommands,
    private readonly dropTo: DropTarget | null,
  ) {}

  async discover(runner: CliRunner, force = false): Promise<RunnerModelCatalog> {
    const cached = this.cache.get(runner);
    if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
    const active = this.inFlight.get(runner);
    if (active) return active;
    const discovery = this.discoverFresh(runner);
    this.inFlight.set(runner, discovery);
    try {
      return await discovery;
    } finally {
      if (this.inFlight.get(runner) === discovery) this.inFlight.delete(runner);
    }
  }

  private async discoverFresh(runner: CliRunner): Promise<RunnerModelCatalog> {
    const resolved = this.commands[runner];
    const fetchedAt = Date.now();
    if (!resolved.available) {
      const catalog: RunnerModelCatalog = { runner, models: [], source: "unsupported", fetchedAt, error: "CLI não instalado" };
      this.cache.set(runner, catalog);
      return catalog;
    }
    if (runner === "claude" || runner === "gemini") {
      const catalog: RunnerModelCatalog = {
        runner,
        models: [],
        source: "unsupported",
        fetchedAt,
        error: "este CLI não oferece listagem não interativa de modelos",
      };
      this.cache.set(runner, catalog);
      return catalog;
    }
    try {
      const models = runner === "codex"
        ? await discoverCodex(resolved.command, this.dropTo)
        : parseLineModelCatalog(
          await runCommand(resolved.command, ["models"], this.dropTo),
          runner as "opencode" | "crush" | "grok",
        );
      if (models.length === 0) throw new Error("CLI retornou catálogo vazio");
      const catalog: RunnerModelCatalog = {
        runner,
        models,
        source: runner === "codex" ? "codex-app-server" : "cli-command",
        fetchedAt,
      };
      this.cache.set(runner, catalog);
      return catalog;
    } catch (error) {
      const catalog: RunnerModelCatalog = {
        runner,
        models: [],
        source: runner === "codex" ? "codex-app-server" : "cli-command",
        fetchedAt,
        error: (error as Error).message.slice(0, 300),
      };
      this.cache.set(runner, catalog);
      return catalog;
    }
  }

  discoverMany(runner?: CliRunner, force = false): Promise<RunnerModelCatalog[]> {
    const targets = runner ? [runner] : RUNNERS;
    return Promise.all(targets.map((target) => this.discover(target, force)));
  }
}
