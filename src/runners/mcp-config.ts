export interface McpServerConfig {
  type?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
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
  features?: Record<string, string>; socketPath?: string;
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

export function buildClaudeMcpConfig(extras: Record<string, McpServerConfig> | undefined, bridge: BridgeConfig) {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, config] of Object.entries(extras ?? {})) {
    if (name !== "the-dudes") mcpServers[name] = config;
  }
  mcpServers["the-dudes"] = { type: "stdio", ...bridge };
  return { mcpServers };
}

export function buildCrushMcpConfig(
  extras: Record<string, McpServerConfig> | undefined,
  bridge: BridgeConfig,
) {
  const mcp: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const [name, config] of Object.entries(extras ?? {})) {
    if (name === "the-dudes") continue;
    const type = config.type ?? "stdio";
    if (type === "stdio" && config.command) {
      mcp[name] = {
        type, command: config.command,
        ...(config.args?.length ? { args: config.args } : {}),
        ...(config.env && Object.keys(config.env).length ? { env: config.env } : {}),
      };
    } else if ((type === "http" || type === "sse") && config.url) {
      mcp[name] = {
        type, url: config.url,
        ...(config.headers && Object.keys(config.headers).length ? { headers: config.headers } : {}),
      };
    } else {
      warnings.push(`skipping MCP "${name}" — transport "${type}" requires ${type === "stdio" ? "command" : "url"}`);
    }
  }
  mcp["the-dudes"] = { type: "stdio", ...bridge };
  return { config: { $schema: "https://charm.land/crush.json", mcp }, warnings };
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
