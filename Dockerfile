# the-dudes daemon — containerizado.
#
# Objetivo de segurança: rodar o daemon + os agentes DENTRO de um container
# que só enxerga a pasta de workspace que você montar (-v ...:/workspace) e as
# credenciais que você montar. Mesmo que algo dê errado, fica confinado ao
# container + ao volume montado, não ao seu disco inteiro.
#
# O daemon em si é baixado do orchestrator no boot (com verificação SHA-256),
# então a imagem é genérica e sempre pega a versão atual — não precisa
# rebuildar a cada release do daemon.
FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl python3 ripgrep \
    && rm -rf /var/lib/apt/lists/*

# CLIs de agente — auto-detectadas pelo daemon no PATH. Versões pináveis via
# build-arg pra builds reprodutíveis (default = latest).
ARG CLAUDE_VERSION=latest
ARG OPENCODE_VERSION=latest
ARG GEMINI_VERSION=latest
ARG CODEX_VERSION=latest
RUN npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
      "@google/gemini-cli@${GEMINI_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force

# Roda como NÃO-root (uid 1000 'node') — claude-code recusa bypassPermissions
# como root. /workspace + /opt/the-dudes (download do daemon) pertencem ao node.
RUN mkdir -p /workspace /opt/the-dudes /home/node/.the-dudes /home/node/.config/claude /home/node/.local/share /home/node/.local/state /home/node/.cache && chown -R node:node /workspace /opt/the-dudes /home/node
ENV HOME=/home/node
ENV THE_DUDES_WORKSPACE_ROOT=/workspace
# Força o config-dir do claude (ignora o campo por-agente, que é path do host).
# Monte as creds: -v <dir-host-com-.credentials.json>:/home/node/.config/claude
ENV THE_DUDES_CLAUDE_CONFIG_DIR=/home/node/.config/claude
WORKDIR /workspace

COPY docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER node
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
