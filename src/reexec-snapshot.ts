/**
 * T-842: grava o spool do re-exec e, só se essa gravação passou, os ids
 * vistos. Spool que lança não pode persistir os vistos — o processo novo
 * descartaria o replay do server e a mensagem em voo sumiria.
 * T-824 (prova): o mesmo vale por mensagem — a que ficou fora do spool (sem
 * chave do projeto) sai dos vistos, para o replay do server reentregá-la.
 */
export function commitReexecSnapshot(deps: {
  tag: string;
  writeSpool: () => { spooled: number; lost: number; lostDeliveryIds?: string[] };
  /** `excluir`: ids que não entraram no spool e não podem constar como vistos. */
  saveSeen: (excluir: string[]) => void;
  log: (level: "info" | "warn", msg: string) => void;
}): void {
  let ok = false;
  let excluir: string[] = [];
  try {
    const sp = deps.writeSpool();
    ok = true;
    excluir = sp.lostDeliveryIds ?? [];
    deps.log("info", `${deps.tag} spool: ${sp.spooled} msg(s) gravadas cifradas${sp.lost ? `, ${sp.lost} perdida(s) sem chave (não gravadas em claro)` : ""}`);
  } catch (e) {
    deps.log("warn", `${deps.tag} spool falhou: ${(e as Error).message} — mensagens retidas perdidas na saída`);
  }
  if (!ok) {
    deps.log("warn", `${deps.tag} ids de entrega vistos NÃO gravados — o spool falhou e o replay do server precisa reentregar`);
    return;
  }
  if (excluir.length) {
    deps.log("warn", `${deps.tag} ${excluir.length} id(s) de entrega fora dos vistos — a mensagem não entrou no spool e o replay do server a reentrega`);
  }
  try {
    deps.saveSeen(excluir);
  } catch (e) {
    deps.log("warn", `${deps.tag} ids de entrega vistos: gravação falhou (${(e as Error).message}) — o replay pode reentregar`);
  }
}
