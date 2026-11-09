import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAnalisar, validarEntrada } from "../src/sitesecure/analisar.js";
import { bindingSitesecure, contexto, pedido, eventos, simularRede, semRede, dns, brCode } from "./apoio/ambiente.js";

const ALEATORIA = "123e4567-e89b-12d3-a456-426614174000";

async function chamar(corpo, env, opcoes) {
  const ctx = contexto();
  const resposta = await handleAnalisar(pedido(corpo, opcoes), env, ctx, {}, "203.0.113.9");
  const evs = resposta.status === 200 || resposta.headers.get("content-type")?.includes("ndjson") ? await eventos(resposta) : [];
  await ctx.esperar();
  return { resposta, evs, status: resposta.status };
}

const usoDoGlobal = (b) => b.objetos.get("global")?.armazenamento.dados.get("dia")?.n ?? 0;
const chamadasDeConsumo = (b) => b.chamadas.filter((c) => c.caminho.endsWith("/consumir")).length;

test("validarEntrada: URL, PIX e formato do corpo", () => {
  assert.equal(validarEntrada(null).erro, "corpo_invalido");
  assert.equal(validarEntrada([]).erro, "corpo_invalido");
  assert.equal(validarEntrada("texto").erro, "corpo_invalido");
  assert.equal(validarEntrada({}).erro, "url_invalida");
  assert.equal(validarEntrada({ url: 42 }).erro, "url_invalida");
  assert.equal(validarEntrada({ pix: 42 }).erro, "pix_invalido");
  assert.equal(validarEntrada({ pix: "x".repeat(1025) }).erro, "pix_invalido");
  assert.equal(validarEntrada({ pix: "isto nao e pix" }).erro, "pix_invalido");
  assert.equal(validarEntrada({ url: "http://localhost./" }).erro, "host_nao_permitido");
  const ok = validarEntrada({ url: " LOJA.com.br/p#x ", pix: brCode({ chave: ALEATORIA }) });
  assert.equal(ok.url.toString(), "https://loja.com.br/p");
  assert.equal(ok.brCode.valido, true);
});

test("corpo acima de 4 KB e recusado antes de qualquer cota ou Durable Object", async (t) => {
  simularRede(t, semRede);
  const b = bindingSitesecure();
  const { status, evs } = await chamar({ url: "https://loja.com.br/", lixo: "x".repeat(5000) }, { SITESECURE_DO: b });
  assert.equal(status, 413);
  assert.equal(evs[0].erro, "corpo_grande");
  assert.equal(b.chamadas.length, 0);
});

test("corpo acima de 4 KB com Content-Length declarado tambem e recusado", async (t) => {
  simularRede(t, semRede);
  const b = bindingSitesecure();
  const ctx = contexto();
  const req = new Request("https://api.itibere.tec.br/sitesecure/analisar", { method: "POST", headers: { "Content-Length": "9000" }, body: "{}" });
  const r = await handleAnalisar(req, { SITESECURE_DO: b }, ctx, {}, "1.2.3.4");
  assert.equal(r.status, 413);
  assert.equal(b.chamadas.length, 0);
});

test("JSON invalido e corpo vazio nao consomem nada", async (t) => {
  simularRede(t, semRede);
  const b = bindingSitesecure();
  const env = { SITESECURE_DO: b };
  const a = await chamar("{nao e json", env, { bruto: true });
  assert.equal(a.status, 400);
  assert.equal(a.evs[0].erro, "corpo_invalido");
  const c = await chamar("null", env, { bruto: true });
  assert.equal(c.evs[0].erro, "corpo_invalido");
  assert.equal(b.chamadas.length, 0);
});

test("entradas hostis: sem cota, sem Durable Object, sem rede", async (t) => {
  const chamadasRede = simularRede(t, semRede);
  const b = bindingSitesecure();
  const env = { SITESECURE_DO: b };
  const hostis = [
    ["http://localhost./", "host_nao_permitido"],
    ["http://127.0.0.1/", "ip_nao_permitido"],
    ["http://[::1]/", "ip_nao_permitido"],
    ["http://169.254.169.254/latest/meta-data", "ip_nao_permitido"],
    ["file:///etc/passwd", "protocolo_nao_permitido"],
    ["ftp://loja.com.br/", "protocolo_nao_permitido"],
    ["https://usuario:senha@loja.com.br/", "url_com_credenciais"],
    ["https://loja.com.br:8080/", "porta_nao_permitida"],
    ["https://intranet.corp/", "host_nao_permitido"],
    ["", "url_invalida"],
  ];
  for (const [url, erro] of hostis) {
    const r = await chamar({ url }, env);
    assert.equal(r.status, 400, url);
    assert.equal(r.evs[0].erro, erro, url);
  }
  assert.equal(chamadasRede.length, 0);
  assert.equal(b.chamadas.length, 0, "nenhuma chamada a guarda");
  assert.equal(usoDoGlobal(b), 0);
});

test("PIX invalido nao consome o teto diario", async (t) => {
  simularRede(t, semRede);
  const b = bindingSitesecure();
  const r = await chamar({ pix: "000201 isto foi cortado" }, { SITESECURE_DO: b });
  assert.equal(r.status, 400);
  assert.equal(r.evs[0].erro, "pix_invalido");
  assert.equal(chamadasDeConsumo(b), 0);
  assert.equal(usoDoGlobal(b), 0);
});

test("dominio que nao resolve: a analise falha e o teto do dia e devolvido", async (t) => {
  simularRede(t, dns({}));
  const b = bindingSitesecure();
  const r = await chamar({ url: "https://naoexiste.com.br/" }, { SITESECURE_DO: b });
  assert.equal(r.evs.at(-1).erro, "dominio_nao_resolve");
  assert.equal(usoDoGlobal(b), 0, "teto do dia so cai com analise concluida");
  assert.equal(b.objetos.get("ip:203.0.113.9").armazenamento.dados.get("dia").n, 1, "o IP continua pagando a tentativa");
});

test("host que resolve para faixa privada (AAAA ::1) e recusado e nao gasta o teto", async (t) => {
  simularRede(t, dns({ "golpe.com.br": { A: ["93.184.216.34"], AAAA: ["::1"] } }));
  const b = bindingSitesecure();
  const r = await chamar({ url: "https://golpe.com.br/" }, { SITESECURE_DO: b });
  assert.equal(r.evs.at(-1).erro, "ip_privado");
  assert.equal(usoDoGlobal(b), 0);
});

test("falha do Durable Object na cota: 503 sem vazar mensagem interna", async (t) => {
  simularRede(t, semRede);
  const quebrado = { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error("SQLITE_FULL /var/interno"); } }) };
  const r = await chamar({ url: "https://loja.com.br/" }, { SITESECURE_DO: quebrado });
  assert.equal(r.status, 503);
  assert.equal(r.evs[0].erro, "servico_indisponivel");
  assert.ok(!JSON.stringify(r.evs).includes("SQLITE"));
  assert.ok(!JSON.stringify(r.evs).includes("interno"));
});

test("IP bloqueado e recusado antes do Turnstile e do cache", async (t) => {
  simularRede(t, semRede);
  const b = bindingSitesecure();
  const env = { SITESECURE_DO: b };
  b.get("ip:203.0.113.9");
  b.objetos.get("ip:203.0.113.9").armazenamento.dados.set("bloqueioAte", Date.now() + 3_600_000);
  const r = await chamar({ url: "https://loja.com.br/" }, env);
  assert.equal(r.status, 429);
  assert.equal(r.evs[0].erro, "bloqueado");
  assert.equal(usoDoGlobal(b), 0);
});

test("Turnstile no modo exigir sem token recusa antes de gastar cota", async (t) => {
  simularRede(t, semRede);
  const b = bindingSitesecure();
  const r = await chamar({ url: "https://loja.com.br/" }, { SITESECURE_DO: b, TURNSTILE_SECRET: "segredo", TURNSTILE_MODO: "exigir" });
  assert.equal(r.status, 403);
  assert.equal(r.evs[0].erro, "verificacao_humana");
  assert.equal(chamadasDeConsumo(b), 0);
});

test("PIX: cache nao guarda recebedor, cidade nem valor; a segunda consulta vem do cache sem gastar cota", async (t) => {
  simularRede(t, semRede);
  const b = bindingSitesecure();
  const env = { SITESECURE_DO: b };
  const pix = brCode({ chave: ALEATORIA, recebedor: "MARIA APARECIDA SOUZA", cidade: "RECIFE", valor: "123.45" });

  const primeira = await chamar({ pix }, env);
  const laudo1 = primeira.evs.find((e) => e.etapa === "laudo").laudo;
  assert.equal(laudo1.tipo, "pix");
  assert.equal(laudo1.detalhes.pix.recebedor, "MARIA APARECIDA SOUZA");
  assert.equal(usoDoGlobal(b), 1);

  const guardado = JSON.stringify([...b.objetos.entries()].filter(([n]) => n.startsWith("cache:")).map(([, o]) => [...o.armazenamento.dados.entries()]));
  assert.ok(guardado.includes("laudo"), "o laudo foi para o cache");
  for (const segredo of ["MARIA", "SOUZA", "RECIFE", "123.45", ALEATORIA]) assert.ok(!guardado.includes(segredo), `cache nao deve ter ${segredo}`);

  const consumosAntes = chamadasDeConsumo(b);
  const segunda = await chamar({ pix }, env);
  assert.equal(segunda.evs[0].etapa, "cache");
  const laudo2 = segunda.evs.find((e) => e.etapa === "laudo").laudo;
  assert.equal(laudo2.detalhes.pix.recebedor, "MARIA APARECIDA SOUZA");
  assert.equal(laudo2.detalhes.pix.cidade, "RECIFE");
  assert.equal(laudo2.detalhes.pix.valor, "123.45");
  assert.equal(laudo2.doCache > 0, true);
  assert.equal(chamadasDeConsumo(b), consumosAntes, "cache hit nao cobra cota");
  assert.equal(usoDoGlobal(b), 1);
});

test("PIX dinamico sem Safe Browsing: Analise incompleta, nunca 'Parece segura'", async (t) => {
  simularRede(t, (url) => {
    const u = new URL(url);
    if (u.hostname.includes("cloudflare-dns.com")) return Response.json({ Status: 0, Answer: [] });
    return semRede();
  });
  const pix = brCode({ psp: "pix.exemplo-psp.com.br/qr/v2/abc123" });
  const r = await chamar({ pix }, { SITESECURE_DO: bindingSitesecure() });
  const laudo = r.evs.find((e) => e.etapa === "laudo").laudo;
  assert.deepEqual(laudo.fontesIndisponiveis, ["Google Safe Browsing"]);
  assert.equal(laudo.analiseIncompleta, true);
  assert.notEqual(laudo.nota, "bom");
  assert.notEqual(laudo.notaRotulo, "Parece segura");
});

test("falha interna nao expõe a mensagem do erro", async (t) => {
  simularRede(t, () => { throw new Error("segredo interno do runtime"); });
  const b = bindingSitesecure();
  const r = await chamar({ url: "https://loja.com.br/" }, { SITESECURE_DO: b });
  const txt = JSON.stringify(r.evs);
  assert.ok(!txt.includes("segredo interno"));
  assert.equal(usoDoGlobal(b), 0, "sem laudo, o teto e devolvido");
});

test("sem binding da guarda (dev local) a analise segue sem cota", async (t) => {
  simularRede(t, dns({}));
  const r = await chamar({ url: "https://naoexiste.com.br/" }, {});
  assert.equal(r.evs.at(-1).erro, "dominio_nao_resolve");
});
