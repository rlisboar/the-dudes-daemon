/**
 * When the daemon runs as root (e.g. `sudo node daemon.cjs ...` to bypass
 * an outbound firewall app on the host that intercepts the unprivileged
 * node process), child processes — claude/opencode/git/etc — must drop
 * back to the original user. Otherwise files would be created as root
 * in the user's workspace and CLI tools may refuse to run.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";

export interface DropTarget {
  uid: number;
  gid: number;
  user: string;
  home: string;
  path: string;
}

export function detectDropTarget(): DropTarget | null {
  // not on POSIX (windows) — geteuid is undefined
  if (typeof process.geteuid !== "function") return null;
  if (process.geteuid() !== 0) return null;
  const user = process.env.SUDO_USER;
  const uid = Number(process.env.SUDO_UID);
  const gid = Number(process.env.SUDO_GID);
  if (!user || !Number.isFinite(uid) || !Number.isFinite(gid)) return null;
  // Defensive: SUDO_USER vem do env. Em systemd Unit malicioso ou
  // env injection antes do exec, pode ter caracteres especiais que
  // depois entram em comandos shell (resolveUserPath via execFileSync
  // com sh -lc). Restringe a POSIX username válido (RFC + util-linux).
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(user)) {
    console.warn(`[privileges] SUDO_USER inválido: "${user}" — skip drop`);
    return null;
  }

  const home = resolveHome(user) ?? defaultHomeFor(user);
  const path = resolveUserPath(user);
  return { uid, gid, user, home, path };
}

function resolveHome(user: string): string | null {
  // Prefer the HOME env if sudo --preserve-env=HOME was used and it's not
  // root's home.
  const fromEnv = process.env.HOME;
  if (fromEnv && fromEnv !== "/var/root" && fromEnv !== "/root") {
    return fromEnv;
  }
  // Try platform-specific lookups.
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("dscl", [".", "-read", `/Users/${user}`, "NFSHomeDirectory"], {
        encoding: "utf8",
        timeout: 1500,
      });
      const m = out.match(/NFSHomeDirectory:\s*(\S+)/);
      if (m) return m[1];
    } else {
      const out = execFileSync("getent", ["passwd", user], { encoding: "utf8", timeout: 1500 });
      const fields = out.trim().split(":");
      if (fields.length >= 6 && fields[5]) return fields[5];
    }
  } catch {}
  return null;
}

function defaultHomeFor(user: string): string {
  return process.platform === "darwin" ? `/Users/${user}` : `/home/${user}`;
}

/**
 * Try to resolve the target user's login PATH. Falls back to a sane default
 * containing common dirs where the agent CLIs live.
 */
function resolveUserPath(user: string): string {
  // Sudo preserves PATH when --preserve-env=PATH; trust it if it doesn't
  // look like the secure_path.
  const env = process.env.PATH;
  if (env && !/^\/usr\/bin:?\/?bin$/.test(env)) return env;
  try {
    const out = execFileSync(
      "sudo",
      ["-u", user, "-i", "sh", "-lc", "echo $PATH"],
      { encoding: "utf8", timeout: 2000 }
    );
    const trimmed = out.trim();
    if (trimmed) return trimmed;
  } catch {}
  return "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
}

/**
 * Apply a drop target to a SpawnOptions object: set uid/gid and override
 * env vars that depend on the user (HOME, USER, LOGNAME, PATH).
 *
 * IMPORTANTE: setar `uid`/`gid` via spawn não chama `initgroups(3)` —
 * o processo dropado HERDA supplementary groups do daemon root (`wheel`,
 * `docker`, `adm`). Pra fechar isso, use `spawnDropped()` que envolve via
 * `setpriv --init-groups` quando disponível. Esse `applyDrop` continua
 * útil pra setar env mesmo quando o wrapper é usado (spawnDropped chama
 * por baixo).
 */
export function applyDrop<T extends SpawnOptions>(opts: T, drop: DropTarget | null): T {
  if (!drop) return opts;
  const env = {
    ...(opts.env ?? process.env),
    USER: drop.user,
    LOGNAME: drop.user,
    HOME: drop.home,
    PATH: drop.path,
  };
  return { ...opts, uid: drop.uid, gid: drop.gid, env } as T;
}

/* ---------- setpriv wrapper for safe drop (H-12) ---------- */

let setprivPathCache: string | null | undefined = undefined;
let setprivWarnedAbsent = false;

function findSetpriv(): string | null {
  if (setprivPathCache !== undefined) return setprivPathCache;
  const candidates = [
    "/usr/bin/setpriv",
    "/sbin/setpriv",
    "/usr/sbin/setpriv",
    "/bin/setpriv",
  ];
  for (const p of candidates) {
    try {
      accessSync(p, fsConstants.X_OK);
      setprivPathCache = p;
      return p;
    } catch { /* try next */ }
  }
  // Last-resort PATH lookup via `command -v` (works mesmo sem which).
  try {
    const out = spawnSync("/bin/sh", ["-c", "command -v setpriv"], {
      encoding: "utf8",
      timeout: 1500,
    });
    const found = (out.stdout ?? "").trim();
    if (found) {
      setprivPathCache = found;
      return found;
    }
  } catch { /* fall through */ }
  setprivPathCache = null;
  return null;
}

/** Spawn dropping privileges com initgroups(3) correto via setpriv.
 *
 *  - Quando há `drop` + setpriv disponível: spawn setpriv que chama
 *    setresgid + initgroups (carrega grupos LEGÍTIMOS do user da
 *    `/etc/group`) + setresuid + drop de capabilities herdadas.
 *  - Quando setpriv não existe (macOS sem util-linux, container minimal):
 *    o drop nativo via uid/gid NÃO chama initgroups(3), então o filho
 *    HERDA os supplementary groups do daemon root (`wheel`, `admin`,
 *    `docker`, `adm`) — um "dropped" process com group docker chega
 *    trivialmente a root via socket. Por isso, por padrão RECUSAMOS rodar
 *    (fail-closed): lançamos erro em vez de fazer um drop inseguro
 *    silencioso. Para ambientes onde isso é aceito conscientemente, o
 *    fallback é opt-in via `DUDES_ALLOW_UNSAFE_DROP=1` — aí caímos pro
 *    spawn nativo com uid/gid (comportamento legado) logando warn.
 *  - Quando não há drop: spawn nativo sem mexer em uid/gid.
 *
 *  Env vars dependentes de user (HOME/USER/LOGNAME/PATH) são setadas
 *  via applyDrop em ambos paths. Outras opts (cwd, stdio, etc) passam
 *  through.
 */
export function spawnDropped(
  cmd: string,
  args: string[],
  opts: SpawnOptions,
  drop: DropTarget | null,
): ChildProcess {
  /*
   * `detached: true` em TODO spawn de CLI: cria um process group novo com o
   * filho como líder, e é o que permite ao kill alcançar a árvore inteira
   * (`kill(-pid)` em process-lifecycle). Sem isso, o SIGKILL ia só no filho
   * direto — o wrapper (setpriv, pty do opencode) morria e o CLI real
   * sobrevivia segurando os pipes: 'close' nunca vinha, o turno ficava
   * "busy preso" e a sessão era descartada com 40-50KB de contexto reenviado.
   * Medido em produção: 3 hard recovers num dia, todos com "close não veio".
   */
  opts = { ...opts, detached: true };
  if (!drop) {
    return spawn(cmd, args, opts);
  }
  const setpriv = findSetpriv();
  if (setpriv) {
    const wrappedArgs = [
      "--reuid", String(drop.uid),
      "--regid", String(drop.gid),
      "--init-groups",
      "--inh-caps=-all",
      "--",
      cmd,
      ...args,
    ];
    // spawnOptions: NÃO seta uid/gid (setpriv faz o drop interno).
    // Mantém env (HOME/USER/LOGNAME/PATH) via applyDrop sem uid/gid.
    const envOnly = {
      ...(opts.env ?? process.env),
      USER: drop.user,
      LOGNAME: drop.user,
      HOME: drop.home,
      PATH: drop.path,
    };
    const safeOpts: SpawnOptions = { ...opts, env: envOnly };
    delete (safeOpts as any).uid;
    delete (safeOpts as any).gid;
    return spawn(setpriv, wrappedArgs, safeOpts);
  }
  // setpriv ausente: o drop nativo deixa vazar os supplementary groups de
  // root (docker/wheel/admin → escalada trivial). Fail-closed por padrão;
  // só prossegue com o drop inseguro se explicitamente liberado no env.
  const allowUnsafe = process.env.DUDES_ALLOW_UNSAFE_DROP === "1";
  if (!allowUnsafe) {
    throw new Error(
      "[the-dudes] privilege drop inseguro recusado: setpriv não encontrado, " +
      `o filho (uid=${drop.uid}) herdaria os supplementary groups de root ` +
      "(docker/wheel/admin → escalada trivial). Instale util-linux (setpriv), " +
      "rode o daemon diretamente como o user alvo, ou — assumindo o risco — " +
      "exporte DUDES_ALLOW_UNSAFE_DROP=1 para liberar o fallback nativo.",
    );
  }
  if (!setprivWarnedAbsent) {
    setprivWarnedAbsent = true;
    console.warn(
      "[the-dudes] setpriv not found — DUDES_ALLOW_UNSAFE_DROP=1 ativo: child processes " +
      "will inherit daemon's supplementary groups " +
      `(uid=${drop.uid} pode acessar recursos via groups herdadas de root). ` +
      "Instale util-linux ou rode o daemon como o user alvo direto.",
    );
  }
  return spawn(cmd, args, applyDrop(opts, drop));
}
