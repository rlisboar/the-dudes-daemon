/**
 * T-075: spawnDropped fail-closed quando não há como dropar privilégio
 * (setpriv ausente) — não spawna o filho herdando groups de root.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants as fsConstants } from "node:fs";
import { spawnDropped, type DropTarget } from "../privileges.js";

const SETPRIV_CANDIDATES = [
  "/usr/bin/setpriv",
  "/sbin/setpriv",
  "/usr/sbin/setpriv",
  "/bin/setpriv",
];

function setprivPath(): string | null {
  for (const p of SETPRIV_CANDIDATES) {
    try {
      accessSync(p, fsConstants.X_OK);
      return p;
    } catch { /* next */ }
  }
  return null;
}

const drop: DropTarget = {
  uid: 501,
  gid: 20,
  user: "nobody",
  home: "/tmp",
  path: "/usr/bin:/bin",
};

afterEach(() => {
  delete process.env.DUDES_ALLOW_UNSAFE_DROP;
});

test("T-075 privileges: spawnDropped SEM drop spawna o comando (sem uid/gid)", () => {
  const child = spawnDropped(
    process.execPath,
    ["-e", "process.exit(0)"],
    { stdio: "ignore" },
    null,
  );
  assert.ok(child.pid);
  child.kill("SIGKILL");
});

test("T-075 privileges: spawnDropped COM drop e SEM setpriv recusa (fail-closed)", () => {
  delete process.env.DUDES_ALLOW_UNSAFE_DROP;
  const found = setprivPath();
  if (found) {
    // Host com setpriv: o caminho seguro é o wrapper, NÃO o cmd cru como root.
    const child = spawnDropped(
      process.execPath,
      ["-e", "setInterval(()=>{}, 99999)"],
      { stdio: "ignore" },
      drop,
    );
    try {
      assert.ok(child.pid, "setpriv deve spawnar o wrapper");
    } finally {
      child.kill("SIGKILL");
    }
    return;
  }
  assert.throws(
    () => spawnDropped(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" }, drop),
    (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /privilege drop inseguro recusado/);
      assert.match(msg, /setpriv não encontrado/);
      return true;
    },
  );
});

test("T-075 privileges: DUDES_ALLOW_UNSAFE_DROP=1 é o único opt-in do fallback inseguro", () => {
  if (setprivPath()) {
    // Com setpriv o fallback inseguro não entra — o wrapper seguro é usado.
    return;
  }
  process.env.DUDES_ALLOW_UNSAFE_DROP = "1";
  let child: ReturnType<typeof spawnDropped> | undefined;
  try {
    child = spawnDropped(
      process.execPath,
      ["-e", "process.exit(0)"],
      { stdio: "ignore" },
      drop,
    );
    assert.ok(child.pid, "opt-in deve spawnar (drop nativo uid/gid)");
  } catch (err) {
    // macOS não-root: spawn com uid/gid alheio → EPERM. Ainda assim NÃO é o
    // fail-closed default — o throw é do kernel, não da recusa setpriv.
    assert.match((err as Error).message, /EPERM|Operation not permitted|spawn/i);
  } finally {
    child?.kill("SIGKILL");
  }
});
