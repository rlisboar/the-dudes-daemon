/**
 * Helpers puros de memória (extract/near-dup/budget) — testáveis sem AgentRunner.
 */

export type MemoryExtractItem = {
  title: string;
  body: string;
  type: string;
  supersedes: string[];
};

const ALLOWED_TYPES = new Set(["fact", "decision", "reference", "preference", "task_state"]);

/** Prioridade no budget de inject: decision/preference primeiro. */
export function memoryTypePriority(type: string): number {
  if (type === "decision") return 0;
  if (type === "preference") return 1;
  if (type === "reference") return 2;
  if (type === "task_state") return 3;
  return 4; // fact / other
}

export function sortByMemoryTypePriority<T extends { type: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => memoryTypePriority(a.type) - memoryTypePriority(b.type));
}

/**
 * Aplica budget de chars com reserva para sticky (decision/preference).
 * stickyReservePct (0–1) do budget é tentado primeiro só com sticky.
 */
export function applyMemoryCharBudget(
  blocks: Array<{ type: string; text: string }>,
  charBudget: number,
  stickyReservePct = 0.45,
): { kept: string[]; dropped: number; used: number } {
  const stickyBudget = Math.floor(charBudget * stickyReservePct);
  const ordered = sortByMemoryTypePriority(blocks);
  const sticky = ordered.filter((b) => memoryTypePriority(b.type) <= 1);
  const rest = ordered.filter((b) => memoryTypePriority(b.type) > 1);

  const kept: string[] = [];
  let used = 0;
  let dropped = 0;

  const take = (list: typeof blocks, hardCap: number) => {
    for (const b of list) {
      if (used + b.text.length > hardCap && kept.length > 0) {
        dropped++;
        continue;
      }
      if (used + b.text.length > charBudget && kept.length > 0) {
        dropped++;
        continue;
      }
      kept.push(b.text);
      used += b.text.length;
    }
  };

  // 1) sticky com reserva; 2) resto no restante do budget; 3) sticky overflow no resto
  take(sticky, Math.max(stickyBudget, 1));
  take(rest, charBudget);
  // sticky que não couberam na reserva tentam o budget total
  const stickyLeft = sticky.filter((b) => !kept.includes(b.text));
  take(stickyLeft, charBudget);

  return { kept, dropped, used };
}

/** Similaridade grosseira de título (near-dup) sem embeddings. */
export function memoryTitleNearDup(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(" ").filter((w) => w.length > 2));
  const tb = new Set(nb.split(" ").filter((w) => w.length > 2));
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 && inter / union >= 0.72;
}

/** Extrai MEMORY_JSON do summary; retorna texto limpo + itens. */
export function parseAndStripMemory(summary: string): { clean: string; items: MemoryExtractItem[] } {
  const patterns = [
    /^[ \t>*-]*MEMORY_JSON:\s*(\[[\s\S]*?\])\s*$/m,
    /MEMORY_JSON:\s*(\[[\s\S]*?\])\s*$/m,
    /MEMORY_JSON:\s*```(?:json)?\s*(\[[\s\S]*?\])\s*```/i,
    /MEMORY_JSON:\s*(\[[\s\S]{0,12000}?\])/,
  ];
  let match: RegExpMatchArray | null = null;
  for (const re of patterns) {
    match = summary.match(re);
    if (match) break;
  }
  if (!match) return { clean: summary.trim(), items: [] };

  let items: MemoryExtractItem[] = [];
  try {
    let raw = match[1]!;
    let arr: unknown;
    try {
      arr = JSON.parse(raw);
    } catch {
      raw = raw.replace(/,\s*([}\]])/g, "$1");
      arr = JSON.parse(raw);
    }
    if (Array.isArray(arr)) {
      const pick = (o: any, keys: string[]): string => {
        for (const k of keys) if (typeof o?.[k] === "string" && o[k].trim()) return o[k];
        return "";
      };
      items = arr
        .map((x) => {
          if (typeof x === "string") {
            const s = x.trim();
            return { title: s.slice(0, 80), body: s, type: "fact", supersedes: [] as string[] };
          }
          const title = pick(x, ["title", "name", "heading", "summary"]);
          const body = pick(x, ["body", "content", "detail", "details", "text", "value", "description"]) || title;
          const rawType = typeof x?.type === "string" ? x.type : typeof x?.kind === "string" ? x.kind : "fact";
          const supRaw = Array.isArray(x?.supersedes)
            ? x.supersedes
            : Array.isArray(x?.replaces)
              ? x.replaces
              : [];
          const supersedes = supRaw
            .filter((s: unknown) => typeof s === "string" && /^mem_[a-z0-9]+$/i.test(s))
            .slice(0, 5) as string[];
          return {
            title: (title || body).slice(0, 200),
            body: body.slice(0, 4000),
            type: ALLOWED_TYPES.has(rawType) ? rawType : "fact",
            supersedes,
          };
        })
        .filter((it) => it.title && it.body)
        .slice(0, 5);
    }
  } catch {
    /* malformed */
  }
  const clean = summary.replace(match[0], "").trim();
  return { clean, items };
}

/** Multi-termo: mode "and" (default) ou "or". */
export function memoryQueryMatch(
  haystack: string,
  query: string | undefined,
  mode: "and" | "or" = "and",
): boolean {
  if (!query?.trim()) return true;
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return true;
  const hay = haystack.toLowerCase();
  return mode === "or" ? terms.some((t) => hay.includes(t)) : terms.every((t) => hay.includes(t));
}
