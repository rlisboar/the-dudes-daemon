/**
 * T-826: o controller (opencode glm-5.3) chamou a tool nativa `question` do
 * opencode 1.18 — pergunta de múltipla escolha que ESPERA resposta no TUI.
 * Sob o daemon não há TUI e a UI não mostra a pergunta: tool `running` para
 * sempre, sessão busy, turno preso e o agente "falando" na UI (o watchdog,
 * com tool em voo, só age aos 20min). A tool fica negada na config e
 * desligada em cada POST de turno. Medido num serve real: sem as medidas o
 * modelo chama `question`; com qualquer uma delas responde em texto.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpenCodeMcpConfig, OPENCODE_INTERACTIVE_TOOLS, OPENCODE_TURN_TOOLS } from "../runners/mcp-config.js";
import { runOpenCodeMessageAttached } from "../runners/turns/opencode.js";

const bridge = { command: "node", args: ["bridge.cjs"], env: {} };

test("T-826: config do opencode nega a `question` com e sem auto-approve", () => {
  assert.deepEqual([...OPENCODE_INTERACTIVE_TOOLS], ["question"]);
  const auto = buildOpenCodeMcpConfig({}, bridge, true);
  // "allow" é normalizado pelo serve para {"*":"allow"}: a negação só soma.
  assert.deepEqual(auto.config.permission, { "*": "allow", question: "deny" });
  const manual = buildOpenCodeMcpConfig({}, bridge, false);
  assert.equal((manual.config.permission as Record<string, string>).question, "deny");
  assert.equal((manual.config.permission as Record<string, string>).bash, "ask", "asks de sempre intactos");
});

test("T-826: POST do turno desliga a `question` (vale até num serve com config antiga)", async () => {
  const posts: Array<{ route: string; body: any }> = [];
  const self: any = {
    stopped: false,
    info: { id: "agent_t826", model: "zai-coding-plan/glm-5.3" },
    opts: { log: () => {}, onError: () => {} },
    openCodeTransport: { ready: () => true, abortSession: async () => {} },
    messageSession: {
      busy: true, epoch: 1, sessionId: "ses_t826", needsPrime: false,
      owns: () => true,
      restoreFirstTurn: () => {},
      consumeFirstTurnIfNeeded: () => ({ firstTurn: false, pendingSummary: undefined }),
    },
    fetchOcCatalogLimit: () => {},
    traceCli: () => {},
    attachNonImageFiles: (content: string) => ({ content, cleanup: () => {} }),
    scheduleAttachmentCleanup: () => {},
    turnLatency: { enqueue: () => {}, activate: () => {} },
    ensureRunnerAvailable: () => true,
    runOpenCodeMessage: async () => {},
  };
  self.ocServeFetch = async (route: string, method: string, body?: unknown) => {
    if (method === "POST") posts.push({ route, body });
    throw new Error("fim do teste");
  };
  await runOpenCodeMessageAttached(self, "oi", undefined, 0);
  self.stopped = true; // neutraliza o retry agendado pelo erro
  await new Promise((r) => setTimeout(r, 10));
  const turno = posts.find((p) => p.route === "/session/ses_t826/message");
  assert.ok(turno, `POST do turno enviado (vistos: ${posts.map((p) => p.route).join(", ")})`);
  assert.deepEqual(turno!.body.tools, OPENCODE_TURN_TOOLS);
  assert.equal(turno!.body.tools.question, false);
  assert.equal(turno!.body.agent, "the-dudes-managed", "o resto do corpo não muda");
});

test("T-826: dashboard sobe para warn a tool em voo SEM atividade além do soft (o caso do controller)", async () => {
  const { diagnose } = await import("../debug/index.js");
  const gate = { pools: { main: { max: 3, active: 0, queued: 0, grants: 0, waited: 0, forced: 0, waitP50Ms: null, waitP95Ms: null, waitMaxMs: null }, bg: { max: 2, active: 0, queued: 0, grants: 0, waited: 0, forced: 0, waitP50Ms: null, waitP95Ms: null, waitMaxMs: null } }, holders: [], waiters: [], maxHoldMs: 1 };
  const agente = (idleMs: number) => ({
    agentId: "agent_75fadceb", name: "controller", cliRunner: "opencode", hasRunner: true,
    runner: {
      state: "speaking", inTurn: true, busy: true, queued: 0, idleMs,
      toolsInFlight: 1, toolsInFlightMs: 7 * 60_000,
      thresholds: { softMs: 180_000, hardMs: 600_000, toolsHardMs: 1_200_000 },
    },
  });
  const base = { platform: "linux", gate, loop: null, proc: null, ws: { readyState: 1 }, process: {}, system: {} };
  const mudo = diagnose({ ...base, agents: [agente(7 * 60_000)] } as never)
    .filter((a: { area: string }) => a.area === "agente");
  assert.equal(mudo.length, 1);
  assert.equal(mudo[0]!.level, "warn");
  assert.match(mudo[0]!.title, /controller \(opencode\): 1 tool\(s\) em voo há .* sem nenhuma atividade/);
  assert.match(mudo[0]!.action ?? "", /GET \/question/);
  // Tool longa mas dando sinal (eventos recentes): continua só informativo.
  const vivo = diagnose({ ...base, agents: [agente(20_000)] } as never)
    .filter((a: { area: string }) => a.area === "agente");
  assert.equal(vivo.length, 1);
  assert.equal(vivo[0]!.level, "info");
});
