import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { collectProcessOutput, processAlive, terminateAndWait, terminateWithEscalation } from "../runners/process-lifecycle.js";

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
