/**
 * T-092: agent:error cifra com AAD messages.content (paridade agent:text).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { randomBytes, publicEncrypt, createPublicKey, constants } from "node:crypto";
import { aadV2, E2EE_TABLE } from "@the-dudes/protocol/e2ee-fields";

process.env.THE_DUDES_DAEMON_KEY_PATH = path.join(os.tmpdir(), `td-err-key-${process.pid}-${Date.now()}.pem`);
process.env.THE_DUDES_PROJECT_KEYS_PATH = path.join(os.tmpdir(), `td-err-pkeys-${process.pid}-${Date.now()}.json`);

const { getDaemonPublicKey, rememberProjectKey, decryptForProject, setE2eeRequired } = await import("../daemon-crypto.js");
const { agentErrorKind, sealAgentErrorMessage } = await import("../agent-host.js");

const PID = "proj-t092-err";
{
  const aes = randomBytes(32);
  const pub = createPublicKey({ key: Buffer.from(getDaemonPublicKey(), "base64"), format: "der", type: "spki" });
  const wrapped = publicEncrypt({ key: pub, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, aes);
  rememberProjectKey(PID, wrapped.toString("base64"));
}

test("T-092 stderr com chave → e2e:v2 messages.content (abre com o mesmo AAD de agent:text)", () => {
  const sealed = sealAgentErrorMessage(PID, "rate limit 429 no provider");
  assert.ok(sealed && sealed.startsWith("e2e:v2:"), sealed);
  const aad = aadV2({ projectId: PID, table: E2EE_TABLE.MESSAGES, field: "content" });
  assert.equal(decryptForProject(sealed, PID, aad), "rate limit 429 no provider");
});

test("T-092 e2ee-required sem chave → DROP (null)", () => {
  setE2eeRequired("proj-sem-chave", true);
  try {
    assert.equal(sealAgentErrorMessage("proj-sem-chave", "stderr claro"), null);
  } finally {
    setE2eeRequired("proj-sem-chave", false);
  }
});

test("T-092 sem projectId → plaintext (legado)", () => {
  assert.equal(sealAgentErrorMessage(undefined, "boom"), "boom");
});

test("T-092 errorKind classifica no plaintext: rate_limit vs other", () => {
  assert.equal(agentErrorKind("rate limit 429 no provider"), "rate_limit");
  assert.equal(agentErrorKind("temporarily limiting requests"), "rate_limit");
  assert.equal(agentErrorKind("ENOENT /secret/token"), "other");
});
