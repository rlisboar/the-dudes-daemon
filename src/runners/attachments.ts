import type { CliRunner, ImageAttachment } from "../types.js";
import { isGrokFamily } from "./index.js";

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
  "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg",
};

export function normalizeImageMime(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  return Object.hasOwn(IMAGE_EXTENSIONS, normalized) ? normalized : "application/octet-stream";
}

export function imageExtension(mimeType: string): string {
  return IMAGE_EXTENSIONS[normalizeImageMime(mimeType)] ?? "bin";
}

/**
 * Mimes que o modelo aceita INLINE (visão).
 *
 * Subconjunto estrito de IMAGE_EXTENSIONS: `image/svg+xml` e `image/bmp` são
 * imagem pra gravar em disco, mas a API do claude só aceita png/jpeg/gif/webp
 * — mandar svg como `type: "image"` volta 400 e o turno morre. Desde que o
 * composer aceita qualquer arquivo, esses dois chegam de verdade.
 */
const INLINE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Vai inline pro modelo? O resto (inclusive svg/bmp) vira arquivo em disco. */
export function isInlineImage(a: { mimeType: string }): boolean {
  return INLINE_IMAGE_MIMES.has(normalizeImageMime(a.mimeType ?? ""));
}

/** Extensão do anexo: usa o nome original quando não é imagem conhecida. */
export function attachmentExtension(a: { mimeType: string; name?: string }): string {
  const conhecida = IMAGE_EXTENSIONS[normalizeImageMime(a.mimeType ?? "")];
  if (conhecida) return conhecida;
  const ext = (a.name ?? "").split(".").pop();
  return ext && /^[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : "bin";
}

/**
 * Nome seguro pro arquivo temporário — o nome vem do cliente.
 *
 * Espaço também cai fora: o path entra cru no prompt (gemini referencia com
 * `@<path>`), e `@/tmp/nota fiscal.pdf` quebra no espaço.
 */
export function safeAttachmentName(name: string | undefined, fallback: string): string {
  const base = (name ?? "").replace(/[^\w.\-]+/g, "_").replace(/^[._]+/, "");
  return base ? base.slice(0, 80) : fallback;
}

/** Trecho de prompt listando arquivos NÃO-imagem anexados. */
export function appendFilePrompt(content: string, files: Array<{ path: string; name: string }>): string {
  if (!files.length) return content;
  const lista = files.map((f) => `- ${f.name}: ${f.path}`).join("\n");
  return `${content}\n\nAttached file(s) — read them with your file tool:\n${lista}`;
}

export function imageDataUrl(image: ImageAttachment): string {
  return `data:${normalizeImageMime(image.mimeType)};base64,${image.base64}`;
}

export function buildOpenCodeParts(content: string, images?: ImageAttachment[]): Array<Record<string, unknown>> {
  // Só imagem entra inline; arquivo comum vai por caminho no prompt.
  return [
    { type: "text", text: content },
    ...(images ?? []).filter(isInlineImage).map((image) => ({
      type: "file", mime: normalizeImageMime(image.mimeType), url: imageDataUrl(image),
    })),
  ];
}

export function buildClaudeUserContent(content: string, images?: ImageAttachment[]): string | Array<Record<string, unknown>> {
  // Mandar não-imagem como `type: "image"` faz o runner recusar a mensagem.
  const inline = (images ?? []).filter(isInlineImage);
  if (!inline.length) return content;
  return [
    ...(content ? [{ type: "text", text: content }] : []),
    ...inline.map((image) => ({
      type: "image",
      source: { type: "base64", media_type: normalizeImageMime(image.mimeType), data: image.base64 },
    })),
  ];
}

export function codexImageArgs(paths: string[]): string[] {
  return paths.flatMap((filePath) => ["-i", filePath]);
}

/**
 * Trecho de prompt pros runners que recebem anexo por CAMINHO (gemini, grok,
 * crush). Vale pra qualquer tipo — não só imagem: o composer aceita qualquer
 * arquivo, e dizer "image file(s)" fazia o modelo ignorar o PDF anexado.
 */
export function appendPathAttachmentPrompt(
  content: string,
  files: Array<{ path: string; name: string }>,
  runner: CliRunner,
): string {
  if (!files.length) return content;
  if (runner === "gemini" || runner === "qwen") return `${content}\n\n${files.map((f) => `@${f.path}`).join(" ")}`;
  const viewer = isGrokFamily(runner) ? "reader" : "viewer";
  const lista = files.map((f) => `- ${f.name}: ${f.path}`).join("\n");
  return `${content}\n\nAttached file(s) — open with your file ${viewer} tool:\n${lista}`;
}
