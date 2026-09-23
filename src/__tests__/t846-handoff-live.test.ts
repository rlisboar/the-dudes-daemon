/**
 * T-846 (ao vivo) — o handoff de token contra um WS real.
 *
 * Guia o DaemonClient REAL (seam THE_DUDES_DAEMON_TEST=1 pula o bootstrap) num
 * servidor WS de teste que replica o gate do #843: primeira conexão aceita e
 * depois derrubada com 4000 "superseded"; a retomada passiva é recusada com
 * 4001 "occupied" enquanto o "outro processo" está vivo e aceita quando ele
 * morre. Verifica o contrato: sem reconexão imediata, CLIs parados, volta
 * passiva com backoff crescente e operação normal quando aceita.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.THE_DUDES_DAEMON_TEST = "1";
process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `t846-key-${process.pid}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `t846-pkeys-${process.pid}.json`);
process.env.THE_DUDES_DAEMON_CONFIG = path.join(os.tmpdir(), `t846-cli-missing-${process.pid}.json`);

const { WebSocketServer } = await import("ws");
const { DaemonClient } = await import("../main.js");
const { resolveCliCommands } = await import("../cli-config.js");
const { _setPassivoBaseForTest } = await import("../ws-handoff.js");

const BASE_MS = 200;
const rascunho = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("T-846 ao vivo: 4000 para os CLIs e volta passivo; 4001 espera; aceito volta ao normal", async () => {
  _setPassivoBaseForTest(BASE_MS);
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as { port: number }).port;

  const conexoes: Array<{ em: number; passivo: boolean }> = [];
  const sockets: Array<import("ws").WebSocket> = [];
  let numero = 0;

  wss.on("connection", (ws) => {
    numero++;
    sockets.push(ws);
    const indice = numero;
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as { type?: string; passive?: boolean };
      if (m.type !== "daemon:hello") return;
      conexoes.push({ em: Date.now(), passivo: m.passive === true });
      const welcome = () => ws.send(JSON.stringify({ type: "daemon:welcome", user: { name: "dono", email: "d@x" }, protocolVersion: 1 }));
      if (indice === 1) {
        welcome();
        // outro processo sobe e assume: o server fecha a conexão velha.
        setTimeout(() => { try { ws.close(4000, "superseded"); } catch { /* noop */ } }, 60);
        return;
      }
      if (m.passive === true) {
        // Enquanto o "vencedor" está vivo a retomada passiva é recusada.
        if (conexoes.filter((c) => c.passivo).length < 2) {
          try { ws.close(4001, "occupied"); } catch { /* noop */ }
          return;
        }
      }
      welcome();
    });
  });

  const args = {
    orch: `http://127.0.0.1:${port}`, token: "t846", name: "t846-test", pingMs: 30_000,
    verbose: false, verboseHuman: false, verboseHumanIo: true,
    cliConfigPath: process.env.THE_DUDES_DAEMON_CONFIG!, cliPaths: {},
  };
  const client = new (DaemonClient as unknown as new (a: unknown, c: unknown) => {
    connect(): void;
    ws: unknown;
    host: { entries: Map<string, unknown>; stopLocalClis(m: string): number };
    helloPassivo: boolean;
  })(args, resolveCliCommands());

  // CLIs locais de mentira: provam que o 4000 os para.
  const parados: string[] = [];
  client.host.entries.set("ag1", { projectId: "p1", info: { id: "ag1" }, runner: { stop: () => { parados.push("ag1"); } } });

  let saiu = false;
  process.once("exit", () => { saiu = true; });

  client.connect();
  const esperar = async (cond: () => boolean, ms = 4_000) => {
    const t0 = Date.now();
    while (!cond() && Date.now() - t0 < ms) await rascunho(20);
    assert.ok(cond(), `condição não satisfeita em ${ms}ms`);
  };

  await esperar(() => conexoes.length >= 2);
  const primeira = conexoes[0]!;
  const segunda = conexoes[1]!;
  assert.equal(primeira.passivo, false, "primeiro hello é normal");
  assert.deepEqual(parados, ["ag1"], "o 4000 parou o CLI local");
  assert.equal(saiu, false, "não saiu do processo");

  const gap1 = segunda.em - primeira.em;
  assert.ok(gap1 >= BASE_MS * 0.7, `sem reconexão imediata (gap ${gap1}ms)`);
  assert.equal(segunda.passivo, true, "a retomada é passiva");
  assert.equal(client.helloPassivo, true);

  // 4001 → espera com backoff maior antes da próxima tentativa passiva.
  await esperar(() => conexoes.length >= 3);
  const gap2 = conexoes[2]!.em - segunda.em;
  assert.ok(gap2 > gap1, `backoff crescente (${gap1}ms → ${gap2}ms)`);
  assert.equal(conexoes[2]!.passivo, true);

  // Passivo aceito (o "vencedor" morreu): operação normal, sem revezamento.
  await esperar(() => client.helloPassivo === false);
  const antes = conexoes.length;
  await rascunho(500);
  assert.equal(conexoes.length, antes, "aceito o passivo, não fica reconectando em loop");
  assert.equal(client.ws != null, true, "segue conectado");

  for (const s of sockets) { try { s.close(); } catch { /* noop */ } }
  wss.close();
});