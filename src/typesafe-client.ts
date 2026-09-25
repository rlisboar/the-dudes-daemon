/** Shared, fail-closed client for the daemon's Jev shadow calls. */
import { createHmac, hkdfSync } from "node:crypto";
import { redactCredentials, getProjectKey, isE2eEncrypted } from "./daemon-crypto.js";
import { safeFetch, type SafeFetchOpts } from "./ssrf-guard.js";

export const TYPESAFE_SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";
export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const TYPESAFE_MODEL = "jev-1.13.0";
export const OPENROUTER_DEFAULT_MODEL = "typesafe/jev-1.13";
export const TYPESAFE_TIMEOUT_MS = 2_500;
export const TYPESAFE_MAX_BODY_BYTES = 8 * 1024;
export const TYPESAFE_MAX_TEXTO_BYTES = 2 * 1024;
export const TYPESAFE_REFLECT_TITLE_BYTES = 512;

const DOMAIN_TEXT_HASH = "jev-text-hmac-v1";
const DOMAIN_REF_ID = "jev-ref-id-hmac-v1";
const REDACTED = "[REDACTED]";
const REDACTED_DB = "[REDACTED_DATABASE_URI]";

export type TypesafeProvider = "typesafe" | "openrouter";

let warnedUnknownProvider = false;

function selectedProvider(): TypesafeProvider | null {
  const configured = (process.env.TYPESAFE_PROVIDER ?? "typesafe").trim().toLowerCase();
  if (configured === "typesafe" || configured === "openrouter") return configured;
  if (!warnedUnknownProvider) {
    warnedUnknownProvider = true;
    try { console.warn("[typesafe-client] disabled: unknown TYPESAFE_PROVIDER"); } catch {}
  }
  return null;
}

interface ProviderConfig {
  provider: TypesafeProvider;
  url: string;
  apiKey: string;
}

function providerConfig(): ProviderConfig | null {
  const provider = selectedProvider();
  if (!provider) return null;
  return {
    provider,
    url: provider === "openrouter" ? OPENROUTER_DECISIONS_URL : TYPESAFE_SYSTEMONE_URL,
    apiKey: (process.env[provider === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY"] ?? "").trim(),
  };
}

function payloadForProvider(payload: unknown, provider: TypesafeProvider): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const configuredModel = (process.env.TYPESAFE_MODEL ?? "").trim();
  const current = payload as Record<string, unknown>;
  const currentModel = typeof current.model === "string" && current.model.trim() ? current.model : TYPESAFE_MODEL;
  const model = configuredModel || (provider === "openrouter" ? OPENROUTER_DEFAULT_MODEL : currentModel);
  return { ...current, model };
}

export interface TypesafeRequestInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export interface TypesafeFetchOpts {
  timeoutMs: number;
  maxRedirects: number;
}

export interface TypesafeResponse {
  status: number;
  text: () => Promise<string>;
}

export type TypesafeFetch = (
  url: string,
  init: TypesafeRequestInit,
  opts: TypesafeFetchOpts,
) => Promise<TypesafeResponse>;

const PRIVATE_KEY_MARKER = /-----BEGIN\s+(?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED)\s+)?PRIVATE KEY-----|openssh-key-v1|AGE-SECRET-KEY-/i;
const OPENSSH_KEY_LINE = /^\s*ssh-(?:rsa|ed25519|ecdsa-[^\s]+)\s+[A-Za-z0-9+/]{24,}={0,2}(?:\s|$)/im;
const SECRET_KEY_NAME = /(?:^|[_-])(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|COOKIE|SESSION|PRIVATE[_-]?KEY|JWT)$/i;
const SECRET_ASSIGNMENT = /(?:^|[\n,{\[]\s*)(?:export\s+)?["']?([A-Z0-9_.-]+)["']?\s*[:=]\s*(?:"[^"\n]+"|'[^'\n]+'|[^\s,}\]]+)/gim;
const STRUCTURED_CREDENTIAL = /(?:^|[\n,{\[]\s*)["']?(?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?\s*(?:bearer|basic)\s+\S+|(?:^|[\n,{\[]\s*)["']?(?:cookie|set-cookie)["']?\s*[:=]\s*["']?\s*\S+/im;
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*\s*=/gm;
const ENV_FILE_PATH = /(?:^|[\\/\s])\.env(?:\.[A-Za-z0-9_.-]+)?(?:$|[\s:'"`])/im;

const SECRET_TOKEN_PATTERNS: RegExp[] = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/gi,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/gi,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/gi,
  /\bxox[a-z0-9]*-[A-Za-z0-9-]{12,}\b/gi,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/gi,
  /\bnpm_[A-Za-z0-9_-]{16,}\b/gi,
  /\bpypi-[A-Za-z0-9_-]{16,}\b/gi,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gi,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];
const BASIC_CREDENTIAL = /\bBasic\s+([A-Za-z0-9+/]{8,}={0,2})/gi;

const DB_URI = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql):\/\/[^\s"'`<>]+/gi;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const CLOUD_VALUE = /\b(?:AccountKey|aws_(?:secret_access_key|session_token)|google_(?:api_key|application_credentials)|AZURE_STORAGE_(?:ACCOUNT_KEY|CONNECTION_STRING)|(?:connectionstring|connection_string))\s*[:=]\s*["']?[^\s,}"']+/gi;
const CLOUD_JSON_CREDENTIAL = /"(?:private_key|client_secret|access_token|refresh_token)"\s*:\s*"[^"]{8,}"/gi;

/** Checks an explicit feature flag and the server-side API key. */
export function typesafeLigado(flag: string): boolean {
  const value = (process.env[flag] ?? "").trim().toLowerCase();
  if (value !== "1" && value !== "true") return false;
  return !!providerConfig()?.apiKey;
}

function containsSecretAssignment(text: string): boolean {
  SECRET_ASSIGNMENT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SECRET_ASSIGNMENT.exec(text))) {
    if (SECRET_KEY_NAME.test(match[1] ?? "")) return true;
  }
  return false;
}

function temArquivoDeSegredo(text: string): boolean {
  if (PRIVATE_KEY_MARKER.test(text) || OPENSSH_KEY_LINE.test(text) || STRUCTURED_CREDENTIAL.test(text)) return true;
  if (containsSecretAssignment(text)) return true;

  const envLines = text.match(ENV_ASSIGNMENT) ?? [];
  if (envLines.length >= 1 && ENV_FILE_PATH.test(text)) return true;
  if (/(?:^|[\\/\s])(?:~\/)?\.ssh(?:\/[A-Za-z0-9_.-]+)?/im.test(text) && (text.includes("\n") || OPENSSH_KEY_LINE.test(text) || PRIVATE_KEY_MARKER.test(text))) return true;
  return false;
}

function redigirPadroes(text: string): string {
  let out = text;
  for (const pattern of SECRET_TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  out = out.replace(CLOUD_VALUE, REDACTED);
  out = out.replace(CLOUD_JSON_CREDENTIAL, REDACTED);
  out = out.replace(BASIC_CREDENTIAL, (match, encoded: string) => {
    try {
      return Buffer.from(encoded, "base64").toString("utf8").includes(":") ? REDACTED : match;
    } catch {
      return match;
    }
  });
  out = out.replace(DB_URI, REDACTED_DB);
  out = out.replace(URL_USERINFO, `$1${REDACTED}@`);
  return out;
}

function hasSecretMarker(text: string): boolean {
  return PRIVATE_KEY_MARKER.test(text) || OPENSSH_KEY_LINE.test(text) || STRUCTURED_CREDENTIAL.test(text) || containsSecretAssignment(text)
    || SECRET_TOKEN_PATTERNS.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    });
}

function decodeForSecretCheck(text: string): string | null {
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    if (/%[0-9a-f]{2}/i.test(text)) return null;
  }
  if (decoded !== text && (temArquivoDeSegredo(decoded) || hasSecretMarker(decoded))) return null;

  const base64Candidates = text.match(/\b[A-Za-z0-9+/_-]{24,}={0,2}\b/g) ?? [];
  for (const candidate of base64Candidates) {
    try {
      const plain = Buffer.from(candidate, "base64").toString("utf8");
      if (plain && (temArquivoDeSegredo(plain) || hasSecretMarker(plain))) return null;
    } catch {
      return null;
    }
  }
  return decoded;
}

/**
 * Redacts generic credentials and remembered credentials, then enforces a UTF-8
 * byte limit. `null` means fail closed; an empty result is insufficient signal.
 */
export function prepararTexto(
  texto: unknown,
  maxBytes = TYPESAFE_MAX_TEXTO_BYTES,
  projectId = "",
): string | null {
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return null;
    const raw = typeof texto === "string" ? texto : String(texto ?? "");
    if (!raw.trim() || isE2eEncrypted(raw.trim()) || temArquivoDeSegredo(raw)) return null;
    const decoded = decodeForSecretCheck(raw);
    if (decoded === null) return null;

    let safe = redactCredentials(projectId, raw);
    safe = redigirPadroes(safe);
    if (decoded !== raw) {
      // URL-encoded credential material is rejected rather than risk a missed variant.
      const decodedRedacted = redigirPadroes(redactCredentials(projectId, decoded));
      if (decodedRedacted !== decoded) return null;
    }

    const meaningful = safe.replace(/\[REDACTED(?:_DATABASE_URI)?\]/g, "").trim();
    if (!meaningful) return "";
    return truncarUtf8(safe, maxBytes);
  } catch {
    return null;
  }
}

function truncarUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "…";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes) return "";
  let out = "";
  for (const point of text) {
    if (Buffer.byteLength(out + point + marker, "utf8") > maxBytes) break;
    out += point;
  }
  return out ? `${out}${marker}` : "";
}

function projectDerivedKey(projectId: string, domain: string): Buffer | null {
  try {
    const projectKey = getProjectKey(projectId);
    if (!projectKey) return null;
    return Buffer.from(hkdfSync("sha256", projectKey, Buffer.alloc(0), domain, 32));
  } catch {
    return null;
  }
}

/** HMAC of text for the verdict. No key or derivation failure means no hash. */
export function hmacTexto(projectId: string, texto: string): string | null {
  const key = projectDerivedKey(projectId, DOMAIN_TEXT_HASH);
  if (!key) return null;
  try {
    return createHmac("sha256", key).update(texto, "utf8").digest("hex");
  } catch {
    return null;
  } finally {
    key.fill(0);
  }
}

/** Stable project-scoped opaque correlation id; uses its own HKDF domain. */
export function opaqueRefId(projectId: string, deliveryId: string): string | null {
  if (!deliveryId) return null;
  const key = projectDerivedKey(projectId, DOMAIN_REF_ID);
  if (!key) return null;
  try {
    return createHmac("sha256", key).update(deliveryId, "utf8").digest("hex");
  } catch {
    return null;
  } finally {
    key.fill(0);
  }
}

/** Serializes only a caller-whitelisted payload and enforces the actual wire cap. */
export function serializarRequestSombra(payload: unknown): string | null {
  try {
    const body = JSON.stringify(payload);
    if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > TYPESAFE_MAX_BODY_BYTES) return null;
    return body;
  } catch {
    return null;
  }
}

/** Real SystemOne POST. Fixed HTTPS endpoint, no redirects, one 2.5s deadline. */
export async function chamarSystemOne(
  payload: unknown,
  fetcher?: TypesafeFetch,
): Promise<TypesafeResponse | null> {
  const config = providerConfig();
  if (!config?.apiKey) return null;
  const body = serializarRequestSombra(payloadForProvider(payload, config.provider));
  if (!body) return null;
  const init: TypesafeRequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body,
    signal: AbortSignal.timeout(TYPESAFE_TIMEOUT_MS),
  };
  const opts = { timeoutMs: TYPESAFE_TIMEOUT_MS, maxRedirects: 0 };
  if (fetcher) return fetcher(config.url, init, opts);
  const response = await safeFetch(config.url, init, opts as SafeFetchOpts);
  return { status: response.status, text: () => response.text() };
}
