/**
 * Normalização de args de board_upsert_block (T-024).
 *
 * Agentes (e o PM) reusam o nome `content` de send_message; o schema MCP só
 * documentava `body` e o Zod descartava `content` → payload sem body → server
 * T-020 responde 400 fail-loud ("html exige body"). Mapear content→body no
 * bridge ANTES do post (e antes do E2EE do relay, que cifra `body`).
 *
 * Preferência: body explícito vence content.
 */

export function normalizeBoardUpsertArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const hasBody = args.body !== undefined && args.body !== null;
  const hasContent = args.content !== undefined && args.content !== null;
  const body = hasBody ? args.body : hasContent ? args.content : undefined;
  const out: Record<string, unknown> = { ...args };
  delete out.content;
  if (body !== undefined) out.body = body;
  return out;
}
