import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { bindingLimitador, bindingSitesecure, contexto, pedido, simularRede, semRede } from "./apoio/ambiente.js";

const HASH = "d41d8cd98f00b204e9800998ecf8427e";
const IP = { "CF-Connecting-IP": "203.0.113.9" };

function vt(url) {
  if (url.includes("virustotal.com")) return new Response("{}", { status: 404 });
  return semRede();
}

function chamar(caminho, corpo, env, { metodo = "POST", headers = IP, bruto = false } = {}) {
  const req = metodo === "GET"
    ? new Request(`https://api.itibere.tec.br${caminho}`, { headers })
    : pedido(corpo, { url: `https://api.itibere.tec.br${caminho}`, headers, bruto });
  return worker.fetch(req, { VT_API_KEY: "k", ...env }, contexto());
}

const diaDoIp = (limitador, ip = "203.0.113.9") => limitador.objetos.get(`vt-dia:${ip}`)?.armazenamento.dados.get("contador")?.contagem ?? 0;

test("/hash: consulta valida passa e conta no limite diario", async (t) => {
  simularRede(t, vt);
  const limitador = bindingLimitador();
  const r = await chamar("/hash", { hash: HASH }, { RATE_LIMITER_DO: limitador });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { found: false });
  assert.equal(diaDoIp(limitador), 1);
});

test("/hash e /url: entrada invalida nao consome o limite diario nem o teto", async (t) => {
  const rede = simularRede(t, semRede);
  const limitador = bindingLimitador();
  const env = { RATE_LIMITER_DO: limitador };
  for (const [caminho, corpo] of [["/hash", { hash: "zzz" }], ["/hash", {}], ["/hash", { hash: 5 }], ["/url", { url: "ftp://x.com" }], ["/url", { url: "nao e url" }], ["/url", {}], ["/url", { url: "https://a.com/" + "x".repeat(2100) }]]) {
    const r = await chamar(caminho, corpo, env);
    assert.equal(r.status, 400, `${caminho} ${JSON.stringify(corpo).slice(0, 40)}`);
  }
  assert.equal(diaDoIp(limitador), 0);
  assert.equal(limitador.objetos.has("vt-teto-dia"), false);
  assert.equal(rede.length, 0);
});

test("/hash e /url: corpo acima de 4 KB e JSON invalido sao recusados sem rede", async (t) => {
  const rede = simularRede(t, semRede);
  const env = { RATE_LIMITER_DO: bindingLimitador() };
  const grande = await chamar("/hash", { hash: HASH, lixo: "x".repeat(5000) }, env);
  assert.equal(grande.status, 413);
  const ruim = await chamar("/url", "{quebrado", env, { bruto: true });
  assert.equal(ruim.status, 400);
  assert.equal(rede.length, 0);
});

test("/hash e /url: limite diario de 10 por IP sem Turnstile (modo observar)", async (t) => {
  simularRede(t, vt);
  const limitador = bindingLimitador();
  const env = { RATE_LIMITER_DO: limitador };
  let agora = Date.parse("2026-11-09T15:00:00Z");
  const original = Date.now;
  Date.now = () => agora;
  t.after(() => { Date.now = original; });
  for (let i = 0; i < 10; i++) {
    assert.equal((await chamar("/hash", { hash: HASH }, env)).status, 200, `consulta ${i + 1}`);
    if (i % 5 === 4) agora += 61_000;
  }
  const r = await chamar("/hash", { hash: HASH }, env);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, "limite_diario");
});

test("/hash e /url: teto diario geral", async (t) => {
  simularRede(t, vt);
  const limitador = bindingLimitador();
  const env = { RATE_LIMITER_DO: limitador };
  limitador.get("vt-teto-dia:hash");
  limitador.objetos.get("vt-teto-dia:hash").armazenamento.dados.set("contador", { janela: Math.floor(Date.now() / 86_400_000), contagem: 60 });
  const r = await chamar("/hash", { hash: HASH }, env);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, "teto_diario");
  const outraRota = await chamar("/url", { url: "https://exemplo.com.br/" }, env);
  assert.notEqual(outraRota.status, 503, "o teto de /hash nao derruba /url");
});

function relogio(t) {
  let agora = Date.parse("2026-11-09T15:00:00Z");
  const original = Date.now;
  Date.now = () => agora;
  t.after(() => { Date.now = original; });
  return (ms = 61_000) => { agora += ms; };
}

const contagem = (limitador, chave) => limitador.objetos.get(chave)?.armazenamento.dados.get("contador")?.contagem ?? 0;

function virusTotal() {
  const estado = { n: 0, chamadas: [] };
  const resolver = (url, init) => {
    estado.chamadas.push(`${init?.method || "GET"} ${new URL(url).pathname}`);
    const caminho = new URL(url).pathname;
    if (!url.includes("virustotal.com")) return semRede();
    if (init?.method === "POST" && caminho === "/api/v3/urls") return Response.json({ data: { id: `u-${++estado.n}-1` } });
    if (caminho.startsWith("/api/v3/analyses/")) return Response.json({ data: { attributes: { status: "queued" } } });
    return new Response("{}", { status: 404 });
  };
  return { estado, resolver };
}

const POLL = (id) => `/url/${id}`;

test("GET /url/:id: id inventado e recusado sem chamar o VirusTotal nem gastar teto", async (t) => {
  const rede = simularRede(t, semRede);
  const limitador = bindingLimitador();
  const r = await chamar(POLL("u-inventado-1"), null, { RATE_LIMITER_DO: limitador }, { metodo: "GET" });
  assert.equal(r.status, 404);
  assert.equal(rede.length, 0);
  assert.equal(contagem(limitador, "vt-teto-dia:url"), 0);
  assert.equal(contagem(limitador, "vt-teto-total-dia"), 0);
});

test("GET /url/:id: so o IP que recebeu o id consulta; a chamada ao VirusTotal sai a cada 25 s", async (t) => {
  const vt = virusTotal();
  simularRede(t, vt.resolver);
  const avancar = relogio(t);
  const limitador = bindingLimitador();
  const env = { RATE_LIMITER_DO: limitador };
  const sub = await chamar("/url", { url: "https://exemplo.com.br/a" }, env);
  assert.equal((await sub.json()).analysis_id, "u-1-1");
  assert.equal(contagem(limitador, "vt-teto-total-dia"), 2, "POST gasta 1 de consulta e 1 de envio");

  const outroIp = await chamar(POLL("u-1-1"), null, env, { metodo: "GET", headers: { "CF-Connecting-IP": "198.51.100.7" } });
  assert.equal(outroIp.status, 404, "id emitido a outro IP");

  const antes = vt.estado.chamadas.length;
  const cedo = await chamar(POLL("u-1-1"), null, env, { metodo: "GET" });
  assert.deepEqual(await cedo.json(), { done: false });
  assert.equal(vt.estado.chamadas.length, antes, "consulta antes de 25 s nao chega ao VirusTotal");

  avancar(26_000);
  const r = await chamar(POLL("u-1-1"), null, env, { metodo: "GET" });
  assert.deepEqual(await r.json(), { done: false });
  assert.equal(vt.estado.chamadas.length, antes + 1);
  assert.equal(contagem(limitador, "vt-teto-total-dia"), 3);
});

test("GET /url/:id: no maximo 8 chamadas ao VirusTotal e 30 consultas por id", async (t) => {
  const vt = virusTotal();
  simularRede(t, vt.resolver);
  const avancar = relogio(t);
  const env = { RATE_LIMITER_DO: bindingLimitador() };
  await chamar("/url", { url: "https://exemplo.com.br/a" }, env);
  let chamadasVt = 0;
  let ultimo;
  for (let i = 0; i < 12; i++) {
    avancar(26_000);
    const antes = vt.estado.chamadas.length;
    ultimo = await chamar(POLL("u-1-1"), null, env, { metodo: "GET" });
    chamadasVt += vt.estado.chamadas.length - antes;
    if (ultimo.status !== 200) break;
  }
  assert.equal(chamadasVt, 8);
  assert.equal(ultimo.status, 429);
  assert.equal((await ultimo.json()).error, "limite_consultas");
});

test("um IP sozinho nao esgota a cota combinada: 10 envios com todas as consultas gastam menos de 1/3 do teto", async (t) => {
  const vt = virusTotal();
  simularRede(t, vt.resolver);
  const avancar = relogio(t);
  const limitador = bindingLimitador();
  const env = { RATE_LIMITER_DO: limitador };
  for (let i = 1; i <= 10; i++) {
    assert.equal((await chamar("/url", { url: `https://exemplo.com.br/${i}` }, env)).status, 200);
    for (let k = 0; k < 10; k++) {
      avancar(26_000);
      await chamar(POLL(`u-${i}-1`), null, env, { metodo: "GET" });
    }
  }
  assert.equal((await chamar("/url", { url: "https://exemplo.com.br/x" }, env)).status, 429, "11o envio do dia");
  assert.ok(contagem(limitador, "vt-teto-total-dia") <= 10 * (2 + 8), "no maximo 100 de 420");
});

test("cobranca: recusa pelo teto combinado devolve o limite do IP e o teto da rota", async (t) => {
  const rede = simularRede(t, semRede);
  const limitador = bindingLimitador();
  const env = { RATE_LIMITER_DO: limitador };
  limitador.get("vt-teto-total-dia");
  limitador.objetos.get("vt-teto-total-dia").armazenamento.dados.set("contador", { janela: Math.floor(Date.now() / 86_400_000), contagem: 420 });
  const r = await chamar("/hash", { hash: HASH }, env);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, "teto_diario");
  assert.equal(diaDoIp(limitador), 0, "limite diario do IP intacto");
  assert.equal(contagem(limitador, "vt-teto-dia:hash"), 0, "teto da rota intacto");
  assert.equal(contagem(limitador, "vt-teto-total-dia"), 420);
  assert.equal(rede.length, 0);
});

test("cobranca: recusa pelo teto da rota devolve o limite do IP", async (t) => {
  simularRede(t, semRede);
  const limitador = bindingLimitador();
  limitador.get("vt-teto-dia:hash");
  limitador.objetos.get("vt-teto-dia:hash").armazenamento.dados.set("contador", { janela: Math.floor(Date.now() / 86_400_000), contagem: 60 });
  const r = await chamar("/hash", { hash: HASH }, { RATE_LIMITER_DO: limitador });
  assert.equal(r.status, 503);
  assert.equal(diaDoIp(limitador), 0);
  assert.equal(contagem(limitador, "vt-teto-total-dia"), 0);
});

test("/hash: Turnstile no modo exigir recusa sem token e aceita o modo observar", async (t) => {
  simularRede(t, vt);
  const base = { RATE_LIMITER_DO: bindingLimitador(), TURNSTILE_SECRET: "segredo" };
  const recusado = await chamar("/hash", { hash: HASH }, { ...base, TURNSTILE_VT_MODO: "exigir" });
  assert.equal(recusado.status, 403);
  assert.equal((await recusado.json()).error, "verificacao_humana");
  const observando = await chamar("/hash", { hash: HASH }, { ...base, RATE_LIMITER_DO: bindingLimitador(), TURNSTILE_VT_MODO: "observar" });
  assert.equal(observando.status, 200);
  const semModo = await chamar("/hash", { hash: HASH }, { ...base, RATE_LIMITER_DO: bindingLimitador(), TURNSTILE_MODO: "exigir" });
  assert.equal(semModo.status, 200, "TURNSTILE_MODO do sitesecure nao muda o comportamento de /hash");
});

test("/hash e /url: falha do Durable Object vira 503 sem vazar mensagem", async (t) => {
  simularRede(t, vt);
  const quebrado = { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error("falha em /var/interno"); } }) };
  const r = await chamar("/hash", { hash: HASH }, { RATE_LIMITER_DO: quebrado });
  assert.equal(r.status, 503);
  const txt = await r.text();
  assert.ok(!txt.includes("interno"));
});

test("GET /url/:id valida o identificador e nao gasta o limite diario", async (t) => {
  const rede = simularRede(t, semRede);
  const limitador = bindingLimitador();
  const env = { RATE_LIMITER_DO: limitador };
  for (const ruim of ["/url/abc/qualquer/coisa", "/url/abc%2F..%2Fx", "/url/a b", "/url/" + "a".repeat(201)]) {
    const r = await chamar(ruim, null, env, { metodo: "GET" });
    assert.equal(r.status, 404, ruim);
  }
  assert.equal(rede.length, 0);
  assert.equal(diaDoIp(limitador), 0);
});

test("IPv6 do mesmo /64 divide o mesmo limite por minuto", async (t) => {
  simularRede(t, vt);
  const limitador = bindingLimitador();
  const env = { RATE_LIMITER_DO: limitador };
  for (let i = 0; i < 10; i++) {
    const r = await chamar("/hash", { hash: HASH }, env, { headers: { "CF-Connecting-IP": `2804:14c:1234:5678::${i + 1}` } });
    assert.equal(r.status, 200);
  }
  const r = await chamar("/hash", { hash: HASH }, env, { headers: { "CF-Connecting-IP": "2804:14c:1234:5678:ffff::1" } });
  assert.equal(r.status, 429);
  assert.deepEqual([...limitador.objetos.keys()].filter((k) => !k.startsWith("vt-")), ["v6:2804:14c:1234:5678"]);
});

test("/sitesecure/analisar recebe o IPv6 agrupado na guarda", async (t) => {
  simularRede(t, semRede);
  const guarda = bindingSitesecure();
  const r = await chamar("/sitesecure/analisar", { url: "https://naoexiste.com.br/" }, { SITESECURE_DO: guarda }, { headers: { "CF-Connecting-IP": "2804:14c:1234:5678::9" } });
  await r.text();
  assert.ok(guarda.objetos.has("ip:v6:2804:14c:1234:5678"));
});

test("scheduled: apaga do historico o que passou de 12 meses", async () => {
  let args;
  const env = { HISTORICO: { prepare: () => ({ bind: (...a) => { args = a; return { run: async () => ({ meta: { changes: 0 } }) }; } }) } };
  await worker.scheduled({}, env, contexto());
  assert.match(args[0], /^\d{4}-\d{2}-\d{2}$/);
});

test("scheduled: falha da limpeza e relancada para o cron constar como falho", async (t) => {
  const logs = [];
  const original = console.log;
  console.log = (l) => logs.push(l);
  t.after(() => { console.log = original; });
  const env = { HISTORICO: { prepare: () => { throw new Error("d1 fora"); } } };
  await assert.rejects(worker.scheduled({}, env, contexto()), /d1 fora/);
  assert.ok(logs.some((l) => l.includes("limpeza_historico_falhou")));
});
