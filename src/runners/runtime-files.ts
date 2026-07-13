import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RuntimeImage {
  base64: string;
  mimeType: string;
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

  geminiConfigDir(): string {
    const dir = path.join(this.tempDir(), ".gemini");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch {}
    return dir;
  }

  openCodeConfigPath(): string {
    return path.join(this.tempDir(), "opencode.json");
  }

  grokHome(): string {
    return path.join(this.input.home ?? os.homedir(), ".grok");
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

  writeImages(images: RuntimeImage[], extensionFor: (mimeType: string) => string) {
    const paths: string[] = [];
    const errors: Error[] = [];
    const nonce = `${Date.now()}-${process.pid}-${this.imageSequence++}`;
    images.forEach((image, index) => {
      const filePath = path.join(this.tempDir(), `img-${nonce}-${index}.${extensionFor(image.mimeType)}`);
      try {
        writeFileSync(filePath, Buffer.from(image.base64, "base64"), { mode: 0o600 });
        paths.push(filePath);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      paths,
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
