/**
 * SSRF guard do daemon.
 *
 * A implementação mora em `@the-dudes/net-guard`, compartilhada com o
 * orchestrator: as duas cópias que existiam aqui e em `server/security.ts`
 * já tinham divergido (esta não conhecia `::` nem o prefixo NAT64
 * `64:ff9b:`), então um host que resolvesse pra um deles passava aqui e era
 * barrado lá. Este arquivo continua existindo só como ponto de importação
 * pros call sites do daemon.
 *
 * Por que o daemon precisa de guard próprio: ele executa request na rede do
 * USUÁRIO (LAN, localhost, IMDS). Um orchestrator comprometido — ou um MITM
 * no /ws/daemon — não pode usá-lo como pivô.
 */
export { checkOutboundUrl, isPrivateAddress, safeFetch, unmapV4 } from "@the-dudes/net-guard";
export type { OutboundCheckOpts, SafeFetchOpts } from "@the-dudes/net-guard";
