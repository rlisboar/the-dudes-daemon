/* R7 (T-462): support extraído do agent-runner — `self` é o AgentRunner. */
import {CliRunner} from "../types.js";
import {statSync} from "node:fs";
import {recordCliIo} from "../debug/store.js";
export function traceCli(self: any, runner: CliRunner, direction: "spawn" | "argv" | "stdin" | "stdout" | "stderr", text: string) {
    // T-812: contadores de I/O por agente (sempre) + captura opt-in do dashboard.
    try { recordCliIo(String(self.info?.id ?? "?"), runner, direction, String(text ?? "")); } catch { /* observação */ }
    if (!self.opts.verbose) return;
    if (self.opts.verboseHumanIo) {
      if (direction === "stderr" || direction === "spawn") return;
      const rendered = self.renderVerboseIoBlock(runner, direction, text);
      if (rendered) self.opts.cliLog("info", rendered);
      return;
    }
    if (self.opts.verboseHuman) {
      if (direction === "spawn") {
        self.opts.cliLog("info", `cli ${runner} spawn ${text}`);
        return;
      }
      const rendered = self.renderVerboseBlock(runner, direction, text);
      if (rendered) self.opts.cliLog("info", rendered);
      return;
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      self.opts.cliLog("info", `[cli:${self.info.id}:${runner}:${direction}] ${trimmed}`);
    }
  }
export function traceSpawn(self: any, runner: CliRunner, args: string[]) {
    if (!self.opts.verbose) return;
    if (self.opts.verboseHumanIo) return;
    if (self.opts.verboseHuman) {
      const lines = [
        `cli ${runner} spawn`,
        `  command: ${self.runnerCommand(runner)}`,
        `  args:`,
        ...args.map((a) => `    ${a}`),
      ];
      self.opts.cliLog("info", lines.join("\n"));
      return;
    }
    self.opts.cliLog("info", `[cli:${self.info.id}:${runner}:spawn] ${self.runnerCommand(runner)} ${args.map((a) => JSON.stringify(a)).join(" ")}`);
  }
export function renderVerboseIoBlock(self: any, _runner: CliRunner, _direction: "argv" | "stdin" | "stdout", text: string): string {
    const lines = text.replace(/\r/g, "").split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
    if (lines.length === 0) return "";
    const bodyLines: string[] = [];
    for (const line of lines) {
      const body = self.extractVerbosePayload(line);
      if (!body) continue;
      bodyLines.push(...body.split("\n").filter((chunk: any) => chunk.trim().length > 0));
    }
    if (bodyLines.length === 0) return "";
    const body = bodyLines.join("\n").trim();
    if (!body) return "";
    const now = Date.now();
    if (body === self.lastVerboseIoBody && now - self.lastVerboseIoAt < 10_000) return "";
    self.lastVerboseIoBody = body;
    self.lastVerboseIoAt = now;
    const agent = self.colorizeAgentName(self.info.name);
    return [agent, ...bodyLines.map((chunk) => `  ${chunk}`)].join("\n");
  }
export function traceInternalCli(self: any, level: "info" | "warn" | "error", msg: string) {
    if (self.opts.verboseHumanIo) return;
    self.opts.cliLog(level, msg);
  }
export function renderVerboseBlock(self: any, runner: CliRunner, direction: "argv" | "stdin" | "stdout" | "stderr", text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return "";
    const header = `cli ${runner} ${direction}`;
    const body = self.prettyPrintVerboseText(trimmed);
    return [header, ...body.split("\n").map((line: any) => `  ${line}`)].join("\n");
  }
export function colorizeAgentName(self: any, name: string): string {
    if (!self.supportsAnsi()) return name;
    const rgb = self.hexToRgb(self.info.color);
    if (!rgb) return name;
    return `\u001b[1m\u001b[38;2;${rgb.r};${rgb.g};${rgb.b}m${name}\u001b[0m`;
  }
export function supportsAnsi(_self: any, ): boolean {
    return !!(process.stdout.isTTY || process.stderr.isTTY);
  }
export function hexToRgb(self: any, hex: string): { r: number; g: number; b: number } | null {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = Number.parseInt(m[1], 16);
    return {
      r: (n >> 16) & 0xff,
      g: (n >> 8) & 0xff,
      b: n & 0xff,
    };
  }
export function extractVerbosePayload(self: any, text: string): string {
    const compact = text.trim();
    if (!compact) return "";
    if (compact.startsWith("{") || compact.startsWith("[")) {
      try {
        const parsed = JSON.parse(compact);
        return self.extractValueText(parsed);
      } catch {
        // fall through to raw text
      }
    }
    return compact.replace(/\t/g, "  ");
  }
export function extractValueText(self: any, value: unknown): string {
    if (value == null) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      return value.map((item) => self.extractValueText(item)).filter(Boolean).join("\n").trim();
    }
    if (typeof value !== "object") return "";
    const obj = value as Record<string, unknown>;
    if (obj.type === "rate_limit_event") return "";
    if (obj.type === "thinking") return "";
    if (obj.type === "tool_use") {
      const input = typeof obj.input === "object" && obj.input
        ? obj.input as Record<string, unknown>
        : {};
      if (typeof input.command === "string" && input.command.trim()) return input.command.trim();
      return self.extractValueText(input.content ?? input.text ?? input.message);
    }
    if (typeof obj.type === "string" && obj.type === "tool_result") {
      const pieces: string[] = [];
      for (const key of ["content", "stdout", "output", "text", "message", "result"] as const) {
        const extracted = self.extractValueText(obj[key]);
        if (extracted) pieces.push(extracted);
      }
      return pieces.join("\n").trim();
    }
    if (typeof obj.type === "string" && obj.type === "text" && typeof obj.text === "string") {
      return obj.text.trim();
    }
    if (typeof obj.text === "string" && obj.text.trim()) return obj.text.trim();
    if (typeof obj.content !== "undefined") return self.extractValueText(obj.content);
    if (typeof obj.message !== "undefined") return self.extractValueText(obj.message);
    if (typeof obj.tool_result !== "undefined") return self.extractValueText(obj.tool_result);
    if (typeof obj.output !== "undefined") return self.extractValueText(obj.output);
    if (typeof obj.stdout !== "undefined") return self.extractValueText(obj.stdout);
    if (typeof obj.stderr !== "undefined") return self.extractValueText(obj.stderr);
    if (typeof obj.result !== "undefined") return self.extractValueText(obj.result);
    return "";
  }
export function prettyPrintVerboseText(self: any, text: string): string {
    const compact = text.trim();
    if (!compact) return "";
    if (compact.startsWith("{") || compact.startsWith("[")) {
      try {
        return JSON.stringify(JSON.parse(compact), null, 2);
      } catch {}
    }
    const lines = compact.replace(/\r/g, "").split("\n");
    return lines
      .map((line) => line.replace(/\t/g, "  "))
      .join("\n");
  }
  /** Remove o tmpdir do agente (token plaintext + sessions). Best-effort,
   *  chamado no fim de vida pra não deixar token válido em /tmp. */
export function cleanupAgentTmpDir(self: any, ): void {
    self.runtimeFiles.cleanup();
  }
export function grokSessionRecentWrite(self: any, withinMs: number): boolean {
    const sid = self.messageSession.sessionId;
    if (!sid) return false;
    const now = Date.now();
    const paths = [
      ...self.grokSignalsCandidates(sid),
      ...self.grokUpdatesCandidates(sid),
    ];
    for (const p of paths) {
      try {
        if (now - statSync(p).mtimeMs < withinMs) return true;
      } catch { /* missing */ }
    }
    return false;
  }