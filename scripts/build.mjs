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
import { sign as edSign, createHash, createPrivateKey } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// BUILD REPRODUZÍVEL: o bundle distribuído NÃO embute DSN nem BUILD_SHA por
// padrão — assim `npm run build` num clone do repo público (que tem git
// history própria) produz bytes IDÊNTICOS ao binário publicado em /install.
// Telemetria é OPT-IN: defina SENTRY_DSN_DAEMON_BUILD pra embutir a DSN (e
// BUILD_SHA pra carimbar o sha) — esses builds deixam de ser reproduzíveis,
// por isso NÃO são o que distribuímos. Default = sem phone-home (melhor p/
// confiança) + reproduzível.
const dsn = process.env.SENTRY_DSN_DAEMON_BUILD || "";
const buildSha = process.env.BUILD_SHA || "";
const env = process.env.SENTRY_ENV || process.env.NODE_ENV || "production";

const repro = !dsn && !buildSha;
console.log(`[build] sentry dsn: ${dsn ? "embedded (opt-in, NÃO reproduzível)" : "(absent — telemetry off)"}`);
console.log(`[build] build sha:  ${buildSha || "(none)"}`);
console.log(`[build] reproducible: ${repro ? "yes (default distribuível)" : "no (DSN/SHA embutidos)"}`);

// Versão do package embutida (reproduzível: mesma árvore → mesma versão).
// Era "0.1.0" hardcoded no main.ts, morto há meses — o painel de monitoramento
// mostrava um número que não acompanhava release nenhum.
const pkgVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version ?? "0.0.0";

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  define: {
    "process.env.SENTRY_DSN_DAEMON_DEFAULT": JSON.stringify(dsn),
    "process.env.BUILD_SHA": JSON.stringify(buildSha),
    "process.env.SENTRY_ENV_DEFAULT": JSON.stringify(env),
    "process.env.DAEMON_PKG_VERSION": JSON.stringify(pkgVersion),
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

for (const name of ["daemon.cjs", "mcp-bridge.cjs"]) {
  const bundle = readFileSync(resolve(root, "dist", name));
  const checksum = createHash("sha256").update(bundle).digest("hex");
  writeFileSync(resolve(root, "dist", `${name}.sha256`), `${checksum}  ${name}\n`);
}

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
