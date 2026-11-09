import { test } from "node:test";
import assert from "node:assert/strict";
import { validarUrl, ipv4Privado, ipv6Privado, expandirIpv6, resolverPublico, verificarDestinos } from "../src/sitesecure/guard.js";
import { Orcamento } from "../src/sitesecure/util.js";
import { simularRede, dns, semRede } from "./apoio/ambiente.js";

test("validarUrl: aceita site comum e completa o protocolo", () => {
  assert.equal(validarUrl("loja.com.br/p?x=1#topo").url.toString(), "https://loja.com.br/p?x=1");
  assert.equal(validarUrl("HTTP://Loja.com.br:80/").url.hostname, "loja.com.br");
});

test("validarUrl: nomes proibidos, inclusive com ponto final", () => {
  for (const ruim of ["http://localhost/", "http://localhost./", "https://foo.local./", "https://x.internal./", "https://a.b.example", "https://servidor/"]) {
    assert.equal(validarUrl(ruim).erro, "host_nao_permitido", ruim);
  }
});

test("validarUrl: IP literal em qualquer notacao", () => {
  for (const ruim of ["http://127.0.0.1/", "http://2130706433/", "http://0x7f.0.0.1/", "http://127.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://10.0.0.1./"]) {
    assert.equal(validarUrl(ruim).erro, "ip_nao_permitido", ruim);
  }
});

test("validarUrl: protocolo, porta, credenciais e tamanho", () => {
  assert.equal(validarUrl("ftp://loja.com.br/").erro, "protocolo_nao_permitido");
  assert.equal(validarUrl("javascript:alert(1)").erro, "url_invalida");
  assert.equal(validarUrl("https://loja.com.br:8443/").erro, "porta_nao_permitida");
  assert.equal(validarUrl("https://user:senha@loja.com.br/").erro, "url_com_credenciais");
  assert.equal(validarUrl("https://loja.com.br/" + "a".repeat(2100)).erro, "url_invalida");
  assert.equal(validarUrl(null).erro, "url_invalida");
  assert.equal(validarUrl({}).erro, "url_invalida");
});

test("ipv4Privado: faixas reservadas e documentacao", () => {
  for (const ip of ["0.0.0.0", "10.1.1.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.0.1", "100.64.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "192.88.99.1", "224.0.0.1", "255.255.255.255", "999.1.1.1"]) {
    assert.equal(ipv4Privado(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "191.6.1.1", "100.63.0.1"]) assert.equal(ipv4Privado(ip), false, ip);
});

test("ipv6Privado: loopback, ULA, link-local, mapeado e reservados", () => {
  for (const ip of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "2001:db8::1", "2002:7f00:1::", "texto-invalido"]) {
    assert.equal(ipv6Privado(ip), true, ip);
  }
  for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "::ffff:8.8.8.8"]) assert.equal(ipv6Privado(ip), false, ip);
});

test("expandirIpv6: forma comprimida e invalidos", () => {
  assert.deepEqual(expandirIpv6("2001:db8::1"), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expandirIpv6("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(expandirIpv6("1::2::3"), null);
  assert.equal(expandirIpv6("1:2:3"), null);
  assert.equal(expandirIpv6("zzzz::1"), null);
});

test("resolverPublico: dominio publico com A e AAAA publicos", async (t) => {
  simularRede(t, dns({ "loja.com.br": { A: ["93.184.216.34"], AAAA: ["2606:2800:220:1::1"] } }));
  const r = await resolverPublico(new Orcamento(10), "loja.com.br");
  assert.deepEqual(r.ips, ["93.184.216.34"]);
  assert.equal(r.erro, undefined);
});

test("resolverPublico: A publico mas AAAA para ::1 e recusado", async (t) => {
  simularRede(t, dns({ "golpe.com.br": { A: ["93.184.216.34"], AAAA: ["::1"] } }));
  assert.equal((await resolverPublico(new Orcamento(10), "golpe.com.br")).erro, "ip_privado");
});

test("resolverPublico: so AAAA privado (fd00::/8) e recusado; so AAAA publico passa", async (t) => {
  simularRede(t, dns({ "a.com.br": { AAAA: ["fd00::5"] }, "b.com.br": { AAAA: ["2606:4700::1"] } }));
  assert.equal((await resolverPublico(new Orcamento(10), "a.com.br")).erro, "ip_privado");
  assert.equal((await resolverPublico(new Orcamento(10), "b.com.br")).erro, undefined);
});

test("resolverPublico: nip.io apontando para o metadata da nuvem e nome sem registro", async (t) => {
  simularRede(t, dns({ "169.254.169.254.nip.io": { A: ["169.254.169.254"] } }));
  assert.equal((await resolverPublico(new Orcamento(10), "169.254.169.254.nip.io")).erro, "ip_privado");
  assert.equal((await resolverPublico(new Orcamento(10), "naoexiste.com.br")).erro, "dominio_nao_resolve");
});

test("resolverPublico: falha do DoH nao vira 'dominio nao resolve'", async (t) => {
  simularRede(t, () => new Response("erro", { status: 500 }));
  assert.equal((await resolverPublico(new Orcamento(10), "loja.com.br")).erro, "dns_falhou");
});

test("verificarDestinos: salto para host que resolve em faixa privada e recusado", async (t) => {
  simularRede(t, dns({
    "loja.com.br": { A: ["93.184.216.34"] },
    "interno.exemplo.com.br": { A: ["10.0.0.8"] },
  }));
  const vistos = new Set(["loja.com.br"]);
  const r = await verificarDestinos(new Orcamento(20), vistos, ["https://loja.com.br/", "https://interno.exemplo.com.br/x"]);
  assert.equal(r.erro, "ip_privado");
});

test("verificarDestinos: nao resolve de novo host ja visto e limita saltos novos", async (t) => {
  const chamadas = simularRede(t, dns(Object.fromEntries(["a", "b", "c", "d", "e"].map((h) => [`${h}.com.br`, { A: ["93.184.216.34"] }]))));
  const vistos = new Set(["a.com.br"]);
  assert.deepEqual(await verificarDestinos(new Orcamento(20), vistos, ["https://a.com.br/", "https://a.com.br/outra"]), {});
  assert.equal(chamadas.length, 0);
  const r = await verificarDestinos(new Orcamento(40), vistos, ["https://b.com.br/", "https://c.com.br/", "https://d.com.br/", "https://e.com.br/", "https://f.com.br/"]);
  assert.equal(r.erro, "redirecionamentos_demais");
});

test("verificarDestinos: IP literal e nome proibido na cadeia sao recusados sem consultar DNS", async (t) => {
  const chamadas = simularRede(t, semRede);
  assert.equal((await verificarDestinos(new Orcamento(5), new Set(), ["http://169.254.169.254/latest"])).erro, "ip_nao_permitido");
  assert.equal((await verificarDestinos(new Orcamento(5), new Set(), ["http://localhost./"])).erro, "host_nao_permitido");
  assert.equal(chamadas.length, 0);
});
