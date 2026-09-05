/**
 * T-253 (P1-7): o summarizer spawna o CLI com ENV POR ALLOWLIST. O histórico
 * era `{ ...process.env }` + 3 deletes → qualquer token/cloud key do daemon
 * ficava em /proc/<pid>/environ do filho (prompt injection → exfiltração).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSummarizerEnv, AGENT_ENV_ALLOWLIST } from "../runners/env.js";

const AQUI = dirname(fileURLToPath(import.meta.url));

test("T-253: buildSummarizerEnv NÃO vaza tokens/keys — só a allowlist sobrevive", () => {
  const env = buildSummarizerEnv({
    PATH: "/usr/bin", HOME: "/home/u", LANG: "C.UTF-8", TERM: "xterm", USER: "u", LOGNAME: "u",
    // segredos do daemon que o /proc do filho NÃO pode ver:
    THE_DUDES_DAEMON_TOKEN: "dtok",
    THE_DUDES_TOKEN: "tok",
    THE_DUDES_ENCRYPTION_KEY: "ek",
    THE_DUDES_AGENT_TOKEN: "atok",
    ANTHROPIC_API_KEY: "sk-ant-…",
    GOOGLE_API_KEY: "gk",
    XAI_API_KEY: "xk",
    OPENAI_API_KEY: "ok",
    AWS_SECRET_ACCESS_KEY: "aws",
    DATABASE_URL: "postgres://u:p@h/db",
    SOME_FUTURE_SECRET: "s",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/u"); // auth dos CLIs mora em HOME/config — tem que passar
  for (const leaked of [
    "THE_DUDES_DAEMON_TOKEN", "THE_DUDES_TOKEN", "THE_DUDES_ENCRYPTION_KEY", "THE_DUDES_AGENT_TOKEN",
    "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY", "OPENAI_API_KEY",
    "AWS_SECRET_ACCESS_KEY", "DATABASE_URL", "SOME_FUTURE_SECRET",
  ]) {
    assert.equal(env[leaked], undefined, `${leaked} vazou no env do summarizer`);
  }
  // segredo NOVO não precisa de patch: a ausência é o default (whitelist, não blacklist)
  assert.deepEqual(Object.keys(env).sort(), [...AGENT_ENV_ALLOWLIST].sort());
});

test("T-253: passthrough opt-in continua valendo para keys que PRECISAM vir de env", () => {
  const env = buildSummarizerEnv({
    PATH: "/usr/bin", HOME: "/home/u",
    THE_DUDES_AGENT_ENV_PASSTHROUGH: "TZ,XAI_API_KEY",
    TZ: "America/Sao_Paulo",
    XAI_API_KEY: "xk",
    AWS_SECRET_ACCESS_KEY: "aws",
  });
  assert.equal(env.TZ, "America/Sao_Paulo");
  assert.equal(env.XAI_API_KEY, "xk");
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, "sem passthrough continua fora");
});

test("T-253: summarizer-runner usa a allowlist (fonte lida — sem copy-total de process.env)", () => {
  const src = readFileSync(join(AQUI, "../summarizer-runner.ts"), "utf8");
  assert.match(src, /buildSummarizerEnv\(process\.env\)/);
  assert.doesNotMatch(src, /const env: NodeJS\.ProcessEnv = \{ \.\.\.process\.env \}/);
});
