# Rodar o daemon em container (recomendado)

Rodar o daemon num container é a forma mais segura: ele e os agentes só
enxergam a **pasta de workspace que você montar** e as **credenciais que você
montar** — nada mais do seu disco. Mesmo que algo dê errado, fica confinado ao
container + ao volume.

O daemon é baixado do orchestrator no boot **com verificação SHA-256**, então a
imagem é genérica e sempre pega a versão atual.

> **Roda como não-root.** A imagem usa o usuário `node` (uid 1000),
> `HOME=/home/node` — nunca root. Isso limita o blast radius e é o que permite
> `bypassPermissions` (auto-approve) funcionar: o `claude-code` recusa rodar com
> bypass como root. Por isso os mounts de credencial vão pra `/home/node/...`
> (e não `/root/...`). No Docker Desktop (macOS) o `node` lê arquivos do host
> montados mesmo sendo `0600` de outro uid — o compartilhamento FUSE ignora uid.

## 1. Build

```sh
cd daemon
docker build -t the-dudes/daemon .
```

As CLIs de agente (`claude`, `opencode`, `gemini`, `codex`) já vêm instaladas.
Pra fixar versões (build reprodutível):

```sh
docker build -t the-dudes/daemon \
  --build-arg CLAUDE_VERSION=2.1.157 \
  --build-arg OPENCODE_VERSION=1.15.12 \
  --build-arg GEMINI_VERSION=0.44.1 \
  --build-arg CODEX_VERSION=0.135.0 .
```

## 2. Rodar

Monte **só** o diretório que você quer que os agentes acessem em `/workspace`:

```sh
docker run -d --name the-dudes-daemon \
  -e THE_DUDES_ORCH=https://the-dudes.com \
  -e THE_DUDES_DAEMON_TOKEN=<seu-token> \
  -e THE_DUDES_DAEMON_NAME="$(hostname)" \
  -v the-dudes-data:/home/node/.the-dudes \
  -v "$PWD":/workspace \
  -v "$HOME/.claude":/home/node/.config/claude \
  -v "$HOME/.codex":/home/node/.codex \
  -v "$HOME/.gemini":/home/node/.gemini \
  -v "$HOME/.local/share/opencode":/home/node/.local/share/opencode \
  the-dudes/daemon
```

> ⚠ **Ordem importa:** `the-dudes/daemon` (a imagem) é o ÚLTIMO argumento.
> Qualquer `-v`/`-e` DEPOIS da imagem vira argumento do container e é ignorado
> como mount/env. Tudo antes da imagem.

- `-v "$PWD":/workspace` → **único** diretório de código exposto (rw). Troque por
  qualquer pasta. O daemon é confinado a ele (`THE_DUDES_WORKSPACE_ROOT=/workspace`).
- Os `-v` de credencial montam a auth do host (assinatura/API key) — **rw**, tire
  os runners que não usar. Claude com `CLAUDE_CONFIG_DIR` custom: ajuste o destino
  (ver seção de Autenticação).
- `-v the-dudes-data:/home/node/.the-dudes` → **persiste a keypair do daemon** (volume
  nomeado). Sem isso, cada container gera uma pubkey nova e projetos **E2EE**
  param de entregar a chave ("project key not held" → spawn falha).
- Token: via `-e` ou montando o `daemon.env` do installer:
  `-v "$HOME/.the-dudes/daemon.env":/daemon.env:ro`.

### Projetos E2EE

Se o projeto é end-to-end encrypted, o daemon precisa da **chave do projeto**
(entregue cifrada pra pubkey do daemon). Pra funcionar no container:

1. Monte `-v the-dudes-data:/home/node/.the-dudes` (acima) — keypair estável entre
   restarts.
2. Esteja **logado na web como owner/admin do projeto** quando o daemon conectar
   — o web client embrulha a chave pra a pubkey do daemon e o server entrega.
   Com a keypair persistida, isso acontece uma vez e segue valendo.

Se faltar, o log mostra `systemPrompt is encrypted but project key not held`.

Logs: `docker logs -f the-dudes-daemon`. Parar/remover: `docker rm -f the-dudes-daemon`.

## 3. docker-compose

```yaml
services:
  daemon:
    build: ./daemon          # ou image: the-dudes/daemon
    environment:
      THE_DUDES_ORCH: https://the-dudes.com
      THE_DUDES_DAEMON_TOKEN: ${THE_DUDES_DAEMON_TOKEN}
      THE_DUDES_DAEMON_NAME: ${HOSTNAME:-the-dudes}
    volumes:
      - ./:/workspace
      - ${HOME}/.claude:/home/node/.config/claude
    restart: unless-stopped
```

`THE_DUDES_DAEMON_TOKEN=<token> docker compose up -d`

## Autenticação das CLIs (IMPORTANTE)

O container vem com `claude`/`opencode`/`gemini`/`codex` instalados, mas **sem
login** — a sua auth do host (Keychain no macOS) não existe lá. Se faltar, o
agente sobe e cai na hora (ex: `Not logged in · Please run /login`).

### A. API key via env (mais simples — funciona pros 4)

O daemon repassa as env pros agentes. Passe só as dos runners que usar:

```sh
docker run -d --name the-dudes-daemon \
  -e THE_DUDES_ORCH=https://the-dudes.com -e THE_DUDES_DAEMON_TOKEN=<token> \
  -e ANTHROPIC_API_KEY=sk-ant-...   `# claude` \
  -e OPENAI_API_KEY=sk-...          `# codex` \
  -e GEMINI_API_KEY=...             `# gemini` \
  -v "$PWD":/workspace -v td-home:/home/node \
  the-dudes/daemon
```

Verificado: cada CLI aceita sua key via env. `-v td-home:/home/node` persiste
qualquer login feito depois (volume nomeado).

### B. Login uma vez (assinatura, sem API key) — persistido em /home/node

Use o volume `td-home:/home/node` acima e logue cada runner que usar via `docker
exec`. Atenção aos diretórios:

```sh
# claude — o daemon usa CLAUDE_CONFIG_DIR=$HOME/.config/claude (NÃO ~/.claude).
# Logue no MESMO dir (e deixe o campo CLAUDE_CONFIG_DIR do agente VAZIO na UI):
docker exec -e CLAUDE_CONFIG_DIR=/home/node/.config/claude -it the-dudes-daemon claude setup-token

# opencode (necessário pra providers tipo zai/glm — não há env padrão):
docker exec -it the-dudes-daemon opencode auth login

# gemini (assinatura google):
docker exec -it the-dudes-daemon gemini

# codex (assinatura ChatGPT):
docker exec -it the-dudes-daemon codex login
```

As credenciais ficam no volume `td-home` e sobrevivem a restarts.

> Se o agente tiver um `CLAUDE_CONFIG_DIR` custom setado na UI (ex:
> `$HOME/.claude-eonf`), o claude do container procura em `/home/node/.claude-eonf`
> — logue nesse dir ou limpe o campo.

### C. Reusar a auth do host por mount (mais fácil pra assinatura)

No macOS/Linux a auth dessas CLIs costuma ser **arquivo** (não Keychain), então
basta montar o dir de config do host no caminho que cada CLI usa dentro do
container (HOME do container = `/home/node`):

```sh
docker run -d --name the-dudes-daemon \
  -e THE_DUDES_ORCH=https://the-dudes.com -e THE_DUDES_DAEMON_TOKEN=<token> \
  -v "$PWD":/workspace \
  -v "$HOME/.codex":/home/node/.codex                         `# codex (assinatura ChatGPT)` \
  -v "$HOME/.gemini":/home/node/.gemini                       `# gemini` \
  -v "$HOME/.local/share/opencode":/home/node/.local/share/opencode `# opencode` \
  -v "$HOME/.claude-eonf":/home/node/.claude-eonf             `# claude — ver nota` \
  the-dudes/daemon
```

- **codex**: o daemon não troca o dir do codex (`~/.codex`), então montar
  `~/.codex` já resolve — ele lê o `auth.json` da sua assinatura.
- **claude**: o daemon força `CLAUDE_CONFIG_DIR`. Monte o dir que bate com o
  campo `CLAUDE_CONFIG_DIR` do agente na UI (ex: `$HOME/.claude-eonf` →
  `/home/node/.claude-eonf`); se o campo estiver vazio, é `/home/node/.config/claude` e
  você monta `-v "$HOME/.claude":/home/node/.config/claude`.
- Monte read-write (sem `:ro`) — as CLIs renovam o token e regravam o arquivo.

## Hardening extra (opcional)

```sh
docker run -d --name the-dudes-daemon \
  --read-only --tmpfs /tmp --tmpfs /opt/the-dudes \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  --pids-limit 512 --memory 4g \
  -e THE_DUDES_ORCH=https://the-dudes.com -e THE_DUDES_DAEMON_TOKEN=<token> \
  -v "$PWD":/workspace -v "$HOME/.claude":/home/node/.config/claude \
  the-dudes/daemon
```

- `--read-only` + `--tmpfs`: FS imutável exceto `/workspace`, `/tmp`, `/opt/the-dudes`.
- `--cap-drop ALL` + `--no-new-privileges`: sem capabilities, sem escalação.
- Egress: o daemon só precisa falar com o orchestrator (HTTPS/WSS) + git/registries
  dos seus repos. Pra travar a rede a um destino específico, use uma rede Docker
  custom com regras de saída (ou rode atrás de um proxy egress).

## O que o container PODE e NÃO PODE tocar

- **Pode**: a pasta montada em `/workspace`, as credenciais montadas, a rede de
  saída (orchestrator + APIs/git).
- **Não pode**: o resto do seu disco, outros processos do host, outros usuários.

O daemon ainda aplica suas próprias defesas dentro do container: workspace-root
scoping, SSRF guard, sanitização do skill installer, drop de privilégio, e
aprovação manual de comandos por padrão.
