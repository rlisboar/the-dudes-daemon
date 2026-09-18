/**
 * T-594: interpolação de `{{mem.NAME}}` do prompt de step — UMA definição.
 *
 * O placeholder é resolvido contra a mission_memory (scratch da missão, escrito
 * pelos steps via `<<<MEM_SET k=v>>>`). Até aqui o único interpolador era o
 * server, no tick do MissionEngine — o que funciona enquanto o prompt do step é
 * texto em claro.
 *
 * Sob E2EE o prompt do step é um BLOB (`e2e:v2:…`): o `{{mem.NAME}}` mora
 * DENTRO do plaintext cifrado, então o server (que não tem a chave) faz um
 * `replace` que não casa nada e o subagente recebe o placeholder LITERAL. Quem
 * vê o plaintext é o daemon, na hora de montar as parts — por isso a MESMA
 * função tem de existir dos dois lados. Se as duas cópias divergirem, o caminho
 * em claro e o caminho cifrado passam a resolver diferente.
 *
 * Formato: `{{mem.NAME}}`, com espaços internos tolerados e NAME em
 * `[A-Za-z0-9_]`. Chave ausente resolve para string vazia (é o comportamento do
 * server desde a introdução da feature — um `{{mem.X}}` de um step que não
 * gravou X não vira lixo no prompt).
 */

/** Fonte do regex (sem flag) — cada chamada compila o seu, sem `lastIndex` compartilhado. */
export const MEM_PLACEHOLDER_SOURCE = "\\{\\{\\s*mem\\.([A-Za-z0-9_]+)\\s*\\}\\}";

/** true se o texto tem ao menos um placeholder de memória. */
export function hasMemPlaceholder(text) {
  if (typeof text !== "string" || !text) return false;
  return new RegExp(MEM_PLACEHOLDER_SOURCE).test(text);
}

/**
 * Substitui cada `{{mem.NAME}}` pelo valor em `mem`; chave ausente (ou valor não
 * string) vira string vazia. `mem` ausente devolve o texto intacto.
 *
 * Passada ÚNICA: um valor que contenha `{{mem.OUTRO}}` não é reexpandido.
 */
export function interpolateMissionMemory(text, mem) {
  if (typeof text !== "string") return "";
  if (!mem || typeof mem !== "object") return text;
  return text.replace(new RegExp(MEM_PLACEHOLDER_SOURCE, "g"), (_full, key) => {
    const v = mem[key];
    return typeof v === "string" ? v : "";
  });
}