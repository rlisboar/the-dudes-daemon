# MCP bridge

Servidor MCP stdio que cada agente CLI carrega para conversar com o orchestrator. Implementado em `daemon/src/mcp-bridge.ts` usando `@modelcontextprotocol/sdk`.

## Como o agente "vê" o bridge

| Runner    | Configuração                                                                              |
|-----------|-------------------------------------------------------------------------------------------|
| Claude    | `--mcp-config /tmp/the-dudes/<agentId>/mcp.json`                                         |
| OpenCode  | `<workspaceRoot>/opencode.json` com `mcp.the-dudes.command`                              |
| Gemini    | `<agentTmpDir>/.gemini/settings.json` com `mcpServers.the-dudes`                         |
| Codex     | `-c mcp_servers.the-dudes.command=...` na linha de comando                               |

## Autenticação

Cada runner spawna o bridge com env vars:
- `THE_DUDES_AGENT_ID`
- `THE_DUDES_AGENT_NAME`
- `THE_DUDES_ORCH_URL` (default `http://127.0.0.1:8787`)
- `THE_DUDES_AGENT_TOKEN` (Bearer único, gerado a cada `startAgent`)

Toda chamada do bridge é `POST /api/bridge/<agentId>/<route>` com header `Authorization: Bearer <token>`. O orchestrator valida com `ProjectInstance.validateAgentToken`. Token é destruído quando o agente sai.

## Tools expostas

### `send_message`
Envia mensagem para outro agente do projeto.

```json
{
  "to": "Architect",
  "content": "Pode revisar o módulo de auth?"
}
```

- `to`: nome do teammate (ou `agentId`).
- Mensagem chega ao destinatário prefixada com `[from <sender_name>]: ...` + lembrete `(reply to <name> via mcp__the_dudes__send_message — plain text will NOT reach them)`.
- Retorna `delivered to <to>` ou erro `unknown teammate`.

### `list_agents`
Lista os outros agentes ativos.

```json
{}
```

- Resposta: `You are <name>.\nTeammates:\n- Architect: Senior Architect\n- ...`
- Filtra o próprio chamador.

### `list_tasks`
Lê o board.

```json
{}
```

- Resposta linha-a-linha: `- [<status>] <task_id> · <title>@<assignee_id>\n    <description>`

### `add_task`
Cria tarefa.

```json
{
  "title": "Implementar JWT refresh",
  "description": "...",
  "status": "todo",
  "assignee": "Coder"
}
```

- `status`: `todo` | `doing` | `done` | `blocked` (default `todo`).
- `assignee`: nome ou agentId; resolvido para `assigneeAgentId` no servidor.
- Resposta: `created task task_xxxx: "..." [status]`.

### `update_task`
Atualiza tarefa existente.

```json
{
  "id": "task_xxxx",
  "status": "doing",
  "assignee": "Coder"
}
```

- Passe `null` em `assignee` para remover responsável.
- Útil para o agente sinalizar progresso (`todo` → `doing` → `done`).

### `get_credential`
Recupera valor de credencial armazenada.

```json
{ "name": "GITHUB_TOKEN" }
```

- Lookup case-insensitive por nome.
- Resposta: o valor em texto puro (decriptografado on-demand).
- Erro `credential 'X' not found` se inexistente.
- Use sempre que precisar de uma API key — nunca peça o valor ao usuário no chat.

### `add_task_comment` / `list_task_comments`

```json
{ "taskId": "task_xxx", "content": "decisão tomada" }
```
e
```json
{ "taskId": "task_xxx" }
```

Adiciona comentário e lê histórico cronológico. Conteúdo cifrado E2EE
no DB; bridge-relay decifra na resposta usando project_key.

### `list_webhooks`

Sem args. Lista subscriptions do projeto: nome, direção
(outbound/inbound), enabled, eventos. **URL e secret nunca expostos.**
Use pra descobrir nomes válidos antes de `send_webhook`.

### `send_webhook`

```json
{ "webhookName": "Discord", "message": "deploy concluído" }
```

Posta uma mensagem custom num webhook outbound nomeado. Server formata
de acordo com o formato da sub (Discord/Slack/Generic), assina com HMAC
quando há secret, registra na delivery log. Requer chip
**Agente custom** (`agent:custom`) ou **Todos** ligado na sub. Rate
limit 30/min por agente. Detalhes em [WEBHOOKS.md](WEBHOOKS.md).

### `approve_action`
Tool especial — não é chamada pelo agente, mas pelo CLI Claude com `--permission-prompt-tool`. Quando uma tool requer aprovação:

```json
{
  "tool_name": "Bash",
  "input": { "command": "rm -rf foo" },
  "tool_use_id": "..."
}
```

Bridge faz `POST /permission`, orchestrator espera resolução do usuário (modal na UI), retorna `{ allow: true|false }`.

Resposta serializada conforme protocolo do Claude:
- Allow: `{"behavior":"allow","updatedInput":<input>}`
- Deny: `{"behavior":"deny","message":"..."}`

## System prompt (injetado no agente)

Cabeçalho compartilhado por todos os runners (`SYSTEM_PROMPT_HEADER` em `agent-runner.ts`):

```
You are part of a multi-agent team running locally.

# CRITICAL ROUTING RULE
- Direct text in your response is delivered ONLY to the human user.
- To talk to ANOTHER AGENT (teammate), you MUST use mcp__the_dudes__send_message — never as plain text.
- If a message arrives prefixed with [from <name>]:, that came from a teammate.
  Reply via mcp__the_dudes__send_message with to: "<name>".
- Plain text is for the user. Tool call is for teammates. Pick the right channel.

# Teammate communication
- mcp__the_dudes__list_agents
- mcp__the_dudes__send_message {to, content}

# Shared task board
- mcp__the_dudes__list_tasks
- mcp__the_dudes__add_task {title, description?, status?, assignee?}
- mcp__the_dudes__update_task {id, status?, ...}

# Credentials
- mcp__the_dudes__get_credential {name}

Use the board to coordinate. Mark `doing`/`done`. Stay in character. Be concise.
```

Append-system-prompt do agente segue depois com `# Your role` + role + system prompt customizado + (opcional) plan mode addendum.

## Tools permitidas (Claude)

Para reduzir surface de risco, Claude é spawnado com `--allowed-tools` explícito (apenas as MCP tools acima). Outras tools (Bash, Write, Edit, Read) só rodam se passarem pelo `permission-prompt-tool` (modal manual ou bypass).

## Roteamento e idempotência

- `routeAgentMessage` valida o destinatário; falha → retorna `404 unknown teammate`.
- O envio aparece como `kind: agent_to_agent` no log.
- Lembrete inline (`reply via mcp...`) garante que o destinatário não responda em texto puro.

## Erros típicos

| Origem                   | Exemplo                              | Como debugar                                   |
|--------------------------|--------------------------------------|-----------------------------------------------|
| 401 unauthorized         | bridge.ts: `bridge ... 401`          | Token expirado — agente foi reiniciado        |
| 404 agent not in project | Agente removido enquanto bridge vivo | Bridge filho fica zumbi — kill manual         |
| credential not found     | `get_credential` com nome errado     | Nome é case-insensitive — verifique digitação |

Logs HTTP do bridge não são roteados pra UI. Use console do orchestrator (`npm run dev:server`) ou `/logs`.
