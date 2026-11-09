import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAnalisar } from "../src/sitesecure/analisar.js";
import { bindingSitesecure, contexto, pedido, eventos, simularRede, semRede, dns, brCode } from "./apoio/ambiente.js";
import { instalarHtmlRewriter } from "./apoio/html.js";

const IP = "203.0.113.9";
const MARCADOR_NO_TITULO = "Loja ⟦2⟧  0;";
const PAGINA = `<html><head><title>Loja Exemplo</title></head><body><header>Loja Exemplo</header>
<a href="/produto">produto</a><a href="https://google.com/">google</a>
<script src="https://js.stripe.com/v3/"></script>
<footer>Rua das Flores 100, CEP 01001-000. contato@loja.com.br</footer></body></html>`;

const DNS_PUBLICO = {
  "loja.com.br": { A: ["93.184.216.34"] },
  "google.com": { A: ["142.250.1.1"] },
  "interno.exemplo.com.br": { A: ["10.0.0.8"] },
  "vazio.exemplo.com.br": { A: ["93.184.216.35"] },
};

const html = (corpo) => () => new Response(corpo, { headers: { "content-type": "text/html" } });
const redireciona = (destino) => () => new Response(null, { status: 302, headers: { location: destino } });

function mundo({ pagina = html(PAGINA), dnsTabela = DNS_PUBLICO } = {}) {
  const rede = dns(dnsTabela);
  return (url, init) => {
    const u = new URL(url);
    if (u.hostname.includes("cloudflare-dns.com")) return rede(url);
    if (u.hostname.endsWith("exemplo.com.br") || u.hostname === "loja.com.br") {
      if (u.pathname.includes("security.txt")) return new Response("", { status: 404 });
      if (u.protocol === "http:") return new Response(null, { status: 301, headers: { location: `https://${u.hostname}/` } });
      return pagina(u, init);
    }
    if (u.hostname === "safebrowsing.googleapis.com") return Response.json({});
    if (u.hostname === "urlhaus-api.abuse.ch") return Response.json({ query_status: "no_results" });
    return new Response("{}", { status: 404 });
  };
}

const CHAVES = { VT_API_KEY: "k", GSB_API_KEY: "k", URLHAUS_AUTH_KEY: "k", SEM_NAVEGADOR: "1" };

async function chamar(corpo, env) {
  const ctx = contexto();
  const resposta = await handleAnalisar(pedido(corpo), env, ctx, {}, IP);
  const evs = await eventos(resposta);
  await ctx.esperar();
  return { evs, laudo: evs.find((e) => e.etapa === "laudo")?.laudo, erro: evs.find((e) => e.etapa === "erro")?.erro };
}

const usoDoGlobal = (b) => b.objetos.get("global")?.armazenamento.dados.get("dia")?.n ?? 0;
const cru = (b) => JSON.stringify([...b.objetos.entries()].filter(([n]) => n.startsWith("cache:")).map(([, o]) => [...o.armazenamento.dados.entries()]));

test("site: laudo completo de ponta a ponta, cache sem a query e segunda consulta sem gastar cota", async (t) => {
  instalarHtmlRewriter(t);
  const chamadas = simularRede(t, mundo());
  const b = bindingSitesecure();
  const env = { SITESECURE_DO: b, ...CHAVES };
  const url = "https://loja.com.br/produto/12?token=abc123&cpf=52998224725";

  const primeira = await chamar({ url }, env);
  const l = primeira.laudo;
  assert.ok(l, JSON.stringify(primeira.evs.at(-1)));
  assert.equal(l.modo, "estatico");
  assert.equal(l.titulo, "Loja Exemplo");
  assert.equal(l.analiseIncompleta, false);
  assert.deepEqual(l.detalhes.fontesIndisponiveis.filter((f) => f !== "Cloudflare Radar"), []);
  assert.equal(l.url, url);
  assert.ok(chamadas.some((c) => c.includes("virustotal.com")));
  assert.ok(chamadas.some((c) => c.includes("safebrowsing")));
  assert.ok(chamadas.some((c) => c.includes("urlhaus")));
  assert.equal(usoDoGlobal(b), 1);

  const guardado = cru(b);
  assert.ok(guardado.includes("Loja Exemplo"), "o laudo foi para o cache");
  for (const segredo of ["abc123", "52998224725", "token=", "/produto/12"]) assert.ok(!guardado.includes(segredo), `cache nao deve ter ${segredo}`);

  const antes = chamadas.length;
  const segunda = await chamar({ url }, env);
  assert.equal(segunda.evs[0].etapa, "cache");
  assert.equal(segunda.laudo.url, url);
  assert.equal(segunda.laudo.titulo, "Loja Exemplo");
  assert.equal(chamadas.length, antes, "cache hit nao faz rede");
  assert.equal(usoDoGlobal(b), 1);
});

test("site: sem Safe Browsing e URLhaus o laudo sai incompleto e NAO vai para o cache de 1 h", async (t) => {
  instalarHtmlRewriter(t);
  simularRede(t, mundo());
  const b = bindingSitesecure();
  const env = { SITESECURE_DO: b, VT_API_KEY: "k", SEM_NAVEGADOR: "1" };
  const primeira = await chamar({ url: "https://loja.com.br/" }, env);
  assert.equal(primeira.laudo.analiseIncompleta, true);
  assert.ok(primeira.laudo.fontesIndisponiveis.includes("Google Safe Browsing"));
  assert.ok(!cru(b).includes("laudo"), "nada guardado no cache");

  const segunda = await chamar({ url: "https://loja.com.br/" }, { ...env, GSB_API_KEY: "k", URLHAUS_AUTH_KEY: "k" });
  assert.notEqual(segunda.evs[0].etapa, "cache");
  assert.equal(segunda.laudo.analiseIncompleta, false, "a fonte voltou: nova consulta, laudo completo");
  assert.ok(cru(b).includes("laudo"));
});

test("cache: recebedor '0', marcador literal no titulo e URL com caminho nao quebram a ida e volta", async (t) => {
  instalarHtmlRewriter(t);
  simularRede(t, mundo({ pagina: html(`<html><head><title>${MARCADOR_NO_TITULO}</title></head><body><a href="/x">x</a></body></html>`) }));
  const b = bindingSitesecure();
  const env = { SITESECURE_DO: b, ...CHAVES };
  const pix = brCode({ chave: "123e4567-e89b-12d3-a456-426614174000", recebedor: "0", cidade: "SP", valor: "10.00" });
  const corpo = { url: "https://loja.com.br/rastreio/52998224725", pix };
  const primeira = await chamar(corpo, env);
  assert.equal(primeira.evs.filter((e) => e.etapa === "laudo").length, 2);
  assert.ok(cru(b).includes("laudo"), "gravou no cache");
  assert.ok(!cru(b).includes("52998224725"));
  const segunda = await chamar(corpo, env);
  assert.equal(segunda.evs[0].etapa, "cache");
  const volta = segunda.evs.filter((e) => e.etapa === "laudo").map((e) => e.laudo);
  assert.equal(volta[0].titulo, MARCADOR_NO_TITULO);
  assert.equal(volta[0].url, corpo.url);
  assert.equal(volta[1].detalhes.pix.recebedor, "0");
  assert.equal(volta[1].detalhes.pix.cidade, "SP");
  assert.equal(volta[1].detalhes.pix.valor, "10.00");
});

test("cache corrompido nao vira 500: a analise e refeita", async (t) => {
  instalarHtmlRewriter(t);
  simularRede(t, mundo());
  const b = bindingSitesecure();
  const env = { SITESECURE_DO: b, ...CHAVES };
  await chamar({ url: "https://loja.com.br/" }, env);
  const [, objeto] = [...b.objetos.entries()].find(([n]) => n.startsWith("cache:"));
  const c = objeto.armazenamento.dados.get("c");
  c.eventos[0] = { etapa: "laudo", laudo: { titulo: "9;" } };
  objeto.armazenamento.dados.set("c", c);
  const r = await chamar({ url: "https://loja.com.br/" }, env);
  assert.ok(r.laudo);
  assert.notEqual(r.evs[0].etapa, "cache");
});

test("teto do dia: falha DEPOIS de gastar consultas nao devolve o teto; falha na resolucao inicial devolve", async (t) => {
  instalarHtmlRewriter(t);
  const b = bindingSitesecure();
  const env = { SITESECURE_DO: b, ...CHAVES };

  simularRede(t, mundo({ pagina: redireciona("https://interno.exemplo.com.br/admin") }));
  const r1 = await chamar({ url: "https://vazio.exemplo.com.br/" }, env);
  assert.equal(r1.erro, "redirecionou_para_destino_nao_permitido");
  assert.equal(usoDoGlobal(b), 1, "redirecionou para rede interna: continua contando");

  simularRede(t, mundo({ pagina: () => { throw new Error("conexao recusada"); } }));
  const r2 = await chamar({ url: "https://vazio.exemplo.com.br/outra" }, env);
  assert.equal(r2.erro, "site_inacessivel");
  assert.equal(usoDoGlobal(b), 2, "site inacessivel depois das consultas: continua contando");

  simularRede(t, mundo());
  const r3 = await chamar({ url: "https://naoexiste.exemplo.com.br/" }, env);
  assert.equal(r3.erro, "dominio_nao_resolve");
  assert.equal(usoDoGlobal(b), 2, "falha barata na resolucao inicial devolve o teto");
});

test("redirecionamento: DNS que falha e cadeia longa tem codigo proprio", async (t) => {
  instalarHtmlRewriter(t);
  const env = { SITESECURE_DO: bindingSitesecure(), ...CHAVES };
  const quebrado = mundo({ pagina: redireciona("https://quebrado.exemplo.com.br/") });
  simularRede(t, (url, init) => {
    const u = new URL(url);
    if (u.hostname.includes("cloudflare-dns.com") && u.searchParams.get("name") === "quebrado.exemplo.com.br") return new Response("", { status: 500 });
    return quebrado(url, init);
  });
  assert.equal((await chamar({ url: "https://vazio.exemplo.com.br/" }, env)).erro, "redirecionamento_dns_falhou");

  let n = 0;
  const tabela = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`h${i}.exemplo.com.br`, { A: ["93.184.216.40"] }]));
  simularRede(t, mundo({ dnsTabela: { ...DNS_PUBLICO, ...tabela }, pagina: () => new Response(null, { status: 302, headers: { location: `https://h${n++}.exemplo.com.br/` } }) }));
  assert.equal((await chamar({ url: "https://vazio.exemplo.com.br/" }, env)).erro, "redirecionamentos_demais");
});

test("rebinding: o host final e resolvido de novo mesmo que ja tenha sido visto", async (t) => {
  instalarHtmlRewriter(t);
  const env = { SITESECURE_DO: bindingSitesecure(), ...CHAVES };
  let consultasAoHost = 0;
  const base = mundo();
  simularRede(t, (url, init) => {
    const u = new URL(url);
    if (u.hostname.includes("cloudflare-dns.com") && u.searchParams.get("name") === "loja.com.br" && u.searchParams.get("type") === "A") {
      consultasAoHost++;
      if (consultasAoHost > 1) return Response.json({ Status: 0, Answer: [{ type: 1, data: "169.254.169.254" }] });
    }
    return base(url, init);
  });
  const r = await chamar({ url: "https://loja.com.br/" }, env);
  assert.equal(r.erro, "redirecionou_para_destino_nao_permitido");
  assert.ok(consultasAoHost >= 2);
});

test("security.txt que redireciona para host interno nao e buscado", async (t) => {
  instalarHtmlRewriter(t);
  const base = mundo();
  const chamadas = simularRede(t, (url, init) => {
    const u = new URL(url);
    if (u.hostname === "loja.com.br" && u.pathname.includes("security.txt")) return new Response(null, { status: 302, headers: { location: "https://interno.exemplo.com.br/security.txt" } });
    return base(url, init);
  });
  const r = await chamar({ url: "https://loja.com.br/" }, { SITESECURE_DO: bindingSitesecure(), ...CHAVES });
  assert.ok(r.laudo);
  assert.ok(!chamadas.some((c) => c.startsWith("https://interno.exemplo.com.br")), "o destino interno nunca foi buscado");
});

test("log de falha nao carrega a URL consultada", async (t) => {
  instalarHtmlRewriter(t);
  const logs = [];
  const original = console.log;
  console.log = (l) => logs.push(String(l));
  t.after(() => { console.log = original; });
  simularRede(t, mundo({ pagina: () => { throw new Error("falha em https://loja.com.br/?cpf=52998224725"); } }));
  await chamar({ url: "https://loja.com.br/?cpf=52998224725" }, { SITESECURE_DO: bindingSitesecure(), ...CHAVES });
  assert.ok(logs.some((l) => l.includes("etapa_falhou")));
  assert.ok(!logs.join("\n").includes("52998224725"));
});

const siteverify = (corpo) => (url) => (url.includes("challenges.cloudflare.com") ? Response.json(corpo) : semRede());
const ENV_TS = { TURNSTILE_SECRET: "s", TURNSTILE_MODO: "exigir" };
const corpoTs = (turnstile) => ({ url: "https://loja.com.br/", turnstile });

test("Turnstile: so token rejeitado de fato pelo siteverify conta como recusa e bloqueia o IP", async (t) => {
  simularRede(t, siteverify({ success: false, "error-codes": ["invalid-input-response"] }));
  const env = { SITESECURE_DO: bindingSitesecure(), ...ENV_TS };
  for (let i = 0; i < 3; i++) assert.equal((await handleAnalisar(pedido(corpoTs("token-lixo")), env, contexto(), {}, IP)).status, 403);
  const bloqueado = await handleAnalisar(pedido(corpoTs("token-lixo")), env, contexto(), {}, IP);
  assert.equal(bloqueado.status, 429);
  assert.equal((await eventos(bloqueado))[0].erro, "bloqueado");
});

test("Turnstile: token ausente, expirado, falta de segredo e siteverify fora do ar nao bloqueiam o IP", async (t) => {
  const env = { SITESECURE_DO: bindingSitesecure(), ...ENV_TS };
  const silencio = console.error;
  console.error = () => {};
  t.after(() => { console.error = silencio; });
  simularRede(t, semRede);
  for (let i = 0; i < 8; i++) assert.equal((await handleAnalisar(pedido({ url: "https://loja.com.br/" }), env, contexto(), {}, IP)).status, 403, "sem token");
  simularRede(t, siteverify({ success: false, "error-codes": ["timeout-or-duplicate"] }));
  for (let i = 0; i < 8; i++) assert.equal((await handleAnalisar(pedido(corpoTs("expirado")), env, contexto(), {}, IP)).status, 403, "expirado");
  for (let i = 0; i < 8; i++) assert.equal((await handleAnalisar(pedido({ url: "https://loja.com.br/" }), { SITESECURE_DO: env.SITESECURE_DO, TURNSTILE_MODO: "exigir" }, contexto(), {}, IP)).status, 403, "sem segredo");
  assert.equal(env.SITESECURE_DO.objetos.get(`ip:${IP}`)?.armazenamento.dados.get("recusas"), undefined, "nenhuma recusa registrada");
});

test("Turnstile: siteverify fora do ar recusa com 503 no modo exigir e libera no observar", async (t) => {
  const silencio = console.error;
  console.error = () => {};
  t.after(() => { console.error = silencio; });
  simularRede(t, (url) => { if (url.includes("challenges.cloudflare.com")) throw new Error("rede"); return semRede(); });
  const exigir = await handleAnalisar(pedido(corpoTs("tk")), { SITESECURE_DO: bindingSitesecure(), ...ENV_TS }, contexto(), {}, IP);
  assert.equal(exigir.status, 503);
  const ev = (await eventos(exigir))[0];
  assert.equal(ev.erro, "verificacao_indisponivel");
  const observar = await handleAnalisar(pedido(corpoTs("tk")), { SITESECURE_DO: bindingSitesecure(), TURNSTILE_SECRET: "s" }, contexto(), {}, IP);
  assert.notEqual(observar.status, 503);
  assert.notEqual(observar.status, 403);
  await observar.text();
});

test("Turnstile sem segredo: modo exigir recusa e registra erro", async (t) => {
  simularRede(t, semRede);
  const erros = [];
  const original = console.error;
  console.error = (l) => erros.push(String(l));
  t.after(() => { console.error = original; });
  const exigir = await handleAnalisar(pedido({ url: "https://loja.com.br/" }), { SITESECURE_DO: bindingSitesecure(), TURNSTILE_MODO: "exigir" }, contexto(), {}, IP);
  assert.equal(exigir.status, 403);
  assert.ok(erros.some((e) => e.includes("turnstile_sem_segredo")));
});
