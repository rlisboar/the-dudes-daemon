/**
 * T-1054: turno do grok pelo ACP persistente (`grok agent stdio`).
 *
 * O que este teste trava é o MOTIVO do card: com o ACP o processo é reusado
 * entre mensagens — o segundo turno NÃO paga boot nenhum (um único `session/new`
 * no handshake, prompts seguintes na MESMA sessão). O binário real é substituído
 * pelo fake ACP (mesmo dialecto), então nada aqui depende do grok instalado.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentRunner } from "../agent-runner.js";
import { resolveCliCommands } from "../cli-config.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-server.mjs", import.meta.url));
const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;

function off() { return { command: "false", source: "override" as const, available: false }; }

function harness(): {
  runner: AgentRunner;
  textos: string[];
  tools: Array<{ nome: string }>;
  pensamentos: string[];
  lerLog: () => Array<Record<string, unknown>>;
  dir: string;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t1054-"));
  // T-1088: caminho FIXO em /tmp era compartilhado com outros arquivos que usam
  // esta mesma fixture (t690/t827) — um deles apagava/reescrevia o arquivo e a
  // leitura aqui estourava com ENOENT (a "interferência entre paralelos").
  // O wrapper exporta o caminho no SPAWN (o runner não repassa env arbitrário).
  const logAcp = path.join(dir, "acp.jsonl");
  const wrapper = path.join(dir, "acp.sh");
  writeFileSync(wrapper, `#!/bin/sh\nFAKE_ACP_LOG=${JSON.stringify(logAcp)} exec ${JSON.stringify(FIXTURE)} "$@"\n`);
  chmodSync(wrapper, 0o755);
  const textos: string[] = [];
  const pensamentos: string[] = [];
  const tools: Array<{ nome: string }> = [];
  const info = {
    id: `agent_t1054_${process.pid}_${Math.random().toString(36).slice(2, 8)}`,
    ownerUserId: "u", name: "t1054", role: "backend",
    systemPrompt: "sys", color: "#7aa2ff", state: "idle", running: true,
    // model/effort existem para exercitar o `set_config_option` do handshake
    // (o `agent stdio` não aceita flags de modelo).
    model: "deepseek-v4-flash", effort: "high",
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
    collectThinking: true,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "grok", autoApprove: true, workspaceRoot: dir,
    cliCommands: { ...resolveCliCommands(), grok: { command: wrapper, source: "override" as const, available: true }, "grok-custom": off() },
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: (t: string) => { textos.push(t); return true; },
    onThinkingText: (t: string) => pensamentos.push(t),
    onToolUse: (nome: string) => tools.push({ nome }),
    onError: () => {}, onHung: () => {}, onExit: () => {},
  } as never);
  return {
    runner, textos, tools, pensamentos, dir,
    lerLog: () => {
      try { return readFileSync(logAcp, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>); }
      catch { return []; } // arquivo do próprio dir pode ainda não existir
    },
  };
}

async function until(cond: () => boolean, ms = 20_000, o = "condição"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout aguardando ${o}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("T-1054: turno pelo ACP entrega texto, adota a sessão e reporta a tool", async (t) => {
  const antes = process.env.THE_DUDES_GROK_ACP;
  process.env.THE_DUDES_GROK_ACP = "1";
  t.after(() => { if (antes === undefined) delete process.env.THE_DUDES_GROK_ACP; else process.env.THE_DUDES_GROK_ACP = antes; });
  const h = harness();
  t.after(() => h.runner.stop());

  h.runner.pushUserMessage("olá grok");
  await until(() => h.textos.length > 0, 8_000, "texto do assistant");

  assert.match(h.textos[0]!, /olá grok/, "texto do turno chega ao runner");
  const sid = asAny(h.runner).messageSession.sessionId;
  assert.ok(typeof sid === "string" && sid.length > 0, "sessão ACP adotada");
  assert.equal(h.tools[0]?.nome, "list_tasks", "tool_call do ACP vira onToolUse");
  assert.equal(h.pensamentos.join("").includes("pensando"), true, "thought em stream");

  const metodos = h.lerLog().map((l) => l.method).filter(Boolean);
  for (const m of ["initialize", "session/new", "session/set_config_option", "session/prompt"]) {
    assert.ok(metodos.includes(m), `handshake ACP chamou ${m} (log: ${metodos.join(",")})`);
  }
});

test("T-1054: o processo é REUSADO — 2º turno não refaz boot nem abre sessão", async (t) => {
  const antes = process.env.THE_DUDES_GROK_ACP;
  process.env.THE_DUDES_GROK_ACP = "1";
  t.after(() => { if (antes === undefined) delete process.env.THE_DUDES_GROK_ACP; else process.env.THE_DUDES_GROK_ACP = antes; });
  const h = harness();
  t.after(() => h.runner.stop());

  h.runner.pushUserMessage("primeira");
  await until(() => h.textos.length > 0, 20_000, "1º turno");
  // espera o 1º turno ASSENTAR (busy false) antes de fotografar: um retry dele
  // caindo depois da foto contava como se fosse o 2º turno refazendo boot.
  await until(() => asAny(h.runner).messageSession.busy === false, 20_000, "1º turno assentou");
  const pid1 = asAny(h.runner).grokAcp?.pid?.();
  assert.ok(pid1, "cliente ACP vivo após o 1º turno");
  // T-1088: a contagem de handshake é ancorada DEPOIS do 1º turno. Sob carga o
  // primeiro turno pode sofrer um retry (cliente novo) — isso é o retry, não o
  // "boot por turno" que o teste denuncia. O que importa é o 2º turno NÃO refazer.
  const aposPrimeiro = h.lerLog().map((l) => l.method);
  const inicializa1 = aposPrimeiro.filter((m) => m === "initialize").length;
  const sessoes1 = aposPrimeiro.filter((m) => m === "session/new").length;
  const prompts1 = aposPrimeiro.filter((m) => m === "session/prompt").length;

  h.runner.pushUserMessage("segunda");
  await until(() => h.textos.length > 1, 20_000, "2º turno");

  assert.equal(asAny(h.runner).grokAcp?.pid?.(), pid1, "MESMO processo no 2º turno (é o ganho do card)");
  const log = h.lerLog();
  assert.equal(log.filter((l) => l.method === "session/new").length, sessoes1, `o 2º turno não abre sessão nova | pid1=${pid1} pidAgora=${asAny(h.runner).grokAcp?.pid?.()} metodos=${log.map((l) => l.method).join(",")}`);
  assert.equal(log.filter((l) => l.method === "initialize").length, inicializa1, "nem refaz o handshake");
  // relativo à foto: se o 1º turno sofreu retry, ele já custou prompts extras ✓
  assert.equal(log.filter((l) => l.method === "session/prompt").length, prompts1 + 1, "o 2º turno foi UM prompt na mesma sessão");
});

test("T-1054: stop mata o cliente ACP (processo persistente não vaza)", async (t) => {
  const antes = process.env.THE_DUDES_GROK_ACP;
  process.env.THE_DUDES_GROK_ACP = "1";
  t.after(() => { if (antes === undefined) delete process.env.THE_DUDES_GROK_ACP; else process.env.THE_DUDES_GROK_ACP = antes; });
  const h = harness();
  h.runner.pushUserMessage("oi");
  await until(() => h.textos.length > 0, 25_000, "turno");  // T-1088: carga dupla
  const pid = asAny(h.runner).grokAcp?.pid?.() as number;
  assert.ok(pid > 0);

  h.runner.stop();
  await until(() => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }, 20_000, "cliente morto");
  assert.equal(asAny(h.runner).grokAcp, null, "a referência do cliente é liberada");
});

test("T-1054: com a flag OFF nenhum cliente ACP é criado (headless segue dono)", async (t) => {
  const antes = process.env.THE_DUDES_GROK_ACP;
  delete process.env.THE_DUDES_GROK_ACP;
  t.after(() => { if (antes !== undefined) process.env.THE_DUDES_GROK_ACP = antes; });
  const h = harness();
  t.after(() => h.runner.stop());
  // Sem flag, o caminho headless spawna o fixture com os args do headless — o
  // fake ACP não responde a `-p`, então basta provar que o cliente não existiu.
  h.runner.pushUserMessage("oi");
  await until(() => asAny(h.runner).ocActiveProc !== null, 20_000, "spawn do headless");
  assert.equal(asAny(h.runner).grokAcp, undefined, "sem cliente ACP com a flag off");
});