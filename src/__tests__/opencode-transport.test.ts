import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import http from "node:http";
import { OPENCODE_BOOT_TIMEOUT_MS, OPENCODE_PROBE_TIMEOUT_MS, OpenCodeTransport, SseJsonDecoder, freeLoopbackPort, parseJsonResponse } from "../runners/opencode-transport.js";

class FakeServerProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.signalCode = signal;
    this.emit("exit", null, signal);
    return true;
  }
  child(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
}

test("SSE decoder preserves partial lines and ignores malformed payloads", () => {
  const decoder = new SseJsonDecoder();
  assert.deepEqual(decoder.push('data: {"type":"permission.'), []);
  assert.deepEqual(decoder.push('asked","properties":{"id":"p"}}\r\ndata: nope\n'), [
    { type: "permission.asked", properties: { id: "p" } },
  ]);
});

test("JSON transport parses successful responses and includes bounded error bodies", () => {
  assert.deepEqual(parseJsonResponse(200, '{"ready":true}'), { ready: true });
  assert.deepEqual(parseJsonResponse(204, ""), {});
  assert.deepEqual(parseJsonResponse(200, "not-json"), {});
  assert.throws(() => parseJsonResponse(503, "provider unavailable"), /HTTP 503 — provider unavailable/);
  assert.throws(() => parseJsonResponse(500, "x".repeat(300)), (error: unknown) => {
    assert.ok(error instanceof Error);
    return error.message.length < 220;
  });
});

async function configServer(): Promise<{ port: number; url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => { res.writeHead(200, {"content-type":"application/json"}); res.end("{}"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { port, url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test("OpenCode transport becomes ready through /config even when serve prints no URL", async () => {
  const httpd = await configServer();
  const fake = new FakeServerProcess();
  let spawns = 0;
  let ready = "";
  let spawnedPort = 0;
  const transport = new OpenCodeTransport({
    spawnServer: (port) => { spawns++; spawnedPort = port; return fake.child(); },
    port: httpd.port,
    streamEvents: false,
    onReady: (url) => { ready = url; },
    bootTimeoutMs: 1_000,
  });
  const first = transport.ensureServer();
  const second = transport.ensureServer();
  await Promise.all([first, second]);
  assert.equal(spawns, 1);
  assert.equal(spawnedPort, httpd.port, "serve recebe a porta explícita");
  assert.equal(ready, httpd.url);
  assert.deepEqual(fake.signals, [], "processo que já responde HTTP não é morto no boot");
  assert.equal(transport.ready(), true);
  transport.stop();
  await httpd.close();
  assert.deepEqual(fake.signals, ["SIGTERM"]);
});

test("OpenCode transport clears a failed spawn so the next boot can retry", async () => {
  const httpd = await configServer();
  const fake = new FakeServerProcess();
  let attempts = 0;
  const transport = new OpenCodeTransport({
    spawnServer: () => {
      attempts++;
      if (attempts === 1) throw new Error("missing binary");
      return fake.child();
    },
    port: httpd.port,
    streamEvents: false,
    bootTimeoutMs: 1_000,
  });
  await assert.rejects(transport.ensureServer(), /missing binary/);
  await new Promise((resolve) => setImmediate(resolve));
  const retry = transport.ensureServer();
  await retry;
  assert.equal(attempts, 2);
  transport.stop();
  await httpd.close();
});

test("OpenCode transport times out when serve never listens", async () => {
  const fake = new FakeServerProcess();
  const transport = new OpenCodeTransport({ spawnServer: () => fake.child(), port: await freeLoopbackPort(), streamEvents: false, bootTimeoutMs: 50 });
  await assert.rejects(transport.ensureServer(), /boot timeout/);
  assert.ok(fake.signals.length > 0, "processo que nunca escuta é encerrado");
});

test("T-703: serve lento (sem URL no stdout) que só escuta depois de um tempo fica ready e não é morto", async () => {
  const port = await freeLoopbackPort();
  const fake = new FakeServerProcess();
  let httpd: { close: () => Promise<void> } | null = null;
  const transport = new OpenCodeTransport({
    spawnServer: (p) => {
      // Escuta só após 400ms e não escreve nada no stdout (OpenCode 1.18.31).
      setTimeout(() => {
        const server = http.createServer((_req, res) => { res.writeHead(200); res.end("{}"); });
        server.listen(p, "127.0.0.1");
        httpd = { close: () => new Promise((resolve) => server.close(() => resolve())) };
      }, 400);
      return fake.child();
    },
    port,
    streamEvents: false,
    bootTimeoutMs: 3_000,
  });
  await transport.ensureServer();
  assert.equal(transport.url(), `http://127.0.0.1:${port}`);
  assert.deepEqual(fake.signals, []);
  transport.stop();
  await httpd!.close();
});

test("T-703: sem porta fixa, o transporte escolhe porta loopback livre e a passa ao serve", async () => {
  const fake = new FakeServerProcess();
  let spawnedPort = 0;
  const transport = new OpenCodeTransport({
    spawnServer: (p) => { spawnedPort = p; return fake.child(); },
    streamEvents: false,
    bootTimeoutMs: 50,
  });
  await assert.rejects(transport.ensureServer(), /boot timeout/);
  assert.ok(spawnedPort > 0 && spawnedPort < 65_536, "porta explícita, nunca 0");
});

test("T-703: /config lento em voo quando o boot expira — ready, processo NÃO é morto", async () => {
  // Serve escuta na hora, mas o 1º /config demora 600ms (medido: 9.2s no real).
  const server = http.createServer((_req, res) => { setTimeout(() => { res.writeHead(200); res.end("{}"); }, 600); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const fake = new FakeServerProcess();
  const transport = new OpenCodeTransport({ spawnServer: () => fake.child(), port, streamEvents: false, bootTimeoutMs: 200 });
  await transport.ensureServer();
  assert.equal(transport.ready(), true);
  assert.deepEqual(fake.signals, []);
  transport.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("T-703: serve que responde não-2xx no /config não fica ready e expira", async () => {
  const server = http.createServer((_req, res) => { res.writeHead(503); res.end("booting"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const fake = new FakeServerProcess();
  const transport = new OpenCodeTransport({ spawnServer: () => fake.child(), port, streamEvents: false, bootTimeoutMs: 300 });
  await assert.rejects(transport.ensureServer(), /boot timeout/);
  assert.equal(transport.ready(), false);
  assert.ok(fake.signals.length > 0);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("T-703: defaults cobrem o boot medido do serve 1.18.31 (54.5s; 1º /config 9.2s)", () => {
  assert.ok(OPENCODE_BOOT_TIMEOUT_MS >= 90_000);
  assert.ok(OPENCODE_PROBE_TIMEOUT_MS >= 10_000);
});
