import type { GitFileStatus } from "./protocol.js";

/** Parseia `git status --porcelain=v1` preservando os dois campos XY.
 * Nunca aplique trim no output inteiro: um status de working tree começa
 * com espaço e isso desloca o path da primeira linha. */
export function parseGitPorcelain(output: string): GitFileStatus[] {
  return output.split(/\r?\n/).filter((line) => line.length >= 3).map((line) => ({
    status: line.slice(0, 2),
    path: line.slice(3).trim(),
  }));
}
