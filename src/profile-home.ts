import os from "node:os";
import path from "node:path";

/**
 * Home do PERFIL do daemon (T-029): dirname do daemon.cjs em execução
 * (~/.the-dudes, ~/.the-dudes-mac…). Fora do bundle (dev/testes), o perfil
 * default. T-824: spool do re-exec e ids de entrega vistos moram aqui — dois
 * perfis na mesma conta (mesmo HOME) não podem dividir o mesmo arquivo.
 */
export function profileHome(): string {
  const bin = process.env.THE_DUDES_DAEMON_BIN || process.argv[1] || "";
  if (bin.endsWith(".cjs")) return path.dirname(path.resolve(bin));
  return path.join(os.homedir(), ".the-dudes");
}
