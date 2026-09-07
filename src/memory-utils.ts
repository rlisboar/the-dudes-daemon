/**
 * Helpers puros de memória (extract/near-dup/budget) — testáveis sem AgentRunner.
 */

export type MemoryExtractItem = {
  title: string;
  body: string;
  type: string;
  supersedes: string[];
};

/** T-343: `experience` é memória EPISÓDICA (como uma tarefa parecida se
 *  resolveu). Type fora de ALLOWED_TYPES continua a cair para "fact". */
const ALLOWED_TYPES = new Set(["fact", "decision", "reference", "preference", "experience"]);

/** Prioridade no budget de inject: decision/preference primeiro. */
export function memoryTypePriority(type: string): number {
  if (type === "decision") return 0;
  if (type === "preference") return 1;
  if (type === "experience") return 2;
  if (type === "reference") return 3;
  return 4; // fact / other
}

export function sortByMemoryTypePriority<T extends { type: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => memoryTypePriority(a.type) - memoryTypePriority(b.type));
}

/* ─────────────────────────────────────────────────────────────────────────
 * T-343 — HOT-SET EM BLOCOS ETIQUETADOS (padrão MemGPT/Letta "memory blocks",
 * agnóstico de LLM). O hot-set era um monte único ordenado por tipo: 3 factos
 * triviais pinados podiam expulsar a única decision crítica, e o agente não
 * via estrutura. Agora o budget global de chars é PARTICADO em blocos com
 * propósito, rótulo e fatia própria:
 *   - cada bloco tem um FLOOR garantido (share × budget): o seu conteúdo entra
 *     até à fatia mesmo com blocos maiores a competir;
 *   - a folga de um bloco vazio é emprestada, em ordem de prioridade
 *     (decision → preference → experience → reference → fact), ao bloco que
 *     tiver mais conteúdo à espera — partilhas rígidas desperdiçam budget.
 * ───────────────────────────────────────────────────────────────────────── */

export interface MemoryBlockSpec {
  /** id estável (log/métrica). */
  label: string;
  /** título da secção no prompt. */
  heading: string;
  /** que tipos caem neste bloco. */
  types: string[];
  /** fatia garantida do budget global (0–1). */
  share: number;
  /** ordem de empréstimo da folga (menor = prioritário). */
  borrowOrder: number;
  /** o que o bloco é e como o agente deve usá-lo (renderizado no prompt). */
  usage: string;
}

export const MEMORY_BLOCKS: MemoryBlockSpec[] = [
  {
    label: "decisions", heading: "Decisões", types: ["decision"], share: 0.30, borrowOrder: 0,
    usage: "decisões de arquitetura/produto tomadas neste projeto — tratar como vinculativas até nova decisão",
  },
  {
    label: "preferences", heading: "Preferências do dono", types: ["preference"], share: 0.20, borrowOrder: 1,
    usage: "preferências pedidas explicitamente pelo dono — não contradizer sem pedir",
  },
  {
    label: "experiences", heading: "Experiências (como resolver)", types: ["experience"], share: 0.10, borrowOrder: 2,
    usage: "como tarefas parecidas foram resolvidas com sucesso; adaptar, não copiar cegamente",
  },
  {
    label: "references", heading: "Referências", types: ["reference"], share: 0.10, borrowOrder: 3,
    usage: "endereços, caminhos, comandos — verificar antes de citar",
  },
  {
    label: "state", heading: "Estado & factos", types: ["fact"], share: 0.30, borrowOrder: 4,
    usage: "factos observados (podem estar desatualizados — data na entrada)",
  },
];

/** Bloco de um tipo; tipos desconhecidos/legados (task_state) caem em state. */
export function memoryBlockForType(type: string): MemoryBlockSpec {
  return MEMORY_BLOCKS.find((b) => b.types.includes(type)) ?? MEMORY_BLOCKS[MEMORY_BLOCKS.length - 1]!;
}

export interface MemoryBlockItem {
  type: string;
  text: string;
  /** source da entrada (e.g. "user:nome") — pins do dono não são superseded por notas do agente. */
  source?: string;
}

/** Pins de humano (source "user:") primeiro; espelha pinVictimRank do server. */
function humanPinRank(e: MemoryBlockItem): number {
  return (e.source ?? "").startsWith("user:") ? 0 : 1;
}

export interface MemoryBlockRender {
  label: string;
  heading: string;
  usage: string;
  items: string[];
}

/**
 * Budget do hot-set com fatias por bloco + empréstimo de folga.
 * 1.ª passada: cada bloco preenche até à sua fatia garantida (floor), em
 *    ordem de prioridade de tipo.
 * 2.ª passada: o que sobrou é redistribuído pelos blocos com resto, por
 *    borrowOrder — folga de bloco vazio empresta para blocos cheios.
 */
export function applyMemoryBlockBudget(
  entries: MemoryBlockItem[],
  charBudget: number,
): { sections: MemoryBlockRender[]; dropped: number; used: number } {
  const byBlock = new Map<string, MemoryBlockItem[]>();
  for (const e of entries) {
    const b = memoryBlockForType(e.type);
    if (!byBlock.has(b.label)) byBlock.set(b.label, []);
    byBlock.get(b.label)!.push(e);
  }
  for (const list of byBlock.values()) {
    sortByMemoryTypePriority(list);
    // dentro do bloco, pins do dono vêm antes dos do agente (T-343)
    list.sort((a, b) => (humanPinRank(a) - humanPinRank(b)) || (memoryTypePriority(a.type) - memoryTypePriority(b.type)));
  }

  const placed = new Map<string, string[]>();
  const blockUsed = new Map<string, number>();
  const remaining = new Map<string, MemoryBlockItem[]>();
  let used = 0;
  let dropped = 0;

  /** Preenche `queue` enquanto couber em `cap` (teto do bloco) E no budget
   *  global. Devolve o que ficou de fora. */
  const place = (b: MemoryBlockSpec, cap: number, queue: MemoryBlockItem[]): MemoryBlockItem[] => {
    const left: MemoryBlockItem[] = [];
    for (const it of queue) {
      const inBlock = (blockUsed.get(b.label) ?? 0) + it.text.length;
      if (inBlock > Math.min(cap, charBudget) || used + it.text.length > charBudget) {
        // entrada maior que o budget inteiro entra sozinha (nunca ficar vazio
        // por uma única nota grande), desde que o bloco ainda esteja vazio.
        if ((blockUsed.get(b.label) ?? 0) > 0 || used > 0) { left.push(it); continue; }
      }
      if (!placed.has(b.label)) placed.set(b.label, []);
      placed.get(b.label)!.push(it.text);
      blockUsed.set(b.label, (blockUsed.get(b.label) ?? 0) + it.text.length);
      used += it.text.length;
    }
    return left;
  };

  // 1) fatias garantidas
  const ordered = [...MEMORY_BLOCKS].sort((a, b) => a.borrowOrder - b.borrowOrder);
  for (const b of ordered) {
    const queue = byBlock.get(b.label);
    if (!queue?.length) continue;
    remaining.set(b.label, place(b, Math.floor(charBudget * b.share), queue));
  }
  // 2) folga emprestada, por ordem de prioridade
  for (const b of ordered) {
    const left = remaining.get(b.label);
    if (!left?.length) continue;
    remaining.set(b.label, place(b, charBudget, left));
  }
  for (const b of ordered) dropped += remaining.get(b.label)?.length ?? 0;

  const sections: MemoryBlockRender[] = MEMORY_BLOCKS.filter((b) => placed.has(b.label)).map((b) => ({
    label: b.label,
    heading: b.heading,
    usage: b.usage,
    items: placed.get(b.label)!,
  }));
  return { sections, dropped, used };
}

/**
 * Aplica budget de chars com reserva para sticky (decision/preference).
 * Compat: um único bloco "all" sem fatias — comportamento antigo.
 * (T-343: o caminho de produção é applyMemoryBlockBudget.)
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

/** Normalizador compartilhado: lowercase + NFD + strip diacritics +
 *  pontuação→espaço + colapso de whitespace. Usado por near-dup de título,
 *  comparação de corpo e fold de query no recall (tolerância a acento). */
export function normalizeMemoryText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Corpo "essencialmente igual": normalização compartilhada (acentos e
 *  pontuação ignorados) comparando o prefixo de 400 chars — mesmo critério
 *  do skip near-dup do saveExtractedMemory (auto-extract). */
export function memoryBodySame(a: string, b: string): boolean {
  return normalizeMemoryText(a).slice(0, 400) === normalizeMemoryText(b).slice(0, 400);
}

/** Orçamento do hot-set (pinned) e limiar de warning por entrada. */
export const MEMORY_HOTSET_BUDGET_CHARS = 8000;
export const MEMORY_PIN_WARN_CHARS = 2000;

/** Feedback de tamanho no pin: entrada pinned com corpo grande consome
 *  desproporcionalmente o orçamento de 8000 chars do hot-set — warning
 *  vai no texto da tool remember, sem bloquear o save. */
export function memoryPinBudgetWarning(pinned: boolean | undefined, body: string): string {
  if (pinned !== true || body.length <= MEMORY_PIN_WARN_CHARS) return "";
  return ` ⚠️ body=${body.length} chars (>${MEMORY_PIN_WARN_CHARS}); hot-set budget = ${MEMORY_HOTSET_BUDGET_CHARS} chars no total — considere encurtar ou deixar unpinned`;
}

/** Decisão de duplicidade p/ remember MANUAL: near-dup de título
 *  (Jaccard ≥0.72) + corpo essencialmente igual → skip; near-dup com
 *  corpo novo → supersede (a nova entrada substitui a antiga). */
export type MemoryDupDecision =
  | { action: "skip"; nearId: string; nearTitle: string }
  | { action: "supersede"; nearId: string; nearTitle: string }
  | { action: "create" };

export function memoryManualDupDecision(
  existing: Array<{ id: string; title?: string; body?: string }>,
  title: string,
  body: string,
): MemoryDupDecision {
  const near = existing.find((e) => e.title && memoryTitleNearDup(e.title, title));
  if (!near?.title) return { action: "create" };
  if (memoryBodySame(near.body ?? "", body)) {
    return { action: "skip", nearId: near.id, nearTitle: near.title };
  }
  return { action: "supersede", nearId: near.id, nearTitle: near.title };
}

/** Similaridade grosseira de título (near-dup) sem embeddings. */
export function memoryTitleNearDup(a: string, b: string): boolean {
  const na = normalizeMemoryText(a);
  const nb = normalizeMemoryText(b);
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

/** Multi-termo: mode "and" (default) ou "or". Query e haystack passam pelo
 *  normalizador compartilhado (NFD + strip diacritics + pontuação→espaço):
 *  'configuracao' acha 'Configuração', 't-230' acha 'T 230'. */
export function memoryQueryMatch(
  haystack: string,
  query: string | undefined,
  mode: "and" | "or" = "and",
): boolean {
  if (!query?.trim()) return true;
  const terms = query
    .split(/\s+/)
    .map((t) => normalizeMemoryText(t))
    .filter((t) => t.length > 0);
  if (terms.length === 0) return true;
  const hay = normalizeMemoryText(haystack);
  return mode === "or" ? terms.some((t) => hay.includes(t)) : terms.every((t) => hay.includes(t));
}
