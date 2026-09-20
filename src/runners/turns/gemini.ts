/* R7 (T-462): turno extraído do agent-runner — `self` é o AgentRunner. */
import { endTurn } from "./end-turn.js";
import {ChildProcess} from "node:child_process";
import {ImageAttachment} from "../../types.js";
import {PER_MSG_TURN_TIMEOUT_MS} from "../../agent-runner.js";
import {appendPathAttachmentPrompt} from "../attachments.js";
import {armHardTimeout} from "../process-lifecycle.js";
import {buildGeminiEnv} from "../env.js";
import {parseGeminiTurnEvent} from "../turn-parsers.js";
import {spawnDropped} from "../../privileges.js";


export function ingestGeminiLine(self: any, 
    obj: unknown,
    epoch: number,
    acc: { addText: (t: string) => void; onResult: () => void; flush: () => void },
  ): void {
    if (!self.messageSession.owns(epoch)) return;
    self.touchActivity();
    for (const event of parseGeminiTurnEvent(obj)) {
      if (event.type === "session") self.turnLatency?.current?.bootReady();
      if (event.type === "text" && event.text) self.turnLatency?.current?.semantic("text");
      if (event.type === "thought" && event.text) self.turnLatency?.current?.semantic("thinking");
      if (event.type === "tool") self.turnLatency?.current?.semantic("tool");
      if (event.type === "text") acc.addText(event.text);
      else if (event.type === "tool") {
        acc.flush();
        self.noteGrokToolInFlight();
        self.opts.onToolUse(event.name, event.input);
        self.setState("thinking");
      } else if (event.type === "result") {
        acc.onResult();
        self.clearGrokToolsInFlight();
        acc.flush();
      } else if (event.type === "usage") {
        const rawInput = event.input;
        const rawOutput = event.output;
        const rawCached = event.cacheRead;
        const cumulative = self.gemUsage.delta({ input: rawInput, output: rawOutput, cached: rawCached });
        self.opts.onUsageDelta?.({
          input: cumulative.input,
          output: cumulative.output,
          cacheCreate: 0,
          cacheRead: cumulative.cached,
        });
      }
    }
  }
export async function runGeminiMessage(self: any, content: string, images?: ImageAttachment[]) {
    const timing = self.turnLatency?.current;
    if (self.stopped) return;
    if (!self.ensureRunnerAvailable("gemini")) return;
    // T-251: gate de turno para TODOS os runners (antes só Grok) — sem isto
    // o self-update (idle = gate vazio) matava o CLI gemini em turno vivo.
    if (!(await self.gateTurn())) { self.messageSession.busy = false; return; }
    self.setState("thinking");
    const tmpDir = self.runtimeFiles.tempDir();
    self.writeGeminiConfig();
    let message = content;
    const firstTurnSnapshot = self.messageSession.consumeFirstTurnIfNeeded();
    const firstTurn = firstTurnSnapshot.firstTurn;
    // Preservados pra restaurar se o turno morrer sem completar: com o
    // --resume condicional, perder o firstTurn num turno falho mudaria QUAL
    // sessão o agente usa dali em diante (re-resume da sessão que o
    // clear/compact descartou) — e o resumo pendente seria perdido junto.
    const pendingSummary = firstTurnSnapshot.pendingSummary;
    const epoch = self.messageSession.epoch;
    if (firstTurn) {
      message = self.initialMessage(content, pendingSummary);
    }
    // Anexos: gemini lê arquivos referenciados por @<path> no prompt.
    let imgCleanup = () => {};
    if (images && images.length) {
      const { files, cleanup } = self.writeAttachmentFiles(images);
      imgCleanup = cleanup;
      message = appendPathAttachmentPrompt(message, files, "gemini");
    }
    self.traceCli("gemini", "argv", message);
    // Gemini só conecta MCP servers nomeados na allowlist. Montar
    // dinamicamente a partir de extraMcpServers (graphify + outros do
    // workspace) — senão a feature graph fica sem efeito no gemini.
    const allowedMcp = ["the-dudes", ...Object.keys(self.opts.extraMcpServers ?? {})]
      .filter((n, i, a) => a.indexOf(n) === i)
      .join(",");
    const args = [
      "--output-format", "stream-json",
      "--include-directories", self.opts.workspaceRoot,
      "--allowed-mcp-server-names", allowedMcp,
      "--skip-trust",
      "-p", message,
    ];
    if (self.info.model) args.push("--model", self.info.model);
    if (self.opts.autoApprove) args.push("--yolo");
    // Resume SÓ quando não é primeiro turno: o storage do gemini é indexado
    // pelo cwd (tmpdir da instância, nunca rotacionado) — `--resume latest`
    // incondicional re-abria a sessão CHEIA depois de clear/compact
    // (resetWithSummary não a apaga), tornando os dois no-ops e o compact um
    // loop infinito (resumo appendado na própria sessão que estourou).
    // Sem o resume, o processo novo cria sessão limpa que vira a "latest".
    if (!firstTurn) args.push("--resume", "latest");
    const env = buildGeminiEnv(self.buildEnv());
    self.traceSpawn("gemini", args);
    let proc: ChildProcess;
    try {
      proc = spawnDropped(self.runnerCommand("gemini"), args, {
      cwd: tmpDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }, self.opts.dropTo ?? null);
    } catch (e) {
      self.failTurnSpawn("gemini", e, epoch, imgCleanup, firstTurnSnapshot);
      return;
    }
    timing?.bootStart();
    self.ocActiveProc = proc;
    armHardTimeout(proc, PER_MSG_TURN_TIMEOUT_MS, () => {
      timing?.finish("hard-recover", "hard-timeout", "lifetime");
      self.opts.log("warn", `[gemini:${self.info.name}] turno excedeu ${PER_MSG_TURN_TIMEOUT_MS / 1000}s — SIGKILL`);
    });
    let buf = "";
    let pendingText = "";
    let sawResult = false;
    const flush = () => {
      // Epoch trocado (clear/compact durante o turno): texto da sessão
      // descartada não pode "falar" pós-reset.
      if (!self.messageSession.owns(epoch)) { pendingText = ""; return; }
      const t = pendingText.trim();
      if (t) {
        self.setState("speaking");
        self.opts.onAssistantText(t);
      }
      pendingText = "";
    };
    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      self.traceCli("gemini", "stdout", chunk);
      buf = self.capAccum("gemini", buf, chunk);
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("{")) continue;
        // Eventos de um turno pré-reset (proc morto pelo clear ainda drenando
        // stdout): result tardio envenenaria a gemStatsBase recém-zerada
        // (double-billing) e texto/tool velhos vazariam pós-clear.
        if (!self.messageSession.owns(epoch)) continue;
        try {
          self.ingestGeminiLine(JSON.parse(line), epoch, {
            addText: (t: any) => { pendingText += t; },
            onResult: () => { sawResult = true; },
            flush,
          });
        } catch {}
      }
    });
    proc.stderr!.on("data", (chunk: string) => {
      const msg = chunk.trim();
      if (msg) { self.traceCli("gemini", "stderr", msg); self.checkContextFullError(msg); self.opts.onError(msg); }
    });
    proc.on("close", (code) => {
      // R7: fim de turno único/idempotente (T-417 + T-251 preservados dentro).
      timing?.finish(sawResult ? "completed" : code === 0 ? "error" : "process-exit");
      endTurn(self, { epoch, code, sawResult, firstTurnSnapshot, beforeCleanup: flush, imgCleanup });
    });
  }
  /* ---------- Qwen Code per-message model (fork do Gemini CLI, stream JSONL
     estilo Claude; sessão uuid própria — primeiro turno cria com --session-id,
     seguintes retomam com -r; medido na 0.23.0) ---------- */