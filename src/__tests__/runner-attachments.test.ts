import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFilePrompt, appendPathAttachmentPrompt, attachmentExtension, buildClaudeUserContent,
  buildOpenCodeParts, codexImageArgs, imageDataUrl, imageExtension, isInlineImage,
  normalizeImageMime, safeAttachmentName,
} from "../runners/attachments.js";

const jpeg = { mimeType: " IMAGE/JPG ", base64: "aW1hZ2U=" };
const pdf = { mimeType: "application/pdf", base64: "cGRm", name: "nota fiscal.pdf" };
const svg = { mimeType: "image/svg+xml", base64: "PHN2Zy8+" };

test("image MIME normalization handles aliases and rejects non-image metadata", () => {
  assert.equal(normalizeImageMime(" IMAGE/JPG "), "image/jpeg");
  assert.equal(imageExtension("image/jpeg"), "jpg");
  assert.equal(normalizeImageMime("text/html\r\nX-Bad: yes"), "application/octet-stream");
  assert.equal(imageExtension("text/plain"), "bin");
  assert.equal(imageDataUrl(jpeg), "data:image/jpeg;base64,aW1hZ2U=");
});

test("OpenCode and Claude multimodal payloads share normalized MIME", () => {
  assert.deepEqual(buildOpenCodeParts("look", [jpeg]), [
    { type: "text", text: "look" },
    { type: "file", mime: "image/jpeg", url: "data:image/jpeg;base64,aW1hZ2U=" },
  ]);
  assert.deepEqual(buildClaudeUserContent("", [jpeg]), [{
    type: "image", source: { type: "base64", media_type: "image/jpeg", data: "aW1hZ2U=" },
  }]);
  assert.equal(buildClaudeUserContent("plain"), "plain");
});

test("file-based runners receive their native path representation", () => {
  const files = [{ path: "/a.png", name: "a.png" }];
  assert.deepEqual(codexImageArgs(["/a.png", "/b.jpg"]), ["-i", "/a.png", "-i", "/b.jpg"]);
  assert.equal(appendPathAttachmentPrompt("see", files, "gemini"), "see\n\n@/a.png");
  assert.match(appendPathAttachmentPrompt("see", files, "grok"), /file reader tool:\n- a\.png: \/a\.png$/);
  assert.match(appendPathAttachmentPrompt("see", files, "crush"), /file viewer tool:\n- a\.png: \/a\.png$/);
  assert.equal(appendPathAttachmentPrompt("see", [], "gemini"), "see");
});

test("only raster images the model accepts go inline; svg and files go to disk", () => {
  assert.equal(isInlineImage(jpeg), true);
  // svg/bmp são imagem, mas a API do claude recusa — vão por arquivo.
  assert.equal(isInlineImage(svg), false);
  assert.equal(isInlineImage(pdf), false);
  assert.equal(attachmentExtension(svg), "svg");
  assert.equal(attachmentExtension(pdf), "pdf");
  assert.equal(attachmentExtension({ mimeType: "application/octet-stream" }), "bin");
  assert.deepEqual(buildOpenCodeParts("look", [jpeg, pdf, svg]), [
    { type: "text", text: "look" },
    { type: "file", mime: "image/jpeg", url: "data:image/jpeg;base64,aW1hZ2U=" },
  ]);
  assert.equal(buildClaudeUserContent("look", [pdf, svg]), "look");
});

test("temp file names stay shell/prompt safe and keep a usable extension", () => {
  // Espaço quebraria o `@<path>` do gemini; separador de path é escapada.
  assert.equal(safeAttachmentName("nota fiscal.pdf", "x"), "nota_fiscal.pdf");
  assert.equal(safeAttachmentName("../../etc/passwd", "x"), "etc_passwd");
  assert.equal(safeAttachmentName("...", "fallback.bin"), "fallback.bin");
  assert.equal(safeAttachmentName(undefined, "fallback.bin"), "fallback.bin");
});

test("non-image attachments are announced by path in the prompt", () => {
  const out = appendFilePrompt("veja", [{ path: "/tmp/nota_fiscal.pdf", name: "nota fiscal.pdf" }]);
  assert.match(out, /Attached file\(s\)[^\n]*\n- nota fiscal\.pdf: \/tmp\/nota_fiscal\.pdf$/);
  assert.equal(appendFilePrompt("veja", []), "veja");
});
