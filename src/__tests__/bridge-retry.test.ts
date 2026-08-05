/**
 * T-037: retry do mcp-bridge em erros transitórios.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransientBridgeError, withBridgeRetry } from "../bridge-retry.js";

test("classifica 502, ECONNREFUSED, timeout como transitórios", () => {
  assert.equal(isTransientBridgeError(new Error("bridge send 502: bad gateway")), true);
  assert.equal(isTransientBridgeError(new Error("connect ECONNREFUSED /tmp/bridge.sock")), true);
  assert.equal(isTransientBridgeError(new Error("bridge send timeout após 30000ms")), true);
  assert.equal(isTransientBridgeError(new Error("bridge send 404: agent not found")), false);
  assert.equal(isTransientBridgeError(new Error("hierarchy violation")), false);
});

test("retry: falha 2× com ECONNREFUSED e sucede na 3ª", async () => {
  let n = 0;
  const delays: number[] = [];
  const result = await withBridgeRetry(
    async () => {
      n++;
      if (n < 3) throw new Error("connect ECONNREFUSED 127.0.0.1");
      return { ok: true };
    },
    {
      attempts: 4,
      baseDelayMs: 10,
      sleep: async (ms) => { delays.push(ms); },
    },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(n, 3);
  assert.equal(delays.length, 2);
  assert.equal(delays[0], 10);
  assert.equal(delays[1], 20);
});

test("retry: 404 não re-tenta (erro permanente)", async () => {
  let n = 0;
  await assert.rejects(
    () =>
      withBridgeRetry(
        async () => {
          n++;
          throw new Error("bridge send 404: agent not in any project");
        },
        { attempts: 4, baseDelayMs: 1, sleep: async () => {} },
      ),
    /404/,
  );
  assert.equal(n, 1, "não deve retentar em 404");
});

test("retry: esgota attempts e propaga último erro", async () => {
  let n = 0;
  await assert.rejects(
    () =>
      withBridgeRetry(
        async () => {
          n++;
          throw new Error("bridge send 502");
        },
        { attempts: 3, baseDelayMs: 1, sleep: async () => {} },
      ),
    /502/,
  );
  assert.equal(n, 3);
});
