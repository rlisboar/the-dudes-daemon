import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { BridgeRelay } from "../bridge-relay.js";

/**
 * #592: o estado do peer-pid precisa ser OBSERVÁVEL de fora do log.
 *
 * O que estes testes fixam:
 *  - `pending` enquanto o start não decidiu (nunca `false` por omissão);
 *  - os três desfechos distintos, com `downgrade-insecure` e `fail-closed`
 *    separados — "não-enforced" tem duas causas OPOSTAS e confundi-las faz o
 *    dono ler opt-out onde há quebra (ou o contrário);
 *  - o estado é derivado da DECISÃO: mexer no env depois do start não muda o
 *    que o relay está de fato aplicando.
 */

const ENV = "THE_DUDES_PEER_PID_INSECURE";

afterEach(() => {
  delete process.env[ENV];
});

function relay(selfTest: () => Promise<boolean>): BridgeRelay {
  return new BridgeRelay("http://127.0.0.1:9", null, undefined, { peerPidSelfTest: selfTest });
}

test("#592: antes do start o estado e pending, com enforced=null (nao false)", () => {
  const r = relay(async () => true);
  assert.deepEqual(r.peerPidState(), { enforced: null, mode: "pending" });
});

test("#592: self-test ok sem env => enforced", async () => {
  const r = relay(async () => true);
  await r.start();
  try {
    assert.deepEqual(r.peerPidState(), { enforced: true, mode: "enforced" });
  } finally {
    r.stop();
  }
});

test("#592: env=1 => downgrade-insecure (ACEITA nao verificavel), mesmo com self-test ok", async () => {
  process.env[ENV] = "1";
  const r = relay(async () => true);
  await r.start();
  try {
    assert.deepEqual(r.peerPidState(), { enforced: false, mode: "downgrade-insecure" });
  } finally {
    r.stop();
  }
});

test("#592: env=1 com self-test falho => ainda downgrade-insecure (nao fail-closed)", async () => {
  process.env[ENV] = "1";
  const r = relay(async () => false);
  await r.start();
  try {
    assert.deepEqual(r.peerPidState(), { enforced: false, mode: "downgrade-insecure" });
  } finally {
    r.stop();
  }
});

test("#592: self-test falho sem env => fail-closed (RECUSA nao verificavel)", async () => {
  const r = relay(async () => false);
  await r.start();
  try {
    assert.deepEqual(r.peerPidState(), { enforced: false, mode: "fail-closed" });
  } finally {
    r.stop();
  }
});

test("#592: self-test que ESTOURA tambem decide (nao fica pending para sempre)", async () => {
  const r = relay(async () => {
    throw new Error("boom");
  });
  await r.start();
  try {
    assert.deepEqual(r.peerPidState(), { enforced: false, mode: "fail-closed" });
  } finally {
    r.stop();
  }
});

test("#592: o estado segue a DECISAO — env mexido depois do start nao o altera", async () => {
  const r = relay(async () => true);
  await r.start();
  try {
    assert.equal(r.peerPidState().mode, "enforced");
    // Setar o env depois do start não re-decide (o env é lido uma vez, no
    // self-test): quem muda daemon.env precisa de restart, e o observador tem
    // de ver o que está APLICADO, não o que está escrito no arquivo.
    process.env[ENV] = "1";
    assert.deepEqual(r.peerPidState(), { enforced: true, mode: "enforced" });
  } finally {
    r.stop();
  }
});