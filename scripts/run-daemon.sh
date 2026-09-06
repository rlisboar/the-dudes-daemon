#!/usr/bin/env bash
#
# Launcher supervisionado do daemon — rotação de log + relançamento pós-update.
#
# Por que existe:
#  - O daemon era lançado com `nohup node daemon.cjs >> daemon-prod.log` — o
#    log crescia pra sempre (e reteve um token vazado por horas), e não havia
#    NINGUÉM pra relançar o processo: o self-update assinado (self-update.ts)
#    precisa sair e ser reiniciado com o binário novo.
#  - Exit code 42 = "atualizei o binário, relance-me". Qualquer outro exit
#    encerra o launcher (crash-loop infinito mascara problema real).
#
# Uso:
#   <profile-home>/run-daemon.sh <env-file> [log-file]
# Ex. default (T-026):
#   nohup ~/.the-dudes/run-daemon.sh ~/.the-dudes/daemon.env ~/.the-dudes/daemon-prod.log &
# Ex. perfil "work" (T-029):
#   ~/.the-dudes-work/run-daemon.sh ~/.the-dudes-work/daemon.env ~/.the-dudes-work/daemon-prod.log
#
# Multi-conta: cada perfil tem o PRÓPRIO daemon.cjs (THE_DUDES_DAEMON_BIN).
# Self-update escreve em dirname(selfPath) — sem race entre perfis.
# Preferido no macOS: install-launchagent.sh [--profile X].
set -euo pipefail

ENV_FILE="${1:?uso: run-daemon.sh <env-file> [log-file]}"
LOG_FILE="${2:-$HOME/.the-dudes/daemon.log}"
# Default = home canônico; LaunchAgent multi-perfil sobrescreve via env/plist.
DAEMON_BIN="${THE_DUDES_DAEMON_BIN:-$HOME/.the-dudes/daemon.cjs}"
# Path absoluto de node sob launchd (PATH esparso). install-launchagent.sh define.
NODE_BIN="${THE_DUDES_NODE:-node}"
MAX_LOG_BYTES=$((20 * 1024 * 1024))   # 20MB por geração
KEEP_GENERATIONS=2

# T-031: sob launchd o PATH é mínimo e não carrega .zshrc. Prepende dirs
# padrão de runners de usuário (espelha userRunnerBinDirs no daemon).
# Não usa `zsh -lc` — evita depender de dotfiles e de side-effects de login.
ensure_runner_path() {
  local home="${HOME:-}"
  local prepend=(
    "${home}/.grok/bin"
    "${home}/.local/bin"
    "${home}/bin"
    "/opt/homebrew/bin"
    "/usr/local/bin"
  )
  local d new=""
  for d in "${prepend[@]}"; do
    [ -n "$d" ] || continue
    case ":${PATH:-}:" in
      *":$d:"*) ;; # já no PATH
      *) new="${new:+$new:}$d" ;;
    esac
  done
  if [ -n "$new" ]; then
    export PATH="$new${PATH:+:$PATH}"
  fi
}
ensure_runner_path

rotate_log() {
  # Rotaciona no start e sempre que a geração atual passa do teto.
  local size
  size=$(stat -f %z "$LOG_FILE" 2>/dev/null || stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "${size:-0}" -ge "$MAX_LOG_BYTES" ]; then
    local g=$KEEP_GENERATIONS
    while [ "$g" -gt 1 ]; do
      local prev=$((g - 1))
      [ -f "$LOG_FILE.$prev" ] && mv -f "$LOG_FILE.$prev" "$LOG_FILE.$g"
      g=$prev
    done
    mv -f "$LOG_FILE" "$LOG_FILE.1"
  fi
}

while true; do
  rotate_log
  # T-261 (F-8): o log do launcher leva token/emails/paths — nasce 0644 pelo
  # umask e fica legível a qualquer usuário. Após o rotate (ou no primeiro
  # start) o `>>` recria o arquivo com o umask, então o aperto é reafirmado a
  # cada loop. `>>` do node usa fd próprio; chmod não quebra append.
  touch "$LOG_FILE" 2>/dev/null || true
  chmod go-rwx "$LOG_FILE" 2>/dev/null || true
  # Blindagem do env: daemon.env guarda THE_DUDES_DAEMON_TOKEN. Se ficar
  # legível por grupo/outros, o token vaza; se ficar gravável, vira execução
  # arbitrária sob launchd (source de conteúdo controlado). Força 0600 antes.
  if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
    chmod go-rwx "$ENV_FILE" 2>/dev/null || true
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  export THE_DUDES_LAUNCHER=1
  set +e
  # Nota T-031: se launchd.stderr mostrar
  #   run-daemon.sh: line N: PID Killed: 9  "$NODE_BIN" ...
  # isso NÃO é este script matando a si mesmo. É o bash reportando que o
  # filho node recebeu SIGKILL (exit 137 = 128+9) de fora — em geral
  # install-launchagent.sh safe_stop (reinstall do mesmo perfil) ou kill
  # manual. O launcher nunca envia kill.
  "$NODE_BIN" "$DAEMON_BIN" >> "$LOG_FILE" 2>&1
  code=$?
  set -e
  if [ "$code" -eq 42 ]; then
    echo "[$(date -u +%FT%TZ)] [launcher] daemon pediu relançamento pós-update (exit 42)" >> "$LOG_FILE"
    continue
  fi
  # Sob launchd (KeepAlive), o agent relança este script. Fora do launchd,
  # exit evita crash-loop silencioso (nohup puro).
  # code 137 = SIGKILL externo (ver nota acima).
  echo "[$(date -u +%FT%TZ)] [launcher] daemon saiu com código $code — encerrando launcher" >> "$LOG_FILE"
  exit "$code"
done
