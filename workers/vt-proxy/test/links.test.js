import { test } from "node:test";
import assert from "node:assert/strict";
import { classificarPorNome, destinosDoLink, classificarDestinos } from "../src/sitesecure/links.js";
import { Orcamento } from "../src/sitesecure/util.js";
import { simularRede, semRede } from "./apoio/ambiente.js";

test("adulto: palavra inteira casa, sexta e sextante nao", () => {
  assert.equal(classificarPorNome("sexta.com.br"), null);
  assert.equal(classificarPorNome("sextante.com.br"), null);
  assert.equal(classificarPorNome("sexologia.com.br"), null);
  assert.equal(classificarPorNome("essex.com.br"), null);
  assert.equal(classificarPorNome("sex.com")?.nivel, "medio");
  assert.equal(classificarPorNome("sexo-online.com.br")?.motivo, "possível conteúdo adulto (pelo nome do domínio)");
  assert.equal(classificarPorNome("xvideos.com")?.nivel, "medio");
  assert.equal(classificarPorNome("xxx1.com")?.nivel, "medio");
  assert.equal(classificarPorNome("privacy.com.br")?.nivel, "medio");
  assert.equal(classificarPorNome("meuprivacy.com.br"), null);
});

test("aposta: palavra inteira casa, apostila e nomes comuns nao", () => {
  assert.equal(classificarPorNome("apostila.com.br"), null);
  assert.equal(classificarPorNome("bingol.com.br"), null);
  assert.equal(classificarPorNome("pokerface.com.br"), null);
  assert.equal(classificarPorNome("alphabet.com"), null);
  assert.equal(classificarPorNome("slotmachine.com"), null);
  assert.equal(classificarPorNome("apostas.com")?.nivel, "medio");
  assert.equal(classificarPorNome("bet365.com")?.nivel, "medio");
  assert.equal(classificarPorNome("7bet.com")?.nivel, "medio");
  assert.equal(classificarPorNome("fortune-tiger.com")?.nivel, "medio");
  assert.equal(classificarPorNome("cassino-brasil.com")?.nivel, "medio");
  assert.equal(classificarPorNome("exemplo.bet.br")?.nivel, "medio");
});

test("destinosDoLink: ?url= em link comum nao esconde o destino real", () => {
  assert.deepEqual(destinosDoLink("https://golpe.com/?url=https://google.com"), ["https://golpe.com/?url=https://google.com"]);
  assert.deepEqual(destinosDoLink("https://google.com/search?q=x&u=https://x.com"), ["https://google.com/search?q=x&u=https://x.com"]);
  assert.deepEqual(destinosDoLink("nao e url"), ["nao e url"]);
});

test("destinosDoLink: redirecionador de anuncio conhecido repassa o destino do parametro", () => {
  assert.deepEqual(destinosDoLink("https://www.googleadservices.com/pagead/aclk?adurl=https://loja.com.br/oferta"), ["https://loja.com.br/oferta"]);
  assert.deepEqual(destinosDoLink("https://l.facebook.com/l.php?u=https://loja.com.br/"), ["https://loja.com.br/"]);
  assert.deepEqual(destinosDoLink("https://www.google.com/aclk?adurl=https://loja.com.br/"), ["https://loja.com.br/"]);
  assert.deepEqual(destinosDoLink("https://www.googleadservices.com/pagead/aclk?x=1"), ["https://www.googleadservices.com/pagead/aclk?x=1"]);
});

test("classificarDestinos: golpe.com atras de ?url=google.com aparece no laudo e vai ao Safe Browsing", async (t) => {
  simularRede(t, semRede);
  const links = [
    { href: "https://golpe.com/?url=https://google.com", zona: "corpo", anuncio: false },
    { href: "https://loja.com.br/interno", zona: "corpo", anuncio: false },
  ];
  const itens = await classificarDestinos(new Orcamento(0), {}, links, "loja.com.br");
  const raizes = itens.map((i) => i.raiz);
  assert.ok(raizes.includes("golpe.com"));
  assert.ok(!raizes.includes("google.com"));
  assert.ok(itens.find((i) => i.raiz === "golpe.com").exemplos[0].startsWith("https://golpe.com/"));
});

test("classificarDestinos: sexta.com.br e milestone.com.br nao sao rebaixados por nome", async (t) => {
  simularRede(t, semRede);
  const links = ["https://sexta.com.br/x", "https://milestone.com.br/y", "https://sex.com/z"].map((href) => ({ href, zona: "corpo", anuncio: false }));
  const itens = await classificarDestinos(new Orcamento(0), {}, links, "loja.com.br");
  const nivel = (r) => itens.find((i) => i.raiz === r).nivel;
  assert.equal(nivel("sex.com"), "medio");
  assert.equal(nivel("sexta.com.br"), "neutro");
  assert.equal(nivel("milestone.com.br"), "neutro");
});

test("classificarDestinos: nome suspeito fica em medio e so a categoria do Radar o leva a baixo", async (t) => {
  simularRede(t, (url) => {
    const dominio = decodeURIComponent(url.split("/domain/")[1] || "");
    const categorias = { "cassino-brasil.com": ["Gambling"], "casino-estoril.pt": ["Travel"] }[dominio] || [];
    return Response.json({ success: true, result: { details_0: { rank: 5000, categories: categorias.map((name) => ({ name })) } } });
  });
  const links = ["https://cassino-brasil.com/", "https://casino-estoril.pt/", "https://sex-education.com/"].map((href) => ({ href, zona: "corpo", anuncio: false }));
  const itens = await classificarDestinos(new Orcamento(40), { CF_RADAR_TOKEN: "t" }, links, "loja.com.br");
  const item = (r) => itens.find((i) => i.raiz === r);
  assert.equal(item("cassino-brasil.com").nivel, "baixo");
  assert.match(item("cassino-brasil.com").motivo, /Gambling/);
  assert.equal(item("casino-estoril.pt").nivel, "medio");
  assert.equal(item("sex-education.com").nivel, "medio");
});
