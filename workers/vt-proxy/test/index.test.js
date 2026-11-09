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

test("/hash e /url: limite diario de 20 por IP", async (t) => {
  simularRede(t, vt);
  const limitador = bindingLimitador();
  const env = { RATE_LIMITER_DO: limitador };
  let agora = Date.parse("2026-11-09T15:00:00Z");
  const original = Date.now;
  Date.now = () => agora;
  t.after(() => { Date.now = original; });
  for (let i = 0; i < 20; i++) {
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
  limitador.get("vt-teto-dia");
  limitador.objetos.get("vt-teto-dia").armazenamento.dados.set("contador", { janela: Math.floor(Date.now() / 86_400_000), contagem: 150 });
  const r = await chamar("/hash", { hash: HASH }, env);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, "teto_diario");
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
  const env = { HISTORICO: { prepare: () => ({ bind: (...a) => { args = a; return { run: async () => ({}) }; } }) } };
  const ctx = contexto();
  await worker.scheduled({}, env, ctx);
  await ctx.esperar();
  assert.match(args[0], /^\d{4}-\d{2}-\d{2}$/);
});
