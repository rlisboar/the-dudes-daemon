# Daemon — instalação e operação

O **the-dudes-daemon** roda na máquina de cada usuário e executa
os agentes localmente (a cada `Iniciar` na UI, o orchestrator manda
um `agent:spawn` para o daemon do owner; o daemon spawna o CLI
correspondente — `claude`, `opencode`, `gemini`, `codex` — usando o
workspace local do usuário).

Sem daemon online, o orchestrator recusa spawn/start de agentes do
usuário e a UI mostra `○ daemon` em vermelho.

---

## Pré-requisitos da máquina destino

- **Node ≥ 18** (recomendado 20+). `node --version`.
- **git** com credenciais válidas (SSH key, gh, netrc) para clonar
  os repositórios do projeto. Teste com `git ls-remote <git-url>`.
- **CLI(s) do(s) agente(s) que pretende usar**, no `$PATH`:
  - `claude` (Claude Code CLI)
  - `opencode`
  - `gemini`
  - `codex`
- **Acesso de rede** ao orchestrator (URL + porta 8787 alcançáveis).

A máquina destino **não** precisa de Docker, Postgres ou clone do
monorepo — só Node e curl.

---

## Pré-requisito do orchestrator

Antes de servir os bundles, no host do orchestrator, gere uma vez:

```bash
npm run build --workspace daemon
```

Gera `daemon/dist/daemon.cjs` e `daemon/dist/mcp-bridge.cjs`. Sem isso,
`/install/daemon.cjs` retorna 404.

---

## Instalação manual (passo-a-passo, sem agent)

### 1. Mint do token (na UI web)

1. Abra `http://<orch-host>:5173`, faça login.
2. Clique no pill `○ daemon` (canto superior direito) ou
   **Configurações → Meu daemon**.
3. Em **Mint novo token**, dê um label (ex `laptop-rodrigo`) e clique
   **Gerar**.
4. **Copie o token** mostrado — só aparece uma vez.

O modal mostra dois comandos prontos: o **install** (one-liner curl)
e o **runManual** (node …). Copie o de instalação.

### 2. Instalar na máquina destino

```bash
curl -fsSL <ORCH_URL>/install-daemon.sh | sh -s -- <ORCH_URL> <TOKEN> [NOME]
```

Exemplo concreto:

```bash
curl -fsSL http://192.168.15.177:8787/install-daemon.sh | \
  sh -s -- http://192.168.15.177:8787 IhcKOPPE1Bgx... laptop-rodrigo
```

Baixa para `~/.the-dudes/daemon.cjs` (167 KB) e
`~/.the-dudes/mcp-bridge.cjs` (712 KB). Idempotente — re-rode para
atualizar.

### 3. Rodar o daemon (foreground, primeiro teste)

```bash
node ~/.the-dudes/daemon.cjs \
  --orch <ORCH_URL> \
  --token <TOKEN> \
  --name <NOME>
```

Para depuração, adicione `-v` para log bruto, `-vh` para verbose
humanizado, ou `-vhio` para mostrar só os canais reais de I/O dos CLIs
externos (`argv`, `stdin`, `stdout`, `stderr`)
externos em formato legível.

Output esperado:
```
[ts] [info] connecting to ws://<host>/ws/daemon…
[ts] [info] connected · sending hello
[ts] [info] authed as <Seu Nome> <email>
```

Na UI, o pill vira `● daemon` (verde) em até 1s. Se ficar `○`:
- Verifique URL e firewall (porta 8787 entrante na máquina central).
- Token errado/revogado → mint outro.

`Ctrl-C` para parar (foreground). Em background, ver seção
**Persistência** abaixo.

### 4. Definir workspace local + clonar repos

Na UI: **Configurações → Meu workspace** → digite um diretório
local da máquina destino (ex `/Users/rodrigo/projetos/the-dudes-x`)
→ **Salvar e clonar repos**.

O daemon valida o path, cria se faltar, e roda
`git clone <repo.gitUrl> <basePath>/<repo.name>` para cada repo do
projeto. Usa as credenciais git locais (SSH agent, netrc).

Toast `workspace ready: ✓ repo-x (cloned)` confirma.

### 5. Spawn de agente

ControlPanel → **+ preset** ou **+ customizado** → Spawn. O agent
roda na máquina destino, com `cwd = <basePath>/<repo>`.

O endpoint `/install/daemon.cjs` retorna 200 + bundle se built.
404 indica que o host orchestrator esqueceu o
`npm run build --workspace daemon`.

---

## Persistência (rodar como serviço)

Substitua `<USER>`, `<ORCH_URL>`, `<TOKEN>`, `<NOME>`.

### macOS (launchd, user-level)

`~/Library/LaunchAgents/com.the-dudes.daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.the-dudes.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/<USER>/.the-dudes/daemon.cjs</string>
    <string>--orch</string><string><ORCH_URL></string>
    <string>--token</string><string><TOKEN></string>
    <string>--name</string><string><NOME></string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/the-dudes-daemon.log</string>
  <key>StandardErrorPath</key><string>/tmp/the-dudes-daemon.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.the-dudes.daemon.plist
# ver logs
tail -f /tmp/the-dudes-daemon.log
# parar
launchctl unload ~/Library/LaunchAgents/com.the-dudes.daemon.plist
```

Use `which node` para confirmar o path; ajuste se diferente.

### Linux (systemd user)

`~/.config/systemd/user/the-dudes-daemon.service`:

```ini
[Unit]
Description=The Dudes daemon
After=network-online.target

[Service]
ExecStart=/usr/bin/node %h/.the-dudes/daemon.cjs --orch <ORCH_URL> --token <TOKEN> --name <NOME>
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now the-dudes-daemon
journalctl --user -u the-dudes-daemon -f
```

### pm2 (cross-platform, sem root)

```bash
pm2 start ~/.the-dudes/daemon.cjs --name the-dudes-daemon -- \
  --orch <ORCH_URL> --token <TOKEN> --name <NOME>
pm2 save
pm2 startup   # siga o comando que ele imprime para auto-start no boot
pm2 logs the-dudes-daemon
```

### Variáveis de ambiente (alternativa às flags)

O daemon aceita:
- `THE_DUDES_ORCH — URL do orchestrator
- `THE_DUDES_DAEMON_TOKEN` — bearer token
- `THE_DUDES_DAEMON_NAME` — label

---

## Atualização

Quando o orchestrator publicar novos bundles:

```bash
curl -fsSL <ORCH_URL>/install-daemon.sh | sh -s -- <ORCH_URL> <TOKEN>
# reiniciar o serviço:
launchctl kickstart -k gui/$UID/com.the-dudes.daemon   # macOS
systemctl --user restart the-dudes-daemon               # linux
pm2 restart the-dudes-daemon                             # pm2
```

---

## Troubleshooting

| Sintoma                                                      | Causa provável                                                                        | Correção                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `connect EHOSTUNREACH <host>:5173` (mas browser conecta na mesma porta) | Firewall outbound app (Little Snitch / Lulu / antivirus corp / VPN) interceptando node. | Rodar com `sudo --preserve-env=PATH,HOME` (esperado). Daemon faz drop de uid pros filhos + relay Unix-socket pra MCP bridges. Veja **Firewall outbound** abaixo. |
| MCP `send_message`/`list_agents` retornam `fetch failed` mas daemon conecta OK | Mesmo firewall outbound bloqueia o `node` do MCP bridge (que roda como user). | Restart daemon com bundle ≥ 13:35 (que ativa o bridge relay) + Stop+Start cada agent na UI pra pegar `THE_DUDES_BRIDGE_SOCKET` no MCP config. |
| `error: invalid token`                                       | Token revogado/errado, ou nunca chegou na máquina.                                    | Mint novo na UI. Cheque copy/paste.                                                       |
| Pill `○ daemon` permanece offline                            | Firewall na máquina central bloqueia 8787 entrante.                                   | Libere TCP 8787. Em mac, aceite popup do macOS na 1ª conexão.                             |
| `installed.` mas `node ~/.the-dudes/daemon.cjs` falha       | `node` não está em `$PATH` para usuários não-interativos.                             | Use path absoluto (`/usr/local/bin/node`) na unit/plist.                                  |
| `cwd "/path/x" not found` ao spawn agent                     | Workspace não definido ou repo não clonado para o usuário owner.                      | UI → Settings → Meu workspace.                                                            |
| `git clone` falha com `Permission denied (publickey)`        | Falta SSH key para o repo na máquina destino.                                         | `ssh-add` ou copiar key. Teste com `git ls-remote <repo-url>`.                            |
| Daemon conecta mas spawn não acontece                        | `claude`/`opencode`/`gemini`/`codex` não está no `$PATH`.                             | Instale o CLI; verifique com `which claude`.                                              |
| Agent inicia mas trava sem responder                         | API key do provider ausente (Anthropic/OpenAI/Google).                                | Configure conforme docs do CLI escolhido.                                                 |
| `agent:error session invalid — restarting` em loop           | Sessão Claude expirou/foi corrompida no `.claude/projects/...`.                       | Limpar contexto na UI (`Limpar ctx`) ou apagar o agent + criar de novo.                   |

Logs do daemon são prefixados com `[ts] [level] msg`. Tudo que vai
para `stderr` é replicado como `[stderr] …` no log de mensagens da UI.

---

## Firewall outbound (Little Snitch / Lulu / antivirus / VPN)

Sintoma: `connect EHOSTUNREACH` no daemon, mas `nc -vz <orch-host> 5173`
diz `succeeded` e o browser na mesma máquina abre `http://<orch-host>:5173`
sem problema.

Causa: firewall outbound de aplicativo (geralmente Little Snitch ou Lulu
no macOS, ou antivirus/Cisco AnyConnect/CrowdStrike Falcon em ambiente
corporativo) intercepta o socket do `node` mas deixa o tráfego do
browser passar (browser usa APIs de sistema como NSURLSession).

### Verificação rápida

```bash
sudo --preserve-env=PATH,HOME node ~/.the-dudes/daemon.cjs --orch http://<orch>:5173 --token <T>
```

Se com `sudo` o daemon conecta (`authed as ...`), confirma o diagnóstico.

### Sudo é seguro neste daemon

O daemon detecta `SUDO_USER`/`SUDO_UID`/`SUDO_GID` e dropa privilégios
em **todos os spawns de filhos** — `claude`/`opencode`/`gemini`/`codex`,
`git clone`, MCP bridge — usando `uid`/`gid`/`HOME`/`USER`/`PATH` do
usuário original.

Apenas dois pontos rodam como root:
1. O socket WS de saída para o orchestrator (necessário para furar o
   firewall outbound).
2. Um relay HTTP local em **Unix socket** (`/tmp/the-dudes-bridge-<pid>.sock`,
   chown pro `SUDO_USER`, mode 0660). Esse relay é o que permite que
   as MCP bridges dos agents (rodando como user) cheguem no orchestrator
   sem hit no firewall outbound — elas falam HTTP via socket loopback,
   não fetch direto.

Logs no startup mostram:
```
running as root via sudo — child processes will drop to uid=501 (rodrigo) home=/Users/rodrigo
bridge relay listening on /tmp/the-dudes-bridge-12345.sock
```

Se ambas linhas aparecerem, o drop + relay estão ativos. Arquivos
criados pelos agents pertencem ao `SUDO_USER`, não a root.

**Recomendação**: use `sudo --preserve-env=PATH,HOME` (não só `sudo`)
para não perder o `PATH` (onde estão `claude`/etc) e o `HOME`
(usado por `~/.claude/`, `~/.gemini/`, `~/.opencode/`).

### Quando fizer stop/start dos agents após upgrade do daemon

Os MCP configs dos agents (claude `mcp.json`, gemini `settings.json`,
codex `-c`, opencode `opencode.json`) recebem o `THE_DUDES_BRIDGE_SOCKET`
no momento do **spawn**. Agents que já estavam rodando antes de o relay
existir continuam tentando fetch direto e vão falhar com `fetch failed`.
Solução: na UI, **Stop** seguido de **Iniciar** em cada agent. Eles
respawnam com a env nova.

### Soluções permanentes

**macOS — Little Snitch:**
1. Abra Little Snitch Configuration.
2. New Rule → Allow Connections.
3. Process: `/usr/local/bin/node` (ou path do `which node`).
4. Direção: Outgoing.
5. Remote: `<orch-host>:5173` (ou Any para permitir qualquer destino).

**macOS — Lulu:**
1. Open Lulu → Rules.
2. Add → Process → selecione binário do `node`.
3. Action: Allow.

**macOS — Application Firewall (built-in):**
```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$(which node)"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$(which node)"
```

**Windows — Defender/firewall corp:**
Adicionar regra de saída pra `node.exe` em `Control Panel → Windows
Defender Firewall → Advanced settings → Outbound rules → New Rule`.

**Linux — iptables/ufw:**
Geralmente outbound é livre por default. Se houver bloqueio, contatar
admin.

**Antivirus / EDR corporativo (CrowdStrike, SentinelOne, Sophos, etc.):**
Pedir ao TI para incluir o binário do `node` (e `~/.the-dudes/daemon.cjs`)
na allowlist. Pode levar tempo — workaround é rodar como serviço com
privilégios elevados.

---

## Para automação (Claude Code / outro agent)

Use este checklist se precisar instalar via agent SSH/local:

**Inputs obrigatórios** (o usuário tem que fornecer):
- `ORCH_URL` — ex `http://192.168.15.177:8787`
- `TOKEN` — gerado na UI (não dá para gerar via API sem login web)
- `NAME` (opcional) — label da máquina

**Pré-checks**:
```bash
node --version       # ≥ v18
git --version        # qualquer versão recente
curl --version
which claude || true # opcional, depende do runner

# Confirma que `node` consegue saída pro orchestrator. Se browser conecta
# mas isto falhar, há firewall outbound interceptando node — veja seção
# "Firewall outbound" acima.
nc -vz <ORCH_HOST> 5173 2>&1 | grep -q succeeded && echo "tcp OK" || echo "tcp BLOCKED"
```

**Instalar**:
```bash
curl -fsSL "$ORCH_URL/install-daemon.sh" | sh -s -- "$ORCH_URL" "$TOKEN" "$NAME"
```

**Verificar download** (defensivo):
```bash
test -s "$HOME/.the-dudes/daemon.cjs" && \
test -s "$HOME/.the-dudes/mcp-bridge.cjs" && \
node "$HOME/.the-dudes/daemon.cjs" --help | head -1
```

**Rodar (foreground, para teste)** — usa nohup para não bloquear:
```bash
nohup node "$HOME/.the-dudes/daemon.cjs" \
  --orch "$ORCH_URL" --token "$TOKEN" --name "$NAME" \
  > /tmp/the-dudes-daemon.log 2>&1 &
sleep 2
grep -q 'authed as' /tmp/the-dudes-daemon.log && echo OK || tail /tmp/the-dudes-daemon.log
```

**Persistir** (escolha conforme OS — veja seções acima). Idempotente:
o agent pode escrever a unit/plist sem checar existência.

**Se houver firewall outbound** (corp EDR, Little Snitch, Lulu): rode
com `sudo --preserve-env=PATH,HOME`. O daemon detecta `SUDO_USER` e:
- Dropa uid/gid de todos os spawns de filhos para o usuário original.
- Abre um Unix socket em `/tmp/the-dudes-bridge-<pid>.sock` (chown pro
  user, mode 0660) por onde as MCP bridges dos agents falam com o
  orchestrator sem disparar a app de firewall.

Linhas que devem aparecer no log:
```
running as root via sudo — child processes will drop to uid=… home=…
bridge relay listening on /tmp/the-dudes-bridge-…sock
```

**Limpeza / desinstalar**:
```bash
launchctl unload ~/Library/LaunchAgents/com.the-dudes.daemon.plist 2>/dev/null
systemctl --user disable --now the-dudes-daemon 2>/dev/null
pm2 delete the-dudes-daemon 2>/dev/null
rm -rf "$HOME/.the-dudes"
```

> **Limitação atual:** não existe endpoint HTTP para mintar token sem
> login web (cookie session). Um agent não consegue gerar o próprio
> token; o usuário precisa colá-lo. Se isto virar bloqueador, abrir
> issue para adicionar `POST /api/auth/login + /api/daemon/tokens`
> via Basic auth ou personal-access-token.
