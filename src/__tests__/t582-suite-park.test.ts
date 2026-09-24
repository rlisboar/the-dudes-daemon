// T-897 (ambiente): parte deste arquivo EXIGE `ps` funcional (sandbox do agente nega com
// EPERM) — os testes afetados dão `skip` com motivo em vez de falhar por ambiente.
/**
 * T-582: suites de teste abandonadas ficam penduradas para sempre.
 *
 * Cobre os 4 critérios de aceite do card:
 *  C1 — UM comando lista as penduradas com o critério de corte declarado;
 *  C2 — CONTROLE NEGATIVO: suite em voo (CPU a crescer) não é classificada
 *       pendurada nem morta;
 *  C4 — a morte alcança a ÁRVORE (raiz + worker + neto + o `grep` do
 *       pipeline `node --test … | grep`), sem órfão.
 * C3 (parque não cresce entre turnos) é medido no host, não aqui — ver o
 * comentário da entrega.
 */
import { describe, test } from "node:test";
import { semPs } from "./env-exigido.js";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessSuites,
  collectSuites,
  sampleOf,
  fmtDuration,
  isTestRoot,
  parsePsDuration,
  parsePsOutput,
  primeiraAmostraUtil,
  reapSuites,
  rowsFromPsAttempt,
  runPs,
  runSuiteParkCli,
  suiteParkCliArgs,
  type ProcRow,
  type PsSpawnResult,
} from "../suite-park.js";

const DAEMON_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN_TS = path.join(DAEMON_DIR, "src", "main.ts");

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** T-652: burn da fixture "viva" — ver derivação no comentário de spawnFakeSuite. */
const VIVA_BURN_MS = 180_000;
/** T-652: teto do CLI nos testes — o boot sob carga no CI chegou a ~57s no
 *  teste inteiro; 120s dá >2x de margem e o `status: null` do spawnSync
 *  (timeout) mataria o assert de status antes do assert do VIVA. */
const RUNCLI_TIMEOUT_MS = 120_000;
/** T-652: timeout dos testes que rodam o CLI — cobre findSuite (10s) +
 *  RUNCLI_TIMEOUT_MS + folga, e fica abaixo do burn da fixture. */
const CLI_TEST_TIMEOUT_MS = 150_000;

function row(pid: number, ppid: number, pgid: number, etime: string, cpu: string, command: string, stat = "S"): ProcRow {
  const [r] = parsePsOutput(`${pid} ${ppid} ${pgid} ${stat} ${etime} ${cpu} ${command}`);
  assert.ok(r, `linha de ps parseável: ${command}`);
  return r;
}

// ────────────────────────────── leitura do ps ───────────────────────────────

test("T-582: parser de duração cobre etime (dd-hh:mm:ss) e time (MM:SS.ss)", () => {
  assert.equal(parsePsDuration("0:01.14"), 1_140);
  assert.equal(parsePsDuration("23:17.65"), (23 * 60 + 17.65) * 1000);
  // macOS não normaliza minutos em horas: 109:00.03 são 109 MINUTOS.
  assert.equal(parsePsDuration("109:00.03"), (109 * 60 + 0.03) * 1000);
  assert.equal(parsePsDuration("1:02:03"), (3600 + 120 + 3) * 1000);
  assert.equal(parsePsDuration("02-09:34:28"), ((2 * 24 + 9) * 3600 + 34 * 60 + 28) * 1000);
  assert.equal(parsePsDuration("-"), 0);
  assert.equal(parsePsDuration("lixo"), 0);
  assert.equal(fmtDuration(0), "0s");
  assert.equal(fmtDuration(95_000), "1m35s");
  assert.equal(fmtDuration((26 * 3600 + 35 * 60) * 1000), "1d02h35m");
});

test("T-582: assinatura da raiz — `node … --test` nu, não o worker nem o `sh -c`", () => {
  assert.equal(isTestRoot("node --test queima.test.mjs"), true);
  assert.equal(isTestRoot("/opt/homebrew/bin/node --import tsx --test src/x.test.ts"), true);
  // worker: só flags `--test-*`
  assert.equal(
    isTestRoot("/opt/homebrew/Cellar/node/25.2.1/bin/node --test-concurrency=0 --test-isolation=process x.test.ts"),
    false,
  );
  // wrapper: a string contém `--test` mas o argv[0] é o shell
  assert.equal(isTestRoot("sh -c node --import tsx --test \"src/**/*.test.ts\""), false);
  assert.equal(isTestRoot("node /path/vite --port 30474 --strictPort"), false);
});

test("T-761: ps morto ou vazio não vira host sem processos", { skip: semPs() }, () => {
  const sentinela = "SENTINELA_STDOUT_NAO_ENTRA_NO_ERRO";
  const timeout: PsSpawnResult = {
    status: null,
    stdout: sentinela,
    error: Object.assign(new Error("spawnSync ps ETIMEDOUT"), { code: "ETIMEDOUT" }),
  };
  assert.equal(rowsFromPsAttempt(timeout), null);
  const bom: PsSpawnResult = {
    status: 0,
    stdout: "  101   100   100 S  1:23  0:12.50 node --test a.test.mjs\n",
    error: null,
  };
  const rows = primeiraAmostraUtil([timeout, bom]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.pid, 101);
  assert.throws(
    () => primeiraAmostraUtil([timeout, { status: 0, stdout: `lixo ${sentinela}`, error: null }]),
    (e: Error) => {
      assert.equal(e.message.includes(sentinela), false);
      assert.match(e.message, /ps indisponível \(sem_processo\)/);
      return true;
    },
  );
  assert.throws(
    () => primeiraAmostraUtil([{ status: null, stdout: "", error: Object.assign(new Error("x"), { code: "ETIMEDOUT" }) }]),
    /ps indisponível \(timeout\)/,
  );
  assert.ok(runPs().length > 0, "ps real ainda devolve processo");
});

test("T-761: raiz mais velha que a janela e ausente da 1ª amostra repete a medição", () => {
  const velha = row(10, 1, 10, "1:10", "0:08.00", "node --test fake.test.mjs");
  const depois = row(10, 1, 10, "1:13", "0:11.00", "node --test fake.test.mjs");
  const seq: ProcRow[][] = [[], [velha], [depois]];
  let i = 0;
  const out: string[] = [];
  const code = runSuiteParkCli(
    { reap: false, windowMs: 3_000, minAgeMs: 0, graceMs: 0, maxCpuDeltaMs: 50 },
    {
      out: (s) => out.push(s),
      ps: () => seq[i++] ?? [],
      sleep: () => {},
    },
  );
  const texto = out.join("");
  assert.equal(code, 0);
  assert.equal(i, 3, "baseline furada + uma repetição, sem laço");
  assert.match(texto, /amostra 1 incompleta/);
  assert.match(texto, /VIVA\s+10\b/);
  assert.match(texto, /cresceu 3000ms >= 50ms/);
  assert.equal(/INDETERMINADA\s+10\b/.test(texto), false);
});

test("T-761: processo nascido dentro da janela não força outra medição", () => {
  const jovem = row(7, 1, 7, "0:01", "0:00.10", "node --test novo.test.mjs");
  const seq: ProcRow[][] = [[], [jovem]];
  let i = 0;
  const out: string[] = [];
  runSuiteParkCli(
    { reap: false, windowMs: 3_000, minAgeMs: 0, graceMs: 0, maxCpuDeltaMs: 50 },
    { out: (s) => out.push(s), ps: () => seq[i++] ?? [], sleep: () => {} },
  );
  assert.equal(i, 2);
  assert.equal(out.join("").includes("amostra 1 incompleta"), false);
  assert.match(out.join(""), /INDETERMINADA\s+7\b/);
});

test("T-582: parse do ps ignora cabeçalho/ruído e preserva o comando inteiro", () => {
  const rows = parsePsOutput(
    "  101   100   100 S    1:23   0:12.50 node --test a.test.mjs\n" +
    "lixo\n" +
    "  102   101   100 R+  02-09:34:28   23:17.65 /opt/node --test-concurrency=0 a.test.mjs\n",
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    pid: 101, ppid: 100, pgid: 100, stat: "S", elapsedMs: 83_000, cpuMs: 12_500, command: "node --test a.test.mjs",
  });
  assert.equal(rows[1].command, "/opt/node --test-concurrency=0 a.test.mjs");
  assert.equal(rows[1].stat, "R+");
});

// ─────────────────────────── árvore e classificação ─────────────────────────

/** sh(100) → node --test(101) → worker(102), e o `grep` do pipeline(103) —
 *  irmão de grupo, NÃO descendente da raiz. */
function arvoreComPipeline(): ProcRow[] {
  return [
    row(100, 1, 100, "1:00", "0:00.10", 'sh -c node --test x.test.mjs | grep -E .'),
    row(101, 100, 100, "0:59", "0:02.00", "node --test x.test.mjs"),
    row(102, 101, 100, "0:58", "0:11.00", "node --test-concurrency=0 --test-isolation=process x.test.mjs"),
    row(103, 100, 100, "0:59", "0:00.00", "grep -E ."),
    row(200, 1, 200, "3:00:00", "1:00.00", "node /out/vite --port 30474"),
  ];
}

test("T-582: collectSuites pega raiz + worker + grep, e ignora quem não é suite", () => {
  const suites = collectSuites(arvoreComPipeline(), 999); // observador fora do grupo
  assert.equal(suites.length, 1, "só a raiz `node --test` vira suite");
  const [s] = suites;
  assert.equal(s.rootPid, 101);
  assert.equal(s.killGroup, true, "grupo próprio → morte por grupo alcança o grep");
  assert.deepEqual(s.members, [100, 101, 102, 103]);
  assert.equal(s.cpuMs, 13_100, "CPU somada da árvore inteira");
});

test("T-582: grupo partilhado com o observador cai no kill membro-a-membro (e ainda pega o grep)", () => {
  const suites = collectSuites(arvoreComPipeline(), 100); // 100 é o próprio observador
  assert.equal(suites.length, 1);
  assert.equal(suites[0].killGroup, false);
  assert.deepEqual(suites[0].members, [101, 102, 103], "grep entra por irmania de grupo, o líder não");
});

test("T-582: raiz aninhada (teste que dispara outro runner) é suite própria", () => {
  const rows = arvoreComPipeline();
  rows.push(row(150, 102, 100, "0:30", "0:00.50", "node --test outro.test.mjs"));
  const suites = collectSuites(rows, 999);
  assert.deepEqual(suites.map((s) => s.rootPid), [101, 150]);
  assert.ok(suites[1].members.includes(150), "a interna é reportada por si");
});

test("T-582 C1/C2 (unidade): pendurada exige CPU plana E idade; CPU a crescer = viva", () => {
  const antes = arvoreComPipeline();
  const baseline = sampleOf(antes);
  const opts = { minAgeMs: 30_000, maxCpuDeltaMs: 1_000, windowMs: 180_000 };

  const parada = collectSuites(arvoreComPipeline(), 999);
  assert.equal(assessSuites(parada, baseline, opts)[0].state, "pendurada");

  // mesma árvore, mas o worker queimou 4s de CPU na janela → em voo
  const crescendo = arvoreComPipeline();
  crescendo[2].cpuMs += 4_000;
  assert.equal(assessSuites(collectSuites(crescendo, 999), baseline, opts)[0].state, "viva");

  // jovem demais: nem olha a CPU
  const jovem = arvoreComPipeline();
  jovem[1].elapsedMs = 10_000;
  assert.equal(assessSuites(collectSuites(jovem, 999), baseline, opts)[0].state, "viva");

  // primeira amostra (sem baseline) é indeterminada, nunca pendurada
  assert.equal(assessSuites(parada, null, opts)[0].state, "indeterminada");
});

test("T-667: CPU plana só é pendurada sem sinal RUNNABLE REPETIDO (≥2 procs, ou o mesmo pid nas duas pontas)", { skip: semPs() }, () => {
  const opts = { minAgeMs: 30_000, maxCpuDeltaMs: 1_000, windowMs: 180_000 };
  const avaliar = (agora: ProcRow[], antes: ProcRow[] = agora) =>
    assessSuites(collectSuites(agora, 999), sampleOf(antes), opts)[0];

  // (a) delta 0 com VÁRIOS procs RUNNABLE no snapshot — a árvore queima, só
  // não recebeu CPU na janela. É o flake do CI (dCPU 0ms sob contenção):
  // medido nas fixtures reais, a viva tem 3–4 procs RUNNABLE em 100% das
  // amostras.
  const starvada = arvoreComPipeline();
  starvada[1].stat = "R";
  starvada[2].stat = "R";
  const a = avaliar(starvada);
  assert.equal(a.state, "viva", a.motivo);
  assert.match(a.motivo, /2 procs RUNNABLE/);

  // (b) um ÚNICO proc RUNNABLE que também estava RUNNABLE na outra ponta da
  // janela → viva (cobre a suite de um queimador só).
  const soUmAntes = arvoreComPipeline();
  soUmAntes[2].stat = "R";
  const soUm = arvoreComPipeline();
  soUm[2].stat = "R";
  const b = avaliar(soUm, soUmAntes);
  assert.equal(b.state, "viva", b.motivo);
  assert.match(b.motivo, /DUAS pontas/);

  // (c) BLIP: um proc RUNNABLE só no snapshot de agora (um `setInterval` que
  // acordou), AUSENTE na outra ponta da janela, não é liveness — é o que
  // derrubava o C4 sob contenção.
  const blip = arvoreComPipeline();
  blip[3].stat = "R";
  const c = avaliar(blip, arvoreComPipeline()); // baseline sem o blip
  assert.equal(c.state, "pendurada", c.motivo);
  assert.equal(c.cpuDeltaMs, 0);

  // (d) árvore INTEIRA dormindo nas duas pontas → pendurada (controle).
  const d = avaliar(arvoreComPipeline());
  assert.equal(d.state, "pendurada", d.motivo);
  assert.equal(d.cpuDeltaMs, 0);
});

test("T-582: reapSuites mata o grupo primeiro e escala para SIGKILL no que resiste", () => {
  const sinais: string[] = [];
  const vivas = new Set<number>();
  const suites = collectSuites(arvoreComPipeline(), 999);
  for (const pid of suites[0].members) vivas.add(pid);
  const deps = {
    // 103 (o `grep`) ignora SIGTERM: só morre no SIGKILL, como dois dos
    // processos que o PM precisou matar à mão.
    kill: (pid: number, signal: NodeJS.Signals) => {
      sinais.push(`${pid}:${signal}`);
      if (pid < 0) {
        if (signal === "SIGKILL") vivas.clear();
        else for (const p of [...vivas]) if (p !== 103) vivas.delete(p);
      } else if (signal === "SIGKILL") vivas.delete(pid);
    },
    alive: (pid: number) => vivas.has(pid),
    sleep: () => {},
  };
  const r = reapSuites(suites, { graceMs: 1 }, deps)[0];
  assert.equal(r.viaGrupo, true);
  assert.deepEqual(r.sobreviventes, []);
  assert.ok(sinais.includes("-100:SIGTERM"), `SIGTERM no grupo: ${sinais.join(",")}`);
  assert.ok(sinais.includes("-100:SIGKILL"), `escalada para SIGKILL: ${sinais.join(",")}`);
});

// ───────────────────────── integração com processos reais ───────────────────

/** Suite falsa com a MESMA forma do defeito: pipeline `node --test | grep`,
 *  `detached` (grupo próprio, como todo spawn do daemon). */
function spawnFakeSuite(modo: "pendurada" | "viva"): { dir: string; child: ChildProcess } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t582-"));
  const file = path.join(dir, "fake.test.mjs");
  // "pendurada": teste que nunca resolve + neto vivo → árvore parada em CPU.
  // T-652: o burn da "viva" é DERIVADO com margem — a fixture tem de estar
  // viva quando o CLI (boot lento sob carga no CI) faz o sample; o pior caso
  // medido no CI foi 56.7s no teste inteiro, então 180s (≈3x) cobre boot de
  // até ~170s. O finally killByDir mata a árvore, então o burn não custa
  // suíte (nenhum teste espera ele terminar).
  const corpo = modo === "pendurada" ? `import { test } from "node:test";
import { spawn } from "node:child_process";
test("pendura", async () => {
  spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await new Promise(() => {});
});`
    : `import { test } from "node:test";
import { spawn } from "node:child_process";
const BURN_MS = ${VIVA_BURN_MS};
// T-652: burn em 3 processos ALÉM do loop do próprio teste — sob contenção
// extrema no CI um único proc pode ser starvado na janela de amostra
// (medido: dCPU 0ms com 1 proc, árvore viva); a soma da CPU da árvore cresce
// com o nº de queimadores e dá sinal robusto.
for (let i = 0; i < 3; i++) spawn(process.execPath, ["-e", "const t=Date.now(); while(Date.now()-t<${VIVA_BURN_MS}) {}"], { stdio: "ignore" });
test("queima", async () => { const t = Date.now(); while (Date.now() - t < BURN_MS) {} });`;
  writeFileSync(file, corpo);
  // NODE_TEST_CONTEXT vaza do worker do `node --test` para os netos e faz o
  // runner filho achar que já É um worker — ele sai na hora. Em produção o
  // CLI do agente não tem essa variável, então limpar é o que espelha o host.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(
    "sh",
    ["-c", `${JSON.stringify(process.execPath)} --test ${JSON.stringify(file)} | grep -E .`],
    { detached: true, stdio: "ignore", cwd: dir, env },
  );
  // Sem unref: o handle do filho segura o event loop do node:test. Com unref
  // o ficheiro chegava a "Promise still pending but the event loop has
  // already resolved" e cancelava C2/C4.
  return { dir, child };
}

async function findSuite(dir: string, minMembers = 3, deadlineMs = 10_000) {
  const until = Date.now() + deadlineMs;
  let last: ReturnType<typeof collectSuites>[number] | undefined;
  while (Date.now() < until) {
    last = collectSuites(runPs()).find((s) => s.command.includes(dir));
    if (last && last.members.length >= minMembers) return last;
    if (process.env.T582_DEBUG) console.error(`[dbg] dir=${dir} found=${!!last} t582rows=${JSON.stringify(runPs().filter((r) => r.command.includes("t582")).map((r) => `${r.pid} ${r.command.slice(0, 70)}`))}`);
    await sleep(100);
  }
  return last;
}

function killByDir(dir: string, child?: ChildProcess): void {
  const s = collectSuites(runPs()).find((x) => x.command.includes(dir));
  if (s) reapSuites([s], { graceMs: 200 });
  const pgid = child?.pid;
  if (pgid) {
    try { process.kill(-pgid, "SIGKILL"); } catch { /* já morto */ }
  }
}

/** Roda o comando REAL do card, como processo separado (nada de mock). */
function runCli(flags: string[]): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env.THE_DUDES_DAEMON_TEST;
  const r = spawnSync(process.execPath, ["--import", "tsx", MAIN_TS, ...flags], {
    cwd: DAEMON_DIR, encoding: "utf8", env, timeout: RUNCLI_TIMEOUT_MS,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("T-582 integração (serial: o CLI varre o host inteiro)", { concurrency: 1, skip: semPs() }, () => {
test("T-582 C1: `--list-suites` lista a pendurada e declara o critério de corte", { skip: semPs(), timeout: CLI_TEST_TIMEOUT_MS }, async () => {
  const { dir, child } = spawnFakeSuite("pendurada");
  try {
    const suite = await findSuite(dir);
    assert.ok(suite, "suite falsa visível no ps");
    const out = runCli([
      "--list-suites", "--suite-window-ms", "600", "--suite-min-age-ms", "0", "--suite-max-cpu-delta-ms", "200",
    ]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /criterio: raiz `node … --test` viva ha >= 0s/);
    assert.match(out.stdout, /PENDURADA/);
    assert.match(out.stdout, new RegExp(`PENDURADA\\s+${suite.rootPid}\\b`));
    // T-731: a coluna CMD é truncada em 90 chars (suite-park.ts). No runner
    // novo do CI o node vive em /home/gh-runner/actions-runner/_work/_tool/
    // node/<versão>/x64/bin/node (66 chars), então `node --test <tmp>/
    // fake.test.mjs` passa de 90 e o nome do ficheiro some no "...". Antes
    // passava só porque o path do node era curto. A identidade da suite é
    // afirmada pelo CWD (coluna própria, NÃO truncada) + o root ser um
    // `--test`, que é o que o critério exige e não depende do comprimento
    // do path do runner.
    const linha = out.stdout.split("\n").find((l) => l.includes("PENDURADA") && l.includes(String(suite.rootPid)));
    assert.ok(linha, `linha da pendurada:\n${out.stdout}`);
    assert.ok(linha!.includes(path.basename(dir)), `a linha identifica a suite pelo CWD: ${linha}`);
    // O comando COMPLETO (sem truncagem de exibição) vem do scan do ps: é ele
    // que prova que a raiz listada é a nossa suite `node … --test fake.test.mjs`.
    // Com path de node longo o suficiente, nem "--test" sobrevive aos 90 chars
    // da coluna — medido aqui com execPath de 90 chars, pior que o do CI (66).
    assert.match(suite.command, /--test/, "a raiz é um `node … --test`");
    assert.match(suite.command, /fake\.test\.mjs/, "a raiz é a suite falsa deste teste");
    assert.match(out.stdout, /modo lista \(zero mutacao\)/);
    assert.equal(alive(suite.rootPid), true, "modo lista não mata");
  } finally {
    killByDir(dir, child);
  }
});

test("T-582 C2: suite EM VOO (CPU a crescer) não é classificada pendurada nem morta", { skip: semPs(), timeout: CLI_TEST_TIMEOUT_MS }, async () => {
  const { dir, child } = spawnFakeSuite("viva");
  try {
    const suite = await findSuite(dir);
    assert.ok(suite, "suite falsa visível no ps");
    const pids = [...suite.members];
    // --list-suites (não --reap-suites): o CLI varre o HOST inteiro, e com
    // min-age 0 um reap mataria outras suites do `npm test` em paralelo.
    // A prova de que o reaper não recebe viva está no filtro `state ===
    // "pendurada"` de runSuiteParkCli + no teste de unidade do reap.
    // T-652: janela 3s e limiar 50ms — derivados do CI: numa janela de 1.2s
    // sob carga o queimador foi starvado (dCPU 0ms) e a árvore foi lida como
    // pendurada. Com o burn em 3 processos + janela 3s o delta da "viva" fica
    // bem acima de 50ms mesmo em blip de contenção, e a "pendurada" (~0ms)
    // segue abaixo. O limiar só separa os dois — não é teto de produção.
    const out = runCli([
      "--list-suites", "--suite-window-ms", "3000", "--suite-min-age-ms", "0",
      "--suite-max-cpu-delta-ms", "50",
    ]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`VIVA\\s+${suite.rootPid}\\b`), `classificada viva:\n${out.stdout}`);
    assert.doesNotMatch(out.stdout, new RegExp(`PENDURADA\\s+${suite.rootPid}\\b`));
    assert.match(out.stdout, /modo lista \(zero mutacao\)/);
    for (const pid of pids) assert.equal(alive(pid), true, `pid ${pid} foi morto indevidamente`);
  } finally {
    killByDir(dir, child);
  }
});

test("T-667: janela com dCPU ~0 (limiar absurdo) NÃO lê a suite EM VOO como pendurada — RUNNABLE manda", { timeout: CLI_TEST_TIMEOUT_MS }, async () => {
  // Pina o flake do CI (run 35295629976 attempt 1): sob starvation o dCPU da
  // fixture viva fica ~0 na janela e a árvore era lida como pendurada. Com
  // limiar absurdo (100s) o dCPU real fica SEMPRE abaixo → exercita o ramo
  // "CPU plana" de forma determinística: a viva só escapa pelo RUNNABLE
  // (≥2 procs queimando no snapshot), e a pendurada — cujo RUNNABLE é blip —
  // segue pendurada.
  const viva = spawnFakeSuite("viva");
  const pendurada = spawnFakeSuite("pendurada");
  try {
    const sv = await findSuite(viva.dir);
    const sp = await findSuite(pendurada.dir);
    assert.ok(sv && sp, "as duas fixtures visíveis no ps");
    const out = runCli([
      "--list-suites", "--suite-window-ms", "300", "--suite-min-age-ms", "0",
      "--suite-max-cpu-delta-ms", "100000",
    ]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`VIVA\\s+${sv.rootPid}\\b`), `viva classificada viva:\n${out.stdout}`);
    assert.doesNotMatch(out.stdout, new RegExp(`PENDURADA\\s+${sv.rootPid}\\b`));
    assert.match(out.stdout, new RegExp(`PENDURADA\\s+${sp.rootPid}\\b`), `controle segue pendurada:\n${out.stdout}`);
    assert.match(out.stdout, /E nenhum sinal RUNNABLE repetido/);
  } finally {
    killByDir(viva.dir, viva.child);
    killByDir(pendurada.dir, pendurada.child);
  }
});

test("T-582 C4: o reap mata a ÁRVORE (raiz + worker + neto + grep) sem deixar órfão", { skip: semPs(), timeout: 45_000 }, async () => {
  const { dir, child } = spawnFakeSuite("pendurada");
  try {
    const suite = await findSuite(dir, 4);
    assert.ok(suite, "suite falsa visível no ps");
    assert.ok(suite.members.length >= 4, `árvore completa (vi ${suite.members.length} membros: ${suite.members})`);
    assert.ok(suite.members.includes(suite.pgid), "o `sh` do pipeline está na árvore");
    const members = [...suite.members];

    const baseline = sampleOf(runPs());
    await sleep(1_200);
    const cur = collectSuites(runPs()).find((s) => s.command.includes(dir));
    assert.ok(cur, "suite ainda visível na 2ª amostra");
    const [a] = assessSuites([cur], baseline, { minAgeMs: 0, maxCpuDeltaMs: 200, windowMs: 1_200 });
    assert.equal(a.state, "pendurada", a.motivo);

    if (process.env.T582_DEBUG) console.error("[dbg c4]", JSON.stringify({ members, pgid: cur.pgid, killGroup: cur.killGroup, cmd: cur.command }));
    const [r] = reapSuites([cur], { graceMs: 500 });
    if (process.env.T582_DEBUG) console.error("[dbg c4 resultado]", JSON.stringify(r), "vivos:", members.filter(alive));
    assert.deepEqual(r.sobreviventes, [], `nada sobreviveu: sinais=${r.sinais.join(",")}`);
    const deadline = Date.now() + 3_000;
    while (members.some(alive) && Date.now() < deadline) await sleep(50);
    for (const pid of members) assert.equal(alive(pid), false, `órfão: pid ${pid} sobreviveu`);
    assert.equal(
      collectSuites(runPs()).some((s) => s.command.includes(dir)),
      false,
      "nenhuma suite falsa resta no ps",
    );
  } finally {
    killByDir(dir, child);
  }
});

test("T-582: parser das flags do comando (defaults e override)", () => {
  assert.equal(suiteParkCliArgs(["--orch", "x"]), null);
  const d = suiteParkCliArgs(["--list-suites"]);
  assert.ok(d);
  assert.equal(d.reap, false);
  assert.equal(d.windowMs, 60_000);
  assert.equal(d.minAgeMs, 600_000);
  const o = suiteParkCliArgs(["--reap-suites", "--suite-window-ms", "1200", "--suite-min-age-ms", "0"]);
  assert.ok(o);
  assert.equal(o.reap, true);
  assert.equal(o.windowMs, 1_200);
  assert.equal(o.minAgeMs, 0);
  assert.equal(suiteParkCliArgs(["--list-suites", "--suite-window-ms", "abc"])?.windowMs, 60_000);
});
});