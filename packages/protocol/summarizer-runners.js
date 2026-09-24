/**
 * T-1148 — runners que sabem responder um prompt one-shot (o digest da migração
 * de contexto e o resumo de voz usam o mesmo caminho).
 *
 * Fonte ÚNICA: o daemon monta o argv por runner e o server escolhe QUEM roda o
 * digest — se as duas listas divergirem, o server manda um runner que o daemon
 * recusa com "runner inválido" (foi o que aconteceu com `dsh`). Um teste do
 * server confere esta lista contra o switch do daemon.
 *
 * `dsh` NÃO está aqui de propósito: o adapter dele é ACP/serve e não tem um
 * one-shot textual — enquanto não tiver, o digest tem de rodar em outro runner.
 */
export const SUMMARIZER_RUNNERS = Object.freeze(["claude", "codex", "crush", "gemini", "qwen", "opencode", "grok", "grok-custom"]);

/** true se o runner consegue fazer o digest (one-shot textual). */
export function canSummarize(runner) {
  return SUMMARIZER_RUNNERS.includes(runner);
}
