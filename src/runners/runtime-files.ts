import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
