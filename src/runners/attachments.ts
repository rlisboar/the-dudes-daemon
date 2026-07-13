import type { ImageAttachment } from "../types.js";

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

export function imageDataUrl(image: ImageAttachment): string {
  return `data:${normalizeImageMime(image.mimeType)};base64,${image.base64}`;
}

export function buildOpenCodeParts(content: string, images?: ImageAttachment[]): Array<Record<string, unknown>> {
  return [
    { type: "text", text: content },
    ...(images ?? []).map((image) => ({
      type: "file", mime: normalizeImageMime(image.mimeType), url: imageDataUrl(image),
    })),
  ];
}

export function buildClaudeUserContent(content: string, images?: ImageAttachment[]): string | Array<Record<string, unknown>> {
  if (!images?.length) return content;
  return [
    ...(content ? [{ type: "text", text: content }] : []),
    ...images.map((image) => ({
      type: "image",
      source: { type: "base64", media_type: normalizeImageMime(image.mimeType), data: image.base64 },
    })),
  ];
}

export function codexImageArgs(paths: string[]): string[] {
  return paths.flatMap((filePath) => ["-i", filePath]);
}

export function appendFileImagePrompt(
  content: string,
  paths: string[],
  runner: "gemini" | "grok" | "crush",
): string {
  if (!paths.length) return content;
  if (runner === "gemini") return `${content}\n\n${paths.map((filePath) => `@${filePath}`).join(" ")}`;
  const viewer = runner === "grok" ? "reader" : "viewer";
  return `${content}\n\nAttached image file(s) — open with your file ${viewer} tool:\n${paths.join("\n")}`;
}
