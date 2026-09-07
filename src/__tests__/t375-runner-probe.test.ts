import "./scratch-home.js";

/**
 * T-375 — disponibilidade de runner só com prova de execução.
 *
 * Os quatro estados feios têm de ser DISTINGUÍVEIS (inexistente, não
 * executável, existe mas quebra a correr, existe mas PENDURA sem provar) e
 * nenhum pode aparecer como disponível. Ruling PM: timeout NÃO é prova —
 * `available` só sai do caminho com `exit 0` no `--version`/`--help`; o
 * timeout tem razão própria, é inconclusivo e por isso nunca é cacheado.
 * O alvo estrutural continua a ser o `available: true` incondicional do
 * caminho PATH detectado — o teste do branch PATH é o que cai se alguém o
 * repuser (mutação obrigatória da task).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  formatCliStatus,
  PROBE_CACHE_PATH,
  probeRunnerExecutable,
  resolveCliCommand,
} from "../cli-config.js";

function fakeBin(dir: string, name: string, body: string, mode = 0o755): string {
  const p = path.join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, mode);
  return p;
}

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "t375-"));
}

const GOOD = `#!/bin/sh\ncase "$1" in --version) exit 0;; --help) exit 0;; esac\nexit 2\n`;
const HELP_ONLY = `#!/bin/sh\ncase "$1" in --help) exit 0;; esac\nexit 2\n`;
const BROKEN = `#!/bin/sh\necho "Error: cannot execute binary file" >&2\nexit 1\n`;
const HANG = `#!/bin/sh\ncase "$1" in --version|--help) sleep 5;; esac\nexit 0\n`;
// Lento enquanto existir o marker (consome-o antes de dormir): é o
// "runner são numa máquina carregada" que o retry único tem de resgatar.
// Marker em vez de contador porque o PRIMEIRO exec de um ficheiro
// recém-criado no macOS paga ~0.3-1s de avaliação (AMFI) ANTES do corpo
// correr — um contador leria esse imposto como 1ª chamada. Um spawn de
// aquecimento absorve o imposto fora da medição, como qualquer binário
// real já pagou no primeiro uso do utilizador.
// sleep 3 = critério 3 da re-entrega à letra: "delay injetado ~3-5s vs
// orçamento do retry" — um --version legítimo de 3s tem de sobreviver aos
// orçamentos REAIS de produção (1.5s + retry 6s), que é a constrição
// binária do ruling; o teste corre sem injectar orçamentos.
// SEMPRE lento (não "lento uma vez"): a constrição binária do ruling é sobre
// o CLI ser lento a cada chamada — "um --version legítimo de até 5s tem de
// sobreviver". Com marker, quem sobrevivesse era um filho rápido no retry;
// aqui a 1ª tentativa é morta aos 1.5s a meio do sleep e o retry espera o
// sleep inteiro (3s) dentro dos 6s — é o caso do PM, à letra.
const SLOW_ALWAYS = `#!/bin/sh\nsleep 3\nexit 0\n`;

test("T-375 estados distinguíveis: inexistente, não-executável, quebra-a-correr, pendura-sem-prova, só-ajuda, são", () => {
  const dir = tmpDir();
  const good = fakeBin(dir, "good", GOOD);
  const helpOnly = fakeBin(dir, "onlyhelp", HELP_ONLY);
  const broken = fakeBin(dir, "broken", BROKEN);
  const hang = fakeBin(dir, "hang", HANG);
  const noExec = fakeBin(dir, "noexec", GOOD, 0o644);
  const missing = path.join(dir, "does-not-exist");

  const pGood = probeRunnerExecutable(good);
  const pHelp = probeRunnerExecutable(helpOnly);
  assert.equal(pGood.ok, true, "binário são passa na sonda");
  assert.equal(pHelp.ok, true, "binário que só conhece --help passa pela segunda forma");

  // timeout folgado nos casos NEGATIVOS de veredicto: sob carga do suite
  // completo um spawn pode inchar para além do orçamento e cair no estado
  // `timeout` (inconclusivo) onde a asserção esperava `broken`.
  const pBroken = probeRunnerExecutable(broken, 20_000);
  const pNoExec = probeRunnerExecutable(noExec);
  const pMissing = probeRunnerExecutable(missing);
  // sem retry (3º arg = 0) para o caso do pendura ser determinístico e barato.
  const pHang = probeRunnerExecutable(hang, 200, 0);
  assert.equal(pBroken.ok, false, "existe mas quebra a correr ⇒ indisponível");
  assert.match(pBroken.reason, /status 1/);
  assert.equal(pNoExec.ok, false, "sem bit de exec ⇒ indisponível");
  assert.match(pNoExec.reason, /EACCES/);
  assert.equal(pMissing.ok, false, "inexistente ⇒ indisponível");
  assert.match(pMissing.reason, /inexistente/);
  // RULING PM: pendurar não é prova ⇒ indisponível, com razão PRÓPRIA.
  assert.equal(pHang.ok, false, "arrancou mas não respondeu ⇒ indisponível (timeout não é prova)");
  assert.match(pHang.reason, /^timeout/);
  assert.ok(pHang.inconclusive, "timeout é inconclusivo, não um veredicto");
  // distinguíveis entre si (quatro razões de indisponível diferentes):
  assert.notEqual(pHang.reason, pBroken.reason);
  assert.notEqual(pBroken.reason, pNoExec.reason);
  assert.notEqual(pNoExec.reason, pMissing.reason);

  // resolveCliCommand com override: o falso verde do override manual morre aqui
  const rBroken = resolveCliCommand("gemini", broken, undefined, 20_000);
  assert.equal(rBroken.available, false, "override para binário partido ⇒ available false");
  assert.equal(rBroken.source, "override");
  assert.equal(rBroken.resolvedPath, broken);
  const rGood = resolveCliCommand("gemini", good);
  assert.equal(rGood.available, true);

  // diagnóstico legível: os estados são labels próprios no status
  const statusBroken = formatCliStatus("gemini", rBroken);
  assert.match(statusBroken, /\[broken \(/);
  assert.match(statusBroken, /, manual\]/);
  assert.match(formatCliStatus("gemini", resolveCliCommand("gemini", missing)), /\[missing, manual\]/);
  assert.match(
    formatCliStatus("gemini", {
      command: hang,
      source: "override",
      available: false,
      resolvedPath: hang,
      probeReason: pHang.reason,
    }),
    /\[timeout, manual\]/,
    "timeout é o QUARTO estado — nem broken, nem missing"
  );
});

test("T-375 caminho PATH detectado deixa de ser `available: true` incondicional", () => {
  const dir = tmpDir();
  const savedPath = process.env.PATH;
  try {
    // binário PARTIDO primeiro no PATH: `which` encontra-o; o branch
    // "detected" era o que devolvia available:true sem qualquer prova.
    fakeBin(dir, "t375fake-runner", BROKEN);
    process.env.PATH = `${dir}:${savedPath ?? ""}`;
    const rBroken = resolveCliCommand("t375fake-runner", undefined, undefined, 20_000);
    assert.equal(rBroken.source, "detected", "pré-condição: veio pelo branch PATH");
    // veredicto completo na mensagem: duas ocorrências deste assert caírem
    // com `true` dentro do suite em carga (isolado sempre verde) exigem que
    // a próxima ocorrência se auto-diagnostique — sem isto, flake às cegas.
    assert.equal(rBroken.available, false, `PATH detectado SEM prova ⇒ indisponível — veio: ${JSON.stringify(rBroken)}`);
    assert.match(rBroken.probeReason ?? "", /status 1/);

    // e o PATH detectado SÃO continua disponível — a prova é que o habilita
    const dir2 = tmpDir();
    fakeBin(dir2, "t375fake-runner2", HELP_ONLY);
    process.env.PATH = `${dir2}:${savedPath ?? ""}`;
    const rGood = resolveCliCommand("t375fake-runner2");
    assert.equal(rGood.source, "detected");
    assert.equal(rGood.available, true, "executou a sonda ⇒ disponível, pelo branch PATH também");
  } finally {
    process.env.PATH = savedPath;
  }
});

test("T-375 timeout não é prova: retry único com orçamento maior rescata o lento, o que pendura fica indisponível e NÃO é cacheado", () => {
  const dir = tmpDir();

  // (a) a mitigação do falso negativo, com os orçamentos REAIS (1.5s/6s, sem
  // injectar): 1ª tentativa estoura os 1.5s, o retry único de 6s prova o
  // binário são com delay injetado de 3s (critério 3 da re-entrega).
  const slow = fakeBin(dir, "slow", SLOW_ALWAYS);
  const warm = spawnSync(slow, ["--version"], { stdio: "ignore" });
  assert.equal(warm.status, 0, "aquecimento: paga o primeiro-exec do macOS fora da medição");

  const tSlow = Date.now();
  const pSlow = probeRunnerExecutable(slow);
  const slowElapsed = Date.now() - tSlow;
  assert.equal(pSlow.ok, true, "--version legítimo de 3s sobrevive aos orçamentos de produção");
  assert.match(pSlow.reason, /status 0/);
  assert.ok(slowElapsed >= 4000, `1ª tentativa morreu aos 1.5s e o retry esperou os 3s (levou ${slowElapsed}ms)`);
  assert.ok(slowElapsed <= 9000, `retry completou dentro do orçamento de 6s (levou ${slowElapsed}ms)`);

  // (b) o que pendura sempre: indisponível com razão própria, e o resultado é
  // INCONCLUSIVO — nunca entra na cache, é re-sondado no próximo boot.
  const hang = fakeBin(dir, "hang", HANG);
  const t0 = Date.now();
  const r1 = probeRunnerExecutable(hang, 200, 300);
  const first = Date.now() - t0;
  assert.equal(r1.ok, false, "timeout ⇒ NÃO disponível (ruling PM)");
  assert.match(r1.reason, /^timeout/);
  assert.match(r1.reason, /retry 300ms/, "a razão declara os dois orçamentos gastos");
  assert.ok(first >= 450, `primeira chamada pagou orçamento + retry (levou ${first}ms)`);

  const t1 = Date.now();
  const r2 = probeRunnerExecutable(hang, 200, 300);
  const second = Date.now() - t1;
  assert.equal(r2.ok, false);
  assert.ok(second >= 450, `inconclusivo não é servido da cache — re-sonda (levou ${second}ms)`);

  // Persistência: o negativo por timeout não pode ter entrada no disco,
  // o positivo do (a) tem de ter — o contraste entre os dois é o ponto.
  const st = statSync(hang);
  const key = `${hang}:${st.size}:${st.mtimeMs}`;
  let onDisk: Record<string, { ok: boolean; reason: string }> | undefined;
  try {
    onDisk = JSON.parse(readFileSync(PROBE_CACHE_PATH, "utf8"));
  } catch {
    /* ainda sem ficheiro: também prova a ausência do pendura */
  }
  assert.ok(!onDisk || !(key in onDisk), "timeout não é cacheado em disco — 'não consegui provar' volta a ser tentado");
  const stSlow = statSync(slow);
  assert.ok(onDisk && `${slow}:${stSlow.size}:${stSlow.mtimeMs}` in onDisk, "exit 0 limpo É resposta: cacheia");

  // ... e o NEGATIVO limpo (exit != 0) também: é veredicto, não falha de
  // prova. As três asserções acima/abaixo são sobre o FICHEIRO, não sobre
  // mensagens (critério 3 do ruling).
  const broken = fakeBin(dir, "broken", BROKEN);
  const pBroken = probeRunnerExecutable(broken, 20_000);
  assert.equal(pBroken.ok, false);
  const stBroken = statSync(broken);
  onDisk = JSON.parse(readFileSync(PROBE_CACHE_PATH, "utf8"));
  assert.ok(
    `${broken}:${stBroken.size}:${stBroken.mtimeMs}` in onDisk,
    "exit != 0 limpo também é resposta: persiste e não se re-sonda a cada boot",
  );
});

// Bateria adversarial da cache (critério 6 da re-entrega): cada cenário corre
// um processo NOVO (carga de módulo fresca) com HOME scratch e cache
// pré-semada. A constante: corrupção NUNCA fabrica available:true sem prova;
// escrita concorrente não perde entradas (merge-on-write).
test("T-375 bateria da cache: lixo, truncada, chmod 000 e escrita concorrente não fabricam verde", () => {
  const daemonDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const modUrl = pathToFileURL(path.join(daemonDir, "src", "cli-config.ts")).href;
  const runChild = (home: string, broken: string): { available: boolean } => {
    const p = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e",
        `const m = await import(${JSON.stringify(modUrl)});
         const r = m.resolveCliCommand("fakesha", ${JSON.stringify(broken)}, undefined, 20000);
         console.log(JSON.stringify({ available: r.available }));`],
      { env: { ...process.env, HOME: home }, encoding: "utf8", cwd: daemonDir },
    );
    const line = p.stdout.trim().split("\n").pop() ?? "";
    assert.ok(p.status === 0, `child deve sobreviver à corrupção (boot não trava): ${p.stderr.slice(0, 200)}`);
    return JSON.parse(line);
  };
  const scenarios: Array<[string, (cachePath: string, dir: string) => void]> = [
    ["lixo", (c) => writeFileSync(c, "}{isto não é json")],
    ["truncada", (c) => writeFileSync(c, '{"a":{"ok":tru')],
    ["chmod000", (c, dir) => {
      writeFileSync(c, JSON.stringify({ "x": { ok: false, reason: "r" } }));
      chmodSync(c, 0o000);
      void dir;
    }],
  ];
  for (const [nome, semear] of scenarios) {
    const home = mkdtempSync(path.join(os.tmpdir(), "t375-home-"));
    const dir = tmpDir();
    const broken = fakeBin(dir, "broken", BROKEN);
    mkdirSync(path.join(home, ".the-dudes"), { recursive: true });
    semear(path.join(home, ".the-dudes", "runner-probe-cache.json"), dir);
    const r = runChild(home, broken);
    assert.equal(r.available, false, `cache ${nome}: veredicto tem de vir da sonda, não do lixo lido`);
  }

  // Veneno shape-valid: o cache é CREDULA por contrato — quem escreveu provou.
  // Uma entrada ok:true na chave certa é servida sem re-execução; é o único
  // verde que pode vir do ficheiro, e nunca um veredicto lido de lixo.
  const homeV = mkdtempSync(path.join(os.tmpdir(), "t375-home-"));
  const dirV = tmpDir();
  const brokenV = fakeBin(dirV, "broken", BROKEN);
  mkdirSync(path.join(homeV, ".the-dudes"), { recursive: true });
  const stV = statSync(brokenV);
  writeFileSync(
    path.join(homeV, ".the-dudes", "runner-probe-cache.json"),
    JSON.stringify({ [`${brokenV}:${stV.size}:${stV.mtimeMs}`]: { ok: true, reason: "VENENO" } }),
  );
  assert.equal(runChild(homeV, brokenV).available, true, "shape-valid ok:true é servido pela cache");

  // Escrita concorrente: entrada de OUTRO processo sobrevivente ao nosso
  // merge-on-write — perder a dele estragava o boot dele.
  const home = mkdtempSync(path.join(os.tmpdir(), "t375-home-"));
  const dir = tmpDir();
  const broken = fakeBin(dir, "broken", BROKEN);
  mkdirSync(path.join(home, ".the-dudes"), { recursive: true });
  const cachePath = path.join(home, ".the-dudes", "runner-probe-cache.json");
  writeFileSync(cachePath, JSON.stringify({ "outro/bin:1:2": { ok: true, reason: "escrito por outro daemon" } }));
  const r = runChild(home, broken);
  assert.equal(r.available, false);
  const after = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, { ok: boolean }>;
  assert.ok(after["outro/bin:1:2"], "merge-on-write: a entrada do concorrente sobreviveu");
  const st = statSync(broken);
  assert.ok(after[`${broken}:${st.size}:${st.mtimeMs}`], "e a nossa entrou");
});

test("T-375 spawn que o sistema nega (EAGAIN/EMFILE) é inconclusivo, nunca um veredicto", (t) => {
  // Ponto 3 do ruling (QA): um erro de spawn sob tabela de processos esgotada
  // não pode ficar em cache — a chave path:size:mtime serviria o falso até o
  // binário mudar. Esgotamos os fd deste processo para o spawnSync ser
  // negado pelo SO com EMFILE.
  const dir = tmpDir();
  const good = fakeBin(dir, "good", GOOD);
  const fds: number[] = [];
  let capped = false;
  try {
    for (let i = 0; i < 200_000 && !capped; i++) {
      try {
        fds.push(openSync("/dev/null", "r"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EMFILE") capped = true;
        else throw e;
      }
    }
    if (!capped) {
      t.skip("limite de fds não foi atingível nesta máquina (hard limit alto demais)");
      return;
    }
    const r = probeRunnerExecutable(good, 2_000, 0);
    assert.equal(r.ok, false, "sem conseguir spawnar não se pode anunciar disponível");
    assert.ok(r.inconclusive, "EMFILE é 'não consegui provar', não um veredicto");
    assert.match(r.reason, /spawn erro: (EMFILE|EAGAIN)/);
  } finally {
    for (const fd of fds) {
      try {
        closeSync(fd);
      } catch {
        /* melhor esforço */
      }
    }
  }
});
