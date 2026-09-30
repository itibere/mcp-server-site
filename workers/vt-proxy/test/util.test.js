// Domínio raiz: plataformas com subdomínio livre precisam ser tratadas como
// sufixo público, senão o subdomínio herda idade e reputação da plataforma.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dominioRaiz, ehPlataforma } from "../src/sitesecure/util.js";

test("ehPlataforma: só subdomínio de plataforma, não o domínio da plataforma nem domínio comum", () => {
  assert.equal(ehPlataforma("testsafebrowsing.appspot.com"), true);
  assert.equal(ehPlataforma("meusite.github.io"), true);
  assert.equal(ehPlataforma("appspot.com"), false);
  assert.equal(ehPlataforma("kabum.com.br"), false);
  assert.equal(ehPlataforma("loja.com.br"), false);
});

test("domínio comum: últimos dois rótulos", () => {
  assert.equal(dominioRaiz("www.kabum.com.br"), "kabum.com.br");
  assert.equal(dominioRaiz("loja.exemplo.com"), "exemplo.com");
});

test("plataformas de subdomínio livre: o subdomínio é a raiz", () => {
  assert.equal(dominioRaiz("testsafebrowsing.appspot.com"), "testsafebrowsing.appspot.com");
  assert.equal(dominioRaiz("www.meusite.github.io"), "meusite.github.io");
  assert.equal(dominioRaiz("app.run.app"), "app.run.app");
  assert.equal(dominioRaiz("loja.myshopify.com"), "loja.myshopify.com");
});

test("ponto final e caixa alta são ignorados", () => {
  assert.equal(dominioRaiz("WWW.Kabum.com.br."), "kabum.com.br");
});
