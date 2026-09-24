/**
 * @the-dudes/test-utils — tipos do helper de diretório temporário de teste.
 * O par `.js`/`.d.ts` é mantido à mão, como em `net-guard`/`protocol`.
 */

/** Candidatos, na ordem em que o helper tenta (TMPDIR pode ser vazio). */
export function tmpCandidates(): string[];

/**
 * Diretório base gravável do processo de teste (cacheado — uma escolha por
 * processo). Lança, listando o que foi tentado, quando nenhum candidato aceita
 * `mkdtemp`. O diretório é removido no fim do processo (exit/SIGTERM/SIGINT).
 */
export function tmpRoot(): string;

/** Subdiretório novo dentro do tmpRoot. */
export function tmpDir(prefix: string): string;

/** Caminho de arquivo dentro do tmpRoot (para env vars de caminho). */
export function tmpFile(name: string): string;

/** Só para teste: o `os.tmpdir()` cru do ambiente (o que este helper substitui). */
export function tmpdirCru(): string;
