#!/usr/bin/env node
/**
 * Dispara test events no Sentry pra confirmar pipeline.
 * Roda local, mata em seguida.
 *
 * Usage:
 *   SERVER_DSN=https://... DAEMON_DSN=https://... node scripts/sentry-test.mjs
 *
 * Sem env, lê de daemon/.env.local + ../server/.env.local.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function envFromFile(path, key) {
  try {
    const txt = readFileSync(path, "utf8");
    const m = txt.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"));
    return m ? m[1].trim().replace(/^"|"$/g, "") : null;
  } catch {
    return null;
  }
}

const SERVER_DSN = process.env.SERVER_DSN
  ?? envFromFile(resolve(root, "..", "server", ".env.local"), "SENTRY_DSN")
  ?? envFromFile(resolve(root, ".env.server.local"), "SENTRY_DSN");
const DAEMON_DSN = process.env.DAEMON_DSN
  ?? envFromFile(resolve(root, ".env.local"), "SENTRY_DSN_DAEMON")
  ?? envFromFile(resolve(root, ".env.local"), "SENTRY_DSN");

if (!SERVER_DSN) throw new Error("missing SERVER_DSN");
if (!DAEMON_DSN) throw new Error("missing DAEMON_DSN");

const Sentry = await import("@sentry/node");

async function fire(name, dsn, tags) {
  const client = new Sentry.NodeClient({
    dsn,
    transport: Sentry.makeNodeTransport,
    stackParser: Sentry.defaultStackParser,
    integrations: Sentry.getDefaultIntegrations({}),
    environment: "production",
    release: "manual-test",
    sendDefaultPii: false,
  });
  const scope = new Sentry.Scope();
  scope.setClient(client);
  client.init();
  for (const [k, v] of Object.entries(tags)) scope.setTag(k, v);
  const id = Sentry.captureException(
    new Error(`manual sentry test ${name} ${new Date().toISOString()}`),
    { captureContext: scope },
  );
  await client.flush(5000);
  console.log(`[${name}] event id: ${id}`);
}

await fire("server", SERVER_DSN, { source: "scripts/sentry-test.mjs", target: "server" });
await fire("daemon", DAEMON_DSN, { source: "scripts/sentry-test.mjs", target: "daemon" });

console.log("done — check Sentry org lisboa-47 projects the-dudes-server + the-dudes-daemon");
