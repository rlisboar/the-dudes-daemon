/**
 * T-1154 (Jev sombra #3): utilidades da sombra do summarizer.
 *
 * `similaridadeLocal` existe para o daemon registrar o desfecho que ELE conhece
 * (o resumo saiu praticamente igual ao original?) sem mandar texto ao server:
 * Jaccard sobre tokens normalizados, em [0,1].
 */
const MINUSCULAS = /[^\p{L}\p{N}\s]/gu;

function tokens(texto: string): Set<string> {
  const limpo = texto.toLowerCase().replace(MINUSCULAS, " ").split(/\s+/).filter((t) => t.length > 2);
  return new Set(limpo);
}

/** Jaccard dos tokens (0 = nada em comum, 1 = idêntico). Texto vazio → null. */
export function similaridadeLocal(original: string, resumo: string): number | null {
  if (!original?.trim() || !resumo?.trim()) return null;
  const a = tokens(original);
  const b = tokens(resumo);
  if (a.size === 0 || b.size === 0) return null;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const uniao = a.size + b.size - inter;
  return uniao === 0 ? null : Math.round((inter / uniao) * 1000) / 1000;
}
