/**
 * @the-dudes/test-utils — diretório temporário de teste que não confia no
 * `TMPDIR` do ambiente.
 *
 * Promovido do `server/src/__tests__/tmp.ts` (T-867/T-873/T-908) porque agora são
 * três consumidores: server (6 arquivos), daemon (~91 candidatos) e web (1).
 *
 * No ambiente dos agentes o `TMPDIR` chega VAZIO e o `os.tmpdir()` cai no temp do
 * confstr do macOS (/var/folders/...), que o sandbox nega. Pior: quando o TMPDIR
 * EXISTE mas aponta para um diretório negado (ou inexistente), o `os.tmpdir()`
 * devolve ele e `mkdtemp`/`open` estouram com EPERM — o pedaço da suíte que grava
 * chaves e artefatos em tmp morre junto, sem relação com o código sob teste.
 *
 * Aqui o diretório base é escolhido por TENTATIVA REAL (TMPDIR → /tmp → cwd), uma
 * vez por processo; o `mkdtemp` é a prova, não a variável.
 *
 * LIMITE DE HARNESS (medido, e é por isso que os testes que forçam um TMPDIR sem
 * escrita pré-criam `<TMPDIR>/tsx-<uid>`): o `tsx` cria esse cache no IMPORT,
 * antes de qualquer helper rodar. Num TMPDIR que não aceita `mkdir`, quem morre
 * primeiro é o loader do tsx (`EPERM mkdir '<TMPDIR>/tsx-501'`), não o helper — o
 * que este arquivo resolve é o caso real (TMPDIR existe, o `mkdtemp` é que é
 * negado) e o caso de fallback; TMPDIR impossível de criar na raiz é do runner.
 *
 * LIMPEZA: no `exit` e também em SIGTERM/SIGINT (o `exit` não roda neles). O que
 * sobra é SIGKILL, que não roda hook nenhum: aí fica o diretório, vazio se
 * ninguém escreveu (git nem lista diretório vazio).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cached = null;
let avisou = false;
let limpezaRegistrada = false;

/**
 * T-873 (review): o diretório criado é removido no fim do processo. Sem isso,
 * um fallback para `cwd` deixaria `td-test-XXXX` não rastreado dentro da
 * worktree (a raiz acabou de ser limpa) e cada execução sujaria mais um. O hook
 * roda no `exit` — inclusive sob `--test-force-exit` (medido) — e cobre também
 * os subdiretórios de `tmpDir()`. SIGKILL não roda hook: aí sobra o diretório,
 * que é vazio quando ninguém escreveu (git nem lista diretório vazio).
 */
function apagarCached() {
  if (!cached) return;
  try { rmSync(cached, { recursive: true, force: true }); } catch { /* melhor esforço */ }
}

function registrarLimpeza() {
  if (limpezaRegistrada) return;
  limpezaRegistrada = true;
  process.once("exit", apagarCached);
  // T-908/F2: `exit` NÃO roda em SIGTERM/SIGINT sem handler — era o resíduo de
  // `td-test-*` nos runs interrompidos (o script tem trap de bash; o helper não).
  process.once("SIGTERM", () => { apagarCached(); process.exit(143); });
  process.once("SIGINT", () => { apagarCached(); process.exit(130); });
}

/** Candidatos, na ordem. Exportado para o teste do próprio helper. */
export function tmpCandidates() {
  return [process.env.TMPDIR ?? "", "/tmp", process.cwd()];
}

/**
 * Diretório base gravável do processo de teste. Lança (com a lista do que foi
 * tentado) quando nenhum candidato aceita `mkdtemp`.
 */
export function tmpRoot() {
  if (cached) return cached;
  const tentados = [];
  // T-908/F1: `primeiro` é o TMPDIR DE FACTO (pode ser vazio). Antes, TMPDIR
  // vazio fazia a mensagem chamar /tmp de "TMPDIR do ambiente".
  const doAmbiente = process.env.TMPDIR ?? "";
  for (const d of tmpCandidates()) {
    if (!d) continue;
    try {
      // candidato que não existe ainda é CRIADO (antes isso dependia do loader
      // do tsx, que faz mkdir recursivo no import — o consumidor node-puro
      // merecia o mesmo comportamento); falhou em criar (ex.: / sem permissão)
      // → cai para o próximo candidato.
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
      const dir = mkdtempSync(join(d, "td-test-"));
      cached = dir;
      registrarLimpeza();
      // Fallback explícito, com o nome certo de quem foi recusado.
      if (!avisou && d !== (doAmbiente || "/tmp")) {
        avisou = true;
        const recusado = doAmbiente || "/tmp";
        const porque = tentados.find((t) => t.dir === recusado)?.motivo ?? "candidato anterior falhou";
        console.warn(
          doAmbiente
            ? `[tmp] TMPDIR do ambiente (${recusado}) recusado — usando ${d}. Motivo: ${porque}`
            : `[tmp] sem TMPDIR no ambiente e /tmp recusado — usando ${d}. Motivo: ${porque}`,
        );
      }
      return dir;
    } catch (e) {
      tentados.push({ dir: d, motivo: e.message.split("\n")[0] ?? "erro" });
    }
  }
  throw new Error(
    `[tmp] nenhum diretório temporário gravável. Tentados: ${tentados.map((t) => `${t.dir} (${t.motivo})`).join("; ")}`,
  );
}

/** Subdiretório novo dentro do tmpRoot. */
export function tmpDir(prefix) {
  return mkdtempSync(join(tmpRoot(), prefix));
}

/** Caminho de arquivo dentro do tmpRoot (para env vars de caminho). */
export function tmpFile(name) {
  return join(tmpRoot(), name);
}

/** Só para teste: o `os.tmpdir()` cru do ambiente (o que este helper substitui). */
export function tmpdirCru() {
  return tmpdir();
}