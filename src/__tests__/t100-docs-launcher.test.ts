/**
 * T-100: systemd/pm2 nas docs não podem instruir `node daemon.cjs` direto.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const docs = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../docs/DAEMON.md"),
  "utf8",
);

function section(title: string): string {
  const i = docs.indexOf(title);
  assert.ok(i >= 0, `seção ausente: ${title}`);
  const next = docs.indexOf("\n### ", i + title.length);
  return docs.slice(i, next < 0 ? undefined : next);
}

test("T-100 docs: systemd ExecStart é run-daemon.sh, não node daemon.cjs", () => {
  const s = section("### Linux (systemd user)");
  assert.match(s, /ExecStart=%h\/\.the-dudes\/run-daemon\.sh/);
  assert.doesNotMatch(s, /ExecStart=\/usr\/bin\/node %h\/\.the-dudes\/daemon\.cjs/);
  assert.doesNotMatch(s, /node %h\/\.the-dudes\/daemon\.cjs --orch/);
});

test("T-100 docs: pm2 sobe o launcher, não daemon.cjs cru", () => {
  const s = section("### pm2 (cross-platform");
  assert.match(s, /pm2 start ~\/\.the-dudes\/run-daemon\.sh/);
  assert.doesNotMatch(s, /pm2 start ~\/\.the-dudes\/daemon\.cjs/);
});

test("T-100 docs: footgun LAUNCHER=1 sem supervisor", () => {
  assert.match(docs, /THE_DUDES_LAUNCHER=1/);
  assert.match(docs, /morre/);
  assert.match(docs, /run-daemon\.sh/);
});
