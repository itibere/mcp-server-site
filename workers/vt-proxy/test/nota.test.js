// Testes das regras de nota (src/sitesecure/nota.js) com dados fixos, sem rede
// e sem gastar cota. Rodar: npm test
//
// Cada cenario descreve um tipo de site pelas evidencias que o analisar.js
// coletaria e diz a nota esperada. Quando uma regra for recalibrada de
// proposito, ajuste o cenario junto: o teste documenta a decisao.
import { test } from "node:test";
import assert from "node:assert/strict";
import { notaReputacao, notaLinks, notaPropagandas, notaHeaderFooter, notaFinal } from "../src/sitesecure/nota.js";

const HARDENING_BOM = { itens: { https: true }, pontos: 5, faltando: ["csp"], certificado: { diasParaVencer: 90 } };
const HARDENING_FRACO = { itens: { https: true }, pontos: 2, faltando: ["csp", "hsts", "nosniff", "referrerPolicy"], certificado: { diasParaVencer: 90 } };
const BOAS_BOM = { cumpridos: 8, total: 10, proporcao: 0.8, faltandoConsumidor: [] };
const BOAS_MEDIO = { cumpridos: 7, total: 10, proporcao: 0.7, faltandoConsumidor: [] };

// Loja grande e antiga, tudo em ordem.
function lojaBoa(sobre = {}) {
  return {
    rep: {
      rdap: { idadeDias: 4000 }, vt: { disponivel: true, conhecido: true, maliciosos: 0, suspeitos: 0, total: 70 },
      gsbSite: [], urlhaus: { listado: false }, dns: { politicaDmarc: "reject", spfRestritivo: true },
      hardening: HARDENING_BOM, httpsRedirect: true,
      empresa: { encontrado: true, ativa: true, cnpj: "00.000.000/0001-00", razaoSocial: "Loja Exemplo SA", idadeDias: 8000 },
      pagamento: { plataforma: "checkout" }, pix: null, reclameAqui: { verificado: false },
      governo: null, imitacao: null, radarSite: { estabelecido: true, posicao: 900 }, boas: BOAS_BOM, raiz: "loja.com.br",
    },
    links: { destinos: [{ anuncio: false, nivel: "bom", raiz: "google.com", zonas: ["body"] }], gsbLinks: [], redirecionamento: null },
    ads: { existe: false, verificavel: true, redes: { arriscadas: [], confiaveis: [] }, anunciantes: [] },
    hf: {
      host: { nome: "AWS", organizacao: "Amazon", tier: "bom" }, cnpjInfo: { cnpj: "00000000000100", origem: "rodapé" },
      empresa: { encontrado: true, ativa: true, cnpj: "00.000.000/0001-00", razaoSocial: "Loja Exemplo SA", idadeDias: 8000 },
      condiz: true, pagamento: { plataforma: "checkout" }, destinos: [], coleta: { temFooter: true }, rdap: {}, governo: null, boas: BOAS_BOM, raiz: "loja.com.br",
    },
    ...sobre,
  };
}

// Aplica as mesmas quatro notas do analisar.js e a nota final.
function avaliar(c, ajustes = {}) {
  const cen = { ...c, rep: { ...c.rep, ...ajustes.rep }, links: { ...c.links, ...ajustes.links }, ads: ajustes.ads ?? c.ads, hf: { ...c.hf, ...ajustes.hf } };
  const blocos = {
    reputacao: notaReputacao(cen.rep),
    links: notaLinks(cen.links),
    propagandas: notaPropagandas(cen.ads),
    headerFooter: notaHeaderFooter(cen.hf),
  };
  return { blocos, final: notaFinal(blocos) };
}

const tem = (bloco, trecho) => bloco.alertas.some((a) => a.includes(trecho));

test("loja grande e antiga com tudo em ordem: bom", () => {
  const r = avaliar(lojaBoa());
  assert.equal(r.final, "bom");
  for (const b of Object.values(r.blocos)) assert.equal(b.nivel, "bom");
});

test("site de governo limpo, sem CNPJ: bom", () => {
  const r = avaliar(lojaBoa(), {
    rep: { governo: { governo: true, esfera: "federal" }, empresa: null, pagamento: null, radarSite: null, raiz: "orgao.gov.br" },
    hf: { governo: { governo: true, esfera: "federal" }, cnpjInfo: null, empresa: null, pagamento: null, raiz: "orgao.gov.br" },
  });
  assert.equal(r.final, "bom");
});

test("site de governo com Safe Browsing: baixo e alerta de possível invasão em primeiro", () => {
  const r = avaliar(lojaBoa(), {
    rep: { governo: { governo: true, esfera: "federal" }, gsbSite: ["https://orgao.gov.br/"], raiz: "orgao.gov.br" },
  });
  assert.equal(r.final, "baixo");
  assert.match(r.blocos.reputacao.alertas[0], /possível invasão/);
});

test("Safe Browsing marca o site: baixo", () => {
  const r = avaliar(lojaBoa(), { rep: { gsbSite: ["https://loja.com.br/"] } });
  assert.equal(r.final, "baixo");
});

test("VirusTotal: 2 engines maliciosos = baixo, 1 = médio (bloco), 0 = bom", () => {
  const vt = (m) => ({ disponivel: true, conhecido: true, maliciosos: m, suspeitos: 0, total: 70 });
  assert.equal(avaliar(lojaBoa(), { rep: { vt: vt(2) } }).blocos.reputacao.nivel, "baixo");
  assert.equal(avaliar(lojaBoa(), { rep: { vt: vt(1) } }).blocos.reputacao.nivel, "medio");
  assert.equal(avaliar(lojaBoa(), { rep: { vt: vt(0) } }).blocos.reputacao.nivel, "bom");
});

test("um único bloco médio não derruba a nota final", () => {
  const r = avaliar(lojaBoa(), { rep: { vt: { disponivel: true, conhecido: true, maliciosos: 1, suspeitos: 0, total: 70 } } });
  assert.equal(r.blocos.reputacao.nivel, "medio");
  assert.equal(r.final, "bom");
});

test("dois blocos médios: nota final média", () => {
  const r = avaliar(lojaBoa(), {
    rep: { vt: { disponivel: true, conhecido: true, maliciosos: 1, suspeitos: 0, total: 70 } },
    links: { destinos: [{ anuncio: false, nivel: "bom", raiz: "x.com", zonas: [] }, { anuncio: false, nivel: "neutro", raiz: "bit.ly", encurtado: true, zonas: [] }] },
  });
  assert.equal(r.final, "medio");
});

test("domínio de 10 dias: baixo sem hardening, médio com hardening", () => {
  const novo = { rdap: { idadeDias: 10 }, radarSite: null, vt: { disponivel: true, conhecido: false } };
  assert.equal(avaliar(lojaBoa(), { rep: { ...novo, hardening: HARDENING_FRACO } }).blocos.reputacao.nivel, "baixo");
  assert.equal(avaliar(lojaBoa(), { rep: { ...novo, hardening: HARDENING_BOM } }).blocos.reputacao.nivel, "medio");
});

test("domínio de 200 dias e desconhecido: médio no bloco (menos de 1 ano)", () => {
  const r = avaliar(lojaBoa(), { rep: { rdap: { idadeDias: 200 }, radarSite: null } });
  assert.ok(tem(r.blocos.reputacao, "menos de 1 ano"));
  assert.equal(r.blocos.reputacao.nivel, "medio");
});

test("domínio de 200 dias mas popular no Radar: não pesa", () => {
  const r = avaliar(lojaBoa(), { rep: { rdap: { idadeDias: 200 } } });
  assert.equal(r.blocos.reputacao.nivel, "bom");
});

test("site sem HTTPS: baixo", () => {
  const r = avaliar(lojaBoa(), { rep: { hardening: { itens: { https: false }, pontos: 0, faltando: [] } } });
  assert.equal(r.final, "baixo");
});

test("certificado vencendo em 3 dias: médio no bloco", () => {
  const r = avaliar(lojaBoa(), { rep: { hardening: { ...HARDENING_BOM, certificado: { diasParaVencer: 3 } } } });
  assert.equal(r.blocos.reputacao.nivel, "medio");
});

test("dois alertas leves viram médio; com 60%+ das boas práticas viram observação", () => {
  const leves = { rdap: null, vt: { disponivel: true, conhecido: false }, radarSite: null };
  assert.equal(avaliar(lojaBoa(), { rep: { ...leves, boas: { ...BOAS_BOM, proporcao: 0.4 } } }).blocos.reputacao.nivel, "medio");
  const aliviado = avaliar(lojaBoa(), { rep: { ...leves, boas: BOAS_MEDIO } });
  assert.equal(aliviado.blocos.reputacao.nivel, "bom");
  assert.ok(aliviado.blocos.reputacao.observacoes.length >= 2);
});

test("Reclame Aqui não lido não rebaixa a loja", () => {
  const r = avaliar(lojaBoa());
  assert.ok(r.blocos.reputacao.observacoes.some((o) => o.includes("Reclame Aqui")));
  assert.equal(r.blocos.reputacao.nivel, "bom");
});

test("apostas: fora de .bet.br é baixo; em .bet.br não vira baixo", () => {
  const fora = avaliar(lojaBoa(), { rep: { radarSite: { estabelecido: false, categoriaRuim: "Gambling" }, raiz: "cassino.com" } });
  assert.equal(fora.blocos.reputacao.nivel, "baixo");
  const dentro = avaliar(lojaBoa(), { rep: { radarSite: { estabelecido: false, categoriaRuim: "Gambling" }, raiz: "casa.bet.br" } });
  assert.notEqual(dentro.blocos.reputacao.nivel, "baixo");
});

test("imitação de marca: baixo se o domínio tem menos de 1 ano, médio se for antigo", () => {
  const jovem = avaliar(lojaBoa(), { rep: { imitacao: "imita banco X", rdap: { idadeDias: 30 }, radarSite: null } });
  assert.equal(jovem.blocos.reputacao.nivel, "baixo");
  const velho = avaliar(lojaBoa(), { rep: { imitacao: "imita banco X" } });
  assert.equal(velho.blocos.reputacao.nivel, "medio");
});

test("loja .br com pagamento e sem CNPJ: baixo; site estrangeiro: só observação", () => {
  const br = avaliar(lojaBoa(), { hf: { cnpjInfo: null, empresa: null, raiz: "loja.com.br" } });
  assert.equal(br.blocos.headerFooter.nivel, "baixo");
  const fora = avaliar(lojaBoa(), { hf: { cnpjInfo: null, empresa: null, raiz: "shop.com" } });
  assert.equal(fora.blocos.headerFooter.nivel, "bom");
});

test("CNPJ inexistente na Receita: baixo; empresa aberta há 60 dias: médio", () => {
  const inex = avaliar(lojaBoa(), { hf: { empresa: { encontrado: false } } });
  assert.equal(inex.blocos.headerFooter.nivel, "baixo");
  const recente = avaliar(lojaBoa(), { hf: { empresa: { encontrado: true, ativa: true, cnpj: "x", razaoSocial: "Loja Exemplo SA", idadeDias: 60 } } });
  assert.equal(recente.blocos.headerFooter.nivel, "medio");
});

test("hospedagem de tier baixo derruba; tier neutro é só observação", () => {
  assert.equal(avaliar(lojaBoa(), { hf: { host: { nome: "X", tier: "baixo" } } }).blocos.headerFooter.nivel, "baixo");
  assert.equal(avaliar(lojaBoa(), { hf: { host: { nome: "X", tier: "neutro" } } }).blocos.headerFooter.nivel, "bom");
});

test("propagandas: rede arriscada = baixo; anunciante neutro velho = observação; novo = médio", () => {
  const base = { existe: true, verificavel: true, redes: { arriscadas: [], confiaveis: ["google"] } };
  assert.equal(notaPropagandas({ ...base, redes: { arriscadas: ["rede-x"], confiaveis: [] }, anunciantes: [] }).nivel, "baixo");
  const velho = notaPropagandas({ ...base, anunciantes: [{ nivel: "neutro", raiz: "a.com", idadeDias: 900 }] });
  assert.equal(velho.nivel, "bom");
  assert.ok(velho.observacoes.length);
  const novo = notaPropagandas({ ...base, anunciantes: [{ nivel: "neutro", raiz: "b.com", idadeDias: 100 }] });
  assert.equal(novo.nivel, "medio");
});

test("propagandas com navegador indisponível: nível 'na' e ignorado na nota final", () => {
  const p = notaPropagandas({ existe: false, verificavel: false });
  assert.equal(p.nivel, "na");
  assert.equal(notaFinal({ a: { nivel: "bom" }, b: p }), "bom");
});

test("link malicioso no corpo: baixo; encurtador: médio", () => {
  const mau = notaLinks({ destinos: [{ anuncio: false, nivel: "baixo", raiz: "mal.com", motivo: "phishing", zonas: [] }], gsbLinks: [], redirecionamento: null });
  assert.equal(mau.nivel, "baixo");
  const enc = notaLinks({ destinos: [{ anuncio: false, nivel: "neutro", raiz: "bit.ly", encurtado: true, zonas: [] }], gsbLinks: [], redirecionamento: null });
  assert.equal(enc.nivel, "medio");
});

test("redirecionamento suspeito para outro domínio: médio; explicado: só observação", () => {
  const susp = notaLinks({ destinos: [], gsbLinks: [], redirecionamento: { suspeito: true, host: "outro.com" } });
  assert.equal(susp.nivel, "medio");
  const ok = notaLinks({ destinos: [], gsbLinks: [], redirecionamento: { suspeito: false, host: "www.loja.com", motivo: "mesma empresa" } });
  assert.equal(ok.nivel, "bom");
});

test("propagandas sem navegador: avalia o que há no HTML e avisa que o resto não foi visto", () => {
  const p = notaPropagandas({ existe: true, verificavel: false, redes: { arriscadas: [], confiaveis: ["google"] }, anunciantes: [] });
  assert.equal(p.nivel, "bom");
  assert.ok(p.observacoes.some((o) => o.includes("sem navegador")));
});
