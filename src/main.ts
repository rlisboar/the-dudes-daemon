import { initSentry, capture, captureWarn, breadcrumb, setTag, flush as flushSentry } from "./sentry.js";
initSentry(); // gated em SENTRY_DSN_DAEMON / SENTRY_DSN; no-op sem env

import os from "node:os";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { parseWireMessage } from "@the-dudes/protocol";
import { AgentHost } from "./agent-host.js";
import { assertWorkspaceScoped, autoWorkspaceCwd, describeGitRoots, ensureWritableDir, expandBasePath, isInsideRoot, validateBasePath, validateGitHash, validateGitRef } from "./workspace.js";
import { buildGraph, graphPath } from "./graph-indexer.js";
import { detectDropTarget, spawnDropped, type DropTarget } from "./privileges.js";
import { BridgeRelay } from "./bridge-relay.js";
import { defaultDaemonConfigPath, formatCliStatus, loadDaemonCliConfig, mergeCliConfig, resolveCliCommands, type DaemonCliConfig, type ResolvedCliCommands } from "./cli-config.js";
import type { FromDaemon, FromOrch } from "./protocol.js";
import { runSummarizer } from "./summarizer-runner.js";
import { decryptForProject, encryptForProject, forgetAllProjectKeys, getDaemonPublicKey, hasProjectKey, isE2eEncrypted, rememberProjectKey } from "./daemon-crypto.js";
import { dispatchWebhook } from "./webhook-dispatch.js";
import { ModelDiscovery } from "./model-discovery.js";

const VERSION = "0.1.0";

interface Args {
  orch: string;
  token: string;
  name: string;
  pingMs: number;
  verbose: boolean;
  verboseHuman: boolean;
  verboseHumanIo: boolean;
  cliConfigPath: string;
  cliPaths: DaemonCliConfig["cliPaths"];
}

function parseCli(): Args {
  const argv = process.argv.slice(2);
  const verboseHumanIo = argv.includes("-vh") || argv.includes("-vhio") || argv.includes("--verbose-human-io");
  const verboseHuman = argv.includes("--verbose-human");
  const filtered = argv.filter((arg) =>
    arg !== "-vh" &&
    arg !== "-vhio" &&
    arg !== "--verbose-human" &&
    arg !== "--verbose-human-io"
  );
  const { values } = parseArgs({
    args: filtered,
    options: {
      orch: { type: "string" },
      token: { type: "string" },
      name: { type: "string" },
      "ping-ms": { type: "string" },
      "cli-config": { type: "string" },
      "claude-path": { type: "string" },
      "opencode-path": { type: "string" },
      "gemini-path": { type: "string" },
      "codex-path": { type: "string" },
      "crush-path": { type: "string" },
      "grok-path": { type: "string" },
      verbose: { type: "boolean", short: "v" },
      "verbose-human": { type: "boolean" },
      "verbose-human-io": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) { printHelp(); process.exit(0); }
  const orch = values.orch ?? process.env.THE_DUDES_ORCH
  const token = values.token ?? process.env.THE_DUDES_DAEMON_TOKEN;
  const name = values.name ?? process.env.THE_DUDES_DAEMON_NAME ?? `${os.hostname()}-${process.pid}`;
  const pingMs = Number(values["ping-ms"] ?? 30_000);
  const verbose = !!values.verbose || verboseHuman || verboseHumanIo;
  const verboseHumanIoFlag = !!values["verbose-human-io"] || verboseHumanIo;
  const cliConfigPath = values["cli-config"] ?? process.env.THE_DUDES_DAEMON_CONFIG ?? defaultDaemonConfigPath();
  const cliPaths = {
    claude: values["claude-path"] ?? process.env.THE_DUDES_CLAUDE_PATH,
    opencode: values["opencode-path"] ?? process.env.THE_DUDES_OPENCODE_PATH,
    gemini: values["gemini-path"] ?? process.env.THE_DUDES_GEMINI_PATH,
    codex: values["codex-path"] ?? process.env.THE_DUDES_CODEX_PATH,
    crush: values["crush-path"] ?? process.env.THE_DUDES_CRUSH_PATH,
    grok: values["grok-path"] ?? process.env.THE_DUDES_GROK_PATH,
  };
  if (!orch) { console.error("error: --orch required (or THE_DUDES_ORCHenv)"); printHelp(); process.exit(1); }
  if (!token) { console.error("error: --token required (or THE_DUDES_DAEMON_TOKEN env)"); printHelp(); process.exit(1); }
  return { orch, token, name, pingMs, verbose, verboseHuman, verboseHumanIo: verboseHumanIoFlag, cliConfigPath, cliPaths };
}

function printHelp() {
  console.log(`the-dudes-daemon v${VERSION}

Connect a local agent runner to a remote the-dudes orchestrator.

Usage:
  the-dudes-daemon --orch <url> --token <token> [--name <label>]

Options:
  --orch     Orchestrator base URL, e.g. http://192.168.1.50:8787
             (or THE_DUDES_ORCHenv)
  --token    Daemon bearer token (mint one in the web UI under Settings)
             (or THE_DUDES_DAEMON_TOKEN env)
  --name     Daemon label shown in the UI (default: hostname-pid)
  --ping-ms  Heartbeat interval in ms (default 30000)
  -v, --verbose
             Log raw daemon and CLI debug output
  -vh, --verbose-human-io
             Human-friendly CLI input/output only
  --verbose-human
             Human-friendly verbose CLI debug output
  -vhio
             Alias for -vh
  --cli-config  Local JSON file with cliPaths overrides (default: ~/.the-dudes/daemon-config.json)
  --claude-path / --opencode-path / --gemini-path / --codex-path / --crush-path / --grok-path
             Manual executable overrides for each CLI
  -h, --help Show this help`);
}

class DaemonClient {
  private args: Args;
  private readonly installedRunnerAvailability: Record<string, boolean>;
  private ws: WebSocket | null = null;
  private reconnectDelay = 1_000;
  private static readonly RECONNECT_CAP_MS = 60_000;
  // Tracker de disconnects transient (1006/1005/1011) — sliding window
  // 5min. Acima do threshold, log warn explícito uma vez orientando user
  // sobre rede ruim em vez de spam de mensagens individuais.
  private transientDisconnects: number[] = [];
  private rateWarnedAt = 0;
  private static readonly TRANSIENT_WINDOW_MS = 5 * 60_000;
  private static readonly TRANSIENT_WARN_THRESHOLD = 10;
  // State recovery: server injeta `seq` em cada msg outbound; daemon
  // tracka maior seq visto + envia no próximo hello pra resume. Server
  // replay buffer das que ficaram pendentes em transient disconnect
  // (1006 mobile/CGNAT). Persiste entre reconnects do mesmo processo.
  private lastSeenSeq = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  /** Heartbeat WS-level (frame PING nativo). Detecta TCP zumbi
   *  em ~60s — sem isso, sleep/wake do laptop deixa socket fantasma. */
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPongAt = 0;
  // 4G/CGNAT: NAT mapping expira em 60s tipicamente. PING WS a cada 15s
  // mantém NAT entry "ativa" + detecta morte cedo. TIMEOUT 90s = 6 ciclos
  // de chance antes do terminate; tolera jitter mobile sem matar conn
  // legítima. Trade-off: ~4 PING/min em rede ruim — overhead aceitável.
  private static readonly HEARTBEAT_INTERVAL_MS = 15_000;
  private static readonly HEARTBEAT_TIMEOUT_MS = 90_000;
  private stopped = false;
  private host: AgentHost;
  private orchUrl: string;
  private dropTo: DropTarget | null;
  private relay: BridgeRelay | null = null;
  private cliCommands: ResolvedCliCommands;
  private modelDiscovery: ModelDiscovery;
  // Workspace é per-request (cada msg do server traz workspaceRoot do
  // projeto ATIVO). Sem state global pra evitar last-write-wins.
  /** Spawns adiados esperando project key E2EE (race: spawn chega antes do wrap). */
  private pendingSpawns = new Map<string, FromOrch[]>(); // projectId → agent:spawn msgs
  /** agentIds que já esperaram SPAWN_KEY_WAIT_MS — evita loop infinito de adiar. */
  private spawnKeyWaited = new Set<string>();
  private static readonly SPAWN_KEY_WAIT_MS = 8_000;

  constructor(args: Args, cliCommands: ResolvedCliCommands) {
    this.args = args;
    this.orchUrl = args.orch.replace(/\/$/, "");
    this.dropTo = detectDropTarget();
    this.cliCommands = cliCommands;
    this.installedRunnerAvailability = Object.fromEntries(
      (["claude", "codex", "opencode", "gemini", "crush", "grok"] as const)
        .map((runner) => [runner, cliCommands[runner].available]),
    );
    this.modelDiscovery = new ModelDiscovery(cliCommands, this.dropTo);
    if (this.dropTo) {
      log("info", `running as root via sudo — child processes will drop to uid=${this.dropTo.uid} (${this.dropTo.user}) home=${this.dropTo.home}`);
    }
    setTag("daemon_name", this.args.name);
    setTag("hostname", os.hostname());
    this.host = new AgentHost((msg) => this.send(msg), this.dropTo, null, this.cliCommands, this.args.verbose, this.args.verboseHuman, this.args.verboseHumanIo, log, cliLog);
  }

  async start() {
    process.on("SIGINT", () => this.shutdown());
    process.on("SIGTERM", () => this.shutdown());
    // Sweep de tmpdirs órfãos de agentes (token plaintext em /tmp) — cobre
    // crash anterior onde o cleanup do emitExit não rodou. No boot ainda não
    // há runner ativo deste daemon, então limpar tudo em /tmp/the-dudes é
    // seguro (dirs novos "ag-*" + legados por agentId). Ver SECURITY-TODO S-05.
    try {
      const parent = path.join(os.tmpdir(), "the-dudes");
      for (const name of fs.readdirSync(parent)) {
        try { fs.rmSync(path.join(parent, name), { recursive: true, force: true }); } catch { /* skip */ }
      }
    } catch { /* dir não existe ainda — ok */ }
    // Start the local Unix-socket relay so MCP bridges spawned by agents
    // (which run as the dropped user) can reach the orchestrator without
    // hitting an outbound firewall app.
    this.relay = new BridgeRelay(this.orchUrl, this.dropTo, (agentId) => this.host.getAgentProjectId(agentId));
    try {
      await this.relay.start();
      log("info", `bridge relay listening on ${this.relay.socketPath}`);
      this.host = new AgentHost((msg) => this.send(msg), this.dropTo, this.relay.socketPath, this.cliCommands, this.args.verbose, this.args.verboseHuman, this.args.verboseHumanIo, log, cliLog);
    } catch (e) {
      log("warn", `bridge relay failed to start (${(e as Error).message}) — agents will fetch orch directly`);
    }
    (["claude", "opencode", "gemini", "codex", "crush", "grok"] as const).forEach((runner) => {
      const status = this.cliCommands[runner];
      log(status.available ? "info" : "warn", formatCliStatus(runner, status));
    });
    this.connect();
  }

  private connect() {
    if (this.stopped) return;
    const url = wsUrlFromOrch(this.args.orch);
    log("info", `connecting to ${url}…`);
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.args.token}` },
      // Force IPv4 to avoid EHOSTUNREACH on dual-stack hosts where the
      // resolver hands the underlying http(s) agent an unreachable v6 path.
      family: 4,
      maxPayload: 32 * 1024 * 1024,
      handshakeTimeout: 15_000,
      // perMessageDeflate=false: 4G/lossy networks corrompem stream do
      // deflate (pacote perdido invalida sliding window do compress).
      // Trade-off: payloads maiores na rede; em compensação sem state
      // corruption que força reconnect.
      perMessageDeflate: false,
    } as any);
    this.ws = ws;
    // TCP keepalive 15s — 4G CGNAT mata mapping em ~60s sem traffic.
    // Probes ativos 4x antes do NAT expirar. setNoDelay desativa Nagle
    // pra latência menor em PING frames pequenos.
    const enableTcpKeepalive = () => {
      try {
        const sock = (ws as any)._socket;
        if (sock && typeof sock.setKeepAlive === "function") {
          sock.setKeepAlive(true, 15_000);
          sock.setNoDelay(true);
        }
      } catch { /* best-effort */ }
    };
    ws.once("upgrade", enableTcpKeepalive);

    // Heartbeat WS-level — pong reseta lastPongAt; setInterval verifica
    // se servidor está respondendo. Sem isso, TCP zumbi (sleep/wake, wifi
    // troca) deixa daemon achando que está online por minutos/horas.
    ws.on("pong", () => {
      this.lastPongAt = Date.now();
    });

    ws.on("open", () => {
      this.reconnectDelay = 1_000;
      this.lastPongAt = Date.now();
      log("info", "connected · sending hello");
      breadcrumb("ws", "open", { url });
      let cryptoPublicKey: string | undefined;
      try {
        cryptoPublicKey = getDaemonPublicKey();
      } catch (e) {
        log("warn", `crypto keypair unavailable: ${(e as Error).message}`);
        capture(e, { phase: "getDaemonPublicKey" });
      }
      this.send({
        type: "daemon:hello",
        name: this.args.name,
        os: process.platform,
        hostname: os.hostname(),
        version: VERSION,
        cryptoPublicKey,
        // Resume: server reenvia msgs com seq > lastSeenSeq do buffer
        // persistente per-tokenId. 0/ausente = primeira conn / buffer
        // expirou (server faz nothing, comportamento legado).
        resumeFromSeq: this.lastSeenSeq,
        availableRunners: (["claude", "codex", "opencode", "gemini", "crush", "grok"] as const)
          .filter((runner) => this.cliCommands[runner].available),
      });
      // Ressincroniza tokens de agents já rodando localmente — sem isso,
      // após restart do server, o Map agentTokens fica vazio e o
      // mcp-bridge (que mantém o token antigo em env) começa a receber
      // 401 em /api/bridge. Agents sem auto_resume_at flag não passam
      // pelo path de auto-resume, então este push proativo cobre-os.
      for (const { id, token } of this.host.listAgentTokens()) {
        this.send({ type: "agent:token_resync", agentId: id, token });
      }
      this.startPing();
      this.startHeartbeat();
    });

    ws.on("message", (raw: Buffer) => {
      let msg: FromOrch;
      try { msg = parseWireMessage<FromOrch>(raw.toString()); } catch { return; }
      // Tracka maior seq visto pra resume no próximo reconnect. Server
      // injeta seq em cada msg via sendDaemon. Replay duplica msgs com
      // seq <= lastSeen — handle natural cobre (correlationId match
      // descarta duplicados nos handlers de file:/git: result).
      const seq = Number((msg as any).seq);
      if (Number.isFinite(seq) && seq > this.lastSeenSeq) {
        this.lastSeenSeq = seq;
      }
      this.handle(msg);
    });

    ws.on("close", (code, reason) => {
      this.stopPing();
      this.stopHeartbeat();
      this.ws = null;
      if (this.stopped) return;
      const reasonStr = reason?.toString() || "(no reason)";
      const isTransient = code === 1006 || code === 1005 || code === 1011;
      const baseDelay = isTransient ? 200 : this.reconnectDelay;
      const jittered = Math.floor(baseDelay * (0.75 + Math.random() * 0.5));
      // Transient (1006/1005/1011) é esperado em mobile/CGNAT — não
      // poluir log com mensagem individual. Tracker abaixo agrega.
      if (!isTransient) {
        log("warn", `disconnected (code ${code}, reason: ${reasonStr}) — reconnecting in ${jittered}ms`);
      }
      breadcrumb("ws", "close", { code, reason: reasonStr, nextDelayMs: jittered });
      if (isTransient) {
        const now = Date.now();
        this.transientDisconnects.push(now);
        this.transientDisconnects = this.transientDisconnects.filter(
          (t) => now - t < DaemonClient.TRANSIENT_WINDOW_MS,
        );
        // Threshold: > N transient em janela → log warn UMA VEZ por hora.
        // Útil pra user perceber que rede tá ruim sem ler todas as linhas.
        if (
          this.transientDisconnects.length >= DaemonClient.TRANSIENT_WARN_THRESHOLD &&
          now - this.rateWarnedAt > 60 * 60_000
        ) {
          this.rateWarnedAt = now;
          log(
            "warn",
            `rede instável: ${this.transientDisconnects.length} reconnects transient em ${Math.round(DaemonClient.TRANSIENT_WINDOW_MS / 60_000)}min ` +
            `(code 1006/1005/1011 = mobile carrier/NAT/wifi handoff). Reconnect automático funciona; verificar rede se persistir.`,
          );
        }
      }
      // 1000=normal, 1001=going-away (server restart), 1006/1005/1011
      // = transient mobile (NÃO captura pra evitar spam Sentry).
      if (code !== 1000 && code !== 1001 && !isTransient) {
        captureWarn(`ws disconnected code=${code}`, { code, reason: reasonStr });
      }
      setTimeout(() => {
        // Backoff só pra non-transient. Transient sempre tenta rápido.
        if (!isTransient) {
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, DaemonClient.RECONNECT_CAP_MS);
        } else {
          this.reconnectDelay = 1_000; // reset pra próximo non-transient
        }
        this.connect();
      }, jittered);
    });

    ws.on("error", (err) => {
      log("error", `ws error: ${(err as Error).message}`);
      capture(err, { phase: "ws:error" });
    });

    ws.on("unexpected-response", (_req, res) => {
      log("error", `handshake failed: HTTP ${res.statusCode}`);
      captureWarn(`ws handshake HTTP ${res.statusCode}`, { status: res.statusCode });
      if (res.statusCode === 401) {
        log("error", "invalid token — check the token minted in the web UI");
        this.reconnectDelay = 30_000;
      }
    });
  }

  private async handle(msg: FromOrch) {
    // Wrap em try/finally pra setar override de workspace per-request
    // (multi-projeto seguro). Aplica a todos cmds git que carregam
    // workspaceRoot opcional. file:list/file:read recebem o override
    // direto via parâmetro do handler — não dependem disto.
    const m = msg as { type: string; workspaceRoot?: string };
    const wsOverride = typeof m.workspaceRoot === "string" && m.workspaceRoot ? m.workspaceRoot : null;
    if (wsOverride && m.type.startsWith("git:")) {
      // Defense-in-depth: o workspaceRoot vem do server (semi-confiável). Só
      // aceita se estiver dentro do THE_DUDES_WORKSPACE_ROOT (ou $HOME) — senão
      // git rodaria em qualquer dir que o server mandasse (MED-8).
      try {
        this.enforceWorkspaceScope(expandBasePath(wsOverride));
        this.activeWsOverride = wsOverride;
      } catch (e) {
        log("warn", `git workspaceRoot fora do root permitido — ignorado: ${(e as Error).message}`);
        this.activeWsOverride = null;
      }
    }
    try {
      await this.handleInner(msg);
    } finally {
      this.activeWsOverride = null;
    }
  }

  private async handleInner(msg: FromOrch) {
    switch (msg.type) {
      case "daemon:welcome":
        log("info", `authed as ${msg.user.name} <${msg.user.email}>`);
        return;
      case "daemon:pong":
        return;
      case "runner-policy:set": {
        const allowed = new Set(msg.allowedRunners);
        for (const runner of ["claude", "codex", "opencode", "gemini", "crush", "grok"] as const) {
          this.cliCommands[runner].available = this.installedRunnerAvailability[runner] === true && allowed.has(runner);
        }
        log("info", `runner policy synced: ${[...allowed].join(", ") || "none"}`);
        return;
      }
      case "daemon:challenge": {
        // H-18 PoP: server pediu prova de posse da privkey RSA. Sem
        // responder, server marca daemon como unverified e admin web
        // não consegue wrap project keys pra ele. Resposta usa
        // RSA-PKCS1-v1_5 signature SHA-256 sobre o nonce.
        try {
          const { signChallenge } = await import("./daemon-crypto.js");
          const signature = signChallenge(msg.nonce);
          this.send({ type: "daemon:challenge_response", signature });
        } catch (e) {
          log("warn", `daemon:challenge failed to sign: ${(e as Error).message}`);
        }
        return;
      }
      case "agent:spawn": {
        let resolvedCwd: string;
        if (msg.agentRepo && msg.cwdOverride) {
          resolvedCwd = `${msg.cwdOverride}/${msg.agentRepo.name} (agent repo)`;
        } else if (msg.cwdOverride) {
          resolvedCwd = `${msg.cwdOverride} (override)`;
        } else if (msg.repoName) {
          resolvedCwd = `${msg.basePath}/${msg.repoName}`;
        } else {
          resolvedCwd = msg.basePath;
        }
        // E2EE: decrypt agent.systemPrompt before passing to the host so
        // the CLI receives plaintext. Legacy plain pass-through.
        const spec: import("./protocol.js").AgentSpawn = { ...msg, orchUrl: this.orchUrl };
        if (msg.projectId && isE2eEncrypted(spec.agent.systemPrompt)) {
          // Server pode ter appendado skills DEPOIS do blob e2e: (plaintext tail).
          // Separa antes do decrypt — o base64 decoder ignora o tail, e sem
          // isso as skills somem no path de sucesso.
          const rawSpFull = spec.agent.systemPrompt;
          const skillsMark = "\n\n---\n\n## Available skills";
          const skillsIdxFull = typeof rawSpFull === "string" ? rawSpFull.indexOf(skillsMark) : -1;
          const e2eOnly = skillsIdxFull >= 0 ? rawSpFull.slice(0, skillsIdxFull) : rawSpFull;
          const skillsTailFromServer = skillsIdxFull >= 0 ? rawSpFull.slice(skillsIdxFull) : "";
          const dec = decryptForProject(e2eOnly, msg.projectId);
          if (dec !== null) {
            this.spawnKeyWaited.delete(spec.agent.id);
            spec.agent = { ...spec.agent, systemPrompt: dec + skillsTailFromServer };
          } else if (!hasProjectKey(msg.projectId) && !this.spawnKeyWaited.has(spec.agent.id)) {
            // Race: agent:spawn chega ANTES de project_key:for_daemon.
            const pid = msg.projectId;
            const list = this.pendingSpawns.get(pid) ?? [];
            if (!list.some((m) => (m as { agent?: { id?: string } }).agent?.id === spec.agent.id)) {
              list.push(msg);
              this.pendingSpawns.set(pid, list);
            }
            this.spawnKeyWaited.add(spec.agent.id);
            log("info", `agent ${spec.agent.id} aguardando project key E2EE de ${pid} (spawn adiado ${DaemonClient.SPAWN_KEY_WAIT_MS}ms)`);
            setTimeout(() => {
              const still = this.pendingSpawns.get(pid);
              if (!still?.length) return;
              const left = still.filter((m) => (m as { agent?: { id?: string } }).agent?.id !== spec.agent.id);
              if (left.length) this.pendingSpawns.set(pid, left);
              else this.pendingSpawns.delete(pid);
              void this.handleInner(msg);
            }, DaemonClient.SPAWN_KEY_WAIT_MS);
            return;
          } else {
            // Sem key após espera, OU key presente mas ciphertext de outra rotação.
            // NÃO passa e2e: pro CLI (hang). Fallback role-only — agente sobe.
            // CRÍTICO: limpa sessionId. Sessões antigas podem ter sido
            // envenenadas com o blob e2e: literal no histórico (bug pré-fix),
            // e --resume re-trava o runner (0% CPU por horas). Cold start
            // com role-only é recuperável; resume da sessão podre não.
            this.spawnKeyWaited.delete(spec.agent.id);
            const why = hasProjectKey(msg.projectId)
              ? "ciphertext não bate com a key atual (rotação?)"
              : "project key não chegou ao daemon a tempo";
            // Cipher não decripta; tail de skills (se o server appendou) sobrevive.
            log("error", `agent ${spec.agent.id}: systemPrompt E2EE falhou (${why}) — spawn com role-only + sem resume${skillsTailFromServer ? " + skills plaintext" : ""}; re-salve o system prompt no browser`);
            this.send({
              type: "agent:error",
              agentId: spec.agent.id,
              message: `systemPrompt E2EE não decripta (${why}). Agente sobe com role-only (sessão limpa) — abra o projeto no browser e re-salve o system prompt do agente.`,
            });
            // Notifica orch pra zerar session_id no DB (evita re-resume no próximo auto-spawn).
            this.send({ type: "agent:session", agentId: spec.agent.id, sessionId: "" });
            spec.agent = {
              ...spec.agent,
              sessionId: undefined,
              systemPrompt:
                `[E2EE] system prompt could not be decrypted (${why}). ` +
                `Re-save this agent's system prompt in the UI to re-encrypt with the current project key.\n\n` +
                `# Role\n${spec.agent.role || "agent"}` +
                skillsTailFromServer,
            };
          }
        }
        // Global project memory — decrypt each cipher entry and append a
        // "## Project Memory" block to the (already decrypted) system
        // prompt. Server can't pre-concatenate (the prompt is cipher at
        // rest), so each title/body arrives as a separate cipher blob and
        // we assemble here. Re-built on every spawn, so durable knowledge
        // survives model/runner switches and context compaction.
        if (msg.projectId && msg.memory && msg.memory.length > 0) {
          // Budget token-aware: server manda candidatos ordenados (pinned >
          // recente); aqui cortamos por tamanho decriptado (~2k tokens ≈
          // 8000 chars) pra a memória não dominar o contexto. Server é cego
          // a tokens (cipher), então o corte real é aqui.
          const MEMORY_CHAR_BUDGET = 8000;
          const entries: string[] = [];
          let used = 0;
          let dropped = 0;
          for (const m of msg.memory) {
            const title = isE2eEncrypted(m.titleCipher) ? decryptForProject(m.titleCipher, msg.projectId) : m.titleCipher;
            const body = isE2eEncrypted(m.bodyCipher) ? decryptForProject(m.bodyCipher, msg.projectId) : m.bodyCipher;
            if (title === null || body === null) continue; // sem chave — pula
            const block = `### [${m.type}] ${title}\n${body}`;
            if (used + block.length > MEMORY_CHAR_BUDGET && entries.length > 0) { dropped++; continue; }
            entries.push(block);
            used += block.length;
          }
          if (dropped > 0) {
            log("info", `memory budget: ${entries.length} injected, ${dropped} dropped (over ${MEMORY_CHAR_BUDGET} chars) for ${spec.agent.id}`);
            // Overflow visível: avisa o agente que a memória foi truncada pra ele
            // usar `recall` em vez de assumir que o injetado é tudo.
            entries.push(`### [system] memória truncada\n${dropped} memória(s) mais antiga(s) omitida(s) por limite de contexto. Use a tool \`recall\` pra buscar conhecimento que não esteja aqui.`);
          }
          if (entries.length > 0) {
            const block = `## Project Memory\n\nNotas duráveis **deste agente** (não são copiadas para os outros). Catálogo do projeto: use a tool \`recall\`. Verifique antes de confiar em detalhes específicos.\n\n${entries.join("\n\n")}`;
            spec.agent = { ...spec.agent, systemPrompt: `${spec.agent.systemPrompt}\n\n---\n\n${block}` };
            log("info", `injected ${entries.length} memory entries into ${spec.agent.id} system prompt`);
          }
        }
        log("info", `spawn ${spec.agent.name} (${spec.agent.id}) cfg=${resolvedCwd} runner=${spec.agent.cliRunner ?? "claude"}`);
        this.host.spawn(spec).catch((e) => {
          log("error", `spawn failed: ${(e as Error).message}`);
        });
        return;
      }
      case "agent:stop":
        log("info", `stop ${msg.agentId}`);
        this.host.stop(msg.agentId);
        return;
      case "agent:send": {
        let content: string;
        const dropMissingKey = () => {
          log("warn", `agent:send to ${msg.agentId} encrypted but project key not held — dropping`);
          this.send({
            type: "agent:error",
            agentId: msg.agentId,
            message: "daemon sem chave do projeto — recarregue a página ou reinicie o daemon",
          });
        };
        if (msg.parts && msg.parts.length > 0) {
          const out: string[] = [];
          for (const p of msg.parts) {
            if (p.kind === "plain") { out.push(p.text); continue; }
            if (!isE2eEncrypted(p.text)) { out.push(p.text); continue; }
            if (!msg.projectId) { dropMissingKey(); return; }
            const dec = decryptForProject(p.text, msg.projectId);
            if (dec === null) { dropMissingKey(); return; }
            out.push(dec);
          }
          content = out.join("");
        } else {
          content = msg.content;
          if (msg.projectId && isE2eEncrypted(content)) {
            const dec = decryptForProject(content, msg.projectId);
            if (dec !== null) content = dec;
            else { dropMissingKey(); return; }
          }
          if (msg.systemPrefix) content = msg.systemPrefix + content;
          if (msg.systemSuffix) content = content + msg.systemSuffix;
        }
        if (msg.telegram !== undefined) this.host.setTelegramMirror(msg.agentId, msg.telegram);
        this.host.send_message(msg.agentId, content, msg.images);
        return;
      }
      case "agent:clear":
        this.host.clear(msg.agentId).catch(() => {});
        return;
      case "agent:compact":
        this.host.compact(msg.agentId, msg.saveMemory !== false).catch(() => {});
        return;
      case "auto_approve:set":
        this.host.setAutoApprove(msg.value);
        return;
      case "workspace:set":
        await this.applyWorkspace(msg.projectId, msg.basePath, msg.repos);
        return;
      case "file:list":
        await this.handleFileList(msg.correlationId, msg.path, msg.workspaceRoot);
        return;
      case "file:read":
        await this.handleFileRead(msg.correlationId, msg.path, msg.workspaceRoot);
        return;
      case "file:write":
        await this.handleFileWrite(msg.correlationId, msg.path, msg.content, msg.workspaceRoot);
        return;
      case "summarize:request":
        await this.handleSummarize(msg);
        return;
      case "project_key:for_daemon": {
        const ok = rememberProjectKey(msg.projectId, msg.wrappedProjectKey);
        if (!ok) {
          log("warn", `E2EE project key wrap rejeitado para ${msg.projectId} (RSA unwrap falhou)`);
          return;
        }
        log("info", `received E2EE project key for ${msg.projectId}`);
        // Flush spawns que esperavam a key.
        const pending = this.pendingSpawns.get(msg.projectId);
        if (pending?.length) {
          this.pendingSpawns.delete(msg.projectId);
          log("info", `retomando ${pending.length} spawn(s) adiado(s) de ${msg.projectId}`);
          for (const m of pending) void this.handleInner(m);
        }
        return;
      }
      case "webhook:dispatch": {
        await this.handleWebhookDispatch(msg);
        return;
      }
      case "gitlab:request": {
        await this.handleGitlabRequest(msg);
        return;
      }
      case "skills:rescan": {
        await this.reportSkillsScan(msg.workspaceSkillsRoot).catch((e) =>
          log("warn", `manual rescan failed: ${(e as Error).message}`)
        );
        return;
      }
      case "skill:read_file": {
        await this.handleSkillReadFile(msg);
        return;
      }
      case "skill:save_file": {
        await this.handleSkillSaveFile(msg);
        return;
      }
      case "skill:delete": {
        await this.handleSkillDelete(msg);
        return;
      }
      case "mcps:rescan": {
        await this.reportMCPsScan(msg.workspaceRoot).catch((e) =>
          log("warn", `mcps rescan failed: ${(e as Error).message}`)
        );
        return;
      }
      case "models:discover": {
        const catalogs = await this.modelDiscovery.discoverMany(msg.runner, msg.force === true);
        this.send({ type: "models:catalog", correlationId: msg.correlationId, catalogs });
        return;
      }
      case "debug:sentry-test" as any: {
        const ts = (msg as any).ts ?? Date.now();
        log("info", `[debug:sentry] capturing test event ts=${ts}`);
        try {
          throw new Error(`sentry daemon test ${new Date(ts).toISOString()}`);
        } catch (e) {
          capture(e, { source: "debug:sentry-test", ts });
        }
        captureWarn("daemon sentry test", { ts });
        await flushSentry(3000);
        return;
      }
      case "mcps:save": {
        await this.handleMCPSave(msg);
        return;
      }
      case "mcps:delete": {
        await this.handleMCPDelete(msg);
        return;
      }
      case "git:log":
        await this.handleGitLog(msg.correlationId, msg.count);
        return;
      case "git:status":
        await this.handleGitStatus(msg.correlationId);
        return;
      case "git:diff":
        await this.handleGitDiff(msg.correlationId, msg.path);
        return;
      case "git:stage":
        await this.handleGitOp(msg.correlationId, "stage", ["add", "--", msg.path]);
        return;
      case "git:unstage":
        await this.handleGitOp(msg.correlationId, "unstage", ["reset", "HEAD", "--", msg.path]);
        return;
      case "git:commit": {
        const paths = msg.paths ?? [];
        // paths user-controlled vão direto pra git commit como pathspec.
        // Sem `--` separador, path "-help" vira flag. Inserimos `--`
        // explicit antes da lista.
        await this.handleGitOp(msg.correlationId, "commit", ["commit", "-m", msg.message, "--", ...paths]);
        return;
      }
      case "git:push":
        await this.handleGitOp(msg.correlationId, "push", ["push"]);
        return;
      case "git:pull":
        await this.handleGitOp(msg.correlationId, "pull", ["pull"]);
        return;
      case "git:branches":
        await this.handleGitBranches(msg.correlationId);
        return;
      case "git:switch_branch":
        try { validateGitRef(msg.branch, "branch"); }
        catch (e) { this.send({ type: "git:result", correlationId: msg.correlationId, op: "switch_branch", ok: false, error: (e as Error).message }); return; }
        await this.handleGitOp(msg.correlationId, "switch_branch", ["checkout", msg.branch]);
        return;
      case "git:create_branch":
        try { validateGitRef(msg.branch, "branch"); }
        catch (e) { this.send({ type: "git:result", correlationId: msg.correlationId, op: "create_branch", ok: false, error: (e as Error).message }); return; }
        await this.handleGitOp(msg.correlationId, "create_branch", ["checkout", "-b", msg.branch]);
        return;
      case "git:show":
        try { validateGitHash(msg.hash); }
        catch (e) { this.send({ type: "git:result", correlationId: msg.correlationId, op: "show", ok: false, error: (e as Error).message }); return; }
        await this.handleGitOp(msg.correlationId, "show", ["show", msg.hash]);
        return;
      case "git:file_log":
        await this.handleGitFileLog(msg.correlationId, msg.path, msg.count);
        return;
      case "git:graph":
        await this.handleGitOp(msg.correlationId, "graph", ["log", "--graph", "--oneline", "--all", "-20"]);
        return;
      case "graph:build":
        await this.handleGraphBuild(msg);
        return;
      case "graph:fetch":
        await this.handleGraphFetch(msg);
        return;
      case "git:blame":
        await this.handleGitOp(msg.correlationId, "blame", ["blame", "--", msg.path]);
        return;
      case "git:stash_list":
        await this.handleGitStashList(msg.correlationId);
        return;
      case "git:stash":
        await this.handleGitOp(msg.correlationId, "stash", msg.message ? ["stash", "push", "-m", msg.message] : ["stash"]);
        return;
      case "git:stash_pop":
        await this.handleGitOp(msg.correlationId, "stash_pop", ["stash", "pop"]);
        return;
    }
  }


  /** Resolve um path relativo dentro de `<root>/<name>/` com guard contra
   *  traversal. `root` é `<projectBase>/skills` quando vem do server. */
  private resolveSkillFile(rootPath: string | undefined, skillName: string, relPath: string): string {
    const skillsRoot = rootPath ?? null;
    if (!skillsRoot) throw new Error("workspaceSkillsRoot ausente na msg");
    this.enforceWorkspaceScope(expandBasePath(skillsRoot)); // server-supplied root no root permitido (MED-6)
    if (!skillName || skillName.includes("/") || skillName.includes("..") || skillName.startsWith(".")) {
      throw new Error("skillName inválido");
    }
    const safeRel = path.posix.normalize(relPath || "SKILL.md");
    if (safeRel.startsWith("../") || safeRel.includes("/../") || path.isAbsolute(safeRel) || safeRel === "..") {
      throw new Error("relPath inválido");
    }
    const root = path.resolve(skillsRoot, skillName);
    const target = path.resolve(root, safeRel);
    if (!target.startsWith(root + path.sep) && target !== root) {
      throw new Error("path fora da pasta da skill");
    }
    return target;
  }

  private async handleSkillReadFile(msg: Extract<FromOrch, { type: "skill:read_file" }>) {
    try {
      const file = this.resolveSkillFile(msg.workspaceSkillsRoot, msg.skillName, msg.relPath ?? "SKILL.md");
      const content = await fs.promises.readFile(file, "utf8");
      this.send({ type: "skill:read_file_result", correlationId: msg.correlationId, ok: true, content });
    } catch (err) {
      this.send({ type: "skill:read_file_result", correlationId: msg.correlationId, ok: false, error: (err as Error).message });
    }
  }

  private async handleSkillSaveFile(msg: Extract<FromOrch, { type: "skill:save_file" }>) {
    try {
      if (msg.content.length > 256 * 1024) throw new Error("conteúdo > 256KB");
      const file = this.resolveSkillFile(msg.workspaceSkillsRoot, msg.skillName, msg.relPath ?? "SKILL.md");
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, msg.content, { mode: 0o644 });
      this.send({ type: "skill:save_file_result", correlationId: msg.correlationId, ok: true });
      await this.reportSkillsScan(msg.workspaceSkillsRoot);
    } catch (err) {
      this.send({ type: "skill:save_file_result", correlationId: msg.correlationId, ok: false, error: (err as Error).message });
    }
  }

  private async handleSkillDelete(msg: Extract<FromOrch, { type: "skill:delete" }>) {
    try {
      const skillsRoot = msg.workspaceSkillsRoot ?? null;
      if (!skillsRoot) throw new Error("workspaceSkillsRoot ausente na msg");
      this.enforceWorkspaceScope(expandBasePath(skillsRoot)); // MED-9
      if (!msg.skillName || msg.skillName.includes("/") || msg.skillName.includes("..")) {
        throw new Error("skillName inválido");
      }
      const dir = path.resolve(skillsRoot, msg.skillName);
      const rootResolved = path.resolve(skillsRoot);
      if (!dir.startsWith(rootResolved + path.sep)) throw new Error("path fora de skills/");
      await fs.promises.rm(dir, { recursive: true, force: true });
      this.send({ type: "skill:delete_result", correlationId: msg.correlationId, ok: true });
      await this.reportSkillsScan(msg.workspaceSkillsRoot);
    } catch (err) {
      this.send({ type: "skill:delete_result", correlationId: msg.correlationId, ok: false, error: (err as Error).message });
    }
  }

  /** AgentSkills v2 — varre 6 sources (workspace, .agents, ~/.agents,
   *  ~/.openclaw/skills, bundled, extras) e envia snapshot pro orch.
   *  Aceita override de workspaceRoot pra cenários multi-projeto. */
  private async reportSkillsScan(workspaceSkillsRoot?: string) {
    const { scanSkills } = await import("./skills-scanner.js");
    // workspaceRoot do scanner é o BASE (não a pasta /skills). Strip o
    // sufixo /skills se vier do server. Sem path = nada pra escanear.
    if (!workspaceSkillsRoot) return;
    const wsRoot = workspaceSkillsRoot.replace(/\/skills$/, "");
    const result = await scanSkills({
      workspaceRoot: wsRoot,
      // Bundled vão entrar quando shippamos com o daemon. Por enquanto
      // null pra não tentar ler path inexistente.
      bundledRoot: null,
      extraSourceRoots: [],
    });
    this.send({
      type: "skills:scan",
      skills: result.skills,
      scannedSources: result.scannedSources,
      ts: Date.now(),
    });
    log("info", `skills scan: ${result.skills.length} (sources: ${result.scannedSources.length})`);
  }

  /** MCP server discovery — Phase 1 (read-only). Scans claude/codex/opencode/
   *  gemini configs + workspace + ~/.config/the-dudes overrides. */
  private async reportMCPsScan(workspaceRoot?: string) {
    const { scanMCPs } = await import("./mcps-scanner.js");
    const result = await scanMCPs({ workspaceRoot });
    this.send({
      type: "mcps:scan",
      mcps: result.mcps,
      scannedSources: result.scannedSources,
      ts: Date.now(),
    });
    log("info", `mcps scan: ${result.mcps.length} (sources: ${result.scannedSources.length})`);
  }

  /**
   * Path do override file. Escolha consciente: precedência máxima entre
   * todas as fontes — user edita aqui e o app sempre respeita.
   */
  private mcpsOverridePath(): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require("node:os") as typeof import("node:os");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    return path.join(os.homedir(), ".config", "the-dudes", "mcp-servers.json");
  }

  private async readMCPsOverride(): Promise<{ mcpServers: Record<string, any> }> {
    const fs = await import("node:fs/promises");
    const p = this.mcpsOverridePath();
    try {
      const raw = await fs.readFile(p, "utf8");
      const json = JSON.parse(raw);
      if (json && typeof json === "object" && json.mcpServers && typeof json.mcpServers === "object") {
        return { mcpServers: json.mcpServers };
      }
      return { mcpServers: {} };
    } catch (e: any) {
      if (e?.code === "ENOENT") return { mcpServers: {} };
      throw e;
    }
  }

  private async writeMCPsOverride(data: { mcpServers: Record<string, any> }): Promise<void> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const p = this.mcpsOverridePath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
  }

  private async handleMCPSave(msg: import("./protocol.js").MCPSaveRequest) {
    try {
      const name = String(msg.name ?? "").trim();
      if (!name) throw new Error("name required");
      if (!/^[A-Za-z0-9_.\-]+$/.test(name)) {
        throw new Error(`invalid name "${name}" — allowed chars: A-Z a-z 0-9 _ . -`);
      }
      const transport = msg.transport ?? "stdio";
      const entry: Record<string, unknown> = { type: transport };
      if (transport === "stdio") {
        if (!msg.command) throw new Error("command required for stdio transport");
        entry.command = msg.command;
        if (msg.args && msg.args.length > 0) entry.args = msg.args;
        if (msg.env && Object.keys(msg.env).length > 0) entry.env = msg.env;
      } else {
        if (!msg.url) throw new Error(`url required for ${transport} transport`);
        entry.url = msg.url;
        if (msg.headers && Object.keys(msg.headers).length > 0) entry.headers = msg.headers;
      }
      if (msg.description) entry.description = msg.description;

      const current = await this.readMCPsOverride();
      current.mcpServers[name] = entry;
      await this.writeMCPsOverride(current);

      this.send({ type: "mcps:save_result", correlationId: msg.correlationId, ok: true });
      log("info", `mcps save: ${name} → ${this.mcpsOverridePath()}`);
      // re-scan pra UI atualizar
      void this.reportMCPsScan(msg.workspaceRoot).catch((e) =>
        log("warn", `mcps post-save rescan failed: ${(e as Error).message}`)
      );
    } catch (e) {
      const error = (e as Error).message;
      log("warn", `mcps save failed (${msg.name}): ${error}`);
      this.send({ type: "mcps:save_result", correlationId: msg.correlationId, ok: false, error });
    }
  }

  private async handleMCPDelete(msg: import("./protocol.js").MCPDeleteRequest) {
    try {
      const name = String(msg.name ?? "").trim();
      if (!name) throw new Error("name required");
      const current = await this.readMCPsOverride();
      if (!(name in current.mcpServers)) {
        // idempotente: deletar coisa que não existe é OK
        this.send({ type: "mcps:delete_result", correlationId: msg.correlationId, ok: true });
        return;
      }
      delete current.mcpServers[name];
      await this.writeMCPsOverride(current);
      this.send({ type: "mcps:delete_result", correlationId: msg.correlationId, ok: true });
      log("info", `mcps delete: ${name}`);
      void this.reportMCPsScan(msg.workspaceRoot).catch((e) =>
        log("warn", `mcps post-delete rescan failed: ${(e as Error).message}`)
      );
    } catch (e) {
      const error = (e as Error).message;
      log("warn", `mcps delete failed (${msg.name}): ${error}`);
      this.send({ type: "mcps:delete_result", correlationId: msg.correlationId, ok: false, error });
    }
  }

  private async applyWorkspace(projectId: string, basePath: string, repos: { id: string; name: string; gitUrl: string; defaultBranch?: string }[]) {
    log("info", `workspace ${projectId} → ${basePath} (${repos.length} legacy repos ignored)`);
    try {
      const resolved = validateBasePath(basePath);
      ensureWritableDir(resolved, this.dropTo);
      this.send({
        type: "workspace:result",
        projectId,
        basePath: resolved,
        clones: [{ repoName: "(workspace)", ok: true, message: describeGitRoots(resolved) }],
      });
      // Scan AgentSkills v2 do projeto recém-aplicado. Path vai
      // explicitamente — nada de state global.
      void this.reportSkillsScan(`${resolved}/skills`).catch((err) =>
        log("warn", `skills scan failed: ${(err as Error).message}`),
      );
      void this.reportMCPsScan(resolved).catch((err) =>
        log("warn", `mcps scan failed: ${(err as Error).message}`),
      );
    } catch (e) {
      this.send({
        type: "workspace:result",
        projectId,
        basePath,
        clones: [{ repoName: "(setup)", ok: false, message: (e as Error).message }],
      });
    }
  }

  /** Proxy de API do GitLab: o server manda método+url+token e o DAEMON faz o
   *  request HTTP a partir da SUA rede. É o que torna GitLab interno/on-prem
   *  (ex.: gitlab.eonf.ltd, só resolvível/alcançável na infra do usuário)
   *  utilizável — o server público nunca alcança o host. Passa por safeFetch:
   *  git/spawn são escopados ao workspace, mas um fetch tem alcance irrestrito;
   *  sem o guard, server/admin comprometido pivotaria pra IMDS/RFC1918/loopback
   *  da rede do membro e o PRIVATE-TOKEN vazaria em redirect cross-origin. */
  private async handleGitlabRequest(msg: Extract<FromOrch, { type: "gitlab:request" }>) {
    const send = (r: Partial<Extract<FromDaemon, { type: "gitlab:request_result" }>>) =>
      this.send({ type: "gitlab:request_result", correlationId: msg.correlationId, ok: false, status: 0, ...r });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    try {
      // safeFetch: bloqueia IP privado/metadata/loopback (checkOutboundUrl),
      // pina o IP resolvido no socket (anti DNS-rebinding) e NÃO segue redirect
      // (maxRedirects 0) — senão o PRIVATE-TOKEN vazaria pro host de destino do
      // 30x (undici reenvia header custom cross-origin). Mesmo guard do
      // webhook-dispatch/skills-installer.
      const { safeFetch } = await import("./ssrf-guard.js");
      const res = await safeFetch(
        msg.url,
        {
          method: msg.method,
          headers: { "PRIVATE-TOKEN": msg.token, "Content-Type": "application/json" },
          body: msg.body,
          signal: ctrl.signal,
        },
        { maxRedirects: 0 },
      );
      // Lê o corpo por stream com teto de 2MB — não materializa res.text()
      // inteiro na RAM antes de cortar (alvo malicioso podia mandar GBs).
      const CAP = 2 * 1024 * 1024;
      let text = "";
      const body = res.body;
      if (body) {
        const reader = (body as any).getReader?.();
        if (reader) {
          const dec = new TextDecoder();
          let total = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            text += dec.decode(value, { stream: true });
            if (total >= CAP) { try { await reader.cancel(); } catch {} break; }
          }
          text += dec.decode();
          if (text.length > CAP) text = text.slice(0, CAP);
        } else {
          const raw = await res.text();
          text = raw.length > CAP ? raw.slice(0, CAP) : raw;
        }
      }
      send({ ok: res.ok, status: res.status, statusText: res.statusText, text });
    } catch (e) {
      const reason = (e as Error).name === "AbortError" ? "timeout (25s)" : (e as Error).message;
      send({ error: `${msg.method}: ${reason}` });
    } finally {
      clearTimeout(timer);
    }
  }

  private async handleWebhookDispatch(msg: Extract<FromOrch, { type: "webhook:dispatch" }>) {
    const eventType = String((msg.event as any)?.type ?? "unknown");
    // NÃO logar a URL inteira: webhooks carregam segredo no path (telegram
    // .../bot<TOKEN>/..., discord/slack incoming-webhook tokens). Loga só o host.
    const host = (() => { try { return new URL(msg.url).host; } catch { return "?"; } })();
    log("info", `webhook:dispatch ${eventType} → ${host} (${msg.format})`);
    try {
      const result = await dispatchWebhook({
        event: msg.event,
        projectId: msg.projectId,
        projectName: msg.projectName,
        agentNames: msg.agentNames,
        url: msg.url,
        secret: msg.secret,
        format: msg.format,
        headers: msg.headers,
      });
      this.send({
        type: "webhook:delivery_result",
        deliveryId: msg.deliveryId,
        eventType,
        status: result.status,
        body: result.body,
        error: result.error,
      });
    } catch (e) {
      this.send({
        type: "webhook:delivery_result",
        deliveryId: msg.deliveryId,
        eventType,
        status: null,
        body: "",
        error: (e as Error).message,
      });
    }
  }

  private async handleSummarize(msg: Extract<FromOrch, { type: "summarize:request" }>) {
    // E2EE: if `text` is encrypted with the project key, decrypt before
    // running the LLM, then re-encrypt the summary so the server only
    // ever forwards ciphertext.
    let plainText = msg.text;
    if (msg.projectId && isE2eEncrypted(plainText)) {
      const dec = decryptForProject(plainText, msg.projectId);
      if (dec === null) {
        this.send({ type: "summarize:result", correlationId: msg.correlationId, ok: false, error: "project key not held by daemon" });
        return;
      }
      plainText = dec;
    }
    log("info", `summarize:request runner=${msg.runner} model=${msg.model ?? "(default)"} effort=${msg.effort ?? "(none)"} len=${plainText?.length ?? 0} corrId=${msg.correlationId}`);
    try {
      const result = await runSummarizer({
        runner: msg.runner,
        model: msg.model,
        effort: msg.effort,
        systemPrompt: msg.systemPrompt,
        text: plainText,
        claudeConfigDir: msg.claudeConfigDir,
        cliCommands: this.cliCommands,
        dropTo: this.dropTo,
      });
      let outSummary = result.summary;
      if (result.ok && msg.projectId && outSummary) {
        const enc = encryptForProject(outSummary, msg.projectId);
        if (enc) outSummary = enc;
      }
      log(result.ok ? "info" : "warn", `summarize:result ok=${result.ok} ${result.ok ? `len=${result.summary?.length ?? 0} tokens=${result.usage?.input ?? 0}/${result.usage?.output ?? 0}` : `error=${result.error}`}`);
      this.send({
        type: "summarize:result",
        correlationId: msg.correlationId,
        ok: result.ok,
        summary: outSummary,
        error: result.error,
        usage: result.usage,
      });
    } catch (e) {
      log("error", `summarize:result throw: ${(e as Error).message}`);
      this.send({
        type: "summarize:result",
        correlationId: msg.correlationId,
        ok: false,
        error: (e as Error).message,
      });
    }
  }

  /** graph:build — reindex sob demanda do knowledge graph (graphify) pro
   *  workspace do projeto. Roda async (não trava o event loop) e reporta
   *  building→ready/error via graph:status. */
  private async handleGraphBuild(msg: Extract<FromOrch, { type: "graph:build" }>): Promise<void> {
    // NUNCA cair pro $HOME quando o server não manda workspaceRoot — senão um
    // workspaceFor() null faria `graphify update $HOME` indexar o home inteiro.
    if (!msg.workspaceRoot) {
      this.send({ type: "graph:status", projectId: msg.projectId, status: "error", error: "workspace não configurado no projeto", correlationId: msg.correlationId });
      return;
    }
    let root: string;
    try {
      const base = expandBasePath(msg.workspaceRoot);
      validateBasePath(base);            // bloqueia /, /etc, $HOME, /usr… (server semi-confiável)
      this.enforceWorkspaceScope(base);  // assertWorkspaceScoped quando THE_DUDES_WORKSPACE_ROOT setado
      root = base;
    } catch (e) {
      this.send({ type: "graph:status", projectId: msg.projectId, status: "error", error: `workspace inválido: ${(e as Error).message}`, correlationId: msg.correlationId });
      return;
    }
    const gbin = this.cliCommands.graphify;
    if (!gbin?.available) {
      this.send({ type: "graph:status", projectId: msg.projectId, status: "error", error: "graphify não instalado (pip install graphifyy mcp)", correlationId: msg.correlationId });
      return;
    }
    // modo semântico (docs/.md/.yaml via LLM). Backend claude-cli exige o
    // `claude` CLI; outros backends leem a API key do env do daemon.
    const claude = this.cliCommands.claude;
    const backend = msg.backend || "claude-cli";
    if (msg.semantic && backend === "claude-cli" && !claude?.available) {
      this.send({ type: "graph:status", projectId: msg.projectId, status: "error", error: "backend claude-cli exige o claude CLI instalado (ou escolha outro backend)", correlationId: msg.correlationId });
      return;
    }
    // Backends *-cli (opencode/codex/gemini via shim OpenAI-compat) exigem o
    // respectivo CLI instalado no daemon.
    const SHIM_CLI: Record<string, "opencode" | "codex" | "gemini"> = { "opencode-cli": "opencode", "codex-cli": "codex", "gemini-cli": "gemini" };
    const shimCli = SHIM_CLI[backend];
    if (msg.semantic && shimCli && !this.cliCommands[shimCli]?.available) {
      this.send({ type: "graph:status", projectId: msg.projectId, status: "error", error: `backend ${backend} exige o CLI ${shimCli} instalado no daemon`, correlationId: msg.correlationId });
      return;
    }
    // API key do backend não-claude: server manda o cipher do vault; daemon
    // decifra (project key) e injeta como env var do backend.
    let apiKey: string | undefined;
    if (msg.semantic && msg.apiKeyEnv && msg.apiKeyCipher && msg.projectId) {
      const dec = isE2eEncrypted(msg.apiKeyCipher) ? decryptForProject(msg.apiKeyCipher, msg.projectId) : msg.apiKeyCipher;
      if (dec) apiKey = dec;
    }
    this.send({ type: "graph:status", projectId: msg.projectId, status: "building", correlationId: msg.correlationId });
    const r = await buildGraph(root, gbin.command, msg.semantic
      ? { semantic: true, backend, model: msg.model, claudeCmd: claude?.command, apiKeyEnv: msg.apiKeyEnv, apiKey, cliCommands: this.cliCommands, dropTo: this.dropTo, log }
      : {});
    if (!r.ok) {
      this.send({ type: "graph:status", projectId: msg.projectId, status: "error", error: r.error, correlationId: msg.correlationId });
      return;
    }
    this.send({ type: "graph:status", projectId: msg.projectId, status: "ready", nodeCount: r.nodeCount, edgeCount: r.edgeCount, inputTokens: r.inputTokens, outputTokens: r.outputTokens, correlationId: msg.correlationId });
  }

  /** graph:fetch — lê o graphify-out/graph.json do workspace pra renderizar o
   *  mapa na UI. Scope-checked; cap 4MB. */
  private async handleGraphFetch(msg: Extract<FromOrch, { type: "graph:fetch" }>): Promise<void> {
    if (!msg.workspaceRoot) {
      this.send({ type: "graph:data", projectId: msg.projectId, error: "workspace não configurado no projeto", correlationId: msg.correlationId });
      return;
    }
    try {
      const root = expandBasePath(msg.workspaceRoot);
      validateBasePath(root);
      this.enforceWorkspaceScope(root);
      const gp = graphPath(root);
      const stat = await fs.promises.stat(gp).catch(() => null);
      if (!stat) {
        this.send({ type: "graph:data", projectId: msg.projectId, error: "índice ainda não gerado — reindexe", correlationId: msg.correlationId });
        return;
      }
      if (stat.size > 16 * 1024 * 1024) {
        this.send({ type: "graph:data", projectId: msg.projectId, error: "grafo muito grande (> 16MB) pra renderizar", correlationId: msg.correlationId });
        return;
      }
      const json = await fs.promises.readFile(gp, "utf-8");
      this.send({ type: "graph:data", projectId: msg.projectId, json, correlationId: msg.correlationId });
    } catch (e) {
      this.send({ type: "graph:data", projectId: msg.projectId, error: (e as Error).message, correlationId: msg.correlationId });
    }
  }

  /** Enforça o scope do workspace SÓ quando THE_DUDES_WORKSPACE_ROOT está
   *  explicitamente setado (hardening opt-in, alinhado ao controle documentado).
   *  Sem a env, mantém o comportamento atual (não quebra workspace fora do
   *  $HOME). Throw se `p` cair fora do root permitido. */
  private enforceWorkspaceScope(p: string): void {
    if (process.env.THE_DUDES_WORKSPACE_ROOT) assertWorkspaceScoped(p);
  }

  private async handleFileList(correlationId: string, targetPath: string, override?: string) {
    if (!override) {
      this.send({ type: "file:list_result", correlationId, path: targetPath, entries: [], error: "workspaceRoot ausente na msg" });
      return;
    }
    // ~ pode vir cru do DB. Expandir antes de comparar/resolver.
    const root = expandBasePath(override);
    try {
      this.enforceWorkspaceScope(root); // server-supplied root tem que estar no root permitido (MED-7)
      const resolved = path.resolve(root, targetPath);
      if (!isInsideRoot(resolved, root)) {
        this.send({ type: "file:list_result", correlationId, path: targetPath, entries: [], error: "acesso negado" });
        return;
      }
      const names = await fs.promises.readdir(resolved, { withFileTypes: true });
      names.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const entries = names.map((d) => ({
        name: d.name,
        path: path.relative(root, path.join(resolved, d.name)),
        isDirectory: d.isDirectory(),
      }));
      this.send({ type: "file:list_result", correlationId, path: targetPath, entries });
    } catch (e) {
      this.send({ type: "file:list_result", correlationId, path: targetPath, entries: [], error: (e as Error).message });
    }
  }

  private async handleFileRead(correlationId: string, targetPath: string, override?: string) {
    if (!override) {
      this.send({ type: "file:read_result", correlationId, path: targetPath, error: "workspaceRoot ausente na msg" });
      return;
    }
    const root = expandBasePath(override);
    try {
      this.enforceWorkspaceScope(root); // MED-7
      const resolved = path.resolve(root, targetPath);
      if (!isInsideRoot(resolved, root)) {
        this.send({ type: "file:read_result", correlationId, path: targetPath, error: "acesso negado" });
        return;
      }
      const stat = await fs.promises.stat(resolved);
      if (stat.isDirectory()) {
        this.send({ type: "file:read_result", correlationId, path: targetPath, error: "é um diretório" });
        return;
      }
      if (stat.size > 2 * 1024 * 1024) {
        this.send({ type: "file:read_result", correlationId, path: targetPath, error: "arquivo muito grande (> 2MB)" });
        return;
      }
      const content = await fs.promises.readFile(resolved, "utf-8");
      this.send({ type: "file:read_result", correlationId, path: targetPath, content });
    } catch (e) {
      this.send({ type: "file:read_result", correlationId, path: targetPath, error: (e as Error).message });
    }
  }

  private async handleFileWrite(correlationId: string, targetPath: string, content: string, override?: string) {
    if (!override) {
      this.send({ type: "file:write_result", correlationId, path: targetPath, ok: false, error: "workspaceRoot ausente na msg" });
      return;
    }
    const root = expandBasePath(override);
    try {
      this.enforceWorkspaceScope(root); // MED-7
      const resolved = path.resolve(root, targetPath);
      if (!isInsideRoot(resolved, root)) {
        this.send({ type: "file:write_result", correlationId, path: targetPath, ok: false, error: "acesso negado" });
        return;
      }
      // limites preventivos — não aceitar payloads gigantes.
      if (typeof content !== "string" || content.length > 5 * 1024 * 1024) {
        this.send({ type: "file:write_result", correlationId, path: targetPath, ok: false, error: "conteúdo inválido ou > 5MB" });
        return;
      }
      try {
        const stat = await fs.promises.stat(resolved);
        if (stat.isDirectory()) {
          this.send({ type: "file:write_result", correlationId, path: targetPath, ok: false, error: "é um diretório" });
          return;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      // garante diretório pai existe (write em path novo).
      await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
      await fs.promises.writeFile(resolved, content, { encoding: "utf-8", mode: 0o644 });
      this.send({ type: "file:write_result", correlationId, path: targetPath, ok: true });
    } catch (e) {
      this.send({ type: "file:write_result", correlationId, path: targetPath, ok: false, error: (e as Error).message });
    }
  }

  /** Override do workspace pra um único request — set pelo dispatcher
   *  antes do handler git:*, limpo depois. Per-request = multi-projeto
   *  seguro. */
  private activeWsOverride: string | null = null;

  private gitCwd(): string | null {
    if (!this.activeWsOverride) return null;
    const cwd = autoWorkspaceCwd(this.activeWsOverride);
    return this.isGitWorkTree(cwd) ? cwd : null;
  }

  private isGitWorkTree(cwd: string): boolean {
    const res = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return res.status === 0 && res.stdout.trim() === "true";
  }

  private gitExec(args: string[]): Promise<string> {
    if (!this.activeWsOverride) return Promise.reject(new Error("workspaceRoot ausente na msg git:*"));
    const fallback = autoWorkspaceCwd(this.activeWsOverride);
    // Env enxuto + drop de privilégio (MED-8): um repo pode ter .git/config
    // ou hooks; sem isto, secrets do daemon (THE_DUDES_DAEMON_TOKEN, etc.)
    // vazam pro processo git e ele roda como root. Espelha runGitClone.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: this.dropTo?.home ?? process.env.HOME ?? "/tmp",
      USER: this.dropTo?.user ?? process.env.USER ?? "nobody",
      LANG: process.env.LANG ?? "C.UTF-8",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    return new Promise((resolve, reject) => {
      const proc = spawnDropped("git", args, { cwd: this.gitCwd() ?? fallback, stdio: ["ignore", "pipe", "pipe"], env }, this.dropTo);
      let stdout = "";
      let stderr = "";
      proc.stdout!.setEncoding("utf8");
      proc.stdout!.on("data", (c: string) => { stdout += c; });
      proc.stderr!.setEncoding("utf8");
      proc.stderr!.on("data", (c: string) => { stderr += c; });
      proc.on("close", (code) => {
        if (code !== 0) { reject(new Error(stderr.trim() || `git exited ${code}`)); return; }
        resolve(stdout);
      });
      proc.on("error", (e) => reject(e));
    });
  }

  private async handleGitLog(correlationId: string, count?: number) {
    if (!this.gitCwd()) {
      this.send({ type: "git:log_result", correlationId, commits: [], error: "repo git não encontrado no workspace" });
      return;
    }
    try {
      // Coerce pra inteiro positivo com clamp — `count` chega do WS e um valor
      // string injetaria args no git (ex `--output=<file>` → escrita arbitrária).
      const n = Math.min(Math.max(Number.parseInt(String(count ?? 20), 10) || 20, 1), 1000);
      const output = await this.gitExec(["log", `-${n}`, "--format=%H||%s||%an||%aI"]);
      const commits = output.trim().split("\n").filter(Boolean).map((line) => {
        const [hash, message, author, date] = line.split("||");
        return { hash: hash.slice(0, 8), message, author, date };
      });
      this.send({ type: "git:log_result", correlationId, commits });
    } catch (e) {
      this.send({ type: "git:log_result", correlationId, commits: [], error: (e as Error).message });
    }
  }

  private async handleGitStatus(correlationId: string) {
    if (!this.gitCwd()) {
      this.send({ type: "git:status_result", correlationId, files: [], error: "repo git não encontrado no workspace" });
      return;
    }
    try {
      const [branchOut, statusOut] = await Promise.all([
        this.gitExec(["branch", "--show-current"]),
        this.gitExec(["status", "--porcelain"]),
      ]);
      const branch = branchOut.trim() || undefined;
      const files = statusOut.trim().split("\n").filter(Boolean).map((line) => ({
        status: line.slice(0, 2).trim() || "M",
        path: line.slice(3).trim(),
      }));
      this.send({ type: "git:status_result", correlationId, files, branch });
    } catch (e) {
      this.send({ type: "git:status_result", correlationId, files: [], error: (e as Error).message });
    }
  }

  private async handleGitDiff(correlationId: string, targetPath: string) {
    if (!this.gitCwd()) {
      this.send({ type: "git:diff_result", correlationId, path: targetPath, error: "repo git não encontrado no workspace" });
      return;
    }
    try {
      const output = await this.gitExec(["diff", "--", targetPath]);
      this.send({ type: "git:diff_result", correlationId, path: targetPath, diff: output || "(sem alterações)" });
    } catch (e) {
      this.send({ type: "git:diff_result", correlationId, path: targetPath, error: (e as Error).message });
    }
  }

  private async handleGitOp(correlationId: string, op: string, args: string[]) {
    if (!this.gitCwd()) {
      this.send({ type: "git:result", correlationId, op, ok: false, error: "repo git não encontrado no workspace" });
      return;
    }
    try {
      const output = await this.gitExec(args);
      this.send({ type: "git:result", correlationId, op, ok: true, output: output.trim() || undefined, message: `${op} ok` });
    } catch (e) {
      this.send({ type: "git:result", correlationId, op, ok: false, error: (e as Error).message });
    }
  }

  private async handleGitBranches(correlationId: string) {
    if (!this.gitCwd()) {
      this.send({ type: "git:result", correlationId, op: "branches", ok: false, error: "repo git não encontrado" });
      return;
    }
    try {
      const output = await this.gitExec(["branch", "-a"]);
      const branches = output.trim().split("\n").filter(Boolean)
        .filter((line) => !line.includes("->"))
        .map((line) => {
          const trimmed = line.trim().replace(/^\*\s*/, "");
          return { name: trimmed, current: line.startsWith("*") };
        });
      this.send({ type: "git:result", correlationId, op: "branches", ok: true, branches });
    } catch (e) {
      this.send({ type: "git:result", correlationId, op: "branches", ok: false, error: (e as Error).message });
    }
  }

  private async handleGitFileLog(correlationId: string, filePath: string, count?: number) {
    if (!this.gitCwd()) {
      this.send({ type: "git:result", correlationId, op: "file_log", ok: false, error: "repo git não encontrado" });
      return;
    }
    try {
      const n = Math.min(Math.max(Number.parseInt(String(count ?? 10), 10) || 10, 1), 1000);
      const output = await this.gitExec(["log", `-${n}`, "--format=%H||%s||%an||%aI", "--", filePath]);
      const commits = output.trim().split("\n").filter(Boolean).map((line) => {
        const [hash, message, author, date] = line.split("||");
        return { hash: hash.slice(0, 8), message, author, date };
      });
      this.send({ type: "git:result", correlationId, op: "file_log", ok: true, commits });
    } catch (e) {
      this.send({ type: "git:result", correlationId, op: "file_log", ok: false, error: (e as Error).message });
    }
  }

  private async handleGitStashList(correlationId: string) {
    if (!this.gitCwd()) {
      this.send({ type: "git:result", correlationId, op: "stash_list", ok: false, error: "repo git não encontrado" });
      return;
    }
    try {
      const output = await this.gitExec(["stash", "list"]);
      const stashes = output.trim().split("\n").filter(Boolean).map((line, idx) => {
        const match = line.match(/^stash@\{(\d+)\}:(.*)$/);
        return {
          index: match ? parseInt(match[1]) : idx,
          message: match ? match[2].trim() : line,
          branch: line.includes("On ") ? line.split("On ")[1]?.split(":")[0]?.trim() ?? "" : "",
        };
      });
      this.send({ type: "git:result", correlationId, op: "stash_list", ok: true, stashes });
    } catch (e) {
      this.send({ type: "git:result", correlationId, op: "stash_list", ok: false, error: (e as Error).message });
    }
  }

  private send(obj: FromDaemon) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ type: "daemon:ping", ts: Date.now() });
      // Re-anuncia os tokens dos agentes vivos a cada ping. Necessário porque
      // atrás do Cloudflare o WS do daemon pode permanecer ABERTO quando o
      // origin (server) reinicia — o daemon não detecta o restart, não dispara
      // o resync do "open", e o server fica com o Map agentTokens vazio →
      // /api/bridge devolve 401 pra sempre. O resync periódico restaura o
      // mapping em <pingMs. Idempotente (server ignora token já igual).
      for (const { id, token } of this.host.listAgentTokens()) {
        this.send({ type: "agent:token_resync", agentId: id, token });
      }
    }, this.args.pingMs);
  }
  private stopPing() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  /**
   * Heartbeat WS-level: manda PING frame nativo; se pong não chega em
   * HEARTBEAT_TIMEOUT_MS, força terminate pra disparar ws.on("close")
   * e reconnect. `ws.send()` é fire-and-forget — sem isso, daemon nunca
   * detecta peer morto.
   */
  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const ageMs = Date.now() - this.lastPongAt;
      if (ageMs > DaemonClient.HEARTBEAT_TIMEOUT_MS) {
        log("warn", `heartbeat timeout (${ageMs}ms sem pong) — terminating socket`);
        breadcrumb("ws", "heartbeat-timeout", { ageMs });
        captureWarn("ws heartbeat timeout", { ageMs });
        try { ws.terminate(); } catch {}
        return;
      }
      try {
        ws.ping();
      } catch (e) {
        log("warn", `ws.ping failed: ${(e as Error).message}`);
      }
    }, DaemonClient.HEARTBEAT_INTERVAL_MS);
  }
  private stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private shutdown() {
    log("info", "shutting down");
    this.stopped = true;
    this.host.shutdown();
    if (this.relay) this.relay.stop();
    this.stopPing();
    this.stopHeartbeat();
    forgetAllProjectKeys();
    try { this.ws?.close(1000, "shutdown"); } catch {}
    process.exit(0);
  }
}

function wsUrlFromOrch(orch: string): string {
  const u = new URL(orch);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${u.host}/ws/daemon`;
}

/**
 * Scrub PII antes de escrever pra stdout/stderr. Daemon roda como root
 * em alguns setups — log file (geralmente redirecionado pra journald ou
 * /tmp/the-dudes-daemon.log) pode acabar world-readable em multi-user
 * host. Mesmo cobertura parcial reduz blast-radius. Cobre:
 *  - Bearer tokens
 *  - THE_DUDES_AGENT_TOKEN inline em error msgs (env dump no spawn fail)
 *  - THE_DUDES_DAEMON_TOKEN
 *  - Argumentos --token X / -t X / token=X / Authorization headers
 *  - Ciphertext E2EE (não-segredo mas evita ruído)
 */
const SCRUB_BEARER_RE = /(authorization:\s*bearer\s+)[A-Za-z0-9._\-+/=]+/gi;
const SCRUB_QS_RE = /\b(token|recovery|kek|passphrase|password|secret|api[_-]?key)=([^&\s"'`]+)/gi;
const SCRUB_FLAG_RE = /(--token\s+|--bearer\s+|-t\s+)([A-Za-z0-9._\-+/=]{8,})/gi;
const SCRUB_ENV_RE = /(THE_DUDES_[A-Z_]*TOKEN["']?\s*[:=]\s*["']?)([^"',\s}]+)/g;
const SCRUB_E2E_RE = /\be2e:[A-Za-z0-9+/=]{8,}/g;
function scrubLog(msg: string): string {
  if (!msg) return "";
  return msg
    .replace(SCRUB_BEARER_RE, "$1[REDACTED]")
    .replace(SCRUB_QS_RE, "$1=[REDACTED]")
    .replace(SCRUB_FLAG_RE, "$1[REDACTED]")
    .replace(SCRUB_ENV_RE, "$1[REDACTED]")
    .replace(SCRUB_E2E_RE, "e2e:[REDACTED]");
}

function log(level: "info" | "warn" | "error", msg: string) {
  if (args.verboseHumanIo) return;
  const ts = new Date().toISOString();
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  const safe = scrubLog(msg);
  for (const line of safe.split(/\r?\n/)) {
    stream.write(`[${ts}] [${level}] ${line}\n`);
  }
}

function cliLog(level: "info" | "warn" | "error", msg: string) {
  if (!args.verbose && !args.verboseHuman && !args.verboseHumanIo) return;
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  const prefix = args.verboseHumanIo ? "" : `[cli] `;
  if (args.verboseHumanIo) {
    const lines = msg.split(/\r?\n/);
    const rendered = lines.map((line) => line.length ? line : "").join("\n");
    stream.write(`${rendered}\n`);
    return;
  }
  stream.write(`${prefix}${msg}\n`);
}

const args = parseCli();
const cliConfig = mergeCliConfig(
  loadDaemonCliConfig(args.cliConfigPath),
  { cliPaths: args.cliPaths },
);
const cliCommands = resolveCliCommands(cliConfig);
new DaemonClient(args, cliCommands).start().catch(async (e) => {
  capture(e, { phase: "startup" });
  log("error", `failed to start: ${(e as Error).message}`);
  await flushSentry();
  process.exit(1);
});
