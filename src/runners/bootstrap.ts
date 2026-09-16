/* R7 (T-462): bootstrap/spawn/config extraído do agent-runner — `self` é o AgentRunner. */
import {CliRunner} from "../types.js";
import {CONTROLLER_ROLE} from "../bridge-tool-gate.js";

import {RUNNER_OUTPUT_CAP_BYTES, appendCapped} from "./process-lifecycle.js";
import {buildAgentContext, buildInitialMessage, buildSystemPromptHeader, buildWorkspacePrompt} from "./prompts.js";
import {buildBaseRunnerEnv} from "./env.js";
import {buildBridgeEnv, buildClaudeMcpConfig, buildGeminiMcpServers, buildOpenCodeMcpConfig, buildQwenMcpServers} from "./mcp-config.js";
import {buildGraph, graphExists, graphMtime, graphPath, hasSemanticMarker, needsSemanticUpdate} from "../graph-indexer.js";
import {buildOpenCodeAgentConfig} from "./opencode-effort.js";

import {claudeThinkingEffort, qwenConfigContextLimit, qwenReasoningEffort} from "./model-policy.js";
import {existsSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {isGrokFamily, runnerAdapter} from "./index.js";

import http from "node:http";
import https from "node:https";

import path from "node:path";
import {startClaude, handleStdout, handleStreamEvent} from "./turns/claude.js";
export { startClaude, handleStdout, handleStreamEvent };
export function bootPerMessageRunner(self: any) {
    // NÃO dispara turno no start. Gastar tokens só pra "hello" é desperdício
    // (agentes iniciados em lote e nunca usados).
    //
    // - Resume (sessionId): sessão no disco já tem system+histórico.
    //   Próxima msg real usa --resume / -s / etc.
    // - Cold start: firstTurn permanece true → o 1º user/a2a message
    //   real injeta system+role+skills na hora do turno (runGrokMessage etc).
    //
    // Antes: pushUserMessage("[system] Context loaded…") forçava um call
    // ao CLI em todo start (cold e, pior, com re-injeção + resume).
    self.setState("idle");
    if (self.messageSession.sessionId) {
      self.messageSession.firstTurn = false;
      self.opts.log(
        "info",
        `[cli:${self.info.id}:${self.opts.cliRunner}] resume session=${self.messageSession.sessionId.slice(0, 8)}… — idle, aguardando input`,
      );
    } else {
      self.opts.log(
        "info",
        `[cli:${self.info.id}:${self.opts.cliRunner}] cold start — idle, system prompt no 1º input real`,
      );
    }
  }
  /** Env do mcp-bridge: lista de grupos de contexto ligados. Objeto vazio
   *  quando não há features (bridge registra tudo). Spread nos 4 config
   *  writers do bridge (gemini/opencode/claude/codex). */
export function featuresEnv(self: any, ): Record<string, string> {
    const f = self.opts.features;
    if (!f) return {};
    const on: string[] = [];
    if (f.teammates !== false) on.push("teammates");
    if (f.tasks !== false) on.push("tasks");
    if (f.filelock !== false) on.push("filelock");
    if (f.memory !== false) on.push("memory");
    if (f.goals !== false) on.push("goals");
    if (f.credentials !== false) on.push("credentials");
    if (f.webhooks !== false) on.push("webhooks");
    // board/graph são opt-in (default off) — só entram se true explícito
    if (f.graph === true) on.push("graph");
    if (f.board === true) on.push("board");
    // O bridge precisa saber a linguagem pra descrever a tool e validar o
    // kind — sem isso o agente escreveria mermaid num projeto configurado
    // pra d2 e o bloco chegaria na UI sem renderer.
    const lang = f.diagramLanguage === "d2" ? "d2" : "mermaid";
    const env: Record<string, string> = { THE_DUDES_FEATURES: on.join(","), THE_DUDES_DIAGRAM_LANG: lang };
    if (f.boardMode === "html") {
      env.THE_DUDES_BOARD_MODE = "html";
      env.THE_DUDES_BOARD_HTML_LEVEL = f.boardHtmlLevel ?? "normal";
    }
    return env;
  }
export function bridgeEnv(self: any, ): Record<string, string> {
    return buildBridgeEnv({
      agentId: self.info.id,
      agentName: self.info.name,
      orchestratorUrl: self.opts.orchestratorUrl,
      tokenFile: self.runtimeFiles.tokenFile(),
      features: self.featuresEnv(),
      socketPath: self.opts.bridgeSocketPath ?? undefined,
      // T-391: único ponto onde o papel sai do runner e chega ao bridge (pelos
      // 4 config writers, um só spread). O bridge omite o que o papel não é.
      role: self.info.role,
    });
  }
export function writeGeminiConfig(self: any) {
    const dir = self.runtimeFiles.geminiConfigDir();
    // Gemini settings.json aceita `mcpServers` no mesmo shape do Claude
    // (command/args/env pra stdio; url/headers pra http). Apenas o campo
    // `type` é específico do Claude e deve ficar fora aqui.
    const mcpServers = buildGeminiMcpServers(self.opts.extraMcpServers, {
      command: self.opts.bridgeCommand,
      args: self.opts.bridgeArgs,
      env: self.bridgeEnv(),
    });
    const config = { mcpServers };
    // mode 0o600: o JSON contém THE_DUDES_AGENT_TOKEN inline em "env".
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
  }
  /** Qwen Code: QWEN_HOME POR AGENTE com settings.json = config do dono
   *  (~/.qwen/settings.json, auth/model/baseUrl) FUNDO com o mcpServers do
   *  bridge por cima. Copiar o config do usuário é o que mantém o auth vivo:
   *  QWEN_HOME substitui o dir inteiro, não faz overlay. Re-escrito a cada
   *  start/turno (o dono pode editar o dele; o daemon respira a mudança no
   *  próximo turno). */
export function writeQwenConfig(self: any) {
    const dir = self.runtimeFiles.qwenHomeDir();
    const mcpServers = buildQwenMcpServers(self.opts.extraMcpServers, {
      command: self.opts.bridgeCommand,
      args: self.opts.bridgeArgs,
      env: self.bridgeEnv(),
    });
    let merged: Record<string, unknown> = {};
    try {
      const home = self.opts.dropTo?.home ?? process.env.HOME ?? "";
      const userCfg = path.join(home, ".qwen", "settings.json");
      if (home && existsSync(userCfg)) {
        const parsed = JSON.parse(readFileSync(userCfg, "utf8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) merged = parsed as Record<string, unknown>;
      }
    } catch { /* config do dono ilegível → só mcpServers (o dono pode autenticar depois) */ }
    merged.mcpServers = mcpServers;
    // T-343: effort do agente → model.reasoningEffort (o CLI lê daqui; não
    // existe flag CLI — medido no bundle 0.23.0). Sem effort no agente, o
    // valor do dono passa tal-e-qual (fundo é do dono); "none" desliga.
    {
      const qEffort = qwenReasoningEffort(self.info.effort);
      if (qEffort) {
        const modelCfg = (merged.model && typeof merged.model === "object" && !Array.isArray(merged.model))
          ? merged.model as Record<string, unknown>
          : {};
        modelCfg.reasoningEffort = qEffort;
        merged.model = modelCfg;
      }
    }
    // Janela de contexto: a mesma fonte que o próprio CLI usa (medido no
    // bundle 0.23.0: compact/thresholds = generationConfig.contextWindowSize
    // ?? 200k). Sem esta linha a barra de contexto fica UNKNOWN para sempre
    // — o init do stream-json NÃO traz janela e o modelo custom (baseUrl)
    // não está no mapa estático.
    self.contextTracker.setCatalogLimit(qwenConfigContextLimit(merged, self.info.model));
    // mode 0o600: o config do DONO pode trazer apiKey inline + o nosso env do bridge.
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify(merged, null, 2), { mode: 0o600 });
  }
  /** Path do config do opencode POR AGENTE (dir privado, fora do workspace).
   *  Passado ao serve/run via env OPENCODE_CONFIG (suportado no 1.17.x). */
export function writeOpenCodeConfig(self: any) {
    // Config POR AGENTE em dir privado + OPENCODE_CONFIG no env do serve.
    // Histórico: já morou no workspaceRoot (COMPARTILHADO entre agentes) —
    // 1ª versão com identidade literal = last-writer-wins (todos os serves
    // viravam o último agente); 2ª com placeholders {env:} = quebrava o CLI
    // manual no workspace, nome de agente com aspas corrompia o JSON (a
    // substituição é texto cru pré-parse) e o bloco mcp (filtrado pelo
    // mcpAllowlist POR agente) continuava clobberado. Arquivo por agente
    // elimina as três classes: valores literais (JSON.stringify escapa),
    // workspace intocado, mcp allowlist por agente respeitado.
    const configPath = self.runtimeFiles.openCodeConfigPath();
    // Remove o opencode.json legado que versões anteriores deixaram no
    // workspace — SÓ se for nosso (marker mcp "the-dudes"); nunca o config
    // próprio do usuário.
    try {
      const legacy = path.join(self.opts.workspaceRoot, "opencode.json");
      if (existsSync(legacy) && readFileSync(legacy, "utf8").includes('"the-dudes"')) {
        rmSync(legacy);
        self.opts.log("info", `[opencode:${self.info.name}] opencode.json legado removido do workspace (config agora é por agente via OPENCODE_CONFIG)`);
      }
    } catch { /* best-effort */ }
    // BUG histórico: faltava `environment` → o mcp-bridge spawnado pelo serve
    // não recebia THE_DUDES_AGENT_TOKEN_FILE → mandava Bearer vazio →
    // /api/bridge 401 (as tools the-dudes nunca funcionaram no opencode).
    // Valores LITERAIS por agente: o arquivo agora é por agente (ver
    // ocConfigPath), então identidade aqui é segura — e JSON.stringify escapa
    // nome com aspas/backslash. featuresEnv via spread: chave AUSENTE segue
    // significando "registra tudo (inclusive grupos futuros)" no bridge.
    const built = buildOpenCodeMcpConfig(self.opts.extraMcpServers, {
      command: self.opts.bridgeCommand,
      args: self.opts.bridgeArgs,
      env: self.bridgeEnv(),
    }, self.opts.autoApprove, buildOpenCodeAgentConfig(self.info.model, self.info.effort));
    for (const warning of built.warnings) self.opts.log("warn", `[opencode:${self.info.name}] ${warning}`);
    const config = built.config;
    // Não escreve `provider.*`: isso pode substituir/corromper providers
    // nativos. Effort entra num agent isolado, cujas opções adicionais o
    // OpenCode repassa ao provider sem alterar a configuração global.
    try {
      // mode 0o600: contém TOKEN_FILE path e identidade; dir já é 0700.
      writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    } catch (e) {
      console.error(`[opencode:${self.info.name}] failed to write opencode.json: ${e}`);
    }
  }
export function buildEnv(self: any, ): NodeJS.ProcessEnv {
    // CLI process NÃO recebe THE_DUDES_AGENT_TOKEN — leak via
    // /proc/<pid>/environ pra outros procs do mesmo user. Bridge MCP
    // (spawned como child do CLI) recebe via TOKEN_FILE inline em
    // mcp.json/settings.json — esse env só vai pro proc bridge, não
    // pro CLI runner.
    // Scrub adicional: THE_DUDES_DAEMON_TOKEN do process.env do daemon
    // vazaria pro CLI agente (prompt injection no agente poderia fazer
    // ele revelar/exfiltrar). Mesmo motivo pra outras chaves sensíveis.
    const env = buildBaseRunnerEnv({
      inherited: process.env,
      runner: self.opts.cliRunner,
      agentId: self.info.id,
      agentName: self.info.name,
      orchestratorUrl: self.opts.orchestratorUrl,
      bridgeSocketPath: self.opts.bridgeSocketPath ?? undefined,
      claudeConfigDir: self.opts.cliRunner === "claude" ? self.resolveClaudeConfigDir() : undefined,
      opencodeConfigPath: self.opts.cliRunner === "opencode" ? self.runtimeFiles.openCodeConfigPath() : undefined,
      qwenHome: self.opts.cliRunner === "qwen" ? self.runtimeFiles.qwenHomeDir() : undefined,
    });
    if (self.opts.cliRunner === "codex") env.CODEX_HOME = self.runtimeFiles.codexHomeDir();
    return env;
  }
export function resolveClaudeConfigDir(self: any, ): string | undefined {
    const home = self.opts.dropTo?.home ?? process.env.HOME ?? "";
    // Override por env (container): ignora o campo por-agente, que costuma
    // apontar pra path do HOST inexistente no container. Permite montar as
    // credenciais num único dir fixo (ex: THE_DUDES_CLAUDE_CONFIG_DIR=
    // /root/.config/claude + -v <creds-do-host>:/root/.config/claude).
    const forced = process.env.THE_DUDES_CLAUDE_CONFIG_DIR?.trim();
    if (forced) return self.expandHome(forced, home);
    const custom = self.info.claudeConfigDir?.trim();
    if (custom) return self.expandHome(custom, home);
    // Default nativo: NÃO definir CLAUDE_CONFIG_DIR. Claude Code pode guardar
    // OAuth no Keychain/credential store associado ao HOME; forçar até mesmo
    // ~/.claude altera o contexto de autenticação em versões atuais.
    return undefined;
  }
export function expandHome(self: any, p: string, home: string): string {
    if (!home) return p;
    if (p === "~" || p === "$HOME") return home;
    if (p.startsWith("~/")) return path.join(home, p.slice(2));
    if (p.startsWith("$HOME/")) return path.join(home, p.slice(6));
    if (p.startsWith("${HOME}/")) return path.join(home, p.slice(8));
    return p;
  }
export function buildClaudeArgs(self: any, ): string[] {
    const mcpConfig = self.writeMcpConfig();
    const planAddon = self.info.planMode
      ? `\n\n# PLAN MODE ACTIVE\nDo NOT execute destructive tools (Write, Edit, Bash that mutates state, etc.). Only Read, Grep, Glob and analysis. Output a clear, numbered plan and ask the user to confirm before any execution. Wait for explicit user approval before proceeding.`
      : "";
    // Allowed-tools base: tools internos do bridge "the-dudes" sempre liberados
    // (não passa pelo permission-prompt). Cada MCP server extra ganha um
    // wildcard `mcp__<name>__*` pra não cair em prompt — quando o user
    // libera um MCP via allowlist, ele já está confiando.
    const baseAllowed = [
      "mcp__the-dudes__send_message",
      "mcp__the-dudes__list_agents",
      "mcp__the-dudes__list_tasks",
      "mcp__the-dudes__add_task",
      "mcp__the-dudes__update_task",
      "mcp__the-dudes__lock_task",
      "mcp__the-dudes__unlock_task",
      "mcp__the-dudes__add_task_comment",
      "mcp__the-dudes__list_task_comments",
      "mcp__the-dudes__list_goals",
      "mcp__the-dudes__get_credential",
      "mcp__the-dudes__send_webhook",
      "mcp__the-dudes__list_webhooks",
    ];
    // T-391 A3/A5 (T-397: + start/remove): as tools do controller só entram na
    // lista de quem É controller — num projeto com teammates ligado, um BACKEND
    // não as vê.
    if (self.info.role === CONTROLLER_ROLE) {
      baseAllowed.push(
        "mcp__the-dudes__save_agent",
        "mcp__the-dudes__stop_agent",
        "mcp__the-dudes__start_agent",
        "mcp__the-dudes__remove_agent",
      );
    }
    const extraAllowed: string[] = [];
    if (self.opts.extraMcpServers) {
      for (const name of Object.keys(self.opts.extraMcpServers)) {
        if (name === "the-dudes") continue;
        extraAllowed.push(`mcp__${name}__*`);
      }
    }
    const args = [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--mcp-config", mcpConfig,
      "--append-system-prompt",
      buildAgentContext(self.promptContext(undefined, planAddon)),
      "--allowed-tools",
      [...baseAllowed, ...extraAllowed].join(","),
    ];
    if (self.opts.autoApprove) {
      args.push("--permission-mode", "bypassPermissions");
    } else {
      // O McpServer registra como "the-dudes" (com hífen); Claude Code
      // expõe via mcp__the-dudes__approve_action. Underscore dispara
      // "tool not found" e mata o agent.
      args.push("--permission-prompt-tool", "mcp__the-dudes__approve_action");
    }
    if (self.info.model) args.push("--model", self.info.model);
    // Claude only emits `thinking` blocks when --effort gives the model
    // enough thinking budget AND the prompt is complex enough to warrant
    // it. low/medium have ~zero budget. high/xhigh/max all engage thinking
    // when the prompt requires reasoning. Floor at "high" when the user
    // opted in but set a level too low to ever emit thinking.
    const effortPolicy = claudeThinkingEffort(self.info.effort, !!self.info.collectThinking);
    if (effortPolicy.lifted) {
      const prev = self.info.effort ?? "(unset)";
      self.traceInternalCli("info", `[cli:${self.info.id}:claude:thinking] effort lifted from "${prev}" to "high" because collectThinking=true`);
    }
    if (effortPolicy.effort) args.push("--effort", effortPolicy.effort);
    if (self.info.collectThinking) {
      // Required to make Claude CLI emit thinking content (not just signature).
      // See https://github.com/anthropics/claude-code/issues/56356
      args.push("--thinking", "adaptive", "--thinking-display", "summarized");
      const m = (self.info.model ?? "").toLowerCase();
      if (m.includes("opus-4-7") || m === "opus") {
        self.traceInternalCli("warn", `[cli:${self.info.id}:claude:thinking] WARNING: Opus 4.7 has a known bug (issue #56356) — thinking content arrives empty. Use sonnet (4.6) or claude-opus-4-6 instead.`);
      }
    }
    if (self.opts.resumeSessionId) args.push("--resume", self.opts.resumeSessionId);
    return args;
  }
export function writeMcpConfig(self: any, ): string {
    const dir = self.runtimeFiles.tempDir();
    const configPath = path.join(dir, "mcp.json");
    const config = buildClaudeMcpConfig(self.opts.extraMcpServers, {
      command: self.opts.bridgeCommand, args: self.opts.bridgeArgs, env: self.bridgeEnv(),
    });
    // mode 0o600: contém THE_DUDES_AGENT_TOKEN; tmpdir 0o700 protege parent.
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    const names = Object.keys(config.mcpServers).filter((n) => n !== "the-dudes");
    self.opts.log("info", `[mcp:write] agent=${self.info.name} servers=[${names.join(",") || "(only-bridge)"}] path=${configPath}`);
    return configPath;
  }
  /* ---------- Claude stdout parsing ---------- */
export function capAccum(self: any, label: string, buf: string, chunk: string): string {
    const next = appendCapped(buf, chunk);
    if (next.justHit) {
      self.opts.log("warn", `[${label}:${self.info.name}] output exceeded ${RUNNER_OUTPUT_CAP_BYTES} bytes — truncated`);
    }
    return next.text;
  }
export async function prepareGraphify(self: any) {
    if (!self.opts.features?.graph) return;
    const mcpBin = self.opts.cliCommands.graphifyMcp;
    const gbin = self.opts.cliCommands.graphify;
    const avail = {
      graphifyAvailable: !!gbin?.available,
      graphifyMcpAvailable: !!mcpBin?.available,
    };
    if (!mcpBin?.available) {
      self.opts.log("warn", `[graph:${self.info.name}] feature ligada mas graphify-mcp não encontrado — pip install graphifyy mcp. Pulando.`);
      self.opts.onGraphStatus?.("error", { error: "graphify-mcp não instalado (pip install graphifyy mcp)", ...avail });
      return;
    }
    const root = self.opts.workspaceRoot;
    const hadIndex = graphExists(root);
    const inject = (): boolean => {
      if (!graphExists(root)) return false;
      self.opts.extraMcpServers = {
        ...(self.opts.extraMcpServers ?? {}),
        graphify: {
          type: "stdio",
          command: mcpBin.command,
          args: [graphPath(root), "--transport", "stdio"],
        },
      };
      return true;
    };
    // Índice existente → serve agora; refresh code-only em background.
    // O `graphify update` preserva nós semânticos (docs) de runs anteriores.
    if (hadIndex) {
      inject();
      self.opts.onGraphStatus?.("ready", {
        ...avail,
        indexMtime: graphMtime(root),
        stale: needsSemanticUpdate(root),
        docsPending: needsSemanticUpdate(root),
        hasSemantic: hasSemanticMarker(root),
      });
      if (gbin?.available) {
        self.opts.log("info", `[graph:${self.info.name}] índice presente — refresh code-only em background (preserva docs).`);
        void buildGraph(root, gbin.command).then((r) => {
          if (self.stopped) return;
          if (r.ok) {
            self.opts.log("info", `[graph:${self.info.name}] refresh: ${r.nodeCount ?? "?"} nós, ${r.edgeCount ?? "?"} arestas.`
              + (needsSemanticUpdate(root) ? " (docs pendentes — use + docs)" : ""));
            self.opts.onGraphStatus?.("ready", {
              nodeCount: r.nodeCount,
              edgeCount: r.edgeCount,
              indexMtime: graphMtime(root),
              stale: needsSemanticUpdate(root),
              docsPending: needsSemanticUpdate(root),
              hasSemantic: hasSemanticMarker(root),
              ...avail,
            });
          } else {
            self.opts.log("warn", `[graph:${self.info.name}] refresh falhou (mantém índice antigo): ${r.error}`);
          }
        }).catch((e) => {
          self.opts.log("warn", `[graph:${self.info.name}] refresh exceção: ${(e as Error).message}`);
        });
        // Watch debounced (idempotente por root) — mantém fresco entre spawns.
        self.opts.onGraphWatch?.(root, gbin.command);
      }
      return;
    }
    // Sem índice: precisa do CLI de build; bloqueia spawn até o 1º index.
    if (!gbin?.available) {
      self.opts.log("warn", `[graph:${self.info.name}] sem índice e graphify (build) não encontrado — pulando injeção.`);
      self.opts.onGraphStatus?.("error", { error: "graphify não instalado (pip install graphifyy mcp)", ...avail });
      return;
    }
    self.opts.onGraphStatus?.("building", { phase: "update", progress: 5, ...avail });
    self.opts.log("info", `[graph:${self.info.name}] indexando workspace (1ª vez, graphify update)…`);
    const r = await buildGraph(root, gbin.command, {
      onProgress: (p) => {
        if (self.stopped) return;
        self.opts.onGraphStatus?.("building", { phase: p.phase, progress: p.progress, ...avail });
      },
    });
    if (self.stopped) return;
    if (r.ok) {
      self.opts.log("info", `[graph:${self.info.name}] índice pronto: ${r.nodeCount ?? "?"} nós, ${r.edgeCount ?? "?"} arestas.`);
      self.opts.onGraphStatus?.("ready", {
        nodeCount: r.nodeCount,
        edgeCount: r.edgeCount,
        indexMtime: graphMtime(root),
        stale: false,
        progress: 100,
        ...avail,
      });
      inject();
      self.opts.onGraphWatch?.(root, gbin.command);
    } else {
      self.opts.log("warn", `[graph:${self.info.name}] build falhou: ${r.error}`);
      self.opts.onGraphStatus?.("error", { error: r.error, ...avail });
    }
  }
  /**
   * Hot-inject do MCP graphify após reindex (agentes já em execução).
   * Reescreve configs MCP no disco; runners per-message pegam no próximo turno;
   * Claude contínuo pode precisar de novo turno/restart pra reabrir o MCP.
   */
export function refreshGraphifyMcp(self: any, mcpCommand: string, gPath: string): boolean {
    if (self.stopped || !self.opts.features?.graph) return false;
    if (!mcpCommand || !gPath) return false;
    self.opts.extraMcpServers = {
      ...(self.opts.extraMcpServers ?? {}),
      graphify: {
        type: "stdio",
        command: mcpCommand,
        args: [gPath, "--transport", "stdio"],
      },
    };
    try {
      const r = self.opts.cliRunner;
      if (r === "claude") self.writeMcpConfig();
      else if (r === "opencode") self.writeOpenCodeConfig();
      else if (r === "gemini") self.writeGeminiConfig();
      else if (r === "crush") self.writeCrushConfig();
      else if (isGrokFamily(r)) self.writeGrokConfig();
      // codex: MCP args montados a cada turno a partir de extraMcpServers
      self.opts.log("info", `[graph:${self.info.name}] MCP graphify injetado/atualizado (hot) → ${gPath}`);
      return true;
    } catch (e) {
      self.opts.log("warn", `[graph:${self.info.name}] falha ao reescrever MCP: ${(e as Error).message}`);
      return false;
    }
  }
export function bridgePost(self: any, route: string, body: unknown): Promise<any> {
    const data = JSON.stringify(body);
    const path = `/api/bridge/${self.info.id}/${route}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(data)),
      "Authorization": `Bearer ${self.opts.agentToken}`,
    };
    const timeoutMs = 6 * 60_000;
    return new Promise((resolve, reject) => {
      let opts: import("node:http").RequestOptions;
      let isHttps = false;
      if (self.opts.bridgeSocketPath) {
        opts = { socketPath: self.opts.bridgeSocketPath, path, method: "POST", headers, timeout: timeoutMs };
      } else {
        let u: URL;
        try { u = new URL(self.opts.orchestratorUrl + path); } catch (e) { reject(e as Error); return; }
        // P2 (T-474): bridgePost ignorava https: — tudo ia por http.request e
        // um orchestrator https quebrava o bridge (TLS handshake corrompido).
        isHttps = u.protocol === "https:";
        opts = { hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers, timeout: timeoutMs };
      }
      const req = (isHttps ? https : http).request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const txt = Buffer.concat(chunks).toString("utf8");
          const sc = res.statusCode ?? 0;
          if (sc >= 200 && sc < 300) { try { resolve(txt ? JSON.parse(txt) : {}); } catch { resolve({}); } }
          else reject(new Error(`HTTP ${sc}${txt ? ` — ${txt.slice(0, 120)}` : ""}`));
        });
        res.on("error", (e) => reject(new Error(`resposta interrompida: ${e.message}`))); // mesmo hang do ocServeFetch
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
      req.write(data);
      req.end();
    });
  }
  /** Lê TODAS as mensagens da sessão e processa as parts ainda não vistas.
   *  Cobre tool calls que vivem em mensagens intermediárias (o POST /message
   *  só devolve a última). Fallback p/ resp.parts se o GET falhar.
   *  `sessionId` é a sessão DO TURNO (capturada antes do POST) — usar
   *  self.messageSession.sessionId aqui abriria janela pro clear no meio: GET em
   *  /session/undefined + dispatch de histórico velho pós-reset. */
export function runnerCommand(self: any, runner: CliRunner): string {
    return runnerAdapter(runner).command(self.opts.cliCommands);
  }
export function workspaceInfo(self: any, ): string {
    return buildWorkspacePrompt({ workspaceRoot: self.opts.workspaceRoot, repo: self.info.repo });
  }
export function promptContext(self: any, summary?: string, addon?: string) {
    return {
      // T-391: a prosa do controller entra só para quem tem o papel — os três
      // injetores (env do bridge, --allowed-tools, prompt) lêem o mesmo
      // self.info.role, nenhum depende de features do projeto.
      capabilityHeader: buildSystemPromptHeader(self.opts.features, {
        controller: self.info.role === CONTROLLER_ROLE,
      }),
      role: self.info.role,
      systemPrompt: self.info.systemPrompt,
      workspace: self.workspaceInfo(),
      summary,
      addon,
    };
  }
export function initialMessage(self: any, content: string, summary?: string): string {
    return buildInitialMessage({ ...self.promptContext(summary), content });
  }
export function ensureRunnerAvailable(self: any, runner: CliRunner): boolean {
    const status = self.opts.cliCommands[runner];
    if (status.available) return true;
    self.opts.onError(`[cli] ${runner} not found. Set the path manually or install the binary.`);
    return false;
  }
