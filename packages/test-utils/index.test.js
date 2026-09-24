/**
 * Teste do helper — os cenários que o server já cobria (T-867/T-873/T-908),
 * agora junto do código que eles exercitam:
 * TMPDIR vazio, inexistente, negado, apontando para ARQUIVO e o cache por
 * processo; mais SIGTERM (limpeza) e a redação das mensagens de fallback.
 *
 * Cada cenário roda num PROCESSO novo: o helper cacheia o diretório escolhido.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir, tmpFile } from "./index.js";

const HELPER = fileURLToPath(new URL("./index.js", import.meta.url));

/** Roda o helper num processo novo com o TMPDIR pedido e devolve o resultado. */
function runHelper(tmp) {
  const script = `
    const fs = await import("node:fs");
    const m = await import(${JSON.stringify(HELPER)});
    const dir = m.tmpRoot();
    const sub = m.tmpDir("probe-");
    const arq = m.tmpFile("probe.txt");
    fs.writeFileSync(arq, "x");
    const vivos = { dir: fs.existsSync(dir), sub: fs.existsSync(sub), arq: fs.existsSync(arq) };
    process.stdout.write(JSON.stringify({ dir, sub, arq, vivos }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tmp },
    timeout: 60_000,
  });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function okPayload(out) {
  const p = JSON.parse(out);
  assert.deepEqual(p.vivos, { dir: true, sub: true, arq: true }, "o filho não criou o que devolveu");
  assert.ok(p.arq.startsWith(p.dir), "tmpFile fora do tmpRoot");
  assert.ok(p.sub.startsWith(p.dir), "tmpDir fora do tmpRoot");
  assert.equal(existsSync(p.dir), false, `tmpRoot não foi limpo na saída: ${p.dir}`);
  assert.equal(existsSync(p.sub), false, "subdiretório sobreviveu à saída");
  return p;
}

test("TMPDIR vazio (ambiente dos agentes) → cai em /tmp, sem aviso, e limpa", () => {
  const r = runHelper("");
  assert.equal(r.status, 0, `helper falhou: ${r.err}`);
  const p = okPayload(r.out);
  assert.ok(p.dir.startsWith("/tmp"), `esperava /tmp, veio ${p.dir}`);
  assert.equal(r.err.includes("TMPDIR do ambiente"), false, "sem TMPDIR não há o que avisar");
});

test("TMPDIR inexistente é criado e usado (sem fallback desnecessário)", () => {
  const alvo = tmpFile(`t934-ausente-${process.pid}-${Date.now()}`);
  const r = runHelper(alvo);
  assert.equal(r.status, 0, `helper falhou: ${r.err}`);
  const p = okPayload(r.out);
  assert.ok(p.dir.startsWith(alvo), `esperava usar ${alvo}, veio ${p.dir}`);
});

test("TMPDIR sem escrita → fallback explícito com o TMPDIR recusado na mensagem", () => {
  const ruim = tmpDir("t934-sem-escrita-");
  chmodSync(ruim, 0o500);
  try {
    const r = runHelper(ruim);
    assert.equal(r.status, 0, `helper falhou: ${r.err}`);
    const p = okPayload(r.out);
    assert.ok(!p.dir.startsWith(ruim), "não podia escolher o diretório sem escrita");
    assert.match(r.err, /TMPDIR do ambiente \(.*\) recusado — usando \/tmp/, "fallback silencioso");
  } finally {
    chmodSync(ruim, 0o700);
  }
});

test("TMPDIR apontando para ARQUIVO → recusa e cai para /tmp", () => {
  const arq = tmpFile(`t934-arquivo-${Date.now()}`);
  writeFileSync(arq, "nao sou diretorio");
  const r = runHelper(arq);
  assert.equal(r.status, 0, `helper falhou: ${r.err}`);
  const p = okPayload(r.out);
  assert.ok(p.dir.startsWith("/tmp"), `tinha de cair para /tmp, veio ${p.dir}`);
  assert.match(r.err, /recusado — usando/, "fallback silencioso");
});

test("cache por processo: duas chamadas devolvem o MESMO diretório", () => {
  const script = `
    const m = await import(${JSON.stringify(HELPER)});
    const a = m.tmpRoot(); const b = m.tmpRoot();
    process.stdout.write(a === b ? "igual" : "diferente");
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(r.stdout, "igual", "tmpRoot não cacheou");
});

test("SIGTERM limpa o tmpRoot (o hook `exit` não roda nele)", async () => {
  const script = `
    const m = await import(${JSON.stringify(HELPER)});
    process.stdout.write(m.tmpRoot() + "\\n");
    setInterval(() => {}, 1000);
  `;
  const p = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, TMPDIR: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const dir = await new Promise((res, rej) => {
    let buf = "";
    p.stdout.on("data", (c) => { buf += c.toString(); if (buf.includes("\n")) res(buf.trim()); });
    setTimeout(() => rej(new Error("filho não anunciou o dir")), 20_000);
  });
  assert.equal(existsSync(dir), true, "pré-condição: o filho criou o tmpRoot");
  p.kill("SIGTERM");
  const saiu = await new Promise((res) => p.on("exit", (code, sig) => res(code ?? (sig ? -1 : null))));
  assert.equal(saiu, 143, `saída esperada 143, veio ${saiu}`);
  assert.equal(existsSync(dir), false, `SIGTERM deixou resíduo em ${dir}`);
});

test("mensagem de erro lista o que foi tentado (e o cabeçalho documenta os limites)", async () => {
  const fonte = await import("node:fs/promises").then((fs) => fs.readFile(HELPER, "utf8"));
  assert.match(fonte, /nenhum diretório temporário gravável\. Tentados:/);
  assert.match(fonte, /LIMITE DE HARNESS/, "limite do loader do tsx fora do cabeçalho");
  assert.match(fonte, /sem TMPDIR no ambiente e \/tmp recusado/, "texto do caso sem TMPDIR");
  assert.equal(dirname(HELPER).endsWith(join("packages", "test-utils")), true, "helper fora do pacote");
});

test("o helper não depende de tsx (roda em node puro — consumidor daemon/web)", () => {
  const r = runHelper("");
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.err, /tsx/, "algo do tsx vazou para o caminho do consumidor");
});
