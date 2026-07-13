import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileImagePrompt, buildClaudeUserContent, buildOpenCodeParts,
  codexImageArgs, imageDataUrl, imageExtension, normalizeImageMime,
} from "../runners/attachments.js";

const jpeg = { mimeType: " IMAGE/JPG ", base64: "aW1hZ2U=" };

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
  assert.deepEqual(codexImageArgs(["/a.png", "/b.jpg"]), ["-i", "/a.png", "-i", "/b.jpg"]);
  assert.equal(appendFileImagePrompt("see", ["/a.png"], "gemini"), "see\n\n@/a.png");
  assert.match(appendFileImagePrompt("see", ["/a.png"], "grok"), /file reader tool:\n\/a\.png$/);
  assert.match(appendFileImagePrompt("see", ["/a.png"], "crush"), /file viewer tool:\n\/a\.png$/);
});
