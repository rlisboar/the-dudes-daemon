/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * MCP server discovery scanner (Phase 1, read-only).
 *
 * Scans 7 config locations in precedence order (later wins on name collision):
 *   1. workspace          — <ws>/.mcp.json | <ws>/.claude/mcp.json
 *   2. claude-project     — <ws>/.claude/settings.json [.mcpServers]
 *   3. claude-global      — ~/.claude/mcp_servers.json | ~/.claude/settings.json
 *   4. codex              — ~/.codex/mcp.json
 *   5. opencode           — ~/.config/opencode/mcp.json
 *   6. gemini             — ~/.config/gemini/mcp.json
 *   7. override           — ~/.config/the-dudes/mcp-servers.json
 *
 * Config format follows the de-facto MCP JSON used by Claude Code/Codex:
 *   {
 *     "mcpServers": {
 *       "<name>": { "command": "...", "args": [...], "env": {...} }
 *       or       { "url": "...", "transport": "sse"|"http", "headers": {...} }
 *     }
 *   }
 *
 * Returns dedup'd snapshot. Never throws — missing/malformed files are silently
 * skipped and reported via scannedSources for UI introspection.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { MCPDefinition, MCPSource } from "./types.js";

interface ScanInput {
  workspaceRoot?: string;
}

interface ScanResult {
  mcps: MCPDefinition[];
  scannedSources: string[];
}

interface ConfigSource {
  source: MCPSource;
  candidates: string[]; // first existing wins
  /** Where inside the JSON to look. Defaults to "mcpServers". */
  field?: string;
}

function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

function buildSources(workspaceRoot?: string): ConfigSource[] {
  const home = homeDir();
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const wsCandidates = workspaceRoot
    ? [path.join(workspaceRoot, ".mcp.json"), path.join(workspaceRoot, ".claude", "mcp.json")]
    : [];
  const wsClaudeSettings = workspaceRoot
    ? [path.join(workspaceRoot, ".claude", "settings.json")]
    : [];
  return [
    { source: "workspace",      candidates: wsCandidates },
    { source: "claude-project", candidates: wsClaudeSettings },
    {
      source: "claude-global",
      candidates: [
        path.join(home, ".claude", "mcp_servers.json"),
        path.join(home, ".claude", "settings.json"),
      ],
    },
    { source: "codex",          candidates: [path.join(home, ".codex", "mcp.json")] },
    { source: "opencode",       candidates: [path.join(xdg, "opencode", "mcp.json")] },
    { source: "gemini",         candidates: [path.join(xdg, "gemini", "mcp.json")] },
    { source: "override",       candidates: [path.join(xdg, "the-dudes", "mcp-servers.json")] },
  ];
}

const MAX_MCP_CONFIG_BYTES = 1 * 1024 * 1024; // 1MB — configs reais <10KB

async function readFirstExisting(paths: string[]): Promise<{ data: any; path: string } | null> {
  for (const p of paths) {
    try {
      // Stat antes pra evitar OOM em config gigante (synthesized ou
      // arquivo wrong-formato apontado por env). MCP configs reais
      // são <10KB; 1MB já é absurdo.
      const st = await fs.stat(p);
      if (st.size > MAX_MCP_CONFIG_BYTES) {
        console.warn(`[mcps-scanner] ${p} muito grande (${st.size} bytes), skip`);
        continue;
      }
      const raw = await fs.readFile(p, "utf8");
      return { data: JSON.parse(raw), path: p };
    } catch {
      // missing or invalid — continue
    }
  }
  return null;
}

function parseServers(
  data: any,
  source: MCPSource,
  configPath: string,
): MCPDefinition[] {
  // Standard shape: { mcpServers: {...} }. Some configs nest under "mcp.servers".
  const servers = data?.mcpServers ?? data?.mcp?.servers ?? data?.servers ?? null;
  if (!servers || typeof servers !== "object") return [];
  const out: MCPDefinition[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== "object") continue;
    const v = raw as any;
    const def: MCPDefinition = { name, source, configPath };
    if (typeof v.transport === "string") def.transport = v.transport;
    if (typeof v.command === "string") {
      def.command = v.command;
      def.transport ??= "stdio";
      if (Array.isArray(v.args)) def.args = v.args.map(String);
      if (v.env && typeof v.env === "object") def.env = Object.fromEntries(
        Object.entries(v.env).map(([k, val]) => [k, String(val)]),
      );
    } else if (typeof v.url === "string") {
      def.url = v.url;
      def.transport ??= v.transport === "http" ? "http" : "sse";
      if (v.headers && typeof v.headers === "object") def.headers = Object.fromEntries(
        Object.entries(v.headers).map(([k, val]) => [k, String(val)]),
      );
    } else {
      continue; // neither stdio nor sse/http — skip
    }
    if (typeof v.description === "string") def.description = v.description;
    out.push(def);
  }
  return out;
}

export async function scanMCPs(input: ScanInput): Promise<ScanResult> {
  const sources = buildSources(input.workspaceRoot);
  const byName = new Map<string, MCPDefinition>();
  const scannedSources: string[] = [];

  for (const src of sources) {
    if (src.candidates.length === 0) continue;
    scannedSources.push(...src.candidates);
    const hit = await readFirstExisting(src.candidates);
    if (!hit) continue;
    const defs = parseServers(hit.data, src.source, hit.path);
    // Later sources overwrite earlier on name collision (precedence: override
    // wins last). Map.set handles that naturally given iteration order.
    for (const def of defs) byName.set(def.name, def);
  }

  return {
    mcps: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    scannedSources,
  };
}
