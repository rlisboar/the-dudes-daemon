/**
 * Sentry integration para o daemon distribuído.
 *
 * Setup análogo ao orchestrator: gated em `SENTRY_DSN`, no-op sem
 * token. Daemons vivem na máquina dos owners — capturar exceptions
 * é a única forma de saber que algo quebrou sem ter que pedir log
 * por canal humano.
 *
 * O daemon herda o mesmo project Sentry do backend (the-dudes-server)
 * por padrão. Owner pode setar `SENTRY_DSN_DAEMON` pra apontar pra
 * project separado se quiser segregar issues.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import * as Sentry from "@sentry/node";

// Build-time injectado em scripts/build.mjs via esbuild --define.
// Runtime env tem precedência pra overrides ad-hoc.
const DSN = process.env.SENTRY_DSN_DAEMON
  ?? process.env.SENTRY_DSN
  ?? process.env.SENTRY_DSN_DAEMON_DEFAULT
  ?? "";
const ENV = process.env.SENTRY_ENV
  ?? process.env.NODE_ENV
  ?? process.env.SENTRY_ENV_DEFAULT
  ?? "production";
const RELEASE = process.env.BUILD_SHA
  ?? process.env.COMMIT_SHA
  ?? "unknown";

let enabled = false;

export function initSentry() {
  if (!DSN) return;
  Sentry.init({
    dsn: DSN,
    environment: ENV,
    release: RELEASE,
    tracesSampleRate: ENV === "production" ? 0.05 : 1.0,
    sendDefaultPii: false,
    integrations: [Sentry.httpIntegration()],
    initialScope: {
      tags: {
        component: "daemon",
        host_os: process.platform,
        node_version: process.version,
      },
    },
    beforeSend(event) {
      // Mesmo redact do orchestrator — daemon vê tokens em transit.
      if (event.request?.url) {
        event.request.url = event.request.url.replace(
          /(token|recovery|kek)=[^&]+/gi,
          "$1=[REDACTED]",
        );
      }
      return event;
    },
  });
  enabled = true;
  console.log(`[sentry] daemon initialised — env=${ENV} release=${RELEASE}`);
}

export function capture(err: unknown, ctx?: Record<string, unknown>) {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    if (ctx) scope.setContext("ctx", ctx);
    Sentry.captureException(err);
  });
}

/** Captura warn level (não erro mas vale registrar). Ex: reconnect repetido. */
export function captureWarn(message: string, ctx?: Record<string, unknown>) {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    scope.setLevel("warning");
    if (ctx) scope.setContext("ctx", ctx);
    Sentry.captureMessage(message);
  });
}

/** Breadcrumb pra rastrear lifecycle sem disparar event. Visível na page
 *  do issue quando algo realmente quebra depois. */
export function breadcrumb(category: string, message: string, data?: Record<string, unknown>) {
  if (!enabled) return;
  Sentry.addBreadcrumb({ category, message, level: "info", data });
}

/** Tag dinâmica — daemon name, owner, etc. */
export function setTag(key: string, value: string) {
  if (!enabled) return;
  Sentry.setTag(key, value);
}

export function flush(timeoutMs = 2000): Promise<boolean> {
  if (!enabled) return Promise.resolve(true);
  return Sentry.flush(timeoutMs);
}

// Eat-all hooks — daemon é processo single-tenant, dropar erro
// silencioso é pior do que mandar pro Sentry e seguir.
process.on("uncaughtException", (err) => {
  capture(err, { phase: "uncaughtException" });
  console.error("[daemon] uncaughtException:", err);
});

process.on("unhandledRejection", (reason) => {
  capture(reason, { phase: "unhandledRejection" });
  console.error("[daemon] unhandledRejection:", reason);
});

// Re-export para uso pontual em handlers async sem try/catch verboso.
export { Sentry };

// `IncomingMessage`/`ServerResponse` re-exports pra futuro middleware
// HTTP no daemon (hoje só WebSocket). Mantém parity com orchestrator.
export type { IncomingMessage, ServerResponse };
