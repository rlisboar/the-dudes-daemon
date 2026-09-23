/**
 * R7 (T-462): fim de turno ÚNICO e IDEMPOTENTE para os runners per-message.
 *
 * Antes cada close handler replicava: release do slot, busy=false, restore do
 * firstTurn, idle + drain. Regras que os testes travam (T-417/T-251):
 *  - close TARDIO de turno já recuperado (epoch mudou) NÃO liberta slot/busy;
 *  - stopped → emitExit SEMPRE (mesmo com epoch trocado);
 *  - sem `result` no MESMO epoch restaura o firstTurn snapshot (senão o
 *    próximo turno faz resume de sessão que o clear/compact descartou);
 *  - idempotente: segundo close do MESMO turno não repete o cleanup.
 *    A chave é o turno (`beginTurn`), não o epoch: o epoch só muda em
 *    reset/bump (recover), então o 2º turno normal do codex/gemini era
 *    engolido e o busy ficava preso (T-841).
 */
import type { FirstTurnSnapshot } from "../message-session.js";

export interface EndTurnOpts {
  epoch: number;
  /** T-841: identidade deste turno. Dois turnos do mesmo epoch são chaves distintas. */
  turnKey: string;
  code: number | null;
  sawResult?: boolean;
  firstTurnSnapshot?: FirstTurnSnapshot;
  imgCleanup?: () => void;
  /** roda ANTES do cleanup (flush de texto pendente do runner). */
  beforeCleanup?: () => void;
}

/** T-841: um id por turno iniciado. Chamar no spawn e passar ao endTurn. */
export function beginTurn(self: { __turnSeq?: number }): string {
  const n = (self.__turnSeq ?? 0) + 1;
  self.__turnSeq = n;
  return `t${n}`;
}

export function endTurn(self: any, o: EndTurnOpts): void {
  const owns = self.messageSession.owns(o.epoch);
  const ended: Set<string> = (self.__endedTurnKeys ??= new Set());
  if (ended.has(o.turnKey) && !self.stopped) return;
  ended.add(o.turnKey);
  try { o.beforeCleanup?.(); } catch { /* flush best-effort */ }
  try { o.imgCleanup?.(); } catch { /* cleanup best-effort */ }
  if (owns || self.stopped) {
    self.releaseActiveTurnSlot();
    self.ocActiveProc = null;
    self.messageSession.busy = false;
  }
  if (self.stopped) {
    self.emitExit(o.code);
    return;
  }
  if (!o.sawResult && owns && o.firstTurnSnapshot) {
    self.messageSession.restoreFirstTurn(o.firstTurnSnapshot);
  }
  if (owns) {
    self.setState("idle");
    self.drainOcQueue();
  }
}
