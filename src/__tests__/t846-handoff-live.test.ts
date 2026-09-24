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

// T-970: `timeout` transforma um travamento em falha rápida (sem ele o processo
// do teste segurava a suíte da main até o teto do job).
test("T-846 ao vivo: 4000 para os CLIs e volta passivo; 4001 espera; aceito volta ao normal", { timeout: 20_000 }, async (t) => {
  _setPassivoBaseForTest(BASE_MS);
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  let client: { pararConexao(): void } | null = null;
  const sockets: Array<import("ws").WebSocket> = [];
  // T-970: teardown em sucesso E em falha. O cliente para primeiro (sem
  // reconexão, timers limpos); só então caem sockets e o servidor. Antes o
  // cleanup ficava no fim do corpo: um assert falho deixava o DaemonClient
  // reconectando com backoff e o processo nunca saía.
  t.after(async () => {
    try { client?.pararConexao(); } catch { /* noop */ }
    for (const s of sockets) { try { s.terminate(); } catch { /* noop */ } }
    await new Promise<void>((r) => wss.close(() => r()));
  });
  const port = (wss.address() as { port: number }).port;

  const conexoes: Array<{ em: number; passivo: boolean }> = [];
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
  const cliente = new (DaemonClient as unknown as new (a: unknown, c: unknown) => {
    connect(): void;
    pararConexao(): void;
    agendarConnect(ms: number, antes?: () => void): void;
    ws: unknown;
    host: { entries: Map<string, unknown>; stopLocalClis(m: string): number };
    helloPassivo: boolean;
  })(args, resolveCliCommands());
  client = cliente;

  // T-970: o backoff é a DECISÃO do cliente — mede-se o delay que ele agendou.
  // Comparar os gaps de relógio (gap2 > gap1) falhava sob carga no CI: com a
  // CPU do pod em throttling os gaps andam em degraus de ~100ms e o gap1
  // (60ms do servidor + close + delay) passava o gap2 (ex.: 395ms → 288ms).
  // O relógio só entra como limite inferior, que carga nenhuma quebra.
  const agendados: number[] = [];
  const agendarOriginal = cliente.agendarConnect.bind(cliente);
  cliente.agendarConnect = (ms, antes) => { agendados.push(ms); agendarOriginal(ms, antes); };

  // CLIs locais de mentira: provam que o 4000 os para.
  const parados: string[] = [];
  cliente.host.entries.set("ag1", { projectId: "p1", info: { id: "ag1" }, runner: { stop: () => { parados.push("ag1"); } } });

  let saiu = false;
  process.once("exit", () => { saiu = true; });

  cliente.connect();
  const esperar = async (cond: () => boolean, ms = 10_000) => {
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

  // Timer do Node pode disparar ~1ms antes do nominal: margem de 5ms.
  const d1 = agendados[0]!;
  assert.ok(d1 >= BASE_MS * 0.75 && d1 <= BASE_MS * 1.25, `cooldown do 4000 na base com jitter (${d1}ms)`);
  const gap1 = segunda.em - primeira.em;
  assert.ok(gap1 >= d1 - 5, `sem reconexão imediata (gap ${gap1}ms, cooldown ${d1}ms)`);
  assert.equal(segunda.passivo, true, "a retomada é passiva");
  assert.equal(cliente.helloPassivo, true);

  // 4001 → espera com backoff maior antes da próxima tentativa passiva.
  await esperar(() => conexoes.length >= 3);
  assert.equal(agendados.length, 2, `um agendamento por close de handoff (${agendados.join(", ")})`);
  const d2 = agendados[1]!;
  // T-1157: banda larga — sob carga os timers esticam e a razão medida sai fora
  // do 1,5-2,5 sem que o backoff tenha mudado de desenho.
  assert.ok(d2 >= d1 * 1.3 && d2 <= d1 * 3, `backoff crescente (${d1}ms → ${d2}ms)`);
  const gap2 = conexoes[2]!.em - segunda.em;
  assert.ok(gap2 >= d2 - 5, `o 4001 espera o cooldown (gap ${gap2}ms, cooldown ${d2}ms)`);
  assert.equal(conexoes[2]!.passivo, true);

  // Passivo aceito (o "vencedor" morreu): operação normal, sem revezamento.
  await esperar(() => cliente.helloPassivo === false);
  const antes = conexoes.length;
  await rascunho(500);
  assert.equal(conexoes.length, antes, "aceito o passivo, não fica reconectando em loop");
  assert.equal(cliente.ws != null, true, "segue conectado");
});