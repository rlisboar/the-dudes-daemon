#!/usr/bin/env node
/**
 * Assina daemon/dist/*.cjs já buildados (Ed25519).
 *
 * Usado pelo Deploy quando reaproveita o artifact do CI (CI não tem a
 * chave). Mesma resolução de chave e mesmo esquema de build.mjs
 * (sign(null, file) + .sig em base64). Fail-closed: sem chave ou sem
 * bundle → exit 1. Não reescreve o .cjs nem o .sha256.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { sign as edSign, createPrivateKey } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keyPath = [
  process.env.THE_DUDES_SIGN_KEY_FILE,
  resolve(homedir(), ".the-dudes-signing/sign-new.key"),
].filter(Boolean).find((p) => existsSync(p));

if (!keyPath) {
  console.error("sign-dist: chave ausente (THE_DUDES_SIGN_KEY_FILE ou ~/.the-dudes-signing/sign-new.key)");
  process.exit(1);
}

const key = createPrivateKey(readFileSync(keyPath));
for (const name of ["daemon.cjs", "mcp-bridge.cjs"]) {
  const p = resolve(root, "dist", name);
  if (!existsSync(p)) {
    console.error(`sign-dist: falta ${p}`);
    process.exit(1);
  }
  writeFileSync(`${p}.sig`, edSign(null, readFileSync(p), key).toString("base64") + "\n");
}
console.log(`sign-dist: daemon.cjs.sig + mcp-bridge.cjs.sig (Ed25519) key=${keyPath}`);
