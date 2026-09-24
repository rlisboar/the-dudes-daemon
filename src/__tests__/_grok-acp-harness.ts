/**
 * Harness compartilhado dos testes do driver ACP do grok (T-1063/T-1072).
 *
 * (a) O modo e o caminho do log do fake vão por ARQUIVO, num diretório ÚNICO por
 *     execução (`tmpdir()` do `@the-dudes/test-utils`) — com caminho fixo em
 *     `/tmp`, duas execuções simultâneas da suíte colidiam (T-1072).
 * (b) O caminho chega ao CLI pelo allowlist de env do runner
 *     (`THE_DUDES_AGENT_ENV_PASSTHROUGH`), que é o mecanismo desenhado para isso.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentRunner } from "../agent-runner.js";
import { resolveCliCommands } from "../cli-config.js";
import { tmpdir } from "./tmp.js";

export const FIXTURE = fileURLToPath(new URL("./fixtures/fake-grok-acp.mjs", import.meta.url));
export const asAny = (r: AgentRunner) => r as unknown as Record<string, any>;

export interface ModoAcp {
  /** Capability anunciada: `load` (default, como o grok real) ou `resume`. */
  caps?: "load" | "resume";
  /** Passo que reprova: vazio, `load` ou `initialize`. */
  falha?: string;
}

export interface HarnessAcp {
  runner: AgentRunner;
  dir: string;
  textos: string[];
  erros: string[];
  sessoes: string[];
  /** Reescreve o modo (o fake lê o arquivo a cada request). */
  modo(m: ModoAcp): void;
  lerLog: () => Array<{ method?: string }>;
}

/** Sobe um AgentRunner com o fake ACP no lugar do CLI do grok. */
export function harnessAcp(m: ModoAcp = {}): HarnessAcp {
  const dir = tmpdir("t1072-acp-"); // único por execução e limpo no exit
  const modoFile = path.join(dir, "modo.json");
  const logFile = path.join(dir, "acp.jsonl");
  const escrever = (novo: ModoAcp): void => writeFileSync(modoFile, JSON.stringify({ ...novo, log: logFile }));
  escrever(m);
  // T-1083 (c): isolamento POR RUNNER, não global. O wrapper abaixo é o "CLI" que
  // o runner spawna: ele exporta o caminho do modo ANTES de virar a fixture, então
  // dois harnesses (t1063 e t1072, ou dois testes no mesmo arquivo) não disputam
  // `process.env.THE_DUDES_AGENT_ENV_PASSTHROUGH` — quem manda no env é o spawn.
  const wrapper = path.join(dir, "grok-acp.sh");
  writeFileSync(wrapper, `#!/bin/sh\nT1063_MODE_FILE=${JSON.stringify(modoFile)} exec ${JSON.stringify(FIXTURE)} "$@"\n`);
  chmodSync(wrapper, 0o755);

  const textos: string[] = [];
  const erros: string[] = [];
  const sessoes: string[] = [];
  const info = {
    id: `agent_t1072_${process.pid}_${Math.random().toString(36).slice(2, 8)}`,
    ownerUserId: "u", name: "t1072", role: "backend",
    systemPrompt: "sys", color: "#7aa2ff", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
    sessionId: "sessao-antiga",
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: "node", bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0",
    agentToken: "t", cliRunner: "grok", autoApprove: true, workspaceRoot: dir,
    cliCommands: { ...resolveCliCommands(), grok: { command: wrapper, source: "override" as const, available: true } },
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {},
    onAssistantText: (t: string) => { textos.push(t); return true; },
    onThinkingText: () => {}, onToolUse: () => {},
    onSessionId: (sid: string) => sessoes.push(sid),
    onError: (e: string) => erros.push(e), onHung: () => {}, onExit: () => {},
  } as never);
  return {
    runner, dir, textos, erros, sessoes,
    modo: (novo: ModoAcp) => escrever(novo),
    lerLog: () => {
      try {
        return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { method?: string });
      } catch { return []; }
    },
  };
}

export async function until(cond: () => boolean, ms = 8_000, o = "condição"): Promise<void> {
  const t0 = Date.now();
  // T-1094: `T1094_POLL=immediate` aperta o poll (era 25ms) e expõe corridas de
  // "espera satisfeita por linha errada" — é a alavanca do repro do QA-A.
  const passo = process.env.T1094_POLL === "immediate" ? () => new Promise((r) => setImmediate(r)) : () => new Promise((r) => setTimeout(r, 25));
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout aguardando ${o}`);
    await passo();
  }
}

/** Liga a flag do driver ACP e restaura o ambiente ao fim do teste. */
export function comFlagAcp(t: { after: (f: () => void) => void }): void {
  const antes = process.env.THE_DUDES_GROK_ACP;
  process.env.THE_DUDES_GROK_ACP = "1";
  t.after(() => {
    if (antes === undefined) delete process.env.THE_DUDES_GROK_ACP; else process.env.THE_DUDES_GROK_ACP = antes;
  });
}
