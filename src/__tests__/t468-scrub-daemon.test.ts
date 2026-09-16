/**
 * T-468 (M26): Sentry do daemon usa o scrub central — "Bearer <token>" e
 * breadcrumbs com /bot<TOKEN>/ deixam de vazar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scrubText } from "@the-dudes/protocol/scrub";

test("T-468 daemon: scrub central cobre bearer e path de bot em breadcrumb", () => {
  const crumb = "POST https://api.telegram.org/bot777:AAF_xxxxxxxxxx/sendMessage authorization: Bearer aaa.bbb";
  const out = scrubText(crumb);
  assert.match(out, /\/bot777:\[REDACTED\]\/sendMessage/);
  assert.match(out, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(out, /AAF_xxxxxxxxxx/);
});

test("T-468 daemon wiring: sentry.ts usa scrubText, sem regex local", () => {
  const src = readFileSync(fileURLToPath(new URL("../sentry.ts", import.meta.url)), "utf8");
  assert.match(src, /from "@the-dudes\/protocol\/scrub"/);
  assert.match(src, /const scrub = scrubText/);
  assert.doesNotMatch(src, /const SECRET = /);
});
