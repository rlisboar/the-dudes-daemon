import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** Named profile selected only on explicit non-owner Codex turn invocations. */
export const CODEX_MEMBER_PERMISSION_PROFILE = "the_dudes_member_readonly";

/**
 * The generic `read-only` preset can read any file on disk. This profile
 * grants only workspace reads (plus the CLI's minimal runtime paths), with
 * temp paths and network denied.
 *
 * Vai SÓ no argv do turno de membro (`-c permissions.<perfil>={…}`), nunca no
 * config.toml do agente: com a tabela `[permissions]` no arquivo, o turno do
 * DONO com `--dangerously-bypass-approvals-and-sandbox` falha com "failed to
 * load workspace requirements" (codex-cli 0.156.1). Sem o `-c`, um
 * `default_permissions` órfão é recusado pelo CLI — falha fechado.
 *
 * Provado com `codex exec` e `codex exec resume` reais (macOS): numa sessão
 * criada pelo dono sem perfil, o resume de membro troca para
 * `managed/restricted` (não herda a política da sessão) e o seatbelt nega a
 * leitura fora do workspace e a escrita; o turno seguinte do dono volta a
 * `danger-full-access`. Exige o codex invocado pelo realpath nativo (o helper
 * reexecuta o caminho invocado; o symlink do PATH dá EPERM).
 */
export const CODEX_MEMBER_PERMISSION_PROFILE_OVERRIDE =
  `permissions.${CODEX_MEMBER_PERMISSION_PROFILE}={` +
  'extends=":read-only", ' +
  'filesystem={":root"="deny", ":minimal"="read", ":tmpdir"="deny", ":slash_tmp"="deny", ":workspace_roots"={"."="read"}}, ' +
  "network={enabled=false}}";

const LEGACY_SANDBOX_SETTING = /^\s*(?:sandbox_mode\s*=|\[sandbox_workspace_write(?:\.|\])|sandbox_workspace_write\s*=)/m;

/**
 * Codex falls back to the legacy broad sandbox if any loaded config layer
 * defines sandbox_mode/sandbox_workspace_write. Refuse the member turn rather
 * than silently dropping the custom workspace-only profile in that case.
 */
export function codexHasLegacySandboxConfig(workspaceRoot: string): boolean {
  let root: string;
  try { root = realpathSync(workspaceRoot); }
  catch { root = path.resolve(workspaceRoot); }
  const candidates = new Set<string>(["/etc/codex/config.toml"]);
  for (let dir = root; ; dir = path.dirname(dir)) {
    candidates.add(path.join(dir, ".codex", "config.toml"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
  }
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let config: string;
    try { config = readFileSync(file, "utf8"); }
    catch { return true; }
    if (LEGACY_SANDBOX_SETTING.test(config)) return true;
  }
  return false;
}


const NATIVE_MAGIC = new Set([
  "7f454c46", // ELF
  "cffaedfe", "cefaedfe", "feedfacf", "feedface", // Mach-O
  "cafebabe", "bebafeca", // Mach-O universal
]);

/**
 * Realpath do codex nativo que o turno de membro executa. O sandbox reexecuta
 * o binário pelo caminho invocado (symlink do PATH = execvp EPERM), então o
 * spawn do membro usa este realpath. Wrapper (script npm/shim) ou ausente → null, e o
 * turno de membro fica bloqueado.
 */
export function resolveCodexNativeBinary(command: string, envPath: string | undefined): string | null {
  const candidates = command.includes("/")
    ? [command]
    : (envPath ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
  for (const candidate of candidates) {
    let real: string;
    try { real = realpathSync(candidate); } catch { continue; }
    try {
      if (!statSync(real).isFile()) continue;
      accessSync(real, constants.X_OK);
      const fd = openSync(real, "r");
      const magic = Buffer.alloc(4);
      try { readSync(fd, magic, 0, 4, 0); } finally { closeSync(fd); }
      return NATIVE_MAGIC.has(magic.toString("hex")) ? real : null;
    } catch {
      return null;
    }
  }
  return null;
}
