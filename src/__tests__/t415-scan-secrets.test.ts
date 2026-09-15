/**
 * T-415/A11: mcps:scan e skills:scan enviam só nomes, nunca valores de env/headers.
 */
import "./scratch-home.js";

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mcpToScanPayload, scanMCPs } from "../mcps-scanner.js";
import { scanSkills, skillToScanPayload } from "../skills-scanner.js";

const GHP = "ghp_TESTSECRET_do_not_send_abc123";
const BEARER = "Bearer FAKESECRET_i1j2k3l4m5n6o7p8q9r0";

function jsonOf(v: unknown): string {
  return JSON.stringify(v);
}

function assertNoSecrets(label: string, payload: unknown): void {
  const raw = jsonOf(payload);
  assert.equal(raw.includes(GHP), false, `${label}: JSON não pode conter ghp_`);
  assert.equal(raw.includes("sk_live_NEVER"), false, `${label}: JSON não pode conter Bearer token`);
  assert.equal(raw.includes(BEARER), false, `${label}: JSON não pode conter Authorization Bearer`);
}

test("T-415 mcps:scan: envKeys/headerKeys presentes; valores ghp_/Bearer ausentes no JSON", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "t415-home-"));
  after(() => rmSync(home, { recursive: true, force: true }));
  const prevHome = process.env.HOME;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  after(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
  });

  mkdirSync(path.join(home, ".config", "the-dudes"), { recursive: true });
  writeFileSync(path.join(home, ".config", "the-dudes", "mcp-servers.json"), JSON.stringify({
    mcpServers: {
      "stdio-secret": {
        type: "stdio",
        command: "npx",
        args: ["-y", "fake"],
        env: { GITHUB_TOKEN: GHP, OPENAI_API_KEY: "sk-not-this-either" },
      },
    },
  }));
  const ws = mkdtempSync(path.join(os.tmpdir(), "t415-ws-"));
  after(() => rmSync(ws, { recursive: true, force: true }));
  writeFileSync(path.join(ws, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "http-secret": {
        type: "http",
        url: "https://mcp.example/u",
        headers: { Authorization: BEARER, "X-Api-Key": "sk_live_NEVER" },
      },
    },
  }));

  const scan = await scanMCPs({ workspaceRoot: ws });
  const wire = {
    type: "mcps:scan" as const,
    mcps: scan.mcps.map(mcpToScanPayload),
    scannedSources: scan.scannedSources,
    ts: 0,
  };
  assertNoSecrets("mcps:scan", wire);

  const stdio = wire.mcps.find((m) => m.name === "stdio-secret");
  const http = wire.mcps.find((m) => m.name === "http-secret");
  assert.ok(stdio, "stdio-secret no payload");
  assert.ok(http, "http-secret no payload");
  assert.deepEqual(stdio!.envKeys?.sort(), ["GITHUB_TOKEN", "OPENAI_API_KEY"]);
  assert.equal(stdio!.env, undefined, "campo env ausente");
  assert.deepEqual(http!.headerKeys?.sort(), ["Authorization", "X-Api-Key"]);
  assert.equal(http!.headers, undefined, "campo headers ausente");

  // scan interno ainda tem valores (spawn local T-308); o JSON do WS não.
  const rawScan = scan.mcps.find((m) => m.name === "stdio-secret");
  assert.equal(rawScan?.env?.GITHUB_TOKEN, GHP);
});

test("T-415 skills:scan: JSON enviado não contém ghp_/Bearer de env/headers", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "t415-skills-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const skillDir = path.join(root, "leaky");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: leaky",
    "description: não deve vazar secrets de env/headers",
    `GITHUB_TOKEN: ${GHP}`,
    `Authorization: ${BEARER}`,
    "---",
    "corpo sem secret",
    "",
  ].join("\n"));

  const scan = await scanSkills({ workspaceRoot: null, extraSourceRoots: [root] });
  const mine = scan.skills.filter((s) => s.path.startsWith(root));
  const wire = {
    type: "skills:scan" as const,
    skills: mine.map(skillToScanPayload),
    scannedSources: scan.scannedSources,
    ts: 0,
  };
  assertNoSecrets("skills:scan", wire);
  const leaky = wire.skills.find((s) => s.name === "leaky");
  assert.ok(leaky, "skill leaky no payload");
  assert.equal("env" in leaky!, false);
  assert.equal("headers" in leaky!, false);
  assert.equal((leaky!.frontmatter as { GITHUB_TOKEN?: string }).GITHUB_TOKEN, undefined);
});

test("T-415: nenhum encryptForProject no recorte (scanners + send de scan)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const scanner = readFileSync(path.join(dir, "../mcps-scanner.ts"), "utf8");
  const skills = readFileSync(path.join(dir, "../skills-scanner.ts"), "utf8");
  const main = readFileSync(path.join(dir, "../main.ts"), "utf8");
  assert.equal(scanner.includes("encryptForProject"), false);
  assert.equal(skills.includes("encryptForProject"), false);
  const reportMcps = main.slice(main.indexOf("async reportMCPsScan"), main.indexOf("mcpsOverridePath"));
  const reportSkills = main.slice(main.indexOf("async reportSkillsScan"), main.indexOf("async reportMCPsScan"));
  assert.equal(reportMcps.includes("encryptForProject"), false);
  assert.equal(reportSkills.includes("encryptForProject"), false);
  assert.match(reportMcps, /mcpToScanPayload/);
  assert.match(reportSkills, /skillToScanPayload/);
});
