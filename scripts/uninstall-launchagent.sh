#!/usr/bin/env bash
#
# Remove o LaunchAgent the-dudes (macOS).
#
# - --check: só reporta, zero mutação.
# - --yes: bootout + remove o plist.
# - NÃO apaga ~/.the-dudes (binário, env, logs) — só o agent.
#
# Uso:
#   ./uninstall-launchagent.sh --check
#   ./uninstall-launchagent.sh --yes
#
set -euo pipefail

LABEL="com.the-dudes.daemon"
HOME_DIR="${HOME:?HOME não definido}"
PLIST_PATH="$HOME_DIR/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"

CHECK_ONLY=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --check|-n) CHECK_ONLY=1 ;;
    --yes|-y)   ASSUME_YES=1 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "arg desconhecido: $1" >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '[uninstall-launchagent] %s\n' "$*"; }
die()  { printf '[uninstall-launchagent] ERRO: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "só macOS"

agent_loaded() {
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

if [ "$CHECK_ONLY" -eq 1 ]; then
  log "=== --check (sem mutação) ==="
  log "label:        $LABEL"
  log "domain:       $DOMAIN"
  log "plist:        $PLIST_PATH  $([ -f "$PLIST_PATH" ] && echo presente || echo ausente)"
  if agent_loaded; then
    log "agent_loaded: 1"
  else
    log "agent_loaded: 0"
  fi
  exit 0
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  die "passe --yes para desinstalar (ou --check para só reportar)"
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
  die "agent ainda carregado após uninstall"
fi
log "OK — LaunchAgent removido. Binário/env/logs em ~/.the-dudes preservados."
