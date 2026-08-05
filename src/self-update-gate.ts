/**
 * Gate de self-update (T-033): evita corrida se o push WS e o timer horário
 * (ou dois pushes) disparam ao mesmo tempo. Um check por vez; o restante
 * é skipped-inflight (próximo intervalo/push tenta de novo se ainda houver
 * release novo).
 */

export type SelfUpdateTriggerResult = "started" | "skipped-inflight" | "skipped-disabled";

export function createSelfUpdateGate(opts: {
  /** THE_DUDES_SELF_UPDATE=0 → disabled */
  enabled: () => boolean;
  run: () => Promise<unknown>;
  log?: (level: "info" | "warn", msg: string) => void;
}): {
  trigger: (reason: string) => Promise<SelfUpdateTriggerResult>;
  busy: () => boolean;
} {
  let inFlight = false;
  return {
    busy: () => inFlight,
    async trigger(reason: string): Promise<SelfUpdateTriggerResult> {
      if (!opts.enabled()) return "skipped-disabled";
      if (inFlight) {
        opts.log?.("info", `[self-update] skip (${reason}) — já checando`);
        return "skipped-inflight";
      }
      inFlight = true;
      opts.log?.("info", `[self-update] check iniciado (${reason})`);
      try {
        await opts.run();
        return "started";
      } finally {
        inFlight = false;
      }
    },
  };
}

/**
 * Dispatch de eventos orch→daemon: tipos desconhecidos são ignorados
 * (retrocompat T-033 — daemons antigos sem case release:available não
 * quebram). Exportado pra provar o contrato em teste.
 */
export function dispatchOrchEvent(
  type: string,
  handlers: Record<string, () => void>,
): "handled" | "ignored" {
  const h = handlers[type];
  if (!h) return "ignored";
  h();
  return "handled";
}
