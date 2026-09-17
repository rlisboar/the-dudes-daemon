/**
 * T-577: importar o mcp-bridge NÃO pode ter efeito colateral de processo.
 *
 * O módulo é um PROGRAMA (o daemon o spawna como processo próprio) e ao mesmo
 * tempo é IMPORTADO pelos testes do registry (t469/t557). Dois efeitos no topo
 * do módulo quebravam o `node --test` no CI, que roda sem env de daemon:
 *  1. `process.exit(1)` com THE_DUDES_AGENT_ID ausente matava o processo do
 *     runner durante o import — os 2 arquivos morriam sem rodar um teste;
 *  2. `server.connect(transport)` pendura listeners em process.stdin e segurava
 *     o event loop do filho para sempre (runner pendurado).
 *
 * O gate é `IS_BRIDGE_ENTRYPOINT` (argv[1] é o próprio bridge). Aqui os três lados
 * do contrato são provados com processo real e stdin ABERTO: é o stdin aberto
 * que separa "importou e saiu sozinho" de "importou e ficou pendurado". O quarto
 * caso cobre o caminho de dev do daemon (bin do tsx, não `node --import tsx`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const BRIDGE_TS = fileURLToPath(new URL("../mcp-bridge.ts", import.meta.url));
const DAEMON_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** env sem NENHUMA var THE_DUDES_* — é assim que o CI roda a suíte do daemon. */
function envLimpo(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("THE_DUDES_")) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

/**
 * Budget derivado T-588 (2026-09-17) — hang detector, não "mais folga".
 *
 * Isolado local n=64 (16 ficheiros × 4 testes): 0 falhas; p50=4.4s p100=13.6s.
 * CI no pod 2 vCPU (cross-ref; o concurrency do ci.yml é por ref, não serializa
 * branch×pre-main):
 *   35156980604 a1 @26cab2f: 4/4 falham em 15030–15432ms (processo vivo / stdout "")
 *   35161489026 @54c8003: initialize 15046ms stdout ""
 *   35164094034 @6a359a8: 3/4 em 15159–15239ms
 *   35164258678 @82d1818: initialize 15043ms stdout ""
 *   35181611214 @d5e120b (tip pre-main, merge #592): initialize 15122ms
 *     stdout "" — siblings 9.0s / 7.1s / 12.0s. t445 NÃO apareceu.
 * t445 PASSOU nos jobs anteriores (2618–3921ms) — não é o C1.
 *
 * 15s é lower-bound do custo de spawn(tsx)+boot no pod ocupado, não duração
 * de hang: o processo AINDA estava vivo quando o teto disparou. Teto =
 * 2 × 15432ms ≈ 30s. Continua a falhar se o bridge pendurar de verdade
 * (o defeito original da T-577). esperaLinha também trata EXIT como FATO
 * (não espera o hang detector se o filho já morreu).
 */
const BOOT_BUDGET_MS = 30_000;
const TEST_TIMEOUT_MS = BOOT_BUDGET_MS * 2 + 5_000;

function spawnBridge(entry: string, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: DAEMON_DIR,
    env,
    // stdin por PIPE e aberto pelo pai: um módulo que liga o stdio no import
    // nunca deixa o filho morrer sozinho.
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function esperaSaida(child: ChildProcess, ms: number): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`processo não saiu em ${ms}ms (pendurado)`)), ms);
    child.once("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

function esperaLinha(child: ChildProcess, re: RegExp, ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      fn();
    };
    const t = setTimeout(() => finish(() => reject(new Error(
      `stdout não bateu ${re} em ${ms}ms: ${JSON.stringify(out)} stderr=${JSON.stringify(err)}`,
    ))), ms);
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      if (re.test(out)) finish(() => resolve(out));
    });
    child.stderr?.on("data", (c: Buffer) => { err += c.toString("utf8"); });
    child.once("exit", (code) => {
      if (re.test(out)) finish(() => resolve(out));
      else finish(() => reject(new Error(
        `processo saiu ${code} antes de ${re}: stdout=${JSON.stringify(out)} stderr=${JSON.stringify(err)}`,
      )));
    });
  });
}

test("T-577: import do bridge com stdin aberto sai sozinho (não pendura o runner)", { timeout: TEST_TIMEOUT_MS }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "t577-import-"));
  const runner = path.join(dir, "import-only.mjs");
  writeFileSync(runner, `await import(${JSON.stringify(BRIDGE_TS)});\nconsole.log("IMPORT_OK");\n`);

  const child = spawnBridge(runner, envLimpo());
  let out = "";
  child.stdout?.on("data", (c: Buffer) => { out += c.toString("utf8"); });
  try {
    const code = await esperaSaida(child, BOOT_BUDGET_MS);
    assert.equal(code, 0, "import puro deve sair com 0 sem ninguém fechar o stdin");
    assert.match(out, /IMPORT_OK/, "o import terminou");
  } finally {
    child.kill("SIGKILL");
  }
});

test("T-577: bridge como entrypoint sem AGENT_ID continua falhando alto (exit 1)", { timeout: TEST_TIMEOUT_MS }, async () => {
  const child = spawnBridge(BRIDGE_TS, envLimpo());
  let err = "";
  child.stderr?.on("data", (c: Buffer) => { err += c.toString("utf8"); });
  try {
    const code = await esperaSaida(child, BOOT_BUDGET_MS);
    assert.equal(code, 1, "sem AGENT_ID o processo do bridge tem que morrer (fail-fast preservado)");
    assert.match(err, /THE_DUDES_AGENT_ID not set/);
  } finally {
    child.kill("SIGKILL");
  }
});

// Caminho de DEV do daemon: `resolveBridge()` spawna o BIN do tsx com o .ts como
// argumento, não `node --import tsx`. O gate depende de argv[1] ser o bridge, e o
// wrapper do tsx re-executa o node com o script no argv[1] — este caso prova que
// o gate não é um acidente do `--import tsx` dos outros testes.
const TSX_BIN = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));

test("T-577: entrypoint pelo bin do tsx (dev) também age como processo", { skip: !existsSync(TSX_BIN), timeout: TEST_TIMEOUT_MS }, async () => {
  const child = spawn(TSX_BIN, [BRIDGE_TS], { cwd: DAEMON_DIR, env: envLimpo(), stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  child.stderr?.on("data", (c: Buffer) => { err += c.toString("utf8"); });
  try {
    const code = await esperaSaida(child, BOOT_BUDGET_MS);
    assert.equal(code, 1, "sob o bin do tsx, sem AGENT_ID o bridge tem que morrer igual");
    assert.match(err, /THE_DUDES_AGENT_ID not set/);
  } finally {
    child.kill("SIGKILL");
  }
});

test("T-577: bridge como entrypoint conecta o stdio (initialize responde)", { timeout: TEST_TIMEOUT_MS }, async () => {
  const child = spawnBridge(BRIDGE_TS, envLimpo({ THE_DUDES_AGENT_ID: "probe-t577", THE_DUDES_AGENT_TOKEN: "probe" }));
  try {
    child.stdin?.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
    })}\n`);
    const out = await esperaLinha(child, /"id":1/, BOOT_BUDGET_MS);
    assert.match(out, /"serverInfo"/, "handshake MCP completo");
    child.stdin?.end();
    const code = await esperaSaida(child, BOOT_BUDGET_MS);
    assert.equal(code, 0, "EOF no stdin encerra o bridge sem erro");
  } finally {
    child.kill("SIGKILL");
  }
});
