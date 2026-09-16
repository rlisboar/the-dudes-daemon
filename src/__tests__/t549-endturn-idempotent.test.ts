/**
 * T-549 (micro): endTurn é idempotente por epoch — segundo close do MESMO
 * epoch não repete release/drain; epoch novo continua a fechar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { endTurn } from "../runners/turns/end-turn.js";

function fakeSelf() {
  const session = {
    epoch: 7,
    busy: true,
    owns(epoch: number) { return epoch === session.epoch; },
    restoreFirstTurn(snap: unknown) { session.restored.push(snap); },
    restored: [] as unknown[],
  };
  const calls = { release: 0, drain: 0, idle: 0, exit: [] as Array<number | null>, cleanup: 0 };
  const self: any = {
    stopped: false,
    messageSession: session,
    releaseActiveTurnSlot: () => { calls.release += 1; },
    drainOcQueue: () => { calls.drain += 1; },
    setState: (s: string) => { if (s === "idle") calls.idle += 1; },
    emitExit: (c: number | null) => { calls.exit.push(c); },
  };
  return { self, calls, session };
}

test("T-549: duplo endTurn do mesmo epoch só limpa uma vez", () => {
  const { self, calls } = fakeSelf();
  const opts = { epoch: 7, code: 0, imgCleanup: () => { calls.cleanup += 1; } };
  endTurn(self, opts);
  endTurn(self, opts);
  assert.equal(calls.release, 1, "release uma vez");
  assert.equal(calls.drain, 1, "drain uma vez");
  assert.equal(calls.idle, 1);
  assert.equal(calls.cleanup, 1, "cleanup de anexos uma vez");
  assert.equal(self.messageSession.busy, false);
});

test("T-549: epoch NOVO após o primeiro endTurn volta a fechar (guard não é global)", () => {
  const { self, calls, session } = fakeSelf();
  endTurn(self, { epoch: 7, code: 0 });
  session.epoch = 8;
  session.busy = true;
  endTurn(self, { epoch: 8, code: 1 });
  assert.equal(calls.release, 2);
  assert.equal(calls.idle, 2);
});

test("T-549: stopped emite exit mesmo no epoch repetido (teardown do stop)", () => {
  const { self, calls } = fakeSelf();
  self.stopped = true;
  endTurn(self, { epoch: 7, code: null });
  endTurn(self, { epoch: 7, code: 0 });
  assert.deepEqual(calls.exit, [null, 0], "emitExit em cada close com stopped");
});
