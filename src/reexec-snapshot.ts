/**
 * T-842: grava o spool do re-exec e, só se essa gravação passou, os ids
 * vistos. Spool que lança não pode persistir os vistos — o processo novo
 * descartaria o replay do server e a mensagem em voo sumiria.
 */
export function commitReexecSnapshot(deps: {
  tag: string;
  writeSpool: () => { spooled: number; lost: number };
  saveSeen: () => void;
  log: (level: "info" | "warn", msg: string) => void;
}): void {
  let ok = false;
  try {
    const sp = deps.writeSpool();
    ok = true;
    deps.log("info", `${deps.tag} spool: ${sp.spooled} msg(s) gravadas cifradas${sp.lost ? `, ${sp.lost} perdida(s) sem chave (não gravadas em claro)` : ""}`);
  } catch (e) {
    deps.log("warn", `${deps.tag} spool falhou: ${(e as Error).message} — mensagens retidas perdidas na saída`);
  }
  if (!ok) {
    deps.log("warn", `${deps.tag} ids de entrega vistos NÃO gravados — o spool falhou e o replay do server precisa reentregar`);
    return;
  }
  try {
    deps.saveSeen();
  } catch (e) {
    deps.log("warn", `${deps.tag} ids de entrega vistos: gravação falhou (${(e as Error).message}) — o replay pode reentregar`);
  }
}
