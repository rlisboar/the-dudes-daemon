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
# Perfil NOMEADO ignora THE_DUDES_HOME (evita 2 labels no MESMO home se a
# var estiver exportada no shell do dono — colisão de kill/binário).
resolve_profile() {
  if [ -z "$PROFILE" ] || [ "$PROFILE" = "default" ]; then
    LABEL="com.the-dudes.daemon"
    TD_DIR="${THE_DUDES_HOME:-$HOME_DIR/.the-dudes}"
    PROFILE_DISP="default"
    PROFILE=""
    return
  fi
  if ! printf '%s' "$PROFILE" | grep -Eq '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$'; then
    die "perfil inválido '$PROFILE' (use [a-zA-Z0-9][a-zA-Z0-9_-]{0,31})"
  fi
  LABEL="com.the-dudes.daemon.$PROFILE"
  if [ -n "${THE_DUDES_HOME:-}" ] && [ "${THE_DUDES_HOME_FORCE:-}" != "1" ]; then
    warn "THE_DUDES_HOME=$THE_DUDES_HOME ignorado para --profile $PROFILE (use THE_DUDES_HOME_FORCE=1 para forçar)"
  fi
  if [ "${THE_DUDES_HOME_FORCE:-}" = "1" ] && [ -n "${THE_DUDES_HOME:-}" ]; then
    TD_DIR="$THE_DUDES_HOME"
  else
    TD_DIR="$HOME_DIR/.the-dudes-$PROFILE"
  fi
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

# PATH do LaunchAgent (T-031): inclui dirs de runners de usuário.
# Espelha userRunnerBinDirs() em daemon/src/cli-config.ts — sem depender de
# .zshrc. Ordem: user bins → homebrew → system.
default_path() {
  local home="${HOME_DIR:-$HOME}"
  local parts=(
    "$home/.grok/bin"
    "$home/.local/bin"
    "$home/bin"
    "/opt/homebrew/bin"
    "/usr/local/bin"
    "/usr/bin"
    "/bin"
    "/usr/sbin"
    "/sbin"
  )
  local out="" d
  for d in "${parts[@]}"; do
    # inclui mesmo se ainda não existir (usuário pode instalar CLI depois)
    if [ -z "$out" ]; then out="$d"; else out="$out:$d"; fi
  done
  printf '%s\n' "$out"
}

# Reporta se runners resolvem com o PATH do plist (simula launchd).
report_runners_on_plist_path() {
  local path_val
  path_val="$(default_path)"
  log "plist_PATH:      $path_val"
  local r found miss
  for r in grok claude opencode gemini codex crush; do
    found=""
    # which com PATH=plist (não herda shell do dono)
    found="$(PATH="$path_val" /usr/bin/which "$r" 2>/dev/null || true)"
    if [ -z "$found" ]; then
      # fallback: scan dirs do PATH manualmente (which às vezes falha em symlink)
      local dir cand
      IFS=':' read -r -a _dirs <<< "$path_val"
      for dir in "${_dirs[@]}"; do
        cand="$dir/$r"
        if [ -x "$cand" ]; then found="$cand"; break; fi
      done
    fi
    if [ -n "$found" ]; then
      log "runner $r:       OK  $found"
    else
      log "runner $r:       AUSENTE (não está no PATH do LaunchAgent)"
      miss=1
    fi
  done
  if [ "${miss:-0}" = "1" ]; then
    warn "runners ausentes sob PATH do plist — agentes desses CLIs não iniciam sob launchd"
    warn "instale o CLI ou adicione o dir ao default_path / daemon-config cliPaths"
  fi
}

# True se $cmd referencia EXATAMENTE um path sob $TD_DIR (não um primo
# ~/.the-dudes-work quando TD_DIR=~/.the-dudes). Exige o path completo do
# binário/launcher como token de argv.
cmd_belongs_to_td_dir() {
  local cmd="$1"
  local bin="$TD_DIR/daemon.cjs"
  local run="$TD_DIR/run-daemon.sh"
  # token match: espaço/início antes e espaço/fim depois — evita substring
  # acidental. Paths absolutos no argv do launchd/node.
  case " $cmd " in
    *" $bin "*|*" $bin"|*"$bin "*) return 0 ;;
    *" $run "*|*" $run"|*"$run "*) return 0 ;;
  esac
  # argv às vezes cola sem espaço final
  case "$cmd" in
    "$bin"|"$bin "*|*" $bin"|*" $bin "*) return 0 ;;
    "$run"|"$run "*|*" $run"|*" $run "*) return 0 ;;
  esac
  return 1
}

# PIDs deste perfil apenas. Nunca pkill genérico; nunca outro perfil.
list_loose_pids() {
  local pid cmd
  ps -axo pid=,command= 2>/dev/null | while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    pid="${line%% *}"
    cmd="${line#"$pid"}"
    cmd="${cmd#"${cmd%%[![:space:]]*}"}"
    if cmd_belongs_to_td_dir "$cmd"; then
      printf '%s\n' "$pid"
    fi
  done | sort -un
}

pid_still_ours() {
  local pid="$1" cmd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [ -n "$cmd" ] || return 1
  cmd_belongs_to_td_dir "$cmd"
}

safe_stop_loose() {
  local pids pid
  pids="$(list_loose_pids | tr '\n' ' ')"
  pids="${pids%% }"
  if [ -z "${pids// }" ]; then
    log "nenhum processo do perfil em $TD_DIR"
    return 0
  fi
  log "processos do perfil a parar (PIDs): $pids"
  if [ "$NO_KILL" -eq 1 ]; then
    warn "--no-kill: não mato"
    return 0
  fi
  for pid in $pids; do
    pid_still_ours "$pid" || { warn "PID $pid já não é deste perfil — pulando"; continue; }
    log "SIGTERM PID $pid (perfil $PROFILE_DISP)"
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in $pids; do
    if pid_still_ours "$pid"; then
      log "SIGKILL PID $pid (perfil $PROFILE_DISP)"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
}

# Avisa se plists de OUTROS perfis sumiram (não deveria acontecer).
assert_siblings_intact() {
  local f base
  shopt -s nullglob 2>/dev/null || true
  for f in "$PLIST_DIR"/com.the-dudes.daemon*.plist; do
    [ -f "$f" ] || continue
    base="$(basename "$f" .plist)"
    [ "$base" = "$LABEL" ] && continue
    if ! launchctl print "$DOMAIN/$base" >/dev/null 2>&1; then
      warn "irmão $base tem plist mas não está loaded (não fui eu que removi o arquivo)"
    else
      log "irmão intacto: $base"
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

# Verifica sha256 de um bundle contra seu .sha256. Retorna 0=ok, 1=mismatch,
# 2=sem arquivo .sha256, 3=sem ferramenta de hash. O caminho de self-update
# (self-update.ts) já verifica assinatura Ed25519; aqui garantimos ao menos
# integridade no seed, que antes copiava cego.
verify_sha256() {
  local file="$1" shafile="$2" expected actual
  [ -f "$shafile" ] || return 2
  expected="$(awk '{print $1; exit}' "$shafile")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    return 3
  fi
  [ -n "$expected" ] && [ "$expected" = "$actual" ]
}

# Gate de integridade antes de copiar um binário semeado. Fail-closed em
# corrupção; warn (não bloqueia install) quando não há sha/ferramenta.
seed_check() {
  local file="$1" name="$2" rc=0
  # `|| rc=$?` é obrigatório: sob `set -e`, chamar verify_sha256 solto abortaria
  # o install em QUALQUER retorno ≠0 (inclusive 2/3 = "sem sha/ferramenta"),
  # transformando os warns em código morto. O `||` captura o código e desliga
  # o errexit pra esta chamada.
  verify_sha256 "$file" "$file.sha256" || rc=$?
  case $rc in
    0) : ;;
    1) die "seed $name FALHOU sha256 — bundle corrompido em $file, abortando" ;;
    2) warn "seed $name sem .sha256 — copiando sem verificar integridade" ;;
    3) warn "seed $name: sem sha256sum/shasum — copiando sem verificar integridade" ;;
  esac
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
      seed_check "$seed_dir/daemon.cjs" "daemon.cjs"
      cp "$seed_dir/daemon.cjs" "$DAEMON_BIN"
      chmod 755 "$DAEMON_BIN"
      log "seed daemon.cjs ← $seed_dir"
      if [ -f "$seed_dir/mcp-bridge.cjs" ]; then
        seed_check "$seed_dir/mcp-bridge.cjs" "mcp-bridge.cjs"
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
  report_runners_on_plist_path

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
  # 0700: TD_DIR guarda daemon.env (token), .sig e binários — não deve ser
  # legível por grupo/outros.
  chmod 700 "$TD_DIR" 2>/dev/null || true

  if [ ! -f "$ENV_FILE" ]; then
    warn "env ausente: $ENV_FILE — crie com THE_DUDES_ORCH / THE_DUDES_DAEMON_TOKEN / THE_DUDES_DAEMON_NAME antes de usar"
  else
    # daemon.env tem o token — 0600 sempre (self-heal de instalações antigas 644).
    chmod 600 "$ENV_FILE" 2>/dev/null || true
  fi

  local tmp
  tmp="$(mktemp -t td-plist.XXXXXX)"
  # render precisa dos paths; run-daemon ainda não precisa estar no destino
  render_plist "$tmp"
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$tmp" >/dev/null || die "plist inválido"
  fi

  # ORDEM CRÍTICA (T-031): parar o agent ANTES de sobrescrever run-daemon.sh.
  # Copiar o script enquanto o bash do launchd ainda o executa corrompe o
  # fluxo (leituras parciais) e deixa o job em estado estranho.
  if [ "$NO_LOAD" -eq 0 ]; then
    if agent_loaded; then
      log "bootout $DOMAIN/$LABEL (antes de atualizar arquivos)"
      launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || \
        launchctl unload "$PLIST_PATH" 2>/dev/null || true
    fi
    safe_stop_loose
  else
    log "--no-load: skip kill/bootout"
  fi

  # Só agora atualiza launcher/binários no home do perfil.
  cp "$RUN_DAEMON_SRC" "$RUN_DAEMON_DST"
  chmod 755 "$RUN_DAEMON_DST"
  log "launcher → $RUN_DAEMON_DST"
  seed_binaries

  cp "$tmp" "$PLIST_PATH"
  chmod 644 "$PLIST_PATH"
  rm -f "$tmp"
  log "plist → $PLIST_PATH"

  if [ "$NO_LOAD" -eq 1 ]; then
    log "OK materializado (sem load). Perfil=$PROFILE_DISP td=$TD_DIR"
    assert_siblings_intact
    return 0
  fi

  if launchctl bootstrap "$DOMAIN" "$PLIST_PATH" 2>/dev/null; then
    log "bootstrap OK"
  else
    # Já existia no domínio: tenta bootout residual + bootstrap de novo
    warn "bootstrap falhou — retry bootout+bootstrap"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    if ! launchctl bootstrap "$DOMAIN" "$PLIST_PATH" 2>/dev/null; then
      warn "bootstrap ainda falhou — tentando load legacy"
      launchctl load -w "$PLIST_PATH" 2>/dev/null || launchctl load "$PLIST_PATH" || true
    else
      log "bootstrap OK (retry)"
    fi
  fi
  launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
  if launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null; then
    log "kickstart OK"
  else
    launchctl kickstart "$DOMAIN/$LABEL" 2>/dev/null || true
    log "kickstart (sem -k) tentado"
  fi
  sleep 1
  if agent_loaded; then
    log "agent ativo: $DOMAIN/$LABEL"
  else
    warn "agent NÃO ativo após install — plist em $PLIST_PATH; ver $LAUNCHD_STDERR"
    warn "NÃO remova o plist; rode de novo: $0 --yes ${PROFILE:+--profile $PROFILE}"
  fi
  assert_siblings_intact
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
