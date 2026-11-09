import { test } from "node:test";
import assert from "node:assert/strict";
import { coletarEstatico } from "../src/sitesecure/render.js";
import { Orcamento } from "../src/sitesecure/util.js";
import { simularRede, dns } from "./apoio/ambiente.js";

const REDE = dns({
  "loja.com.br": { A: ["93.184.216.34"] },
  "interno.exemplo.com.br": { A: ["10.0.0.8"] },
  "v6.exemplo.com.br": { A: ["93.184.216.34"], AAAA: ["fd00::1"] },
});

function redirecionador(destino) {
  return (url) => (url.includes("cloudflare-dns.com") ? REDE(url) : new Response(null, { status: 302, headers: { location: destino } }));
}

test("coletarEstatico: redirecionamento para host que resolve em IP privado e barrado antes de buscar", async (t) => {
  const chamadas = simularRede(t, redirecionador("https://interno.exemplo.com.br/admin"));
  await assert.rejects(
    coletarEstatico(new Orcamento(20), "https://loja.com.br/", new Set(["loja.com.br"])),
    (e) => e.destinoProibido === true && e.message === "ip_privado",
  );
  assert.ok(!chamadas.some((c) => c.includes("interno.exemplo.com.br/admin")), "o destino privado nunca foi buscado");
});

test("coletarEstatico: redirecionamento cujo AAAA e privado tambem e barrado", async (t) => {
  simularRede(t, redirecionador("https://v6.exemplo.com.br/"));
  await assert.rejects(coletarEstatico(new Orcamento(20), "https://loja.com.br/", new Set(["loja.com.br"])), (e) => e.destinoProibido === true);
});

test("coletarEstatico: redirecionamento para IP literal e localhost com ponto final e barrado", async (t) => {
  for (const destino of ["http://169.254.169.254/", "http://localhost./"]) {
    simularRede(t, redirecionador(destino));
    await assert.rejects(coletarEstatico(new Orcamento(20), "https://loja.com.br/", new Set(["loja.com.br"])), (e) => e.destinoProibido === true, destino);
  }
});

test("coletarEstatico: laco de redirecionamentos para", async (t) => {
  simularRede(t, redirecionador("https://loja.com.br/"));
  await assert.rejects(coletarEstatico(new Orcamento(60), "https://loja.com.br/", new Set(["loja.com.br"])), /redirecionamentos_demais/);
});

import { renderizar } from "../src/sitesecure/render.js";

function navegadorFalso({ navegacoes = ["https://loja.com.br/"], subrecursos = [], navegarDepois = null } = {}) {
  const estado = { fechado: false, continuadas: [], abortadas: [] };
  const principal = {};
  const filhos = {};
  const page = {
    handlers: [],
    mainFrame: () => principal,
    frames: () => [principal],
    setViewport: async () => {},
    setRequestInterception: async (v) => { estado.interceptando = v; },
    on(ev, fn) { if (ev === "request") this.handlers.push(fn); },
    url: () => navegacoes.at(-1),
    async evaluate() {
      if (navegarDepois) {
        const req = { url: () => navegarDepois, isNavigationRequest: () => true, frame: () => principal, continue: async () => {}, abort: async () => { estado.abortadas.push(navegarDepois); } };
        this.handlers.forEach((h) => h(req));
        await new Promise((r) => setTimeout(r, 5));
      }
      return { titulo: "Loja", links: [], iframes: [], cartao: false, texto: "oi", headerTexto: "", footerTexto: "", temHeader: false, temFooter: false };
    },
    async goto() {
      const pedidos = [...navegacoes.map((u) => ({ u, nav: true })), ...subrecursos.map((u) => ({ u, nav: false }))];
      for (const { u, nav } of pedidos) {
        const req = {
          url: () => u,
          isNavigationRequest: () => nav,
          frame: () => (nav ? principal : filhos),
          continue: async () => { estado.continuadas.push(u); },
          abort: async () => { estado.abortadas.push(u); },
        };
        this.handlers.forEach((h) => h(req));
        await new Promise((r) => setTimeout(r, 5));
      }
      if (estado.abortadas.some((u) => navegacoes.includes(u))) throw new Error("net::ERR_BLOCKED_BY_CLIENT");
      return { status: () => 200, headers: () => ({}), securityDetails: () => null, request: () => ({ redirectChain: () => navegacoes.slice(0, -1).map((url) => ({ url: () => url })) }) };
    },
  };
  const puppeteer = { launch: async () => ({ newPage: async () => page, close: async () => { estado.fechado = true; } }) };
  return { puppeteer, estado };
}

const opcoes = (puppeteer, extra = {}) => ({ puppeteer, esperaMs: 0, orcamento: new Orcamento(30), vistos: new Set(["loja.com.br"]), ...extra });

test("renderizar: devolve a coleta do navegador, intercepta requisicoes e fecha o navegador", async (t) => {
  simularRede(t, REDE);
  const { puppeteer, estado } = navegadorFalso({ subrecursos: ["https://cdn.loja.com.br/app.js"] });
  const coleta = await renderizar({ BROWSER: {} }, "https://loja.com.br/", opcoes(puppeteer));
  assert.equal(coleta.modo, "navegador");
  assert.equal(coleta.urlFinal, "https://loja.com.br/");
  assert.equal(coleta.titulo, "Loja");
  assert.equal(estado.interceptando, true);
  assert.ok(coleta.requisicoes.includes("https://cdn.loja.com.br/app.js"));
  assert.equal(estado.fechado, true);
});

test("renderizar: navegacao para host que resolve em IP privado e abortada e vira destinoProibido", async (t) => {
  simularRede(t, REDE);
  const { puppeteer, estado } = navegadorFalso({ navegacoes: ["https://loja.com.br/", "https://interno.exemplo.com.br/admin"] });
  await assert.rejects(
    renderizar({ BROWSER: {} }, "https://loja.com.br/", opcoes(puppeteer)),
    (e) => e.destinoProibido === true && e.message === "ip_privado",
  );
  assert.deepEqual(estado.abortadas, ["https://interno.exemplo.com.br/admin"]);
  assert.equal(estado.fechado, true, "o navegador fecha mesmo na falha");
});

test("renderizar: subrecurso para IP literal, rede interna ou porta fora do padrao e abortado sem DNS", async (t) => {
  const chamadas = simularRede(t, REDE);
  const ruins = ["http://169.254.169.254/latest", "http://localhost./x", "https://loja.com.br:8443/api", "ftp://loja.com.br/a"];
  const { puppeteer, estado } = navegadorFalso({ subrecursos: [...ruins, "data:image/png;base64,AAAA", "https://cdn.loja.com.br/ok.js"] });
  const coleta = await renderizar({ BROWSER: {} }, "https://loja.com.br/", opcoes(puppeteer));
  assert.deepEqual(estado.abortadas, ruins);
  assert.ok(estado.continuadas.includes("https://cdn.loja.com.br/ok.js"));
  assert.ok(estado.continuadas.includes("data:image/png;base64,AAAA"));
  assert.equal(coleta.modo, "navegador");
  assert.ok(!chamadas.some((c) => c.includes("cdn.loja.com.br")), "subrecurso nao gasta DNS");
});

test("renderizar: cadeia de navegacoes longa demais e abortada", async (t) => {
  simularRede(t, (url) => REDE(url));
  const navegacoes = Array.from({ length: 8 }, () => "https://loja.com.br/");
  const { puppeteer } = navegadorFalso({ navegacoes });
  await assert.rejects(renderizar({ BROWSER: {} }, "https://loja.com.br/", opcoes(puppeteer)), (e) => e.message === "redirecionamentos_demais");
});

test("renderizar: a primeira navegacao nao gasta DNS; o orcamento proprio do navegador nao toca o da analise", async (t) => {
  const chamadas = simularRede(t, REDE);
  const { puppeteer } = navegadorFalso();
  await renderizar({ BROWSER: {} }, "https://loja.com.br/", opcoes(puppeteer));
  assert.equal(chamadas.length, 0);
});

test("renderizar: DNS que falha ou orcamento esgotado na navegacao vira falha do navegador, nao destino proibido", async (t) => {
  simularRede(t, REDE);
  const navegacoes = ["https://loja.com.br/", "https://novo.exemplo.com.br/"];
  const semOrcamento = navegadorFalso({ navegacoes });
  await assert.rejects(
    renderizar({ BROWSER: {} }, "https://loja.com.br/", opcoes(semOrcamento.puppeteer, { orcamento: new Orcamento(0) })),
    (e) => !e.destinoProibido,
  );
  simularRede(t, (url) => (url.includes("cloudflare-dns.com") ? new Response("", { status: 500 }) : REDE(url)));
  const dnsCaido = navegadorFalso({ navegacoes });
  await assert.rejects(
    renderizar({ BROWSER: {} }, "https://loja.com.br/", opcoes(dnsCaido.puppeteer)),
    (e) => !e.destinoProibido,
  );
  assert.equal(dnsCaido.estado.fechado, true);
});

test("renderizar: navegacao proibida feita depois do load (script) tambem falha a coleta", async (t) => {
  simularRede(t, REDE);
  const { puppeteer } = navegadorFalso({ navegarDepois: "https://interno.exemplo.com.br/x" });
  await assert.rejects(
    renderizar({ BROWSER: {} }, "https://loja.com.br/", opcoes(puppeteer)),
    (e) => e.destinoProibido === true && e.message === "ip_privado",
  );
});
