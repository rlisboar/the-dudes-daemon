/**
 * T-442 (M19): hard recover do opencode aborta o turno NO SERVE antes do
 * retry — senão os side effects (tools) duplicam.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {chmodSync, mkdtempSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {spawn} from "node:child_process";
import {OpenCodeTransport} from "../runners/opencode-transport.js";
import {allRunnerSources} from "./_sources.js";

function bootScript(url: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t442-"));
  const stub = path.join(dir, "cli.mjs");
  writeFileSync(stub, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(url)} + "\\n");\nsetInterval(() => {}, 1000);\n`);
  chmodSync(stub, 0o755);
  return stub;
}

test("T-442: abortSession chama POST /session/:id/abort no serve", async () => {
  const hits: Array<{ method: string; url: string }> = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method ?? "", url: req.url ?? "" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const stub = bootScript(`http://127.0.0.1:${port}`);

  const transport = new OpenCodeTransport({
    spawnServer: () => {
      return spawn(process.execPath, [stub], { stdio: ["ignore", "pipe", "pipe"] });
    },
    streamEvents: false,
  });
  await transport.ensureServer();
  await transport.abortSession("ses_abc123");
  transport.stop();
  await new Promise<void>((r) => server.close(() => r()));

  assert.deepEqual(hits, [{ method: "POST", url: "/session/ses_abc123/abort" }]);
});

test("T-442: abortSession sem serve é no-op", async () => {
  const transport = new OpenCodeTransport({
    spawnServer: () => { throw new Error("não deve subir"); },
    streamEvents: false,
  });
  await transport.abortSession("s1");
});

test("T-442 wiring: recoverHungTurn aborta opencode antes de re-enfileirar", () => {
  const src = allRunnerSources(new URL("../agent-runner.ts", import.meta.url));
  const i = src.indexOf("private recoverHungTurn(");
  const bloco = src.slice(i, src.indexOf("private ", i + 20));
  const abort = bloco.indexOf("abortSession(");
  const bump = bloco.indexOf("this.messageSession.bumpEpoch();");
  assert.ok(abort > 0, "recoverHungTurn precisa abortar a sessão do opencode");
  assert.ok(abort < bump, "abort ANTES de bump/re-enqueue");
  assert.match(bloco, /this\.opts\.cliRunner === "opencode"/);
});