/**
 * AgentSkills v2 — filesystem scanner.
 *
 * Implementa a spec AgentSkills (mesma usada por OpenClaw + Claude
 * Skills). Cada skill é uma pasta `<name>/` contendo `SKILL.md` com
 * YAML frontmatter + body em markdown.
 *
 * Discovery em 6 sources, precedência decrescente — conflito de
 * nome resolve pra fonte mais alta:
 *
 *   1. workspace        — <workspace>/skills
 *   2. project-agents   — <workspace>/.agents/skills
 *   3. personal-agents  — ~/.agents/skills
 *   4. openclaw-managed — ~/.openclaw/skills (cross-tool compat)
 *   5. bundled          — <daemon-install>/bundled-skills
 *   6. extra            — paths configurados pelo user
 *
 * Tudo file-system: não persiste em DB. Daemon escaneia, faz hash do
 * conteúdo, e reporta um snapshot completo (não diff) pro orchestrator.
 *
 * Símbolos sensíveis (symlinks que pulam pra fora do source dir,
 * paths absolutos no SKILL.md) são bloqueados — skills são código
 * não-confiável até prova em contrário.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type { SkillDefinition, SkillFrontmatter, SkillSource } from "./types.js";

interface SourceSpec {
  source: SkillSource;
  root: string;
}

export interface ScanInput {
  workspaceRoot: string | null;
  /** Caminhos extras configurados pelo user. */
  extraSourceRoots?: string[];
  /** Bundled skills enviadas com o daemon. */
  bundledRoot?: string | null;
}

export interface ScanResult {
  skills: SkillDefinition[];
  /** Diretórios inspecionados, mesmo quando não existem — útil pra UI
   *  mostrar "onde poderia colocar skill". */
  scannedSources: string[];
}

/** Resolve caminhos das 6 sources na ordem de precedência. */
function resolveSources(input: ScanInput): SourceSpec[] {
  const home = os.homedir();
  const list: SourceSpec[] = [];
  if (input.workspaceRoot) {
    list.push({ source: "workspace",       root: path.join(input.workspaceRoot, "skills") });
    list.push({ source: "project-agents",  root: path.join(input.workspaceRoot, ".agents", "skills") });
  }
  list.push({ source: "personal-agents",  root: path.join(home, ".agents", "skills") });
  list.push({ source: "openclaw-managed", root: path.join(home, ".openclaw", "skills") });
  if (input.bundledRoot) {
    list.push({ source: "bundled", root: input.bundledRoot });
  }
  for (const extra of input.extraSourceRoots ?? []) {
    list.push({ source: "extra", root: extra });
  }
  return list;
}

/** Parse the leading `---\n…\n---` block of a SKILL.md. */
function parseFrontmatter(raw: string): { fm: Record<string, unknown>; body: string } | null {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return null;
  const headerRaw = raw.slice(4, end).trim();
  const body = raw.slice(end + 4).replace(/^\n+/, "");
  const fm: Record<string, unknown> = {};
  // Tiny YAML — flat key:value + scalar arrays. AgentSkills frontmatter
  // is intentionally simple; pulling a full YAML dep here adds 50KB
  // for no real win. Reject anything fancy.
  for (const line of headerRaw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const valRaw = trimmed.slice(idx + 1).trim();
    if (!key) continue;
    fm[key] = parseScalar(valRaw);
  }
  return { fm, body };
}

function parseScalar(raw: string): unknown {
  if (raw === "" || raw === "~" || raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  // Inline array: [a, b, c] or ["a", "b"]
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => parseScalar(s.trim()));
  }
  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function normaliseFrontmatter(folderName: string, fm: Record<string, unknown>): SkillFrontmatter | null {
  const name = (fm.name ?? folderName) as string;
  const description = fm.description as string | undefined;
  if (!name || typeof name !== "string") return null;
  if (!description || typeof description !== "string") return null;
  const out: SkillFrontmatter = { name, description };

  if (typeof fm["user-invocable"] === "boolean") out.userInvocable = fm["user-invocable"];
  else if (typeof fm.userInvocable === "boolean") out.userInvocable = fm.userInvocable;

  if (typeof fm["disable-model-invocation"] === "boolean") out.disableModelInvocation = fm["disable-model-invocation"];
  else if (typeof fm.disableModelInvocation === "boolean") out.disableModelInvocation = fm.disableModelInvocation;

  const dispatch = fm["command-dispatch"] ?? fm.commandDispatch;
  if (dispatch === "tool" || dispatch === "shell") out.commandDispatch = dispatch;

  const allowed = fm["allowed-tools"] ?? fm.allowedTools;
  if (Array.isArray(allowed)) out.allowedTools = allowed.filter((x) => typeof x === "string") as string[];

  // metadata sub-object — keep loose; Object form only
  const meta = fm.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    out.metadata = meta as SkillFrontmatter["metadata"];
  }
  return out;
}

/** Returns true when `child` is inside `parent` (no symlink escape). */
async function isSafeChild(parent: string, child: string): Promise<boolean> {
  try {
    const realParent = await fs.realpath(parent);
    const realChild = await fs.realpath(child);
    const rel = path.relative(realParent, realChild);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

async function scanSource(spec: SourceSpec): Promise<SkillDefinition[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(spec.root);
  } catch {
    return []; // missing dir is fine
  }
  const out: SkillDefinition[] = [];
  for (const name of entries) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    const folder = path.join(spec.root, name);
    if (!(await isSafeChild(spec.root, folder))) continue;
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(folder);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const skillMd = path.join(folder, "SKILL.md");
    let raw: string;
    try {
      // Rejeita SKILL.md que seja symlink — o realpath de isSafeChild só valida
      // a PASTA; um SKILL.md -> /etc/passwd seria lido e injetado no system
      // prompt (exfil de arquivo arbitrário do host). lstat não segue o link.
      const lst = await fs.lstat(skillMd);
      if (lst.isSymbolicLink()) continue;
      raw = await fs.readFile(skillMd, "utf8");
    } catch {
      continue;
    }
    if (raw.length > 256 * 1024) continue; // 256KB skill cap

    const parsed = parseFrontmatter(raw);
    if (!parsed) continue;
    const fm = normaliseFrontmatter(name, parsed.fm);
    if (!fm) continue;

    // Metadados de origem (gravados pelo installer) — distinguem skills
    // com mesmo nome canônico vindas de fontes diferentes.
    let installedFrom: { source: string; slug: string; installedAt?: string } | undefined;
    try {
      const metaPath = path.join(folder, ".installed-from.json");
      const lst = await fs.lstat(metaPath);
      if (lst.isSymbolicLink()) throw new Error("symlink");
      const meta = await fs.readFile(metaPath, "utf8");
      const j = JSON.parse(meta);
      if (j && typeof j.source === "string" && typeof j.slug === "string") {
        installedFrom = { source: j.source, slug: j.slug, installedAt: j.installedAt };
      }
    } catch {
      // arquivo opcional — skills criadas manualmente não têm
    }

    out.push({
      name: fm.name,
      source: spec.source,
      path: folder,
      frontmatter: fm,
      body: parsed.body,
      contentHash: createHash("sha256").update(raw).digest("hex"),
      installedFrom,
    });
  }
  return out;
}

/** Apply 6-source precedence and return the effective skill set.
 *
 *  Key inclui (source-bucket, name, installedFrom-slug). Skills do mesmo
 *  registry+slug são deduped (precedência override entre sources).
 *  Skills com mesmo nome mas slugs diferentes (ou criadas manualmente)
 *  coexistem — duas "devops" de autores diferentes ficam ambas visíveis. */
function dedupeByPrecedence(allHits: SkillDefinition[]): SkillDefinition[] {
  const seen = new Map<string, SkillDefinition>();
  for (const s of allHits) {
    // Identidade lógica = (name, slug-origem). Sem slug, usa o path
    // absoluto (skill manual fica única pelo seu folder).
    const identity = `${s.name}::${s.installedFrom?.slug ?? s.path}`;
    if (!seen.has(identity)) seen.set(identity, s);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function scanSkills(input: ScanInput): Promise<ScanResult> {
  const sources = resolveSources(input);
  const buckets = await Promise.all(sources.map(scanSource));
  const all = ([] as SkillDefinition[]).concat(...buckets);
  return {
    skills: dedupeByPrecedence(all),
    scannedSources: sources.map((s) => s.root),
  };
}
