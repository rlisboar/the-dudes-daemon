/* global AbortSignal */
import * as dns from "node:dns/promises";
import * as net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

// Teto default de egress: sem isto um upstream lento pendura o request
// indefinidamente (undici não desiste sozinho). Callers com signal próprio
// mantêm o deles; `opts.timeoutMs: null` desliga.
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Guard de SSRF compartilhado entre orchestrator e daemon.
 *
 * Antes cada um tinha a sua cópia da lista de CIDRs e elas já haviam
 * divergido: o daemon não conhecia `::` (unspecified) nem o prefixo NAT64
 * `64:ff9b:`, então um host que resolvesse pra um deles passava no daemon e
 * era barrado no server. Duplicata sem vínculo garante que o próximo CIDR
 * adicionado entre em um lugar só — por isso a lista mora aqui agora.
 *
 * O daemon importa isto porque ele faz request na rede do USUÁRIO (LAN,
 * localhost, IMDS): um orchestrator comprometido não pode usá-lo de pivô.
 */

const PRIVATE_CIDRS = [
  // RFC1918
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  // Loopback
  /^127\./,
  /^::1$/i,
  // Link-local (cobre o metadata 169.254.169.254)
  /^169\.254\./,
  // Link-local v6 fe80::/10 — cobre fe80:: até febf:: (não só fe80:).
  /^fe[89ab][0-9a-f]:/i,
  // ULA fc00::/7 — cobre fc00:: até fdff:: (fd00:ec2::254 é o IMDS v6 da AWS)
  /^f[cd][0-9a-f]{2}:/i,
  // CGNAT 100.64.0.0/10
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  // Multicast v4 224.0.0.0/4 (inclui SSDP 239.255.255.250, descoberta de LAN)
  /^2(2[4-9]|3[0-9])\./,
  // Reservado/futuro 240.0.0.0/4 + broadcast 255.255.255.255
  /^2(4[0-9]|5[0-5])\./,
  // Multicast v6 ff00::/8
  /^ff[0-9a-f]{2}:/i,
  // unspecified
  /^0\./,
  /^::$/,
  // NAT64 well-known prefix
  /^64:ff9b:/i,
];

/** Extrai o IPv4 embutido num IPv6 IPv4-mapped, pra re-testar contra os CIDRs
 *  v4. Cobre a forma decimal (`::ffff:169.254.169.254`) e a hex
 *  (`::ffff:7f00:1`). Sem isso um host com AAAA mapeado furava o guard. */
export function unmapV4(ip) {
  const m = /^::ffff:(.+)$/i.exec(ip.toLowerCase());
  if (!m) return null;
  const rest = m[1];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return rest;
  const hm = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (hm) {
    const hi = parseInt(hm[1], 16);
    const lo = parseInt(hm[2], 16);
    if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
      return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    }
  }
  return null;
}

/** Extrai IPv4 embutido em formas que o unmapV4 (só `::ffff:`) não cobre:
 *  IPv4-compatible (`::7f00:1` == `::127.0.0.1`) e 6to4 (`2002:AABB:CCDD::`).
 *  Sem isto, `::127.0.0.1` e `2002:7f00:1::1` furavam o guard como "público". */
export function embeddedV4(ip) {
  const norm = ip.toLowerCase();
  // IPv4-compatible ::a.b.c.d / ::hi:lo — exclui ::1 e :: (já cobertos por CIDR).
  let m = /^::((?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]{1,4}:[0-9a-f]{1,4})$/i.exec(norm);
  if (m) {
    const rest = m[1];
    if (rest.includes(".")) return rest;
    const hm = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
    if (hm) {
      const hi = parseInt(hm[1], 16);
      const lo = parseInt(hm[2], 16);
      if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
        return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
      }
    }
  }
  // 6to4 2002:AABB:CCDD::/48 embute A.B.C.D nos dois hextets após 2002:.
  m = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i.exec(norm);
  if (m) {
    const hi = parseInt(m[1], 16);
    const lo = parseInt(m[2], 16);
    if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
      return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    }
  }
  return null;
}

export function isPrivateAddress(ip) {
  // Strip de colchetes: `new URL("http://[::1]/").hostname` devolve "[::1]",
  // então sem isto net.isIP falha e todo literal IPv6 furava o guard.
  const norm = ip.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (PRIVATE_CIDRS.some((re) => re.test(norm))) return true;
  const v4 = unmapV4(norm) ?? embeddedV4(norm);
  return v4 !== null && PRIVATE_CIDRS.some((re) => re.test(v4));
}

function isLoopbackLiteral(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Checa risco de SSRF numa URL de saída. Devolve null se ok, ou a razão.
 *
 * Resolve o hostname por DNS pra pegar nome público apontando pra IP privado.
 * Contra DNS rebinding entre o check e o request, use `safeFetch`, que pina
 * o IP no socket.
 *
 * `allowLocalhost` existe pro daemon, que legitimamente fala com serviços
 * locais (opencode serve em 127.0.0.1). O orchestrator não passa essa opção.
 */
export async function checkOutboundUrl(rawUrl, opts = {}) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return "URL inválida";
  }
  const allowed = opts.allowSchemes ?? ["http:", "https:"];
  if (!allowed.includes(u.protocol)) return `protocolo não permitido: ${u.protocol}`;
  // hostname vem com colchetes em literal IPv6 ("[::1]") — remove pra net.isIP.
  const host = u.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (opts.allowLocalhost && isLoopbackLiteral(host)) return null;
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) return `endereço privado bloqueado: ${host}`;
    return null;
  }
  // `localhost` barrado explicitamente: não depende do resolver local, que
  // pode ter sido apontado pra outro lugar.
  if (host === "localhost") return "localhost bloqueado";
  try {
    const records = await dns.lookup(host, { all: true });
    for (const r of records) {
      if (isPrivateAddress(r.address)) {
        return `host resolve para endereço privado: ${host} → ${r.address}`;
      }
    }
  } catch (e) {
    return `falha de DNS: ${e.message}`;
  }
  return null;
}

/**
 * fetch com re-checagem de SSRF e PIN de IP em CADA hop.
 *
 * - `redirect:"manual"` + revalida cada Location: o fetch normal segue 30x sem
 *   checar, então uma URL aprovada podia redirecionar pra IMDS/RFC1918.
 * - Pina o IP resolvido no socket (undici Agent.connect.lookup), fechando o
 *   DNS rebinding entre o check e o connect. O hostname original segue indo
 *   em SNI/Host, então cert continua validando.
 */
export async function safeFetch(rawUrl, init = {}, opts = {}) {
  const maxRedirects = opts.maxRedirects ?? 5;
  // Timeout total da cadeia (todos os hops). `opts.timeoutMs === null` desliga.
  // Se o caller já passa init.signal, respeita o dele e não sobrepõe.
  const timeoutMs = opts.timeoutMs === null ? null : (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = init.signal ?? (timeoutMs != null ? AbortSignal.timeout(timeoutMs) : undefined);
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const ssrf = await checkOutboundUrl(current, opts);
    if (ssrf) throw new Error(`SSRF bloqueado: ${ssrf}`);
    const u = new URL(current);
    const host = u.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
    let pinned;
    if (net.isIP(host)) {
      pinned = { address: host, family: net.isIPv6(host) ? 6 : 4 };
    } else {
      const records = await dns.lookup(host, { all: true });
      if (records.length === 0) throw new Error(`SSRF bloqueado: DNS vazio para ${host}`);
      const ok = records.find(
        (r) => !isPrivateAddress(r.address) || (!!opts.allowLocalhost && isLoopbackLiteral(r.address)),
      );
      if (!ok) throw new Error(`SSRF bloqueado: ${host} resolve só pra IP privado`);
      pinned = { address: ok.address, family: ok.family === 6 ? 6 : 4 };
    }
    const dispatcher = new Agent({
      connect: {
        // undici passa {all:true} → o callback tem que devolver ARRAY nesse
        // caso, senão estoura "Invalid IP".
        lookup: (_h, o, cb) => {
          if (o && o.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
          else cb(null, pinned.address, pinned.family);
        },
      },
    });
    const resp = await undiciFetch(current, { ...init, ...(signal ? { signal } : {}), dispatcher, redirect: "manual" });
    if (resp.status >= 300 && resp.status < 400 && resp.headers.has("location")) {
      current = new URL(resp.headers.get("location"), current).toString();
      continue;
    }
    return resp;
  }
  throw new Error(`SSRF bloqueado: redirects demais (> ${maxRedirects})`);
}
