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

# Chave pública Ed25519 (estágio N+3 — SÓ a NOVA; T-035). Privada NUNCA no container.
# Ver docs/ED25519-KEY-ROTATION.md.
SIGN_PUB='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAyOfZNGAQ8udECo/9GauS2CG7jBZM/nIcrry4dd7atXY=
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

# Verifica assinatura Ed25519 — FAIL-CLOSED (só pubkey NOVA).
verify_sig() {
  _out="$1"
  _sig=$(curl -fsSL "$THE_DUDES_ORCH/install/$(basename "$_out").sig" 2>/dev/null || true)
  if [ -z "$_sig" ]; then
    echo "error: assinatura ausente em $_out — abortando (tampering ou build não-assinado)" >&2
    rm -f "$_out"; exit 1
  fi
  printf '%s' "$_sig" > "$_out.sig"
  if node -e '
const {verify}=require("crypto"), fs=require("fs");
const body=fs.readFileSync(process.argv[1]);
const sig=Buffer.from(fs.readFileSync(process.argv[2],"utf8").trim(),"base64");
const pub=process.env.SIGN_PUB;
let ok=false;
try { ok=!!pub && verify(null, body, pub, sig); } catch { ok=false; }
process.exit(ok?0:1);
' "$_out" "$_out.sig"; then
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
