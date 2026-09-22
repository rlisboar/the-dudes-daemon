/**
 * Cliente HTTP só de leitura do daemon local do Open Design.
 * Só loopback. Sem POST, sem path com `..`.
 */

const PADRAO = "http://127.0.0.1:7456";
const TETO_ARQUIVO = 200_000;

export interface ProjetoOd {
  id: string;
  name: string;
  designSystemId?: string | null;
}

export interface ArquivoOd {
  path: string;
  name: string;
  size?: number;
}

function baseUrl(): string {
  const cru = (process.env.OD_DAEMON_URL ?? PADRAO).trim().replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(cru); } catch { throw new Error("URL do Open Design inválida"); }
  const host = url.hostname;
  if (url.protocol !== "http:" || (host !== "127.0.0.1" && host !== "localhost")) {
    throw new Error("Open Design só é lido em loopback");
  }
  return url.origin;
}

function caminhoSeguro(path: string): string {
  const p = path.trim();
  if (!p || p.length > 400 || p.includes("\0") || p.includes("\\") || p.startsWith("/") || p.split("/").includes("..")) {
    throw new Error("caminho recusado");
  }
  return p;
}

function idSeguro(id: string): string {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) throw new Error("projeto recusado");
  return id;
}

async function lerJson(url: string): Promise<unknown> {
  const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`Open Design HTTP ${res.status}`);
  return res.json();
}

export async function listarProjetosOd(): Promise<ProjetoOd[]> {
  const body = await lerJson(`${baseUrl()}/api/projects`) as { projects?: unknown };
  const lista = Array.isArray(body?.projects) ? body.projects : [];
  return lista.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const o = item as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.name !== "string") return [];
    return [{ id: o.id, name: o.name, designSystemId: typeof o.designSystemId === "string" ? o.designSystemId : null }];
  });
}

export async function listarArquivosOd(odProjectId: string): Promise<ArquivoOd[]> {
  const id = idSeguro(odProjectId);
  const body = await lerJson(`${baseUrl()}/api/projects/${id}/files`) as { files?: unknown };
  const lista = Array.isArray(body?.files) ? body.files : [];
  return lista.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const o = item as Record<string, unknown>;
    if (typeof o.path !== "string" || typeof o.name !== "string") return [];
    if (o.type && o.type !== "file") return [];
    return [{ path: o.path, name: o.name, size: typeof o.size === "number" ? o.size : undefined }];
  });
}

export async function lerArquivoOd(odProjectId: string, path: string): Promise<string> {
  const id = idSeguro(odProjectId);
  const rel = caminhoSeguro(path);
  const url = `${baseUrl()}/api/projects/${id}/files/${rel.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`Open Design HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > TETO_ARQUIVO) throw new Error("arquivo grande demais para a aba");
  return buf.toString("utf8");
}
