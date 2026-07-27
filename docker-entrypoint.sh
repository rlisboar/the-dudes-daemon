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

# Chave pública Ed25519 que assina os bundles (privada offline no host de build).
# Canônica: https://github.com/rlisboar/the-dudes-daemon/blob/main/signing-pub.pem
SIGN_PUB='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAhnydRabRqG76LrgUBsx+1Wk5HcojzeYcr3CB/EkglaI=
-----END PUBLIC KEY-----'
export SIGN_PUB

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

# Verifica assinatura Ed25519 — FAIL-CLOSED: assinatura ausente/inválida aborta.
verify_sig() {
  _out="$1"
  _sig=$(curl -fsSL "$THE_DUDES_ORCH/install/$(basename "$_out").sig" 2>/dev/null || true)
  if [ -z "$_sig" ]; then
    echo "error: assinatura ausente em $_out — abortando (tampering ou build não-assinado)" >&2
    rm -f "$_out"; exit 1
  fi
  printf '%s' "$_sig" > "$_out.sig"
  if node -e 'const{verify}=require("crypto"),fs=require("fs");process.exit(verify(null,fs.readFileSync(process.argv[1]),process.env.SIGN_PUB,Buffer.from(fs.readFileSync(process.argv[2],"utf8").trim(),"base64"))?0:1)' "$_out" "$_out.sig"; then
    echo "  ✓ assinatura Ed25519 ok: $_out"; rm -f "$_out.sig"
  else
    echo "error: ASSINATURA INVÁLIDA em $_out — abortando (tampering)" >&2
    rm -f "$_out" "$_out.sig"; exit 1
  fi
}

echo "→ baixando daemon de $THE_DUDES_ORCH …"
dl_verify "$THE_DUDES_ORCH/install/daemon.cjs"     "$DEST/daemon.cjs"
dl_verify "$THE_DUDES_ORCH/install/mcp-bridge.cjs" "$DEST/mcp-bridge.cjs"
verify_sig "$DEST/daemon.cjs"
verify_sig "$DEST/mcp-bridge.cjs"

export THE_DUDES_WORKSPACE_ROOT="${THE_DUDES_WORKSPACE_ROOT:-/workspace}"
echo "→ workspace root: $THE_DUDES_WORKSPACE_ROOT"
exec node "$DEST/daemon.cjs"
