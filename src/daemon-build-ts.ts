/**
 * Epoch ms injetado no bundle assinado (T-088 anti-rollback).
 * esbuild define `process.env.DAEMON_BUILD_TS` → Number("1730…").
 * 0 = dev/tsx (sem define). Extraído do .cjs via extractBuildTs (regex no
 * identificador DAEMON_BUILD_TS), sem executar o binário novo.
 */
export const DAEMON_BUILD_TS = Number(process.env.DAEMON_BUILD_TS || "0");
