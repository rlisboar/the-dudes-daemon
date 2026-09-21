/**
 * T-768: filtro por FERRAMENTA no ponto de injeção.
 * 1) wrapToolFilteredServers troca servidor com `tools` por um proxy stdio
 *    nosso (o resto passa igual — compat).
 * 2) O proxy de verdade FILTRA tools/list: é o que o agente enxerga.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wrapToolFilteredServers } from "../runners/mcp-config.js";

const UPSTREAM = `#!/usr/bin/env node
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!l.trim()) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "od", version: "1" } } });
    if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [
      { name: "read_file", inputSchema: { type: "object" } },
      { name: "write_file", inputSchema: { type: "object" } },
      { name: "delete_project", inputSchema: { type: "object" } },
    ] } });
    if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok:" + m.params.name }] } });
  }
});
setInterval(() => {}, 1000);
process.stdin.on("end", () => process.exit(0));
`;

interface ProxyHandle { proc: import("node:child_process").ChildProcess; request(method: string, params?: unknown): Promise<any>; }

function startProxy(spec: unknown): ProxyHandle {
  const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../mcp-tool-proxy.ts", import.meta.url)), JSON.stringify(spec)],
    { cwd: path.resolve("."), stdio: ["pipe", "pipe", "pipe"], detached: true });
  let buf = ""; const pending = new Map<number, (v: any) => void>();
  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (c: string) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!l.trim()) continue;
      try { const m = JSON.parse(l); if (m.id != null && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } } catch { /* */ }
    }
  });
  let id = 0;
  return {
    proc,
    request: (method, params) => new Promise((resolve) => {
      const myId = ++id; pending.set(myId, resolve);
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    }),
  };
}

test("T-768: proxy filtra tools/list (agente não vê a negada) e faz passthrough de tools/call", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t768-"));
  const upstream = path.join(dir, "up.mjs");
  writeFileSync(upstream, UPSTREAM); chmodSync(upstream, 0o755);
  const h = startProxy({ tools: ["read_file", "delete_project"], upstream: { transport: "stdio", command: process.execPath, args: [upstream] } });
  try {
    const init = await h.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal((init.result as any).serverInfo.name, "od", "initialize passa pelo proxy");
    const list = await h.request("tools/list", {});
    const names = ((list.result as any).tools as Array<{ name: string }>).map((t) => t.name);
    assert.deepEqual(names, ["read_file", "delete_project"], `write_file NÃO pode chegar ao agente: ${names}`);
    const call = await h.request("tools/call", { name: "read_file", arguments: {} });
    assert.match((call.result as any).content[0].text, /ok:read_file/, "tools/call passthrough");
  } finally {
    h.proc.stdin!.end();
    h.proc.kill("SIGTERM");
    await new Promise((r) => { h.proc.once("exit", r); setTimeout(r, 1500); });
    try { process.kill(-h.proc.pid!, "SIGKILL"); } catch { /* já morreu */ }
  }
});

test("T-768: wrap só mexe em servidor com `tools`; o resto passa idêntico (compat)", () => {
  const bridge = { command: "node", args: ["/x/mcp-bridge.cjs"], env: {} };
  const extras = {
    "the-dudes": { type: "stdio" as const, command: "node", args: ["b.cjs"] },
    OpenDesign: { type: "http" as const, url: "http://127.0.0.1:7456/mcp", headers: { "x-a": "1" }, tools: ["read_file"] },
    Graph: { type: "stdio" as const, command: "/g/graphify-mcp", args: ["/g/graph.json"], tools: [] },
    Plain: { type: "stdio" as const, command: "/p/x" },
  };
  const wrapped = wrapToolFilteredServers(extras, bridge)!;
  assert.deepEqual(wrapped["the-dudes"], extras["the-dudes"], "the-dudes intacto");
  assert.deepEqual(wrapped.Plain, extras.Plain, "servidor sem tools intacto");
  for (const name of ["OpenDesign", "Graph"]) {
    const w = wrapped[name]!;
    assert.equal(w.command, "node", `${name} vira proxy no binário do bridge`);
    assert.equal(w.args![1], "--mcp-proxy");
    const spec = JSON.parse(w.args![2]!);
    assert.deepEqual(spec.tools, extras[name as "OpenDesign" | "Graph"].tools);
    assert.equal(spec.upstream.transport, name === "OpenDesign" ? "http" : "stdio");
    assert.equal(spec.upstream.url ?? spec.upstream.command, name === "OpenDesign" ? "http://127.0.0.1:7456/mcp" : "/g/graphify-mcp");
  }
  // Sem nenhum `tools`, devolve o MESMO objeto (config antiga intocada).
  const semTools = { A: { command: "/a" } };
  assert.equal(wrapToolFilteredServers(semTools, bridge), semTools);
});