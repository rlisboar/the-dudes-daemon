export interface McpServerConfig {
  type?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  /** T-768: ferramentas visíveis deste servidor para ESTE agente. Ausente/null
   *  = todas (compat); [] = nenhuma. O daemon troca o servidor por um proxy
   *  que filtra tools/list — os CLIs não filtram visibilidade sozinhos. */
  tools?: string[];
}

export interface BridgeConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** T-308: resumo DE INJEÇÃO pra log diagnóstico — só nome+transporte.
 *  NUNCA incluir env/headers aqui (tokens/credenciais não podem vazar
 *  em log). Formato: [a(stdio), b(http)]. */
export function summarizeMcpServers(extras: Record<string, McpServerConfig> | undefined): string {
  const parts = Object.entries(extras ?? {}).map(([name, config]) => `${name}(${config.type ?? "stdio"})`);
  return `[${parts.join(", ")}]`;
}

export function buildBridgeEnv(input: {
  agentId: string; agentName: string; orchestratorUrl: string; tokenFile: string;
  features?: Record<string, string>; socketPath?: string; role?: string;
}): Record<string, string> {
  // Anotado: sem isso o TS infere o tipo exato do literal e recusa a
  // atribuição condicional de THE_DUDES_BRIDGE_SOCKET logo abaixo.
  const env: Record<string, string> = {
    THE_DUDES_AGENT_ID: input.agentId,
    THE_DUDES_AGENT_NAME: input.agentName,
    THE_DUDES_ORCH_URL: input.orchestratorUrl,
    THE_DUDES_AGENT_TOKEN_FILE: input.tokenFile,
    ...(input.features ?? {}),
  };
  if (input.socketPath) env.THE_DUDES_BRIDGE_SOCKET = input.socketPath;
  // T-391: o papel vem do runner (this.info.role), nunca do projeto — é o que
  // faz o gate de save_agent/stop_agent provar A3/A5. Ausente = bridge não
  // registra as tools de papel (daemon antigo nunca deu controller a ninguém).
  if (input.role) env.THE_DUDES_AGENT_ROLE = input.role;
  return env;
}

/** T-308: gemini-cli distingue SSE (url) de streamable HTTP (httpUrl) —
 *  mandar url pra um MCP "http" fazia o CLI tentar SSE e o servidor nunca
 *  conectava (descarte silencioso por transporte errado). Headers valem
 *  pros dois transportes remotos. */
export function buildGeminiMcpServers(extras: Record<string, McpServerConfig> | undefined, bridge: BridgeConfig): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (const [name, config] of Object.entries(extras ?? {})) {
    if (name === "the-dudes") continue;
    const type = config.type ?? "stdio";
    if (type === "http" && config.url) {
      servers[name] = {
        httpUrl: config.url,
        ...(config.headers && Object.keys(config.headers).length ? { headers: config.headers } : {}),
      };
      continue;
    }
    const copy: Record<string, unknown> = { ...config };
    delete copy.type;
    servers[name] = copy;
  }
  servers["the-dudes"] = bridge;
  return servers;
}

/** Qwen Code: settings.json aceita mcpServers no MESMO shape do gemini
 *  (command/args/env p/ stdio; httpUrl p/ HTTP; `type` do Claude fica fora). */
export const buildQwenMcpServers = buildGeminiMcpServers;

export function buildClaudeMcpConfig(extras: Record<string, McpServerConfig> | undefined, bridge: BridgeConfig) {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, config] of Object.entries(extras ?? {})) {
    if (name !== "the-dudes") mcpServers[name] = config;
  }
  mcpServers["the-dudes"] = { type: "stdio", ...bridge };
  return { mcpServers };
}

/** T-426 (A15): nome de var de ambiente que REFERENCIA um valor no
 *  `.crush.json` (o crush expande `$VAR` em command/args/env/headers — testado
 *  na v0.82.0). O valor literal fica no env do processo crush, nunca no
 *  arquivo do workspace. Namespace evita colisão com PATH/HOME do runner. */
export function crushRefName(server: string, kind: "env" | "hdr", key: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  return `THEDUDES_MCP_${clean(server)}_${kind.toUpperCase()}_${clean(key)}`;
}

/** Crush: `.crush.json` no workspaceRoot só carrega REFERÊNCIAS (`$VAR`) em
 *  env/headers; os valores vão no env do processo (`envRefs`), fora do git.
 *  O envelope `mcp["the-dudes"]` já era construído com `$VAR` pelo caller. */
export function buildCrushMcpConfig(
  extras: Record<string, McpServerConfig> | undefined,
  bridge: BridgeConfig,
) {
  const mcp: Record<string, unknown> = {};
  const warnings: string[] = [];
  const envRefs: Record<string, string> = {};
  const refEnv = (server: string, env: Record<string, string> | undefined) => {
    if (!env || !Object.keys(env).length) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      const ref = crushRefName(server, "env", k);
      out[k] = `$${ref}`;
      envRefs[ref] = v;
    }
    return out;
  };
  const refHeaders = (server: string, headers: Record<string, string> | undefined) => {
    if (!headers || !Object.keys(headers).length) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      const ref = crushRefName(server, "hdr", k);
      out[k] = `$${ref}`;
      envRefs[ref] = v;
    }
    return out;
  };
  for (const [name, config] of Object.entries(extras ?? {})) {
    if (name === "the-dudes") continue;
    const type = config.type ?? "stdio";
    if (type === "stdio" && config.command) {
      const env = refEnv(name, config.env);
      mcp[name] = {
        type, command: config.command,
        ...(config.args?.length ? { args: config.args } : {}),
        ...(env ? { env } : {}),
      };
    } else if ((type === "http" || type === "sse") && config.url) {
      const headers = refHeaders(name, config.headers);
      mcp[name] = {
        type, url: config.url,
        ...(headers ? { headers } : {}),
      };
    } else {
      warnings.push(`skipping MCP "${name}" — transport "${type}" requires ${type === "stdio" ? "command" : "url"}`);
    }
  }
  mcp["the-dudes"] = { type: "stdio", ...bridge };
  return { config: { $schema: "https://charm.land/crush.json", mcp }, warnings, envRefs };
}

export function buildOpenCodeMcpConfig(extras: Record<string, McpServerConfig> | undefined, bridge: BridgeConfig, autoApprove: boolean, managedAgent?: Record<string, unknown>) {
  const mcp: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const [name, config] of Object.entries(extras ?? {})) {
    if (name === "the-dudes") continue;
    const type = config.type ?? "stdio";
    // T-308: opencode suporta MCP remoto (type remote + url/headers) —
    // http/sse antes eram descartados com "only stdio" (skip silencioso
    // na prática). Só segue warning quando o transporte não tem url.
    if ((type === "http" || type === "sse") && config.url) {
      mcp[name] = {
        type: "remote", enabled: true, url: config.url,
        ...(config.headers && Object.keys(config.headers).length ? { headers: config.headers } : {}),
      };
      continue;
    }
    if (type !== "stdio" || !config.command) {
      warnings.push(`skipping MCP "${name}" — transport "${type}" requires ${type === "stdio" ? "command" : "url"}`);
      continue;
    }
    mcp[name] = {
      type: "local", enabled: true,
      command: [config.command, ...(config.args ?? [])],
      ...(config.env && Object.keys(config.env).length ? { environment: config.env } : {}),
    };
  }
  mcp["the-dudes"] = { type: "local", enabled: true, command: [bridge.command, ...bridge.args], environment: bridge.env };
  return {
    config: {
      $schema: "https://opencode.ai/config.json",
      mcp,
      permission: autoApprove ? "allow" : { edit: "ask", bash: "ask", webfetch: "ask", external_directory: "ask" },
      ...(managedAgent ? { agent: { "the-dudes-managed": managedAgent } } : {}),
    },
    warnings,
  };
}

const tomlString = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const tomlArray = (values: string[]) => `[${values.map(tomlString).join(",")}]`;
const tomlEnv = (env: Record<string, string>) => `{${Object.entries(env).map(([key, value]) => `${key}=${tomlString(value)}`).join(",")}}`;
const tomlKey = (name: string) => /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name);

export function buildGrokMcpToml(extras: Record<string, McpServerConfig> | undefined, bridge: BridgeConfig) {
  const lines = [
    "# Managed by the-dudes — MCP bridge for Grok Build agents.",
    "# Per-agent values are expanded from the process environment (${VAR}).",
    "",
  ];
  const warnings: string[] = [];
  const safeName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "-");
  const emitMap = (section: string, values: Record<string, string>) => {
    if (!Object.keys(values).length) return;
    lines.push(`[${section}]`);
    for (const [key, value] of Object.entries(values)) lines.push(`${tomlString(key)} = ${tomlString(value)}`);
    lines.push("");
  };
  const emitStdio = (name: string, config: BridgeConfig) => {
    const section = `mcp_servers.${safeName(name)}`;
    lines.push(`[${section}]`, `command = ${tomlString(config.command)}`, "enabled = true");
    if (config.args.length) lines.push(`args = [${config.args.map(tomlString).join(", ")}]`);
    lines.push("");
    emitMap(`${section}.env`, config.env);
  };
  for (const [name, config] of Object.entries(extras ?? {})) {
    if (name === "the-dudes") continue;
    const type = config.type ?? "stdio";
    if (type === "stdio" && config.command) {
      emitStdio(name, { command: config.command, args: config.args ?? [], env: config.env ?? {} });
    } else if ((type === "http" || type === "sse") && config.url) {
      const section = `mcp_servers.${safeName(name)}`;
      lines.push(`[${section}]`, `url = ${tomlString(config.url)}`, "enabled = true", "");
      emitMap(`${section}.headers`, config.headers ?? {});
    } else {
      warnings.push(`skipping MCP "${name}" — transport "${type}" requires ${type === "stdio" ? "command" : "url"}`);
    }
  }
  emitStdio("the-dudes", bridge);
  return { toml: lines.join("\n"), warnings };
}

/**
 * T-426 (A15): config.toml do CODEX_HOME por agente. Antes tudo ia em `-c
 * mcp_servers.<x>.env={KEY="valor"}` — o VALOR do token ficava visível em
 * `ps`/cmdline. O arquivo fica fora do git worktree e em mode 0600.
 */
export function buildCodexMcpToml(extras: Record<string, McpServerConfig> | undefined, bridge: BridgeConfig): { toml: string; warnings: string[] } {
  const lines = [
    "# Managed by the-dudes — MCP servers for Codex agents (T-426).",
    "# Per-agent file, mode 0600, outside the git worktree.",
    "",
  ];
  const warnings: string[] = [];
  const emitServer = (name: string, config: { command: string; args: string[]; env: Record<string, string> }) => {
    lines.push(`[mcp_servers.${tomlKey(name)}]`, `command = ${tomlString(config.command)}`);
    if (config.args.length) lines.push(`args = ${tomlArray(config.args)}`);
    if (Object.keys(config.env).length) lines.push(`env = ${tomlEnv(config.env)}`);
    lines.push("");
  };
  for (const [name, config] of Object.entries(extras ?? {})) {
    if (name === "the-dudes") continue;
    const type = config.type ?? "stdio";
    if ((type === "http" || type === "sse") && config.url) {
      if (type === "sse") {
        warnings.push(`skipping MCP "${name}" — codex supports stdio and streamable http (url), not sse`);
        continue;
      }
      lines.push(`[mcp_servers.${tomlKey(name)}]`, `url = ${tomlString(config.url)}`, "");
      if (config.headers && Object.keys(config.headers).length) {
        warnings.push(`MCP "${name}" (http): codex não aplica headers custom — use bearer_token_env_var no config do codex`);
      }
      continue;
    }
    if (type !== "stdio" || !config.command) {
      warnings.push(`skipping MCP "${name}" — transport "${type}" requires ${type === "stdio" ? "command" : "url"}`);
      continue;
    }
    emitServer(name, { command: config.command, args: config.args ?? [], env: config.env ?? {} });
  }
  emitServer("the-dudes", bridge);
  return { toml: lines.join("\n"), warnings };
}

export function buildCodexMcpArgs(extras: Record<string, McpServerConfig> | undefined, bridge: BridgeConfig) {
  const args: string[] = [];
  const warnings: string[] = [];
  for (const [name, config] of Object.entries(extras ?? {})) {
    if (name === "the-dudes") continue;
    const type = config.type ?? "stdio";
    // T-308: codex (≥0.153, confirmado `codex mcp add --url` + coluna Bearer
    // Token Env Var no `codex mcp list`) suporta streamable HTTP via
    // mcp_servers.<id>.url. SSE não é suportado — warning com nome+transporte
    // (nunca skip silencioso). Headers não entram no config do codex: o CLI
    // usa bearer_token_env_var — se a Integração define headers, avisa.
    if ((type === "http" || type === "sse") && config.url) {
      if (type === "sse") {
        warnings.push(`skipping MCP "${name}" — codex supports stdio and streamable http (url), not sse`);
        continue;
      }
      const key = tomlKey(name);
      args.push("-c", `mcp_servers.${key}.url=${tomlString(config.url)}`);
      if (config.headers && Object.keys(config.headers).length) {
        warnings.push(`MCP "${name}" (http): codex não aplica headers custom — use bearer_token_env_var no config do codex`);
      }
      continue;
    }
    if (type !== "stdio" || !config.command) {
      warnings.push(`skipping MCP "${name}" — transport "${type}" requires ${type === "stdio" ? "command" : "url"}`);
      continue;
    }
    const key = tomlKey(name);
    args.push("-c", `mcp_servers.${key}.command=${tomlString(config.command)}`);
    if (config.args?.length) args.push("-c", `mcp_servers.${key}.args=${tomlArray(config.args)}`);
    if (config.env && Object.keys(config.env).length) args.push("-c", `mcp_servers.${key}.env=${tomlEnv(config.env)}`);
  }
  args.push(
    "-c", `mcp_servers.the-dudes.command=${tomlString(bridge.command)}`,
    "-c", `mcp_servers.the-dudes.args=${tomlArray(bridge.args)}`,
    "-c", `mcp_servers.the-dudes.env=${tomlEnv(bridge.env)}`,
  );
  return { args, warnings };
}

/** T-768: troca cada servidor com `tools` declaradas por um proxy stdio nosso
 *  (mcp-bridge --mcp-proxy) que filtra tools/list no ponto de injeção. Sem
 *  `tools`, devolve o MESMO objeto (compat total: config antiga passa igual). */
export function wrapToolFilteredServers(
  extras: Record<string, McpServerConfig> | undefined,
  bridge: BridgeConfig,
): Record<string, McpServerConfig> | undefined {
  if (!extras) return extras;
  let changed = false;
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(extras)) {
    if (name !== "the-dudes" && Array.isArray(cfg.tools)) {
      changed = true;
      const isRemote = (cfg.type === "http" || cfg.type === "sse") && cfg.url;
      const upstream = isRemote
        ? { transport: cfg.type as "http" | "sse", url: cfg.url as string, ...(cfg.headers && Object.keys(cfg.headers).length ? { headers: cfg.headers } : {}) }
        : { transport: "stdio" as const, command: cfg.command ?? "", ...(cfg.args ? { args: cfg.args } : {}), ...(cfg.env ? { env: cfg.env } : {}) };
      out[name] = {
        type: "stdio",
        command: bridge.command,
        args: [...bridge.args, "--mcp-proxy", JSON.stringify({ tools: cfg.tools, upstream })],
        ...(cfg.description ? { description: cfg.description } : {}),
      };
      continue;
    }
    if (cfg.tools !== undefined) {
      changed = true;
      const rest: McpServerConfig = { ...cfg };
      delete rest.tools;
      out[name] = rest;
      continue;
    }
    out[name] = cfg;
  }
  return changed ? out : extras;
}
