import { test } from "node:test";
import assert from "node:assert/strict";
import { linhaHistorico, registrarConsulta, limparHistorico, diaBR, diaLimiteRetencao } from "../src/sitesecure/historico.js";

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

test("data gravada e so o dia (sem horario), no fuso de Brasilia", async () => {
  let args;
  const env = { HISTORICO: { prepare: () => ({ bind: (...a) => { args = a; return { run: async () => ({}) }; } }) } };
  await registrarConsulta(env, { tipo: "pix", nota: "bom", detalhes: {} });
  assert.match(args[0], /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(diaBR(Date.parse("2026-11-10T02:30:00Z")), "2026-11-09");
  assert.equal(diaBR(Date.parse("2026-11-10T03:00:00Z")), "2026-11-10");
});

test("laudo de analise incompleta entra no historico como 'incompleta'", () => {
  const laudo = { url: "https://a.com", nota: "medio", notaRotulo: "Análise incompleta", analiseIncompleta: true, detalhes: { dominio: { raiz: "a.com" } } };
  assert.equal(linhaHistorico(laudo).nota, "incompleta");
  assert.equal(linhaHistorico({ ...laudo, nota: "baixo", notaRotulo: "Risco alto" }).nota, "baixo");
});

test("retencao: corte em 12 meses", () => {
  assert.equal(diaLimiteRetencao(Date.parse("2026-11-09T15:00:00Z")), "2025-11-09");
  assert.equal(diaLimiteRetencao(Date.parse("2026-03-01T01:00:00Z")), "2025-02-28");
});

test("limparHistorico: apaga so o que passou do corte e nunca falha", async () => {
  let sql, args;
  const env = { HISTORICO: { prepare: (s) => { sql = s; return { bind: (...a) => { args = a; return { run: async () => ({}) }; } }; } } };
  await limparHistorico(env, Date.parse("2026-11-09T15:00:00Z"));
  assert.equal(sql, "DELETE FROM consultas WHERE em < ?");
  assert.deepEqual(args, ["2025-11-09"]);
  await limparHistorico({});
  await limparHistorico({ HISTORICO: { prepare: () => { throw new Error("d1 fora"); } } });
});
