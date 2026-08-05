#!/usr/bin/env bash
#
# Instala o the-dudes daemon como LaunchAgent (macOS), com suporte a PERFIS
# multi-conta (T-029).
#
# Sem --profile  → perfil default: ~/.the-dudes + com.the-dudes.daemon (T-026).
# Com --profile X → ~/.the-dudes-X + com.the-dudes.daemon.X
#
# Cada perfil tem binário, env, chave E2EE, project-keys e log próprios —
# self-update não faz race (escreve em dirname(selfPath) por instância).
#
# - --check: zero mutação (seguro para agentes / QA).
# - --yes: instala de verdade (mata soltos do PERFIL, bootstrap).
# - --no-load: com --yes, só materializa arquivos/plist (sem kill/launchctl)
#   — útil para dry-run controlado sob HOME temporário.
# - --list: lista plists the-dudes instalados.
#
# Execução final nos daemons vivos = DONO (1 comando por perfil).
#
set -euo pipefail

HOME_DIR="${HOME:?HOME não definido}"
PROFILE=""
CHECK_ONLY=0
ASSUME_YES=0
NO_KILL=0
NO_LOAD=0
LIST_ONLY=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${THE_DUDES_PLIST_TEMPLATE:-$SCRIPT_DIR/com.the-dudes.daemon.plist.template}"
RUN_DAEMON_SRC="${THE_DUDES_RUN_DAEMON_SRC:-$SCRIPT_DIR/run-daemon.sh}"
PLIST_DIR="${THE_DUDES_LAUNCH_AGENTS_DIR:-$HOME_DIR/Library/LaunchAgents}"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"

usage() {
  cat <<'EOF'
Uso: install-launchagent.sh [opções]

  --profile <nome>   Perfil isolado (a-zA-Z0-9_-). Sem flag = default (~/.the-dudes).
  --check | -n       Só reporta (zero mutação). plutil no plist renderizado.
  --list             Lista LaunchAgents com.the-dudes.daemon* instalados.
  --yes | -y         Confirma instalação real.
  --no-kill          Não mata daemons soltos do perfil.
  --no-load          Com --yes: grava arquivos/plist sem launchctl/kill.
  -h | --help

Exemplos:
  ./install-launchagent.sh --check
  ./install-launchagent.sh --check --profile work
  ./install-launchagent.sh --yes --profile work   # DONO
  ./install-launchagent.sh --list
EOF
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      [ $# -ge 2 ] || { echo "faltou valor de --profile" >&2; usage 2; }
      PROFILE="$2"
      shift 2
      ;;
    --check|-n) CHECK_ONLY=1; shift ;;
    --list)     LIST_ONLY=1; shift ;;
    --yes|-y)   ASSUME_YES=1; shift ;;
    --no-kill)  NO_KILL=1; shift ;;
    --no-load)  NO_LOAD=1; shift ;;
    -h|--help)  usage 0 ;;
    *) echo "arg desconhecido: $1" >&2; usage 2 ;;
  esac
done

log()  { printf '[install-launchagent] %s\n' "$*"; }
warn() { printf '[install-launchagent] WARN: %s\n' "$*" >&2; }
die()  { printf '[install-launchagent] ERRO: %s\n' "$*" >&2; exit 1; }

require_macos() {
  [ "$(uname -s)" = "Darwin" ] || die "só macOS (uname=$(uname -s))"
}

# Resolve LABEL e TD_DIR a partir do perfil.
resolve_profile() {
  if [ -z "$PROFILE" ]; then
    LABEL="com.the-dudes.daemon"
    TD_DIR="${THE_DUDES_HOME:-$HOME_DIR/.the-dudes}"
    PROFILE_DISP="default"
    return
  fi
  case "$PROFILE" in
    default|"")
      LABEL="com.the-dudes.daemon"
      TD_DIR="${THE_DUDES_HOME:-$HOME_DIR/.the-dudes}"
      PROFILE_DISP="default"
      PROFILE=""
      return
      ;;
  esac
  if ! printf '%s' "$PROFILE" | grep -Eq '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$'; then
    die "perfil inválido '$PROFILE' (use [a-zA-Z0-9][a-zA-Z0-9_-]{0,31})"
  fi
  # "preview" e nomes com prefixo já usados como ~/.the-dudes-preview
  LABEL="com.the-dudes.daemon.$PROFILE"
  TD_DIR="${THE_DUDES_HOME:-$HOME_DIR/.the-dudes-$PROFILE}"
  PROFILE_DISP="$PROFILE"
}

apply_paths() {
  ENV_FILE="${THE_DUDES_ENV_FILE:-$TD_DIR/daemon.env}"
  LOG_FILE="${THE_DUDES_LOG_FILE:-$TD_DIR/daemon-prod.log}"
  LAUNCHD_STDOUT="${THE_DUDES_LAUNCHD_STDOUT:-$TD_DIR/launchd.stdout.log}"
  LAUNCHD_STDERR="${THE_DUDES_LAUNCHD_STDERR:-$TD_DIR/launchd.stderr.log}"
  PLIST_PATH="$PLIST_DIR/$LABEL.plist"
  RUN_DAEMON_DST="$TD_DIR/run-daemon.sh"
  DAEMON_BIN="$TD_DIR/daemon.cjs"
  MCP_BIN="$TD_DIR/mcp-bridge.cjs"
  DAEMON_KEY="$TD_DIR/daemon-key.pem"
  PROJECT_KEYS="$TD_DIR/project-keys.json"
  DAEMON_CONFIG="$TD_DIR/daemon-config.json"
}

resolve_node() {
  if [ -n "${THE_DUDES_NODE:-}" ] && [ -x "$THE_DUDES_NODE" ]; then
    printf '%s\n' "$THE_DUDES_NODE"; return
  fi
  local n
  n="$(command -v node 2>/dev/null || true)"
  if [ -n "$n" ] && [ -x "$n" ]; then printf '%s\n' "$n"; return; fi
  for c in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && { printf '%s\n' "$c"; return; }
  done
  die "node não encontrado"
}

resolve_bash() {
  local b
  b="$(command -v bash 2>/dev/null || true)"
  if [ -n "$b" ] && [ -x "$b" ]; then printf '%s\n' "$b"; return; fi
  [ -x /bin/bash ] && { printf '%s\n' /bin/bash; return; }
  die "bash não encontrado"
}

default_path() {
  printf '%s\n' "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

# PIDs soltos deste perfil (path canônico do TD_DIR). Nunca pkill genérico.
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
      *"$needle_daemon"*|*"$needle_run"*) printf '%s\n' "$pid" ;;
    esac
  done | sort -un
}

pid_still_ours() {
  local pid="$1" cmd
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
  log "daemons soltos do perfil (PIDs): $pids"
  if [ "$NO_KILL" -eq 1 ]; then
    warn "--no-kill: não mato"
    return 0
  fi
  for pid in $pids; do
    pid_still_ours "$pid" || { warn "PID $pid já não é nosso"; continue; }
    log "SIGTERM PID $pid"
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in $pids; do
    if pid_still_ours "$pid"; then
      log "SIGKILL PID $pid"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
}

agent_loaded() {
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

render_plist() {
  local node bash_bin path_val out="$1"
  node="$(resolve_node)"
  bash_bin="$(resolve_bash)"
  path_val="$(default_path)"
  [ -f "$TEMPLATE" ] || die "template ausente: $TEMPLATE"
  sed \
    -e "s|__LABEL__|${LABEL}|g" \
    -e "s|__BASH__|${bash_bin}|g" \
    -e "s|__RUN_DAEMON__|${RUN_DAEMON_DST}|g" \
    -e "s|__ENV_FILE__|${ENV_FILE}|g" \
    -e "s|__LOG_FILE__|${LOG_FILE}|g" \
    -e "s|__TD_DIR__|${TD_DIR}|g" \
    -e "s|__HOME__|${HOME_DIR}|g" \
    -e "s|__PATH__|${path_val}|g" \
    -e "s|__NODE__|${node}|g" \
    -e "s|__DAEMON_BIN__|${DAEMON_BIN}|g" \
    -e "s|__DAEMON_KEY__|${DAEMON_KEY}|g" \
    -e "s|__PROJECT_KEYS__|${PROJECT_KEYS}|g" \
    -e "s|__DAEMON_CONFIG__|${DAEMON_CONFIG}|g" \
    -e "s|__STDOUT__|${LAUNCHD_STDOUT}|g" \
    -e "s|__STDERR__|${LAUNCHD_STDERR}|g" \
    "$TEMPLATE" > "$out"
}

seed_binaries() {
  # Copia binários para o home do perfil se ausentes — isolamento de self-update.
  local seed_dir=""
  if [ -f "$HOME_DIR/.the-dudes/daemon.cjs" ] && [ "$TD_DIR" != "$HOME_DIR/.the-dudes" ]; then
    seed_dir="$HOME_DIR/.the-dudes"
  elif [ -f "$SCRIPT_DIR/../release/daemon.cjs" ]; then
    seed_dir="$(cd "$SCRIPT_DIR/../release" && pwd)"
  elif [ -f "$SCRIPT_DIR/../dist/daemon.cjs" ]; then
    seed_dir="$(cd "$SCRIPT_DIR/../dist" && pwd)"
  fi

  if [ ! -f "$DAEMON_BIN" ]; then
    if [ -n "$seed_dir" ] && [ -f "$seed_dir/daemon.cjs" ]; then
      cp "$seed_dir/daemon.cjs" "$DAEMON_BIN"
      chmod 755 "$DAEMON_BIN"
      log "seed daemon.cjs ← $seed_dir"
      if [ -f "$seed_dir/mcp-bridge.cjs" ]; then
        cp "$seed_dir/mcp-bridge.cjs" "$MCP_BIN"
        chmod 755 "$MCP_BIN"
      fi
      for ext in sha256 sig; do
        [ -f "$seed_dir/daemon.cjs.$ext" ] && cp "$seed_dir/daemon.cjs.$ext" "$TD_DIR/" || true
        [ -f "$seed_dir/mcp-bridge.cjs.$ext" ] && cp "$seed_dir/mcp-bridge.cjs.$ext" "$TD_DIR/" || true
      done
    else
      warn "sem daemon.cjs em $TD_DIR — rode install-daemon apontando DEST=$TD_DIR antes do load"
    fi
  fi
}

list_agents() {
  log "=== LaunchAgents the-dudes ==="
  local f base
  shopt -s nullglob 2>/dev/null || true
  for f in "$PLIST_DIR"/com.the-dudes.daemon*.plist; do
    [ -f "$f" ] || continue
    base="$(basename "$f" .plist)"
    local loaded=0
    launchctl print "$DOMAIN/$base" >/dev/null 2>&1 && loaded=1 || true
    # extrai WorkingDirectory se possível
    local wd="?"
    if command -v plutil >/dev/null 2>&1; then
      wd="$(plutil -extract WorkingDirectory raw "$f" 2>/dev/null || echo "?")"
    fi
    log "  $base  loaded=$loaded  wd=$wd  plist=$f"
  done
  # também reporta homes conhecidos
  log "homes candidatos:"
  log "  $HOME_DIR/.the-dudes  $([ -d "$HOME_DIR/.the-dudes" ] && echo OK || echo ausente)"
  local d
  for d in "$HOME_DIR"/.the-dudes-*; do
    [ -d "$d" ] || continue
    log "  $d  OK"
  done
}

check_report() {
  local node bash_bin pids loaded=0
  node="$(resolve_node 2>/dev/null || echo AUSENTE)"
  bash_bin="$(resolve_bash 2>/dev/null || echo AUSENTE)"
  pids="$(list_loose_pids | tr '\n' ' ')"
  agent_loaded && loaded=1 || true

  log "=== --check (sem mutação) profile=$PROFILE_DISP ==="
  log "label:           $LABEL"
  log "domain:          $DOMAIN"
  log "td_dir:          $TD_DIR"
  log "env_file:        $ENV_FILE  $([ -f "$ENV_FILE" ] && echo OK || echo AUSENTE)"
  if [ -f "$DAEMON_BIN" ]; then log "daemon_bin:      $DAEMON_BIN  OK"; else log "daemon_bin:      $DAEMON_BIN  AUSENTE"; fi
  if [ -f "$RUN_DAEMON_SRC" ]; then log "run_daemon_src:  $RUN_DAEMON_SRC  OK"; else log "run_daemon_src:  AUSENTE"; fi
  if [ -f "$TEMPLATE" ]; then log "template:        OK"; else log "template:        AUSENTE"; fi
  if [ -f "$PLIST_PATH" ]; then log "plist_path:      $PLIST_PATH  presente"; else log "plist_path:      $PLIST_PATH  ausente"; fi
  log "daemon_key:      $DAEMON_KEY  $([ -f "$DAEMON_KEY" ] && echo presente || echo ausente)"
  log "project_keys:    $PROJECT_KEYS  $([ -f "$PROJECT_KEYS" ] && echo presente || echo ausente)"
  log "node:            $node"
  log "bash:            $bash_bin"
  log "log_file:        $LOG_FILE"
  log "agent_loaded:    $loaded"
  log "loose_pids:      ${pids:-"(nenhum)"}"
  log "self_update:     isolado em dirname($DAEMON_BIN) — sem race com outros perfis"

  if [ -f "$TEMPLATE" ] && [ "$node" != "AUSENTE" ] && [ "$bash_bin" != "AUSENTE" ]; then
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
    fi
    # prova de isolamento no XML renderizado
    if grep -q "$TD_DIR" "$tmp" && grep -q "$LABEL" "$tmp"; then
      log "render_paths:    OK (label+td_dir no plist)"
    else
      warn "render_paths: label/td_dir não encontrados no plist"
    fi
    rm -f "$tmp"
  fi
  [ "$node" != "AUSENTE" ] && [ "$bash_bin" != "AUSENTE" ]
}

install_real() {
  require_macos
  [ -f "$TEMPLATE" ] || die "template ausente: $TEMPLATE"
  [ -f "$RUN_DAEMON_SRC" ] || die "run-daemon.sh ausente: $RUN_DAEMON_SRC"

  if [ "$ASSUME_YES" -ne 1 ]; then
    cat >&2 <<EOF
Isto vai (perfil=$PROFILE_DISP):
  1) materializar $TD_DIR (binário/env se faltarem);
  2) $([ "$NO_LOAD" -eq 1 ] && echo "NÃO matar / NÃO load (--no-load)" || echo "parar soltos só em $TD_DIR");
  3) instalar $PLIST_PATH;
  4) $([ "$NO_LOAD" -eq 1 ] && echo "pular bootstrap" || echo "bootstrap/kickstart $DOMAIN/$LABEL").

Agentes deste perfil perdem a sessão se houver kill/load. Passe --yes.
EOF
    die "recusado (sem --yes)"
  fi

  mkdir -p "$TD_DIR" "$PLIST_DIR"
  cp "$RUN_DAEMON_SRC" "$RUN_DAEMON_DST"
  chmod 755 "$RUN_DAEMON_DST"
  log "launcher → $RUN_DAEMON_DST"

  seed_binaries

  if [ ! -f "$ENV_FILE" ]; then
    warn "env ausente: $ENV_FILE — crie com THE_DUDES_ORCH / THE_DUDES_DAEMON_TOKEN / THE_DUDES_DAEMON_NAME antes de usar"
  fi

  local tmp
  tmp="$(mktemp -t td-plist.XXXXXX)"
  render_plist "$tmp"
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$tmp" >/dev/null || die "plist inválido"
  fi

  if [ "$NO_LOAD" -eq 0 ]; then
    safe_stop_loose
    if agent_loaded; then
      log "bootout $DOMAIN/$LABEL"
      launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || \
        launchctl unload "$PLIST_PATH" 2>/dev/null || true
    fi
  else
    log "--no-load: skip kill/bootout"
  fi

  cp "$tmp" "$PLIST_PATH"
  chmod 644 "$PLIST_PATH"
  rm -f "$tmp"
  log "plist → $PLIST_PATH"

  if [ "$NO_LOAD" -eq 1 ]; then
    log "OK materializado (sem load). Perfil=$PROFILE_DISP td=$TD_DIR"
    return 0
  fi

  if launchctl bootstrap "$DOMAIN" "$PLIST_PATH" 2>/dev/null; then
    log "bootstrap OK"
  else
    warn "bootstrap falhou ou já existia — enable/kickstart"
    launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
  fi
  launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
  if launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null; then
    log "kickstart OK"
  else
    launchctl load -w "$PLIST_PATH" 2>/dev/null || launchctl load "$PLIST_PATH" || true
    log "load (legacy) tentado"
  fi
  sleep 1
  if agent_loaded; then log "agent ativo: $DOMAIN/$LABEL"; else warn "agent não aparece em print"; fi
  log "log: $LOG_FILE"
}

# --- main ---
require_macos

if [ "$LIST_ONLY" -eq 1 ]; then
  list_agents
  exit 0
fi

resolve_profile
apply_paths

if [ "$CHECK_ONLY" -eq 1 ]; then
  check_report
  exit 0
fi

install_real
