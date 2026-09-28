// Coleta da pagina: navegador headless (Cloudflare Browser Rendering) e, se a
// cota diaria do navegador acabar, fallback para o HTML estatico.
import puppeteer from "@cloudflare/puppeteer";
import { buscar } from "./util.js";

const MAX_REQS = 400;
const MAX_TEXTO = 60_000;

// Roda dentro da pagina. Nao pode referenciar nada de fora desta funcao.
function extrairNaPagina() {
  const ANUNCIO = /(^|[\s_-])(ad|ads|adv|advert|advertising|anuncio|banner|sponsor|sponsored|patrocinado|publicidade|dfp|gpt-ad|adsbygoogle|taboola|outbrain)([\s_-]|$)/i;
  const header = document.querySelector("header, [role=banner], #header, .header");
  const footer = document.querySelector("footer, [role=contentinfo], #footer, .footer");

  function zona(el) {
    if (header && header.contains(el)) return "header";
    if (footer && footer.contains(el)) return "footer";
    return "corpo";
  }
  function emAnuncio(el) {
    for (let n = el, i = 0; n && i < 8; n = n.parentElement, i++) {
      const marca = `${n.id || ""} ${typeof n.className === "string" ? n.className : ""} ${n.getAttribute?.("data-ad-slot") ? "ad" : ""}`;
      if (ANUNCIO.test(marca)) return true;
    }
    return false;
  }

  const links = [];
  for (const a of document.querySelectorAll("a[href]")) {
    if (links.length >= 600) break;
    const href = a.href;
    if (!/^https?:/i.test(href)) continue;
    links.push({ href, texto: (a.textContent || "").trim().slice(0, 60), zona: zona(a), anuncio: emAnuncio(a) });
  }
  const iframes = [...document.querySelectorAll("iframe[src]")].slice(0, 60).map((f) => f.src);
  const cartao = !!document.querySelector(
    'input[autocomplete="cc-number"], input[name*="cardnumber" i], input[name*="card_number" i], input[name*="numero_cartao" i], input[id*="card-number" i], input[placeholder*="número do cartão" i]'
  );
  const texto = (document.body?.innerText || "").slice(0, 60000);
  return {
    titulo: document.title || "",
    links,
    iframes,
    cartao,
    texto,
    headerTexto: header ? header.innerText.slice(0, 4000) : "",
    footerTexto: footer ? footer.innerText.slice(0, 6000) : texto.slice(-3000),
    temHeader: !!header,
    temFooter: !!footer,
  };
}

// Links dentro de iframes de anuncio (cross-origin; o CDP enxerga os frames).
async function linksDosFrames(page) {
  const saida = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const hrefs = await frame.evaluate(() =>
        [...document.querySelectorAll("a[href]")].slice(0, 20).map((a) => a.href)
      );
      for (const href of hrefs) {
        if (/^https?:/i.test(href)) saida.push({ href, texto: "", zona: "corpo", anuncio: true, frame: frame.url() });
      }
    } catch {
      // frame destruido ou bloqueado: ignora
    }
    if (saida.length > 80) break;
  }
  return saida;
}

export async function renderizar(env, url) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    const requisicoes = new Set();
    page.on("request", (r) => {
      if (requisicoes.size < MAX_REQS) requisicoes.add(r.url());
    });
    const resp = await page.goto(url, { waitUntil: "networkidle2", timeout: 25_000 });
    // Anuncios costumam chegar depois do load.
    await new Promise((r) => setTimeout(r, 2500));
    const dados = await page.evaluate(extrairNaPagina);
    dados.links.push(...(await linksDosFrames(page)));
    const seg = resp?.securityDetails();
    return {
      modo: "navegador",
      urlFinal: page.url(),
      status: resp?.status() ?? 0,
      headers: resp?.headers() ?? {},
      redirecionamentos: resp ? resp.request().redirectChain().map((r) => r.url()) : [],
      tls: seg ? { emissor: seg.issuer(), protocolo: seg.protocol(), validoAte: seg.validTo() * 1000 } : null,
      requisicoes: [...requisicoes],
      ...dados,
      texto: dados.texto.slice(0, MAX_TEXTO),
    };
  } finally {
    await browser.close();
  }
}

// Fallback sem navegador: so HTML estatico. Nao ve anuncio injetado por JS.
export async function coletarEstatico(orcamento, url) {
  const res = await buscar(orcamento, url, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; IJ-Sitesecure/1.0; +https://itibere.tec.br/sitesecure/)" },
  }, 12_000);
  const headers = Object.fromEntries(res.headers);
  const links = [];
  const iframes = [];
  const scripts = [];
  let zona = "corpo";
  let headerTexto = "";
  let footerTexto = "";
  let temHeader = false;
  let temFooter = false;

  const reescrito = new HTMLRewriter()
    .on("header, footer", {
      element(el) {
        zona = el.tagName;
        if (zona === "header") temHeader = true; else temFooter = true;
        el.onEndTag(() => { zona = "corpo"; });
      },
      text(t) {
        if (zona === "header" && headerTexto.length < 4000) headerTexto += t.text;
        if (zona === "footer" && footerTexto.length < 6000) footerTexto += t.text;
      },
    })
    .on("a[href]", {
      element(el) {
        if (links.length >= 600) return;
        try {
          const href = new URL(el.getAttribute("href"), res.url).toString();
          if (/^https?:/i.test(href)) links.push({ href, texto: "", zona, anuncio: false });
        } catch { /* href invalido */ }
      },
    })
    .on("iframe[src]", { element(el) { try { iframes.push(new URL(el.getAttribute("src"), res.url).toString()); } catch { /* */ } } })
    .on("script[src]", { element(el) { try { scripts.push(new URL(el.getAttribute("src"), res.url).toString()); } catch { /* */ } } })
    .transform(res);

  // Le no maximo ~1,5 MB (o suficiente para achar CNPJ/BR Code no texto).
  const leitor = reescrito.body.getReader();
  const dec = new TextDecoder();
  let html = "";
  while (html.length < 1_500_000) {
    const { done, value } = await leitor.read();
    if (done) break;
    html += dec.decode(value, { stream: true });
  }
  leitor.cancel().catch(() => {});
  const texto = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, MAX_TEXTO);

  return {
    modo: "estatico",
    urlFinal: res.url,
    status: res.status,
    headers,
    redirecionamentos: res.redirected ? [url] : [],
    tls: null,
    requisicoes: [...scripts, ...iframes],
    titulo: (html.match(/<title[^>]*>([^<]*)/i)?.[1] || "").trim(),
    links,
    iframes,
    cartao: /<input[^>]+(autocomplete=["']cc-number|name=["'][^"']*(card-?number|cc-?num|numero-?_?cartao))/i.test(html),
    texto,
    headerTexto: headerTexto.replace(/\s+/g, " "),
    footerTexto: (footerTexto || texto.slice(-3000)).replace(/\s+/g, " "),
    temHeader,
    temFooter,
  };
}
