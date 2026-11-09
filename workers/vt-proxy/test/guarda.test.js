import { test } from "node:test";
import assert from "node:assert/strict";
import { SitesecureDO, LIMITES_SITESECURE as L, agruparIp, chaveCache, ocultarSegredos, restaurarSegredos, guarda } from "../src/sitesecure/guarda.js";
import { validarUrl } from "../src/sitesecure/guard.js";
import { armazenamentoFalso, bindingSitesecure } from "./apoio/ambiente.js";

const MIN = 60_000;
const HORA = 60 * MIN;

function relogio(t, inicio = Date.parse("2026-11-09T15:00:00Z")) {
  let agora = inicio;
  const original = Date.now;
  Date.now = () => agora;
  t.after(() => { Date.now = original; });
  return { avancar: (ms) => { agora += ms; }, agora: () => agora };
}

function objeto() {
  const armazenamento = armazenamentoFalso();
  const d = new SitesecureDO({ storage: armazenamento });
  const chamar = async (caminho, init) => (await d.fetch(new Request(`https://sitesecure${caminho}`, init))).json();
  return { chamar, armazenamento, d };
}

test("IP: 5 analises por janela de 10 min, a sexta e recusada com tempo de espera", async (t) => {
  relogio(t);
  const { chamar } = objeto();
  for (let i = 0; i < L.porJanela; i++) assert.equal((await chamar("/ip/consumir")).ok, true);
  const r = await chamar("/ip/consumir");
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "rate_limit_excedido");
  assert.ok(r.tentarEm > 0 && r.tentarEm <= 600);
});

test("IP: a janela desliza e libera depois de 10 min", async (t) => {
  const rel = relogio(t);
  const { chamar } = objeto();
  for (let i = 0; i < L.porJanela; i++) await chamar("/ip/consumir");
  rel.avancar(L.janelaMs + 1000);
  assert.equal((await chamar("/ip/consumir")).ok, true);
});

test("IP: limite diario de 20 e reinicia na virada do dia de Brasilia", async (t) => {
  const rel = relogio(t, Date.parse("2026-11-09T20:00:00Z"));
  const { chamar } = objeto();
  for (let i = 0; i < L.porDia; i++) {
    assert.equal((await chamar("/ip/consumir")).ok, true, `analise ${i + 1}`);
    rel.avancar(L.janelaMs + 1000);
  }
  const r = await chamar("/ip/consumir");
  assert.equal(r.motivo, "limite_diario");
  assert.ok(r.tentarEm > 0);
  rel.avancar(r.tentarEm * 1000 + 1000);
  assert.equal((await chamar("/ip/consumir")).ok, true);
});

test("IP: 3 recusas bloqueiam por 1 h e 6 por 24 h; insistir no bloqueio conta", async (t) => {
  const rel = relogio(t);
  const { chamar } = objeto();
  for (let i = 0; i < L.porJanela; i++) await chamar("/ip/consumir");
  assert.equal((await chamar("/ip/consumir")).motivo, "rate_limit_excedido");
  assert.equal((await chamar("/ip/consumir")).motivo, "rate_limit_excedido");
  const terceira = await chamar("/ip/consumir");
  assert.equal(terceira.motivo, "bloqueado");
  assert.ok(terceira.tentarEm > 3000 && terceira.tentarEm <= 3600);
  assert.equal((await chamar("/ip/estado")).bloqueado, true);
  assert.equal((await chamar("/ip/estado")).bloqueado, true);
  const longo = await chamar("/ip/estado");
  assert.ok(longo.tentarEm > 20 * 3600, "6a recusa estende para 24 h");
  rel.avancar(25 * HORA);
  assert.equal((await chamar("/ip/estado")).bloqueado, false);
});

test("global: teto de 150 por dia e estorno devolve a vaga", async (t) => {
  relogio(t);
  const { chamar } = objeto();
  for (let i = 0; i < L.tetoGlobalDia; i++) assert.equal((await chamar("/global/consumir")).ok, true);
  const cheio = await chamar("/global/consumir");
  assert.equal(cheio.ok, false);
  assert.equal(cheio.motivo, "teto_diario");
  await chamar("/global/estornar");
  assert.equal((await chamar("/global/consumir")).ok, true);
});

test("global: estorno nunca deixa o contador negativo nem mexe no dia anterior", async (t) => {
  const rel = relogio(t);
  const { chamar, armazenamento } = objeto();
  await chamar("/global/estornar");
  assert.equal((await armazenamento.get("dia"))?.n ?? 0, 0);
  await chamar("/global/consumir");
  rel.avancar(24 * HORA);
  await chamar("/global/estornar");
  assert.equal((await armazenamento.get("dia")).n, 1);
});

test("cache: guarda por 1 h e expira", async (t) => {
  const rel = relogio(t);
  const { chamar } = objeto();
  assert.equal(await chamar("/cache/get"), null);
  await chamar("/cache/put", { method: "POST", body: JSON.stringify([{ etapa: "laudo", laudo: { nota: "bom" } }]) });
  assert.equal((await chamar("/cache/get")).eventos[0].laudo.nota, "bom");
  rel.avancar(L.cacheMs + 1000);
  assert.equal(await chamar("/cache/get"), null);
});

test("alarme apaga o estado do objeto", async () => {
  const { d, armazenamento } = objeto();
  await armazenamento.put("x", 1);
  await d.alarm();
  assert.equal(armazenamento.dados.size, 0);
});

test("agruparIp: IPv6 do mesmo /64 vira uma chave; IPv4 e mapeado seguem iguais", () => {
  const a = agruparIp("2804:14c:1234:5678::1");
  assert.equal(a, agruparIp("2804:14c:1234:5678:aaaa:bbbb:cccc:dddd"));
  assert.equal(a, agruparIp("2804:014c:1234:5678:0:0:0:2"));
  assert.notEqual(a, agruparIp("2804:14c:1234:5679::1"));
  assert.equal(a, "v6:2804:14c:1234:5678");
  assert.equal(agruparIp("203.0.113.9"), "203.0.113.9");
  assert.equal(agruparIp("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(agruparIp(""), "sem-ip");
  assert.equal(agruparIp("lixo::lixo"), "sem-ip");
});

test("chaveCache: mesma URL escrita de formas diferentes cai na mesma chave", async () => {
  const k = (u, pix) => chaveCache(validarUrl(u).url.toString(), pix);
  const base = await k("https://loja.com/");
  assert.equal(base, await k("loja.com"));
  assert.equal(base, await k("https://LOJA.com/#promo"));
  assert.notEqual(base, await k("https://loja.com/Pedido?T=Ab"));
  assert.notEqual(await k("https://loja.com/Pedido?T=Ab"), await k("https://loja.com/pedido?t=ab"));
  assert.match(base, /^[0-9a-f]{64}$/);
});

test("chaveCache: o PIX entra so como hash, sem espacos", async () => {
  const a = await chaveCache("https://a.com/", "000201 abc");
  assert.equal(a, await chaveCache("https://a.com/", "000201abc"));
  assert.ok(!a.includes("000201"));
});

test("ocultarSegredos/restaurarSegredos: ida e volta sem perda", () => {
  const eventos = [{ etapa: "laudo", laudo: { url: "https://x.com/p?cpf=123", achados: ['recebedor "MARIA SOUZA" nao condiz'], cidade: "RECIFE" } }];
  const segredos = ["https://x.com/p?cpf=123", "?cpf=123", "MARIA SOUZA", "RECIFE"];
  const oculto = ocultarSegredos(eventos, segredos);
  const txt = JSON.stringify(oculto);
  for (const s of segredos) assert.ok(!txt.includes(s), s);
  assert.deepEqual(restaurarSegredos(oculto, segredos), eventos);
});

test("guarda: falha do Durable Object vira erro fixo, sem vazar a mensagem interna", async () => {
  const env = { SITESECURE_DO: { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error("SQLITE_FULL em /var/interno/segredo"); } }) } };
  await assert.rejects(guarda.consumirIp(env, "1.2.3.4"), (e) => e.message === "guarda_indisponivel");
});

test("guarda: IPs diferentes usam objetos diferentes", async () => {
  const b = bindingSitesecure();
  const env = { SITESECURE_DO: b };
  await guarda.consumirIp(env, "1.1.1.1");
  await guarda.consumirIp(env, "2.2.2.2");
  assert.deepEqual([...b.objetos.keys()].sort(), ["ip:1.1.1.1", "ip:2.2.2.2"]);
});
