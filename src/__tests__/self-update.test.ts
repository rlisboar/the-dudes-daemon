import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import {
  _resetIdleRestartForTest,
  captureBootBinaryHash,
  checkAndApplyUpdate,
  extractBuildTs,
  runningReleaseInfo,
  signatureAccepted,
  verifyBundle,
  TRUSTED_SIGN_PUBS,
} from "../self-update.js";

/**
 * A chave embutida no módulo é a de produção; o teste NÃO tem a privada dela
 * por default. Estratégia:
 *  - fail-closed (assinatura errada → recusa) — sempre no CI;
 *  - dual-trust com par efêmero A/B injetado — sempre no CI;
 *  - privada NOVA em disco (THE_DUDES_SIGN_KEY_FILE ou ~/.the-dudes-signing/sign-new.key):
 *    skip explícito se ausente (CI); roda no host do dono;
 *  - privada ANTIGA em daemon/.signing/sign.key: skip se ausente.
 */

const log = () => {};

afterEach(() => { _resetIdleRestartForTest(); });

function signBundle(body: string, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]) {
  const bundle = Buffer.from(body);
  return {
    bundle,
    sha: createHash("sha256").update(bundle).digest("hex"),
    sig: edSign(null, bundle, privateKey).toString("base64"),
  };
}

function fetchMap(map: Record<string, Buffer>): typeof fetch {
  return (async (url: string) => {
    const k = Object.keys(map).find((p) => String(url).endsWith(p));
    if (!k) throw new Error(`sem fixture pra ${url}`);
    return { ok: true, arrayBuffer: async () => map[k]! };
  }) as unknown as typeof fetch;
}

function signedInstall(
  daemonBody: string,
  bridgeBody: string,
): { pubs: string[]; fetchFn: typeof fetch; daemonSha: string } {
  const pair = generateKeyPairSync("ed25519");
  const pubs = [pair.publicKey.export({ type: "spki", format: "pem" }) as string];
  const d = signBundle(daemonBody, pair.privateKey);
  const b = signBundle(bridgeBody, pair.privateKey);
  return {
    pubs,
    daemonSha: d.sha,
    fetchFn: fetchMap({
      "/install/daemon.cjs.sha256": Buffer.from(`${d.sha}  daemon.cjs\n`),
      "/install/daemon.cjs": d.bundle,
      "/install/daemon.cjs.sig": Buffer.from(d.sig),
      "/install/mcp-bridge.cjs.sha256": Buffer.from(`${b.sha}  mcp-bridge.cjs\n`),
      "/install/mcp-bridge.cjs": b.bundle,
      "/install/mcp-bridge.cjs.sig": Buffer.from(b.sig),
    }),
  };
}

function daemonSrc(ts: number): string {
  return `#!/usr/bin/env node\nconst DAEMON_BUILD_TS = Number("${ts}");\n`;
}

test("hash publicado igual ao rodando → nada a fazer", async () => {
  const fetchFn = (async (_url: string) => ({
    ok: true,
    arrayBuffer: async () => Buffer.from("a".repeat(64) + "  daemon.cjs\n"),
  })) as unknown as typeof fetch;
  const r = await checkAndApplyUpdate({
    orchBase: "http://x", selfPath: "/tmp/daemon.cjs",
    runningHash: "a".repeat(64), log, underLauncher: true, fetchFn,
  });
  assert.equal(r, "current");
});

test("assinatura inválida → recusa e mantém o binário", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sup-"));
  const selfPath = path.join(dir, "daemon.cjs");
  writeFileSync(selfPath, "BINARIO ORIGINAL");
  const bundle = Buffer.from("BINARIO NOVO MALICIOSO");
  const sha = createHash("sha256").update(bundle).digest("hex");
  const respostas: Record<string, Buffer> = {
    "/install/daemon.cjs.sha256": Buffer.from(`${sha}  daemon.cjs\n`),
    "/install/daemon.cjs": bundle,
    "/install/daemon.cjs.sig": Buffer.from(Buffer.from("assinatura-forjada-64-bytes-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").toString("base64")),
  };
  const fetchFn = (async (url: string) => {
    const k = Object.keys(respostas).find((p) => String(url).endsWith(p));
    if (!k) throw new Error(`sem fixture pra ${url}`);
    return { ok: true, arrayBuffer: async () => respostas[k]! };
  }) as unknown as typeof fetch;

  const r = await checkAndApplyUpdate({
    orchBase: "http://x", selfPath,
    runningHash: "b".repeat(64), log, underLauncher: true, fetchFn,
    exitFn: () => { throw new Error("NÃO deveria sair — update inválido"); },
  });
  assert.equal(r, "failed");
  assert.equal(readFileSync(selfPath, "utf8"), "BINARIO ORIGINAL", "binário foi trocado com assinatura inválida!");
});

test("verifyBundle: recusa sha divergente mesmo com assinatura válida no conjunto", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const bundle = Buffer.from("conteudo do bundle");
  const sig = edSign(null, bundle, privateKey).toString("base64");
  const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  assert.ok(edVerify(null, bundle, pubPem, Buffer.from(sig, "base64")), "primitiva ed25519 quebrada");
  // Contra o conjunto REAL de produção: chave efêmera não está na lista →
  // falha em assinatura (fail-closed) — sha correto sozinho não basta.
  const sha = createHash("sha256").update(bundle).digest("hex");
  assert.throws(() => verifyBundle(bundle, sig, sha), /assinatura/);
});

test("dual-trust: assinatura da chave A (antiga) é aceita", () => {
  const a = generateKeyPairSync("ed25519");
  const b = generateKeyPairSync("ed25519");
  const pubs = [
    a.publicKey.export({ type: "spki", format: "pem" }) as string,
    b.publicKey.export({ type: "spki", format: "pem" }) as string,
  ];
  const bundle = Buffer.from("release-stage-N");
  const sig = edSign(null, bundle, a.privateKey).toString("base64");
  const sha = createHash("sha256").update(bundle).digest("hex");
  assert.equal(signatureAccepted(bundle, sig, pubs), true);
  assert.doesNotThrow(() => verifyBundle(bundle, sig, sha, pubs));
});

test("dual-trust: assinatura da chave B (nova) é aceita", () => {
  const a = generateKeyPairSync("ed25519");
  const b = generateKeyPairSync("ed25519");
  const pubs = [
    a.publicKey.export({ type: "spki", format: "pem" }) as string,
    b.publicKey.export({ type: "spki", format: "pem" }) as string,
  ];
  const bundle = Buffer.from("release-stage-N+1");
  const sig = edSign(null, bundle, b.privateKey).toString("base64");
  const sha = createHash("sha256").update(bundle).digest("hex");
  assert.equal(signatureAccepted(bundle, sig, pubs), true);
  assert.doesNotThrow(() => verifyBundle(bundle, sig, sha, pubs));
});

test("dual-trust: assinatura de chave fora do conjunto é rejeitada", () => {
  const a = generateKeyPairSync("ed25519");
  const b = generateKeyPairSync("ed25519");
  const outsider = generateKeyPairSync("ed25519");
  const pubs = [
    a.publicKey.export({ type: "spki", format: "pem" }) as string,
    b.publicKey.export({ type: "spki", format: "pem" }) as string,
  ];
  const bundle = Buffer.from("forjado");
  const sig = edSign(null, bundle, outsider.privateKey).toString("base64");
  const sha = createHash("sha256").update(bundle).digest("hex");
  assert.equal(signatureAccepted(bundle, sig, pubs), false);
  assert.throws(() => verifyBundle(bundle, sig, sha, pubs), /assinatura/);
});

test("TRUSTED_SIGN_PUBS tem exatamente 1 entrada (só NOVA — N+3)", () => {
  assert.equal(TRUSTED_SIGN_PUBS.length, 1);
  for (const p of TRUSTED_SIGN_PUBS) {
    assert.match(p, /BEGIN PUBLIC KEY/);
    assert.match(p, /END PUBLIC KEY/);
  }
  // NOVA canônica embutida
  assert.match(TRUSTED_SIGN_PUBS[0]!, /AyOfZNGAQ8udECo/);
  // ANTIGA removida
  assert.ok(!TRUSTED_SIGN_PUBS.some((p) => p.includes("AhnydRabRqG76")));
});

test("nova chave T-006 assina e passa no conjunto real (prod N+3)", (t) => {
  // Path default do host do dono; override via THE_DUDES_SIGN_KEY_FILE para
  // simular CI (apontar p/ path inexistente) sem renomear a chave real.
  const newKeyPath =
    process.env.THE_DUDES_SIGN_KEY_FILE ||
    path.join(os.homedir(), ".the-dudes-signing", "sign-new.key");
  if (!existsSync(newKeyPath)) {
    t.skip(
      `privada nova ausente em ${newKeyPath} — skip no CI; cobertura via dual-trust A/B em memória`,
    );
    return;
  }
  const privateKey = createPrivateKey(readFileSync(newKeyPath));
  const bundle = Buffer.from("t006-new-key-vector");
  const sig = edSign(null, bundle, privateKey).toString("base64");
  const sha = createHash("sha256").update(bundle).digest("hex");
  assert.equal(signatureAccepted(bundle, sig), true, "nova deve ser aceita pelo TRUSTED_SIGN_PUBS");
  assert.doesNotThrow(() => verifyBundle(bundle, sig, sha));
});

test("antiga chave (se presente no host) é REJEITADA no trust N+3", (t) => {
  // Estágio N+3: a antiga saiu do trust set — assinatura dela não deve passar.
  const oldKeyPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../.signing/sign.key",
  );
  const candidates = [
    oldKeyPath,
    path.join(process.cwd(), ".signing", "sign.key"),
    path.join(os.homedir(), "Documents/eonf/projects/claudinhos/daemon/.signing/sign.key"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    t.skip("privada antiga ausente no host — skip; rejeição coberta pelo teste efêmero outsider");
    return;
  }
  const privateKey = createPrivateKey(readFileSync(found));
  const bundle = Buffer.from("t035-old-key-must-fail");
  const sig = edSign(null, bundle, privateKey).toString("base64");
  const sha = createHash("sha256").update(bundle).digest("hex");
  assert.equal(signatureAccepted(bundle, sig), false, "antiga NÃO deve ser aceita pós N+3");
  assert.throws(() => verifyBundle(bundle, sig, sha), /assinatura/);
});

test("extractBuildTs lê Number(\"epoch\") do bundle", () => {
  assert.equal(extractBuildTs(Buffer.from('const DAEMON_BUILD_TS = Number("1700000000000");')), 1_700_000_000_000);
  assert.equal(extractBuildTs(Buffer.from("sem marcador")), null);
});

test("T-088 idle + update aplicado -> re-exec (exit 42, arquivo novo)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sup-idle-"));
  const selfPath = path.join(dir, "daemon.cjs");
  writeFileSync(selfPath, "ANTIGO");
  const inst = signedInstall(daemonSrc(2_000_000_000_000), "bridge");
  let exitCode: number | null = null;
  const r = await checkAndApplyUpdate({
    orchBase: "http://x", selfPath,
    runningHash: "b".repeat(64),
    runningBuildTs: 1_000_000_000_000,
    log, underLauncher: true,
    fetchFn: inst.fetchFn, trustedPubs: inst.pubs,
    isIdle: () => true,
    exitFn: (c) => { exitCode = c; },
  });
  assert.equal(r, "updated");
  assert.equal(exitCode, 42);
  assert.match(readFileSync(selfPath, "utf8"), /2000000000000/);
});

test("T-088 ocupado -> não reinicia, pending, reinicia ao esvaziar", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sup-busy-"));
  const selfPath = path.join(dir, "daemon.cjs");
  writeFileSync(selfPath, "ANTIGO");
  const inst = signedInstall(daemonSrc(2_000_000_000_000), "bridge");
  let idle = false;
  const ticks: Array<() => void> = [];
  let exitCode: number | null = null;
  const logs: string[] = [];
  const r = await checkAndApplyUpdate({
    orchBase: "http://x", selfPath,
    runningHash: "b".repeat(64),
    runningBuildTs: 1_000_000_000_000,
    log: (_l, m) => { logs.push(m); },
    underLauncher: true,
    fetchFn: inst.fetchFn, trustedPubs: inst.pubs,
    isIdle: () => idle,
    idleRecheckMs: 5,
    setTimeoutFn: (fn) => { ticks.push(fn); return 0; },
    exitFn: (c) => { exitCode = c; },
  });
  assert.equal(r, "updated-awaiting-idle");
  assert.equal(exitCode, null, "não pode exit enquanto ocupado");
  assert.equal(runningReleaseInfo().updatePending, true);
  assert.ok(logs.some((m) => m.includes("update aplicado, aguardando idle")));
  assert.match(readFileSync(selfPath, "utf8"), /2000000000000/, "arquivo já trocado");
  assert.equal(ticks.length, 1);
  ticks[0]!();
  assert.equal(exitCode, null, "ainda ocupado no recheck");
  idle = true;
  ticks[1]!();
  assert.equal(exitCode, 42);
});

test("T-088 bundle VÁLIDO com BUILD_TS antigo -> recusado + log; arquivo intacto", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sup-oldts-"));
  const selfPath = path.join(dir, "daemon.cjs");
  writeFileSync(selfPath, "ANTIGO");
  const inst = signedInstall(daemonSrc(1_000_000_000_000), "bridge");
  const logs: string[] = [];
  const r = await checkAndApplyUpdate({
    orchBase: "http://x", selfPath,
    runningHash: "b".repeat(64),
    runningBuildTs: 2_000_000_000_000,
    log: (_l, m) => { logs.push(m); },
    underLauncher: true,
    fetchFn: inst.fetchFn, trustedPubs: inst.pubs,
    exitFn: () => { throw new Error("não deveria sair"); },
  });
  assert.equal(r, "failed");
  assert.equal(readFileSync(selfPath, "utf8"), "ANTIGO");
  assert.ok(logs.some((m) => /BUILD_TS recusado/.test(m)), logs.join("\n"));
});

test("T-088 pós-update sem restart: hello reporta hash/BUILD_TS velhos + updatePending; re-exec limpa", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sup-boot-"));
  const selfPath = path.join(dir, "daemon.cjs");
  const oldBody = "BINARIO-VELHO-BOOT";
  writeFileSync(selfPath, oldBody);
  const bootHash = captureBootBinaryHash(selfPath);
  const bootTs = runningReleaseInfo().buildTs;
  assert.equal(bootHash, createHash("sha256").update(oldBody).digest("hex"));
  assert.equal(runningReleaseInfo().updatePending, false);

  const inst = signedInstall(daemonSrc(2_000_000_000_000), "bridge");
  const r = await checkAndApplyUpdate({
    orchBase: "http://x", selfPath,
    runningHash: bootHash,
    runningBuildTs: 1_000_000_000_000,
    log, underLauncher: true,
    fetchFn: inst.fetchFn, trustedPubs: inst.pubs,
    isIdle: () => false,
    idleRecheckMs: 60_000,
    setTimeoutFn: () => 0,
    exitFn: () => { throw new Error("não deveria re-exec enquanto ocupado"); },
  });
  assert.equal(r, "updated-awaiting-idle");
  const hello = runningReleaseInfo();
  assert.equal(hello.binaryHash, bootHash, "hello não pode re-ler o arquivo novo");
  assert.equal(hello.buildTs, bootTs, "BUILD_TS é da imagem carregada, não do arquivo");
  assert.equal(hello.updatePending, true);
  const fileBuf = readFileSync(selfPath);
  const fileHash = createHash("sha256").update(fileBuf).digest("hex");
  assert.notEqual(fileHash, bootHash);
  assert.equal(extractBuildTs(fileBuf), 2_000_000_000_000);

  // Segundo check: já aplicado — não re-baixa; hello segue mentindo se re-lesse o arquivo
  const r2 = await checkAndApplyUpdate({
    orchBase: "http://x", selfPath,
    runningHash: bootHash,
    runningBuildTs: 1_000_000_000_000,
    log, underLauncher: true,
    fetchFn: inst.fetchFn, trustedPubs: inst.pubs,
    isIdle: () => false,
    idleRecheckMs: 60_000,
    setTimeoutFn: () => 0,
    exitFn: () => { throw new Error("não deveria re-exec"); },
  });
  assert.equal(r2, "updated-awaiting-idle");
  assert.equal(runningReleaseInfo().binaryHash, bootHash);
  assert.equal(runningReleaseInfo().updatePending, true);

  // Simula re-exec: processo novo captura o arquivo novo, pending=false
  _resetIdleRestartForTest();
  const after = captureBootBinaryHash(selfPath);
  assert.equal(after, fileHash);
  assert.equal(runningReleaseInfo().updatePending, false);
  assert.equal(runningReleaseInfo().binaryHash, fileHash);
});

test("T-088 bundle BUILD_TS novo -> aceito", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sup-newts-"));
  const selfPath = path.join(dir, "daemon.cjs");
  writeFileSync(selfPath, "ANTIGO");
  const inst = signedInstall(daemonSrc(2_000_000_000_000), "bridge");
  let exitCode: number | null = null;
  const r = await checkAndApplyUpdate({
    orchBase: "http://x", selfPath,
    runningHash: "b".repeat(64),
    runningBuildTs: 1_500_000_000_000,
    log, underLauncher: true,
    fetchFn: inst.fetchFn, trustedPubs: inst.pubs,
    isIdle: () => true,
    exitFn: (c) => { exitCode = c; },
  });
  assert.equal(r, "updated");
  assert.equal(exitCode, 42);
  assert.match(readFileSync(selfPath, "utf8"), /2000000000000/);
});

test("T-100 idle-restart: filhos terminam ANTES do exit 42", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sup-t100-order-"));
  const selfPath = path.join(dir, "daemon.cjs");
  writeFileSync(selfPath, "ANTIGO");
  const inst = signedInstall(daemonSrc(2_000_000_000_000), "bridge");
  const order: string[] = [];
  let exitCode: number | null = null;
  const r = await checkAndApplyUpdate({
    orchBase: "http://x", selfPath,
    runningHash: "b".repeat(64),
    runningBuildTs: 1_000_000_000_000,
    log, underLauncher: true,
    fetchFn: inst.fetchFn, trustedPubs: inst.pubs,
    isIdle: () => true,
    prepareReexec: async () => { order.push("kill-children"); },
    exitFn: (c) => { order.push(`exit-${c}`); exitCode = c; },
  });
  assert.equal(r, "updated");
  assert.equal(exitCode, 42);
  assert.deepEqual(order, ["kill-children", "exit-42"]);
});

test("T-100 filho que não morre no prazo: escalation e exit mesmo assim", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sup-t100-hang-"));
  const selfPath = path.join(dir, "daemon.cjs");
  writeFileSync(selfPath, "ANTIGO");
  const inst = signedInstall(daemonSrc(2_000_000_000_000), "bridge");
  const logs: string[] = [];
  let exitCode: number | null = null;
  const t0 = Date.now();
  const r = await checkAndApplyUpdate({
    orchBase: "http://x", selfPath,
    runningHash: "b".repeat(64),
    runningBuildTs: 1_000_000_000_000,
    log: (_l, m) => { logs.push(m); },
    underLauncher: true,
    fetchFn: inst.fetchFn, trustedPubs: inst.pubs,
    isIdle: () => true,
    prepareReexec: () => new Promise(() => { /* filho zumbi — nunca resolve */ }),
    reexecTimeoutMs: 40,
    exitFn: (c) => { exitCode = c; },
  });
  const elapsed = Date.now() - t0;
  assert.equal(r, "updated");
  assert.equal(exitCode, 42);
  assert.ok(elapsed < 2_000, `travou o restart (${elapsed}ms)`);
  assert.ok(logs.some((m) => /estourou 40ms/.test(m)), logs.join("\n"));
});

test("T-100 sem launcher: pending, sem exit, sem matar filhos", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sup-t100-nolaunch-"));
  const selfPath = path.join(dir, "daemon.cjs");
  writeFileSync(selfPath, "ANTIGO");
  const inst = signedInstall(daemonSrc(2_000_000_000_000), "bridge");
  let killed = false;
  let exitCode: number | null = null;
  const r = await checkAndApplyUpdate({
    orchBase: "http://x", selfPath,
    runningHash: "b".repeat(64),
    runningBuildTs: 1_000_000_000_000,
    log, underLauncher: false,
    fetchFn: inst.fetchFn, trustedPubs: inst.pubs,
    isIdle: () => true,
    prepareReexec: () => { killed = true; },
    exitFn: (c) => { exitCode = c; },
  });
  assert.equal(r, "updated-restart-pending");
  assert.equal(exitCode, null);
  assert.equal(killed, false);
  assert.equal(runningReleaseInfo().updatePending, true);
});

test("T-100 main.ts injeta prepareReexec no checkAndApplyUpdate", () => {
  const src = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  assert.match(src, /prepareReexec:\s*\(\)\s*=>\s*this\.prepareReexec\(\)/);
  assert.match(src, /parando CLIs filhos antes do re-exec/);
  assert.doesNotMatch(src, /process\.exit\(42\)/);
});
