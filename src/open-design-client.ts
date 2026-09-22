/**
 * Cliente HTTP do daemon local do Open Design.
 * Só loopback. Path sem `..`. Escrita é POST/DELETE na API local.
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

async function pedir(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  return res;
}

async function lerJson(url: string): Promise<unknown> {
  const res = await pedir(url);
  if (!res.ok) throw new Error(`Open Design HTTP ${res.status}`);
  return res.json();
}

async function enviarJson(url: string, method: "POST" | "DELETE", body?: unknown): Promise<unknown> {
  const res = await pedir(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && typeof data === "object" && data && "error" in data ? JSON.stringify((data as { error: unknown }).error) : "";
    throw new Error(`Open Design HTTP ${res.status}${msg ? ` ${msg}` : ""}`);
  }
  return data;
}

function nomeSeguro(nome: string): string {
  const n = nome.trim();
  if (!n || n.length > 120 || /[\u0000-\u001f]/.test(n)) throw new Error("nome recusado");
  return n;
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

export async function criarProjetoOd(name: string): Promise<{ id: string; name: string }> {
  const data = await enviarJson(`${baseUrl()}/api/projects`, "POST", {
    id: crypto.randomUUID(),
    name: nomeSeguro(name),
  }) as { project?: { id?: string; name?: string } };
  const id = data.project?.id;
  const nome = data.project?.name ?? name;
  if (!id) throw new Error("Open Design não devolveu o id do projeto");
  return { id, name: nome };
}

export async function apagarProjetoOd(odProjectId: string): Promise<void> {
  await enviarJson(`${baseUrl()}/api/projects/${encodeURIComponent(idSeguro(odProjectId))}`, "DELETE");
}

export async function gravarArquivoOd(odProjectId: string, path: string, content: string): Promise<void> {
  if (content.length > TETO_ARQUIVO) throw new Error("arquivo grande demais para a aba");
  await enviarJson(`${baseUrl()}/api/projects/${encodeURIComponent(idSeguro(odProjectId))}/files`, "POST", {
    name: caminhoSeguro(path),
    content,
    encoding: "utf8",
  });
}

export async function apagarArquivoOd(odProjectId: string, path: string): Promise<void> {
  const rel = caminhoSeguro(path);
  await enviarJson(`${baseUrl()}/api/projects/${encodeURIComponent(idSeguro(odProjectId))}/files/${encodeURIComponent(rel)}`, "DELETE");
}

export async function listarSkillsOd(): Promise<string[]> {
  const body = await lerJson(`${baseUrl()}/api/skills`) as { skills?: unknown };
  const lista = Array.isArray(body?.skills) ? body.skills : [];
  return lista.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object" && typeof (item as { id?: string }).id === "string") return [(item as { id: string }).id];
    return [];
  });
}

export interface RunOd {
  runId: string;
  status?: string;
  previewUrl?: string;
  message?: string;
}

export async function iniciarRunOd(odProjectId: string, prompt: string, skillId?: string): Promise<RunOd> {
  const texto = prompt.trim();
  if (!texto || texto.length > 8000) throw new Error("pedido recusado");
  const body: Record<string, string> = { projectId: idSeguro(odProjectId), message: texto };
  if (skillId?.trim()) body.skillId = skillId.trim().slice(0, 120);
  const data = await enviarJson(`${baseUrl()}/api/runs`, "POST", body) as { runId?: string; run?: { id?: string; status?: string } };
  const runId = data.runId ?? data.run?.id;
  if (!runId) throw new Error("Open Design não devolveu o run");
  return { runId, status: data.run?.status ?? "queued" };
}

export async function lerRunOd(runId: string): Promise<RunOd> {
  if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(runId)) throw new Error("run recusado");
  const data = await lerJson(`${baseUrl()}/api/runs/${encodeURIComponent(runId)}`) as {
    runId?: string; id?: string; status?: string; previewUrl?: string; agentMessage?: string;
    run?: { id?: string; status?: string; previewUrl?: string; agentMessage?: string };
  };
  const run = data.run ?? data;
  return {
    runId: run.id ?? data.runId ?? runId,
    status: run.status,
    previewUrl: run.previewUrl,
    message: run.agentMessage,
  };
}

export async function cancelarRunOd(runId: string): Promise<void> {
  if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(runId)) throw new Error("run recusado");
  await enviarJson(`${baseUrl()}/api/runs/${encodeURIComponent(runId)}/cancel`, "POST");
}

export interface AcertoOd {
  path: string;
  name: string;
  snippet?: string;
}

export interface ItemOd {
  id: string;
  name?: string;
}

export interface VersaoOd {
  id: string;
  label?: string;
  createdAt?: string;
}

function tokenSeguro(id: string, rotulo: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(id)) throw new Error(`${rotulo} recusado`);
  return id;
}

function textoSeguro(valor: string, rotulo: string, teto: number): string {
  const t = valor.trim();
  if (!t || t.length > teto || t.includes("\0")) throw new Error(`${rotulo} recusado`);
  return t;
}

function runSeguro(runId: string): string {
  if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(runId)) throw new Error("run recusado");
  return runId;
}

/** Erro só com o status. O corpo da API não entra — pode ecoar o pedido. */
async function enviarCurto(url: string, method: "POST" | "DELETE", body?: unknown): Promise<unknown> {
  const res = await pedir(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Open Design HTTP ${res.status}`);
  return data;
}

function itensDe(lista: unknown, nomeDe?: (o: Record<string, unknown>) => string | undefined): ItemOd[] {
  if (!Array.isArray(lista)) return [];
  return lista.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const o = item as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id) return [];
    const name = nomeDe?.(o) ?? (typeof o.name === "string" ? o.name : typeof o.title === "string" ? o.title : undefined);
    return [name ? { id: o.id, name } : { id: o.id }];
  });
}

/** GET /api/projects/:id/search?q= — search_files do daemon local. */
export async function buscarArquivosOd(odProjectId: string, query: string): Promise<AcertoOd[]> {
  const id = idSeguro(odProjectId);
  const q = textoSeguro(query, "busca", 200);
  const url = `${baseUrl()}/api/projects/${encodeURIComponent(id)}/search?${new URLSearchParams({ q })}`;
  const body = await lerJson(url) as { matches?: unknown; hits?: unknown; results?: unknown };
  const lista = body.matches ?? body.hits ?? body.results;
  if (!Array.isArray(lista)) return [];
  return lista.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const o = item as Record<string, unknown>;
    const path = typeof o.path === "string" ? o.path : typeof o.file === "string" ? o.file : "";
    if (!path) return [];
    const name = typeof o.name === "string" && o.name ? o.name : path.split("/").pop() || path;
    const snippet = typeof o.snippet === "string" ? o.snippet.replace(/\s+/g, " ").slice(0, 180) : undefined;
    return [{ path, name, ...(snippet ? { snippet } : {}) }];
  }).slice(0, 200);
}

/** GET do arquivo de entrada. O CLI não tem um GET /artifact; o conteúdo é o arquivo. */
export async function lerArtefatoOd(odProjectId: string, path: string): Promise<string> {
  return lerArquivoOd(odProjectId, path);
}

export async function listarSkillsCatalogoOd(): Promise<ItemOd[]> {
  const body = await lerJson(`${baseUrl()}/api/skills`) as { skills?: unknown };
  return itensDe(body.skills);
}

export async function listarPluginsOd(): Promise<ItemOd[]> {
  const body = await lerJson(`${baseUrl()}/api/plugins`) as { plugins?: unknown };
  return itensDe(body.plugins);
}

export async function listarAgentsOd(): Promise<ItemOd[]> {
  const body = await lerJson(`${baseUrl()}/api/agents`) as { agents?: unknown };
  return itensDe(body.agents);
}

/** POST /api/projects/:id/duplicate { name }. */
export async function duplicarProjetoOd(odProjectId: string, name: string): Promise<ProjetoOd[]> {
  const id = idSeguro(odProjectId);
  await enviarCurto(`${baseUrl()}/api/projects/${encodeURIComponent(id)}/duplicate`, "POST", { name: nomeSeguro(name) });
  return listarProjetosOd();
}

/** POST /api/projects/:id/design-system-copy { name }. */
export async function copiarDesignSystemOd(odProjectId: string, name: string): Promise<{ id: string; name: string; odProjectId: string }> {
  const id = idSeguro(odProjectId);
  const nome = nomeSeguro(name);
  const data = await enviarCurto(
    `${baseUrl()}/api/projects/${encodeURIComponent(id)}/design-system-copy`,
    "POST",
    { name: nome },
  ) as { designSystemId?: string; designSystem?: { id?: string; name?: string }; project?: { id?: string; name?: string } };
  const dsId = data.designSystem?.id ?? data.designSystemId;
  if (!dsId) throw new Error("Open Design não devolveu o design system");
  return {
    id: dsId,
    name: data.designSystem?.name ?? data.project?.name ?? nome,
    odProjectId: data.project?.id ?? id,
  };
}

function caminhoCodificado(path: string): string {
  return caminhoSeguro(path).split("/").map(encodeURIComponent).join("/");
}

/** GET .../files/:path/versions. */
export async function listarVersoesOd(odProjectId: string, path: string): Promise<VersaoOd[]> {
  const id = idSeguro(odProjectId);
  const rel = caminhoCodificado(path);
  const body = await lerJson(`${baseUrl()}/api/projects/${encodeURIComponent(id)}/files/${rel}/versions`) as { versions?: unknown };
  if (!Array.isArray(body.versions)) return [];
  return body.versions.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const o = item as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id) return [];
    const label = typeof o.label === "string" && o.label
      ? o.label
      : typeof o.prompt === "string" && o.prompt.trim()
        ? o.prompt.trim().replace(/\s+/g, " ").slice(0, 80)
        : typeof o.version === "number"
          ? `v${o.version}`
          : undefined;
    let createdAt: string | undefined;
    if (typeof o.createdAt === "string") createdAt = o.createdAt;
    else if (typeof o.createdAt === "number" && Number.isFinite(o.createdAt)) createdAt = new Date(o.createdAt).toISOString();
    return [{ id: o.id, ...(label ? { label } : {}), ...(createdAt ? { createdAt } : {}) }];
  });
}

/** POST .../versions/:id/restore e relê o arquivo. */
export async function restaurarVersaoOd(odProjectId: string, path: string, versionId: string): Promise<string> {
  const id = idSeguro(odProjectId);
  const rel = caminhoCodificado(path);
  const versao = tokenSeguro(versionId, "versão");
  await enviarCurto(
    `${baseUrl()}/api/projects/${encodeURIComponent(id)}/files/${rel}/versions/${encodeURIComponent(versao)}/restore`,
    "POST",
    {},
  );
  return lerArquivoOd(odProjectId, path);
}

/** POST /api/runs/:id/steer { text }. O campo da CLI é `text`, não `message`. */
export async function guiarRunOd(runId: string, message: string): Promise<RunOd> {
  const id = runSeguro(runId);
  const text = textoSeguro(message, "mensagem", 8000);
  const data = await enviarCurto(`${baseUrl()}/api/runs/${encodeURIComponent(id)}/steer`, "POST", { text }) as {
    run?: { id?: string; status?: string; previewUrl?: string; agentMessage?: string };
  };
  return {
    runId: data.run?.id ?? id,
    status: data.run?.status,
    previewUrl: data.run?.previewUrl,
    message: data.run?.agentMessage,
  };
}
