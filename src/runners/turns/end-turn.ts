/**
 * R7 (T-462): fim de turno ÚNICO e IDEMPOTENTE para os runners per-message.
 *
 * Antes cada close handler replicava: release do slot, busy=false, restore do
 * firstTurn, idle + drain. Regras que os testes travam (T-417/T-251):
 *  - close TARDIO de turno já recuperado (epoch mudou) NÃO liberta slot/busy;
 *  - stopped → emitExit SEMPRE (mesmo com epoch trocado);
 *  - sem `result` no MESMO epoch restaura o firstTurn snapshot (senão o
 *    próximo turno faz resume de sessão que o clear/compact descartou);
 *  - idempotente: segundo close do mesmo epoch não repete o cleanup.
 */
import type { FirstTurnSnapshot } from "../message-session.js";

export interface EndTurnOpts {
  epoch: number;
  code: number | null;
  sawResult?: boolean;
  firstTurnSnapshot?: FirstTurnSnapshot;
  imgCleanup?: () => void;
  /** roda ANTES do cleanup (flush de texto pendente do runner). */
  beforeCleanup?: () => void;
}

export function endTurn(self: any, o: EndTurnOpts): void {
  const owns = self.messageSession.owns(o.epoch);
  const ended: Set<number> = (self.__endedTurnEpochs ??= new Set());
  if (ended.has(o.epoch) && !self.stopped) return;
  ended.add(o.epoch);
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
