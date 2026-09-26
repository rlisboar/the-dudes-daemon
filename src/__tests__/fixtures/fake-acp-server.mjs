#!/usr/bin/env node
/**
 * T-690: fake do servidor ACP v1 stdio do dsh para testes do cliente.
 * Fala NDJSON JSON-RPC 2.0 (linhas em stdout), registra o que RECEBEU no
 * arquivo de FAKE_ACP_LOG (JSONL) e simula o fluxo real do profile `acp`
 * (initialize/session/new/set_config_option/prompt/updates/permission/
 * cancel/close/resume) sem depender do binário instalado.
 */
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const LOG = process.env.FAKE_ACP_LOG ?? "/tmp/fake-acp-log.jsonl";
const log = (dir, obj) => appendFileSync(LOG, JSON.stringify({ dir, ts: Date.now(), ...obj }) + "\n");

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const result = (id, res) => out({ jsonrpc: "2.0", id, result: res });
const notify = (method, params) => out({ jsonrpc: "2.0", method, params });

const SESSION_ID = "57eb3eca-0a64-411f-890d-8478bef47e71";
/** Par dsflash (rota COM chave) — o default do catálogo real é o official. */
const DSFLASH_VALUE = '["dsflash","deepseek-flash-41"]';
let sessionId = null;
let modelValue = '["deepseek-official","deepseek-v4-flash"]';
let effortValue = "high";
let promptInFlight = null;
let promptCount = 0;
let cancelRequested = false;
let serverReqId = 100;

const configOptions = () => [
  {
    id: "model", name: "Model", category: "model", type: "select", currentValue: modelValue,
    options: [
      {
        group: "deepseek-official", name: "DeepSeek",
        options: [
          { value: '["deepseek-official","deepseek-v4-flash"]', name: "DeepSeek-V4-Flash", description: "Fast" },
          { value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro" },
        ],
      },
      {
        group: "dsflash", name: "DeepSeek Flash 4.1 (dsflash)",
        options: [{ value: '["dsflash","deepseek-flash-41"]', name: "DeepSeek Flash 4.1 (SGLang · 1M)" }],
      },
    ],
  },
  {
    id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select", currentValue: effortValue,
    options: [{ value: "off", name: "Off" }, { value: "low", name: "Low" }, { value: "high", name: "High" }, { value: "max", name: "Max" }],
  },
];

const PROMPT_TEXT = "responda OK";

function handle(msg) {
  log("recv", msg);
  if (msg.method === "initialize") {
    return result(msg.id, {
      protocolVersion: 1,
      agentInfo: { name: "deepseek-harness-acp", version: "0.0.0-fake" },
      agentCapabilities: { promptCapabilities: { image: false }, sessionCapabilities: { close: {}, list: {}, resume: {} } },
      authMethods: [],
    });
  }
  if (msg.method === "session/new") {
    // T-726: simula o MCP que não conecta (o dsh real devolve isto ~63s depois).
    const quebrado = process.env.FAKE_ACP_FAIL_MCP;
    if (quebrado && (msg.params?.mcpServers ?? []).some((m) => m?.name === quebrado)) {
      return out({
        jsonrpc: "2.0", id: msg.id,
        error: { code: -32603, message: "Internal error", data: { details: `mcp-client(${quebrado}): initial connection or tool synchronization failed` } },
      });
    }
    sessionId = SESSION_ID;
    return result(msg.id, { sessionId, configOptions: configOptions() });
  }
  if (msg.method === "session/resume") {
    sessionId = msg.params?.sessionId ?? SESSION_ID;
    return result(msg.id, { sessionId, configOptions: configOptions() });
  }
  if (msg.method === "session/set_config_option") {
    if (msg.params?.configId === "model") modelValue = String(msg.params?.value);
    if (msg.params?.configId === "reasoning_effort") effortValue = String(msg.params?.value);
    return result(msg.id, { configOptions: configOptions() });
  }
  if (msg.method === "session/prompt") {
    const text = msg.params?.prompt?.[0]?.text ?? "";
    // T-796: no host do dono a rota `deepseek-official` NÃO tem chave e o
    // prompt morre em ~180ms com -32603. Com esta flag o fake reproduz isso —
    // o prompt só passa se a sessão tiver sido configurada para dsflash.
    if (process.env.FAKE_ACP_REQUIRE_DSFLASH && modelValue !== DSFLASH_VALUE) {
      return out({
        jsonrpc: "2.0", id: msg.id,
        error: { code: -32603, message: "Internal error: turn failed: llm-deepseek: no API key for provider route \"deepseek-official\"" },
      });
    }
    promptCount++;
    promptInFlight = { id: msg.id, text };
    // Updates na ordem do contrato: thought → tool (call+update) → texto → usage.
    notify("session/update", { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "pensando…" } } });
    // T-827: o dsh real manda os argumentos no rawInput do tool_call (dsh 0.1.5).
    notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tc_1", title: "list_tasks", kind: "other", status: "pending", rawInput: { status: "open", limit: 5 } } });
    // Permission request (server→client) — só depois da resposta seguimos.
    const pid = serverReqId++;
    out({ jsonrpc: "2.0", id: pid, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "tc_1" }, options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }, { optionId: "reject_once", name: "Reject", kind: "reject_once" }] } });
    return; // settle acontece quando a resposta da permissão chegar (route abaixo)
  }
  if (msg.method === "session/close") {
    sessionId = null;
    return result(msg.id, {});
  }
  if (msg.method === "session/cancel") {
    // Cancela o prompt em voo; o settle sai quando a resposta da permissão
    // chegar (janela testável), com stopReason cancelled.
    if (promptInFlight) cancelRequested = true;
    return;
  }
  if (msg.id !== undefined && msg.result !== undefined && !msg.method) {
    // Resposta à request_permission.
    if (promptInFlight && msg.result?.outcome?.optionId) {
      const { id, text } = promptInFlight;
      if (msg.result.outcome.optionId === "reject_once") {
        promptInFlight = null;
        notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "tc_1", status: "failed" } });
        return result(id, { stopReason: "permission_denied" });
      }
      // Janela de 300ms p/ um session/cancel chegar antes do settle.
      setTimeout(() => {
        const wasCancelled = cancelRequested;
        promptInFlight = null;
        cancelRequested = false;
        if (wasCancelled) return result(id, { stopReason: "cancelled" });
        notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "tc_1", status: "completed" } });
        const replies = process.env.FAKE_ACP_REPLY_SEQUENCE?.split("|");
        const responseText = replies?.[promptCount - 1] ?? (text.includes(PROMPT_TEXT) ? "OK" : text);
        notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: randomUUID(), content: { type: "text", text: responseText } } });
        notify("session/update", { sessionId, update: { sessionUpdate: "usage_update", used: 7457 + (promptCount - 1) * 531, size: 1048576 } });
        result(id, { stopReason: "end_turn" });
      }, 300);
    }
    return;
  }
  if (msg.id !== undefined && msg.method) {
    return result(msg.id, {});
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (e) { log("parse_error", { line, err: String(e) }); }
  }
});
process.stdin.on("end", () => { log("eof", {}); process.exit(0); });
log("boot", {});
