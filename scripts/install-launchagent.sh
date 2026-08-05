#!/usr/bin/env bash
#
# Instala o the-dudes daemon como LaunchAgent (macOS, user-level).
#
# - Idempotente: rodar 2× não duplica o agent (um Label, um plist).
# - --check: só reporta estado, zero mutação (seguro para QA / agentes).
# - Kill seguro: só PIDs cujo argv aponta para $HOME/.the-dudes/daemon.cjs
#   ou run-daemon.sh — nunca kill por nome genérico.
#
# ATENÇÃO: a instalação REAL (sem --check) para os daemons soltos e
# recarrega o LaunchAgent. Quem roda agentes via esse daemon perde a
# sessão. Execução final = dono, em momento escolhido por ele.
#
# Uso:
#   ./install-launchagent.sh --check          # dry-run / relatório
#   ./install-launchagent.sh --yes            # instala de verdade
#   ./install-launchagent.sh --yes --no-kill  # instala sem matar soltos
#
set -euo pipefail

LABEL="com.the-dudes.daemon"
HOME_DIR="${HOME:?HOME não definido}"
TD_DIR="${THE_DUDES_HOME:-$HOME_DIR/.the-dudes}"
ENV_FILE="${THE_DUDES_ENV_FILE:-$TD_DIR/daemon.env}"
LOG_FILE="${THE_DUDES_LOG_FILE:-$TD_DIR/daemon-prod.log}"
LAUNCHD_STDOUT="${THE_DUDES_LAUNCHD_STDOUT:-$TD_DIR/launchd.stdout.log}"
LAUNCHD_STDERR="${THE_DUDES_LAUNCHD_STDERR:-$TD_DIR/launchd.stderr.log}"
PLIST_DIR="$HOME_DIR/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${THE_DUDES_PLIST_TEMPLATE:-$SCRIPT_DIR/com.the-dudes.daemon.plist.template}"
RUN_DAEMON_SRC="${THE_DUDES_RUN_DAEMON_SRC:-$SCRIPT_DIR/run-daemon.sh}"
RUN_DAEMON_DST="$TD_DIR/run-daemon.sh"

CHECK_ONLY=0
ASSUME_YES=0
NO_KILL=0

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \?//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check|-n) CHECK_ONLY=1 ;;
    --yes|-y)   ASSUME_YES=1 ;;
    --no-kill)  NO_KILL=1 ;;
    -h|--help)  usage 0 ;;
    *) echo "arg desconhecido: $1" >&2; usage 2 ;;
  esac
  shift
done

log()  { printf '[install-launchagent] %s\n' "$*"; }
warn() { printf '[install-launchagent] WARN: %s\n' "$*" >&2; }
die()  { printf '[install-launchagent] ERRO: %s\n' "$*" >&2; exit 1; }

require_macos() {
  [ "$(uname -s)" = "Darwin" ] || die "só macOS (uname=$(uname -s))"
}

resolve_node() {
  if [ -n "${THE_DUDES_NODE:-}" ] && [ -x "$THE_DUDES_NODE" ]; then
    printf '%s\n' "$THE_DUDES_NODE"
    return
  fi
  local n
  n="$(command -v node 2>/dev/null || true)"
  if [ -n "$n" ] && [ -x "$n" ]; then
    printf '%s\n' "$n"
    return
  fi
  for c in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$c" ]; then
      printf '%s\n' "$c"
      return
    fi
  done
  die "node não encontrado no PATH nem em /opt/homebrew|/usr/local"
}

resolve_bash() {
  local b
  b="$(command -v bash 2>/dev/null || true)"
  if [ -n "$b" ] && [ -x "$b" ]; then
    printf '%s\n' "$b"
    return
  fi
  [ -x /bin/bash ] && { printf '%s\n' /bin/bash; return; }
  die "bash não encontrado"
}

default_path() {
  # PATH mínimo para launchd + dirs comuns de node.
  printf '%s\n' "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

# Lista PIDs de processos soltos do daemon de PRODUÇÃO do usuário
# (path canônico em $TD_DIR). Nunca usa pkill -f com padrão frouxo.
# Match por substring do path absoluto — NÃO casa .the-dudes-preview
# (lá o sufixo após .the-dudes é "-preview", não "/").
list_loose_pids() {
  local pid cmd
  local needle_daemon="$TD_DIR/daemon.cjs"
  local needle_run="$TD_DIR/run-daemon.sh"
  ps -axo pid=,command= 2>/dev/null | while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    pid="${line%% *}"
    cmd="${line#"$pid"}"
    cmd="${cmd#"${cmd%%[![:space:]]*}"}"
    case "$cmd" in
      *"$needle_daemon"*|*"$needle_run"*)
        printf '%s\n' "$pid"
        ;;
    esac
  done | sort -un
}

# Confirma que o PID ainda aponta para o path canônico antes de kill.
pid_still_ours() {
  local pid="$1"
  local cmd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [ -n "$cmd" ] || return 1
  case "$cmd" in
    *"$TD_DIR/daemon.cjs"*|*"$TD_DIR/run-daemon.sh"*) return 0 ;;
    *) return 1 ;;
  esac
}

safe_stop_loose() {
  local pids pid
  pids="$(list_loose_pids | tr '\n' ' ')"
  pids="${pids%% }"
  if [ -z "${pids// }" ]; then
    log "nenhum daemon solto em $TD_DIR"
    return 0
  fi
  log "daemons soltos (PIDs): $pids"
  if [ "$NO_KILL" -eq 1 ]; then
    warn "--no-kill: não vou matar; instância pode duplicar se o LaunchAgent subir em paralelo"
    return 0
  fi
  for pid in $pids; do
    if ! pid_still_ours "$pid"; then
      warn "PID $pid já não é nosso — pulando"
      continue
    fi
    log "SIGTERM PID $pid"
    kill -TERM "$pid" 2>/dev/null || true
  done
  # espera curta
  sleep 1
  for pid in $pids; do
    if pid_still_ours "$pid"; then
      log "SIGKILL PID $pid (não saiu com TERM)"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
}

agent_loaded() {
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

render_plist() {
  local node bash_bin path_val out
  node="$(resolve_node)"
  bash_bin="$(resolve_bash)"
  path_val="$(default_path)"
  out="${1:-}"
  [ -f "$TEMPLATE" ] || die "template ausente: $TEMPLATE"
  [ -n "$out" ] || die "render_plist: falta path de saída"

  # sed: escapa & \ para paths
  local sed_script
  sed_script=$(
    cat <<EOF
s|__LABEL__|${LABEL}|g
s|__BASH__|${bash_bin}|g
s|__RUN_DAEMON__|${RUN_DAEMON_DST}|g
s|__ENV_FILE__|${ENV_FILE}|g
s|__LOG_FILE__|${LOG_FILE}|g
s|__HOME__|${HOME_DIR}|g
s|__PATH__|${path_val}|g
s|__NODE__|${node}|g
s|__STDOUT__|${LAUNCHD_STDOUT}|g
s|__STDERR__|${LAUNCHD_STDERR}|g
EOF
  )
  sed -e "$sed_script" "$TEMPLATE" > "$out"
}

check_prereqs_report() {
  local node bash_bin pids loaded
  node="$(resolve_node 2>/dev/null || echo 'AUSENTE')"
  bash_bin="$(resolve_bash 2>/dev/null || echo 'AUSENTE')"
  pids="$(list_loose_pids | tr '\n' ' ')"
  loaded=0
  agent_loaded && loaded=1 || true

  log "=== --check (sem mutação) ==="
  log "os:              $(uname -s) $(uname -m)"
  log "label:           $LABEL"
  log "domain:          $DOMAIN"
  log "td_dir:          $TD_DIR"
  log "env_file:        $ENV_FILE  $([ -f "$ENV_FILE" ] && echo OK || echo AUSENTE)"
  if [ -f "$TD_DIR/daemon.cjs" ]; then log "daemon_bin:      $TD_DIR/daemon.cjs  OK"; else log "daemon_bin:      $TD_DIR/daemon.cjs  AUSENTE"; fi
  if [ -f "$RUN_DAEMON_SRC" ]; then log "run_daemon_src:  $RUN_DAEMON_SRC  OK"; else log "run_daemon_src:  $RUN_DAEMON_SRC  AUSENTE"; fi
  if [ -f "$RUN_DAEMON_DST" ]; then log "run_daemon_dst:  $RUN_DAEMON_DST  OK"; else log "run_daemon_dst:  $RUN_DAEMON_DST  AUSENTE"; fi
  if [ -f "$TEMPLATE" ]; then log "template:        $TEMPLATE  OK"; else log "template:        $TEMPLATE  AUSENTE"; fi
  if [ -f "$PLIST_PATH" ]; then log "plist_path:      $PLIST_PATH  presente"; else log "plist_path:      $PLIST_PATH  ausente"; fi
  log "node:            $node"
  log "bash:            $bash_bin"
  log "log_file:        $LOG_FILE"
  log "launchd_stdout:  $LAUNCHD_STDOUT"
  log "launchd_stderr:  $LAUNCHD_STDERR"
  log "agent_loaded:    $loaded"
  log "loose_pids:      ${pids:-"(nenhum)"}"
  log "no_kill:         $NO_KILL"

  if [ -f "$TEMPLATE" ]; then
    local tmp
    tmp="$(mktemp -t td-plist.XXXXXX)"
    render_plist "$tmp"
    if command -v plutil >/dev/null 2>&1; then
      if plutil -lint "$tmp" >/dev/null; then
        log "plist_lint:      OK"
      else
        warn "plist_lint: FALHOU"
        plutil -lint "$tmp" || true
      fi
    else
      warn "plutil ausente — skip lint"
    fi
    rm -f "$tmp"
  fi

  if [ ! -f "$ENV_FILE" ]; then
    warn "sem $ENV_FILE — install real falhará até o dono ter o env"
  fi
  if [ "$node" = "AUSENTE" ] || [ "$bash_bin" = "AUSENTE" ]; then
    return 1
  fi
  return 0
}

install_real() {
  require_macos
  [ -f "$ENV_FILE" ] || die "env ausente: $ENV_FILE (gere via install-daemon / UI mint)"
  [ -f "$TD_DIR/daemon.cjs" ] || die "binário ausente: $TD_DIR/daemon.cjs"
  [ -f "$TEMPLATE" ] || die "template ausente: $TEMPLATE"
  [ -f "$RUN_DAEMON_SRC" ] || die "run-daemon.sh ausente: $RUN_DAEMON_SRC"

  if [ "$ASSUME_YES" -ne 1 ]; then
    cat >&2 <<EOF
Isto vai:
  1) parar daemons soltos em $TD_DIR (PIDs detectados);
  2) instalar $PLIST_PATH;
  3) bootstrap/kickstart $DOMAIN/$LABEL.

Agentes conectados a esse daemon perdem a sessão. Passe --yes para confirmar.
EOF
    die "recusado (sem --yes)"
  fi

  mkdir -p "$TD_DIR" "$PLIST_DIR"

  # Copia launcher (idempotente)
  cp "$RUN_DAEMON_SRC" "$RUN_DAEMON_DST"
  chmod 755 "$RUN_DAEMON_DST"
  log "launcher → $RUN_DAEMON_DST"

  # Gera plist em tmp, lint, depois instala
  local tmp
  tmp="$(mktemp -t td-plist.XXXXXX)"
  render_plist "$tmp"
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$tmp" >/dev/null || die "plist inválido após render"
  fi

  # Para soltos ANTES do load (evita 2 instâncias)
  safe_stop_loose

  # bootout se já carregado (idempotente)
  if agent_loaded; then
    log "bootout $DOMAIN/$LABEL"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || \
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
  fi

  cp "$tmp" "$PLIST_PATH"
  chmod 644 "$PLIST_PATH"
  rm -f "$tmp"
  log "plist → $PLIST_PATH"

  # bootstrap + kickstart (API moderna); fallback load
  if launchctl bootstrap "$DOMAIN" "$PLIST_PATH" 2>/dev/null; then
    log "bootstrap OK"
  else
    # já carregado / path diferente — tenta enable + kickstart
    warn "bootstrap falhou ou já existia — tentando enable/kickstart"
    launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
  fi
  launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
  if launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null; then
    log "kickstart OK"
  else
    # macOS antigo
    launchctl load -w "$PLIST_PATH" 2>/dev/null || launchctl load "$PLIST_PATH"
    log "load (legacy) OK"
  fi

  sleep 1
  if agent_loaded; then
    log "agent ativo: $DOMAIN/$LABEL"
  else
    warn "agent não aparece em launchctl print — verifique $LAUNCHD_STDERR"
  fi
  log "log do daemon: $LOG_FILE"
  log "verificação: launchctl print $DOMAIN/$LABEL | head"
  log "verificação: tail -f $LOG_FILE"
}

# --- main ---
require_macos

if [ "$CHECK_ONLY" -eq 1 ]; then
  check_prereqs_report
  exit 0
fi

install_real
