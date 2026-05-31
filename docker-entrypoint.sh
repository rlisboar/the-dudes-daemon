#!/bin/sh
# Entrypoint do daemon containerizado. Baixa+verifica (SHA-256) o daemon do
# orchestrator e roda, confinado a /workspace via THE_DUDES_WORKSPACE_ROOT.
set -eu

# Credenciais: via -e (env) OU montando um daemon.env em /daemon.env (ro).
if [ -f /daemon.env ]; then
  set -a
  . /daemon.env
  set +a
fi

if [ -z "${THE_DUDES_ORCH:-}" ] || [ -z "${THE_DUDES_DAEMON_TOKEN:-}" ]; then
  echo "error: defina THE_DUDES_ORCH e THE_DUDES_DAEMON_TOKEN (-e ... ou monte /daemon.env)" >&2
  exit 1
fi

DEST=/opt/the-dudes
mkdir -p "$DEST"

# Baixa + confere SHA-256 (anti-tampering). Mismatch aborta.
dl_verify() {
  _url="$1"; _out="$2"
  curl -fsSL "$_url" -o "$_out"
  _want=$(curl -fsSL "$_url.sha256" 2>/dev/null | awk '{print $1}')
  if [ -n "$_want" ]; then
    _have=$(sha256sum "$_out" | awk '{print $1}')
    if [ "$_have" != "$_want" ]; then
      echo "error: checksum mismatch em $_out (esperado $_want, obtido $_have)" >&2
      exit 1
    fi
    echo "  ✓ checksum ok: $_out"
  else
    echo "  ! checksum indisponível — prosseguindo sem verificar $_out" >&2
  fi
}

echo "→ baixando daemon de $THE_DUDES_ORCH …"
dl_verify "$THE_DUDES_ORCH/install/daemon.cjs"     "$DEST/daemon.cjs"
dl_verify "$THE_DUDES_ORCH/install/mcp-bridge.cjs" "$DEST/mcp-bridge.cjs"

export THE_DUDES_WORKSPACE_ROOT="${THE_DUDES_WORKSPACE_ROOT:-/workspace}"
echo "→ workspace root: $THE_DUDES_WORKSPACE_ROOT"
exec node "$DEST/daemon.cjs"
