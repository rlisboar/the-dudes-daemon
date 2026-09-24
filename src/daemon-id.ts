import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Stable routing identity for a daemon profile. A copied profile keeps the
 * same id and is rejected by the server's clone check. */
export function loadOrCreateDaemonId(profileDir: string, ownerUid = process.getuid?.()): string {
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const canonicalProfile = fs.realpathSync(profileDir);
  const profileStat = fs.statSync(canonicalProfile);
  if (!profileStat.isDirectory() || (ownerUid != null && profileStat.uid !== ownerUid && process.geteuid?.() !== 0)) {
    throw new Error("daemon profile directory is not owned by the daemon user");
  }

  const file = path.join(canonicalProfile, "daemon-id");
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error("daemon-id must be a regular file");
    if (ownerUid != null && st.uid !== ownerUid && process.geteuid?.() !== 0) {
      throw new Error("daemon-id is not owned by the daemon user");
    }
    const existing = fs.readFileSync(file, "utf8").trim();
    if (!UUID_V4.test(existing)) throw new Error("daemon-id is malformed");
    if (process.geteuid?.() === 0 && ownerUid != null && st.uid !== ownerUid) fs.chownSync(file, ownerUid, -1);
    fs.chmodSync(file, 0o600);
    return existing.toLowerCase();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const id = randomUUID();
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return loadOrCreateDaemonId(canonicalProfile, ownerUid);
    throw error;
  }
  try {
    fs.writeFileSync(fd, `${id}\n`, "utf8");
    fs.fsyncSync(fd);
    if (ownerUid != null && process.geteuid?.() === 0) fs.fchownSync(fd, ownerUid, -1);
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  return id;
}
