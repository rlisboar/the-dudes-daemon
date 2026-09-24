/**
 * T-820: tetos de UM turno por runner — FONTE ÚNICA.
 *
 * Nasceu do T-820. O valve anti-deadlock do turn-gate derivava de UM runner só
 * (`QWEN_HARD_TIMEOUT_MS + 5min` = 70min) enquanto o cap legítimo do opencode
 * já era 120min (T-776): um turno opencode longo e SAUDÁVEL (com progresso)
 * perdia o slot aos 70min — log de "slot preso" falso e o gate passando a
 * admitir mais turnos simultâneos que `THE_DUDES_MAX_CLI_TURNS` (294
 * liberações à força no log de prod, a última 24/09 04:36Z).
 *
 * Aqui todos os tetos ficam declarados juntos e o gate deriva de
 * `MAIOR_TETO_DE_TURNO_MS`. A invariante é travada por teste (t820): o valve
 * tem de ficar ACIMA de TODO teto declarado — quem acrescentar um teto novo
 * aqui e esquecer o valve quebra a suíte em vez de descobrir em produção.
 *
 * Os nomes continuam reexportados pelos módulos de origem (`turn-watchdog.ts`
 * para os do qwen, `agent-runner.ts` para os demais) — nenhum importador muda.
 */

/** T-598/T-749: janela de lifetime do turno qwen, agora RENOVÁVEL por evento
 *  semântico. Era um teto absoluto de 8min (T-371 (d)), depois 30min fixo
 *  (T-598); a medição da T-730 mostrou 79 cortes em 17–19/09 (todos qwen),
 *  48,1% com atividade <60s antes do corte — trabalho vivo morria só por
 *  elapsed. Com a renovação, 30min passa a significar "sem NENHUM evento há
 *  30min"; turno produtivo segue até o cap. */
export const QWEN_TURN_LIFETIME_MS = 30 * 60_000;

/** T-749: teto ABSOLUTO de lifetime do turno qwen, NÃO renovável. Preserva o
 *  apanhe do loop que emite eventos para sempre (F4, que motivou o T-598):
 *  com a janela renovável, só o cap o corta. 2× a janela = 60min — os 2
 *  cortes de QA em 19/09 (1803/1804s, ambos com progresso) completariam
 *  dentro dele.
 *
 *  T-749 (review T-748): os 3 TIERS derivam JUNTOS daqui, com esta ordem
 *  obrigatória — `window < cap < hard-timeout < stream-max`:
 *  - `QWEN_TURN_LIFETIME_MS` (janela, renovável) é o corte por progresso;
 *  - este cap é o corte absoluto (não renovável);
 *  - `QWEN_HARD_TIMEOUT_MS` é o backstop do PROCESSO, acima do cap para o
 *    watchdog cortar primeiro (e, se disparar, passa pelo mesmo recover);
 *  - `QWEN_STREAM_MAX_LIFETIME_MS` é o guard do CLI, acima de todos para o
 *    CLI nunca abortar sozinho e perder a mensagem em voo.
 *  Se um tier não-renovável ficar ABAIXO do cap, o turno saudável morre pelo
 *  tier errado (o cap nunca é alcançado). Teste: t598 (C6). */
export const QWEN_TURN_LIFETIME_CAP_MS = 2 * QWEN_TURN_LIFETIME_MS;

/** T-598/T-749: par do teto no CLI do qwen (`QWEN_STREAM_MAX_LIFETIME_MS`).
 *  O guard do CLI é por RESPOSTA de streaming (upstream wait, não turno);
 *  fica ACIMA do cap do daemon para o daemon cortar primeiro — kill com
 *  re-fila e sessão preservada — e o CLI nunca abortar sozinho (aborto do
 *  CLI fecha o turno sem recover e a mensagem em voo se perde). */
export const QWEN_STREAM_MAX_LIFETIME_MS = QWEN_TURN_LIFETIME_CAP_MS + 10 * 60_000;

/** T-598/T-749: backstop do processo do turno qwen (armHardTimeout). Acima do
 *  cap de lifetime para o watchdog cortar primeiro; se ele próprio disparar,
 *  passa pelo mesmo recover (re-fila + sessão preservada), não por um
 *  SIGKILL seco que perde a mensagem em voo. */
export const QWEN_HARD_TIMEOUT_MS = QWEN_TURN_LIFETIME_CAP_MS + 5 * 60_000;

/** T-750: teto do POST síncrono `/session/:id/message` do opencode.
 *  Era 600s (10min) fixos — mas o POST só resolve quando o RUN termina, e um
 *  turno real com tools longas passa disso: em 20/09 o BACKEND morreu 4× em
 *  error com durationMs 600.002ms cravados enquanto o run SEGUIA no serve
 *  (steps 10+ após o abort — log do provedor em evidence/T-750). O teto
 *  precisa cobrir o pior toolsHardMs do watchdog (~20min) com folga: quem
 *  apanha run travado é o watchdog (idle 10min / tool 20min), não este POST. */
export const OPENCODE_TURN_TIMEOUT_MS = 30 * 60_000;

/** T-776: cap ABSOLUTO do turno opencode (POST + stream). Medido em prod
 *  21/09 pós-T-750: 6/28 turnos morreram cravados no teto de 30min, p90 dos
 *  completed 888s, máx 1509s — e UM run abortado seguiu no serve por 81min
 *  até concluir (134 steps). O teto de 30min vira OCIOSIDADE (sem evento),
 *  e o turno pode viver até este cap com progresso: 120min cobre o pior
 *  observado (81min) com folga. */
export const OPENCODE_POST_CAP_MS = 120 * 60_000;

/** Timeout do turno headless Grok (`grok -p …`). Sem isso, um resume + system
 *  prompt gigante (skills) deixa o processo zumbi por horas com busy=true e
 *  a fila enche (`ocQueue cheia`). 12 min cobre turnos longos com tools. */
export const GROK_TURN_TIMEOUT_MS = 12 * 60_000;

/** Cap absoluto por turno pra codex/gemini/crush. Antes só grok/opencode
 *  tinham; um CLI travado em loop dependia só do hang-watch por inatividade,
 *  que não dispara se ele segue emitindo. Generoso pra não matar turno longo
 *  legítimo (build/tool). armHardTimeout auto-limpa no exit do processo. */
export const PER_MSG_TURN_TIMEOUT_MS = 15 * 60_000;

/** Timeout dos one-shots de resumo (compact). Sem isso, um CLI travado
 *  segura o guard `compacting` pra sempre e o agente fica sem processo. */
export const ONE_SHOT_TIMEOUT_MS = 300_000;

/** Teto declarado de cada runner que PASSA pelo gate. `claude` e `dsh` são
 *  persistentes (`RUNNER_ADAPTERS[…].execution === "persistent"`): não pegam
 *  slot e não entram aqui. Quem pega é o per-message (todos os deste mapa) e o
 *  pool `bg` (one-shot). O teste t820 cruza este mapa com RUNNER_ADAPTERS — um
 *  runner per-message novo sem teto declarado quebra a suíte em vez de furar em
 *  produção. */
export const TETO_POR_RUNNER_GATEADO = {
  opencode: OPENCODE_POST_CAP_MS,
  qwen: QWEN_HARD_TIMEOUT_MS,
  grok: GROK_TURN_TIMEOUT_MS,
  "grok-custom": GROK_TURN_TIMEOUT_MS,
  codex: PER_MSG_TURN_TIMEOUT_MS,
  gemini: PER_MSG_TURN_TIMEOUT_MS,
  crush: PER_MSG_TURN_TIMEOUT_MS,
} as const;

/** Todo teto que pode segurar um slot legitimamente (pool main e bg) — o teste
 *  t820 enumera daqui, então um teto novo entra nesta lista e passa a exigir
 *  valve maior. */
export const TETOS_DE_TURNO_MS: Record<string, number> = {
  ...TETO_POR_RUNNER_GATEADO,
  "qwen janela": QWEN_TURN_LIFETIME_MS,
  "qwen cap": QWEN_TURN_LIFETIME_CAP_MS,
  "qwen stream-max": QWEN_STREAM_MAX_LIFETIME_MS,
  "opencode turn": OPENCODE_TURN_TIMEOUT_MS,
  "one-shot (bg)": ONE_SHOT_TIMEOUT_MS,
};

/** O maior teto de turno declarado. É o que o valve anti-deadlock do turn-gate
 *  tem de cobrir — não o maior tier de um runner só (bug do T-820). */
export const MAIOR_TETO_DE_TURNO_MS = Math.max(...Object.values(TETOS_DE_TURNO_MS));

/** Folga do valve sobre o maior teto: depois do teto o runner ainda mata o
 *  processo e o recover re-fila. Mesma regra do T-598 (que usava 5min sobre o
 *  hard-timeout do qwen). */
export const VALVE_FOLGA_MS = 5 * 60_000;