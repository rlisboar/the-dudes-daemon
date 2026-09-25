import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerAgentPid } from "../privileges.js";

export interface RuntimeImage {
  base64: string;
  mimeType: string;
}

/** Dir name sob $HOME. grok-custom isola do home do CLI oficial. */
export function grokHomeDirName(runner?: string): string {
  return runner === "grok-custom" ? ".grok-custom" : ".grok";
}

export function grokHomePath(home: string, runner?: string): string {
  return path.join(home, grokHomeDirName(runner));
}

const CODEX_AGENT_HOMES_DIR = ".the-dudes-agent-homes";
const CODEX_AGENT_SLUG = /^[a-f0-9]{10}$/;
const CODEX_RESUME_COMPAT_MARKER = ".the-dudes-resume-compat-v1";

function codexAgentSlug(agentId: string): string {
  return createHash("sha1").update(agentId).digest("hex").slice(0, 10);
}

/** T-1248: resolve para a base real quando CODEX_HOME foi herdado de uma home
 *  legada ou atual do daemon. Desembrulha mais de um nível para também
 *  recuperar as homes aninhadas criadas antes do isolamento dos testes. */
function codexBaseFromAgentHome(codexHome: string): string | undefined {
  let candidate = path.resolve(codexHome);
  let recognized = false;
  while (CODEX_AGENT_SLUG.test(path.basename(candidate))) {
    const parent = path.basename(path.dirname(candidate));
    if (parent !== "agents" && parent !== CODEX_AGENT_HOMES_DIR) break;
    candidate = path.dirname(path.dirname(candidate));
    recognized = true;
  }
  return recognized ? candidate : undefined;
}

/** Quarantines live beside (not inside) any agent home. The compatibility
 *  link under CODEX_HOME/agents points at the home, and Codex recursively
 *  scans that tree for role files; keeping old nested homes elsewhere avoids
 *  making them visible to that scan again. */
function quarantineRoot(codexBase: string): string {
  return path.join(codexBase, `${CODEX_AGENT_HOMES_DIR}-orfaos`);
}

function quarantinePath(codexBase: string, slug: string, suffix: string): string {
  const root = quarantineRoot(codexBase);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try { chmodSync(root, 0o700); } catch {}
  let dest = path.join(root, `${slug}-${suffix}`);
  for (let n = 2; existsSync(dest); n++) dest = path.join(root, `${slug}-${suffix}-${n}`);
  return dest;
}

function moveNestedCodexAgentHomes(codexBase: string, slug: string, home: string): boolean {
  const nested = path.join(home, "agents");
  let info;
  try { info = lstatSync(nested); } catch { return true; }
  if (!info.isDirectory() && !info.isSymbolicLink()) return true;

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const quarantined = quarantinePath(codexBase, slug, `agents.orfaos-${date}`);
  try {
    renameSync(nested, quarantined);
    return true;
  } catch {
    return false;
  }
}

/** Moves quarantines created by the earlier T-1248 code out of the home too.
 *  Idempotent: already external paths are left untouched. */
function moveExistingCodexQuarantines(codexBase: string, slug: string, home: string): boolean {
  let names: string[];
  try { names = readdirSync(home).filter((name) => name.startsWith("agents.orfaos-")); }
  catch { return false; }
  for (const name of names) {
    const source = path.join(home, name);
    let info;
    try { info = lstatSync(source); } catch { continue; }
    if (!info.isDirectory() && !info.isSymbolicLink()) continue;
    const target = quarantinePath(codexBase, slug, name);
    try { renameSync(source, target); } catch { return false; }
  }
  return true;
}

/** Move a home T-426 existente na primeira inicialização deste agente. Rename
 *  é atômico dentro do mesmo base; preserva config, modos, symlinks de auth e
 *  sessions. O `agents/` aninhado é só renomeado para uma quarentena inerte;
 *  seus arquivos ficam disponíveis para a limpeza pós-rollout. Não apaga nem
 *  sobrescreve se a nova home já existir. */
function migrarCodexAgentHome(codexBase: string, slug: string): void {
  const antiga = path.join(codexBase, "agents", slug);
  const nova = path.join(codexBase, CODEX_AGENT_HOMES_DIR, slug);
  let infoAntiga;
  try { infoAntiga = lstatSync(antiga); } catch { return; }
  if (!infoAntiga.isDirectory() || infoAntiga.isSymbolicLink() || existsSync(nova)) return;
  mkdirSync(path.dirname(nova), { recursive: true, mode: 0o700 });
  try { chmodSync(path.dirname(nova), 0o700); } catch {}
  if (!moveNestedCodexAgentHomes(codexBase, slug, antiga)) return;
  if (!moveExistingCodexQuarantines(codexBase, slug, antiga)) return;
  try {
    renameSync(antiga, nova);
    try { chmodSync(nova, 0o700); } catch {}
  } catch {
    // Migração best-effort: nunca apagar a sessão antiga se rename falhar.
  }
}

/** The Codex state DB stores absolute rollout paths. Keep the old home path as
 *  a compatibility symlink so those paths keep resolving after migration.
 *  Never replace a real file/directory: only an absent name or our own symlink
 *  is safe to adopt. */
function ensureLegacyCodexHomeAlias(codexBase: string, slug: string, home: string): boolean {
  const legacy = path.join(codexBase, "agents", slug);
  let info;
  try { info = lstatSync(legacy); } catch { info = undefined; }
  if (info?.isSymbolicLink()) {
    try {
      const current = path.resolve(path.dirname(legacy), readlinkSync(legacy));
      if (current === path.resolve(home)) return true;
    } catch { return false; }
    return false;
  }
  if (info) return false;
  mkdirSync(path.dirname(legacy), { recursive: true, mode: 0o700 });
  try { chmodSync(path.dirname(legacy), 0o700); } catch {}
  try {
    symlinkSync(path.relative(path.dirname(legacy), home), legacy, "dir");
    return true;
  } catch { return false; }
}

/** T-426/A15 + T-1248: home por agente fica em sibling de `agents/`, para o
 *  Codex CLI não confundi-la com definições de papel. O slug permanece estável
 *  para que `sessions` continue retomando a mesma conversa após restart. */
export function codexAgentHomePath(codexBase: string, agentId: string): string {
  return path.join(codexBase, CODEX_AGENT_HOMES_DIR, codexAgentSlug(agentId));
}

/** Arquivos e diretórios pertencentes a uma única instância de runner.
 * O tmpdir aleatório evita paths previsíveis; segredos e configs ficam 0600. */
export class RunnerRuntimeFiles {
  private tempPath?: string;
  private imageSequence = 0;

  constructor(private readonly input: {
    workspaceRoot: string;
    agentId: string;
    agentToken: string;
    home?: string;
    tempRoot?: string;
    /** Identidade do runner — grok-custom isola sessões em ~/.grok-custom. */
    runner?: string;
  }) {}

  tempDir(): string {
    if (this.tempPath) return this.tempPath;
    const parent = path.join(this.input.tempRoot ?? os.tmpdir(), "the-dudes");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    try { chmodSync(parent, 0o700); } catch {}
    this.tempPath = mkdtempSync(path.join(parent, "ag-"));
    return this.tempPath;
  }

  tokenFile(): string {
    const tokenPath = path.join(this.tempDir(), "agent.token");
    writeFileSync(tokenPath, this.input.agentToken, { mode: 0o600 });
    try { chmodSync(tokenPath, 0o600); } catch {}
    return tokenPath;
  }

  /** Associa o pid do CLI (e a árvore de filhos) a este agente. */
  bindProcess(pid: number): void {
    registerAgentPid(this.input.agentId, pid);
  }

  geminiConfigDir(): string {
    const dir = path.join(this.tempDir(), ".gemini");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch {}
    return dir;
  }

  /** Config dir POR AGENTE do Qwen Code (QWEN_HOME): settings.json com
   *  mcpServers do bridge. Auth/model do dono ficam no ~/.qwen real — só o
   *  config de MCP é isolado por agente.
   *  ESTÁVEL por agente (hash do id, fora do `ag-*` aleatório): o qwen grava
   *  as sessões em QWEN_HOME/projects/<cwd>/chats — com QWEN_HOME efêmero o
   *  `-r <uuid>` morria a cada restart ("No saved session found"). */
  qwenHomeDir(): string {
    const parent = path.join(this.input.tempRoot ?? os.tmpdir(), "td-qwen");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    try { chmodSync(parent, 0o700); } catch {}
    const slug = createHash("sha1").update(this.input.agentId).digest("hex").slice(0, 10);
    const dir = path.join(parent, slug);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch {}
    return dir;
  }

  /** cwd ESTÁVEL por agente para o qwen: as sessões são project-scoped pela
   *  chave do cwd; com o tempDir aleatório a chave mudava a cada arranque e
   *  o resume falhava mesmo com QWEN_HOME estável. */
  qwenCwdDir(): string {
    const dir = path.join(this.qwenHomeDir(), "cwd");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch {}
    return dir;
  }

  openCodeConfigPath(): string {
    return path.join(this.tempDir(), "opencode.json");
  }

  /**
   * Home do CLI Grok (auth.json, sessions, signals, updates).
   *
   * grok-custom (T-164/T-166): o wrapper grava em `$HOME/.grok-custom` e o
   * daemon NÃO seta GROK_HOME — os leitores de sessão precisam do mesmo
   * path, senão RUNS/ocupação/billing ficam vazios. grok oficial: `~/.grok`.
   */
  grokHome(): string {
    return grokHomePath(this.input.home ?? os.homedir(), this.input.runner);
  }

  /**
   * Socket do "leader" do Grok, POR AGENTE.
   *
   * O CLI roda um processo leader compartilhado por GROK_HOME
   * (`~/.grok/leader.sock`) e todo cliente headless fala com ele. Com um
   * leader só, os turnos de TODOS os agentes — mais o `grok` interativo do
   * usuário e o de um segundo daemon na mesma máquina — dependem do mesmo
   * processo: se ele trava, os clientes ficam esperando o socket sem
   * consumir CPU e sem escrever nada (o hang mudo que só o restart resolvia,
   * porque o SIGKILL do watchdog mata o CLIENTE, nunca o leader).
   *
   * Path curto no tmpdir do sistema de propósito: sockets Unix têm limite de
   * ~104 bytes no macOS e o tmpdir por agente já é longo.
   */
  grokLeaderSocket(): string {
    const parent = path.join(this.input.tempRoot ?? os.tmpdir(), "td-grok");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    try { chmodSync(parent, 0o700); } catch {}
    const slug = createHash("sha1").update(this.input.agentId).digest("hex").slice(0, 10);
    return path.join(parent, `${slug}.sock`);
  }

  /** Base do CODEX_HOME do dono (respeita override por env do container).
   *  T-506: em ROOT+drop, um CODEX_HOME apontando pro home do ROOT não é
   *  atravessável pelo CLI dropado (ex.: /root é 0700) — nesse caso a base
   *  vai pro home do user do drop. Override para path acessível (container
   *  montado, /opt/...) continua vencendo. */
  private codexBaseDir(): string {
    const forced = process.env.CODEX_HOME?.trim();
    if (forced) {
      const forcedBase = codexBaseFromAgentHome(forced) ?? forced;
      const daemonHome = os.homedir();
      const dropHome = this.input.home;
      const dropping = !!dropHome && path.resolve(dropHome) !== path.resolve(daemonHome);
      const forcedInsideDaemonHome =
        path.resolve(forcedBase) === path.resolve(daemonHome) ||
        path.resolve(forcedBase).startsWith(path.resolve(daemonHome) + path.sep);
      if (!(dropping && forcedInsideDaemonHome)) return forcedBase;
    }
    return path.join(this.input.home ?? os.homedir(), ".codex");
  }

  /**
   * Home POR AGENTE do codex: config.toml com os MCPs (escrito pelo runner,
   * 0600) fora do repo. `auth.json` e `sessions` apontam pro base por symlink
   * — sem isso o CLI ficaria deslogado ou perderia o histórico.
   */
  codexHomeDir(): string {
    const base = this.codexBaseDir();
    const slug = codexAgentSlug(this.input.agentId);
    const dir = codexAgentHomePath(base, this.input.agentId);
    const existedBeforeThisCall = existsSync(dir);
    const legacy = path.join(base, "agents", slug);
    let legacyNameExisted = false;
    try { lstatSync(legacy); legacyNameExisted = true; } catch {}
    migrarCodexAgentHome(base, slug);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch {}
    // Also upgrades homes migrated by an older daemon, where the quarantine
    // still lived inside the home. Relocate it before making the old path
    // visible to Codex again.
    const quarantineReady = moveNestedCodexAgentHomes(base, slug, dir)
      && moveExistingCodexQuarantines(base, slug, dir);
    const compatMarker = path.join(dir, CODEX_RESUME_COMPAT_MARKER);
    if (quarantineReady && !existsSync(compatMarker)) {
      // Homes created after this fix use the new canonical path in Codex's
      // state DB and need no legacy alias (which would add a role-scan warning).
      // Existing homes and homes moved from agents/ do need their old absolute
      // path kept alive for persisted rollout paths.
      const aliasReady = !(existedBeforeThisCall || legacyNameExisted) || ensureLegacyCodexHomeAlias(base, slug, dir);
      if (aliasReady) {
        try { writeFileSync(compatMarker, "1\n", { mode: 0o600 }); } catch {}
      }
    }
    const link = (name: string, ensureDir = false) => {
      const target = path.join(base, name);
      const at = path.join(dir, name);
      try {
        if (existsSync(at)) return;
        if (ensureDir && !existsSync(target)) mkdirSync(target, { recursive: true });
        if (existsSync(target)) symlinkSync(target, at);
      } catch { /* base ausente/race — segue sem o link */ }
    };
    link("auth.json");
    link("sessions", true);
    return dir;
  }

  /** T-1018: config.toml do dono (base) — fonte das chaves de modelo que o
   *  writeCodexConfig espelha no config.toml por agente. */
  codexBaseConfigPath(): string {
    return path.join(this.codexBaseDir(), "config.toml");
  }

  crushDataDir(): string {
    const root = path.join(this.input.workspaceRoot, ".crush");
    // encodeURIComponent não codifica pontos; fazê-lo evita os segmentos
    // especiais "." e ".." sem mudar IDs UUID já persistidos.
    const agentSegment = encodeURIComponent(this.input.agentId).replace(/\./g, "%2E");
    const dir = path.join(root, "agents", agentSegment);
    mkdirSync(dir, { recursive: true });
    const gitignore = path.join(root, ".gitignore");
    try { if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n", { mode: 0o644 }); } catch {}
    return dir;
  }

  /**
   * Grava anexos em arquivo temporário.
   *
   * `nameFor` decide o nome final: para imagem colada segue `img-<nonce>-<i>`,
   * mas arquivo anexado preserva o nome original (sanitizado) — é o que o
   * agente vê no prompt, e `anexo-3.bin` não diz nada sobre o conteúdo.
   *
   * `written` carrega o índice do anexo de origem: `paths` pula os que
   * falharam, então casar `paths[i]` com `images[i]` desloca os nomes a
   * partir da primeira falha.
   */
  writeImages(
    images: RuntimeImage[],
    extensionFor: (mimeType: string) => string,
    nameFor?: (image: RuntimeImage, index: number, nonce: string) => string,
  ) {
    const paths: string[] = [];
    const written: Array<{ index: number; path: string }> = [];
    const errors: Error[] = [];
    const nonce = `${Date.now()}-${process.pid}-${this.imageSequence++}`;
    images.forEach((image, index) => {
      const nome = nameFor
        ? nameFor(image, index, nonce)
        : `img-${nonce}-${index}.${extensionFor(image.mimeType)}`;
      const filePath = path.join(this.tempDir(), nome);
      try {
        writeFileSync(filePath, Buffer.from(image.base64, "base64"), { mode: 0o600 });
        paths.push(filePath);
        written.push({ index, path: filePath });
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      paths,
      written,
      errors,
      cleanup: () => {
        for (const filePath of paths) {
          try { rmSync(filePath, { force: true }); } catch {}
        }
      },
    };
  }

  cleanup(): void {
    if (!this.tempPath) return;
    try { rmSync(this.tempPath, { recursive: true, force: true }); } catch {}
    this.tempPath = undefined;
  }
}
