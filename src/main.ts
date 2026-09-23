import { healthSnapshot, recentLogs, recordLog, recordWsRtt } from "./health-monitor.js";
import { turnGateDebug, turnGateStats } from "./runners/turn-gate.js";
import { installSyncProbes, startLoopMonitor } from "./debug/probes.js";
import { profileHome, startDebugDashboard, type DashboardHandle } from "./debug/index.js";
import { recordDebugLog, recordRtt, recordWsEvent, recordWsHandler, recordWsIn, recordWsOut, setCurrentInbound, setDebugScrubber } from "./debug/store.js";
import { performance } from "node:perf_hooks";
import {
  channelCanSend,
  createOutboundQueue,
  flushOutboundQueue,
  trySendOutbound,
} from "./runners/outbound-delivery.js";
import { captureBootBinaryHash, checkAndApplyUpdate, runningReleaseInfo } from "./self-update.js";
import { DAEMON_BUILD_TS } from "./daemon-build-ts.js";
import { createSelfUpdateGate } from "./self-update-gate.js";
import { createDeliveryDeduper, loadDeliverySeen, saveDeliverySeen } from "./inbound-dedup.js";
import { decidirClose, proximoDelayPassivo } from "./ws-handoff.js";
import { commitReexecSnapshot } from "./reexec-snapshot.js";
import {
  resolveGrokSessionRoots,
  scheduleGrokSessionCleanup,
} from "./grok-session-cleanup.js";
import { WIRE_PROTOCOL_VERSION } from "@the-dudes/protocol/wire-version";
import { initSentry, capture, captureWarn, breadcrumb, setTag, flush as flushSentry } from "./sentry.js";
initSentry(); // gated em SENTRY_DSN_DAEMON / SENTRY_DSN; no-op sem env

import os from "node:os";
import { format as formatArgs, parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { MAX_DAEMON_WIRE_MESSAGE_BYTES, WireMessageTooLargeError, parseWireMessage } from "@the-dudes/protocol";
import { AgentHost, agentErrorKind, sealAgentErrorMessage } from "./agent-host.js";
import { assertWorkspaceScoped, autoWorkspaceCwd, describeGitRoots, ensureWritableDir, expandBasePath, isInsideRoot, validateBasePath, validateGitHash, validateGitRef } from "./workspace.js";
import { buildGraph, graphMtime, graphPath, hasSemanticMarker, loadGraphJsonForUi, needsSemanticUpdate } from "./graph-indexer.js";
import { apagarArquivoOd, apagarProjetoOd, buscarArquivosOd, cancelarRunOd, copiarDesignSystemOd, criarProjetoOd, duplicarProjetoOd, gravarArquivoOd, guiarRunOd, iniciarRunOd, lerArquivoOd, lerArtefatoOd, lerRunOd, listarAgentsOd, listarArquivosOd, listarPluginsOd, listarProjetosOd, listarSkillsCatalogoOd, listarVersoesOd, restaurarVersaoOd } from "./open-design-client.js";
import { ensureGraphWatch, stopAllGraphWatches } from "./graph-watcher.js";
import { detectDropTarget, spawnDropped, type DropTarget } from "./privileges.js";
import { BridgeRelay, type PeerPidMode } from "./bridge-relay.js";
import { definirEmissorSombra, definirLogJev, registrarJevDoProjeto } from "./typesafe-delegate-shadow.js";
import { definirElencoProjeto } from "./typesafe-task-shadow.js";
import { defaultDaemonConfigPath, formatCliStatus, loadDaemonCliConfig, mergeCliConfig, resolveCliCommands, type DaemonCliConfig, type ResolvedCliCommands } from "./cli-config.js";
import { applyRunnerPolicy, buildInstalledRunnerAvailability, helloRunnerLists, POLICY_GATED_RUNNERS, type InstalledRunnerAvailability } from "./runner-policy.js";
import { assembleAgentSendParts, contentAadChain, openWithAnyHeldProject, type FromDaemon, type FromOrch, type TaskUpdatedEv } from "./protocol.js";
import { runSummarizer } from "./summarizer-runner.js";
import { aadV2, E2EE_TABLE } from "@the-dudes/protocol/e2ee-fields";
import { interpolateMissionMemory } from "@the-dudes/protocol/mission-memory";
import { decryptForProject, decryptImageAttachments, encryptForProject, countUsableProjectKeys, forgetAllProjectKeys, getDaemonPublicKey, hasProjectKey, isE2eEncrypted, isE2eeRequired, listHeldProjectIds, rememberProjectKey, setE2eeRequired } from "./daemon-crypto.js";
import { decryptTranscriptBlobs, TRANSCRIPT_DECRYPT_REASONS } from "./transcript-decrypt.js";
import { dispatchWebhook } from "./webhook-dispatch.js";
import { ModelDiscovery } from "./model-discovery.js";
import { parseGitPorcelain } from "./git-status.js";
import { runPs, runSuiteParkCli, startSuitePark, suiteParkCliArgs, type SuiteParkHandle } from "./suite-park.js";
import { createTaskWorktree, removeTaskWorktree } from "./task-workspace.js";
import { applyMemoryBlockBudget, MEMORY_HOTSET_BUDGET_CHARS, type MemoryBlockItem } from "./memory-utils.js";

// Embutida no build a partir do package.json (ver build.mjs); fallback pro
// modo dev (tsx direto, sem define).
const VERSION = process.env.DAEMON_PKG_VERSION ?? "0.0.0-dev";

// T-088: hash da imagem CARREGADA. Nunca re-ler argv[1] depois — o arquivo
// no disco muda no self-update; o processo segue na imagem antiga até re-exec.
const BOOT_BINARY_HASH = captureBootBinaryHash(process.argv[1] ?? "");

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

type CliPathsMap = NonNullable<DaemonCliConfig["cliPaths"]>;

/** T-306: composição cliPaths de flags de CLI + env — SÓ campos com valor
 *  entram no objeto. Antes, o literal em parseCli mantinha TODAS as chaves
 *  (valor undefined quando sem flag/env) e o spread do mergeCliConfig
 *  clobberava o cliPaths do daemon-config.json (ex.: cliPaths.claude do
 *  arquivo virava undefined) — o dono perdia override de arquivo e o QA
 *  precisava de workaround via THE_DUDES_CLAUDE_PATH (T-274). Precedência
 *  resultante: flag/env explícito > daemon-config.json > default. */
export function cliPathsFromFlags(
  flags: { claude?: string; opencode?: string; gemini?: string; qwen?: string; codex?: string; crush?: string; grok?: string },
  env: NodeJS.ProcessEnv = process.env,
): CliPathsMap {
  const out: CliPathsMap = {};
  const pairs: Array<[keyof CliPathsMap, string | undefined]> = [
    ["claude", flags.claude ?? env.THE_DUDES_CLAUDE_PATH],
    ["opencode", flags.opencode ?? env.THE_DUDES_OPENCODE_PATH],
    ["gemini", flags.gemini ?? env.THE_DUDES_GEMINI_PATH],
    ["qwen", flags.qwen ?? env.THE_DUDES_QWEN_PATH],
    ["codex", flags.codex ?? env.THE_DUDES_CODEX_PATH],
    ["crush", flags.crush ?? env.THE_DUDES_CRUSH_PATH],
    ["grok", flags.grok ?? env.THE_DUDES_GROK_PATH],
  ];
  for (const [key, value] of pairs) {
    // Vazio/whitespace não é override — nem sequer entra (normalizePath do
    // cli-config trataria como undefined do mesmo jeito).
    if (value && value.trim()) out[key] = value;
  }
  return out;
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
      "qwen-path": { type: "string" },
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
  const cliPaths = cliPathsFromFlags({
    claude: values["claude-path"],
    opencode: values["opencode-path"],
    gemini: values["gemini-path"],
    qwen: values["qwen-path"],
    codex: values["codex-path"],
    crush: values["crush-path"],
    grok: values["grok-path"],
  });
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
  --claude-path / --opencode-path / --gemini-path / --qwen-path / --codex-path / --crush-path / --grok-path
             Manual executable overrides for each CLI
  -h, --help Show this help

Diagnóstico (roda sem --orch/--token, não abre WS):
  --list-suites        Lista as suites de teste vivas no host e classifica
                       cada uma como viva/pendurada pelo critério de CPU
  --reap-suites        Igual, e mata a ÁRVORE das penduradas (raiz + workers
                       + o grep do pipeline). SIGTERM e, se resistir, SIGKILL
  --suite-window-ms N  Janela de medição de CPU (default 60000)
  --suite-min-age-ms N Idade mínima da raiz para ser candidata (default 600000)`);
}

/** Exportado p/ teste unitário (T-252) — o bootstrap real continua privado
 *  ao módulo via SELF_BOOTSTRAP (abaixo). */
function kindOpenDesign(type: Extract<FromOrch, { type: `open_design:${string}` }>["type"]): "projects" | "files" | "file" | "run" | "notice" | "search" | "artifact" | "skills" | "plugins" | "agents" | "versions" | "design_system" {
  switch (type) {
    case "open_design:list":
    case "open_design:create_project":
    case "open_design:delete_project":
    case "open_design:duplicate":
      return "projects";
    case "open_design:files":
    case "open_design:write":
    case "open_design:delete_file":
      return "files";
    case "open_design:file":
    case "open_design:restore_version":
      return "file";
    case "open_design:start_run":
    case "open_design:run":
    case "open_design:cancel_run":
    case "open_design:steer":
      return "run";
    case "open_design:search":
      return "search";
    case "open_design:artifact":
      return "artifact";
    case "open_design:skills":
      return "skills";
    case "open_design:plugins":
      return "plugins";
    case "open_design:agents":
      return "agents";
    case "open_design:versions":
      return "versions";
    case "open_design:copy_design_system":
      return "design_system";
    default: {
      const _nunca: never = type;
      return _nunca;
    }
  }
}

export class DaemonClient {
  /** M35 (T-475): welcome do server declarou protocolo diferente do local. */
  protocolMismatch = false;
  private args: Args;
  private readonly installedRunnerAvailability: InstalledRunnerAvailability;
  private ws: WebSocket | null = null;
  private reconnectDelay = 1_000;
  private static readonly RECONNECT_CAP_MS = 60_000;
  // Backoff separado pro transient: sem isto, um outage que feche com
  // 1006/1005/1011 de forma persistente reconectava a ~5x/s indefinidamente
  // (hot loop). Escala 200ms→5s e reseta ao conectar.
  private transientBackoff = 200;
  private stableConnTimer: NodeJS.Timeout | null = null;
  /** T-846: hello `passive: true` — retomada depois de 4000/4001. */
  private helloPassivo = false;
  /** T-846: cooldown corrente do passivo (30s → 5min). */
  private passivoDelayMs = 0;
  /** T-846: o warn do handoff sai uma vez por episódio. */
  private handoffLogado = false;
  private static readonly TRANSIENT_BASE_MS = 200;
  private static readonly TRANSIENT_BACKOFF_CAP_MS = 5_000;
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
  private lastPingSentAt = 0;
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
    this.installedRunnerAvailability = buildInstalledRunnerAvailability(cliCommands);
    this.modelDiscovery = new ModelDiscovery(cliCommands, this.dropTo);
    if (this.dropTo) {
      log("info", `running as root via sudo — child processes will drop to uid=${this.dropTo.uid} (${this.dropTo.user}) home=${this.dropTo.home}`);
    }
    setTag("daemon_name", this.args.name);
    setTag("hostname", os.hostname());
    this.host = new AgentHost((msg) => this.send(msg), this.dropTo, null, this.cliCommands, this.args.verbose, this.args.verboseHuman, this.args.verboseHumanIo, log, cliLog);
    this.wireGraphWatch();
  }

  /** Liga callback de watch do grafo no AgentHost (rebuilds debounced). */
  private wireGraphWatch(): void {
    this.host.onGraphWatch = (root, gbin, projectId) => {
      ensureGraphWatch(root, gbin, {
        onStatus: (status, info) => {
          this.send({
            type: "graph:status",
            projectId,
            status,
            nodeCount: info?.nodeCount,
            edgeCount: info?.edgeCount,
            error: info?.error,
            progress: info?.progress,
            phase: info?.phase,
            indexMtime: info?.indexMtime,
            stale: info?.stale,
            graphifyAvailable: !!this.cliCommands.graphify?.available,
            graphifyMcpAvailable: !!this.cliCommands.graphifyMcp?.available,
          });
        },
        log,
      }, projectId);
    };
  }

  async start() {
    process.on("SIGINT", () => this.shutdown());
    process.on("SIGTERM", () => this.shutdown());
    // Sweep de tmpdirs órfãos de agentes (token plaintext em /tmp) — cobre
    // crash anterior onde o cleanup do emitExit não rodou. Só varre se NENHUM
    // outro daemon vivo compartilha este parent: num host com 2 daemons (mesmo
    // $TMPDIR/user), limpar tudo destruía agent.token/.gemini de agentes ativos
    // do vizinho. Marca a própria liveness por PID. Ver SECURITY-TODO S-05.
    try {
      const parent = path.join(os.tmpdir(), "the-dudes");
      let neighborAlive = false;
      try {
        for (const name of fs.readdirSync(parent)) {
          const m = /^\.daemon-(\d+)\.alive$/.exec(name);
          if (m && Number(m[1]) !== process.pid && isPidAlive(Number(m[1]))) { neighborAlive = true; break; }
        }
      } catch { /* dir não existe ainda */ }
      if (neighborAlive) {
        log("info", "boot sweep pulado: outro daemon vivo compartilha o tmpdir");
      } else {
        try {
          for (const name of fs.readdirSync(parent)) {
            try { fs.rmSync(path.join(parent, name), { recursive: true, force: true }); } catch { /* skip */ }
          }
        } catch { /* dir não existe ainda — ok */ }
      }
      // Marca este daemon como vivo pro próximo boot respeitar (após o sweep).
      try {
        fs.mkdirSync(parent, { recursive: true });
        fs.writeFileSync(path.join(parent, `.daemon-${process.pid}.alive`), String(process.pid));
      } catch { /* best-effort */ }
    } catch { /* dir não existe ainda — ok */ }
    // T-051: GC de sessões Grok do summarizer (cwd the-dudes-cli-*). Nunca
    // toca sessões de projeto/worktree/outros prefixes. Boot + a cada 6h.
    try {
      this.grokSessionCleanup = scheduleGrokSessionCleanup({
        roots: resolveGrokSessionRoots({
          home: process.env.HOME ?? os.homedir(),
          dropToHome: this.dropTo?.home ?? null,
          grokHomeEnv: process.env.GROK_HOME ?? null,
        }),
        log: (level, msg) => log(level, msg),
      });
    } catch (e) {
      log("warn", `grok session cleanup init falhou: ${(e as Error).message}`);
    }
    // Start the local Unix-socket relay so MCP bridges spawned by agents
    // (which run as the dropped user) can reach the orchestrator without
    // hitting an outbound firewall app.
    definirEmissorSombra((veredito) => {
      try { this.send(veredito); } catch { /* a emissão não falha o delegate */ }
    });
    // T-868: ligar/desligar o Jev pelo toggle não muda em silêncio.
    definirLogJev((nivel, msg) => log(nivel, msg));
    // T-852: elenco do projeto para as opções do Jev nas tasks. Só name/role
    // (whitelist) — o AgentInfo carrega o systemPrompt já decifrado.
    definirElencoProjeto((projectId) => {
      try { return this.host.elencoDoProjeto(projectId); } catch { return []; }
    });
    this.relay = new BridgeRelay(this.orchUrl, this.dropTo, (agentId) => this.host.getAgentProjectId(agentId), {
      // T-581: o prompt de delegação cifrado cita o nome do pai (o subagente
      // responde por send_message pra ele). Closures lazy — `host` nasce abaixo.
      agentNameLookup: (agentId) => this.host.getAgentName(agentId),
    });
    try {
      await this.relay.start();
      log("info", `bridge relay listening on ${this.relay.socketPath}`);
      this.host = new AgentHost((msg) => this.send(msg), this.dropTo, this.relay.socketPath, this.cliCommands, this.args.verbose, this.args.verboseHuman, this.args.verboseHumanIo, log, cliLog);
      this.wireGraphWatch();
    } catch (e) {
      log("warn", `bridge relay failed to start (${(e as Error).message}) — agents will fetch orch directly`);
    }
    // T-720: mensagens retidas pelo dreno do re-exec anterior (spool cifrado).
    // Entregues no spawn de cada agente (replay do hello, T-710b).
    try { this.host.loadReexecSpool(); } catch (e) {
      log("warn", `[self-update] spool: leitura falhou (${(e as Error).message})`);
    }
    // T-824 (revisão): ids de entrega vistos pelo processo anterior — o replay
    // do server (resumeFromSeq=0) não reentrega o que já foi processado/retido.
    try {
      const vistos = loadDeliverySeen(profileHome());
      for (const id of vistos) this.deliveryDedup.markSeen(id);
      if (vistos.length) log("info", `[boot] ${vistos.length} id(s) de entrega do processo anterior carregados (dedup do replay)`);
    } catch (e) {
      log("warn", `[boot] ids de entrega vistos: leitura falhou (${(e as Error).message})`);
    }
    // Marcador de "parar de vez" que sobrou de um uninstall sem daemon vivo
    // não pode valer para o próximo shutdown.
    try { fs.rmSync(path.join(profileHome(), STOP_AGENTS_MARKER), { force: true }); } catch { /* noop */ }
    POLICY_GATED_RUNNERS.forEach((runner) => {
      const status = this.cliCommands[runner];
      log(status.available ? "info" : "warn", formatCliStatus(runner, status));
    });
    // T-582: suites de teste abandonadas por turnos que terminaram sobrevivem
    // no host para sempre (13 acumuladas, a mais antiga com 1d18h). O loop
    // classifica por CPU parada e mata a árvore. Opt-out: THE_DUDES_SUITE_PARK=0.
    if (process.env.THE_DUDES_SUITE_PARK !== "0") {
      try {
        this.suitePark = startSuitePark({ log: (level, msg) => log(level, msg) });
      } catch (e) {
        log("warn", `suite-park init falhou: ${(e as Error).message}`);
      }
    }
    // T-812: dashboard de debug local — não bloqueia o boot nem a conexão.
    void this.startDebugDashboard().catch((e) => log("warn", `[debug-http] falhou: ${(e as Error).message}`));
    this.connect();
  }

  /** T-812: dashboard de debug (loopback + token; opt-out THE_DUDES_DEBUG_HTTP=0). */
  private debugDashboard: DashboardHandle | null = null;

  private async startDebugDashboard(): Promise<void> {
    if (process.env.THE_DUDES_DEBUG_HTTP === "0" || this.debugDashboard) return;
    this.debugDashboard = await startDebugDashboard({
      log,
      scrub: scrubLog,
      identity: () => this.debugIdentity(),
      agents: () => this.host.debugSnapshot(),
      agentCount: () => this.host.agentCount(),
      hostState: () => this.host.debugHostState(),
      gate: () => turnGateDebug(),
      wsLive: () => this.debugWsLive(),
      runners: () => {
        const lists = helloRunnerLists(this.cliCommands, this.installedRunnerAvailability);
        return { commands: this.cliCommands, available: lists.availableRunners, installed: lists.installedRunners };
      },
      health: () => ({
        ...healthSnapshot({ turnGate: turnGateStats(), agentsRunning: this.host.agentCount(), e2eeProjects: countUsableProjectKeys() }),
        ...runningReleaseInfo(),
        ...this.peerPidHealthFields(),
      }),
      relayLive: () => ({
        socketPath: this.relay?.socketPath ?? null,
        peerPid: this.relay?.peerPidState() ?? null,
        peerCacheSize: this.relay?.unixPeerOsCacheSize() ?? 0,
      }),
    });
  }

  /** T-812: identidade do processo para o dashboard (sem token: argv passa pelo scrub). */
  private debugIdentity(): Record<string, unknown> {
    return {
      name: this.args.name,
      version: VERSION,
      buildTs: DAEMON_BUILD_TS,
      protocolVersion: WIRE_PROTOCOL_VERSION,
      protocolMismatch: this.protocolMismatch,
      bootBinaryHash: BOOT_BINARY_HASH ? BOOT_BINARY_HASH.slice(0, 16) : null,
      release: runningReleaseInfo(),
      pid: process.pid,
      ppid: process.ppid,
      hostname: os.hostname(),
      orch: this.orchUrl,
      profileHome: profileHome(),
      execPath: process.execPath,
      script: process.argv[1] ?? null,
      argv: scrubLog(process.argv.slice(2).join(" ")),
      cwd: process.cwd(),
      node: process.version,
      launcher: process.env.THE_DUDES_LAUNCHER === "1",
      dropTo: this.dropTo ? { user: this.dropTo.user, uid: this.dropTo.uid } : null,
      verbose: { verbose: this.args.verbose, human: this.args.verboseHuman, humanIo: this.args.verboseHumanIo },
      pingMs: this.args.pingMs,
      selfUpdate: process.env.THE_DUDES_SELF_UPDATE !== "0",
      draining: this.host.isDraining(),
    };
  }

  /** T-812: estado vivo do WS com o orchestrator. */
  private debugWsLive(): Record<string, unknown> {
    const ws = this.ws;
    const now = Date.now();
    return {
      url: wsUrlFromOrch(this.args.orch),
      readyState: ws ? ws.readyState : null,
      bufferedAmount: ws?.bufferedAmount ?? 0,
      outboundQueued: this.outboundQueue.items.length,
      lastSeenSeq: this.lastSeenSeq,
      lastPongAgoMs: this.lastPongAt ? now - this.lastPongAt : null,
      reconnectDelay: this.reconnectDelay,
      transientBackoff: this.transientBackoff,
      transientRecent: this.transientDisconnects.filter((t) => now - t < DaemonClient.TRANSIENT_WINDOW_MS).length,
      protocolMismatch: this.protocolMismatch,
      stopped: this.stopped,
    };
  }

  /**
   * T-846: voltar passivo depois do cooldown. No 4000 (fomos assumidos) os
   * CLIs locais param — quem ficou é dono dos agentes; no 4001 já estamos
   * parados e só esperamos. Sem replay e sem revezamento: se o vencedor morrer,
   * o server aceita o passivo e faz o replay dos agentes.
   */
  private agendarRetomadaPassiva(decisao: "passivo-superseded" | "passivo-occupied"): void {
    const delay = proximoDelayPassivo(this.passivoDelayMs);
    this.passivoDelayMs = delay;
    this.helloPassivo = true;
    if (decisao === "passivo-superseded") {
      const n = this.host.stopLocalClis("T-846: conexão assumida por outro processo com o mesmo token");
      if (!this.handoffLogado) {
        this.handoffLogado = true;
        log(
          "warn",
          `outro processo com o mesmo token assumiu a conexão (pid=${process.pid} host=${os.hostname()}) — ` +
          `este daemon parou ${n} CLI(s) local(is), segue vivo e tenta voltar passivo em ${Math.round(delay / 1000)}s`,
        );
      } else {
        log("info", `[handoff] assumido de novo — ${n} CLI(s) local(is) parado(s); passivo em ${Math.round(delay / 1000)}s`);
      }
    } else if (!this.handoffLogado) {
      this.handoffLogado = true;
      log("info", `token ocupado por outro processo (close 4001) — nova tentativa passiva em ${Math.round(delay / 1000)}s`);
    }
    breadcrumb("ws", "handoff", { decisao, delayMs: delay, passivo: true });
    setTimeout(() => this.connect(), delay);
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
      maxPayload: MAX_DAEMON_WIRE_MESSAGE_BYTES,
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
      // RTT do canal com o orchestrator — vira o indicador de latência da UI.
      if (this.lastPingSentAt) {
        recordWsRtt(Date.now() - this.lastPingSentAt);
        recordRtt(Date.now() - this.lastPingSentAt);
      }
    });

    ws.on("open", () => {
      this.reconnectDelay = 1_000;
      // NÃO reseta transientBackoff já no open: 1011/1006 podem chegar DEPOIS
      // do handshake e um reset imediato manteria o hot loop pós-open. Só reseta
      // após a conexão ficar ESTÁVEL por 30s (limpo no close se cair antes).
      if (this.stableConnTimer) clearTimeout(this.stableConnTimer);
      this.stableConnTimer = setTimeout(() => {
        this.transientBackoff = DaemonClient.TRANSIENT_BASE_MS;
      }, 30_000);
      this.lastPongAt = Date.now();
      recordWsEvent("open", url);
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
        protocolVersion: WIRE_PROTOCOL_VERSION,
        // T-846: hello passivo não substitui; o server responde 4001 se o
        // token ainda estiver ocupado por outro processo vivo. O campo ainda
        // não está no DaemonHello do protocolo (o server o lê cru), daí o cast.
        passive: this.helloPassivo,
        ...runningReleaseInfo(),
        cryptoPublicKey,
        // Resume: server reenvia msgs com seq > lastSeenSeq do buffer
        // persistente per-tokenId. 0/ausente = primeira conn / buffer
        // expirou (server faz nothing, comportamento legado).
        resumeFromSeq: this.lastSeenSeq,
        availableRunners: helloRunnerLists(this.cliCommands, this.installedRunnerAvailability).availableRunners,
        installedRunners: helloRunnerLists(this.cliCommands, this.installedRunnerAvailability).installedRunners,
        graphify: {
          cli: !!this.cliCommands.graphify?.available,
          mcp: !!this.cliCommands.graphifyMcp?.available,
        },
      } as FromDaemon);
      // Ressincroniza tokens de agents já rodando localmente — sem isso,
      // após restart do server, o Map agentTokens fica vazio e o
      // mcp-bridge (que mantém o token antigo em env) começa a receber
      // 401 em /api/bridge. Agents sem auto_resume_at flag não passam
      // pelo path de auto-resume, então este push proativo cobre-os.
      for (const { id, token } of this.host.listAgentTokens()) {
        this.send({ type: "agent:token_resync", agentId: id, token });
      }
      // Reenvia agent:text/error que caíram durante o buraco de WS (T-009).
      this.flushOutboundQueue();
      this.startPing();
      this.startHeartbeat();
      this.scheduleSelfUpdate();
    });

    ws.on("message", (raw: Buffer) => {
      let msg: FromOrch;
      try {
        msg = parseWireMessage<FromOrch>(raw.toString(), { maxBytes: MAX_DAEMON_WIRE_MESSAGE_BYTES });
      } catch (e) {
        // O default do parser era 8MB enquanto o socket aceitava 32MB: um
        // `agent:send` com imagens era descartado aqui em silêncio e o
        // agente simplesmente nunca recebia o prompt. Agora o teto bate com
        // o do socket, e o que ainda estourar aparece no log.
        if (e instanceof WireMessageTooLargeError) {
          log("warn", `mensagem do orchestrator grande demais (${e.bytes}B > ${e.maxBytes}B) — descartada`);
        }
        recordWsIn("(inválida)", raw.length);
        return;
      }
      // Tracka maior seq visto pra resume no próximo reconnect. Server
      // injeta seq em cada msg via sendDaemon. Replay duplica msgs com
      // seq <= lastSeen — handle natural cobre (correlationId match
      // descarta duplicados nos handlers de file:/git: result).
      const seq = Number((msg as any).seq);
      if (Number.isFinite(seq) && seq > this.lastSeenSeq) {
        this.lastSeenSeq = seq;
      }
      // T-812: tipo, bytes e tempo do handler (parte síncrona = loop bloqueado).
      const tipo = String((msg as { type?: unknown }).type ?? "?");
      recordWsIn(tipo, raw.length);
      const t0 = performance.now();
      setCurrentInbound(tipo);
      let handled: Promise<void>;
      try {
        handled = this.handle(msg);
      } finally {
        setCurrentInbound(null);
      }
      const syncMs = performance.now() - t0;
      // Rejeição segue sem dono como antes (o throw re-propaga ao unhandledRejection).
      void handled.then(
        () => { recordWsHandler(tipo, syncMs, performance.now() - t0); },
        (err) => { recordWsHandler(tipo, syncMs, performance.now() - t0); throw err; },
      );
    });

    ws.on("close", (code, reason) => {
      this.stopPing();
      this.stopHeartbeat();
      // Cai antes dos 30s de estabilidade → não reseta o backoff transient.
      if (this.stableConnTimer) { clearTimeout(this.stableConnTimer); this.stableConnTimer = null; }
      this.ws = null;
      recordWsEvent("close", reason?.toString() || "(no reason)", code);
      if (this.stopped) return;
      const reasonStr = reason?.toString() || "(no reason)";
      // T-846: handoff de token — outro processo com o mesmo token assumiu
      // (4000) ou o token segue ocupado para o nosso hello passivo (4001).
      // Nada de reconexão imediata: sem isto os dois processos se revezavam.
      const decisao = decidirClose(code, reasonStr);
      if (decisao !== "normal") {
        this.agendarRetomadaPassiva(decisao);
        return;
      }
      if (this.helloPassivo) {
        // Close "comum" durante o passivo (rede caiu e o vencedor morreu, por
        // exemplo): volta ao caminho normal, com backoff próprio.
        this.helloPassivo = false;
        this.passivoDelayMs = 0;
      }
      const isTransient = code === 1006 || code === 1005 || code === 1011;
      const baseDelay = isTransient ? this.transientBackoff : this.reconnectDelay;
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
          // Escala o backoff transient — outage persistente não vira hot loop.
          this.transientBackoff = Math.min(this.transientBackoff * 2, DaemonClient.TRANSIENT_BACKOFF_CAP_MS);
        }
        this.connect();
      }, jittered);
    });

    ws.on("error", (err) => {
      recordWsEvent("error", (err as Error).message);
      log("error", `ws error: ${(err as Error).message}`);
      capture(err, { phase: "ws:error" });
    });

    ws.on("unexpected-response", (_req, res) => {
      recordWsEvent("handshake", `HTTP ${res.statusCode}`);
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
    // T-852/T-878: `project:features` ainda não está no FromOrch da main (o
    // tipo chega com o contrato do SERVER). Daemon antigo ignora a mensagem
    // desconhecida; aqui ela desliga o Jev do projeto com efeito IMEDIATO, sem
    // esperar o próximo spawn. Fora do switch porque a case não é comparável.
    const tipos = msg as { type: string; projectId?: unknown; jev?: unknown };
    if (tipos.type === "project:features") {
      registrarJevDoProjeto(String(tipos.projectId ?? ""), tipos.jev === true);
      return;
    }
    switch (msg.type) {
      case "daemon:welcome":
        log("info", `authed as ${msg.user.name} <${msg.user.email}>`);
        // T-846: fomos aceitos (inclusive como passivo, quando o vencedor
        // morreu). Daqui em diante vale o caminho normal de reconexão.
        if (this.helloPassivo) {
          log("info", "[handoff] assumimos a conexão de volta — operação normal");
          this.helloPassivo = false;
        }
        this.passivoDelayMs = 0;
        this.handoffLogado = false;
        // M35 (T-475): o server anuncia a versão de fio no welcome; mismatch
        // aqui = daemon velho contra server novo (o outro lado nos recusaria
        // no hello, mas quando É o server que subiu primeiro queremos o aviso
        // local). Ausente = server antigo; aceita.
        if (Number.isInteger(msg.protocolVersion) && msg.protocolVersion !== WIRE_PROTOCOL_VERSION) {
          log("error", `[protocol] server=${msg.protocolVersion} daemon=${WIRE_PROTOCOL_VERSION} — atualize o daemon (agents rodam com risco de incompatibilidade)`);
          this.protocolMismatch = true;
        }
        return;
      case "daemon:pong":
        return;
      case "release:available": {
        // T-033: server detectou sha novo em /install — check imediato
        // (sem esperar o intervalo horário). Dedup no gate se já checando.
        const sha = typeof msg.sha256 === "string" ? msg.sha256.slice(0, 12) : "?";
        void this.selfUpdateGate.trigger(`push ${sha}`);
        return;
      }
      case "runner-policy:set": {
        applyRunnerPolicy(this.cliCommands, this.installedRunnerAvailability, msg.allowedRunners);
        log("info", `runner policy synced: ${[...new Set(msg.allowedRunners)].join(", ") || "none"}`);
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
        if (msg.projectId) registrarJevDoProjeto(msg.projectId, msg.features?.jev === true);
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
          const dec = decryptForProject(
            e2eOnly,
            msg.projectId,
            aadV2({ projectId: msg.projectId, table: E2EE_TABLE.AGENTS, field: "system_prompt" }),
          );
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
            {
              const plain = `systemPrompt E2EE não decripta (${why}). Agente sobe com role-only (sessão limpa) — abra o projeto no browser e re-salve o system prompt do agente.`;
              const sealed = sealAgentErrorMessage(msg.projectId, plain);
              if (sealed) {
                this.send({ type: "agent:error", agentId: spec.agent.id, message: sealed, errorKind: agentErrorKind(plain) });
              } else log("error", `agent:error recusado: e2ee-required sem chave project=${msg.projectId}`);
            }
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
          // Budget token-aware + reserva p/ decision/preference (sticky).
          // Server é cego a tokens (cipher); corte real é aqui.
          // T-342: o budget é o MESMO valor que o bridge reporta no aviso de
          // pin — uma única fonte (memory-utils).
          const decoded: MemoryBlockItem[] = [];
          for (const m of msg.memory) {
            const title = isE2eEncrypted(m.titleCipher)
              ? decryptForProject(m.titleCipher, msg.projectId, aadV2({ projectId: msg.projectId, table: E2EE_TABLE.MEMORIES, field: "title" }))
              : m.titleCipher;
            const body = isE2eEncrypted(m.bodyCipher)
              ? decryptForProject(m.bodyCipher, msg.projectId, aadV2({ projectId: msg.projectId, table: E2EE_TABLE.MEMORIES, field: "body" }))
              : m.bodyCipher;
            if (title === null || body === null) continue;
            decoded.push({ type: m.type || "fact", text: `### [${m.type}] ${title}\n${body}`, source: m.source });
          }
          // T-343: blocos etiquetados com fatia própria + empréstimo de folga
          // (em vez do monte único por prioridade de tipo).
          const { sections, dropped, used } = applyMemoryBlockBudget(decoded, MEMORY_HOTSET_BUDGET_CHARS);
          if (dropped > 0) {
            log("info", `memory budget: ${decoded.length - dropped} injected (~${used} chars), ${dropped} dropped (over ${MEMORY_HOTSET_BUDGET_CHARS}) for ${spec.agent.id}`);
          }
          if (sections.length > 0 || dropped > 0) {
            const parts = sections.map((s) => `## ${s.heading}\n<!-- ${s.usage} -->\n\n${s.items.join("\n\n")}`);
            if (dropped > 0) {
              parts.push(`## Nota do sistema\n${dropped} memória(s) omitida(s) por limite do hot-set (cada bloco tem fatia própria; a folga foi emprestada por ordem decision→preference→experience→reference→fact). Use \`recall\` para o resto.`);
            }
            const block = `## Project Memory\n\nNotas duráveis **deste agente**, em blocos (não são copiadas para os outros). Catálogo do projeto: use a tool \`recall\`. Verifique antes de confiar em detalhes específicos.\n\n${parts.join("\n\n")}`;
            spec.agent = { ...spec.agent, systemPrompt: `${spec.agent.systemPrompt}\n\n---\n\n${block}` };
            log("info", `injected ${decoded.length - dropped} memory entries in ${sections.length} blocks into ${spec.agent.id} system prompt`);
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
        log("info", `agent:send recebido agent=${msg.agentId} bytes=${String(msg.content ?? "").length} imgs=${(msg.images ?? []).length}`);
        // T-037: reentrega do server (pending + resume) usa o mesmo deliveryId.
        // T-252: só CONSULTA aqui — marcar cedo descartava o retry do server
        // como duplicata quando o decrypt falhava (ex.: chave em rotação),
        // perdendo a mensagem. markSeen acontece no aceite, após
        // decrypt+processamento (fim do case).
        if (this.deliveryDedup.isSeen(msg.deliveryId)) {
          log("info", `agent:send deliveryId=${msg.deliveryId?.slice(0, 8)} — duplicata ignorada`);
          return;
        }
        let content: string;
        // T-597 F1: pid com que o frame foi de fato selado. Começa no pid da
        // linha; se um fallback abrir, vira o pid que abriu — os anexos do
        // mesmo frame usam o mesmo pid.
        let sealPid = msg.projectId;
        const dropMissingKey = () => {
          log("warn", `agent:send to ${msg.agentId} cipher nao abre com nenhuma chave detida (linha=${msg.projectId ?? "-"}) — dropping`);
          const plain = `daemon sem chave que abra a mensagem (linha=${msg.projectId ?? "sem pid"}) — recarregue a página ou reinicie o daemon`;
          const sealed = sealAgentErrorMessage(msg.projectId, plain);
          if (sealed) {
            this.send({ type: "agent:error", agentId: msg.agentId, message: sealed, errorKind: agentErrorKind(plain) });
          } else log("error", `agent:error recusado: e2ee-required sem chave project=${msg.projectId}`);
        };
        if (msg.parts && msg.parts.length > 0) {
          // T-597 F1: tenta o pid da linha e, se não abrir, os demais pids
          // detidos (o remetente pode ter selado com OUTRO pid — caminho
          // direto do bridge). Mesmo primitivo do caminho de content.
          const opened = openWithAnyHeldProject(msg.projectId, listHeldProjectIds(), (pid) => {
            const a = assembleAgentSendParts(msg.parts!, pid, decryptForProject, isE2eEncrypted);
            return a.ok ? a : null;
          });
          if (opened === null) {
            const assembled = assembleAgentSendParts(msg.parts, msg.projectId, decryptForProject, isE2eEncrypted);
            const hasKey = !!(msg.projectId && hasProjectKey(msg.projectId));
            if (hasKey) {
              log(
                "warn",
                `agent:send to ${msg.agentId} cipher drop reason=${assembled.ok ? "-" : assembled.reason} prefix=${assembled.ok ? "-" : assembled.prefix} hasKey=true line=${msg.projectId ?? "-"}`,
              );
              const plain = "agent:send cipher recusado";
              const sealed = sealAgentErrorMessage(msg.projectId, plain);
              if (sealed) {
                this.send({ type: "agent:error", agentId: msg.agentId, message: sealed, errorKind: agentErrorKind(plain) });
              } else log("error", `agent:error recusado: e2ee-required sem chave project=${msg.projectId}`);
            } else {
              dropMissingKey();
            }
            return;
          }
          if (opened.pid !== msg.projectId) {
            sealPid = opened.pid;
            log("warn", `agent:send to ${msg.agentId} parts abertas por fallback pid=${opened.pid} (linha=${msg.projectId ?? "-"})`);
          }
          content = opened.value.content;
        } else {
          content = msg.content;
          if (isE2eEncrypted(content)) {
            // T-649: além do pid, varia o AAD por candidato (conjunto pequeno,
            // canônico primeiro: messages.content → tasks.description — o
            // dispatch de step carrega a description da task). Fail-closed:
            // nada abre → drop como antes.
            let openedAad: string | null = null;
            const opened = openWithAnyHeldProject(msg.projectId, listHeldProjectIds(), (pid) => {
              for (const aad of contentAadChain(pid)) {
                const v = decryptForProject(content, pid, aad);
                if (v !== null) { openedAad = aad; return v; }
              }
              return null;
            });
            if (opened === null) { dropMissingKey(); return; }
            if (opened.pid !== msg.projectId || openedAad !== contentAadChain(msg.projectId)[0]) {
              sealPid = opened.pid;
              log("warn", `agent:send to ${msg.agentId} aberto por fallback pid=${opened.pid} aad=${openedAad} (linha=${msg.projectId ?? "-"})`);
            }
            content = opened.value;
          }
          if (msg.systemPrefix) content = msg.systemPrefix + content;
          if (msg.systemSuffix) content = content + msg.systemSuffix;
        }
        // T-594: `{{mem.NAME}}` do prompt de step. Sob E2EE o placeholder mora
        // DENTRO do blob cifrado, então o `replace` que o server faz no tick não
        // casa nada e o subagente recebia o literal. O plaintext só existe aqui,
        // então o server manda o mapa da mission scratch no campo opcional
        // `mem` e a interpolação acontece sobre o conteúdo JÁ montado/decifrado
        // — a MESMA função que o server usa no caminho em claro. Sem `mem`
        // (server antigo) nada muda.
        if (msg.mem) {
          const antes = content;
          content = interpolateMissionMemory(content, msg.mem);
          if (content !== antes) {
            log("info", `agent:send mem: ${Object.keys(msg.mem).length} chave(s) — placeholder resolvido agent=${msg.agentId}`);
          }
        }
        let images = decryptImageAttachments(msg.images, sealPid);
        if (images === null) {
          // Conteúdo e anexos podem ter sido selados com pids diferentes —
          // mesma varredura fail-closed antes de dropar o frame.
          for (const pid of listHeldProjectIds()) {
            if (pid === sealPid) continue;
            const alt = decryptImageAttachments(msg.images, pid);
            if (alt !== null) { images = alt; log("warn", `agent:send to ${msg.agentId} anexos abertos por fallback pid=${pid}`); break; }
          }
        }
        if (images === null) { dropMissingKey(); return; }
        if (msg.telegram !== undefined) this.host.setTelegramMirror(msg.agentId, msg.telegram);
        // T-233: proveniência de task ativa — SOMENTE pelo sinal autoritativo
        // do server (taskId explícito em agent:send task-linked). Nunca parse
        // de texto. Campo opcional: daemons/servers antigos não enviam.
        if (typeof msg.taskId === "string" && msg.taskId.trim()) {
          this.host.setActiveTask(msg.agentId, msg.taskId);
        }
        this.host.send_message(msg.agentId, content, images, msg.deliveryId);
        // T-252: visto só agora — decrypt ok + processamento aceito
        // (entregue ao runner ou enfileirado pelo host). Falhas de decrypt
        // acima retornam sem marcar, deixando o retry do server ser processado.
        this.deliveryDedup.markSeen(msg.deliveryId);
        return;
      }
      case "task:updated": {
        // T-233: task done → limpa a task ativa do agente atribuído (sem
        // staleness de proveniência). Done atrasado de task antiga não apaga
        // reatribuição mais nova (clear só se bate com a ativa).
        const t = (msg as TaskUpdatedEv).task;
        if (t.status === "done" && t.assigneeAgentId) {
          // T-343: reflexão episódica ANTES do clear — o runner exige que a
          // task refletida seja a ativa (best-effort; guards de idle/cooldown
          // dentro do runner).
          this.host.noteTaskDone(t.assigneeAgentId, t.id, t.titleCipher);
          this.host.clearActiveTask(t.assigneeAgentId, t.id);
        }
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
      case "file:operation":
        await this.handleFileOperation(msg.correlationId, msg.op, msg.path, msg.newPath, msg.workspaceRoot);
        return;
      case "file:search":
        await this.handleFileSearch(msg.correlationId, msg.query, msg.workspaceRoot);
        return;
      case "summarize:request":
        await this.handleSummarize(msg);
        return;
      case "transcript:request": {
        // T-360 (quinto ruling) + T-368: sob E2EE o servidor guarda o transcript
        // cifrado e não tem a chave. Os blobs chegam CRUS (sem label, sem corte):
        // o plaintext nasce aqui e morre na resposta — nunca é escrito em disco.
        // O log é só corrId + contagens + razão constante: zero conteúdo no ring.
        const blobs = Array.isArray(msg.blobs) ? msg.blobs : [];
        const res = decryptTranscriptBlobs(blobs, {
          projectId: msg.projectId,
          hasKey: hasProjectKey(msg.projectId),
          decrypt: (blob, pid) => decryptForProject(
            blob, pid, aadV2({ projectId: pid, table: E2EE_TABLE.MESSAGES, field: "content" }),
          ),
        });
        if (!res.ok) {
          log("warn", `transcript:result corrId=${msg.correlationId} ok=false blobs=${blobs.length} cifrados=${res.cipherCount} falha=${res.index} motivo=${res.reason}`);
          this.send({
            type: "transcript:result",
            correlationId: msg.correlationId,
            ok: false,
            error: TRANSCRIPT_DECRYPT_REASONS[res.reason],
          });
          return;
        }
        log("info", `transcript:request blobs=${blobs.length} corrId=${msg.correlationId}`);
        log("info", `transcript:result corrId=${msg.correlationId} ok=true blobs=${blobs.length} cifrados=${res.cipherCount}`);
        this.send({
          type: "transcript:result",
          correlationId: msg.correlationId,
          ok: true,
          lines: res.lines,
        });
        return;
      }
      case "daemon:logs:get": {
        // Visor de debug da UI: as últimas linhas do ring (pós-scrub).
        const m = msg as { correlationId?: string; limit?: number };
        this.send({
          type: "daemon:logs:result",
          correlationId: m.correlationId,
          lines: recentLogs(m.limit ?? 300),
        });
        return;
      }
      case "project:e2ee_required": {
        setE2eeRequired(msg.projectId, !!msg.value);
        log("info", `e2eeRequired=${!!msg.value} project=${msg.projectId}`);
        return;
      }
      case "project_key:for_daemon": {
        // keyRing opcional (T-007): cadeia project_key_ring mais-antiga→mais-nova.
        const ring = Array.isArray(msg.keyRing) ? msg.keyRing : undefined;
        const ok = rememberProjectKey(msg.projectId, msg.wrappedProjectKey, ring);
        if (!ok) {
          log("warn", `E2EE project key wrap rejeitado para ${msg.projectId} (RSA unwrap falhou)`);
          return;
        }
        const nRing = ring?.length ?? 0;
        log(
          "info",
          `received E2EE project key for ${msg.projectId}` +
            (nRing > 0 ? ` (keyRing: ${nRing} entrada(s))` : ""),
        );
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
      case "workspace:create": {
        const r = await createTaskWorktree({
          workspaceRoot: String(msg.workspaceRoot ?? ""),
          taskId: String(msg.taskId ?? ""),
          agentId: String(msg.agentId ?? ""),
        }, this.dropTo);
        this.send({
          type: "workspace:task_result",
          correlationId: msg.correlationId,
          op: "create",
          taskId: msg.taskId,
          ok: r.ok,
          path: r.path,
          branch: r.branch,
          error: r.ok ? undefined : r.error,
          pendingCommits: r.ok ? undefined : r.pendingCommits,
        });
        return;
      }
      case "workspace:remove": {
        const r = await removeTaskWorktree({
          workspaceRoot: String(msg.workspaceRoot ?? ""),
          path: String(msg.path ?? ""),
          branch: String(msg.branch ?? ""),
          force: !!msg.force,
        }, this.dropTo);
        this.send({
          type: "workspace:task_result",
          correlationId: msg.correlationId,
          op: "remove",
          taskId: msg.taskId,
          ok: r.ok,
          path: r.path,
          branch: r.branch,
          error: r.ok ? undefined : r.error,
          pendingCommits: r.ok ? undefined : r.pendingCommits,
        });
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
        // Commit sem pathspec respeita exatamente o índice. Com paths, o Git
        // pode usar o conteúdo atual do working tree e furar a expectativa de
        // que somente o que aparece em "Em stage" será enviado.
        await this.handleGitOp(msg.correlationId, "commit", ["commit", "-m", msg.message]);
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
      case "open_design:list":
      case "open_design:files":
      case "open_design:file":
      case "open_design:create_project":
      case "open_design:delete_project":
      case "open_design:write":
      case "open_design:delete_file":
      case "open_design:start_run":
      case "open_design:run":
      case "open_design:cancel_run":
      case "open_design:search":
      case "open_design:artifact":
      case "open_design:skills":
      case "open_design:plugins":
      case "open_design:agents":
      case "open_design:duplicate":
      case "open_design:copy_design_system":
      case "open_design:versions":
      case "open_design:restore_version":
      case "open_design:steer":
        await this.handleOpenDesign(msg);
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
    const { scanSkills, skillToScanPayload } = await import("./skills-scanner.js");
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
      skills: result.skills.map(skillToScanPayload),
      scannedSources: result.scannedSources,
      ts: Date.now(),
    });
    log("info", `skills scan: ${result.skills.length} (sources: ${result.scannedSources.length})`);
  }

  /** MCP server discovery — Phase 1 (read-only). Scans claude/codex/opencode/
   *  gemini configs + workspace + ~/.config/the-dudes overrides.
   *  T-308: fontes inválidas viram warning explícito no payload (path+motivo,
   *  sem env/headers) e no log do daemon — configuração corrompida não pode
   *  sumir com MCP da Integração em silêncio. */
  private async reportMCPsScan(workspaceRoot?: string) {
    const { scanMCPs, mcpToScanPayload } = await import("./mcps-scanner.js");
    const result = await scanMCPs({ workspaceRoot });
    this.send({
      type: "mcps:scan",
      mcps: result.mcps.map(mcpToScanPayload),
      scannedSources: result.scannedSources,
      ...(result.warnings.length ? { warnings: result.warnings } : {}),
      ts: Date.now(),
    });
    log("info", `mcps scan: ${result.mcps.length} (sources: ${result.scannedSources.length})`);
    for (const w of result.warnings) log("warn", `[mcps-scanner] ${w.path}: ${w.reason}`);
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
          headers: msg.headers ?? { "PRIVATE-TOKEN": msg.token, "Content-Type": "application/json" },
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
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      send({ ok: res.ok, status: res.status, statusText: res.statusText, text, headers });
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
    if (msg.projectId && isE2eeRequired(msg.projectId) && !hasProjectKey(msg.projectId)) {
      this.send({ type: "summarize:result", correlationId: msg.correlationId, ok: false, error: "e2ee-required: sem chave do projeto" });
      return;
    }
    let plainText = msg.text;
    if (msg.projectId && isE2eEncrypted(plainText)) {
      const dec = decryptForProject(
        plainText,
        msg.projectId,
        aadV2({ projectId: msg.projectId, table: E2EE_TABLE.SUMMARIZE, field: "text" }),
      );
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
        const enc = encryptForProject(
          outSummary,
          msg.projectId,
          aadV2({ projectId: msg.projectId, table: E2EE_TABLE.SUMMARIES, field: "summary" }),
        );
        if (enc) outSummary = enc;
        else if (isE2eeRequired(msg.projectId)) {
          this.send({
            type: "summarize:result",
            correlationId: msg.correlationId,
            ok: false,
            error: "e2ee-required: sem chave do projeto",
          });
          return;
        }
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
    // modo semântico (docs/.md/.yaml via LLM).
    // - claude-cli: nativo no graphify
    // - *-cli (opencode/codex/gemini/crush/grok): shim loopback via ollama backend
    // - API (gemini/openai/claude/deepseek/kimi/ollama): key do vault
    const claude = this.cliCommands.claude;
    const backend = msg.backend || "claude-cli";
    if (msg.semantic && backend === "claude-cli" && !claude?.available) {
      this.send({ type: "graph:status", projectId: msg.projectId, status: "error", error: "backend claude-cli exige o claude CLI instalado (ou escolha outro backend)", correlationId: msg.correlationId });
      return;
    }
    // Todos os CLIs de agente que o shim cobre (graphify não tem backend nativo
    // pra eles — usamos OLLAMA_BASE_URL → shim OpenAI-compat).
    const SHIM_CLI: Record<string, "opencode" | "codex" | "gemini" | "qwen" | "crush" | "grok"> = {
      "opencode-cli": "opencode",
      "codex-cli": "codex",
      "gemini-cli": "gemini",
      "qwen-cli": "qwen",
      "crush-cli": "crush",
      "grok-cli": "grok",
    };
    const shimCli = SHIM_CLI[backend];
    if (msg.semantic && shimCli && !this.cliCommands[shimCli]?.available) {
      this.send({ type: "graph:status", projectId: msg.projectId, status: "error", error: `backend ${backend} exige o CLI ${shimCli} instalado no daemon`, correlationId: msg.correlationId });
      return;
    }
    // API key: server manda cipher do vault; daemon decifra e injeta no env.
    let apiKey: string | undefined;
    if (msg.semantic && msg.apiKeyEnv && msg.apiKeyCipher && msg.projectId) {
      const dec = isE2eEncrypted(msg.apiKeyCipher) ? decryptForProject(msg.apiKeyCipher, msg.projectId) : msg.apiKeyCipher;
      if (dec) apiKey = dec;
    }
    // Backends de API sem key (exceto ollama local / claude-cli / *-cli) → erro cedo.
    if (msg.semantic && !shimCli && backend !== "claude-cli" && backend !== "ollama" && backend !== "bedrock") {
      const needsKey = ["claude", "anthropic", "gemini", "openai", "deepseek", "kimi", "azure"].includes(backend);
      if (needsKey && !apiKey) {
        const hint = msg.apiKeyEnv || "API_KEY";
        this.send({
          type: "graph:status",
          projectId: msg.projectId,
          status: "error",
          error: `backend ${backend} exige a credencial "${hint}" salva em Credenciais do projeto (ou use um runner *-cli / claude-cli / ollama local)`,
          correlationId: msg.correlationId,
        });
        return;
      }
    }
    const avail = {
      graphifyAvailable: true,
      graphifyMcpAvailable: !!this.cliCommands.graphifyMcp?.available,
    };
    this.send({
      type: "graph:status",
      projectId: msg.projectId,
      status: "building",
      phase: msg.semantic ? "extract" : "update",
      progress: 5,
      correlationId: msg.correlationId,
      ...avail,
    });
    const r = await buildGraph(root, gbin.command, {
      ...(msg.semantic
        ? { semantic: true as const, backend, model: msg.model, claudeCmd: claude?.command, apiKeyEnv: msg.apiKeyEnv, apiKey, cliCommands: this.cliCommands, dropTo: this.dropTo, log }
        : {}),
      onProgress: (p) => {
        this.send({
          type: "graph:status",
          projectId: msg.projectId,
          status: "building",
          phase: p.phase ?? (msg.semantic ? "extract" : "update"),
          progress: p.progress,
          correlationId: msg.correlationId,
          ...avail,
        });
      },
    });
    if (!r.ok) {
      this.send({ type: "graph:status", projectId: msg.projectId, status: "error", error: r.error, correlationId: msg.correlationId, ...avail });
      return;
    }
    const docsPending = needsSemanticUpdate(root);
    const hasSemantic = hasSemanticMarker(root) || msg.semantic === true;
    this.send({
      type: "graph:status",
      projectId: msg.projectId,
      status: "ready",
      nodeCount: r.nodeCount,
      edgeCount: r.edgeCount,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      indexMtime: graphMtime(root),
      stale: docsPending,
      docsPending,
      hasSemantic,
      progress: 100,
      correlationId: msg.correlationId,
      ...avail,
    });
    // Hot-inject MCP graphify em agentes já rodando (configs no disco).
    const mcpBin = this.cliCommands.graphifyMcp;
    if (mcpBin?.available) {
      const n = this.host.refreshGraphifyMcpForAgents(mcpBin.command, graphPath(root));
      if (n > 0) log("info", `[graph] MCP graphify hot-inject em ${n} agente(s)`);
    }
    // Mantém índice fresco após reindex manual (code-only; preserva semantic).
    ensureGraphWatch(root, gbin.command, {
      onStatus: (status, info) => {
        this.send({
          type: "graph:status",
          projectId: msg.projectId,
          status,
          nodeCount: info?.nodeCount,
          edgeCount: info?.edgeCount,
          error: info?.error,
          progress: info?.progress,
          phase: info?.phase,
          indexMtime: info?.indexMtime,
          stale: info?.stale ?? needsSemanticUpdate(root),
          docsPending: needsSemanticUpdate(root),
          hasSemantic: hasSemanticMarker(root),
          ...avail,
        });
      },
      log,
    }, msg.projectId);
  }

  /** graph:fetch — lê o graphify-out/graph.json do workspace pra renderizar o
   *  mapa na UI. Scope-checked; se grande, devolve amostra top-N por grau. */
  private async handleGraphFetch(msg: Extract<FromOrch, { type: "graph:fetch" }>): Promise<void> {
    if (!msg.workspaceRoot) {
      this.send({ type: "graph:data", projectId: msg.projectId, error: "workspace não configurado no projeto", correlationId: msg.correlationId });
      return;
    }
    try {
      const root = expandBasePath(msg.workspaceRoot);
      validateBasePath(root);
      this.enforceWorkspaceScope(root);
      const loaded = loadGraphJsonForUi(root, { maxBytes: 48 * 1024 * 1024, maxNodes: 1200 });
      if (loaded.error) {
        this.send({ type: "graph:data", projectId: msg.projectId, error: loaded.error, correlationId: msg.correlationId });
        return;
      }
      this.send({
        type: "graph:data",
        projectId: msg.projectId,
        json: loaded.json,
        correlationId: msg.correlationId,
      });
      if (loaded.truncated) {
        log("info", `[graph] fetch amostrado: top ${1200} de ${loaded.totalNodes ?? "?"} nós`);
      }
    } catch (e) {
      this.send({ type: "graph:data", projectId: msg.projectId, error: (e as Error).message, correlationId: msg.correlationId });
    }
  }

  /** Aba Open Design: HTTP só no daemon local. Erro curto no mesmo correlationId. */
  private async handleOpenDesign(msg: Extract<FromOrch, { type: `open_design:${string}` }>): Promise<void> {
    const kind = kindOpenDesign(msg.type);
    try {
      if (msg.type === "open_design:list") {
        this.send({ type: "open_design:result", correlationId: msg.correlationId, kind: "projects", projects: await listarProjetosOd() });
        return;
      }
      if (msg.type === "open_design:files") {
        this.send({ type: "open_design:result", correlationId: msg.correlationId, kind: "files", odProjectId: msg.odProjectId, files: await listarArquivosOd(msg.odProjectId) });
        return;
      }
      if (msg.type === "open_design:file") {
        this.send({ type: "open_design:result", correlationId: msg.correlationId, kind: "file", odProjectId: msg.odProjectId, path: msg.path, content: await lerArquivoOd(msg.odProjectId, msg.path) });
        return;
      }
      if (msg.type === "open_design:create_project") {
        const criado = await criarProjetoOd(msg.name);
        this.send({ type: "open_design:result", correlationId: msg.correlationId, kind: "projects", projects: await listarProjetosOd(), text: criado.id });
        return;
      }
      if (msg.type === "open_design:delete_project") {
        await apagarProjetoOd(msg.odProjectId);
        this.send({ type: "open_design:result", correlationId: msg.correlationId, kind: "projects", projects: await listarProjetosOd(), text: "apagado" });
        return;
      }
      if (msg.type === "open_design:write") {
        await gravarArquivoOd(msg.odProjectId, msg.path, msg.content);
        this.send({ type: "open_design:result", correlationId: msg.correlationId, kind: "files", odProjectId: msg.odProjectId, files: await listarArquivosOd(msg.odProjectId), path: msg.path, text: "gravado" });
        return;
      }
      if (msg.type === "open_design:delete_file") {
        await apagarArquivoOd(msg.odProjectId, msg.path);
        this.send({ type: "open_design:result", correlationId: msg.correlationId, kind: "files", odProjectId: msg.odProjectId, files: await listarArquivosOd(msg.odProjectId), text: "apagado" });
        return;
      }
      if (msg.type === "open_design:start_run") {
        const run = await iniciarRunOd(msg.odProjectId, msg.prompt, msg.skillId);
        this.send({ type: "open_design:result", correlationId: msg.correlationId, kind: "run", runId: run.runId, status: run.status });
        return;
      }
      if (msg.type === "open_design:run") {
        const run = await lerRunOd(msg.runId);
        this.send({ type: "open_design:result", correlationId: msg.correlationId, kind: "run", runId: run.runId, status: run.status, previewUrl: run.previewUrl, message: run.message });
        return;
      }
      if (msg.type === "open_design:cancel_run") {
        await cancelarRunOd(msg.runId);
        this.send({ type: "open_design:result", correlationId: msg.correlationId, kind: "run", runId: msg.runId, status: "canceled" });
        return;
      }
      if (msg.type === "open_design:search") {
        this.send({
          type: "open_design:result",
          correlationId: msg.correlationId,
          kind: "search",
          odProjectId: msg.odProjectId,
          query: msg.query,
          hits: await buscarArquivosOd(msg.odProjectId, msg.query),
        });
        return;
      }
      if (msg.type === "open_design:artifact") {
        this.send({
          type: "open_design:result",
          correlationId: msg.correlationId,
          kind: "artifact",
          odProjectId: msg.odProjectId,
          path: msg.path,
          content: await lerArtefatoOd(msg.odProjectId, msg.path),
        });
        return;
      }
      if (msg.type === "open_design:skills") {
        this.send({ type: "open_design:result", correlationId: msg.correlationId, kind: "skills", skills: await listarSkillsCatalogoOd() });
        return;
      }
      if (msg.type === "open_design:plugins") {
        this.send({ type: "open_design:result", correlationId: msg.correlationId, kind: "plugins", plugins: await listarPluginsOd() });
        return;
      }
      if (msg.type === "open_design:agents") {
        this.send({ type: "open_design:result", correlationId: msg.correlationId, kind: "agents", agents: await listarAgentsOd() });
        return;
      }
      if (msg.type === "open_design:duplicate") {
        this.send({ type: "open_design:result", correlationId: msg.correlationId, kind: "projects", projects: await duplicarProjetoOd(msg.odProjectId, msg.name) });
        return;
      }
      if (msg.type === "open_design:copy_design_system") {
        const ds = await copiarDesignSystemOd(msg.odProjectId, msg.name);
        this.send({
          type: "open_design:result",
          correlationId: msg.correlationId,
          kind: "design_system",
          odProjectId: ds.odProjectId,
          designSystem: { id: ds.id, name: ds.name },
        });
        return;
      }
      if (msg.type === "open_design:versions") {
        this.send({
          type: "open_design:result",
          correlationId: msg.correlationId,
          kind: "versions",
          odProjectId: msg.odProjectId,
          path: msg.path,
          versions: await listarVersoesOd(msg.odProjectId, msg.path),
        });
        return;
      }
      if (msg.type === "open_design:restore_version") {
        this.send({
          type: "open_design:result",
          correlationId: msg.correlationId,
          kind: "file",
          odProjectId: msg.odProjectId,
          path: msg.path,
          content: await restaurarVersaoOd(msg.odProjectId, msg.path, msg.versionId),
        });
        return;
      }
      const run = await guiarRunOd(msg.runId, msg.message);
      this.send({
        type: "open_design:result",
        correlationId: msg.correlationId,
        kind: "run",
        runId: run.runId,
        status: run.status,
        previewUrl: run.previewUrl,
        message: run.message,
      });
    } catch (e) {
      const bruto = e instanceof Error ? e.message : "falha";
      this.send({
        type: "open_design:result",
        correlationId: msg.correlationId,
        kind,
        odProjectId: "odProjectId" in msg ? msg.odProjectId : undefined,
        path: "path" in msg ? msg.path : undefined,
        query: "query" in msg ? msg.query : undefined,
        runId: "runId" in msg ? msg.runId : undefined,
        error: bruto.replace(/\s+/g, " ").slice(0, 160),
      });
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
      const imageMimes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
      const mimeType = imageMimes[path.extname(resolved).toLowerCase()];
      if (mimeType && mimeType !== "image/svg+xml") {
        const content = (await fs.promises.readFile(resolved)).toString("base64");
        this.send({ type: "file:read_result", correlationId, path: targetPath, content, encoding: "base64", mimeType });
      } else {
        const content = await fs.promises.readFile(resolved, "utf-8");
        this.send({ type: "file:read_result", correlationId, path: targetPath, content, encoding: "utf8", mimeType });
      }
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

  private async handleFileOperation(
    correlationId: string,
    op: "create_file" | "create_directory" | "rename" | "delete",
    targetPath: string,
    newPath: string | undefined,
    override?: string,
  ) {
    const reply = (ok: boolean, error?: string) => this.send({
      type: "file:operation_result" as const, correlationId, op, path: targetPath, newPath, ok, error,
    });
    if (!override) { reply(false, "workspaceRoot ausente na msg"); return; }
    const root = expandBasePath(override);
    try {
      this.enforceWorkspaceScope(root);
      const resolved = path.resolve(root, targetPath);
      if (!targetPath || targetPath === "." || !isInsideRoot(resolved, root)) { reply(false, "acesso negado"); return; }
      if (op === "create_file") {
        await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
        await fs.promises.writeFile(resolved, "", { encoding: "utf-8", flag: "wx", mode: 0o644 });
      } else if (op === "create_directory") {
        await fs.promises.mkdir(resolved, { recursive: false });
      } else if (op === "rename") {
        if (!newPath) { reply(false, "novo caminho ausente"); return; }
        const next = path.resolve(root, newPath);
        if (!isInsideRoot(next, root)) { reply(false, "acesso negado"); return; }
        try { await fs.promises.access(next); reply(false, "destino já existe"); return; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        await fs.promises.rename(resolved, next);
      } else {
        await fs.promises.rm(resolved, { recursive: true, force: false });
      }
      reply(true);
    } catch (e) {
      reply(false, (e as Error).message);
    }
  }

  private async handleFileSearch(correlationId: string, rawQuery: string, override?: string) {
    const query = rawQuery.trim().toLocaleLowerCase();
    if (!override) { this.send({ type: "file:search_result", correlationId, query: rawQuery, entries: [], error: "workspaceRoot ausente na msg" }); return; }
    const root = expandBasePath(override);
    try {
      this.enforceWorkspaceScope(root);
      const ignored = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", "coverage"]);
      const entries: Array<{ name: string; path: string; isDirectory: boolean }> = [];
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (entries.length >= 300 || depth > 14) return;
        const children = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const child of children) {
          if (entries.length >= 300) return;
          if (child.isSymbolicLink() || (child.isDirectory() && ignored.has(child.name))) continue;
          const absolute = path.join(dir, child.name);
          const relative = path.relative(root, absolute);
          if (relative.toLocaleLowerCase().includes(query)) entries.push({ name: child.name, path: relative, isDirectory: child.isDirectory() });
          if (child.isDirectory()) await walk(absolute, depth + 1);
        }
      };
      if (query) await walk(root, 0);
      this.send({ type: "file:search_result", correlationId, query: rawQuery, entries });
    } catch (e) {
      this.send({ type: "file:search_result", correlationId, query: rawQuery, entries: [], error: (e as Error).message });
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
        this.gitExec(["status", "--porcelain=v1", "--untracked-files=all", "--no-renames"]),
      ]);
      const branch = branchOut.trim() || undefined;
      const files = parseGitPorcelain(statusOut);
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
      const output = await this.gitExec(["diff", "HEAD", "--", targetPath]);
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

  /**
   * Outbound WS. Retorna true se o frame foi entregue ao socket OPEN.
   * Críticas (agent:text/error/hung/exit) que falham entram na fila e
   * são reenviadas no próximo open — senão o CLI termina, busy=false e
   * o user nunca vê a resposta (mudo sem watchdog; hipótese T-009 WAN).
   */
  private outboundQueue = createOutboundQueue(80);
  /** T-037: dedup de agent:send reentregues (pending queue + resume buffer). */
  private deliveryDedup = createDeliveryDeduper(500);
  private static readonly WS_MAX_BUFFERED = 4 * 1024 * 1024;

  private send(obj: FromDaemon): boolean {
    const json = JSON.stringify(obj);
    const ws = this.ws;
    const can = channelCanSend(
      ws
        ? {
            readyState: ws.readyState,
            openState: WebSocket.OPEN,
            bufferedAmount: ws.bufferedAmount,
          }
        : null,
      DaemonClient.WS_MAX_BUFFERED,
    );
    const ok = trySendOutbound({
      msg: obj as { type: string },
      json,
      canSend: can,
      send: (j) => { this.ws!.send(j); },
      queue: this.outboundQueue,
    });
    recordWsOut((obj as { type: string }).type, json.length, ok);
    if (!ok) {
      log(
        "warn",
        `outbound drop type=${(obj as { type: string }).type} ` +
          `(ws=${ws ? ws.readyState : "null"} buffered=${ws?.bufferedAmount ?? 0} ` +
          `queued=${this.outboundQueue.items.length})`,
      );
    }
    return ok;
  }

  private flushOutboundQueue(): void {
    const n = flushOutboundQueue({
      queue: this.outboundQueue,
      canSend: () =>
        channelCanSend(
          this.ws
            ? {
                readyState: this.ws.readyState,
                openState: WebSocket.OPEN,
                bufferedAmount: this.ws.bufferedAmount,
              }
            : null,
          DaemonClient.WS_MAX_BUFFERED,
        ),
      send: (j) => { this.ws!.send(j); },
    });
    if (n > 0) log("info", `outbound flush: ${n} msg(s) reenviada(s) após reconnect`);
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
        this.lastPingSentAt = Date.now();
        ws.ping();
      } catch (e) {
        log("warn", `ws.ping failed: ${(e as Error).message}`);
      }
      // Snapshot de saúde no mesmo compasso do heartbeat: 15s é granular o
      // bastante pra UI e barato o bastante pra nem aparecer no perfil.
      this.sendHealth();
    }, DaemonClient.HEARTBEAT_INTERVAL_MS);
  }
  private selfUpdateTimer: NodeJS.Timeout | null = null;
  /** T-582: detector + reaper de suites de teste penduradas. */
  private suitePark: SuiteParkHandle | null = null;
  /** T-051: GC de ~/.grok/sessions/the-dudes-cli-* (summarizer). */
  private grokSessionCleanup: { stop: () => void } | null = null;

  /** Gate com dedup — push WS + timer horário compartilham o mesmo check. */
  private readonly selfUpdateGate = createSelfUpdateGate({
    enabled: () => process.env.THE_DUDES_SELF_UPDATE !== "0",
    run: () => checkAndApplyUpdate({
      orchBase: this.orchUrl,
      selfPath: process.argv[1] ?? "",
      runningHash: BOOT_BINARY_HASH,
      runningBuildTs: DAEMON_BUILD_TS,
      log,
      underLauncher: process.env.THE_DUDES_LAUNCHER === "1",
      // T-088: idle = turn-gate vazio (main+bg). Agentes spawned sem turno
      // não bloqueiam; turnos/fila sim (restart derruba sessões).
      isIdle: () => {
        const t = turnGateStats();
        // M18 (T-441): claude contínuo não passa pelo turn-gate — o turno
        // dele era invisível pro self-update (restart no meio da sessão).
        return t.ativos === 0 && t.fila === 0 && t.bg.ativos === 0 && t.bg.fila === 0
          && !this.host.hasActiveTurn();
      },
      // T-100: idle-restart mata CLIs (detached:true) ANTES do exit 42.
      prepareReexec: () => this.prepareReexec({ keepRunning: true }),
      // T-720: pendente sem idle natural → dreno (sem turno novo; mensagens
      // retidas para o spool cifrado do re-exec).
      startDrain: () => { this.host.startDrain(); },
      drainHolders: () => this.drainHoldersAgora(),
    }),
    log: (level, msg) => log(level, msg),
  });

  /**
   * Self-update assinado: 2min após conectar (não no boot — deixa o canal
   * estabilizar) e depois a cada hora (fallback se o push WS falhar/atrasar).
   * Opt-out: THE_DUDES_SELF_UPDATE=0. Só troca binário com assinatura Ed25519
   * válida; ver self-update.ts. T-033: release:available também chama o gate.
   */
  private scheduleSelfUpdate() {
    if (process.env.THE_DUDES_SELF_UPDATE === "0") return;
    if (this.selfUpdateTimer) return;
    const rodar = () => { void this.selfUpdateGate.trigger("interval-1h"); };
    const primeira = setTimeout(() => { void this.selfUpdateGate.trigger("initial-2min"); }, 2 * 60_000);
    primeira.unref?.();
    this.selfUpdateTimer = setInterval(rodar, 60 * 60_000);
    this.selfUpdateTimer.unref?.();
  }

  /** T-839: claude em turno (agentId) mais quem segura slot do turn-gate. */
  private drainHoldersAgora() {
    const agora = Date.now();
    const doHost = this.host.drainHolders(agora);
    const vistos = new Set(doHost.map((h) => h.agentId));
    const doGate = turnGateDebug(agora).holders
      .map((h) => ({
        agentId: h.label,
        turnAgeMs: h.heldMs,
        runner: h.label.split(":")[0] || "gate",
        reason: `turn-gate:${h.pool}`,
      }))
      .filter((h) => !vistos.has(h.agentId));
    return [...doHost, ...doGate];
  }

  /** Snapshot de saúde → server → UI. Falha silenciosa se o canal caiu. */
  private sendHealth() {
    try {
      const health = healthSnapshot({
        turnGate: turnGateStats(),
        agentsRunning: this.host.agentCount(),
        e2eeProjects: countUsableProjectKeys(),
      });
      this.send({ type: "daemon:health", health: { ...health, ...runningReleaseInfo(), ...this.peerPidHealthFields() } });
    } catch (e) {
      log("warn", `sendHealth falhou: ${(e as Error).message}`);
    }
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  /**
   * #592: o estado do peer-pid sai no health porque hoje ele só existe no log
   * da máquina — um daemon de campo com THE_DUDES_PEER_PID_INSECURE=1 cai para
   * não-enforced sem ninguém ver. O valor vem da DECISÃO do relay (lida no
   * start), não do ambiente: `relay` null = o relay ainda não subiu, e aí o
   * estado é `pending`, não "fail-closed".
   */
  private peerPidHealthFields(): { peerPidEnforced: boolean | null; peerPidMode: PeerPidMode } {
    const st = this.relay?.peerPidState() ?? { enforced: null, mode: "pending" as const };
    return { peerPidEnforced: st.enforced, peerPidMode: st.mode };
  }

  private shuttingDown = false;

  /** T-100: só os filhos/CLIs — NÃO process.exit. O caller decide 0 vs 42. */
  /** T-710b: keepRunning=true: os CLIs morrem, mas os agentes seguem running
   *  no server e o hello do processo novo os religa (replay; passada a graça
   *  de 90s do server, auto-resume).
   *  T-824: o shutdown por sinal (SIGTERM/SIGINT) também mantém — reinício
   *  manual, bootout/reinstalação do LaunchAgent, logout/reboot. Antes ele
   *  anunciava exit de cada agente e o server os deixava parados até alguém
   *  dar Start (23/09: o time inteiro do alertai parou num reinício manual).
   *  Parar agente de propósito continua sendo pela UI (agent:stop). */
  private async prepareReexec(opts: { keepRunning?: boolean; porSinal?: boolean } = {}): Promise<void> {
    if (opts.porSinal) log("info", "[shutdown] parando CLIs filhos; os agentes seguem running no server e voltam no próximo hello (T-824)");
    else log("info", "[self-update] parando CLIs filhos antes do re-exec");
    try { stopAllGraphWatches(); } catch { /* noop */ }
    // T-720: no re-exec, retém tudo que chegar daqui em diante (idle natural
    // não passou pelo dreno) e tira o que ainda estiver nas filas.
    if (opts.keepRunning) {
      if (!this.host.isDraining()) this.host.startDrain(opts.porSinal ? "shutdown" : "update");
      else if (opts.porSinal) this.host.setDrainReason("shutdown");
      // T-842 x T-839: vale para os DOIS caminhos de keepRunning. No sinal o
      // shutdown já chamou isto com o WS aberto (2ª chamada é idempotente); no
      // teto do dreno do self-update é AQUI que o turno aberto entra no spool —
      // sem isto o teto do #839 cortaria o turno e a mensagem em voo sumiria.
      this.host.holdInFlightForShutdown();
    }
    // Revisão T-824: no sinal o WS já fechou (nada novo chega). Grava spool e
    // ids vistos ANTES de matar os CLIs: um daemon novo que suba em paralelo
    // (bootout+bootstrap, Ctrl-C+rerun) já acha os arquivos no boot.
    if (opts.keepRunning && opts.porSinal) {
      this.gravarSpoolEVistos("[shutdown]");
    }
    const n = await this.host.shutdown({ reexec: !!opts.keepRunning });
    if (opts.keepRunning && opts.porSinal) log("info", `[shutdown] ${n} agent(s) mantidos running`);
    else if (opts.keepRunning) log("info", `[self-update] reexec: ${n} agent(s) mantidos running`);
    // Re-exec do update: o WS segue aberto até aqui — grava depois do
    // shutdown, menor janela para mensagem chegar e ficar de fora.
    if (opts.keepRunning && !opts.porSinal) this.gravarSpoolEVistos("[self-update]");
    // terminateWithEscalation agenda SIGKILL em ~1.5s; espera o timer.
    await new Promise((r) => setTimeout(r, 2_500));
  }

  /** Revisão T-824 / T-842: spool primeiro; vistos só se o spool foi gravado. */
  private gravarSpoolEVistos(tag: string): void {
    commitReexecSnapshot({
      tag,
      writeSpool: () => this.host.writeReexecSpool(),
      saveSeen: () => saveDeliverySeen(profileHome(), this.deliveryDedup.snapshot()),
      log: (level, msg) => log(level, msg),
    });
  }

  private async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    log("info", "shutting down");
    this.stopped = true;
    // try/finally: shutdown virou async, então um throw em host.shutdown()/
    // relay.stop()/forgetAllProjectKeys() viraria unhandled rejection e pularia
    // o process.exit(0). O finally garante que o daemon sempre encerra.
    try {
      // T-824: sinal = o daemon vai embora, não os agentes (ver prepareReexec),
      // salvo "parar de vez" pedido pelo uninstall (marcador no perfil).
      const marcador = path.join(profileHome(), STOP_AGENTS_MARKER);
      const pararDeVez = fs.existsSync(marcador);
      if (pararDeVez) {
        try { fs.rmSync(marcador, { force: true }); } catch { /* noop */ }
        log("info", "[shutdown] parada definitiva pedida (uninstall) — anunciando exit dos agentes");
        await this.prepareReexec();
      } else {
        // T-842: o aviso de reinício e o flush saem com o WS ainda OPEN.
        // O close continua ANTES do spool e dos CLIs (filtro de tokenId
        // do server): prepareReexec grava o snapshot e só então mata os filhos.
        this.host.startDrain("shutdown");
        this.host.holdInFlightForShutdown();
        this.host.announceRestart();
        this.flushOutboundQueue();
        this.stopPing();
        this.stopHeartbeat();
        try { this.ws?.close(1000, "shutdown"); } catch { /* noop */ }
        await this.prepareReexec({ keepRunning: true, porSinal: true });
      }
      if (this.relay) this.relay.stop();
      this.stopPing();
      this.stopHeartbeat();
      try { this.debugDashboard?.stop(); } catch { /* noop */ }
      this.debugDashboard = null;
      try { this.grokSessionCleanup?.stop(); } catch { /* noop */ }
      this.grokSessionCleanup = null;
      try { this.suitePark?.stop(); } catch { /* noop */ }
      this.suitePark = null;
      forgetAllProjectKeys();
      try { this.ws?.close(1000, "shutdown"); } catch {}
      // Remove o marker de liveness pra não bloquear o sweep do próximo boot.
      try { fs.rmSync(path.join(os.tmpdir(), "the-dudes", `.daemon-${process.pid}.alive`), { force: true }); } catch {}
    } finally {
      process.exit(0);
    }
  }
}

/** T-824: o uninstall cria este arquivo no perfil antes do bootout: o SIGTERM
 *  seguinte usa o shutdown que anuncia exit (agentes param de verdade). */
const STOP_AGENTS_MARKER = "stop-agents-on-exit";

/** PID vivo? kill(pid,0) não envia sinal — só testa existência. EPERM = existe
 *  mas não é nosso (ainda vivo); ESRCH = morto. */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
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
  const safe = scrubLog(msg);
  const lines = safe.split(/\r?\n/);
  // T-812: o dashboard de debug recebe o log mesmo no modo -vh (que silencia o stdout).
  for (const line of lines) recordDebugLog(level, line);
  if (args.verboseHumanIo) return;
  const ts = new Date().toISOString();
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  for (const line of lines) {
    stream.write(`[${ts}] [${level}] ${line}\n`);
    // Ring de debug da UI — sempre DEPOIS do scrub, nunca o texto cru.
    recordLog(level, line);
  }
}

/** T-812: console.* de módulos que não passam pelo log() central (relay,
 *  privileges, sentry) também chega ao dashboard — texto passa pelo scrub e a
 *  saída original fica intocada. */
function captureConsoleForDebug(): void {
  const pares = [["log", "info"], ["info", "info"], ["warn", "warn"], ["error", "error"]] as const;
  for (const [method, level] of pares) {
    const orig = console[method].bind(console);
    console[method] = (...a: unknown[]) => {
      orig(...a);
      try { recordDebugLog(level, scrubLog(formatArgs(...a)), "console"); } catch { /* observação */ }
    };
  }
}

function cliLog(level: "info" | "warn" | "error", msg: string) {
  if (!args.verbose && !args.verboseHuman && !args.verboseHumanIo) return;
  try { recordDebugLog(level, scrubLog(msg), "cli"); } catch { /* observação */ }
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

/**
 * T-252: seam de teste. THE_DUDES_DAEMON_TEST=1 (só em teste) pula parseCli +
 * bootstrap: no `node --test` o argv carrega paths posicionais que fariam
 * parseCli throw (allowPositionals:false) e o start() abriria conexões reais.
 * Em produção a variável nunca é definida (nem no launcher, nem no LaunchAgent,
 * nem no self-update — todos executam o bundle sem ela) → comportamento
 * 100% idêntico ao de antes.
 */
const SELF_BOOTSTRAP = process.env.THE_DUDES_DAEMON_TEST !== "1";

/**
 * T-582: modo diagnóstico — `--list-suites` (lista) / `--reap-suites`
 * (lista e mata). Roda e sai ANTES do parseCli, que exige --orch/--token e
 * que não tem a ver com um comando de inspeção do host. `fs.writeSync(1, …)`
 * porque `process.exit` truncaria um stdout em pipe.
 */
if (SELF_BOOTSTRAP) {
  const park = suiteParkCliArgs(process.argv.slice(2));
  if (park) {
    process.exit(runSuiteParkCli(park, { out: (s) => { fs.writeSync(1, s); }, ps: runPs }));
  }
}

const args: Args = SELF_BOOTSTRAP
  ? parseCli()
  : {
      orch: "ws://127.0.0.1:1",
      token: "test",
      name: "t252-test",
      pingMs: 30_000,
      verbose: false,
      verboseHuman: false,
      verboseHumanIo: true,
      cliConfigPath: `/tmp/t252-nonexistent-${process.pid}.json`,
      cliPaths: {},
    };
// T-812: sondas do dashboard de debug ANTES do resto do boot (o resolve dos
// CLIs logo abaixo já faz spawnSync). Só no processo real, nunca em teste.
if (SELF_BOOTSTRAP && process.env.THE_DUDES_DEBUG_HTTP !== "0") {
  installSyncProbes();
  startLoopMonitor();
  setDebugScrubber(scrubLog);
  captureConsoleForDebug();
}
const cliConfig = mergeCliConfig(
  loadDaemonCliConfig(args.cliConfigPath),
  { cliPaths: args.cliPaths },
);
const cliCommands = resolveCliCommands(cliConfig);
if (SELF_BOOTSTRAP) {
  new DaemonClient(args, cliCommands).start().catch(async (e) => {
    capture(e, { phase: "startup" });
    log("error", `failed to start: ${(e as Error).message}`);
    await flushSentry();
    process.exit(1);
  });
}
