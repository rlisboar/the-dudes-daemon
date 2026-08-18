import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  appendCapped,
  collectProcessOutput,
  processAlive,
  RUNNER_OUTPUT_CAP_BYTES,
  RUNNER_OUTPUT_TRUNC_MARK,
  terminateAndWait,
  terminateWithEscalation,
} from "../runners/process-lifecycle.js";

class FakeProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  exitOnSignal = false;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.signals.push(signal);
    if (this.exitOnSignal) {
      this.signalCode = signal;
      this.emit("exit", null, signal);
    }
    return true;
  }

  child(): ChildProcess { return this as unknown as ChildProcess; }
}

test("process liveness uses exit and signal codes instead of the killed flag", () => {
  const fake = new FakeProcess();
  fake.killed = true;
  assert.equal(processAlive(fake.child()), true);
  fake.signalCode = "SIGTERM";
  assert.equal(processAlive(fake.child()), false);
});

test("process output collection captures both streams and settles on close", async () => {
  const fake = new FakeProcess();
  const resultPromise = collectProcessOutput(fake.child(), { timeoutMs: 100 });
  fake.stdout.write("hello");
  fake.stderr.write("warning");
  fake.emit("close", 0, null);
  const result = await resultPromise;
  assert.deepEqual(result, { stdout: "hello", stderr: "warning", code: 0, timedOut: false });
});

test("process output collection settles directly on timeout even without close", async () => {
  const fake = new FakeProcess();
  const result = await collectProcessOutput(fake.child(), { timeoutMs: 5 });
  assert.equal(result.timedOut, true);
  assert.deepEqual(fake.signals, ["SIGKILL"]);
});

test("T-069: appendCapped corta no teto e marca; abaixo do teto inalterado", () => {
  const small = appendCapped("hello", " world");
  assert.equal(small.text, "hello world");
  assert.equal(small.truncated, false);
  assert.equal(small.justHit, false);

  const first = appendCapped("x".repeat(16), "y".repeat(16), 20);
  assert.equal(first.truncated, true);
  assert.equal(first.justHit, true);
  assert.ok(first.text.includes(RUNNER_OUTPUT_TRUNC_MARK));
  assert.ok(Buffer.byteLength(first.text, "utf8") < 20 + RUNNER_OUTPUT_TRUNC_MARK.length + 4);

  const again = appendCapped(first.text, "zzzz", 20);
  assert.equal(again.text, first.text);
  assert.equal(again.justHit, false);
  assert.equal(again.truncated, true);
});

test("T-069: collectProcessOutput com saída > cap não derruba e trunca", async () => {
  const fake = new FakeProcess();
  const logs: string[] = [];
  const resultPromise = collectProcessOutput(fake.child(), {
    timeoutMs: 1000,
    onTruncated: (stream) => logs.push(stream),
  });
  fake.stdout.write("ok-");
  fake.stdout.write("x".repeat(RUNNER_OUTPUT_CAP_BYTES));
  fake.stdout.write("SHOULD-NOT-APPEAR");
  fake.emit("close", 0, null);
  const result = await resultPromise;
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.startsWith("ok-"));
  assert.ok(result.stdout.includes(RUNNER_OUTPUT_TRUNC_MARK));
  assert.equal(result.stdout.includes("SHOULD-NOT-APPEAR"), false);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") < RUNNER_OUTPUT_CAP_BYTES + RUNNER_OUTPUT_TRUNC_MARK.length + 8);
  assert.deepEqual(logs, ["stdout"]);
});

test("termination escalates and terminateAndWait handles synchronous exit", async () => {
  const wedged = new FakeProcess();
  terminateWithEscalation(wedged.child(), 5);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(wedged.signals, ["SIGTERM", "SIGKILL"]);

  const cooperative = new FakeProcess();
  cooperative.exitOnSignal = true;
  await terminateAndWait(cooperative.child(), { graceMs: 5, maxWaitMs: 20 });
  assert.deepEqual(cooperative.signals, ["SIGTERM"]);
});
