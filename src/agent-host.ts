import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { AgentRunner, type AgentRunnerOptions } from "./agent-runner.js";
import { breadcrumb, captureWarn } from "./sentry.js";
import { assertWorkspaceScoped, autoWorkspaceCwd, cloneRepoIfMissing, expandBasePath, findGitRoot, getWorkspaceRoot, isInsideRoot, repoCwd } from "./workspace.js";
import { encryptForProject, redactCredentials, redactCredentialsDeep } from "./daemon-crypto.js";
import type { ResolvedCliCommands } from "./cli-config.js";
import type { AgentInfo, ImageAttachment } from "./types.js";
import type { AgentSpawn, FromDaemon } from "./protocol.js";
import type { DropTarget } from "./privileges.js";
import { compatibleSessionId } from "./runners/index.js";

// Works in both CJS bundle (where __dirname is native) and ESM dev (tsx)
// where we fall back to the process entry script.
const baseDir: string = (() => {
  // @ts-expect-error — __dirname only exists in the bundled CJS build
  if (typeof __dirname !== "undefined") return __dirname as string;
  const entry = process.argv[1] || ".";
  return path.dirname(path.resolve(entry));
})();

function resolveBridge(): { command: string; args: string[] } {
  // Bundled distribution (cjs)
  const bundled = path.resolve(baseDir, "mcp-bridge.cjs");
  if (fs.existsSync(bundled)) return { command: "node", args: [bundled] };
  // Compiled tsc output
  const compiled = path.resolve(baseDir, "mcp-bridge.js");
  if (fs.existsSync(compiled)) return { command: "node", args: [compiled] };
  // Dev: tsx + .ts source
  const source = path.resolve(baseDir, "mcp-bridge.ts");
  const tsxBin = (() => {
    const candidates = [
      path.resolve(baseDir, "../node_modules/.bin/tsx"),
      path.resolve(baseDir, "../../node_modules/.bin/tsx"),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return "tsx";
  })();
  return { command: tsxBin, args: [source] };
}

interface Entry {
  info: AgentInfo;
  runner: AgentRunner | null;
  autoApprove: boolean;
  /** Project ID, captured at spawn. Used to look up the E2EE key when
   *  the bridge relay needs to encrypt/decrypt agent_to_agent traffic. */
  projectId?: string;
  /** Agent token (passed via THE_DUDES_AGENT_TOKEN env). Necessário
   *  pra ressincronizar com o server após restart — server perde o
   *  Map agentTokens (in-memory) mas o processo mcp-bridge segue
   *  rodando com o token antigo. Daemon devolve no resync. */
  agentToken?: string;
  /** Espelho Telegram: chat vinculado pra onde TODA saída do agente é
   *  encaminhada (texto em claro). Setado via agent:send.telegram. */
  telegramMirror?: { botToken: string; chatId: string };
}

export class AgentHost {
  private entries = new Map<string, Entry>();
  private autoApproveDefault = false;
  /** Liga watch debounced do grafo (setado pelo DaemonClient). */
  onGraphWatch?: (workspaceRoot: string, graphifyBin: string, projectId?: string) => void;

  /**
   * Após reindex bem-sucedido: injeta graphify MCP nos agentes já rodando
   * com features.graph (reescreve configs no disco).
   */
  refreshGraphifyMcpForAgents(mcpCommand: string, gPath: string): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (!e.runner) continue;
      try {
        if (e.runner.refreshGraphifyMcp(mcpCommand, gPath)) n++;
      } catch { /* skip */ }
    }
    return n;
  }

  constructor(
    private send: (msg: FromDaemon) => void,
    private dropTo: DropTarget | null = null,
    private bridgeSocketPath: string | null = null,
    private cliCommands: ResolvedCliCommands,
    private verbose: boolean = false,
    private verboseHuman: boolean = false,
    private verboseHumanIo: boolean = false,
    private log: (level: "info" | "warn" | "error", msg: string) => void = () => {},
    private cliLog: (level: "info" | "warn" | "error", msg: string) => void = () => {},
  ) {}

  /** Returns the project ID this agent is spawned into, or null if the
   *  agent isn't tracked locally (e.g. message destined for an agent on
   *  another daemon — bridge relay falls back to passing through). */
  getAgentProjectId(agentId: string): string | null {
    return this.entries.get(agentId)?.projectId ?? null;
  }

  /** Vincula/desvincula o agente a um chat do Telegram (espelho de saída). */
  setTelegramMirror(agentId: string, mirror: { botToken: string; chatId: string } | null): void {
    const e = this.entries.get(agentId);
    if (!e) return;
    e.telegramMirror = mirror ?? undefined;
  }

  /** Encaminha um texto pro chat do Telegram via Bot API (egress local, SSRF
   *  guard). Best-effort: falha não derruba o turno do agente. */
  private async mirrorToTelegram(mirror: { botToken: string; chatId: string }, text: string): Promise<void> {
    try {
      const { safeFetch } = await import("./ssrf-guard.js");
      const url = `https://api.telegram.org/bot${mirror.botToken}/sendMessage`;
      // Telegram corta em 4096 chars/mensagem.
      const body = JSON.stringify({ chat_id: mirror.chatId, text: text.slice(0, 4096), disable_web_page_preview: true });
      await safeFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }, { maxRedirects: 0 });
    } catch (e) {
      // Redact o token do bot caso o erro (undici/cause) ecoe a URL.
      const safe = ((e as Error).message ?? "").replace(/bot\d+:[\w-]+/g, "bot***");
      this.log("warn", `[telegram-mirror] falha enviando pro chat ${mirror.chatId}: ${safe}`);
    }
  }

  setAutoApprove(value: boolean) {
    this.autoApproveDefault = value;
  }

  async spawn(msg: AgentSpawn): Promise<void> {
    const existing = this.entries.get(msg.agent.id);
    if (existing?.runner) {
      // Distingue RECONNECT (WS reconectou; mesma config) de RECONFIG
      // (troca de runner/model/effort/… — server parou e re-spawnou). No
      // reconfig, o spawn pode chegar ANTES do runner antigo terminar de
      // sair (race com o fallback de 8s do server). Sem este check, o
      // re-broadcast abaixo re-attacha no runner VELHO e o novo nunca sobe
      // — agente fica mudo até reiniciar, OU (pior) segue com effort/model
      // antigo se só o effort mudou. Detecta a mudança e derruba o velho.
      const reconfig =
        existing.info?.cliRunner !== msg.agent.cliRunner ||
        existing.info?.model !== msg.agent.model ||
        existing.info?.effort !== msg.agent.effort ||
        existing.info?.collectThinking !== msg.agent.collectThinking ||
        existing.info?.planMode !== msg.agent.planMode ||
        existing.info?.claudeConfigDir !== msg.agent.claudeConfigDir;
      if (!reconfig) {
        // Reconnect puro — re-anuncia estado pro orchestrator reconciliar.
        // Re-anuncia o token: server perdeu o Map agentTokens (in-memory)
        // após restart e o mcp-bridge segue com o token antigo — sem isto
        // /api/bridge devolve 401 nas próximas chamadas.
        if (existing.agentToken) {
          this.send({ type: "agent:token_resync", agentId: msg.agent.id, token: existing.agentToken });
        }
        this.send({ type: "agent:running", agentId: msg.agent.id, running: true });
        const sid = existing.info?.sessionId ?? existing.runner.info?.sessionId;
        if (sid) this.send({ type: "agent:session", agentId: msg.agent.id, sessionId: sid });
        this.send({ type: "agent:state", agentId: msg.agent.id, state: existing.runner.currentRuntimeState() });
        return;
      }
      // Reconfig: derruba o runner antigo antes de criar o novo. Seu
      // onExit tardio não vai zerar o novo (guard `e.runner === thisRunner`).
      try { existing.runner.stop(); } catch { /* já morto */ }
      existing.runner = null;
    }

    // Resolve cwd:
    //   - agentRepo present → legacy path: cwdOverride/<repo.name>; clone repo there if missing.
    //   - agentRepo absent + cwdOverride → cwdOverride direct.
    //   - else detect git from basePath automatically; legacy repoName is only
    //     used when that subfolder already exists.
    let cwd: string;
    // Em container/scoped: os paths configurados na UI (basePath/cwdOverride)
    // são do HOST e podem não existir aqui. Se THE_DUDES_WORKSPACE_ROOT está
    // setado e o path cai fora dele, usa o próprio root (= a pasta montada,
    // ex: /workspace) — senão o agente nem inicia no daemon containerizado.
    const wsRoot = getWorkspaceRoot();
    const remap = (p: string | undefined): string | undefined =>
      (!p || !wsRoot || isInsideRoot(expandBasePath(p), wsRoot)) ? p : wsRoot;
    const cwdOverrideEff = remap(msg.cwdOverride);
    const basePathEff = remap(msg.basePath) ?? msg.basePath;
    if (wsRoot && (cwdOverrideEff !== msg.cwdOverride || basePathEff !== msg.basePath)) {
      this.send({
        type: "agent:error",
        agentId: msg.agent.id,
        message: `workspace configurado fica fora do root permitido — usando "${wsRoot}" (THE_DUDES_WORKSPACE_ROOT)`,
      });
    }
    if (msg.agentRepo && cwdOverrideEff) {
      const cwdOverride = expandBasePath(cwdOverrideEff);
      cwd = repoCwd(cwdOverride, msg.agentRepo.name);
      if (!fs.existsSync(path.join(cwd, ".git"))) {
        this.send({
          type: "agent:error",
          agentId: msg.agent.id,
          message: `clonando ${msg.agentRepo.name} em ${cwd} …`,
        });
        try {
          // ensure parent dir exists
          if (!fs.existsSync(cwdOverride)) {
            fs.mkdirSync(cwdOverride, { recursive: true });
            if (this.dropTo) try { fs.chownSync(cwdOverride, this.dropTo.uid, this.dropTo.gid); } catch {}
          }
          const result = await cloneRepoIfMissing(
            cwdOverride,
            { id: "agent", name: msg.agentRepo.name, gitUrl: msg.agentRepo.gitUrl, defaultBranch: msg.agentRepo.branch },
            this.dropTo,
          );
          if (!result.ok) {
            this.send({
              type: "agent:error",
              agentId: msg.agent.id,
              message: `git clone falhou: ${result.message}`,
            });
            this.send({ type: "agent:running", agentId: msg.agent.id, running: false });
            return;
          }
        } catch (e) {
          this.send({
            type: "agent:error",
            agentId: msg.agent.id,
            message: `setup falhou: ${(e as Error).message}`,
          });
          this.send({ type: "agent:running", agentId: msg.agent.id, running: false });
          return;
        }
      }
    } else if (cwdOverrideEff) {
      cwd = expandBasePath(cwdOverrideEff);
      if (!fs.existsSync(cwd)) {
        fs.mkdirSync(cwd, { recursive: true });
        if (this.dropTo) try { fs.chownSync(cwd, this.dropTo.uid, this.dropTo.gid); } catch {}
      }
    } else if (msg.repoName) {
      const legacyRepoCwd = repoCwd(expandBasePath(basePathEff), msg.repoName);
      cwd = fs.existsSync(legacyRepoCwd) ? legacyRepoCwd : autoWorkspaceCwd(basePathEff);
    } else {
      cwd = autoWorkspaceCwd(basePathEff);
      if (!fs.existsSync(cwd)) {
        fs.mkdirSync(cwd, { recursive: true });
        if (this.dropTo) try { fs.chownSync(cwd, this.dropTo.uid, this.dropTo.gid); } catch {}
      }
    }
    // Blast-radius: o cwd resolvido (incluindo cwdOverride vindo do server)
    // tem que estar dentro do THE_DUDES_WORKSPACE_ROOT, se configurado.
    try {
      assertWorkspaceScoped(cwd);
    } catch (e) {
      this.send({ type: "agent:error", agentId: msg.agent.id, message: (e as Error).message });
      this.send({ type: "agent:running", agentId: msg.agent.id, running: false });
      return;
    }
    this.log("info", `agent ${msg.agent.id} cwd resolvido=${cwd}${wsRoot ? ` (root=${wsRoot})` : ""}`);
    if (!fs.existsSync(cwd)) {
      this.send({
        type: "agent:error",
        agentId: msg.agent.id,
        message: `cwd "${cwd}" not found — set workspace and clone repos first`,
      });
      this.send({ type: "agent:running", agentId: msg.agent.id, running: false });
      return;
    }

    // Git worktree isolation: create an isolated worktree for this agent
    // so it never shares the same working directory with other agents.
    let worktreePath: string | undefined;
    if (msg.agentWorktrees) {
      const gitRoot = findGitRoot(cwd);
      if (gitRoot) {
        const worktreesDir = path.join(gitRoot, "..", "worktrees");
        // Sanitiza o nome do agente ANTES de montar o path. Vinha cru aqui
        // (só branchName era limpo) — um nome com "../" colapsava via
        // path.join e o worktreePath apontava fora de worktreesDir, com
        // rmSync recursivo + git worktree add + chown rodando ANTES do
        // realpath-check (dano já feito).
        const safeName = msg.agent.name.replace(/[^a-zA-Z0-9_-]/g, "-");
        const idSuffix = msg.agent.id.slice(0, 8);
        const branchName = `agent/${safeName}-${idSuffix}`;
        worktreePath = path.join(worktreesDir, `${safeName}-${idSuffix}`);
        try {
          // Containment antes de qualquer operação destrutiva (rmSync/add/chown).
          if (!path.resolve(worktreePath).startsWith(path.resolve(worktreesDir) + path.sep)) {
            throw new Error(`worktree path escapou da base: ${worktreePath}`);
          }
          // E também dentro do workspace root permitido, se configurado.
          assertWorkspaceScoped(worktreePath);
          if (!fs.existsSync(worktreesDir)) {
            fs.mkdirSync(worktreesDir, { recursive: true });
            // chown pro user dropado — sem isso, daemon root cria dir
            // root-owned + CLI (uid=1000) não escreve dentro depois.
            if (this.dropTo) {
              try { fs.chownSync(worktreesDir, this.dropTo.uid, this.dropTo.gid); } catch {}
            }
          }
          if (fs.existsSync(worktreePath)) {
            fs.rmSync(worktreePath, { recursive: true, force: true });
          }
          // stdio pipe pra não bufferar git verboso até estourar maxBuffer (1MB)
          // e pra poder inspecionar stderr no erro. encoding utf-8 pra ler a msg.
          const wtRes = spawnSync(
            "git",
            ["worktree", "add", "-b", branchName, worktreePath],
            { cwd: gitRoot, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
          );
          if (wtRes.error || wtRes.status !== 0) {
            // Falha (branch já existe, HEAD destacado, árvore suja…). Não cair
            // silenciosamente no cwd compartilhado: avisa e mantém o cwd base.
            const detail = wtRes.error?.message ?? ((wtRes.stderr || "").trim() || `exit ${wtRes.status}`);
            this.send({
              type: "agent:error",
              agentId: msg.agent.id,
              message: `worktree isolado falhou (${detail}) — agente roda no cwd compartilhado`,
            });
            worktreePath = undefined;
          } else if (this.dropTo && fs.existsSync(worktreePath)) {
            // chown recursive — git worktree add criou árvore como root.
            try {
              const chownRecursive = (p: string) => {
                fs.chownSync(p, this.dropTo!.uid, this.dropTo!.gid);
                const st = fs.statSync(p);
                if (st.isDirectory()) {
                  for (const f of fs.readdirSync(p)) chownRecursive(path.join(p, f));
                }
              };
              chownRecursive(worktreePath);
            } catch {}
          }
          // Só segue se o worktree foi de fato criado (git ok acima).
          if (worktreePath) {
            // Defesa em profundidade: garantir que o worktree resolvido
            // não escapou da pasta de worktrees (symlink/race).
            const resolvedWt = fs.realpathSync(worktreePath);
            const resolvedBase = fs.realpathSync(worktreesDir);
            if (!resolvedWt.startsWith(resolvedBase + path.sep)) {
              fs.rmSync(worktreePath, { recursive: true, force: true });
              throw new Error(`worktree escapou da base: ${resolvedWt}`);
            }
            if (fs.existsSync(worktreePath)) {
              cwd = worktreePath;
              this.send({
                type: "agent:error",
                agentId: msg.agent.id,
                message: `worktree isolado criado em ${worktreePath} (branch ${branchName})`,
              });
            }
          }
        } catch (e) {
          // Não engolir silenciosamente: o throw aqui vem do escape-guard de
          // containment (path traversal / symlink) — é segurança, tem que
          // aparecer. Cai no cwd compartilhado depois de avisar.
          this.send({
            type: "agent:error",
            agentId: msg.agent.id,
            message: `worktree isolado abortado: ${(e as Error).message}`,
          });
        }
      }
    }

    const bridge = resolveBridge();
    const cliRunner = msg.agent.cliRunner ?? "claude";
    // Drop any session id that isn't valid for this runner. claude uses
    // UUIDs, opencode uses `ses_*`, codex uses opaque thread ids — passing
    // a wrong-format id makes the CLI exit immediately.
    const resumeSessionId = compatibleSessionId(cliRunner, msg.agent.sessionId);
    // Identidade do runner deste spawn. Usada no onExit pra só zerar
    // `e.runner` se ainda for ESTE runner — senão o exit tardio de um
    // runner antigo (troca de runner) zeraria o runner novo.
    let thisRunner: AgentRunner | null = null;
    const opts: AgentRunnerOptions = {
      bridgeCommand: bridge.command,
      bridgeArgs: bridge.args,
      orchestratorUrl: msg.orchUrl,
      agentToken: msg.agentToken,
      cliRunner,
      autoApprove: msg.autoApprove,
      workspaceRoot: cwd,
      resumeSessionId,
      dropTo: this.dropTo,
      bridgeSocketPath: this.bridgeSocketPath,
      extraMcpServers: msg.extraMcpServers,
      features: msg.features,
      cliCommands: this.cliCommands,
      verbose: this.verbose,
      verboseHuman: this.verboseHuman,
      verboseHumanIo: this.verboseHumanIo,
      log: this.log,
      cliLog: this.cliLog,
      onState: (state) => this.send({ type: "agent:state", agentId: msg.agent.id, state }),
      onHung: (info) => {
        this.send({
          type: "agent:hung",
          agentId: msg.agent.id,
          soft: info.soft,
          reason: info.reason,
          idleMs: info.idleMs,
          runner: cliRunner,
        });
      },
      onAssistantText: (text) => {
        // Redact credenciais que o agente buscou (get_credential) e ecoou, ANTES
        // de cifrar — em projeto E2EE o server não vê o plaintext, então a
        // redação tem que ser aqui. Depois cifra com a project key. Sem key
        // (legacy/pre-bootstrap) cai pro plaintext já redatado.
        const red = msg.projectId ? redactCredentials(msg.projectId, text) : text;
        const enc = msg.projectId ? encryptForProject(red, msg.projectId) : null;
        this.send({ type: "agent:text", agentId: msg.agent.id, text: enc ?? red });
        // Espelho Telegram: encaminha a MESMA resposta (em claro, já redatada)
        // pro chat vinculado. Server é E2EE-cego, por isso o mirror é aqui.
        const mirror = this.entries.get(msg.agent.id)?.telegramMirror;
        if (mirror && red.trim()) void this.mirrorToTelegram(mirror, red);
      },
      onToolUse: (toolName, input) => this.send({
        type: "agent:tool_use",
        agentId: msg.agent.id,
        toolName,
        // tool_use.input vai cru pro server (não cifrado); redact aqui as
        // credenciais conhecidas (ex `curl -H "Authorization: Bearer <cred>"`).
        input: msg.projectId ? redactCredentialsDeep(msg.projectId, input) : input,
      }),
      onThinkingText: (text, thinkOpts) => {
        const red = msg.projectId ? redactCredentials(msg.projectId, text) : text;
        const enc = msg.projectId ? encryptForProject(red, msg.projectId) : null;
        this.send({ type: "agent:thinking", agentId: msg.agent.id, text: enc ?? red, redacted: !!thinkOpts?.redacted });
      },
      onSessionId: (sid) => this.send({ type: "agent:session", agentId: msg.agent.id, sessionId: sid }),
      onUsageDelta: (delta) => this.send({ type: "agent:usage_delta", agentId: msg.agent.id, delta }),
      onSessionInvalid: () => {
        this.send({
          type: "agent:error",
          agentId: msg.agent.id,
          message: "[ctx] sessão anterior não encontrada — iniciando sessão nova",
        });
      },
      onContextUsage: (used, limit) => this.send({ type: "agent:context", agentId: msg.agent.id, used, limit }),
      onContextWarning: (used, limit) => this.send({ type: "agent:context_warning", agentId: msg.agent.id, used, limit }),
      onContextFull: () => this.send({ type: "agent:context_full", agentId: msg.agent.id }),
      projectId: msg.projectId,
      onGraphStatus: (status, info) => this.send({
        type: "graph:status",
        projectId: msg.projectId,
        status,
        nodeCount: info?.nodeCount,
        edgeCount: info?.edgeCount,
        error: info?.error,
        progress: info?.progress,
        phase: info?.phase,
        indexMtime: info?.indexMtime,
        stale: info?.stale,
        graphifyAvailable: info?.graphifyAvailable,
        graphifyMcpAvailable: info?.graphifyMcpAvailable,
        docsPending: info?.docsPending,
        hasSemantic: info?.hasSemantic,
      }),
      onGraphWatch: (root, gbin) => this.onGraphWatch?.(root, gbin, msg.projectId),
      onError: (err) => {
        // stderr do agente pode conter credencial (echo/uso). Redacta as creds
        // conhecidas ANTES de sair do daemon (vira system message no server,
        // server-visível por design — então redact, não cifra).
        const message = msg.projectId ? redactCredentials(msg.projectId, String(err ?? "")) : String(err ?? "");
        this.send({ type: "agent:error", agentId: msg.agent.id, message });
      },
      onExit: (code) => {
        const e = this.entries.get(msg.agent.id);
        // Se este runner já foi substituído (reconfig/troca de runner), seu
        // exit tardio NÃO deve mexer no estado do agente — senão derruba o
        // runner novo que acabou de subir. Só o runner ativo reporta exit.
        if (e && e.runner !== thisRunner) {
          breadcrumb("agent", "exit-superseded", { agentId: msg.agent.id, code, runner: cliRunner });
          return;
        }
        if (e) e.runner = null;
        this.send({ type: "agent:exit", agentId: msg.agent.id, code });
        this.send({ type: "agent:running", agentId: msg.agent.id, running: false });
        breadcrumb("agent", "exit", { agentId: msg.agent.id, code, runner: cliRunner });
        // Exit code 0 = normal; null = signal kill (provavelmente intencional);
        // resto = crash inesperado, vale capture.
        if (code !== 0 && code !== null) {
          captureWarn(`agent runner exited code=${code}`, {
            agentId: msg.agent.id,
            agentName: msg.agent.name,
            runner: cliRunner,
            code,
          });
        }
      },
    };
    const runner = new AgentRunner(msg.agent, opts);
    thisRunner = runner;
    runner.start().catch((e) => this.log("error", `agent ${msg.agent.id} start failed: ${(e as Error).message}`));
    this.entries.set(msg.agent.id, {
      info: msg.agent,
      runner,
      autoApprove: msg.autoApprove,
      projectId: msg.projectId,
      agentToken: msg.agentToken,
    });
    this.send({ type: "agent:running", agentId: msg.agent.id, running: true });
  }

  listAgentTokens(): { id: string; token: string }[] {
    const out: { id: string; token: string }[] = [];
    for (const [id, e] of this.entries) {
      if (e.runner && e.agentToken) out.push({ id, token: e.agentToken });
    }
    return out;
  }

  stop(agentId: string) {
    const e = this.entries.get(agentId);
    if (!e?.runner) return;
    e.runner.stop();
  }

  send_message(agentId: string, content: string, images?: ImageAttachment[]) {
    const e = this.entries.get(agentId);
    if (!e?.runner) return;
    e.runner.pushUserMessage(content, images);
  }

  async clear(agentId: string) {
    const e = this.entries.get(agentId);
    if (!e?.runner) return;
    try { await e.runner.clearContext(); } catch (err) {
      this.send({ type: "agent:error", agentId, message: `clear failed: ${(err as Error).message}` });
    }
  }

  async compact(agentId: string, saveMemory = true) {
    const e = this.entries.get(agentId);
    if (!e?.runner) return;
    try { await e.runner.compactContext(saveMemory); } catch (err) {
      this.send({ type: "agent:error", agentId, message: `compact failed: ${(err as Error).message}` });
    }
  }

  shutdown() {
    for (const e of this.entries.values()) {
      if (e.runner) try { e.runner.stop(); } catch {}
    }
  }
}
