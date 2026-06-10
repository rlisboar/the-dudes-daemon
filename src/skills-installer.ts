/**
 * AgentSkills v2 — install via ClawHub.
 *
 * Recebe { downloadUrl, slug, version? } do orchestrator, baixa o
 * artefato ZIP direto do ClawHub, extrai numa subpasta isolada de
 * `<workspace>/skills/<name>/`, e re-dispara o scanner.
 *
 * Validações:
 *   - Tamanho < 5 MiB (anti-flood)
 *   - SKILL.md obrigatório dentro do ZIP
 *   - Filenames devem ser POSIX-relative; reject `/`, `..`, NULL bytes
 *   - Sem permissões executáveis preservadas — escreve 0644
 *   - Atomic: extrai num tmp dir, valida, depois move pra final
 *     (rollback simples se algo falhar)
 *
 * Sem dep externa de unzip: usa o módulo nativo `node:zlib` +
 * mini parser de central-directory ZIP. Suporta entries STORE (0) e
 * DEFLATE (8) — formato emitido pelo ClawHub.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";

/** Lê metadata de origem de uma skill já instalada. Retorna null se a
 *  pasta não existe ou não tem o arquivo (skill manual). */
async function readInstalledFrom(dir: string): Promise<{ source: string; slug: string } | null> {
  try {
    const raw = await fs.readFile(path.join(dir, ".installed-from.json"), "utf8");
    const j = JSON.parse(raw);
    if (j && typeof j.source === "string" && typeof j.slug === "string") {
      return { source: j.source, slug: j.slug };
    }
  } catch { /* ausente ou inválido */ }
  return null;
}

/** Sufixo curto e determinístico pra desambiguar nomes colidentes. */
function shortSuffixFromSlug(slug: string): string {
  return createHash("sha1").update(slug).digest("hex").slice(0, 6);
}

const inflateRawP = promisify(inflateRaw);

/** Cap default — ClawHub é per-skill ZIP enxuto, raramente >1MB. */
const MAX_BYTES_DEFAULT = 5 * 1024 * 1024;
/** Cap pra GitHub repo zips (SkillsMP) — repo inteiro vem; filtramos
 *  por subPath na extração mas o download bruto pode ser maior. */
const MAX_BYTES_GITHUB = 50 * 1024 * 1024;
const MAX_FILES = 5000; // GitHub repos podem ter muitos arquivos; só extraímos sob subPath
const MAX_FILE_SIZE = 1 * 1024 * 1024;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** Parse the End-Of-Central-Directory record + read the central
 *  directory. Returns one entry per file. */
function parseCentralDirectory(buf: Buffer): ZipEntry[] {
  // EOCD signature 0x06054b50, max comment 65535 → search backwards
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("ZIP: EOCD not found");
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const totalEntries = buf.readUInt16LE(eocd + 10);

  const entries: ZipEntry[] = [];
  let cur = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(cur) !== 0x02014b50) throw new Error(`ZIP: bad CD signature at ${cur}`);
    const method = buf.readUInt16LE(cur + 10);
    const compressedSize = buf.readUInt32LE(cur + 20);
    const uncompressedSize = buf.readUInt32LE(cur + 24);
    const nameLen = buf.readUInt16LE(cur + 28);
    const extraLen = buf.readUInt16LE(cur + 30);
    const commentLen = buf.readUInt16LE(cur + 32);
    const localHeaderOffset = buf.readUInt32LE(cur + 42);
    const name = buf.toString("utf8", cur + 46, cur + 46 + nameLen);
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    cur += 46 + nameLen + extraLen + commentLen;
  }
  // Sanity — defend against header corruption advancing past buf
  if (cur > cdOffset + cdSize + 1) throw new Error("ZIP: CD overflow");
  return entries;
}

/** Read the file body for a single entry from the local header. */
async function readEntryBody(buf: Buffer, e: ZipEntry): Promise<Buffer> {
  if (buf.readUInt32LE(e.localHeaderOffset) !== 0x04034b50) {
    throw new Error(`ZIP: bad LFH at ${e.localHeaderOffset}`);
  }
  const lfhNameLen = buf.readUInt16LE(e.localHeaderOffset + 26);
  const lfhExtraLen = buf.readUInt16LE(e.localHeaderOffset + 28);
  const dataStart = e.localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
  const compressed = buf.subarray(dataStart, dataStart + e.compressedSize);
  if (e.method === 0) return Buffer.from(compressed);
  if (e.method === 8) {
    // maxOutputLength aborta com RangeError se o DEFLATE expandir além do cap
    // (anti decompression-bomb). uncompressedSize vem da central directory e é
    // controlado pelo atacante, então NÃO confiamos nele — bound na inflação.
    return await inflateRawP(compressed, { maxOutputLength: MAX_FILE_SIZE }) as Buffer;
  }
  throw new Error(`ZIP: unsupported method ${e.method}`);
}

/** Sanitiza um nome pra uso como diretório de skill. O `name:` do
 *  frontmatter do SKILL.md e o `slug` vêm de fonte NÃO-confiável (repos
 *  GitHub / catálogos hub). Sem isto, `name: ../../../home/user/.bashrc`
 *  escaparia de workspaceSkillsRoot → escrita arbitrária + rm recursivo
 *  num path traversado. Strip de tudo que não seja [A-Za-z0-9._-] elimina
 *  separadores/NUL/espaços, garantindo que o resultado é um ÚNICO segmento
 *  de path (nunca traversa). Remove dots/hífens das pontas (evita "..",
 *  dotfiles). Retorna "" se nada sobrar — o caller decide o fallback. */
function sanitizeSkillName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 128);
}

/** Garante que `target` resolve pra dentro de `base` (defesa em profundidade
 *  além da sanitização de nome). */
function assertInside(base: string, target: string): void {
  const b = path.resolve(base);
  const t = path.resolve(target);
  if (t !== b && !t.startsWith(b + path.sep)) {
    throw new Error(`skill dir escapou da base: ${target}`);
  }
}

/** Throw if the entry name is unsafe for filesystem extract. */
function ensureSafePath(name: string): string {
  if (!name) throw new Error("entry name empty");
  if (name.includes("\0")) throw new Error("entry name has NULL byte");
  if (path.isAbsolute(name)) throw new Error(`absolute path rejected: ${name}`);
  const norm = path.posix.normalize(name);
  if (norm.startsWith("../") || norm.includes("/../") || norm === "..") {
    throw new Error(`traversal rejected: ${name}`);
  }
  return norm;
}

export interface InstallInput {
  downloadUrl: string;
  /** Slug do registry de origem — fallback de nome quando SKILL.md não tem. */
  slug: string;
  /** Diretório raiz de skills do workspace. Geralmente `<workspaceRoot>/skills`. */
  workspaceSkillsRoot: string;
  /** Subpath dentro do ZIP que contém a skill. Usado pra GitHub repo
   *  zips (SkillsMP). Se omitido, daemon procura SKILL.md em qualquer
   *  nível como antes (ClawHub). */
  subPath?: string;
  /** Override do cap de bytes — sobe pra 50MB se GitHub. */
  maxBytes?: number;
  /** Registry de origem — usado pra distinguir skills com mesmo nome
   *  canônico vindas de fontes diferentes. Salvo em `.installed-from.json`.
   *  String livre (clawhub/skillsmp/agentskill/skills.sh/etc). */
  source?: string;
}

export interface InstallResult {
  installedAt: string;
  /** Nome canônico (lido do SKILL.md.frontmatter.name; fallback = slug). */
  name: string;
}

export async function installSkillFromClawHub(input: InstallInput): Promise<InstallResult> {
  const maxBytes = input.maxBytes ?? MAX_BYTES_DEFAULT;
  // SSRF + scheme guard: orchestrator manda downloadUrl; orch comprometido
  // poderia apontar pra IMDS/redis/redes RFC1918. Force https-only — skill
  // download deve sempre ser TLS (integridade + auth do CDN). file://,
  // ftp://, http:// bloqueados.
  // safeFetch força https-only E revalida cada redirect — fetch com
  // redirect:"follow" seguia 30x sem re-checar, então uma downloadUrl
  // válida podia 302 pra http://169.254.169.254/ ou host interno. Pior
  // que webhook: este path baixa+extrai+executa a skill.
  const { safeFetch } = await import("./ssrf-guard.js");
  // 1) download — fetch nativo (Node 18+); cap por Content-Length e por bytes
  //    consumidos (servidor podia mentir no header).
  const res = await safeFetch(
    input.downloadUrl,
    { headers: { Accept: "application/zip", "User-Agent": "the-dudes-daemon (skill-install)" } },
    { allowSchemes: ["https:"] },
  );
  if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`);
  const declaredLen = Number(res.headers.get("content-length") ?? 0);
  if (declaredLen && declaredLen > maxBytes) throw new Error(`artifact too large: ${declaredLen} bytes`);
  // Lê o corpo por STREAM com teto — arrayBuffer() carregaria o corpo inteiro
  // na RAM antes do check (host sem/mentindo Content-Length derrubava o daemon
  // por OOM com vários GB antes da linha de validação rodar).
  const reader = (res.body as any).getReader?.();
  let zip: Buffer;
  if (reader) {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { try { await reader.cancel(); } catch {} throw new Error(`artifact too large: > ${maxBytes} bytes`); }
      chunks.push(Buffer.from(value));
    }
    zip = Buffer.concat(chunks);
  } else {
    const arrBuf = await res.arrayBuffer();
    if (arrBuf.byteLength > maxBytes) throw new Error(`artifact too large: ${arrBuf.byteLength} bytes`);
    zip = Buffer.from(arrBuf);
  }

  // 2) parse central directory + validate manifest exists
  const entries = parseCentralDirectory(zip);
  if (entries.length === 0) throw new Error("ZIP empty");
  if (entries.length > MAX_FILES) throw new Error(`too many files (${entries.length} > ${MAX_FILES})`);

  // Estratégia de prefix:
  //  1) Se input.subPath veio (SkillsMP), determinar prefix de top-level
  //     do GitHub zip (ex: "<repo>-<branch>/") + appendar subPath.
  //  2) Senão (ClawHub), procurar SKILL.md em qualquer lugar e usar a
  //     pasta dele como prefix.
  let prefix = "";
  const skillEntries = entries.filter((e) => !e.name.endsWith("/"));

  if (input.subPath) {
    // GitHub zip envelopa em "<repo>-<branch>/...". Achar o primeiro
    // segmento e prefixar com ele + subPath.
    const firstEntry = skillEntries[0];
    if (!firstEntry) throw new Error("ZIP sem entries");
    const topLevel = firstEntry.name.split("/")[0];
    if (!topLevel) throw new Error("ZIP sem top-level dir");
    prefix = `${topLevel}/${input.subPath.replace(/^\/+|\/+$/g, "")}/`;
    const skillMd = skillEntries.find((e) => ensureSafePath(e.name) === `${prefix}SKILL.md`);
    if (!skillMd) throw new Error(`SKILL.md missing em ${input.subPath}`);
  } else {
    const skillMd = skillEntries.find((e) => {
      const safe = ensureSafePath(e.name);
      return safe.endsWith("SKILL.md");
    });
    if (!skillMd) throw new Error("SKILL.md missing from artifact");
    const skillMdSafe = ensureSafePath(skillMd.name);
    if (skillMdSafe !== "SKILL.md") {
      const idx = skillMdSafe.lastIndexOf("/SKILL.md");
      prefix = idx >= 0 ? skillMdSafe.slice(0, idx + 1) : "";
    }
  }

  // 3) extract pra tmp dir, depois move pra <workspaceSkillsRoot>/<name>
  const tmpDir = path.join(tmpdir(), `td-skill-${randomBytes(8).toString("hex")}`);
  await fs.mkdir(tmpDir, { recursive: true });

  let totalBytes = 0;
  let canonicalName = input.slug;
  try {
    for (const e of skillEntries) {
      const safe = ensureSafePath(e.name);
      // Entries fora do prefix são lixo — pulamos. Em GitHub zips isto
      // descarta o resto do repo, mantendo só a pasta da skill.
      if (prefix && !safe.startsWith(prefix)) continue;
      const rel = prefix ? safe.slice(prefix.length) : safe;
      if (!rel) continue;
      if (e.uncompressedSize > MAX_FILE_SIZE) {
        throw new Error(`file too large: ${rel}`);
      }
      const data = await readEntryBody(zip, e);
      totalBytes += data.length;
      // Cap independente do download — limite uncompressed individual da skill.
      if (totalBytes > MAX_BYTES_DEFAULT) throw new Error("uncompressed skill content exceeded cap");
      const dest = path.join(tmpDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, data, { mode: 0o644 });
    }

    // Lê SKILL.md pra extrair o name canônico do frontmatter
    const skillMdContent = await fs.readFile(path.join(tmpDir, "SKILL.md"), "utf8");
    const m = /^---\s*\n([\s\S]*?)\n---/.exec(skillMdContent);
    if (m) {
      const nameMatch = /^name:\s*(.+)$/m.exec(m[1]);
      if (nameMatch) canonicalName = nameMatch[1].trim().replace(/^["']|["']$/g, "");
    }

    const installedFrom = {
      source: input.source ?? "clawhub",
      slug: input.slug,
      installedAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(tmpDir, ".installed-from.json"),
      JSON.stringify(installedFrom, null, 2),
      { mode: 0o644 },
    );

    // 4) Resolve nome final, evitando sobrescrever skill já instalada
    //    com mesmo nome canônico mas (source, slug) diferentes.
    //    Política:
    //      - Pasta inexistente → usa canonicalName direto
    //      - Pasta existe + .installed-from.json bate (source+slug) →
    //        sobrescreve (reinstall/upgrade da MESMA skill)
    //      - Pasta existe + slug diferente OU sem metadata →
    //        sufixa nome com hash curto do slug pra não colidir
    await fs.mkdir(input.workspaceSkillsRoot, { recursive: true });
    // Sanitiza o nome (frontmatter OU slug, ambos não-confiáveis) antes de
    // usá-lo como diretório. Fallback determinístico se nada sobrar.
    const safeBase = sanitizeSkillName(canonicalName) || `skill-${shortSuffixFromSlug(input.slug)}`;
    let finalName = safeBase;
    let finalDir = path.join(input.workspaceSkillsRoot, finalName);
    const existingSlug = await readInstalledFrom(finalDir);
    if (existingSlug && (existingSlug.source !== installedFrom.source || existingSlug.slug !== installedFrom.slug)) {
      // Conflito: pasta com mesmo nome mas origem diferente. Escolhe
      // sufixo determinístico baseado no slug pra ser estável entre
      // reinstalls da mesma skill.
      const suffix = shortSuffixFromSlug(input.slug);
      finalName = `${safeBase}-${suffix}`;
      finalDir = path.join(input.workspaceSkillsRoot, finalName);
      // Se mesmo o sufixado já existir e for outra skill, adicionar
      // contador. Raro — slugs distintos têm hashes distintos.
      let counter = 2;
      while (true) {
        const collision = await readInstalledFrom(finalDir);
        if (!collision) break;
        if (collision.source === installedFrom.source && collision.slug === installedFrom.slug) break;
        finalName = `${safeBase}-${suffix}-${counter}`;
        finalDir = path.join(input.workspaceSkillsRoot, finalName);
        counter++;
        if (counter > 50) throw new Error("nome final não resolvido após 50 tentativas");
      }
    }
    // Defesa em profundidade: finalDir DEVE estar dentro de workspaceSkillsRoot
    // antes de qualquer rm/rename destrutivo.
    assertInside(input.workspaceSkillsRoot, finalDir);
    await fs.rm(finalDir, { recursive: true, force: true });
    // rename é atômico mas só funciona within mesmo filesystem. /tmp
    // tmpfs (Linux) vs ~/workspace (ext4/zfs) = EXDEV. Fallback: copy
    // recursive + rm. Trade-off: não-atômico (window de finalDir parcial
    // se daemon crash); aceitável pra skill install.
    try {
      await fs.rename(tmpDir, finalDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EXDEV") {
        await fs.cp(tmpDir, finalDir, { recursive: true });
        await fs.rm(tmpDir, { recursive: true, force: true });
      } else {
        throw e;
      }
    }
    return { installedAt: finalDir, name: finalName };
  } catch (err) {
    // cleanup tmp em erro
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
