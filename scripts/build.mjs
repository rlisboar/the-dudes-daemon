#!/usr/bin/env node
/**
 * Build do daemon — esbuild bundle com Sentry DSN embedado.
 *
 * Sentry DSN é write-only (público por design); seguro embedar.
 * Source:
 *   1. env var SENTRY_DSN_DAEMON_BUILD (CI/dev)
 *   2. server/.env via SSH não rola aqui — devo passar a DSN explicit
 *   3. fallback: vazio (Sentry inicia silently disabled)
 */

import { build } from "esbuild";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sign as edSign, createPrivateKey } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function loadDsn() {
  if (process.env.SENTRY_DSN_DAEMON_BUILD) return process.env.SENTRY_DSN_DAEMON_BUILD;
  // tenta .env.local local
  try {
    const env = readFileSync(resolve(root, ".env.local"), "utf8");
    const m = env.match(/^SENTRY_DSN_DAEMON\s*=\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^"|"$/g, "");
  } catch {
    /* arquivo não existe — OK */
  }
  // tenta server .env (workspace root)
  try {
    const env = readFileSync(resolve(root, "..", "server", ".env.local"), "utf8");
    const m = env.match(/^SENTRY_DSN\s*=\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^"|"$/g, "");
  } catch {
    /* idem */
  }
  return "";
}

const dsn = loadDsn();
const buildSha = process.env.BUILD_SHA || process.env.COMMIT_SHA || "unknown";
const env = process.env.SENTRY_ENV || process.env.NODE_ENV || "production";

console.log(`[build] sentry dsn: ${dsn ? "embedded" : "(absent — telemetry off)"}`);
console.log(`[build] build sha:  ${buildSha}`);

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  define: {
    "process.env.SENTRY_DSN_DAEMON_DEFAULT": JSON.stringify(dsn),
    "process.env.BUILD_SHA": JSON.stringify(buildSha),
    "process.env.SENTRY_ENV_DEFAULT": JSON.stringify(env),
  },
};

await build({
  ...common,
  entryPoints: [resolve(root, "src/main.ts")],
  outfile: resolve(root, "dist/daemon.cjs"),
  banner: { js: "#!/usr/bin/env node" },
});

await build({
  ...common,
  entryPoints: [resolve(root, "src/mcp-bridge.ts")],
  outfile: resolve(root, "dist/mcp-bridge.cjs"),
});

// Assinatura Ed25519 dos bundles (autenticidade, além do SHA-256 de
// integridade). A chave PRIVADA fica só no host de build (offline em relação
// ao orchestrator) — um server comprometido não consegue forjar assinatura
// válida. A pública vai embutida no install script + entrypoint. Sem chave
// (CI sem secret), pula a assinatura (degrada pra só checksum).
const signKeyPath = process.env.THE_DUDES_SIGN_KEY_FILE || resolve(root, ".signing/sign.key");
if (existsSync(signKeyPath)) {
  const key = createPrivateKey(readFileSync(signKeyPath));
  for (const f of ["dist/daemon.cjs", "dist/mcp-bridge.cjs"]) {
    const p = resolve(root, f);
    const sig = edSign(null, readFileSync(p), key).toString("base64");
    writeFileSync(`${p}.sig`, sig + "\n");
  }
  console.log("[build] signed: daemon.cjs.sig + mcp-bridge.cjs.sig (Ed25519)");
} else {
  console.warn(`[build] signing key absent (${signKeyPath}) — bundles NOT signed (só checksum)`);
}

console.log("[build] done");
