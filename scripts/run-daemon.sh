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
#   ~/.the-dudes/run-daemon.sh <env-file> [log-file]
# Ex.:
#   nohup ~/.the-dudes/run-daemon.sh ~/.the-dudes/daemon.env ~/.the-dudes/daemon-prod.log &
set -euo pipefail

ENV_FILE="${1:?uso: run-daemon.sh <env-file> [log-file]}"
LOG_FILE="${2:-$HOME/.the-dudes/daemon.log}"
DAEMON_BIN="${THE_DUDES_DAEMON_BIN:-$HOME/.the-dudes/daemon.cjs}"
MAX_LOG_BYTES=$((20 * 1024 * 1024))   # 20MB por geração
KEEP_GENERATIONS=2

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
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  export THE_DUDES_LAUNCHER=1
  set +e
  node "$DAEMON_BIN" >> "$LOG_FILE" 2>&1
  code=$?
  set -e
  if [ "$code" -eq 42 ]; then
    echo "[$(date -u +%FT%TZ)] [launcher] daemon pediu relançamento pós-update (exit 42)" >> "$LOG_FILE"
    continue
  fi
  echo "[$(date -u +%FT%TZ)] [launcher] daemon saiu com código $code — encerrando launcher" >> "$LOG_FILE"
  exit "$code"
done
