/**
 * T-815: o loop do suite-park no daemon amostrava com spawnSync a cada 60s
 * (240–340ms de event loop parado por amostra, medido no dashboard T-812) e o
 * reaper esperava o grace do SIGTERM com sleepSync (2s de loop parado). O loop
 * agora é assíncrono; o CLI `--suite-park` segue síncrono. Aqui: paridade do
 * reaper, tradução do erro do execFile, tick sem sobreposição e amostra real
 * sem spawnSync.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import {
  collectSuites,
  describePsFailure,
  parsePsOutput,
  psResultFromExecFile,
  reapSuites,
  reapSuitesAsync,
  runPsAsync,
  startSuitePark,
  SUITE_PARK_DEFAULTS,
  type ProcRow,
} from "../suite-park.js";

const require = createRequire(import.meta.url);
const cp = require("node:child_process") as Record<string, unknown>;

function row(pid: number, ppid: number, pgid: number, etime: string, cpu: string, command: string): ProcRow {
  const [r] = parsePsOutput(`${pid} ${ppid} ${pgid} S ${etime} ${cpu} ${command}`);
  assert.ok(r, `linha de ps parseável: ${command}`);
  return r;
}

/** Mesma árvore do T-582: raiz `node --test` + worker + `grep` do pipeline. */
function arvoreComPipeline(): ProcRow[] {
  return [
    row(100, 1, 100, "1:00", "0:00.10", "sh -c node --test x.test.mjs | grep -E ."),
    row(101, 100, 100, "0:59", "0:02.00", "node --test x.test.mjs"),
    row(102, 101, 100, "0:58", "0:11.00", "node --test-concurrency=0 --test-isolation=process x.test.mjs"),
    row(103, 100, 100, "0:59", "0:00.00", "grep -E ."),
    row(200, 1, 200, "3:00:00", "1:00.00", "node /out/vite --port 30474"),
  ];
}

/** 103 (o `grep`) ignora SIGTERM e só morre no SIGKILL — fixture do T-582. */
function processosFalsos(members: number[]) {
  const sinais: string[] = [];
  const vivas = new Set<number>(members);
  const kill = (pid: number, signal: NodeJS.Signals) => {
    sinais.push(`${pid}:${signal}`);
    if (pid < 0) {
      if (signal === "SIGKILL") vivas.clear();
      else for (const p of [...vivas]) if (p !== 103) vivas.delete(p);
    } else if (signal === "SIGKILL") vivas.delete(pid);
  };
  return { sinais, vivas, kill };
}

test("T-815: reapSuitesAsync dá o MESMO resultado e os mesmos sinais do reapSuites", async () => {
  const suites = collectSuites(arvoreComPipeline(), 999);
  const a = processosFalsos(suites[0].members);
  const sync = reapSuites(suites, { graceMs: 1 }, { kill: a.kill, alive: (p) => a.vivas.has(p), sleep: () => {} });
  const b = processosFalsos(suites[0].members);
  const asy = await reapSuitesAsync(suites, { graceMs: 1 }, {
    kill: b.kill,
    alive: async (p) => b.vivas.has(p),
    sleep: async () => {},
  });
  assert.deepEqual(asy, sync);
  assert.deepEqual(b.sinais, a.sinais);
  assert.ok(b.sinais.includes("-100:SIGKILL"), `escalada para SIGKILL: ${b.sinais.join(",")}`);
});

test("T-815: o grace do reaper não para o event loop", async () => {
  const suites = collectSuites(arvoreComPipeline(), 999);
  const f = processosFalsos(suites[0].members);
  let ticks = 0;
  const iv = setInterval(() => { ticks++; }, 5);
  try {
    await reapSuitesAsync(suites, { graceMs: 120 }, {
      kill: f.kill,
      alive: async (p) => f.vivas.has(p),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
  } finally {
    clearInterval(iv);
  }
  // T-858: o limite era 5 e dependia da velocidade do runner (o CI da main
  // quebrou com ticks=4 sob carga). A propriedade é "o event loop NÃO trava",
  // e com sleepSync a contagem seria 0 — 2 separa os dois casos com folga.
  assert.ok(ticks >= 2, `timers rodaram durante o grace (ticks=${ticks}); com sleepSync seriam 0`);
});

test("T-815: erro do execFile vira o mesmo PsSpawnResult do spawnSync", () => {
  const ok = psResultFromExecFile(null, "1 0 1 S 0:01 0:00.00 launchd\n");
  assert.equal(ok.status, 0);
  assert.equal(ok.error, null);
  const timeout = psResultFromExecFile(Object.assign(new Error("killed"), { killed: true, code: null, signal: "SIGTERM" }), "");
  assert.equal(describePsFailure(timeout), "timeout");
  const buffer = psResultFromExecFile(Object.assign(new Error("maxBuffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }), "");
  assert.equal(describePsFailure(buffer), "maxbuffer");
  const status = psResultFromExecFile(Object.assign(new Error("exit 1"), { code: 1 }), "");
  assert.equal(status.status, 1);
  assert.equal(describePsFailure(status), "status_1");
  const semBinario = psResultFromExecFile(Object.assign(new Error("spawn ps ENOENT"), { code: "ENOENT" }), "");
  assert.equal(describePsFailure(semBinario), "erro");
});

test("T-815: runPsAsync lê a tabela real sem spawnSync", async () => {
  const orig = cp.spawnSync;
  const chamadas: string[] = [];
  cp.spawnSync = (bin: string) => { chamadas.push(String(bin)); throw new Error("T-815: spawnSync proibido"); };
  syncBuiltinESMExports();
  try {
    const rows = await runPsAsync();
    assert.ok(rows.some((r) => r.pid === process.pid), "a própria amostra tem de conter este processo");
  } finally {
    cp.spawnSync = orig;
    syncBuiltinESMExports();
  }
  assert.deepEqual(chamadas, []);
});

test("T-815: o loop do daemon amostra com o ps assíncrono por padrão", async () => {
  const orig = cp.spawnSync;
  const logs: string[] = [];
  cp.spawnSync = () => { throw new Error("T-815: spawnSync proibido"); };
  syncBuiltinESMExports();
  const handle = startSuitePark({ log: (_l, m) => logs.push(m), opts: { ...SUITE_PARK_DEFAULTS, graceMs: 0 } });
  try {
    // A amostra inicial está em curso (tick devolve null); espera ela acabar
    // e roda uma segunda, completa.
    let r = await handle.tick();
    for (let i = 0; i < 200 && r === null; i++) {
      await new Promise((res) => setTimeout(res, 10));
      r = await handle.tick();
    }
    assert.ok(Array.isArray(r), "o tick padrão tem de concluir sem spawnSync");
  } finally {
    handle.stop();
    cp.spawnSync = orig;
    syncBuiltinESMExports();
  }
  assert.deepEqual(logs.filter((m) => m.includes("falhou")), [], `nenhuma amostra pode falhar: ${logs.join(" | ")}`);
});

test("T-815: tick do loop não se sobrepõe — o segundo devolve null enquanto o primeiro amostra", async () => {
  let liberar: (rows: ProcRow[]) => void = () => {};
  let amostras = 0;
  const handle = startSuitePark({
    log: () => {},
    // A amostra inicial do start também passa por aqui: segura até liberar.
    ps: () => { amostras++; return new Promise<ProcRow[]>((r) => { liberar = r; }); },
    deps: { kill: () => {}, alive: async () => false, sleep: async () => {} },
    opts: { ...SUITE_PARK_DEFAULTS, graceMs: 0 },
  });
  try {
    assert.equal(amostras, 1, "amostra inicial disparada");
    assert.equal(await handle.tick(), null, "tick com outro em curso não amostra de novo");
    assert.equal(amostras, 1);
    liberar(arvoreComPipeline());
    await new Promise((r) => setImmediate(r));
    const segundo = handle.tick();
    assert.equal(amostras, 2, "terminada a primeira, o tick seguinte amostra");
    liberar(arvoreComPipeline());
    const r = await segundo;
    assert.ok(Array.isArray(r), "tick concluído devolve as avaliações");
  } finally {
    handle.stop();
  }
});

test("revisão T-815: stop() com tick em curso não mata nada depois", async () => {
  let liberar: (rows: ProcRow[]) => void = () => {};
  const mortos: string[] = [];
  const handle = startSuitePark({
    log: () => {},
    ps: () => new Promise<ProcRow[]>((r) => { liberar = r; }),
    deps: { kill: (pid, sig) => { mortos.push(`${pid}:${sig}`); }, alive: async () => true, sleep: async () => {} },
    // Tudo conta como pendurada na hora: idade mínima 0 e janela 0.
    opts: { ...SUITE_PARK_DEFAULTS, minAgeMs: 0, flatWindowMs: 0, graceMs: 0 },
  });
  handle.stop();
  liberar(arvoreComPipeline());
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(mortos, [], "o tick que estava amostrando no stop não pode matar árvores");
});
