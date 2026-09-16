/**
 * T-474 (P2 daemon): bundles stale não sombreiam a fonte em dev; bridgePost
 * suporta https; installed ≠ available antes da policy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { helloRunnerLists, POLICY_GATED_RUNNERS } from "../runner-policy.js";

const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

test("T-474: resolveBridge em .ts prefere a fonte (cjs stale não sombreia)", () => {
  const s = src("../agent-host.ts");
  assert.match(s, /const runningFromTs = String\(process\.argv\[1\] \?\? ""\)\.endsWith\("\.ts"\)/);
  assert.match(s, /if \(!runningFromTs && fs\.existsSync\(bundled\)\)/);
});

test("T-474: bridgePost escolhe https pelo protocolo", () => {
  const s = src("../runners/bootstrap.ts");
  assert.match(s, /isHttps = u\.protocol === "https:"/);
  assert.match(s, /\(isHttps \? https : http\)\.request/);
});

test("T-474: helloRunnerLists separa instalados de disponíveis", () => {
  const cmds: Record<string, { available: boolean }> = {};
  for (const r of POLICY_GATED_RUNNERS) cmds[r] = { available: false };
  cmds.claude = { available: true };
  const installed = { claude: true, codex: true } as never;
  const lists = helloRunnerLists(cmds as never, installed);
  assert.ok(lists.installedRunners.includes("claude") && lists.installedRunners.includes("codex"));
  assert.deepEqual(lists.availableRunners, ["claude"]);
});
