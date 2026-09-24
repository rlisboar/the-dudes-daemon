import type { ResolvedCliCommand } from "./cli-config.js";
import { RUNNERS, type CliRunner } from "@the-dudes/protocol";
import type { RunnerConfigDirStatus, RunnerStatusMap } from "@the-dudes/protocol/wire";
import { spawnDropped, type DropTarget } from "./privileges.js";
import type { ResolvedCliCommands } from "./cli-config.js";
import type { InstalledRunnerAvailability } from "./runner-policy.js";

const VERSION_RE = /\b(\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]{1,32})?)\b/;
const VERSION_TIMEOUT_MS = 2_500;
const VERSION_OUTPUT_CAP = 2_048;
const CONFIG_ALIAS_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Build only fields admitted by the shared health contract. Binary paths are
 * local read-only diagnostics; malformed/oversized values are omitted. */
export function buildRunnerStatusMap(input: {
  commands: ResolvedCliCommands;
  installed: InstalledRunnerAvailability;
  versions: Partial<Record<CliRunner, string>>;
  claudeConfigDir: RunnerConfigDirStatus;
}): RunnerStatusMap {
  const status: RunnerStatusMap = {};
  for (const runner of RUNNERS) {
    const command = input.commands[runner];
    const binary = command.resolvedPath;
    status[runner] = {
      installed: input.installed[runner] === true,
      ...(input.versions[runner] ? { version: input.versions[runner] } : {}),
      ...(input.installed[runner] === true && binary && binary.length <= 1_024 && !/[\u0000-\u001f\u007f]/.test(binary)
        ? { binary }
        : {}),
    };
  }
  const claudeStatus = status.claude;
  if (claudeStatus) {
    status.claude = {
      ...claudeStatus,
      claudeConfigDir: {
        source: input.claudeConfigDir.source,
        ...(input.claudeConfigDir.alias && CONFIG_ALIAS_RE.test(input.claudeConfigDir.alias)
          ? { alias: input.claudeConfigDir.alias }
          : {}),
      },
    };
  }
  return status;
}

/** Extract only a semver token. The CLI's raw output is never logged, stored,
 * or sent to the server. */
export function parseRunnerVersion(stdout: string, stderr = ""): string | undefined {
  const text = `${stdout}\n${stderr}`.slice(0, VERSION_OUTPUT_CAP);
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(VERSION_RE);
    if (match) return match[1];
  }
  return undefined;
}

/** Runs the detected binary directly with a minimal environment and bounded
 * time/output. No shell and no inherited daemon credentials. */
export function probeRunnerVersion(
  command: ResolvedCliCommand,
  dropTo: DropTarget | null,
  home: string,
  timeoutMs = VERSION_TIMEOUT_MS,
): Promise<string | undefined> {
  const binary = command.resolvedPath;
  if (!command.available || !binary) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawnDropped> | undefined;
    const timeout = setTimeout(() => {
      if (done) return;
      try { child?.kill("SIGTERM"); } catch { /* already exited */ }
      killTimer = setTimeout(() => {
        try { child?.kill("SIGKILL"); } catch { /* exited */ }
        finish();
      }, 100);
      killTimer.unref?.();
    }, Math.max(100, timeoutMs));
    timeout.unref?.();
    const finish = (value?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve(value);
    };
    try {
      child = spawnDropped(binary, ["--version"], {
        cwd: home,
        env: {
          HOME: home,
          PATH: dropTo?.path ?? process.env.PATH ?? "",
          LANG: "C",
          LC_ALL: "C",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }, dropTo);
    } catch {
      finish();
      return;
    }
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      if (stdout.length < VERSION_OUTPUT_CAP) stdout += text.slice(0, VERSION_OUTPUT_CAP - stdout.length);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      if (stderr.length < VERSION_OUTPUT_CAP) stderr += text.slice(0, VERSION_OUTPUT_CAP - stderr.length);
    });
    child.once("error", () => finish());
    child.once("close", (code: number | null) => {
      finish(code === 0 ? parseRunnerVersion(stdout, stderr) : undefined);
    });
  });
}
