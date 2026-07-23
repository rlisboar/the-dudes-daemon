import test from "node:test";
import assert from "node:assert/strict";
import { mergeCliConfig, resolveCliCommands } from "../cli-config.js";

test("disabledRunners makes an installed CLI unavailable", () => {
  const resolved = resolveCliCommands({ cliPaths: { gemini: "/bin/sh" }, disabledRunners: ["gemini"] });
  assert.equal(resolved.gemini.available, false);
  assert.equal(resolved.gemini.resolvedPath, "/bin/sh");
});

test("runtime disabled runner override wins over file policy", () => {
  const merged = mergeCliConfig({ disabledRunners: ["gemini"] }, { disabledRunners: ["grok"] });
  assert.deepEqual(merged.disabledRunners, ["grok"]);
});
