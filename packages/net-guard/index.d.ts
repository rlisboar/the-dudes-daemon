import type { fetch as undiciFetch } from "undici";

export interface OutboundCheckOpts {
  /** Schemes aceitos. Default: ["http:", "https:"]. */
  allowSchemes?: string[];
  /** Libera localhost/127.0.0.1/::1. Só o daemon usa (fala com serviços locais). */
  allowLocalhost?: boolean;
}

export interface SafeFetchOpts extends OutboundCheckOpts {
  maxRedirects?: number;
}

export declare function unmapV4(ip: string): string | null;
export declare function isPrivateAddress(ip: string): boolean;

/** null = seguro; string = motivo da rejeição. */
export declare function checkOutboundUrl(rawUrl: string, opts?: OutboundCheckOpts): Promise<string | null>;

export declare function safeFetch(
  rawUrl: string,
  init?: Parameters<typeof undiciFetch>[1],
  opts?: SafeFetchOpts,
): ReturnType<typeof undiciFetch>;
