/**
 * T-594 — o daemon interpola `{{mem.NAME}}` no `agent:send`.
 *
 * O campo `mem` (opcional) é o mapa da mission scratch. Existe porque o
 * placeholder pode morar DENTRO de um blob cifrado: o server, sem a chave, não
 * o vê, e o único lado que tem o plaintext é este. A interpolação usa a MESMA
 * função do server (`@the-dudes/protocol/mission-memory`), senão o caminho em
 * claro e o cifrado passam a resolver diferente.
 *
 * Cripto real (daemon-crypto) + a montagem real de parts, como no ramo
 * `agent:send` do main.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, publicEncrypt, createPublicKey, constants } from "node:crypto";
import { aadV2, E2EE_TABLE, agentSendCipherPart } from "@the-dudes/protocol/e2ee-fields";
import { interpolateMissionMemory } from "@the-dudes/protocol/mission-memory";
import type { AgentSendPart } from "@the-dudes/protocol/daemon-wire";
import { assembleAgentSendParts } from "../protocol.js";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-t594d-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-t594d-pkeys-${process.pid}-${Date.now()}.json`);

const {
  getDaemonPublicKey, rememberProjectKey, encryptForProject, decryptForProject, isE2eEncrypted,
} = await import("../daemon-crypto.js");

const PID = "proj-t594-daemon";
{
  const aes = randomBytes(32);
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrapped = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, aes);
  assert.equal(rememberProjectKey(PID, wrapped.toString("base64")), true);
}

const PROMPT = "Passo 2: consuma a saída anterior em {{mem.RESULTADO}} e feche.";
const SENTINEL = "\n\n---\nSe entregou, repita <<<STEP_COMPLETE>>>";
const MEMORY = { RESULTADO: "relatorio final do passo 1" };

type Frame = { content: string; parts?: AgentSendPart[]; mem?: Record<string, string> };

/** Réplica do ramo `agent:send` do main.ts (parts mandam; `mem` interpola depois). */
function receive(frame: Frame): { ok: true; content: string } | { ok: false; reason: string } {
  let content: string;
  if (frame.parts && frame.parts.length > 0) {
    const assembled = assembleAgentSendParts(frame.parts, PID, decryptForProject, isE2eEncrypted);
    if (!assembled.ok) return { ok: false, reason: assembled.reason };
    content = assembled.content;
  } else {
    content = frame.content;
    if (isE2eEncrypted(content)) {
      const dec = decryptForProject(content, PID, aadV2({ projectId: PID, table: E2EE_TABLE.MESSAGES, field: "content" }));
      if (dec === null) return { ok: false, reason: "dropMissingKey" };
      content = dec;
    }
  }
  if (frame.mem) content = interpolateMissionMemory(content, frame.mem);
  return { ok: true, content };
}

function stepFrame(mem?: Record<string, string>): Frame {
  const blob = encryptForProject(PROMPT, PID, aadV2({ projectId: PID, table: E2EE_TABLE.MISSION_STEPS, field: "prompt" }))!;
  return {
    content: blob,
    parts: [agentSendCipherPart(blob, E2EE_TABLE.MISSION_STEPS, "prompt"), { kind: "plain", text: SENTINEL }],
    mem,
  };
}

test("T-594: frame com parts + mem entrega o placeholder RESOLVIDO", () => {
  const got = receive(stepFrame(MEMORY));
  assert.equal(got.ok, true, got.ok ? "" : got.reason);
  assert.equal(got.ok && got.content, interpolateMissionMemory(PROMPT, MEMORY) + SENTINEL);
  assert.ok(got.ok && !got.content.includes("{{mem."));
});

test("T-594: sem `mem` (server antigo) o placeholder segue literal — comportamento de hoje", () => {
  const got = receive(stepFrame(undefined));
  assert.equal(got.ok, true);
  assert.ok(got.ok && got.content.includes("{{mem.RESULTADO}}"));
});

test("T-594: mem vazio resolve chave não gravada para vazio", () => {
  const got = receive(stepFrame({}));
  assert.equal(got.ok, true);
  assert.ok(got.ok && got.content.startsWith("Passo 2: consuma a saída anterior em  e feche."));
});

test("T-594: mem sem parts também interpola (o daemon não exige parts pra agir)", () => {
  const got = receive({ content: PROMPT, mem: MEMORY });
  assert.equal(got.ok, true);
  assert.equal(got.ok && got.content, interpolateMissionMemory(PROMPT, MEMORY));
});

test("T-594 wiring: o ramo agent:send do main.ts usa a função COMPARTILHADA", () => {
  const src = readFileSync(fileURLToPath(new URL("../main.ts", import.meta.url)), "utf8");
  const i = src.indexOf('case "agent:send":');
  assert.notEqual(i, -1, "case agent:send sumiu do main.ts");
  const bloco = src.slice(i, src.indexOf('case "task:updated":', i));
  assert.match(
    src,
    /import\s*\{[^}]*interpolateMissionMemory[^}]*\}\s*from\s*"@the-dudes\/protocol\/mission-memory"/,
    "main.ts precisa importar a função compartilhada (não uma cópia local)",
  );
  assert.match(bloco, /content = interpolateMissionMemory\(content, msg\.mem\)/, "o conteúdo montado tem de ser interpolado");
});