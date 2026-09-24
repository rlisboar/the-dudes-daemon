#!/usr/bin/env node
/**
 * T-1063/T-1072: fake do agente ACP para os casos de FALHA e de resume do driver
 * do grok.
 *
 * O modo vem de um ARQUIVO apontado por `T1063_MODE_FILE` (o runner passa env ao
 * CLI por allowlist — o teste usa `THE_DUDES_AGENT_ENV_PASSTHROUGH`; sem isso o
 * fake cai no caminho fixo antigo, que duas execuções simultâneas colidiam).
 *
 * Modo (JSON no arquivo):
 *   { "caps": "load" | "resume",     // capability anunciada no initialize
 *     "falha": "" | "load" | "initialize",  // passo que REPROVA
 *     "log": "/caminho/do/log.jsonl" }      // onde registrar o que recebeu
 *
 * `caps: "resume"` anuncia SÓ `sessionCapabilities.resume` e trata `session/load`
 * como método inexistente — é o peer do ramo `caps.resume` (T-1072).
 */
import { appendFileSync, readFileSync } from "node:fs";

// Fallback só para uso manual do fake; os testes SEMPRE passam T1063_MODE_FILE
// (via THE_DUDES_AGENT_ENV_PASSTHROUGH) apontando para um dir único da execução.
const CAMINHO_FIXO = "/tmp/t1063-acp-mode.json";
const modoAtual = () => {
  try { return JSON.parse(readFileSync(process.env.T1063_MODE_FILE || CAMINHO_FIXO, "utf8")); } catch { return {}; }
};
const log = (obj) => {
  const caminho = modoAtual().log;
  if (!caminho) return;
  try { appendFileSync(caminho, JSON.stringify({ ts: Date.now(), ...obj }) + "\n"); } catch { /* best-effort */ }
};
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const result = (id, res) => out({ jsonrpc: "2.0", id, result: res });
const erro = (id, message) => out({ jsonrpc: "2.0", id, error: { code: -32603, message } });
const notify = (method, params) => out({ jsonrpc: "2.0", method, params });

let sessionId = null;

function handle(msg) {
  const modo = modoAtual();
  log({ method: msg.method ?? "(resposta)", id: msg.id ?? null });

  if (msg.method === "initialize") {
    if (modo.falha === "initialize") return erro(msg.id, "initialize falhou (T-1063)");
    const caps = modo.caps === "resume"
      ? { promptCapabilities: { image: false }, sessionCapabilities: { resume: {} } }
      : { loadSession: true, promptCapabilities: { image: false }, sessionCapabilities: { resume: {} } };
    return result(msg.id, { protocolVersion: 1, agentCapabilities: caps, authMethods: [] });
  }
  if (msg.method === "session/load") {
    // Peer que só tem `resume`: `session/load` é método inexistente para ele.
    if (modo.caps === "resume") return erro(msg.id, "method not found: session/load");
    if (modo.falha === "load") return erro(msg.id, "session not resumable: sessão expurgada (T-1063)");
    sessionId = msg.params?.sessionId ?? "sessao-carregada";
    return result(msg.id, { sessionId, configOptions: [] });
  }
  if (msg.method === "session/resume") {
    sessionId = msg.params?.sessionId ?? "sessao-retomada-1";
    return result(msg.id, { sessionId, configOptions: [] });
  }
  if (msg.method === "session/new") {
    sessionId = "sessao-nova-1";
    return result(msg.id, { sessionId, configOptions: [{ id: "model", currentValue: "m1", options: [{ value: "m1", name: "M1" }] }] });
  }
  if (msg.method === "session/set_config_option") return result(msg.id, { configOptions: [] });
  if (msg.method === "session/prompt") {
    const texto = msg.params?.prompt?.[0]?.text ?? "";
    notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ECO:${texto.slice(-12)}` } } });
    return result(msg.id, { stopReason: "end_turn" });
  }
  if (msg.id !== undefined && msg.method) return result(msg.id, {});
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const linha = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!linha) continue;
    try { handle(JSON.parse(linha)); } catch (e) { log({ parse_error: String(e) }); }
  }
});
process.stdin.on("end", () => process.exit(0));
log({ boot: true });
