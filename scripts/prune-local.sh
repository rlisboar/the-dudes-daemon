#!/usr/bin/env bash
#
# T-261 (auditoria T-204, F-8): poda os daemon.cjs.bak-* acumulados e aperta
# as permissões dos logs do launcher nos homes locais do daemon.
#
# O que faz, por perfil (~/.the-dudes e irmãos ~/.the-dudes-<perfil> que
# contenham daemon.env OU daemon.cjs):
#  - mantém os N mais recentes (default 3) de daemon.cjs.bak-* por mtime e
#    apaga o resto;
#  - chmod go-rwx (0600) em todos os *.log do perfil (hoje nascem 0644 via
#    umask e ficam legíveis por qualquer usuário da máquina).
#
# O que NUNCA faz:
#  - não mata/reinicia/kickstart daemon nenhum — trabalha SÓ em arquivos;
#  - não toca em ~/.the-dudes-mac sem ordem explícita (--home ~/.the-dudes-mac
#    ou --profile mac --allow-mac);
#  - não toca em daemon.cjs, daemon.env, *.pem, project-keys.json etc.
#
# Modos:
#  --check | -n   zero mutação: lista por perfil a identidade (sha256 do
#                 token, 12 primeiros hex — nunca o token), PID vivo do
#                 perfil, baks que seriam removidos e logs que seriam
#                 apertados. Sem flag alguma o script roda em --check.
#  --yes | -y     executa de verdade.
#  --keep N       quantidade de baks mantidos (default 3).
#  --profile X    restringe ao perfil X (nome sem o sufixo; default = todos).
#  --home DIR     home único explícito (fura a exclusão do mac — uso pontual).
#  --allow-mac    inclui ~/.the-dudes-mac na varredura (fora do default).
#
# Idempotente: 2ª execução não encontra nada a fazer (no-op, rc 0).
#
set -euo pipefail

HOME_DIR="${HOME:?HOME não definido}"
CHECK_ONLY=1
ASSUME_YES=0
KEEP=3
PROFILE=""
EXPLICIT_HOME=""
ALLOW_MAC=0

usage() {
  cat <<'EOF'
Uso: prune-local.sh [opções]

  --check | -n       Só reporta (zero mutação). DEFAULT sem flags.
  --yes | -y         Executa a poda + chmod.
  --keep N           Mantém os N baks mais recentes por perfil (default 3).
  --profile <nome>   Restringe a um perfil (ex.: work). Sem flag = todos.
  --home <dir>       Home único explícito (ex.: ~/.the-dudes-mac com ordem).
  --allow-mac        Inclui ~/.the-dudes-mac na varredura padrão.
  -h | --help

Idempotente: sem nada a fazer, não muda nada e sai 0.
EOF
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check|-n) CHECK_ONLY=1; shift ;;
    --yes|-y)   ASSUME_YES=1; shift ;;
    --keep)     [ $# -ge 2 ] || { echo "faltou valor de --keep" >&2; usage 2; }
                case "$2" in (''|*[!0-9]*) echo "--keep precisa de inteiro >= 0" >&2; exit 2;; esac
                KEEP="$2"; shift 2 ;;
    --profile)  [ $# -ge 2 ] || { echo "faltou valor de --profile" >&2; usage 2; }
                case "$2" in (''|*[!a-zA-Z0-9_-]*) echo "--profile só aceita [a-zA-Z0-9_-]" >&2; exit 2;; esac
                PROFILE="$2"; shift 2 ;;
    --home)     [ $# -ge 2 ] || { echo "faltou valor de --home" >&2; usage 2; }
                EXPLICIT_HOME="$2"; shift 2 ;;
    --allow-mac) ALLOW_MAC=1; shift ;;
    -h|--help)  usage 0 ;;
    *) echo "opção desconhecida: $1" >&2; usage 2 ;;
  esac
done

[ "$ASSUME_YES" = "1" ] && CHECK_ONLY=0

file_mode() {
  # modo octal de um arquivo (BSD e GNU)
  stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1" 2>/dev/null || echo "?"
}

token_sha() {
  # sha256 do token do perfil (12 hex) sem imprimir o token
  local envf="$1/daemon.env" tok
  [ -f "$envf" ] || { echo "-"; return; }
  tok="$(grep -m1 'THE_DUDES_DAEMON_TOKEN=' "$envf" | cut -d= -f2- | tr -d '\n')"
  [ -n "$tok" ] || { echo "-"; return; }
  printf '%s' "$tok" | shasum -a 256 2>/dev/null | cut -c1-12
}

running_pid() {
  # PID do daemon.cjs cujo argv aponta para ESTE home (sem matar nada).
  # ps+awk (não pgrep -f): no macOS o pgrep falha p/ processos que são
  # ancestrais da própria sessão (é o caso deste agente).
  # $1=pid, $2=executável — exige node como exe p/ não casar o próprio
  # argv do awk (que contém o path do pat como campo).
  ps -ax -o pid=,command= 2>/dev/null | awk -v pat="$1/daemon.cjs" '
    $2 ~ /(^|\/)node(js)?$/ { for (i = 3; i <= NF; i++) if ($i == pat) { print $1; exit } }' || true
}

# Lista de homes a considerar.
PROFILE_TOTAL=0; BAKS_REMOVED=0; LOGS_TIGHTENED=0; ALREADY_CLEAN=0

consider() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  # é perfil? precisa de daemon.env ou daemon.cjs
  [ -f "$dir/daemon.env" ] || [ -f "$dir/daemon.cjs" ] || return 0
  PROFILE_TOTAL=$((PROFILE_TOTAL + 1))
  local pid tok
  pid="$(running_pid "$dir")"
  tok="$(token_sha "$dir")"
  echo "## $dir  token-sha=$tok pid=${pid:-nenhum}"

  # baks: mantém os KEEP mais recentes por mtime
  local baks stale
  baks="$(ls -1t "$dir"/daemon.cjs.bak-* 2>/dev/null || true)"
  if [ -n "$baks" ]; then
    stale="$(printf '%s\n' "$baks" | tail -n +$((KEEP + 1)))"
  else
    stale=""
  fi
  if [ -n "$stale" ]; then
    printf '%s\n' "$stale" | while IFS= read -r f; do
      [ -n "$f" ] || continue
      echo "  bak-remover: $(basename "$f") ($(file_mode "$f") $(date -r "$f" +%Y-%m-%d\ %H:%M 2>/dev/null || true))"
    done
    if [ "$CHECK_ONLY" = "0" ]; then
      printf '%s\n' "$stale" | while IFS= read -r f; do
        [ -n "$f" ] || continue
        rm -f -- "$f" && echo "  bak-removido: $(basename "$f")"
      done
    fi
  else
    echo "  baks: ok (<= $KEEP)"
  fi

  # logs: 0600
  local logs_bad=0 f
  for f in "$dir"/*.log; do
    [ -e "$f" ] || continue
    if [ "$(file_mode "$f")" != "600" ]; then
      echo "  log-apertar:  $(basename "$f") (modo $(file_mode "$f"))"
      logs_bad=$((logs_bad + 1))
    fi
  done
  if [ "$logs_bad" = "0" ]; then
    echo "  logs: ok (0600)"
  elif [ "$CHECK_ONLY" = "0" ]; then
    for f in "$dir"/*.log; do
      [ -e "$f" ] || continue
      chmod go-rwx "$f" && echo "  log-apertado: $(basename "$f") -> $(file_mode "$f")"
    done
  fi

  # contadores só farão sentido fora dos subshells quando CHECK_ONLY=1
  [ -n "$stale" ] || [ "$logs_bad" != "0" ] || ALREADY_CLEAN=$((ALREADY_CLEAN + 1))
}

if [ -n "$EXPLICIT_HOME" ]; then
  consider "$EXPLICIT_HOME"
elif [ -n "$PROFILE" ]; then
  if [ "$PROFILE" = "default" ]; then consider "$HOME_DIR/.the-dudes"; else consider "$HOME_DIR/.the-dudes-$PROFILE"; fi
else
  consider "$HOME_DIR/.the-dudes"
  for d in "$HOME_DIR"/.the-dudes-*; do
    [ -d "$d" ] || continue
    case "$d" in
      */.the-dudes-mac)
        if [ "$ALLOW_MAC" != "1" ]; then
          echo "## $d  SKIPPED (mac só com --home/--allow-mac)"
          continue
        fi ;;
      */.the-dudes-signing|*/.the-dudes-signing-backup|*/.the-dudes-backup-key) continue ;;
    esac
    consider "$d"
  done
fi

if [ "$CHECK_ONLY" = "1" ]; then
  echo "modo: --check (zero mutação). Use --yes para executar."
else
  echo "modo: --yes (executado)."
fi
exit 0
