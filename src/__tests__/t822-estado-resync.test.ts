/**
 * T-822: o open do WS reemite o estado NÃO crítico dos agentes.
 *
 * Achado (T-812): `outbound drop type=agent:running|state|usage_delta|context`
 * com o WS fora — 588 no perfil padrão em 7d. Esses tipos NÃO entram na fila de
 * reenvio (só text/error/hung/exit/thinking/tool_use entram), então o estado
 * morria no buraco: um `agent:running=false` perdido deixa o server achando que
 * o agente está vivo e as mensagens seguintes ficam retidas ("sem runner ativo
 * — enfileirado": 67× no .mac). running/state/context são SETTER idempotente no
 * server — reemitir o valor ATUAL no open é o conserto.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentHost } from "../agent-host.js";
import { isCriticalOutbound } from "../runners/outbound-delivery.js";

const asAny = (h: AgentHost) => h as unknown as Record<string, any>;

function hostComCaptura(): { host: AgentHost; enviados: Array<Record<string, unknown>> } {
  const enviados: Array<Record<string, unknown>> = [];
  const host = new AgentHost(
    (m) => { enviados.push(m as unknown as Record<string, unknown>); },
    null, null, {} as never, false, false, false, () => {}, () => {},
  );
  return { host, enviados };
}

function porTipo(enviados: Array<Record<string, unknown>>, tipo: string): Array<Record<string, unknown>> {
  return enviados.filter((m) => m.type === tipo);
}

test("T-822: reemite running/state do agente VIVO e running=false do morto", () => {
  const { host, enviados } = hostComCaptura();
  const entries = asAny(host).entries as Map<string, unknown>;
  entries.set("ag_vivo", { projectId: "p", info: { id: "ag_vivo" }, runner: { currentRuntimeState: () => "thinking", stop: () => {} } });
  entries.set("ag_morto", { projectId: "p", info: { id: "ag_morto" }, runner: null });

  host.reemitirEstadoNoHello();

  assert.deepEqual(porTipo(enviados, "agent:running"), [
    { type: "agent:running", agentId: "ag_vivo", running: true },
    { type: "agent:running", agentId: "ag_morto", running: false },
  ], "o server precisa da verdade de cada agente — running=false é o que destrava a entrega");
  assert.deepEqual(porTipo(enviados, "agent:state"), [
    { type: "agent:state", agentId: "ag_vivo", state: "thinking" },
  ], "agente morto não inventa state");
});

test("T-822: reemite o ÚLTIMO agent:context conhecido (e só se houver)", () => {
  const { host, enviados } = hostComCaptura();
  const entries = asAny(host).entries as Map<string, unknown>;
  entries.set("ag_vivo", { projectId: "p", info: { id: "ag_vivo" }, runner: { currentRuntimeState: () => "idle" } });
  entries.set("ag_sem_ctx", { projectId: "p", info: { id: "ag_sem_ctx" }, runner: { currentRuntimeState: () => "idle" } });
  // O cache é alimentado no callback `onContextUsage` do spawn; aqui entra direto
  // (o reemit só lê o último valor visto).
  (asAny(host).ultimoContexto as Map<string, unknown>).set("ag_vivo", { used: 12_000, limit: 200_000 });

  host.reemitirEstadoNoHello();

  assert.deepEqual(porTipo(enviados, "agent:context"), [
    { type: "agent:context", agentId: "ag_vivo", used: 12_000, limit: 200_000 },
  ]);
});

test("T-822: reemitir é idempotente (o server trata como setter, não evento)", () => {
  const { host, enviados } = hostComCaptura();
  (asAny(host).entries as Map<string, unknown>).set("ag", {
    projectId: "p", info: { id: "ag" }, runner: { currentRuntimeState: () => "speaking" },
  });
  host.reemitirEstadoNoHello();
  host.reemitirEstadoNoHello();
  const dois = enviados.length;
  assert.equal(dois % 2, 0);
  assert.deepEqual(enviados.slice(0, dois / 2), enviados.slice(dois / 2), "duas chamadas, mesmos frames");
});

test("T-822: runner sem currentRuntimeState não derruba a reemissão", () => {
  const { host, enviados } = hostComCaptura();
  (asAny(host).entries as Map<string, unknown>).set("ag", { projectId: "p", info: { id: "ag" }, runner: { stop: () => {} } });
  host.reemitirEstadoNoHello();
  assert.deepEqual(porTipo(enviados, "agent:running"), [{ type: "agent:running", agentId: "ag", running: false }]);
  assert.equal(porTipo(enviados, "agent:state").length, 0);
});

test("T-822: só o não crítico é descartado — o crítico é ENFILEIRADO (texto do log)", () => {
  // O log dizia "outbound drop" para os dois casos; quem lê precisa distinguir
  // (e o parser do histórico casa o texto "descartado").
  assert.equal(isCriticalOutbound({ type: "agent:text" }), true);
  assert.equal(isCriticalOutbound({ type: "agent:exit" }), true);
  for (const tipo of ["agent:running", "agent:state", "agent:usage_delta", "agent:context"]) {
    assert.equal(isCriticalOutbound({ type: tipo }), false, `${tipo} é descartado com o WS fora`);
  }
});