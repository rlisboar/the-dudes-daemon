import { createHmac } from "node:crypto";
import { decryptForProject, isE2eEncrypted } from "./daemon-crypto.js";

type Format = "generic" | "discord" | "slack";

/** Recursively walk an object/array and decrypt any string field that
 *  starts with "e2e:" using the project's symmetric key. The structure
 *  is preserved; only cipher leaves are replaced. */
function decryptDeep(value: any, projectId: string): any {
  if (typeof value === "string") {
    if (isE2eEncrypted(value)) return decryptForProject(value, projectId) ?? value;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => decryptDeep(v, projectId));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = decryptDeep(v, projectId);
    return out;
  }
  return value;
}

function colorForEvent(t: string): number {
  if (t.startsWith("agent:")) return 0x7aa2ff;
  if (t.startsWith("task:")) return 0xa78bfa;
  if (t.startsWith("goal:")) return 0xf59e0b;
  if (t.startsWith("schedule:")) return 0x60a5fa;
  if (t.startsWith("permission:")) return 0xf0a4a4;
  if (t.startsWith("credential:")) return 0xfbbf24;
  if (t === "webhook:test") return 0x7fdc8a;
  return 0x9aa3b6;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

interface EventDescription {
  title: string;
  description?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

/** Plaintext event renderer. Mirrors server/src/webhooks.ts describeEvent
 *  but assumes inputs are already decrypted. agentNames maps agentId →
 *  human name and is applied to from/to/assignee/etc fields when known. */
function describeEvent(event: any, agentNames: Record<string, string> = {}): EventDescription {
  const nameFor = (id: unknown): string => {
    const s = String(id ?? "?");
    return agentNames[s] ?? s;
  };
  const t = event.type as string;
  if (t === "webhook:test") {
    return { title: "Webhook test", description: "Disparado da página de configuração para verificar a entrega." };
  }
  if (t === "message") {
    const msg = event.msg ?? {};
    const kindMap: Record<string, string> = {
      user_to_agent: "Usuário → agente",
      agent_to_user: "Agente → usuário",
      agent_to_agent: "Agente → agente",
      system: "Sistema",
    };
    const kind = kindMap[msg.kind as string] ?? msg.kind ?? "?";
    // Emphasize the message content as the embed description so the
    // reader sees it first, with from/to as small inline metadata.
    const content = typeof msg.content === "string" ? msg.content.trim() : "";
    return {
      title: `${nameFor(msg.from)} → ${nameFor(msg.to)}`,
      description: content || undefined,
      fields: [
        { name: "tipo", value: kind, inline: true },
      ],
    };
  }
  if (t === "task:added" || t === "task:updated") {
    const task = event.task ?? {};
    const num = task.taskNumber ? `#${task.taskNumber} · ` : "";
    const titleStr = typeof task.title === "string" ? truncate(task.title, 100) : "(sem título)";
    const fields: EventDescription["fields"] = [
      { name: "status", value: String(task.status ?? "?"), inline: true },
    ];
    if (task.assigneeAgentId) fields.push({ name: "assignee", value: nameFor(task.assigneeAgentId), inline: true });
    if (task.createdBy) fields.push({ name: "criado por", value: nameFor(task.createdBy), inline: true });
    return {
      title: `${t === "task:added" ? "Task criada" : "Task atualizada"} — ${num}${titleStr}`,
      description: typeof task.description === "string" && task.description ? truncate(task.description, 1500) : undefined,
      fields,
    };
  }
  if (t === "task:removed") {
    return { title: "Task removida" };
  }
  if (t === "task:comment:added") {
    const c = event.comment ?? {};
    const author = c.authorName ?? nameFor(c.authorId);
    return {
      title: `Comentário de ${author}`,
      description: typeof c.content === "string" ? truncate(c.content, 1500) : undefined,
    };
  }
  if (t === "agent:added" || t === "agent:updated") {
    const a = event.agent ?? {};
    return {
      title: `${t === "agent:added" ? "Agente adicionado" : "Agente atualizado"}: ${a.name ?? "?"}`,
      fields: [
        { name: "estado", value: String(a.state ?? "?"), inline: true },
      ],
    };
  }
  if (t === "agent:removed") {
    return { title: `Agente removido: ${nameFor(event.id)}` };
  }
  if (t === "agent:running") {
    return {
      title: `${nameFor(event.id)} ${event.running ? "iniciado" : "parado"}`,
    };
  }
  if (t === "agent:state") {
    return {
      title: `${nameFor(event.id)}: ${String(event.state ?? "?")}`,
    };
  }
  if (t === "schedule:fired") {
    const title = typeof event.title === "string" && event.title
      ? truncate(event.title, 120)
      : String(event.id ?? "?").slice(0, 16);
    const status = String(event.status ?? "ok");
    const reason = typeof event.reason === "string" ? truncate(event.reason, 80) : undefined;
    const delivered = Array.isArray(event.deliveredTo) ? event.deliveredTo.length : 0;
    return {
      title: `Schedule ${status}: ${title}`,
      description: reason,
      fields: [
        { name: "status", value: status, inline: true },
        { name: "entregues", value: String(delivered), inline: true },
      ],
    };
  }
  if (t === "goal:added" || t === "goal:updated") {
    const g = event.goal ?? {};
    const titleStr = typeof g.title === "string" ? truncate(g.title, 100) : "(sem título)";
    return {
      title: `${t === "goal:added" ? "Goal criada" : "Goal atualizada"}: ${titleStr}`,
      description: typeof g.description === "string" && g.description ? truncate(g.description, 1500) : undefined,
    };
  }
  if (t === "goal:removed") {
    return { title: "Goal removida" };
  }
  if (t === "permission:request") {
    const r = event.req ?? {};
    return {
      title: `Pedido de permissão: ${r.toolName ?? "?"}`,
      fields: [
        { name: "agente", value: nameFor(r.agentId), inline: true },
      ],
    };
  }
  if (t === "credential:added" || t === "credential:updated") {
    const c = event.credential ?? {};
    return {
      title: `${t === "credential:added" ? "Credencial adicionada" : "Credencial atualizada"}: ${c.name ?? "?"}`,
    };
  }
  if (t === "credential:removed") {
    return { title: "Credencial removida" };
  }
  return { title: t };
}

function buildPayload(event: any, opts: { projectId: string; projectName: string; agentNames: Record<string, string>; format: Format }): string {
  const desc = describeEvent(event, opts.agentNames);
  const ts = new Date().toISOString();
  const headerLine = `the-dudes · ${desc.title}`;
  const projectLabel = opts.projectName || opts.projectId;
  if (opts.format === "discord") {
    const fields = (desc.fields ?? []).map((f) => ({
      name: truncate(f.name, 256),
      value: truncate(f.value || "—", 1024),
      inline: !!f.inline,
    }));
    return JSON.stringify({
      username: "The Dudes",
      embeds: [{
        author: { name: projectLabel },
        title: desc.title,
        description: desc.description ? truncate(desc.description, 4000) : undefined,
        color: colorForEvent(event.type),
        timestamp: ts,
        fields: fields.length > 0 ? fields : undefined,
        footer: { text: event.type },
      }],
    });
  }
  if (opts.format === "slack") {
    const blocks: any[] = [
      { type: "header", text: { type: "plain_text", text: headerLine, emoji: true } },
    ];
    if (desc.description) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: truncate(desc.description, 2900) } });
    }
    if (desc.fields && desc.fields.length > 0) {
      const items = desc.fields.map((f) => ({ type: "mrkdwn" as const, text: `*${f.name}*\n${truncate(f.value || "—", 1900)}` }));
      for (let i = 0; i < items.length; i += 10) {
        blocks.push({ type: "section", fields: items.slice(i, i + 10) });
      }
    }
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `\`${event.type}\` · ${projectLabel} · ${ts}` }] });
    return JSON.stringify({ text: headerLine, blocks });
  }
  return JSON.stringify({
    content: headerLine,
    text: headerLine,
    event: event.type,
    timestamp: ts,
    projectId: opts.projectId,
    projectName: opts.projectName,
    data: event,
  });
}

export interface DispatchResult {
  status: number | null;
  body: string;
  error?: string;
}

export async function dispatchWebhook(args: {
  event: any;
  projectId: string;
  projectName?: string;
  agentNames?: Record<string, string>;
  url: string;
  secret: string | null;
  format: Format;
  headers?: Record<string, string>;
}): Promise<DispatchResult> {
  const decrypted = decryptDeep(args.event, args.projectId);
  const payload = buildPayload(decrypted, {
    projectId: args.projectId,
    projectName: args.projectName ?? args.projectId,
    agentNames: args.agentNames ?? {},
    format: args.format,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-The-Dudes-Event": String(decrypted?.type ?? "unknown"),
    ...(args.headers ?? {}),
  };
  if (args.secret) {
    headers["X-The-Dudes-Signature"] = `sha256=${createHmac("sha256", args.secret).update(payload).digest("hex")}`;
  }
  try {
    // SSRF guard: orchestrator manda webhook url; outbound vai pela
    // rede do user (LAN). checkOutboundUrl do server cobre só a pipe
    // server-side. Aqui replicamos pra fechar SSRF via daemon pivot.
    // safeFetch revalida cada redirect — fetch default segue 30x e um
    // 302 → http://169.254.169.254/ furava o guard inicial.
    // maxRedirects:0 — safeFetch reenvia os MESMOS headers em cada hop, então
    // seguir um 30x cross-origin vazaria a assinatura HMAC + headers de auth
    // custom pro host de destino. Webhook não segue redirect.
    const { safeFetch } = await import("./ssrf-guard.js");
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 10_000);
    // Tipo derivado do próprio safeFetch: ele devolve a Response da undici,
    // que não é a Response global do DOM (falta `bytes`, entre outras).
    let resp: Awaited<ReturnType<typeof safeFetch>>;
    try {
      resp = await safeFetch(args.url, { method: "POST", headers, body: payload, signal: ctrl.signal }, { maxRedirects: 0 });
    } catch (e) {
      clearTimeout(tm);
      return { status: null, body: "", error: `webhook bloqueado: ${(e as Error).message}` };
    }
    clearTimeout(tm);
    const body = await resp.text().catch(() => "");
    return { status: resp.status, body: body.slice(0, 2000) };
  } catch (e) {
    return { status: null, body: "", error: (e as Error).message };
  }
}
