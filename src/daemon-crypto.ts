/**
 * Daemon-side E2EE keypair management.
 *
 * The daemon generates a long-lived RSA-OAEP-2048 keypair on first run,
 * persists the private key to ~/.the-dudes/daemon-key.pem (chmod 600),
 * and announces its public key in the daemon:hello frame. Web clients
 * use that public key to wrap per-project AES-256 symmetric keys; the
 * daemon decrypts the wraps with its private key and keeps the
 * symmetric keys in memory only.
 *
 * The server never sees the daemon's private key or any plaintext
 * project key.
 */

import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  sign as nodeSign,
  type KeyObject,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_KEY_PATH = process.env.THE_DUDES_DAEMON_KEY_PATH
  ?? join(homedir(), ".the-dudes", "daemon-key.pem");

interface KeyPair {
  privateKey: KeyObject;
  publicKeySpkiB64: string;
}

let cached: KeyPair | null = null;

export function loadOrCreateDaemonKeypair(keyPath: string = DEFAULT_KEY_PATH): KeyPair {
  if (cached) return cached;
  if (existsSync(keyPath)) {
    try {
      const pem = readFileSync(keyPath, "utf8");
      const priv = createPrivateKey({ key: pem, format: "pem" });
      const pub = createPublicKey(priv);
      cached = {
        privateKey: priv,
        publicKeySpkiB64: pub.export({ type: "spki", format: "der" }).toString("base64"),
      };
      return cached;
    } catch (e) {
      // PEM corrupto/ilegível: renomeia pra .corrupted.<ts> em vez de
      // sobrescrever silenciosamente. Sem isso, daemon regenerava nova
      // identity, todos web clients TOFU disparavam alerta, e o user não
      // sabia POR QUE (key file desaparece sem trace). Renomear preserva
      // forensics + visibilidade no log.
      const backup = `${keyPath}.corrupted.${Date.now()}`;
      try {
        renameSync(keyPath, backup);
        console.warn(`[the-dudes] daemon keypair PEM corrupto/ilegível em ${keyPath} (${(e as Error).message}). Renomeado pra ${backup}. Gerando novo keypair — web clients vão alertar mudança de pubkey (TOFU).`);
      } catch (renameErr) {
        console.warn(`[the-dudes] daemon keypair PEM corrupto E renomeação falhou: ${(renameErr as Error).message}. Sobrescrevendo.`);
      }
      // fall through to regenerate
    }
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const dir = dirname(keyPath);
  // mode 0o700 + chmod fallback: previne outros users locais listarem o
  // dir (mtime, presença do daemon-key.pem). Default umask 022 deixava
  // 0o755. chmod aplicado mesmo se dir já existir (correção retro).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  writeFileSync(keyPath, pem, { mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch { /* best-effort */ }
  cached = {
    privateKey,
    publicKeySpkiB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
  return cached;
}

export function getDaemonPublicKey(): string {
  return loadOrCreateDaemonKeypair().publicKeySpkiB64;
}

/** Assina um challenge nonce com a privkey RSA do daemon. Usado pelo
 *  H-18 proof-of-possession: server verifica que o daemon que enviou
 *  a pubkey realmente tem a privkey correspondente. Sem isso, atacante
 *  que rouba só o token poderia conectar com sua pubkey forjada e
 *  receber project keys cifradas pra ele. */
export function signChallenge(nonce: string): string {
  const { privateKey } = loadOrCreateDaemonKeypair();
  const sig = nodeSign("sha256", Buffer.from(nonce, "utf8"), {
    key: privateKey,
    padding: constants.RSA_PKCS1_PADDING,
  });
  return sig.toString("base64");
}

/** Decrypt a base64 RSA-OAEP-encrypted payload with the daemon's
 *  private key. Used to unwrap per-project AES-256 symmetric keys. */
export function decryptWithDaemonKey(wrappedB64: string): Buffer {
  const { privateKey } = loadOrCreateDaemonKeypair();
  const ct = Buffer.from(wrappedB64, "base64");
  return privateDecrypt(
    {
      key: privateKey,
      oaepHash: "sha256",
      padding: constants.RSA_PKCS1_OAEP_PADDING,
    },
    ct,
  );
}

/* ---------- project AES-256 keys: RAM + wrap persistido ---------- */

const projectKeys = new Map<string, Buffer>(); // projectId → 32-byte raw key

/**
 * Persistência dos wraps em disco.
 *
 * A chave vivia SÓ em memória, e o relay tem fallback documentado: sem chave,
 * o conteúdo sobe em texto claro. Sequência real: daemon reinicia → chave some
 * → spawn espera um pouco e prossegue mesmo assim → TODO o tráfego dos agentes
 * (mensagens, memórias, quadro) chega ao server em plaintext até alguém abrir
 * o web com o cofre destravado. A promessa E2EE quebrava em silêncio.
 *
 * Aqui fica o blob JÁ EMBRULHADO com a RSA do daemon — o mesmo formato que
 * chega pela rede. Quem lê este arquivo precisa também da privkey, que mora ao
 * lado com a mesma permissão (0600): nenhuma superfície nova além da que o
 * daemon-key.pem já expõe.
 */
const PROJECT_KEYS_PATH = process.env.THE_DUDES_PROJECT_KEYS_PATH
  ?? join(homedir(), ".the-dudes", "project-keys.json");

function readPersistedWraps(): Record<string, string> {
  try {
    if (!existsSync(PROJECT_KEYS_PATH)) return {};
    const raw = JSON.parse(readFileSync(PROJECT_KEYS_PATH, "utf8")) as Record<string, string>;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function persistWrap(projectId: string, wrappedB64: string): void {
  try {
    const all = readPersistedWraps();
    if (all[projectId] === wrappedB64) return;
    all[projectId] = wrappedB64;
    mkdirSync(dirname(PROJECT_KEYS_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(PROJECT_KEYS_PATH, JSON.stringify(all, null, 2), { mode: 0o600 });
    chmodSync(PROJECT_KEYS_PATH, 0o600);
  } catch (e) {
    console.warn(`[the-dudes] falha ao persistir project key wrap de ${projectId}:`, (e as Error).message);
  }
}

/** Repõe a chave da RAM a partir do wrap em disco. true se recuperou. */
function restoreFromDisk(projectId: string): boolean {
  const wrapped = readPersistedWraps()[projectId];
  if (!wrapped) return false;
  try {
    const raw = decryptWithDaemonKey(wrapped);
    if (raw.length !== 32) return false;
    projectKeys.set(projectId, raw);
    console.info(`[the-dudes] project key de ${projectId} restaurada do disco`);
    return true;
  } catch (e) {
    console.warn(`[the-dudes] wrap persistido de ${projectId} não abre (keypair trocou?):`, (e as Error).message);
    return false;
  }
}

/** RAM primeiro; disco como retaguarda pós-restart. */
function keyFor(projectId: string): Buffer | null {
  const k = projectKeys.get(projectId);
  if (k) return k;
  return restoreFromDisk(projectId) ? projectKeys.get(projectId) ?? null : null;
}

/** @returns true se a key foi unwrapada e cacheada com sucesso. */
export function rememberProjectKey(projectId: string, wrappedB64: string): boolean {
  try {
    const raw = decryptWithDaemonKey(wrappedB64);
    if (raw.length !== 32) {
      console.warn(`[the-dudes] unexpected project key length ${raw.length} for ${projectId}`);
      return false;
    }
    projectKeys.set(projectId, raw);
    // O wrap que chegou pela rede vai pro disco: é o que impede o fallback
    // plaintext do relay depois de um restart do daemon.
    persistWrap(projectId, wrappedB64);
    return true;
  } catch (e) {
    console.warn(`[the-dudes] failed to unwrap project key for ${projectId}:`, (e as Error).message);
    return false;
  }
}

export function getProjectKey(projectId: string): Buffer | null {
  return keyFor(projectId);
}

/** Forget a project key — call when daemon disconnects from a project
 *  or on shutdown to minimize the window the symmetric key sits in
 *  RAM. */
export function forgetProjectKey(projectId: string): void {
  const k = projectKeys.get(projectId);
  if (k) {
    k.fill(0);
    projectKeys.delete(projectId);
  }
  credPlaintexts.delete(projectId);
  // Desconectar de UM projeto é remoção deliberada → o wrap sai do disco
  // também. (O shutdown usa forgetAllProjectKeys, que preserva o disco — é
  // exatamente a persistência que evita o fallback plaintext pós-restart.)
  try {
    const all = readPersistedWraps();
    if (all[projectId]) {
      delete all[projectId];
      writeFileSync(PROJECT_KEYS_PATH, JSON.stringify(all, null, 2), { mode: 0o600 });
    }
  } catch { /* best effort */ }
}

/** Nº de projetos com chave utilizável (RAM + wraps em disco). Indicador de
 *  saúde: 0 num daemon com agentes E2EE = tudo subindo... nada, porque o
 *  relay recusa? Não — cai em plaintext. Por isso o número aparece na UI. */
export function countUsableProjectKeys(): number {
  const ids = new Set(projectKeys.keys());
  for (const id of Object.keys(readPersistedWraps())) ids.add(id);
  return ids.size;
}

export function forgetAllProjectKeys(): void {
  for (const k of projectKeys.values()) k.fill(0);
  projectKeys.clear();
  credPlaintexts.clear();
}

/* ---------- credential redaction set (por projeto) ----------
 * Quando um agente busca uma credencial via get_credential, o daemon decifra
 * o value (E2EE) e guarda o plaintext aqui pra mascarar no EGRESSO do agente
 * (text/thinking/tool_use). Em projeto E2EE o server não vê o plaintext, então
 * a redação tem que ser no daemon (sobre o texto decifrado, antes de re-cifrar). */
const credPlaintexts = new Map<string, Set<string>>(); // projectId → set de values

export function rememberCredentialPlaintext(projectId: string, value: string): void {
  if (!projectId || typeof value !== "string" || value.length < 6) return;
  let set = credPlaintexts.get(projectId);
  if (!set) { set = new Set(); credPlaintexts.set(projectId, set); }
  set.add(value);
  // Cap defensivo contra crescimento ilimitado (agente iterando nomes).
  if (set.size > 200) set.delete(set.values().next().value as string);
}

/** Mascara qualquer ocorrência de credencial conhecida (+ variantes
 *  URL-encoded / base64) numa string. */
export function redactCredentials(projectId: string, text: string): string {
  const set = credPlaintexts.get(projectId);
  if (!set || !text) return text;
  let out = text;
  for (const v of set) {
    if (v.length < 6) continue;
    for (const variant of [v, encodeURIComponent(v), Buffer.from(v, "utf8").toString("base64")]) {
      if (variant.length < 6) continue;
      out = out.split(variant).join("[REDACTED]");
    }
  }
  return out;
}

/** redact recursivo sobre strings dentro de objetos/arrays (ex tool_use.input). */
export function redactCredentialsDeep(projectId: string, value: unknown): unknown {
  if (typeof value === "string") return redactCredentials(projectId, value);
  if (Array.isArray(value)) return value.map((x) => redactCredentialsDeep(projectId, x));
  if (value && typeof value === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(value as Record<string, unknown>)) o[k] = redactCredentialsDeep(projectId, val);
    return o;
  }
  return value;
}

/* ---------- content AES-GCM (matches web/src/crypto.ts format) ---------- */

const E2E_PREFIX = "e2e:";

/** Encrypt a UTF-8 string with the project AES-256 key. Returns
 *  "e2e:" + base64(iv || ciphertext || tag) — same wire format the web
 *  client uses, so values round-trip transparently. */
export function encryptForProject(plain: string, projectId: string): string | null {
  const key = keyFor(projectId);
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return E2E_PREFIX + Buffer.concat([iv, ct, tag]).toString("base64");
}

/** Decrypt an "e2e:"-prefixed base64 blob back to UTF-8. Pass-through if
 *  the value isn't prefixed (legacy plain). Returns null if we don't
 *  hold the key for this project (caller must handle fallback). */
export function decryptForProject(stored: string, projectId: string): string | null {
  if (!stored.startsWith(E2E_PREFIX)) return stored;
  const key = keyFor(projectId);
  if (!key) return null;
  try {
    const all = Buffer.from(stored.slice(E2E_PREFIX.length), "base64");
    const iv = all.subarray(0, 12);
    const tag = all.subarray(all.length - 16);
    const ct = all.subarray(12, all.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch (e) {
    // AES-GCM auth fail = ESTE blob não bate com a key em memória.
    // Causa comum: system prompt/memory cifrado com key antiga (rotação)
    // enquanto a key atual é válida para o resto do projeto. NÃO apagar a
    // project key — um único blob stale mataria decrypt de TODOS os
    // agentes/mensagens do projeto. A key só se atualiza via
    // project_key:for_daemon (rememberProjectKey).
    console.warn(`[the-dudes] decrypt failed for ${projectId}:`, (e as Error).message);
    return null;
  }
}

export function hasProjectKey(projectId: string): boolean {
  return projectKeys.has(projectId) || keyFor(projectId) !== null;
}

export function isE2eEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(E2E_PREFIX);
}
