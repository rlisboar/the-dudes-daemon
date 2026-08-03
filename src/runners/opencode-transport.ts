import type { ChildProcess } from "node:child_process";
import http, { type ClientRequest } from "node:http";
import { terminateWithEscalation } from "./process-lifecycle.js";

export class SseJsonDecoder {
  private buffer = "";

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const events: unknown[] = [];
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      try { events.push(JSON.parse(json)); } catch {}
    }
    return events;
  }
}

export function parseJsonResponse(status: number, text: string): unknown {
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}${text ? ` — ${text.slice(0, 200)}` : ""}`);
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

export function requestJson(baseUrl: string, requestPath: string, method: string, body?: unknown, timeoutMs = 20_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try { url = new URL(baseUrl + requestPath); } catch (error) { reject(error as Error); return; }
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
      timeout: timeoutMs,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const status = response.statusCode ?? 0;
        try { resolve(parseJsonResponse(status, text)); } catch (error) { reject(error as Error); }
      });
      response.on("error", (error) => reject(new Error(`resposta interrompida: ${error.message}`)));
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error(`timeout ${timeoutMs}ms`)));
    if (data) request.write(data);
    request.end();
  });
}

export class OpenCodeTransport {
  private serverProcess: ChildProcess | null = null;
  private serverUrl?: string;
  private bootPromise: Promise<void> | null = null;
  private eventRequest: ClientRequest | null = null;
  private reopenTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly input: {
    // ChildProcess (não ...WithoutNullStreams): o serve sobe com
    // stdio ['ignore','pipe','pipe'], ou seja stdin nulo por construção.
    spawnServer: () => ChildProcess;
    streamEvents: boolean;
    onReady?: (url: string) => void;
    onExit?: (code: number | null) => void;
    onEvent?: (event: unknown) => void;
    bootTimeoutMs?: number;
    reconnectMs?: number;
  }) {}

  ready(): boolean { return !!this.serverUrl; }
  url(): string | undefined { return this.serverUrl; }

  ensureServer(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("serve encerrado"));
    if (this.serverUrl) return Promise.resolve();
    if (this.bootPromise) return this.bootPromise;
    const boot = new Promise<void>((resolve, reject) => {
      const process = this.input.spawnServer();
      this.serverProcess = process;
      let settled = false;
      let bootOutput = "";
      const bootTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        terminateWithEscalation(process);
        if (this.serverProcess === process) {
          this.serverProcess = null;
          this.bootPromise = null;
        }
        reject(new Error(`opencode serve boot timeout (${(this.input.bootTimeoutMs ?? 10_000) / 1000}s)`));
      }, this.input.bootTimeoutMs ?? 10_000);
      const onData = (chunk: string) => {
        bootOutput = (bootOutput + chunk).slice(-4_096);
        const match = bootOutput.match(/https?:\/\/[\w.:-]+:\d+/);
        if (!match || settled || this.serverProcess !== process) return;
        settled = true;
        clearTimeout(bootTimer);
        this.serverUrl = match[0];
        this.input.onReady?.(match[0]);
        if (this.input.streamEvents) this.startEventStream();
        resolve();
      };
      const { stdout, stderr } = process;
      if (!stdout || !stderr) {
        clearTimeout(bootTimer);
        settled = true;
        terminateWithEscalation(process);
        reject(new Error("opencode serve: stdout/stderr não foram pipeados"));
        return;
      }
      stdout.setEncoding("utf8");
      stderr.setEncoding("utf8");
      stdout.on("data", onData);
      stderr.on("data", onData);
      process.once("exit", (code) => {
        clearTimeout(bootTimer);
        if (this.serverProcess === process) {
          this.serverProcess = null;
          this.serverUrl = undefined;
          this.bootPromise = null;
          this.closeEventStream();
        }
        if (!settled) {
          settled = true;
          reject(new Error(`opencode serve exited before listening (code ${code})`));
        } else if (!this.stopped) this.input.onExit?.(code);
      });
    });
    this.bootPromise = boot;
    void boot.catch(() => { if (this.bootPromise === boot) this.bootPromise = null; });
    return boot;
  }

  fetch(path: string, method: string, body?: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.serverUrl) return Promise.reject(new Error("serve não está pronto"));
    return requestJson(this.serverUrl, path, method, body, timeoutMs);
  }

  stop(): void {
    this.stopped = true;
    this.closeEventStream();
    terminateWithEscalation(this.serverProcess);
    this.serverProcess = null;
    this.serverUrl = undefined;
    this.bootPromise = null;
  }

  private startEventStream(): void {
    if (!this.input.streamEvents || !this.serverUrl || this.eventRequest || this.stopped) return;
    const url = new URL(this.serverUrl + "/event");
    const decoder = new SseJsonDecoder();
    const request = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: "GET", headers: { Accept: "text/event-stream" },
    }, (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        for (const event of decoder.push(chunk)) this.input.onEvent?.(event);
      });
      response.on("end", () => this.reopenEvents(request));
      response.on("error", () => this.reopenEvents(request));
    });
    this.eventRequest = request;
    request.on("error", () => this.reopenEvents(request));
    request.end();
  }

  private reopenEvents(request: ClientRequest): void {
    if (this.eventRequest !== request) return;
    this.eventRequest = null;
    if (this.stopped || !this.input.streamEvents || !this.serverUrl) return;
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = undefined;
      this.startEventStream();
    }, this.input.reconnectMs ?? 1_000);
  }

  private closeEventStream(): void {
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    this.reopenTimer = undefined;
    try { this.eventRequest?.destroy(); } catch {}
    this.eventRequest = null;
  }
}
