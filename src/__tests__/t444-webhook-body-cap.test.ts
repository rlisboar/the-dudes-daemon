/**
 * T-444 (M21): body do webhook com timeout cobrindo a leitura e cap duro —
 * `resp.text()` pendurava para sempre com body infinito.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ReadableStream } from "node:stream/web";
import { dispatchWebhook, readCapped, WEBHOOK_BODY_CAP_BYTES } from "../webhook-dispatch.js";

test("T-444: readCapped corta no cap e não espera o EOF", async () => {
  let pulls = 0;
  const body = { body: new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(1000).fill(65)); } }) as never };
  const out = await readCapped(body, 2500);
  assert.equal(out.length, 2500);
  assert.ok(pulls <= 4, `cancelou cedo (pulls=${pulls})`);
});

test("T-444: readCapped com body finito normal", async () => {
  const body = { body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("ok")); c.close(); } }) as never };
  assert.equal(await readCapped(body, 1024), "ok");
  assert.equal(await readCapped({ body: null }, 1024), "");
});

test("T-444 integração: webhook com body infinito resolve (antes pendurava)", async () => {
  const http = await import("node:http");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("[");
    const chunk = " ".repeat(8192);
    const tm = setInterval(() => res.write(chunk), 2);
    res.on("close", () => clearInterval(tm));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const r = await Promise.race([
    dispatchWebhook({
      event: { type: "task:done", ts: Date.now() },
      projectId: "p1", projectName: "P", url: `http://127.0.0.1:${port}/wh`,
      secret: null, format: "json",
    }),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("dispachou? pendurou >8s")), 8_000)),
  ]);
  server.close();
  assert.equal(r.status, 200);
  assert.ok(r.body.length > 0 && r.body.length <= 2000);
});

test("T-444 wiring: timeout abrange o body (clearTimeout só no finally)", () => {
  const src = readFileSync(new URL("../webhook-dispatch.ts", import.meta.url), "utf8");
  const i = src.indexOf("export async function dispatchWebhook");
  const bloco = src.slice(i, i + 4200);
  assert.match(bloco, /const tm = setTimeout\(\(\) => ctrl\.abort\(\), 10_000\)/);
  assert.match(bloco, /readCapped\(resp, WEBHOOK_BODY_CAP_BYTES\)/);
  assert.match(bloco, /\} finally \{\s*clearTimeout\(tm\);/);
  assert.ok(bloco.indexOf("readCapped(") < bloco.indexOf("clearTimeout(tm)"), "body lido antes do clear");
  assert.equal(WEBHOOK_BODY_CAP_BYTES, 256 * 1024);
});
