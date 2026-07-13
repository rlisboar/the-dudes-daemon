export type RunnerFailureKind =
  | "rate_limit"
  | "context_full"
  | "missing_session"
  | "authentication"
  | "aborted"
  | "transient_network"
  | "provider_error"
  | "other";

export const CONTEXT_FULL_PATTERNS = [
  /context.{0,20}(length|window|limit).{0,20}exceed/i,
  /exceed\w*.{0,40}context.{0,20}(window|limit|length)/i,
  /maximum.{0,20}(context|token)/i,
  /too many tokens/i,
  /prompt is too long/i,
  /reduce.{0,20}(message|token|context)/i,
];

export const RATE_LIMIT_TEXT_RE = /temporarily limiting requests|·\s*rate limited|\brate.?limit\w*\b|overloaded|too many requests|\b429\b|\b529\b/i;

const MISSING_SESSION_RE = /no conversation found with session id|session not found|couldn't (?:start|load|resume) session|no such session|404 not found/i;
const AUTHENTICATION_RE = /\b401\b|unauthoriz|invalid (?:or expired )?credentials|failed to authenticate|no auth context|auth_kind=bearer/i;
const ABORT_RE = /SIGKILL|SIGTERM|timed? ?out|timeout|aborted|terminated/i;
const TRANSIENT_NETWORK_RE = /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|network error|connection (?:reset|closed|lost)|temporar(?:y|ily) unavailable/i;
const LOOP_STOP_RE = /\[loop-stop\]|Conversation paused|loop detected|agent message limit reached|preventive mode active/i;

export function classifyRunnerFailure(message: string, code?: number | null): RunnerFailureKind {
  if (RATE_LIMIT_TEXT_RE.test(message)) return "rate_limit";
  if (CONTEXT_FULL_PATTERNS.some((pattern) => pattern.test(message))) return "context_full";
  if (MISSING_SESSION_RE.test(message)) return "missing_session";
  if (AUTHENTICATION_RE.test(message)) return "authentication";
  if (code === null || code === 137 || code === 143 || ABORT_RE.test(message)) return "aborted";
  if (TRANSIENT_NETWORK_RE.test(message)) return "transient_network";
  if (/^\s*API Error/i.test(message)) return "provider_error";
  return "other";
}

export const isMissingSessionFailure = (message: string): boolean => classifyRunnerFailure(message) === "missing_session";
export const isAuthenticationFailure = (message: string): boolean => classifyRunnerFailure(message) === "authentication";
export const isAbortedFailure = (message: string, code?: number | null): boolean => classifyRunnerFailure(message, code) === "aborted";
export const isLoopStopMessage = (message: string): boolean => LOOP_STOP_RE.test(message);
export const isApiErrorMessage = (message: string): boolean => /^\s*API Error/i.test(message);
