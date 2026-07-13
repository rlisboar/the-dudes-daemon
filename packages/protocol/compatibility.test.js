import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const serverTypes = readFileSync(resolve(root, "server/src/types.ts"), "utf8");
const webTypes = readFileSync(resolve(root, "web/src/protocol.ts"), "utf8");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(from, -1, `missing section ${start}`);
  if (end) assert.notEqual(to, -1, `missing section terminator ${end}`);
  return source.slice(from, to);
}

function discriminators(source) {
  return [...source.matchAll(/type:\s*"([^"]+)"/g)].map((match) => match[1]).sort();
}

test("web and server expose exactly the same ClientCommand discriminators", () => {
  const server = discriminators(section(serverTypes, "export type ClientCommand"));
  const web = discriminators(section(webTypes, "export type ClientCommand"));
  assert.equal(server.length, 154, "intentional command additions must update this contract count");
  assert.deepEqual(web, server);
});

test("web and server expose exactly the same ServerEvent discriminators", () => {
  const server = discriminators(section(serverTypes, "export type ServerEvent", "export type ClientCommand"));
  const web = discriminators(section(webTypes, "export type ServerEvent", "export type ClientCommand"));
  assert.equal(server.length, 111, "intentional event additions must update this contract count");
  assert.deepEqual(web, server);
});

test("server and web consume canonical primitive types from the protocol package", () => {
  for (const source of [serverTypes, webTypes]) {
    assert.match(source, /from "@the-dudes\/protocol"/);
    assert.doesNotMatch(source, /export type CliRunner\s*=/);
    assert.doesNotMatch(source, /export type EffortLevel\s*=/);
    assert.doesNotMatch(source, /export type AgentRuntimeState\s*=/);
  }
});
