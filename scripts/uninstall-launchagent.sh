#!/usr/bin/env bash
#
# Remove um LaunchAgent the-dudes (macOS) por perfil (T-029).
#
# Sem --profile → default (com.the-dudes.daemon).
# Com --profile X → só com.the-dudes.daemon.X.
# NÃO apaga o home do perfil (~/.the-dudes[-X]) — token/bin/logs preservados.
#
# Uso:
#   ./uninstall-launchagent.sh --check
#   ./uninstall-launchagent.sh --check --profile work
#   ./uninstall-launchagent.sh --yes --profile work
#
set -euo pipefail

HOME_DIR="${HOME:?HOME não definido}"
PROFILE=""
CHECK_ONLY=0
ASSUME_YES=0
PLIST_DIR="${THE_DUDES_LAUNCH_AGENTS_DIR:-$HOME_DIR/Library/LaunchAgents}"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"

while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      [ $# -ge 2 ] || { echo "faltou valor de --profile" >&2; exit 2; }
      PROFILE="$2"
      shift 2
      ;;
    --check|-n) CHECK_ONLY=1; shift ;;
    --yes|-y)   ASSUME_YES=1; shift ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "arg desconhecido: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '[uninstall-launchagent] %s\n' "$*"; }
die()  { printf '[uninstall-launchagent] ERRO: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "só macOS"

if [ -z "$PROFILE" ] || [ "$PROFILE" = "default" ]; then
  LABEL="com.the-dudes.daemon"
  PROFILE_DISP="default"
  TD_DIR="${THE_DUDES_HOME:-$HOME_DIR/.the-dudes}"
else
  if ! printf '%s' "$PROFILE" | grep -Eq '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$'; then
    die "perfil inválido '$PROFILE'"
  fi
  LABEL="com.the-dudes.daemon.$PROFILE"
  PROFILE_DISP="$PROFILE"
  TD_DIR="${THE_DUDES_HOME:-$HOME_DIR/.the-dudes-$PROFILE}"
fi
PLIST_PATH="$PLIST_DIR/$LABEL.plist"

agent_loaded() {
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

if [ "$CHECK_ONLY" -eq 1 ]; then
  log "=== --check profile=$PROFILE_DISP ==="
  log "label:        $LABEL"
  log "td_dir:       $TD_DIR  (NÃO será apagado)"
  log "plist:        $PLIST_PATH  $([ -f "$PLIST_PATH" ] && echo presente || echo ausente)"
  if agent_loaded; then log "agent_loaded: 1"; else log "agent_loaded: 0"; fi
  exit 0
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  die "passe --yes para desinstalar perfil=$PROFILE_DISP (ou --check)"
fi

if agent_loaded; then
  log "bootout $DOMAIN/$LABEL"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || \
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
else
  log "agent não estava carregado"
fi

if [ -f "$PLIST_PATH" ]; then
  rm -f "$PLIST_PATH"
  log "removido $PLIST_PATH"
else
  log "plist já ausente"
fi

if agent_loaded; then
  die "agent ainda carregado"
fi
log "OK — perfil $PROFILE_DISP removido do launchd. Home $TD_DIR preservado."
