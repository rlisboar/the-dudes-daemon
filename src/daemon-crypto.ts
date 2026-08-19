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
  E2E_PREFIX,
  E2E_V2_PREFIX,
  isE2eV1Rejected,
  isE2eV2,
} from "@the-dudes/protocol/e2ee-fields";
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

/* ---------- project AES-256 keys: RAM + wrap + key ring persistidos ---------- */

const projectKeys = new Map<string, Buffer>(); // projectId → 32-byte raw key (ativa)
/** Chaves antigas decifradas, mais recente primeiro — fallback de leitura
 *  pós-rotação (paridade com projectKeysOld do web / maybeDecrypt). */
const projectKeysOld = new Map<string, Buffer[]>();
/** Entradas opacas do ring (e2e:), mais antiga primeiro — o mesmo formato
 *  que project_keys:current.keyRing entrega. Persistidas cifradas. */
const projectKeyRingEntries = new Map<string, string[]>();

/**
 * Persistência dos wraps (+ ring) em disco.
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
 *
 * Formato do arquivo (retrocompatível):
 *   { "<projectId>": "<wrappedB64>" }
 *   { "<projectId>": { "wrap": "<wrappedB64>", "keyRing": ["e2e:…", …] } }
 * String pura = só wrap (formato legado). O keyRing é a cadeia opaca do
 * server — cada entrada já é AES-GCM; sem a chave ativa (e a privkey do
 * daemon pra abrir o wrap) o ring não revela nada.
 */
const PROJECT_KEYS_PATH = process.env.THE_DUDES_PROJECT_KEYS_PATH
  ?? join(homedir(), ".the-dudes", "project-keys.json");

interface PersistedProjectKey {
  wrap: string;
  keyRing?: string[];
}

type PersistedStore = Record<string, string | PersistedProjectKey>;

function parsePersistedEntry(v: unknown): PersistedProjectKey | null {
  if (typeof v === "string" && v.length > 0) return { wrap: v };
  if (v && typeof v === "object" && typeof (v as PersistedProjectKey).wrap === "string") {
    const o = v as PersistedProjectKey;
    const keyRing = Array.isArray(o.keyRing)
      ? o.keyRing.filter((e): e is string => typeof e === "string" && e.startsWith("e2e:"))
      : undefined;
    return { wrap: o.wrap, keyRing: keyRing?.length ? keyRing : undefined };
  }
  return null;
}

function readPersistedStore(): PersistedStore {
  try {
    if (!existsSync(PROJECT_KEYS_PATH)) return {};
    const raw = JSON.parse(readFileSync(PROJECT_KEYS_PATH, "utf8")) as PersistedStore;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writePersistedStore(all: PersistedStore): void {
  mkdirSync(dirname(PROJECT_KEYS_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(PROJECT_KEYS_PATH, JSON.stringify(all, null, 2), { mode: 0o600 });
  try { chmodSync(PROJECT_KEYS_PATH, 0o600); } catch { /* best-effort */ }
}

function persistProjectCrypto(projectId: string, wrappedB64: string): void {
  try {
    const all = readPersistedStore();
    const ring = projectKeyRingEntries.get(projectId);
    const next: string | PersistedProjectKey =
      ring && ring.length > 0
        ? { wrap: wrappedB64, keyRing: ring }
        : wrappedB64;
    const prev = all[projectId];
    if (JSON.stringify(prev) === JSON.stringify(next)) return;
    all[projectId] = next;
    writePersistedStore(all);
  } catch (e) {
    console.warn(`[the-dudes] falha ao persistir project key wrap de ${projectId}:`, (e as Error).message);
  }
}

function wipeOldKeys(projectId: string): void {
  const old = projectKeysOld.get(projectId);
  if (old) {
    for (const k of old) k.fill(0);
    projectKeysOld.delete(projectId);
  }
  projectKeyRingEntries.delete(projectId);
}

/** Decifra a cadeia do key ring a partir da chave ativa (de trás pra frente).
 *  Retorna quantas entradas abriram. Paridade com importProjectKeyRing do web. */
export function importProjectKeyRing(projectId: string, entries: string[] | undefined): number {
  if (!entries?.length) return 0;
  const ativa = projectKeys.get(projectId) ?? keyFor(projectId);
  if (!ativa) return 0;
  const antigas: Buffer[] = [];
  let chave: Buffer = ativa;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    try {
      const rawB64 = decryptWithRawKey(entry, chave);
      if (rawB64 == null) break;
      const antiga = Buffer.from(rawB64, "base64");
      if (antiga.length !== 32) {
        console.warn(`[the-dudes] key ring: entrada ${i} de ${projectId} tem tamanho ${antiga.length}`);
        break;
      }
      antigas.push(antiga); // mais recente primeiro
      chave = antiga;
    } catch {
      console.warn(`[the-dudes] key ring: entrada ${i} de ${projectId} não abriu — histórico anterior fica ilegível`);
      break;
    }
  }
  // Limpa buffers anteriores antes de substituir.
  const prev = projectKeysOld.get(projectId);
  if (prev) for (const k of prev) k.fill(0);
  if (antigas.length) {
    projectKeysOld.set(projectId, antigas);
    projectKeyRingEntries.set(projectId, [...entries]);
  } else {
    projectKeysOld.delete(projectId);
    projectKeyRingEntries.delete(projectId);
  }
  return antigas.length;
}

/** Promove a chave ativa atual a entrada do ring, cifrada com a nova.
 *  Cobre rotação online (daemon ainda tinha a antiga em RAM).
 *  NÃO zera o buffer em projectKeys — o caller substitui a entrada. */
function promoteActiveToRing(projectId: string, newKey: Buffer): void {
  const old = projectKeys.get(projectId);
  if (!old || old.equals(newKey)) return;
  const oldCopy = Buffer.from(old);
  const entry = encryptWithRawKey(oldCopy.toString("base64"), newKey);
  if (!entry) return;
  const entries = projectKeyRingEntries.get(projectId) ?? [];
  entries.push(entry);
  projectKeyRingEntries.set(projectId, entries);
  const antigas = projectKeysOld.get(projectId) ?? [];
  // oldCopy vira a mais recente das antigas; as anteriores já estavam no map
  antigas.unshift(oldCopy);
  projectKeysOld.set(projectId, antigas);
}

/** Repõe a chave da RAM a partir do wrap em disco. true se recuperou. */
function restoreFromDisk(projectId: string): boolean {
  const entry = parsePersistedEntry(readPersistedStore()[projectId]);
  if (!entry) return false;
  try {
    const raw = decryptWithDaemonKey(entry.wrap);
    if (raw.length !== 32) return false;
    projectKeys.set(projectId, raw);
    if (entry.keyRing?.length) {
      const n = importProjectKeyRing(projectId, entry.keyRing);
      console.info(`[the-dudes] project key de ${projectId} restaurada do disco (ring: ${n} antiga(s))`);
    } else {
      console.info(`[the-dudes] project key de ${projectId} restaurada do disco`);
    }
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

/**
 * Unwrap RSA da chave ativa e cacheia. Opcionalmente importa o key ring
 * (cadeia de project_keys:current.keyRing — mais antiga primeiro).
 * Se a chave ativa muda e a anterior ainda estava em RAM, promove-a ao
 * ring automaticamente (rotação online sem precisar do blob do server).
 *
 * @returns true se a key ativa foi unwrapada e cacheada com sucesso.
 */
export function rememberProjectKey(
  projectId: string,
  wrappedB64: string,
  keyRing?: string[],
): boolean {
  try {
    const raw = decryptWithDaemonKey(wrappedB64);
    if (raw.length !== 32) {
      console.warn(`[the-dudes] unexpected project key length ${raw.length} for ${projectId}`);
      return false;
    }
    // Se já havia outra chave em RAM, ela vira entrada do ring antes de
    // ser substituída — cobre o caso em que o web só reenvia a ativa.
    const prev = projectKeys.get(projectId);
    promoteActiveToRing(projectId, raw);
    projectKeys.set(projectId, raw);
    if (prev && !prev.equals(raw)) prev.fill(0);
    if (keyRing?.length) {
      // Ring do server é a fonte autoritativa da cadeia completa.
      importProjectKeyRing(projectId, keyRing);
    }
    // O wrap (+ ring opaco) vai pro disco: impede fallback plaintext e
    // preserva leitura de histórico pós-restart.
    persistProjectCrypto(projectId, wrappedB64);
    return true;
  } catch (e) {
    console.warn(`[the-dudes] failed to unwrap project key for ${projectId}:`, (e as Error).message);
    return false;
  }
}

export function getProjectKey(projectId: string): Buffer | null {
  return keyFor(projectId);
}

/** Nº de chaves antigas em RAM pro projeto (debug/testes). */
export function countOldProjectKeys(projectId: string): number {
  keyFor(projectId); // force restore
  return projectKeysOld.get(projectId)?.length ?? 0;
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
  wipeOldKeys(projectId);
  credPlaintexts.delete(projectId);
  // Desconectar de UM projeto é remoção deliberada → o wrap sai do disco
  // também. (O shutdown usa forgetAllProjectKeys, que preserva o disco — é
  // exatamente a persistência que evita o fallback plaintext pós-restart.)
  try {
    const all = readPersistedStore();
    if (all[projectId]) {
      delete all[projectId];
      writePersistedStore(all);
    }
  } catch { /* best effort */ }
}

/** Nº de projetos com chave utilizável (RAM + wraps em disco). Indicador de
 *  saúde: 0 num daemon com agentes E2EE = tudo subindo... nada, porque o
 *  relay recusa? Não — cai em plaintext. Por isso o número aparece na UI. */
export function countUsableProjectKeys(): number {
  const ids = new Set(projectKeys.keys());
  for (const id of Object.keys(readPersistedStore())) ids.add(id);
  return ids.size;
}

export function forgetAllProjectKeys(): void {
  for (const k of projectKeys.values()) k.fill(0);
  projectKeys.clear();
  for (const id of [...projectKeysOld.keys()]) wipeOldKeys(id);
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

/** Cifra UTF-8 com uma AES-256 raw. Sem aad → e2e: (legado). Com aad → e2e:v2:. Nunca e2e:v1:. */
function encryptWithRawKey(plain: string, key: Buffer, aad?: string): string | null {
  if (key.length !== 32) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad != null) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const prefix = aad != null ? E2E_V2_PREFIX : E2E_PREFIX;
  return prefix + Buffer.concat([iv, ct, tag]).toString("base64");
}

/** Decifra blob e2e: / e2e:v2:. e2e:v1: → null (fail-closed). */
function decryptWithRawKey(stored: string, key: Buffer, aad?: string): string | null {
  if (isE2eV1Rejected(stored)) return null;
  if (key.length !== 32) return null;
  try {
    if (isE2eV2(stored)) {
      if (aad == null || aad === "") return null;
      const all = Buffer.from(stored.slice(E2E_V2_PREFIX.length), "base64");
      if (all.length < 12 + 16) return null;
      const iv = all.subarray(0, 12);
      const tag = all.subarray(all.length - 16);
      const ct = all.subarray(12, all.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    }
    if (!stored.startsWith(E2E_PREFIX)) return stored;
    const all = Buffer.from(stored.slice(E2E_PREFIX.length), "base64");
    if (all.length < 12 + 16) return null;
    const iv = all.subarray(0, 12);
    const tag = all.subarray(all.length - 16);
    const ct = all.subarray(12, all.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Encrypt a UTF-8 string with the project AES-256 key. Sem aad → e2e:
 *  (legado / sem table|field). Com aad → e2e:v2:. Nunca e2e:v1:. */
export function encryptForProject(plain: string, projectId: string, aad?: string): string | null {
  const key = keyFor(projectId);
  if (!key) return null;
  return encryptWithRawKey(plain, key, aad);
}

/** Decrypt an "e2e:"-prefixed base64 blob back to UTF-8. Pass-through if
 *  the value isn't prefixed (legacy plain). Returns null if we don't
 *  hold any key (ativa ou ring) capaz de abrir o blob.
 *
 *  Fallback do key ring: tenta a ativa e depois as antigas (mais recente
 *  primeiro) — paridade com maybeDecrypt do web. Sem isso, rotação tornava
 *  histórico pré-rotação ilegível no MCP bridge. */
export function decryptForProject(stored: string, projectId: string, aad?: string): string | null {
  if (isE2eV1Rejected(stored)) return null;
  if (!stored.startsWith(E2E_PREFIX)) return stored;
  // v2 sem AAD: fail-closed (D5). Não defaultar kind.
  if (isE2eV2(stored) && (aad == null || aad === "")) return null;
  const key = keyFor(projectId);
  if (!key) return null;
  const plain = decryptWithRawKey(stored, key, aad);
  if (plain != null) return plain;
  // AES-GCM auth fail na ativa = blob de era anterior OU lixo. Tenta o ring
  // antes de desistir. NÃO apagar a project key — um único blob stale mataria
  // decrypt de TODOS os agentes/mensagens do projeto.
  const antigas = projectKeysOld.get(projectId) ?? [];
  for (const antiga of antigas) {
    const p = decryptWithRawKey(stored, antiga, aad);
    if (p != null) return p;
  }
  console.warn(`[the-dudes] decrypt failed for ${projectId}: nenhuma chave do ring abriu o blob`);
  return null;
}

export function hasProjectKey(projectId: string): boolean {
  return projectKeys.has(projectId) || keyFor(projectId) !== null;
}

export function isE2eEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(E2E_PREFIX);
}
