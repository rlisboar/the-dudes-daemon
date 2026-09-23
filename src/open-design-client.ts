/**
 * Cliente HTTP do daemon local do Open Design.
 * Só loopback. Path sem `..`. Escrita é POST/DELETE na API local.
 *
 * T-844 (queixa do dono): o teto era ÚNICO de 8s para tudo, e o catálogo de
 * agentes testa cada CLI do host — 15,9s medidos no 0.22.2, sempre abortado.
 * Agora o teto é por OPERAÇÃO, catálogo tem cache em memória com TTL e
 * fallback para o valor vencido, cada pedido deixa uma linha de log e
 * versions/restore — que só existem a partir da 0.23 — devolvem erro claro em
 * vez de lista vazia (na 0.22.2 a rota cai no curinga do arquivo e devolve o
 * Buffer do próprio arquivo).
 */

const PADRAO = "http://127.0.0.1:7456";
const TETO_ARQUIVO = 200_000;
/** Teto padrão por operação (projects/files/search/runs). */
const TETO_PADRAO_MS = 8_000;
/** Arquivo de entrada: o CLI responde grande, mas é local. */
const TETO_ARQUIVO_MS = 4_000;
/** Catálogo (agents/skills/plugins): agents testa cada CLI; plugins tem 3MB. */
const TETO_CATALOGO_MS = 30_000;
/** TTL do cache de catálogo. */
export const TTL_CATALOGO_MS = 10 * 60_000;
/** `GET /api/version` é usado no log/mensagem; quem decide o suporte é a resposta. */
export const OD_MIN_HISTORICO = "0.23.0";

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

export type NivelOd = "info" | "warn";
type LogOd = (nivel: NivelOd, msg: string) => void;

let logOd: LogOd = () => {};

/**
 * T-844: o daemon liga aqui o `log()` dele. Sem isso nenhum pedido
 * `open_design:*` aparecia no log e o dono não tinha como diagnosticar.
 */
export function setLogOd(fn: LogOd): void {
  logOd = fn;
}

function resumoErro(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/\s+/g, " ").trim().slice(0, 160);
}

/**
 * T-844: toda operação exportada passa por aqui — uma linha por pedido, com
 * operação, duração e status/erro. Conteúdo de arquivo nunca entra (só bytes).
 */
async function comLog<T>(op: string, fn: () => Promise<T>, resumo?: (v: T) => string): Promise<T> {
  const t0 = Date.now();
  try {
    const v = await fn();
    logOd("info", `[open_design] ${op} ok em ${Date.now() - t0}ms${resumo ? ` ${resumo(v)}` : ""}`);
    return v;
  } catch (e) {
    logOd("warn", `[open_design] ${op} erro em ${Date.now() - t0}ms: ${resumoErro(e)}`);
    throw e;
  }
}

interface EntradaCache {
  valor: unknown;
  criadoEm: number;
  expiraEm: number;
}

/** Marca de origem preenchida por comCache para o log da operação. */
interface Marca {
  origem?: "cache" | "cache-vencido";
}

const cache = new Map<string, EntradaCache>();
const emVoo = new Map<string, Promise<unknown>>();

/** Testes: cache e dedup limpos entre casos. */
export function _resetOdCacheForTest(): void {
  cache.clear();
  emVoo.clear();
}

/** Testes: vence as entradas sem esperar o TTL de 10min. */
export function _expirarCacheOdForTest(): void {
  for (const [chave, v] of cache) cache.set(chave, { ...v, expiraEm: 0 });
}

/**
 * Cache com TTL, dedup de chamadas simultâneas (a UI dispara agents+skills+
 * plugins de uma vez) e fallback para o valor vencido se o refresh falhar.
 */
async function comCache<T>(chave: string, fn: () => Promise<T>, marca?: Marca): Promise<T> {
  const agora = Date.now();
  const hit = cache.get(chave);
  if (hit && hit.expiraEm > agora) {
    if (marca) marca.origem = "cache";
    return hit.valor as T;
  }
  const voando = emVoo.get(chave);
  if (voando) {
    const v = await voando as T;
    if (marca) marca.origem = "cache";
    return v;
  }
  const p = fn().then(
    (v) => {
      emVoo.delete(chave);
      cache.set(chave, { valor: v, criadoEm: Date.now(), expiraEm: Date.now() + TTL_CATALOGO_MS });
      return v;
    },
    (e) => {
      emVoo.delete(chave);
      if (!hit) throw e;
      if (marca) marca.origem = "cache-vencido";
      logOd("warn", `[open_design] ${chave} falhou (${resumoErro(e)}) — servindo cache de ${Math.round((agora - hit.criadoEm) / 1000)}s atrás`);
      return hit.valor as T;
    },
  );
  emVoo.set(chave, p);
  return p;
}

async function pedir(url: string, init?: RequestInit, timeoutMs = TETO_PADRAO_MS): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const nome = (e as { name?: string })?.name;
    if (nome === "TimeoutError" || nome === "AbortError") throw new Error(`Open Design não respondeu em ${timeoutMs}ms`);
    throw e;
  }
}

async function lerJson(url: string, timeoutMs = TETO_PADRAO_MS): Promise<unknown> {
  const res = await pedir(url, undefined, timeoutMs);
  if (!res.ok) throw new Error(`Open Design HTTP ${res.status}`);
  return res.json();
}

async function enviarJson(url: string, method: "POST" | "DELETE", body?: unknown, timeoutMs?: number): Promise<unknown> {
  const res = await pedir(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, timeoutMs);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && typeof data === "object" && data && "error" in data ? JSON.stringify((data as { error: unknown }).error) : "";
    throw new Error(`Open Design HTTP ${res.status}${msg ? ` ${msg}` : ""}`.slice(0, 200));
  }
  return data;
}

function nomeSeguro(nome: string): string {
  const n = nome.trim();
  if (!n || n.length > 120 || /[\u0000-\u001f]/.test(n)) throw new Error("nome recusado");
  return n;
}

/** GET /api/version — quem decide o que a versão instalada suporta. */
export async function versaoOd(): Promise<string | null> {
  return comLog("version", () => comCache("version", async () => {
    const body = await lerJson(`${baseUrl()}/api/version`) as { version?: unknown };
    const v = body?.version;
    const s = typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { version?: unknown }).version === "string"
      ? (v as { version: string }).version
      : null;
    if (!s) throw new Error("Open Design não devolveu a versão");
    return s;
  }), (v) => `versao=${v ?? "desconhecida"}`);
}

/** Nota de log: no 0.22.x o histórico só existe para arquivos HTML. */
export function historicoNota(versao: string | null): string {
  const m = versao ? /^(\d+)\.(\d+)\./.exec(versao.trim()) : null;
  if (!m) return "suporte decidido pela resposta";
  return Number(m[1]) > 0 || Number(m[2]) >= 23 ? "suporte decidido pela resposta" : "só arquivos HTML têm histórico";
}

/**
 * T-844: quem decide se há histórico é a RESPOSTA, não a versão.
 *
 * Sondado no 0.22.2 stable do dono: `GET .../files/index.html/versions` devolve
 * 200 com `{file:{buffer…}, versions:[…]}` (a rota responde o arquivo junto), e
 * `…/files/MIGRATION.md/versions` devolve 400 `versions are only available for
 * HTML files`. O `POST .../versions/<id>/restore` funciona com id real e devolve
 * 404 `VERSION_NOT_FOUND` com id inválido — o card supunha rota inexistente.
 */
export const MSG_SO_HTML = "histórico de versões só existe para arquivos HTML nesta versão do Open Design";
export const MSG_VERSAO_NAO_ENCONTRADA = "versão não existe mais no Open Design (restore recusado)";

/** Corpo de erro curto da API (`{error:{code,message}}`), sem o resto. */
function erroDaApi(texto: string): string {
  try {
    const e = (JSON.parse(texto) as { error?: { code?: unknown; message?: unknown } }).error;
    const code = typeof e?.code === "string" ? e.code : "";
    const msg = typeof e?.message === "string" ? e.message.replace(/\s+/g, " ").slice(0, 120) : "";
    return [code, msg].filter(Boolean).join(" ");
  } catch {
    return "";
  }
}

export async function listarProjetosOd(): Promise<ProjetoOd[]> {
  return comLog("list", async () => {
    const body = await lerJson(`${baseUrl()}/api/projects`) as { projects?: unknown };
    const lista = Array.isArray(body?.projects) ? body.projects : [];
    return lista.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const o = item as Record<string, unknown>;
      if (typeof o.id !== "string" || typeof o.name !== "string") return [];
      return [{ id: o.id, name: o.name, designSystemId: typeof o.designSystemId === "string" ? o.designSystemId : null }];
    });
  }, (r) => `projetos=${r.length}`);
}

export async function listarArquivosOd(odProjectId: string): Promise<ArquivoOd[]> {
  const id = idSeguro(odProjectId);
  return comLog("files", async () => {
    const body = await lerJson(`${baseUrl()}/api/projects/${id}/files`) as { files?: unknown };
    const lista = Array.isArray(body?.files) ? body.files : [];
    return lista.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const o = item as Record<string, unknown>;
      if (typeof o.path !== "string" || typeof o.name !== "string") return [];
      if (o.type && o.type !== "file") return [];
      return [{ path: o.path, name: o.name, size: typeof o.size === "number" ? o.size : undefined }];
    });
  }, (r) => `arquivos=${r.length}`);
}

async function lerArquivoInterno(odProjectId: string, path: string): Promise<string> {
  const id = idSeguro(odProjectId);
  const rel = caminhoSeguro(path);
  const url = `${baseUrl()}/api/projects/${id}/files/${rel.split("/").map(encodeURIComponent).join("/")}`;
  const res = await pedir(url, { method: "GET" }, TETO_ARQUIVO_MS);
  if (!res.ok) throw new Error(`Open Design HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > TETO_ARQUIVO) throw new Error("arquivo grande demais para a aba");
  return buf.toString("utf8");
}

export async function lerArquivoOd(odProjectId: string, path: string): Promise<string> {
  return comLog("file", () => lerArquivoInterno(odProjectId, path), (r) => `bytes=${r.length}`);
}

export async function criarProjetoOd(name: string): Promise<{ id: string; name: string }> {
  return comLog("create_project", async () => {
    const data = await enviarJson(`${baseUrl()}/api/projects`, "POST", {
      id: crypto.randomUUID(),
      name: nomeSeguro(name),
    }) as { project?: { id?: string; name?: string } };
    const id = data.project?.id;
    const nome = data.project?.name ?? name;
    if (!id) throw new Error("Open Design não devolveu o id do projeto");
    return { id, name: nome };
  });
}

export async function apagarProjetoOd(odProjectId: string): Promise<void> {
  await comLog("delete_project", async () => {
    await enviarJson(`${baseUrl()}/api/projects/${encodeURIComponent(idSeguro(odProjectId))}`, "DELETE");
  });
}

export async function gravarArquivoOd(odProjectId: string, path: string, content: string): Promise<void> {
  if (content.length > TETO_ARQUIVO) throw new Error("arquivo grande demais para a aba");
  await comLog("write", async () => {
    await enviarJson(`${baseUrl()}/api/projects/${encodeURIComponent(idSeguro(odProjectId))}/files`, "POST", {
      name: caminhoSeguro(path),
      content,
      encoding: "utf8",
    });
  }, () => `bytes=${content.length}`);
}

export async function apagarArquivoOd(odProjectId: string, path: string): Promise<void> {
  const rel = caminhoSeguro(path);
  await comLog("delete_file", async () => {
    await enviarJson(`${baseUrl()}/api/projects/${encodeURIComponent(idSeguro(odProjectId))}/files/${encodeURIComponent(rel)}`, "DELETE");
  });
}

export async function listarSkillsOd(): Promise<string[]> {
  return comLog("skills", async () => {
    const lista = await comCache("skills", () => lerJson(`${baseUrl()}/api/skills`, TETO_CATALOGO_MS)) as { skills?: unknown };
    const itens = Array.isArray(lista?.skills) ? lista.skills : [];
    return itens.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (item && typeof item === "object" && typeof (item as { id?: string }).id === "string") return [(item as { id: string }).id];
      return [];
    });
  }, (r) => `itens=${r.length}`);
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
  return comLog("start_run", async () => {
    const data = await enviarJson(`${baseUrl()}/api/runs`, "POST", body) as { runId?: string; run?: { id?: string; status?: string } };
    const runId = data.runId ?? data.run?.id;
    if (!runId) throw new Error("Open Design não devolveu o run");
    return { runId, status: data.run?.status ?? "queued" };
  }, (r) => `status=${r.status ?? "?"}`);
}

export async function lerRunOd(runId: string): Promise<RunOd> {
  if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(runId)) throw new Error("run recusado");
  return comLog("run", async () => {
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
  }, (r) => `status=${r.status ?? "?"}`);
}

export async function cancelarRunOd(runId: string): Promise<void> {
  if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(runId)) throw new Error("run recusado");
  await comLog("cancel_run", async () => {
    await enviarJson(`${baseUrl()}/api/runs/${encodeURIComponent(runId)}/cancel`, "POST");
  });
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
  return comLog("search", async () => {
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
  }, (r) => `hits=${r.length}`);
}

/** GET do arquivo de entrada. O CLI não tem um GET /artifact; o conteúdo é o arquivo. */
export async function lerArtefatoOd(odProjectId: string, path: string): Promise<string> {
  return comLog("artifact", () => lerArquivoInterno(odProjectId, path), (r) => `bytes=${r.length}`);
}

export async function listarSkillsCatalogoOd(): Promise<ItemOd[]> {
  const marca: Marca = {};
  return comLog("skills", async () => {
    const body = await comCache("skills", () => lerJson(`${baseUrl()}/api/skills`, TETO_CATALOGO_MS), marca) as { skills?: unknown };
    return itensDe(body?.skills);
  }, (r) => `itens=${r.length} origem=${marca.origem ?? "rede"}`);
}

export async function listarPluginsOd(): Promise<ItemOd[]> {
  const marca: Marca = {};
  return comLog("plugins", async () => {
    const body = await comCache("plugins", () => lerJson(`${baseUrl()}/api/plugins`, TETO_CATALOGO_MS), marca) as { plugins?: unknown };
    return itensDe(body?.plugins);
  }, (r) => `itens=${r.length} origem=${marca.origem ?? "rede"}`);
}

export async function listarAgentsOd(): Promise<ItemOd[]> {
  const marca: Marca = {};
  return comLog("agents", async () => {
    // O teto de 30s existe porque esta rota testa cada CLI do host (15,9s medido).
    const body = await comCache("agents", () => lerJson(`${baseUrl()}/api/agents`, TETO_CATALOGO_MS), marca) as { agents?: unknown };
    return itensDe(body?.agents);
  }, (r) => `itens=${r.length} origem=${marca.origem ?? "rede"}`);
}

/** POST /api/projects/:id/duplicate { name }. */
export async function duplicarProjetoOd(odProjectId: string, name: string): Promise<ProjetoOd[]> {
  const id = idSeguro(odProjectId);
  return comLog("duplicate", async () => {
    await enviarCurto(`${baseUrl()}/api/projects/${encodeURIComponent(id)}/duplicate`, "POST", { name: nomeSeguro(name) });
    const body = await lerJson(`${baseUrl()}/api/projects`) as { projects?: unknown };
    const lista = Array.isArray(body?.projects) ? body.projects : [];
    return lista.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const o = item as Record<string, unknown>;
      if (typeof o.id !== "string" || typeof o.name !== "string") return [];
      return [{ id: o.id, name: o.name, designSystemId: typeof o.designSystemId === "string" ? o.designSystemId : null }];
    });
  }, (r) => `projetos=${r.length}`);
}

/** POST /api/projects/:id/design-system-copy { name }. */
export async function copiarDesignSystemOd(odProjectId: string, name: string): Promise<{ id: string; name: string; odProjectId: string }> {
  const id = idSeguro(odProjectId);
  const nome = nomeSeguro(name);
  return comLog("copy_design_system", async () => {
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
  });
}

function caminhoCodificado(path: string): string {
  return caminhoSeguro(path).split("/").map(encodeURIComponent).join("/");
}

/**
 * GET .../files/:path/versions.
 * T-844: na 0.22.2 a rota não existe no roteador — cai no curinga do arquivo e
 * devolve `{file:{buffer}}` (200, 200KB). Em vez de lista vazia silenciosa,
 * erro claro; o WEB esconde Versões/restore a partir dele.
 */
export async function listarVersoesOd(odProjectId: string, path: string): Promise<VersaoOd[]> {
  const id = idSeguro(odProjectId);
  const rel = caminhoCodificado(path);
  return comLog("versions", async () => {
    const body = await lerVersoes(id, rel);
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
  }, (r) => `versoes=${r.length}`);
}

/** POST .../versions/:id/restore e relê o arquivo. */
/** 400 "só HTML" e 404 "versão sumiu" viram mensagem clara; o resto sobe igual. */
async function lerVersoes(id: string, rel: string): Promise<{ versions?: unknown }> {
  const res = await pedir(`${baseUrl()}/api/projects/${encodeURIComponent(id)}/files/${rel}/versions`);
  const texto = await res.text().catch(() => "");
  if (res.ok) {
    try {
      return JSON.parse(texto) as { versions?: unknown };
    } catch {
      throw new Error("Open Design devolveu histórico ilegível");
    }
  }
  const detalhe = erroDaApi(texto);
  if (res.status === 400 && /only available for HTML/i.test(detalhe)) throw new Error(MSG_SO_HTML);
  throw new Error(`Open Design HTTP ${res.status}${detalhe ? ` ${detalhe}` : ""}`.slice(0, 200));
}

export async function restaurarVersaoOd(odProjectId: string, path: string, versionId: string): Promise<string> {
  const id = idSeguro(odProjectId);
  const rel = caminhoCodificado(path);
  const versao = tokenSeguro(versionId, "versão");
  return comLog("restore_version", async () => {
    const res = await pedir(
      `${baseUrl()}/api/projects/${encodeURIComponent(id)}/files/${rel}/versions/${encodeURIComponent(versao)}/restore`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    if (!res.ok) {
      const detalhe = erroDaApi(await res.text().catch(() => ""));
      if (res.status === 404) throw new Error(`${MSG_VERSAO_NAO_ENCONTRADA}${detalhe ? ` (${detalhe})` : ""}`);
      if (res.status === 400 && /only available for HTML/i.test(detalhe)) throw new Error(MSG_SO_HTML);
      throw new Error(`Open Design HTTP ${res.status}${detalhe ? ` ${detalhe}` : ""}`.slice(0, 200));
    }
    await res.text().catch(() => "");
    return lerArquivoInterno(odProjectId, path);
  }, (r) => `bytes=${r.length}`);
}

/** POST /api/runs/:id/steer { text }. O campo da CLI é `text`, não `message`. */
export async function guiarRunOd(runId: string, message: string): Promise<RunOd> {
  const id = runSeguro(runId);
  const text = textoSeguro(message, "mensagem", 8000);
  return comLog("steer", async () => {
    const data = await enviarCurto(`${baseUrl()}/api/runs/${encodeURIComponent(id)}/steer`, "POST", { text }) as {
      run?: { id?: string; status?: string; previewUrl?: string; agentMessage?: string };
    };
    return {
      runId: data.run?.id ?? id,
      status: data.run?.status,
      previewUrl: data.run?.previewUrl,
      message: data.run?.agentMessage,
    };
  }, (r) => `status=${r.status ?? "?"}`);
}
