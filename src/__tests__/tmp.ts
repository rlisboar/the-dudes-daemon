/**
 * T-935 — diretório temporário dos testes do daemon: reexporta o pacote
 * `@the-dudes/test-utils` (promovido no T-934), em vez de manter uma cópia.
 *
 * A cópia local nasceu no T-875 e é o mesmo desenho do pacote (escolha por
 * tentativa real, `mkdtemp` como prova, limpeza no fim do processo). O teste do
 * helper vive no pacote (`packages/test-utils/index.test.js`) — aqui não se
 * copia teste, só se importa.
 *
 * Nomes preservados para os consumidores do daemon (`scratch-home.ts`,
 * `grok-session-cleanup.test.ts`) continuarem no mesmo import.
 */
export { tmpRoot as baseTmp, tmpDir as tmpdir, tmpFile as tmpPath } from "@the-dudes/test-utils";
