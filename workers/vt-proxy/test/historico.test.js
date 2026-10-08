import { test } from "node:test";
import assert from "node:assert/strict";
import { linhaHistorico, registrarConsulta } from "../src/sitesecure/historico.js";

test("site: grava o dominio raiz, nunca a URL completa", () => {
  const l = linhaHistorico({
    url: "https://loja.exemplo.com.br/pedido?cpf=12345678900",
    urlFinal: "https://loja.exemplo.com.br/pedido?cpf=12345678900",
    nota: "medio",
    detalhes: { dominio: { raiz: "exemplo.com.br" }, pagamento: { pix: null } },
  });
  assert.deepEqual(l, { tipo: "site", dominio: "exemplo.com.br", instituicao: null, nota: "medio", cache: 0 });
  assert.ok(!JSON.stringify(l).includes("cpf"));
});

test("site sem raiz cai no host da URL final", () => {
  const l = linhaHistorico({ url: "https://a.com", urlFinal: "https://WWW.B.com/x", nota: "bom", detalhes: {} });
  assert.equal(l.dominio, "www.b.com");
});

test("pix: so tipo, instituicao e nota; nunca a chave nem o recebedor", () => {
  const l = linhaHistorico({
    tipo: "pix",
    nota: "baixo",
    detalhes: { pix: { chave: "***.456.789-**", recebedor: "FULANO DE TAL" }, instituicao: { nome: "BANCO X" } },
  }, { cache: true });
  assert.deepEqual(l, { tipo: "pix", dominio: null, instituicao: "BANCO X", nota: "baixo", cache: 1 });
  assert.ok(!JSON.stringify(l).includes("FULANO"));
  assert.ok(!JSON.stringify(l).includes("456"));
});

test("sem laudo ou sem nota nao grava", () => {
  assert.equal(linhaHistorico(null), null);
  assert.equal(linhaHistorico({ url: "https://a.com" }), null);
});

test("sem binding HISTORICO nao faz nada e nao falha", async () => {
  await registrarConsulta({}, { tipo: "pix", nota: "bom", detalhes: {} });
});

test("grava os campos na ordem do INSERT", async () => {
  let sql, args;
  const env = { HISTORICO: { prepare: (s) => { sql = s; return { bind: (...a) => { args = a; return { run: async () => ({}) }; } }; } } };
  await registrarConsulta(env, { tipo: "pix", nota: "bom", detalhes: { instituicao: { nome: "BANCO Y" } } });
  assert.match(sql, /INSERT INTO consultas \(em, tipo, dominio, instituicao, nota, cache\)/);
  assert.deepEqual(args.slice(1), ["pix", null, "BANCO Y", "bom", 0]);
});
