import type { ChildProcess } from "node:child_process";
import http, { type ClientRequest } from "node:http";
import net from "node:net";
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

/** Default do boot. Medido no host com o serve 1.18.31: 17.8s e 54.5s até o
 *  1º /config 2xx (43.8s só para escutar). 10s matava um processo saudável. */
export const OPENCODE_BOOT_TIMEOUT_MS = 120_000;
/** Cada GET /config do probe. O 1º /config levou 9.2s (e 3.9s num serve já
 *  quente); 500ms nunca completava e o boot expirava com o serve saudável.
 *  Connection refused volta na hora, então isto só pesa com o serve escutando. */
export const OPENCODE_PROBE_TIMEOUT_MS = 15_000;

/**
 * T-703: porta loopback livre, escolhida ANTES do spawn e passada explícita
 * ao `serve --port`. Readiness é GET /config nessa porta, nunca o texto da
 * URL no stdout. Pedir ao SO (listen 0) evita colisão entre agents e com
 * serve órfão de um daemon anterior, que responderia /config e daria
 * ready falso.
 */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
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
    spawnServer: (port: number) => ChildProcess;
    /** Porta fixa (testes/stubs). Ausente: porta livre do SO a cada boot. */
    port?: number;
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
    const bootTimeoutMs = this.input.bootTimeoutMs ?? OPENCODE_BOOT_TIMEOUT_MS;
    const boot = (this.input.port != null ? Promise.resolve(this.input.port) : freeLoopbackPort()).then((port) => new Promise<void>((resolve, reject) => {
      if (this.stopped) { reject(new Error("serve encerrado")); return; }
      const process = this.input.spawnServer(port);
      this.serverProcess = process;
      let settled = false;
      const targetUrl = `http://127.0.0.1:${port}`;
      // Probe em voo = o serve já aceitou a conexão. Expirar o boot nesse
      // momento mataria um processo que está respondendo HTTP: o kill fica
      // para depois do desfecho desse probe.
      let probing = false;
      let timedOut = false;
      const failBoot = () => {
        settled = true;
        terminateWithEscalation(process);
        if (this.serverProcess === process) {
          this.serverProcess = null;
          this.bootPromise = null;
        }
        reject(new Error(`opencode serve boot timeout (${bootTimeoutMs / 1000}s)`));
      };
      const bootTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        if (!probing) failBoot();
      }, bootTimeoutMs);
      const probe = async () => {
        if (settled || this.serverProcess !== process) return;
        probing = true;
        let ok = false;
        try {
          await requestJson(targetUrl, "/config", "GET", undefined, OPENCODE_PROBE_TIMEOUT_MS);
          ok = true;
        } catch { /* ainda não escuta, ou respondeu não-2xx */ }
        probing = false;
        if (settled || this.serverProcess !== process) return;
        if (!ok) {
          if (timedOut) failBoot();
          else setTimeout(() => { void probe(); }, 100);
          return;
        }
        settled = true;
        clearTimeout(bootTimer);
        this.serverUrl = targetUrl;
        this.input.onReady?.(targetUrl);
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
      stdout.resume();
      stderr.resume();
      void probe();
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
    }));
    this.bootPromise = boot;
    void boot.catch(() => { if (this.bootPromise === boot) this.bootPromise = null; });
    return boot;
  }

  fetch(path: string, method: string, body?: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.serverUrl) return Promise.reject(new Error("serve não está pronto"));
    return requestJson(this.serverUrl, path, method, body, timeoutMs);
  }

  /** M19 (T-442): cancela o turno em voo NO SERVE. Matar o cliente/POST não
   *  aborta a run no serve — sem isto o retry do hard recover duplica side
   *  effects. Idempotente e best-effort no caller. */
  async abortSession(sessionId: string): Promise<void> {
    if (!this.serverUrl) return;
    await requestJson(this.serverUrl, `/session/${encodeURIComponent(sessionId)}/abort`, "POST");
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
