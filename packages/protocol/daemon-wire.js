import { z } from "zod";
import { RUNNERS } from "./index.js";

/**
 * T-423 (A6/R3): schemas zod das mensagens daemon → server (`FromDaemon`).
 *
 * O handler do /ws/daemon recebia `msg: any` — um daemon comprometido podia
 * mandar campo de tipo errado e só falhar dentro do handler. Aqui o contrato
 * é validado na fronteira, fail-closed (`validateDaemonMessage`).
 *
 * Regra de shape: campos declarados nos tipos de `daemon-wire.d.ts`; objeto
 * aninhado de scanner (skill/mcp/modelo) usa `.passthrough()` para tolerar
 * campo novo do daemon sem derrubar a mensagem. Não-validação de semântica
 * (ranges, limites) fica com os handlers, como antes.
 */

const t = z.string();
const n = z.number();
const b = z.boolean();
const id = z.string();
const queueSenderId = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/);
const queueSenderName = z.string().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/);
const queueSender = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), id: queueSenderId, name: queueSenderName.optional() }).strict(),
  z.object({ type: z.literal("agent"), id: queueSenderId }).strict(),
]);
const requireOwnerStatusForNamedSender = (from, isAgentOwner, ctx) => {
  if (from?.type === "user" && from.name !== undefined && typeof isAgentOwner !== "boolean") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["isAgentOwner"],
      message: "named user provenance requires server-derived owner status",
    });
  }
};

const cliRunner = z.enum(RUNNERS);
const effortLevel = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const opaqueConfigAlias = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const runnerHealthStatus = z.object({
  installed: b,
  version: z.string().min(1).max(128).optional(),
  binary: z.string().min(1).max(1024).optional(),
  claudeConfigDir: z.object({
    alias: opaqueConfigAlias.optional(),
    source: z.enum(["env", "agent", "default", "native"]),
  }).strict().optional(),
}).strict();
const configAliasOption = z.object({ alias: opaqueConfigAlias, label: z.string().min(1).max(80) }).strict();
const runnerDefaultSetValue = z.object({
  model: z.string().min(1).max(128).optional(),
  effort: effortLevel.optional(),
  claudeConfigDir: opaqueConfigAlias.optional(),
  qwenHome: opaqueConfigAlias.optional(),
}).strict();
const fileEntry = z.object({ name: t, path: t, isDirectory: b, size: n.optional() });
const gitCommit = z.object({ hash: t, message: t, author: t, date: t });
const gitFileStatus = z.object({ path: t, status: t });
const gitBranch = z.object({ name: t, current: b });
const gitStashEntry = z.object({ index: n, message: t, branch: t });
const skillDef = z
  .object({ name: t, source: t, path: t, contentHash: t, body: t, frontmatter: z.object({ name: t, description: t }).passthrough() })
  .passthrough();
const mcpDef = z.object({ name: t, source: t, configPath: t }).passthrough();
const discoveredModel = z.object({ id: t, label: t }).passthrough();
const runnerCatalog = z.object({
  runner: t,
  models: z.array(discoveredModel),
  source: z.enum(["codex-app-server", "cli-command", "unsupported"]),
  fetchedAt: n,
  error: t.optional(),
});

const msg = (type, shape = {}) => z.object({ type: z.literal(type), ...shape });

/**
 * T-1006: tetos do snapshot da fila AO VIVO (`agent:queue_live`). Os dois
 * lados importam daqui: o daemon corta os itens mais NOVOS para caber (e manda
 * `truncated: true`); o server recusa o que passar (fail-closed). O snapshot
 * entra no estado do agente que vai para todo cliente do projeto, por isso o
 * teto de bytes é bem abaixo do cap do wire (32 MB).
 */
export const QUEUE_LIVE_MAX_ITEMS = 200;
export const QUEUE_LIVE_MAX_BYTES = 1024 * 1024;

const encoder = new TextEncoder();
/** Bytes que o item ocupa no snapshot: `content` + `images` serializado. */
export function queueLiveItemBytes(item) {
  const content = typeof item?.content === "string" ? item.content : "";
  const images = item?.images === undefined ? "" : JSON.stringify(item.images);
  return encoder.encode(content).length + encoder.encode(images).length;
}

const queueLiveItem = z.object({
  deliveryId: t.min(1).max(120),
  content: t,
  images: z.array(z.unknown()).optional(),
  enqueuedAt: n,
  origin: z.enum(["user", "agent", "system"]),
  silent: b.optional(),
});
const queueLiveItems = z.array(queueLiveItem).max(QUEUE_LIVE_MAX_ITEMS).superRefine((items, ctx) => {
  let total = 0;
  for (const item of items) total += queueLiveItemBytes(item);
  if (total > QUEUE_LIVE_MAX_BYTES) {
    ctx.addIssue({ code: "custom", message: `snapshot da fila ao vivo acima de ${QUEUE_LIVE_MAX_BYTES} bytes (${total})` });
  }
});

/** type → schema. Chave é o `msg.type` exato do FromDaemon (daemon-wire.d.ts). */
export const daemonWireSchemas = {
  "daemon:hello": msg("daemon:hello", {
    name: t,
    os: t,
    hostname: t,
    version: t,
    daemonId: z.string().uuid().optional(),
    configDirAliases: z.object({
      claude: z.array(configAliasOption).max(32).optional(),
      qwen: z.array(configAliasOption).max(32).optional(),
    }).strict().optional(),
    protocolVersion: n.optional(),
    passive: b.optional(),
    capabilities: z.array(z.string().min(1).max(80)).max(32)
      .refine((items) => new Set(items).size === items.length, "duplicate capabilities are not allowed")
      .optional(),
    cryptoPublicKey: t.optional(),
    binaryHash: t.optional(),
    buildTs: n.optional(),
    updatePending: b.optional(),
    updatePendingSince: n.nullable().optional(),
    updateDraining: b.optional(),
    resumeFromSeq: n.optional(),
    availableRunners: z.array(t).optional(),
    graphify: z.object({ cli: b, mcp: b }).optional(),
    installedRunners: z.array(t).optional(),
  }).strict(),
  "daemon:health": msg("daemon:health", {
    health: z.object({
      ts: n,
      uptimeS: n,
      memRssMb: n,
      wsRttMs: n.nullable(),
      turnGate: z.object({ active: n, queued: n, max: n }),
      // T-662: hardRecoversNotified opcional — daemon antigo não envia; o web
      // cai no contador cru nesse caso (fallback).
      turns: z.object({ started: n, ok: n, failed: n, hardRecovers: n, hardRecoversNotified: n.optional(), hangs: n }),
      turnP50Ms: n.nullable(),
      turnP95Ms: n.nullable(),
      byRunner: z.record(z.object({ started: n, ok: n, failed: n, hardRecovers: n, hardRecoversNotified: n.optional(), hangs: n })),
      agentsRunning: n,
      e2eeProjects: n,
      binaryHash: t.optional(),
      buildTs: n.optional(),
      updatePending: b.optional(),
      // Report somente de leitura para exibição na aba Runners.
      runnerStatus: z.partialRecord(cliRunner, runnerHealthStatus).optional(),
    }),
  }),
  "daemon:logs:result": msg("daemon:logs:result", {
    correlationId: t.optional(),
    lines: z.array(z.object({ ts: n, level: z.enum(["info", "warn", "error"]), msg: t })),
  }),
  "daemon:ping": msg("daemon:ping", { ts: n }),
  "daemon:challenge_response": msg("daemon:challenge_response", { signature: t }),

  "gitlab:request_result": msg("gitlab:request_result", {
    correlationId: t,
    ok: b,
    status: n,
    statusText: t.optional(),
    text: t.optional(),
    error: t.optional(),
  }),

  "agent:state": msg("agent:state", { agentId: id, state: t }),
  "agent:running": msg("agent:running", { agentId: id, running: b }),
  "agent:session": msg("agent:session", { agentId: id, sessionId: t }),
  "agent:token_resync": msg("agent:token_resync", { agentId: id, token: t }),
  "agent:usage_delta": msg("agent:usage_delta", {
    agentId: id,
    delta: z.object({ input: n, output: n, cacheCreate: n, cacheRead: n }),
  }),
  "agent:text": msg("agent:text", { agentId: id, text: t }),
  "agent:tool_use": msg("agent:tool_use", { agentId: id, toolName: t, input: z.unknown() }),
  "agent:thinking": msg("agent:thinking", { agentId: id, text: t, redacted: b }),
  "agent:error": msg("agent:error", {
    agentId: id,
    message: t,
    errorKind: z.enum(["rate_limit", "other"]).optional(),
    migrationId: t.optional(),
  }),
  "agent:hung": msg("agent:hung", { agentId: id, soft: b, reason: t, idleMs: n, runner: t.optional(), parked: b.optional() }),
  "agent:exit": msg("agent:exit", { agentId: id, code: n.nullable() }),
  "agent:context": msg("agent:context", { agentId: id, used: n, limit: n }),
  "agent:context_warning": msg("agent:context_warning", { agentId: id, used: n, limit: n }),
  "agent:context_full": msg("agent:context_full", { agentId: id }),

  "workspace:result": msg("workspace:result", {
    projectId: t,
    basePath: t,
    clones: z.array(z.object({ repoName: t, ok: b, message: t })),
  }),
  "workspace:task_result": msg("workspace:task_result", {
    correlationId: t,
    op: z.enum(["create", "remove"]),
    taskId: t.optional(),
    ok: b,
    path: t.optional(),
    branch: t.optional(),
    error: t.optional(),
    pendingCommits: z.array(t).optional(),
  }),

  "file:list_result": msg("file:list_result", { correlationId: t, path: t, entries: z.array(fileEntry), error: t.optional() }),
  "file:read_result": msg("file:read_result", {
    correlationId: t,
    path: t,
    content: t.optional(),
    encoding: z.enum(["utf8", "base64"]).optional(),
    mimeType: t.optional(),
    error: t.optional(),
  }),
  "file:write_result": msg("file:write_result", { correlationId: t, path: t, ok: b, error: t.optional() }),
  "file:operation_result": msg("file:operation_result", {
    correlationId: t,
    op: z.enum(["create_file", "create_directory", "rename", "delete"]),
    path: t,
    newPath: t.optional(),
    ok: b,
    error: t.optional(),
  }),
  "file:search_result": msg("file:search_result", { correlationId: t, query: t, entries: z.array(fileEntry), error: t.optional() }),

  "git:log_result": msg("git:log_result", { correlationId: t, commits: z.array(gitCommit), error: t.optional() }),
  "git:status_result": msg("git:status_result", { correlationId: t, files: z.array(gitFileStatus), branch: t.optional(), error: t.optional() }),
  "git:diff_result": msg("git:diff_result", { correlationId: t, path: t, diff: t.optional(), error: t.optional() }),
  "git:result": msg("git:result", {
    correlationId: t,
    op: t,
    ok: b,
    message: t.optional(),
    output: t.optional(),
    error: t.optional(),
    commits: z.array(gitCommit).optional(),
    files: z.array(gitFileStatus).optional(),
    diff: t.optional(),
    branches: z.array(gitBranch).optional(),
    stashes: z.array(gitStashEntry).optional(),
  }),

  "summarize:result": msg("summarize:result", {
    correlationId: t,
    ok: b,
    summary: t.optional(),
    error: t.optional(),
    usage: z.object({ input: n, output: n }).optional(),
  }),
  "transcript:result": msg("transcript:result", { correlationId: t, ok: b, lines: z.array(t).optional(), error: t.optional() }),
  "webhook:delivery_result": msg("webhook:delivery_result", {
    deliveryId: t,
    eventType: t,
    status: n.nullable(),
    body: t,
    error: t.optional(),
  }),

  "skills:scan": msg("skills:scan", { skills: z.array(skillDef), scannedSources: z.array(t), ts: n }),
  "skill:read_file_result": msg("skill:read_file_result", { correlationId: t, ok: b, content: t.optional(), error: t.optional() }),
  "skill:save_file_result": msg("skill:save_file_result", { correlationId: t, ok: b, error: t.optional() }),
  "skill:delete_result": msg("skill:delete_result", { correlationId: t, ok: b, error: t.optional() }),

  "mcps:scan": msg("mcps:scan", {
    mcps: z.array(mcpDef),
    scannedSources: z.array(t),
    warnings: z.array(z.object({ path: t, reason: t })).optional(),
    ts: n,
  }),
  "mcps:save_result": msg("mcps:save_result", { correlationId: t.optional(), ok: b, error: t.optional() }),
  "mcps:delete_result": msg("mcps:delete_result", { correlationId: t.optional(), ok: b, error: t.optional() }),

  "models:catalog": msg("models:catalog", { correlationId: t, catalogs: z.array(runnerCatalog) }),

  "graph:status": msg("graph:status", {
    projectId: t.optional(),
    status: z.enum(["building", "ready", "error"]),
    nodeCount: n.optional(),
    edgeCount: n.optional(),
    error: t.optional(),
    inputTokens: n.optional(),
    outputTokens: n.optional(),
    progress: n.optional(),
    phase: t.optional(),
    indexMtime: n.optional(),
    stale: b.optional(),
    graphifyAvailable: b.optional(),
    graphifyMcpAvailable: b.optional(),
    docsPending: b.optional(),
    hasSemantic: b.optional(),
    correlationId: t.optional(),
  }),
  "graph:data": msg("graph:data", { projectId: t.optional(), json: t.optional(), error: t.optional(), correlationId: t.optional() }),
  "open_design:result": msg("open_design:result", {
    correlationId: t,
    kind: z.enum(["projects", "files", "file", "run", "notice", "search", "artifact", "skills", "plugins", "agents", "versions", "design_system"]),
    projects: z.array(z.object({ id: t, name: t, designSystemId: t.nullable().optional() })).optional(),
    files: z.array(z.object({ path: t, name: t, size: n.optional() })).optional(),
    hits: z.array(z.object({ path: t, name: t, snippet: t.optional() }).passthrough()).optional(),
    skills: z.array(z.object({ id: t, name: t.optional() }).passthrough()).optional(),
    plugins: z.array(z.object({ id: t, name: t.optional() }).passthrough()).optional(),
    agents: z.array(z.object({ id: t, name: t.optional() }).passthrough()).optional(),
    versions: z.array(z.object({ id: t, label: t.optional(), createdAt: t.optional() }).passthrough()).optional(),
    designSystem: z.object({ id: t, name: t }).passthrough().optional(),
    odProjectId: t.optional(),
    path: t.optional(),
    query: t.optional(),
    content: t.optional(),
    runId: t.optional(),
    status: t.optional(),
    previewUrl: t.optional(),
    message: t.optional(),
    text: t.optional(),
    versionId: t.optional(),
    error: t.optional(),
  }),
  // T-898/security A: retenção vinda do daemon (stop/inbound-ttl) — server não
  // decifra, só persiste o que chegou.
  // T-1150 (contrato §1): retenção em QUALQUER caminho de parada. `source` diz
  // de onde veio; `id` preserva a identidade para o `markDelivered` do server e
  // `content` é ciphertext quando o projeto é E2EE (o server não decifra).
  "agent:queue_retain": msg("agent:queue_retain", {
    agentId: t,
    // projectId/source OPCIONAIS: daemon em rollout (pré-#1150) manda sem, e
    // recusar o frame fazia a fila SUMIR — era o bug do dono.
    projectId: t.optional(),
    source: z.enum(["stop", "inbound-ttl", "inbound", "manual", "replace", "context-clear", "loop-stop", "migrate"]).optional(),
    items: z.array(z.object({
      // id/ts OPCIONAIS: daemon em rollout (pré-#1150) manda sem, e o server
      // gera o id da linha e usa o created_at — recusar era o bug da fila.
      id: t.optional(),
      content: t,
      images: z.array(z.unknown()).optional(),
      ts: n.optional(),
      source: t.optional(),
      sender: queueSender.optional(),
    })).max(200),
  }),
  // T-1150 (contrato §3): o daemon confirma SÓ o que aceitou; o resto fica retido.
  // T-1149: o daemon confirma o que ENTREGOU (o resto continua retido).
  "agent:queue_delivered": msg("agent:queue_delivered", {
    agentId: t,
    ids: z.array(t).max(200),
  }),
  // T-1006: snapshot COMPLETO da fila pendente do runner (o que ainda não virou
  // turno). Estado vivo: o server guarda só o último, em memória. `content`
  // vem como o daemon recebeu (blob `e2e:` em projeto cifrado).
  "agent:queue_live": msg("agent:queue_live", {
    agentId: t,
    projectId: t,
    at: n,
    truncated: b.optional(),
    items: queueLiveItems,
  }),
  "typesafe:shadow": msg("typesafe:shadow", {
    projectId: t,
    at: n,
    ok: b,
    error: t.nullable(),
    model: t,
    latencyMs: n,
    declaredTaskType: t,
    declaredComplexity: t,
    taskType: t,
    complexity: t,
    domain: t,
    confidence: z.object({ task_type: n, complexity: n, domain: n }).nullable(),
    destructiveNoul: n.nullable(),
    disagreeTaskType: b,
    disagreeComplexity: b,
    // T-878 (Jev nas tasks): opcionais e aditivos. O daemon antigo (só
    // delegate) segue válido; campo fora do tipo declarado derruba a mensagem
    // no fail-closed, como qualquer outro campo do schema.
    // T-1209: o RUNTIME estava só em task|delegate enquanto o `.d.ts` já
    // declarava as cinco — frame de sombra nova era dropado aqui (fail-closed),
    // antes de chegar no handler. `reflect` entra junto.
    source: z.enum(["task", "delegate", "agent-msg", "tts-summary", "reply-suggest", "reflect"]).optional(),
    taskId: t.optional(),
    /** T-1128: link OPAQUE do que não é task (mensagem/reflexão). O par
     *  veredito↔desfecho é por igualdade de `refId`, sem interpretar o valor. */
    refId: t.optional(),
    event: t.optional(),
    declaredAssignee: t.optional(),
    probabilities: z.object({
      domain: z.record(t, n).optional(),
      complexity: z.record(t, n).optional(),
    }).optional(),
    securityNoul: n.nullable().optional(),
    acceptanceNoul: n.nullable().optional(),
    // Tri-estado: `null` = não comparável (elenco de outro daemon).
    disagreeDomain: b.nullable().optional(),
    textSha256: t.optional(),
    goalSha256: t.optional(),
    hashKind: z.enum(["sha256", "hmac1"]).optional(),
    /** T-1209: "a task trouxe lição reutilizável?" — Noul da sombra `reflect`. */
    hasReusableLessonNoul: n.nullable().optional(),
    /**
     * T-1128/T-1209: desfecho OBSERVADO, sempre em linha própria com o MESMO
     * `refId` e `event: "outcome"`. `acted` = o destinatário agiu (agent-msg,
     * tts-summary); `produced` = a reflexão gerou memória (reflect). Só
     * booleanos — o texto fica no daemon.
     */
    outcome: z.object({
      acted: b.optional(),
      produced: b.optional(),
      tokens: n.nullable().optional(),
      durationMs: n.nullable().optional(),
    }).nullable().optional(),
  }),
};

/**
 * Valida uma mensagem recebida do daemon. Fail-closed: type sem schema é
 * recusado (o dispatcher loga e dropa). Devolve `{ok:true}` ou `{ok:false,error}`.
 */
export function validateDaemonMessage(message) {
  const schema = Object.prototype.hasOwnProperty.call(daemonWireSchemas, message?.type)
    ? daemonWireSchemas[message.type]
    : undefined;
  if (!schema) return { ok: false, error: `mensagem de daemon sem schema: ${message?.type}` };
  const parsed = schema.safeParse(message);
  if (parsed.success) return { ok: true };
  const first = parsed.error.issues[0];
  const campo = first.path.filter((p) => p !== "type").join(".") || "(raiz)";
  return { ok: false, error: `campo inválido em ${message.type}: ${campo} — ${first.message}` };
}

/* ------------------------------------------------------------------ */
/* FromOrch (server → daemon). Não validado em runtime hoje (o daemon  */
/* não tem validate no inbound); o schema é o contrato p/ quando tiver. */
/* ------------------------------------------------------------------ */

const wsRoot = t.optional();
const agentRepo = z.object({ name: t, gitUrl: t, branch: t.optional() });
const repoSummary = z.object({ id: t, name: t, gitUrl: t, defaultBranch: t.optional() });
const agentInfo = z
  .object({
    id: t,
    ownerUserId: t,
    name: t,
    role: t,
    systemPrompt: t,
    color: t,
    state: t,
    running: b,
    usage: z.object({ input: n, output: n, cacheCreate: n, cacheRead: n }),
  })
  .passthrough();
const contextFeatures = z
  .object({
    teammates: b.optional(),
    tasks: b.optional(),
    filelock: b.optional(),
    memory: b.optional(),
    goals: b.optional(),
    credentials: b.optional(),
    webhooks: b.optional(),
    graph: b.optional(),
    board: b.optional(),
    diagramLanguage: z.enum(["mermaid", "d2"]).optional(),
    boardMode: z.enum(["blocks", "html"]).optional(),
    boardHtmlLevel: z.enum(["basic", "normal", "quality"]).optional(),
    jev: b.optional(),
  })
  .passthrough();
const memoryEntry = z.object({ type: t, scope: t, titleCipher: t, bodyCipher: t, source: t.optional() }).passthrough();
const mcpServerConfig = z
  .object({
    type: z.enum(["stdio", "sse", "http"]).optional(),
    command: t.optional(),
    args: z.array(t).optional(),
    env: z.record(t).optional(),
    url: t.optional(),
    headers: z.record(t).optional(),
  })
  .passthrough();
const agentSendPart = z.union([
  z.object({ kind: z.literal("plain"), text: t }),
  z.object({ kind: z.literal("cipher"), text: t, table: t.optional(), field: t.optional() }),
]);
const imageAtt = z.object({ mimeType: t, base64: t, name: t.optional() });

export const fromOrchSchemas = {
  // T-1150 (contrato §3): ordem de ENTREGA vinda do server (modal "carregar").
  "agent:queue_deliver": msg("agent:queue_deliver", {
    agentId: t,
    projectId: t.optional(),
    items: z.array(z.object({
      id: t,
      content: t,
      images: z.array(z.unknown()).optional(),
      ts: n.optional(),
      from: queueSender.nullable().optional(),
      isAgentOwner: b.optional(),
    }).superRefine((item, ctx) => requireOwnerStatusForNamedSender(item.from, item.isAgentOwner, ctx))).max(200),
  }),
  // T-1150 (contrato §4): decisão "excluir" — o daemon larga a cópia local.
  "agent:queue_forget": msg("agent:queue_forget", { agentId: t }),
  "daemon:welcome": msg("daemon:welcome", { user: z.object({ id: t, email: t, name: t }) }),
  "daemon:pong": msg("daemon:pong", { ts: n }),
  "daemon:challenge": msg("daemon:challenge", { nonce: t }),
  "daemon:logs:get": msg("daemon:logs:get", { correlationId: t.optional(), limit: n.optional() }),
  "release:available": msg("release:available", { sha256: t }),
  "runner-policy:set": msg("runner-policy:set", { allowedRunners: z.array(t) }),
  "runner-defaults:set": msg("runner-defaults:set", {
    daemonId: z.string().min(1).max(128),
    version: z.number().int().nonnegative().safe(),
    defaults: z.partialRecord(cliRunner, runnerDefaultSetValue),
  }),
  "project:e2ee_required": msg("project:e2ee_required", { projectId: t, value: b }),
  // T-878: só a flag da feature — o daemon para de mandar texto sem esperar spawn.
  "project:features": msg("project:features", { projectId: t, jev: b }),
  "project_key:for_daemon": msg("project_key:for_daemon", { projectId: t, wrappedProjectKey: t, keyRing: z.array(t).optional() }),
  "task:updated": msg("task:updated", { task: z.object({ id: t, status: t.optional(), assigneeAgentId: t.nullable().optional(), titleCipher: t.optional() }) }),

  "agent:spawn": msg("agent:spawn", {
    agent: agentInfo,
    projectId: t.optional(),
    e2eeRequired: b.optional(),
    basePath: t,
    repoName: t.optional(),
    cwdOverride: t.optional(),
    agentRepo: agentRepo.optional(),
    autoApprove: b,
    agentToken: t,
    orchUrl: t,
    agentWorktrees: b.optional(),
    extraMcpServers: z.record(mcpServerConfig).optional(),
    memory: z.array(memoryEntry).optional(),
    features: contextFeatures.optional(),
  }),
  "agent:stop": msg("agent:stop", { agentId: t }),
  // T-1006: tira da fila do runner um item que AINDA não iniciou (idempotente).
  "agent:queue_live_remove": msg("agent:queue_live_remove", { agentId: t, deliveryId: t.min(1).max(120) }),
  "agent:send": msg("agent:send", {
    agentId: t,
    deliveryId: t.optional(),
    content: t,
    systemPrefix: t.optional(),
    systemSuffix: t.optional(),
    parts: z.array(agentSendPart).optional(),
    /**
     * T-594: mission scratch (`{{mem.NAME}}`) pra o daemon interpolar no
     * conteúdo JÁ decifrado. Valores em claro: a mission_memory é texto claro
     * at rest (o server a lê e é ele quem a escreve, a partir do MEM_SET do
     * output). Costuma acompanhar `parts` (o prompt de step manda junto, porque
     * sem parts o server já fez a passada); o prompt de reviewer pode vir sem
     * elas, porque o server não o passa.
     */
    mem: z.record(t).optional(),
    projectId: t.optional(),
    images: z.array(imageAtt).optional(),
    telegram: z.object({ botToken: t, chatId: t }).nullable().optional(),
    taskId: t.optional(),
    /**
     * T-1006 (acréscimo PM): origem que o server conhece com certeza. O
     * daemon prefere este campo à dedução por systemPrefix/parts.
     * Opcionais: daemon antigo ignora (compat).
     */
    origin: z.enum(["user", "agent", "system"]).optional(),
    // T-1236: identidade de quem enviou (id ESTÁVEL, não o nome do envelope).
    // Reusa o MESMO `queueSender` do retain (#1180) — formato e limites iguais,
    // para o daemon só repassar ao `sender` sem conversão. `from: null` marca
    // autoria desconhecida ou texto confiado exclusivamente ao server.
    from: queueSender.nullable().optional(),
    // Derivado pelo server da identidade autenticada e do ownerUserId persistido.
    isAgentOwner: b.optional(),
    silent: b.optional(),
  }).superRefine((frame, ctx) => requireOwnerStatusForNamedSender(frame.from, frame.isAgentOwner, ctx)),
  "agent:clear": msg("agent:clear", { agentId: t }),
  "agent:compact": msg("agent:compact", { agentId: t, saveMemory: b.optional() }),
  "auto_approve:set": msg("auto_approve:set", { value: b }),
  "workspace:set": msg("workspace:set", { projectId: t, basePath: t, repos: z.array(repoSummary) }),

  "workspace:create": msg("workspace:create", { correlationId: t, workspaceRoot: t, taskId: t, agentId: t }),
  "workspace:remove": msg("workspace:remove", { correlationId: t, workspaceRoot: t, path: t, branch: t, force: b.optional(), taskId: t.optional() }),

  "file:list": msg("file:list", { correlationId: t, path: t, workspaceRoot: wsRoot }),
  "file:read": msg("file:read", { correlationId: t, path: t, workspaceRoot: wsRoot }),
  "file:write": msg("file:write", { correlationId: t, path: t, content: t, workspaceRoot: wsRoot }),
  "file:operation": msg("file:operation", {
    correlationId: t,
    op: z.enum(["create_file", "create_directory", "rename", "delete"]),
    path: t,
    newPath: t.optional(),
    workspaceRoot: wsRoot,
  }),
  "file:search": msg("file:search", { correlationId: t, query: t, workspaceRoot: wsRoot }),

  "git:log": msg("git:log", { correlationId: t, count: n.optional(), workspaceRoot: wsRoot }),
  "git:status": msg("git:status", { correlationId: t, workspaceRoot: wsRoot }),
  "git:diff": msg("git:diff", { correlationId: t, path: t, workspaceRoot: wsRoot }),
  "git:stage": msg("git:stage", { correlationId: t, path: t, workspaceRoot: wsRoot }),
  "git:unstage": msg("git:unstage", { correlationId: t, path: t, workspaceRoot: wsRoot }),
  "git:commit": msg("git:commit", { correlationId: t, message: t, paths: z.array(t).optional(), workspaceRoot: wsRoot }),
  "git:push": msg("git:push", { correlationId: t, workspaceRoot: wsRoot }),
  "git:pull": msg("git:pull", { correlationId: t, workspaceRoot: wsRoot }),
  "git:branches": msg("git:branches", { correlationId: t, workspaceRoot: wsRoot }),
  "git:switch_branch": msg("git:switch_branch", { correlationId: t, branch: t, workspaceRoot: wsRoot }),
  "git:create_branch": msg("git:create_branch", { correlationId: t, branch: t, workspaceRoot: wsRoot }),
  "git:show": msg("git:show", { correlationId: t, hash: t, workspaceRoot: wsRoot }),
  "git:file_log": msg("git:file_log", { correlationId: t, path: t, count: n.optional(), workspaceRoot: wsRoot }),
  "git:graph": msg("git:graph", { correlationId: t, workspaceRoot: wsRoot }),
  "git:blame": msg("git:blame", { correlationId: t, path: t, workspaceRoot: wsRoot }),
  "git:stash_list": msg("git:stash_list", { correlationId: t, workspaceRoot: wsRoot }),
  "git:stash": msg("git:stash", { correlationId: t, message: t.optional(), workspaceRoot: wsRoot }),
  "git:stash_pop": msg("git:stash_pop", { correlationId: t, workspaceRoot: wsRoot }),

  "gitlab:request": msg("gitlab:request", { correlationId: t, method: t, url: t, token: t, body: t.optional() }),
  "summarize:request": msg("summarize:request", {
    correlationId: t,
    runner: t,
    model: t.optional(),
    effort: t.optional(),
    systemPrompt: t.optional(),
    text: t,
    claudeConfigDir: t.optional(),
    // T-1232: repassado do web sem interpretação — distingue o resumo de voz da
    // sugestão de resposta (sombra #3 do Jev no daemon). Opcional: web antigo
    // não manda e o frame segue válido.
    kind: z.enum(["tts", "reply"]).optional(),
    projectId: t.optional(),
  }),
  "transcript:request": msg("transcript:request", { correlationId: t, projectId: t, blobs: z.array(t) }),
  "webhook:dispatch": msg("webhook:dispatch", {
    deliveryId: t,
    projectId: t,
    projectName: t.optional(),
    agentNames: z.record(t).optional(),
    url: t,
    secret: t.nullable(),
    format: z.enum(["generic", "discord", "slack"]),
    headers: z.record(t).optional(),
    event: z.unknown(),
  }),

  "skills:rescan": msg("skills:rescan", { workspaceSkillsRoot: t.optional() }),
  "skill:read_file": msg("skill:read_file", { correlationId: t, skillName: t, relPath: t.optional(), workspaceSkillsRoot: t.optional() }),
  "skill:save_file": msg("skill:save_file", {
    correlationId: t,
    skillName: t,
    relPath: t.optional(),
    content: t,
    workspaceSkillsRoot: t.optional(),
  }),
  "skill:delete": msg("skill:delete", { correlationId: t, skillName: t, workspaceSkillsRoot: t.optional() }),
  "mcps:rescan": msg("mcps:rescan", { workspaceRoot: t.optional() }),
  "mcps:save": msg("mcps:save", {
    correlationId: t.optional(),
    name: t,
    transport: z.enum(["stdio", "sse", "http"]).optional(),
    command: t.optional(),
    args: z.array(t).optional(),
    env: z.record(t).optional(),
    url: t.optional(),
    headers: z.record(t).optional(),
    description: t.optional(),
    workspaceRoot: t.optional(),
  }),
  "mcps:delete": msg("mcps:delete", { correlationId: t.optional(), name: t, workspaceRoot: t.optional() }),

  "graph:build": msg("graph:build", {
    correlationId: t.optional(),
    projectId: t.optional(),
    workspaceRoot: t.optional(),
    semantic: b.optional(),
    backend: t.optional(),
    model: t.optional(),
    apiKeyEnv: t.optional(),
    apiKeyCipher: t.optional(),
  }),
  "graph:fetch": msg("graph:fetch", { correlationId: t.optional(), projectId: t.optional(), workspaceRoot: t.optional() }),
  "open_design:list": msg("open_design:list", { correlationId: t }),
  "open_design:files": msg("open_design:files", { correlationId: t, odProjectId: t }),
  "open_design:file": msg("open_design:file", { correlationId: t, odProjectId: t, path: t }),
  "open_design:create_project": msg("open_design:create_project", { correlationId: t, name: t }),
  "open_design:delete_project": msg("open_design:delete_project", { correlationId: t, odProjectId: t }),
  "open_design:write": msg("open_design:write", { correlationId: t, odProjectId: t, path: t, content: t }),
  "open_design:delete_file": msg("open_design:delete_file", { correlationId: t, odProjectId: t, path: t }),
  "open_design:start_run": msg("open_design:start_run", { correlationId: t, odProjectId: t, prompt: t, skillId: t.optional() }),
  "open_design:run": msg("open_design:run", { correlationId: t, runId: t }),
  "open_design:cancel_run": msg("open_design:cancel_run", { correlationId: t, runId: t }),
  "open_design:search": msg("open_design:search", { correlationId: t, odProjectId: t, query: t }),
  "open_design:artifact": msg("open_design:artifact", { correlationId: t, odProjectId: t, path: t }),
  "open_design:skills": msg("open_design:skills", { correlationId: t }),
  "open_design:plugins": msg("open_design:plugins", { correlationId: t }),
  "open_design:agents": msg("open_design:agents", { correlationId: t }),
  "open_design:duplicate": msg("open_design:duplicate", { correlationId: t, odProjectId: t, name: t }),
  "open_design:copy_design_system": msg("open_design:copy_design_system", { correlationId: t, odProjectId: t, name: t }),
  "open_design:versions": msg("open_design:versions", { correlationId: t, odProjectId: t, path: t }),
  "open_design:restore_version": msg("open_design:restore_version", { correlationId: t, odProjectId: t, path: t, versionId: t }),
  "open_design:steer": msg("open_design:steer", { correlationId: t, runId: t, message: t }),

  "models:discover": msg("models:discover", { correlationId: t, runner: t.optional(), force: b.optional() }),
};
