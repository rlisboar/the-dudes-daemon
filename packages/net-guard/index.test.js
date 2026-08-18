import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOutboundUrl, isPrivateAddress, unmapV4 } from "./index.js";

test("bloqueia todo o conjunto privado", async () => {
  const privados = [
    "10.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.255",
    "127.0.0.1", "::1",
    "169.254.169.254", // IMDS
    "fe80::1",
    "fd00:ec2::254", "fc00::1", // ULA / IMDS v6
    "100.64.0.1", // CGNAT
    "0.0.0.0", "::",
    "64:ff9b::a9fe:a9fe", // NAT64 → 169.254.169.254
  ];
  for (const ip of privados) {
    assert.equal(isPrivateAddress(ip), true, `${ip} deveria ser privado`);
  }
});

test("os CIDRs que só o server conhecia agora valem pros dois lados", () => {
  // Regressão da unificação: a cópia do daemon não tinha `::` nem o prefixo
  // NAT64, então esses dois passavam lá e eram barrados no server.
  assert.equal(isPrivateAddress("::"), true);
  assert.equal(isPrivateAddress("64:ff9b::1"), true);
});

test("IP público continua liberado", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "172.32.0.1", "100.128.0.1"]) {
    assert.equal(isPrivateAddress(ip), false, `${ip} NÃO deveria ser privado`);
  }
});

test("unmapV4 cobre forma decimal e hex", () => {
  assert.equal(unmapV4("::ffff:169.254.169.254"), "169.254.169.254");
  assert.equal(unmapV4("::ffff:7f00:1"), "127.0.0.1");
  assert.equal(unmapV4("2001:db8::1"), null);
  // O que importa: mapeado de IP privado é bloqueado mesmo assim.
  assert.equal(isPrivateAddress("::ffff:10.0.0.1"), true);
  assert.equal(isPrivateAddress("::ffff:7f00:1"), true);
});

test("checkOutboundUrl: scheme, URL inválida e literais privados", async () => {
  assert.notEqual(await checkOutboundUrl("ftp://example.com/"), null);
  assert.notEqual(await checkOutboundUrl("file:///etc/passwd"), null);
  assert.notEqual(await checkOutboundUrl("não-é-url"), null);
  assert.notEqual(await checkOutboundUrl("http://169.254.169.254/latest/meta-data/"), null);
  assert.notEqual(await checkOutboundUrl("http://127.0.0.1:6379/"), null);
  assert.equal(await checkOutboundUrl("https://8.8.8.8/"), null);
});

test("literais IPv6 entre colchetes são normalizados e barrados", async () => {
  // Regressão: hostname vem "[::1]" e net.isIP dava 0 → isPrivateAddress nunca
  // rodava e todo literal IPv6 furava o guard (caía em DNS ENOTFOUND por acaso).
  assert.notEqual(await checkOutboundUrl("http://[::1]/"), null);
  assert.notEqual(await checkOutboundUrl("http://[::ffff:169.254.169.254]/latest/"), null);
  assert.notEqual(await checkOutboundUrl("http://[fe80::1]/"), null);
  assert.notEqual(await checkOutboundUrl("http://[::127.0.0.1]/"), null);
  assert.notEqual(await checkOutboundUrl("http://[fd00:ec2::254]/"), null);
  // Público IPv6 literal segue liberado.
  assert.equal(await checkOutboundUrl("https://[2001:4860:4860::8888]/"), null);
});

test("classes reservadas/multicast/6to4/link-local ampliadas", () => {
  const bloqueados = [
    "224.0.0.1", "239.255.255.250", // multicast v4 (SSDP)
    "255.255.255.255", "240.0.0.1", // broadcast / reservado 240/4
    "fe90::1", "feb0::1", "febf::1", // link-local /10 além de fe80:
    "ff02::1", // multicast v6
    "::127.0.0.1", "::7f00:1", // IPv4-compatible → loopback
    "2002:7f00:0001::1", // 6to4 embute 127.0.0.1
  ];
  for (const ip of bloqueados) {
    assert.equal(isPrivateAddress(ip), true, `${ip} deveria ser privado/reservado`);
  }
  // Público não regride.
  for (const ip of ["8.8.8.8", "2001:4860:4860::8888", "172.32.0.1"]) {
    assert.equal(isPrivateAddress(ip), false, `${ip} NÃO deveria ser privado`);
  }
});

test("checkOutboundUrl: localhost barrado sem depender do resolver", async () => {
  assert.notEqual(await checkOutboundUrl("http://localhost:8787/"), null);
});

test("allowLocalhost é opt-in — o daemon usa, o orchestrator não", async () => {
  assert.equal(await checkOutboundUrl("http://127.0.0.1:9999/", { allowLocalhost: true }), null);
  assert.equal(await checkOutboundUrl("http://localhost:9999/", { allowLocalhost: true }), null);
  // Sem a opção, o mesmo endereço é bloqueado.
  assert.notEqual(await checkOutboundUrl("http://127.0.0.1:9999/"), null);
  // E allowLocalhost NÃO abre a LAN inteira.
  assert.notEqual(await checkOutboundUrl("http://10.0.0.1/", { allowLocalhost: true }), null);
});
