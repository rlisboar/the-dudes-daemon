import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOutboundUrl } from "../ssrf-guard.js";

test("checkOutboundUrl: IP privado/metadata/loopback bloqueado (IP literal, sem DNS)", async () => {
  for (const u of [
    "http://169.254.169.254/latest/meta-data/", // IMDS
    "http://10.0.0.1/x",
    "http://192.168.1.1/x",
    "http://172.16.0.1/x",
    "http://127.0.0.1:6379/",
    "http://[::1]/x",
    "http://0.0.0.0/x",
  ]) {
    assert.notEqual(await checkOutboundUrl(u), null, `${u} deveria ser bloqueado`);
  }
});

test("checkOutboundUrl: IPv4-mapped IPv6 de IP privado é bloqueado (unmapV4)", async () => {
  assert.notEqual(await checkOutboundUrl("http://[::ffff:169.254.169.254]/"), null);
  assert.notEqual(await checkOutboundUrl("http://[::ffff:10.0.0.1]/"), null);
});

test("checkOutboundUrl: scheme não-http(s) e URL inválida rejeitados", async () => {
  assert.notEqual(await checkOutboundUrl("ftp://example.com/"), null);
  assert.notEqual(await checkOutboundUrl("file:///etc/passwd"), null);
  assert.notEqual(await checkOutboundUrl("não é url"), null);
});

test("checkOutboundUrl: IP público literal passa", async () => {
  assert.equal(await checkOutboundUrl("https://8.8.8.8/"), null);
  assert.equal(await checkOutboundUrl("https://1.1.1.1/path"), null);
});

test("checkOutboundUrl: allowLocalhost opt-in libera loopback", async () => {
  assert.equal(await checkOutboundUrl("http://127.0.0.1:8080/", { allowLocalhost: true }), null);
  assert.equal(await checkOutboundUrl("http://localhost:8080/", { allowLocalhost: true }), null);
});
