/* R7 (T-462): one-shot extraído do agent-runner — `self` é o AgentRunner. */
import {ONE_SHOT_TIMEOUT_MS} from "../agent-runner.js";
import {ChildProcess} from "node:child_process";
import {RUNNER_OUTPUT_CAP_BYTES, collectProcessOutput, processAlive as procAlive, terminateAndWait} from "./process-lifecycle.js";
import {acquireTurnSlot} from "./turn-gate.js";
import {buildGeminiEnv, buildQwenEnv} from "./env.js";
import {claudeOneShotArgs, codexOneShotArgs, crushOneShotArgs, geminiOneShotArgs, opencodeOneShotArgs, qwenOneShotArgs} from "./args.js";
import {extractOneShotText} from "./parsers.js";
import {isGrokFamily} from "./index.js";
import {recordTurnEnd, recordTurnStart} from "../health-monitor.js";
import {resolvePython3} from "../cli-config.js";
import {spawnDropped} from "../privileges.js";

export async function runOneShot(self: any, prompt: string): Promise<string> {
    if (self.stopped) return "";
    // Semáforo global: N turnos de CLI simultâneos = N×~120MB; ver turn-gate.
    const pool = self.info.ephemeral ? "bg" as const : "main" as const;
    const releaseSlot = await acquireTurnSlot(`${self.opts.cliRunner}:${self.info.name}`, self.opts.log, pool);
    if (self.stopped) { releaseSlot(); return ""; }
    recordTurnStart(self.opts.cliRunner);
    const turnoT0 = Date.now();
    return new Promise<string>((resolveRaw) => {
      // Todo caminho de saída passa pelo resolve → o slot volta junto.
      // (Promise ignora resolve duplo e o release é idempotente; a métrica
      // usa o mesmo funil — saída vazia conta como falha do turno.)
      let contabilizado = false;
      const resolve = (v: string) => {
        if (!contabilizado) {
          contabilizado = true;
          recordTurnEnd(self.opts.cliRunner, Date.now() - turnoT0, v.trim().length > 0);
        }
        releaseSlot();
        resolveRaw(v);
      };
      // stop() antes do spawn: sem o check, o one-shot nasce DEPOIS do
      // emitExit (que apagou o tmpdir) e roda órfão consumindo API.
      if (self.stopped) { resolve(""); return; }
      if (!self.ensureRunnerAvailable(self.opts.cliRunner)) {
        resolve("");
        return;
      }
      let proc: ChildProcess;
      const runner = self.opts.cliRunner;
      const sid = runner === "claude" ? self.opts.resumeSessionId : self.messageSession.sessionId;
      if (runner === "gemini") {
        const args = geminiOneShotArgs({ prompt, model: self.info.model, sessionId: sid });
        self.traceCli("gemini", "argv", prompt);
        self.traceSpawn("gemini", args);
        proc = spawnDropped(self.runnerCommand("gemini"), args, {
          cwd: self.runtimeFiles.tempDir(),
          env: buildGeminiEnv(self.buildEnv()),
          stdio: ["ignore", "pipe", "pipe"],
        }, self.opts.dropTo ?? null);
      } else if (runner === "qwen") {
        // Compact/one-shot na MESMA sessão do agente (resume + stream-json).
        // Prompt via STDIN: `-p` é deprecated e rebenta com prompt iniciado
        // por `-` (yargs); stdin é a via canónica do doc headless.
        // cwd = qwenCwdDir (estável): sessões qwen são project-scoped pelo
        // cwd — com tempDir aleatório o `-r` não acha a sessão pós-restart.
        const args = qwenOneShotArgs({ prompt, model: self.info.model, sessionId: sid });
        self.writeQwenConfig();
        self.traceCli("qwen", "argv", prompt);
        self.traceSpawn("qwen", args);
        proc = spawnDropped(self.runnerCommand("qwen"), args, {
          cwd: self.runtimeFiles.qwenCwdDir(),
          env: buildQwenEnv(self.buildEnv()),
          stdio: ["pipe", "pipe", "pipe"],
        }, self.opts.dropTo ?? null);
        proc.stdin?.on("error", () => { /* EPIPE: CLI morreu cedo */ });
        proc.stdin?.end(prompt);
      } else if (runner === "codex") {
        const args = codexOneShotArgs({ prompt, model: self.info.model, sessionId: sid });
        self.traceCli("codex", "argv", prompt);
        self.traceSpawn("codex", args);
        proc = spawnDropped(self.runnerCommand("codex"), args, {
          cwd: self.opts.workspaceRoot,
          env: self.buildEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        }, self.opts.dropTo ?? null);
      } else if (runner === "crush") {
        const args = crushOneShotArgs({ prompt, model: self.info.model, sessionId: sid, dataDir: self.runtimeFiles.crushDataDir() });
        self.traceCli("crush", "argv", prompt);
        self.traceSpawn("crush", args);
        proc = spawnDropped(self.runnerCommand("crush"), args, {
          cwd: self.opts.workspaceRoot,
          env: self.crushTurnEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        }, self.opts.dropTo ?? null);
      } else if (isGrokFamily(runner)) {
        // Headless one-shot: plain text (compact/summarize). Session resume
        // via --resume; --always-approve = non-interactive tool approval.
        const args = self.buildGrokHeadlessArgs(prompt, {
          resume: sid,
          outputFormat: "json",
          forCompact: true,
        });
        self.traceCli(runner, "argv", prompt);
        self.traceSpawn(runner, args);
        proc = spawnDropped(self.runnerCommand(runner), args, {
          cwd: self.opts.workspaceRoot,
          env: self.grokTurnEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        }, self.opts.dropTo ?? null);
      } else if (runner === "opencode") {
        const args = opencodeOneShotArgs({ prompt, model: self.info.model, sessionId: sid, autoApprove: self.opts.autoApprove });
        self.traceCli("opencode", "argv", prompt);
        self.traceSpawn("opencode", args);
        const py = resolvePython3();
        if (!py) { self.opts.onError("python3 não encontrado em path absoluto — opencode precisa do wrapper PTY"); resolve(""); return; }
        proc = spawnDropped(py, ["-c", "import pty,sys; pty.spawn(sys.argv[1:])", self.runnerCommand("opencode"), ...args], {
          cwd: self.opts.workspaceRoot,
          env: self.buildEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        }, self.opts.dropTo ?? null);
      } else {
        const args = claudeOneShotArgs({ prompt, model: self.info.model, sessionId: sid });
        self.traceCli("claude", "argv", prompt);
        self.traceSpawn("claude", args);
        proc = spawnDropped(self.runnerCommand("claude"), args, {
          cwd: self.opts.workspaceRoot,
          env: self.buildEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        }, self.opts.dropTo ?? null);
      }
      self.oneShotProc = proc; // stop() precisa alcançar o one-shot (senão roda órfão até o timeout)
      void collectProcessOutput(proc, {
        timeoutMs: ONE_SHOT_TIMEOUT_MS,
        onStdout: (chunk) => self.traceCli(runner, "stdout", chunk),
        onStderr: (chunk) => self.traceCli(runner, "stderr", chunk),
        onTruncated: (stream) => self.opts.log("warn", `[${runner}:${self.info.name}] ${stream} exceeded ${RUNNER_OUTPUT_CAP_BYTES} bytes — truncated`),
      }).then((result) => {
        if (self.oneShotProc === proc) self.oneShotProc = null;
        resolve(result.timedOut ? "" : extractOneShotText(result.stdout, runner));
      });
    });
  }
export async function runOneShotWithSession(self: any, prompt: string, sessionId: string): Promise<string> {
    // T-251: compact com sessão também passa pelo gate (pool bg) — o
    // self-update usa o gate como prova de idle; sem isto mataria o
    // one-shot de resumo no meio. Release LOCAL (não activeTurnRelease: o
    // slot do turno principal pode estar em voo e o campo é um só).
    const releaseSlot = await acquireTurnSlot(`${self.opts.cliRunner}:${self.info.name}`, self.opts.log, "bg");
    if (self.stopped) { releaseSlot(); return ""; }
    return new Promise((resolveRaw) => {
      const resolve = (v: string): void => { releaseSlot(); resolveRaw(v); };
      if (self.stopped) { resolve(""); return; } // mesmo guard do runOneShot
      if (!self.ensureRunnerAvailable("claude")) {
        resolve("");
        return;
      }
      const args = ["--print", "-p", prompt, "--resume", sessionId];
      if (self.info.model) args.push("--model", self.info.model);
      self.traceSpawn("claude", args);
      const proc = spawnDropped(self.runnerCommand("claude"), args, {
        cwd: self.opts.workspaceRoot,
        env: self.buildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }, self.opts.dropTo ?? null);
      self.oneShotProc = proc; // stop() precisa alcançar o one-shot
      void collectProcessOutput(proc, {
        timeoutMs: ONE_SHOT_TIMEOUT_MS,
        onStdout: (chunk) => self.traceCli("claude", "stdout", chunk),
        onStderr: (chunk) => self.traceCli("claude", "stderr", chunk),
        onTruncated: (stream) => self.opts.log("warn", `[claude:${self.info.name}] ${stream} exceeded ${RUNNER_OUTPUT_CAP_BYTES} bytes — truncated`),
      }).then((result) => {
        if (self.oneShotProc === proc) self.oneShotProc = null;
        resolve(result.timedOut ? "" : result.stdout.trim());
      });
    });
  }
  /** Encaminha onExit pro orchestrator no máximo uma vez (guard idempotente
   *  contra stop() repetido ou close handler racing). */
export async function killClaudeForRestart(self: any, ): Promise<void> {
    // Teste de vida por exitCode/signalCode, NÃO por .killed: kill() marca
    // killed=true no ENVIO do sinal — early-return por .killed pulava a espera
    // quando outro caminho já tinha sinalizado (processo ainda vivo) e a
    // escalação SIGKILL nunca disparava (código morto).
    const proc = self.proc;
    if (!procAlive(proc)) return;
    self.restarting = true;
    await terminateAndWait(proc, { beforeTerminate: () => { try { proc.stdin!.end(); } catch {} } });
    self.restarting = false;
  }