/**
 * T-037: retry com backoff no cliente HTTP/socket do mcp-bridge.
 * Cobre 502, ECONNREFUSED e timeout durante restart do server ou
 * troca do bridge.sock no self-update.
 */

export function isTransientBridgeError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /502|503|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout|socket hang|ENOENT|EPIPE/i.test(m);
}

export async function withBridgeRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseDelayMs ?? 200;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === attempts - 1 || !isTransientBridgeError(e)) throw e;
      await sleep(base * 2 ** i);
    }
  }
  throw last;
}
