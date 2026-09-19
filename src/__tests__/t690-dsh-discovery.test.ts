/**
 * T-690: discovery do catálogo do dsh via ACP — parser das configOptions e
 * caminho end-to-end contra o fake do servidor.
 */
import "./scratch-home.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDshConfigOptions, discoverDsh } from "../model-discovery.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-server.mjs", import.meta.url));

const OPTS = [
  {
    id: "model",
    currentValue: '["dsflash","deepseek-flash-41"]',
    options: [
      {
        group: "deepseek-official", name: "DeepSeek",
        options: [
          { value: '["deepseek-official","deepseek-v4-flash"]', name: "DeepSeek-V4-Flash", description: "Fast" },
          { value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro" },
        ],
      },
      {
        group: "dsflash", name: "DeepSeek Flash 4.1 (dsflash)",
        options: [{ value: '["dsflash","deepseek-flash-41"]', name: "DeepSeek Flash 4.1 (SGLang · 1M)" }],
      },
    ],
  },
  {
    id: "reasoning_effort",
    options: [{ value: "off" }, { value: "low" }, { value: "high" }, { value: "max" }],
  },
];

test("T-690 discovery: parseDshConfigOptions achata grupos, marca default e deriva efforts", () => {
  const models = parseDshConfigOptions(OPTS);
  assert.equal(models.length, 3, "3 modelos dos 2 grupos");
  const def = models.find((m) => m.isDefault);
  assert.equal(def?.id, '["dsflash","deepseek-flash-41"]', "currentValue marca o default");
  assert.equal(def?.label, "DeepSeek Flash 4.1 (SGLang · 1M)");
  assert.ok(models.every((m) => m.efforts?.join(",") === "none,low,high,max"), "efforts do reasoning_effort (off→none)");
  assert.equal(models[0]!.description, "Fast");
});

test("T-690 discovery: sem option de model → catálogo vazio (não inventa)", () => {
  assert.deepEqual(parseDshConfigOptions([]), []);
  assert.deepEqual(parseDshConfigOptions([{ id: "reasoning_effort", options: [] }]), []);
});

test("T-690 discovery: discoverDsh end-to-end contra o fake (initialize→session/new→close)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "t690disc-"));
  const prev = process.env.FAKE_ACP_LOG;
  process.env.FAKE_ACP_LOG = path.join(dir, "acp.jsonl");
  try {
    const models = await discoverDsh(FIXTURE, null);
    assert.ok(models.length >= 1, "catálogo veio do session/new");
    assert.equal(models.find((m) => m.isDefault)?.id, '["deepseek-official","deepseek-v4-flash"]');
  } finally {
    process.env.FAKE_ACP_LOG = prev;
  }
});