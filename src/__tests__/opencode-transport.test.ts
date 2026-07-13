import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { OpenCodeTransport, SseJsonDecoder, parseJsonResponse } from "../runners/opencode-transport.js";

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

test("OpenCode transport deduplicates boot and recognizes a URL split across chunks", async () => {
  const fake = new FakeServerProcess();
  let spawns = 0;
  let ready = "";
  const transport = new OpenCodeTransport({
    spawnServer: () => { spawns++; return fake.child(); },
    streamEvents: false,
    onReady: (url) => { ready = url; },
    bootTimeoutMs: 100,
  });
  const first = transport.ensureServer();
  const second = transport.ensureServer();
  fake.stdout.write("listening on http://127.0.");
  fake.stdout.write("0.1:4321\n");
  await Promise.all([first, second]);
  assert.equal(spawns, 1);
  assert.equal(ready, "http://127.0.0.1:4321");
  assert.equal(transport.ready(), true);
  transport.stop();
  assert.deepEqual(fake.signals, ["SIGTERM"]);
});

test("OpenCode transport clears a failed spawn so the next boot can retry", async () => {
  const fake = new FakeServerProcess();
  let attempts = 0;
  const transport = new OpenCodeTransport({
    spawnServer: () => {
      attempts++;
      if (attempts === 1) throw new Error("missing binary");
      return fake.child();
    },
    streamEvents: false,
    bootTimeoutMs: 100,
  });
  await assert.rejects(transport.ensureServer(), /missing binary/);
  await new Promise((resolve) => setImmediate(resolve));
  const retry = transport.ensureServer();
  fake.stdout.write("http://127.0.0.1:4322\n");
  await retry;
  assert.equal(attempts, 2);
  transport.stop();
});
