import * as dns from "node:dns/promises";
import * as net from "node:net";

/**
 * SSRF guard local do daemon. checkOutboundUrl do server cobre fetches no
 * orchestrator, mas o daemon executa request em rede do USER (LAN/local).
 * Server comprometido (ou MITM no /ws/daemon antes do TLS pin) poderia
 * fazer o daemon pivotar contra IMDS, redis, redes RFC1918 do user.
 *
 * Versão mais simples que `server/security.ts`: sem fetch com IP pin
 * (não temos undici instalado no daemon bundle). DNS rebinding entre
 * check e fetch é janela curta — aceita por enquanto.
 */

const PRIVATE_CIDRS = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^127\./,
  /^::1$/i,
  /^169\.254\./,
  /^fe80:/i,
  // ULA fc00::/7 cobre fc00:: até fdff:: — antes só fd__ era pego, fc__ furava.
  /^f[cd][0-9a-f]{2}:/i,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^0\./,
];

/** Extrai o IPv4 embutido de um endereço IPv4-mapped IPv6 pra re-testar
 *  contra os CIDRs v4. Cobre forma decimal (`::ffff:169.254.169.254`) e
 *  hex (`::ffff:7f00:1`). Sem isso, um host com AAAA mapeado fura o guard
 *  (dns.lookup devolve a string mapeada e nenhum regex casava). */
function unmapV4(ip: string): string | null {
  const m = /^::ffff:(.+)$/i.exec(ip);
  if (!m) return null;
  const rest = m[1];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return rest;
  const hm = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (hm) {
    const hi = parseInt(hm[1], 16);
    const lo = parseInt(hm[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

function isPrivateAddress(ip: string): boolean {
  if (PRIVATE_CIDRS.some((re) => re.test(ip))) return true;
  const v4 = unmapV4(ip);
  if (v4 && PRIVATE_CIDRS.some((re) => re.test(v4))) return true;
  return false;
}

export async function checkOutboundUrl(
  rawUrl: string,
  opts: { allowSchemes?: string[]; allowLocalhost?: boolean } = {},
): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return "URL inválida";
  }
  const allowed = opts.allowSchemes ?? ["http:", "https:"];
  if (!allowed.includes(u.protocol)) return `protocolo não permitido: ${u.protocol}`;
  const host = u.hostname.toLowerCase();
  if (opts.allowLocalhost && (host === "localhost" || host === "127.0.0.1" || host === "::1")) {
    return null;
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) return `endereço privado bloqueado: ${host}`;
    return null;
  }
  if (host === "localhost") return "localhost bloqueado";
  try {
    const records = await dns.lookup(host, { all: true });
    for (const r of records) {
      if (isPrivateAddress(r.address)) {
        return `host resolve para endereço privado: ${host} → ${r.address}`;
      }
    }
  } catch (e) {
    return `falha de DNS: ${(e as Error).message}`;
  }
  return null;
}

export interface SafeFetchOpts {
  allowSchemes?: string[];
  allowLocalhost?: boolean;
  maxRedirects?: number;
}

/**
 * fetch com re-checagem de SSRF em CADA redirect. O fetch nativo com
 * `redirect:"follow"` segue 30x sem revalidar o Location — uma URL que
 * passa no guard pode redirecionar pra IMDS/RFC1918/loopback. Aqui usamos
 * `redirect:"manual"` e revalidamos cada hop antes de segui-lo.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: SafeFetchOpts = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5;
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const ssrf = await checkOutboundUrl(current, opts);
    if (ssrf) throw new Error(`SSRF bloqueado: ${ssrf}`);
    const resp = await fetch(current, { ...init, redirect: "manual" });
    if (resp.status >= 300 && resp.status < 400 && resp.headers.has("location")) {
      const loc = resp.headers.get("location") as string;
      // Resolve Location relativo contra a URL atual; revalida no próximo loop.
      current = new URL(loc, current).toString();
      continue;
    }
    return resp;
  }
  throw new Error(`SSRF bloqueado: redirects demais (> ${maxRedirects})`);
}
