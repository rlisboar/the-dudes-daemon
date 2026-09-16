/**
 * R14 (T-468): scrub CENTRAL de segredos para logs e Sentry (server + daemon).
 *
 * Fecha M13 (ctx do capture sem scrub) e M26 (token depois de "Bearer" e
 * breadcrumbs com /bot<TOKEN>/ do Telegram). Um único regex set mantém
 * logger e Sentry em sincronia — o que o log redige, o Sentry também.
 */

// authorization: bearer <x> / "Bearer <x>"
const BEARER_RE = /(bearer\s+)[A-Za-z0-9._\-+/=]+/gi;
// query/enum: token=, password: "…" etc.
const QS_RE = /\b(token|ticket|recovery|kek|passphrase|password|passwd|code|access_token|id_token|refresh_token|api[_-]?key|apikey|secret|authorization)=([^&\s"'`]+)/gi;
// cookies the_dudes_*
const COOKIE_RE = /(the_dudes_[a-z_]+=)([^;\s"']+)/gi;
// blob E2EE
const E2E_RE = /\be2e:[A-Za-z0-9+/=]{8,}/g;
// token de bot no path (Telegram API: /bot<id>:<secret>/metodo)
const BOT_PATH_RE = /\/bot(\d+):([A-Za-z0-9_-]{10,})(?=\/|$|\?)/g;
// chaves estilo OpenAI/similar
const SK_RE = /\bsk-[A-Za-z0-9_-]{16,}/g;
// termos sensíveis em pares "term: value" / "term=value" / "term":"value"
const SENSITIVE_TERMS = [
  "passphrase",
  "recoverycode",
  "recovery_code",
  "wrappedprivatekey",
  "wrapped_private_key",
  "kek_salt",
  "agent_token",
  "session_token",
  "daemon_token",
];

/** Redige segredos num texto (mensagem de log, URL, descrição). */
export function scrubText(msg) {
  if (!msg) return "";
  let out = String(msg)
    .replace(BEARER_RE, "$1[REDACTED]")
    .replace(BOT_PATH_RE, "/bot$1:[REDACTED]")
    .replace(QS_RE, "$1=[REDACTED]")
    .replace(COOKIE_RE, "$1[REDACTED]")
    .replace(E2E_RE, "e2e:[REDACTED]")
    .replace(SK_RE, "[REDACTED]");
  const lower = out.toLowerCase();
  for (const term of SENSITIVE_TERMS) {
    if (lower.includes(term)) {
      const re = new RegExp(`(${term}["']?\\s*[:=]\\s*["']?)([^"',\\s}]+)`, "gi");
      out = out.replace(re, "$1[REDACTED]");
    }
  }
  return out;
}

/** Scrub recursivo para contextos (objects/arrays) do Sentry. */
export function scrubDeep(value) {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v);
    return out;
  }
  return value;
}
