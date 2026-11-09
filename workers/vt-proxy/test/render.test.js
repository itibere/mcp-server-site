import { test } from "node:test";
import assert from "node:assert/strict";
import { coletarEstatico } from "../src/sitesecure/render.js";
import { Orcamento } from "../src/sitesecure/util.js";
import { simularRede, dns } from "./apoio/ambiente.js";

const REDE = dns({
  "loja.com.br": { A: ["93.184.216.34"] },
  "interno.exemplo.com.br": { A: ["10.0.0.8"] },
  "v6.exemplo.com.br": { A: ["93.184.216.34"], AAAA: ["fd00::1"] },
});

function redirecionador(destino) {
  return (url) => (url.includes("cloudflare-dns.com") ? REDE(url) : new Response(null, { status: 302, headers: { location: destino } }));
}

test("coletarEstatico: redirecionamento para host que resolve em IP privado e barrado antes de buscar", async (t) => {
  const chamadas = simularRede(t, redirecionador("https://interno.exemplo.com.br/admin"));
  await assert.rejects(
    coletarEstatico(new Orcamento(20), "https://loja.com.br/", new Set(["loja.com.br"])),
    (e) => e.destinoProibido === true && e.message === "ip_privado",
  );
  assert.ok(!chamadas.some((c) => c.includes("interno.exemplo.com.br/admin")), "o destino privado nunca foi buscado");
});

test("coletarEstatico: redirecionamento cujo AAAA e privado tambem e barrado", async (t) => {
  simularRede(t, redirecionador("https://v6.exemplo.com.br/"));
  await assert.rejects(coletarEstatico(new Orcamento(20), "https://loja.com.br/", new Set(["loja.com.br"])), (e) => e.destinoProibido === true);
});

test("coletarEstatico: redirecionamento para IP literal e localhost com ponto final e barrado", async (t) => {
  for (const destino of ["http://169.254.169.254/", "http://localhost./"]) {
    simularRede(t, redirecionador(destino));
    await assert.rejects(coletarEstatico(new Orcamento(20), "https://loja.com.br/", new Set(["loja.com.br"])), (e) => e.destinoProibido === true, destino);
  }
});

test("coletarEstatico: laco de redirecionamentos para", async (t) => {
  simularRede(t, redirecionador("https://loja.com.br/"));
  await assert.rejects(coletarEstatico(new Orcamento(60), "https://loja.com.br/", new Set(["loja.com.br"])), /redirecionamentos_demais/);
});
