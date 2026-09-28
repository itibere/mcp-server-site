// Classificacao dos destinos dos links (e dos anuncios): para onde levam e
// qual a reputacao de quem recebe o clique.
import confiaveis from "./data/dominios_confiaveis.json";
import { buscar, doh, DOH_FAMILY, dominioRaiz, hostDe } from "./util.js";
import { identificarGoverno } from "./governo.js";
import { consultarRadarLote, rotuloPosicao } from "./radar.js";

const CONFIAVEIS = new Set(confiaveis.dominios);
const ENCURTADORES = new Set([
  "bit.ly", "tinyurl.com", "cutt.ly", "t.co", "is.gd", "rb.gy", "shorturl.at", "ow.ly", "buff.ly",
  "encurtador.com.br", "abre.ai", "l.ead.me", "linktr.ee", "short.gy", "tiny.cc", "s.id", "bitly.com",
]);
// Desde 01/2025 aposta de quota fixa legal no Brasil opera em .bet.br
// (Portaria SPA/MF 1.330/2024). Aposta fora de .bet.br = nao autorizada.
const APOSTA = /(^|[.-])bets?([.-]|\d|$)|\dbet|bet\d|aposta|cassino|casino|slots?[.-]|tigrinho|fortune-?tiger|roleta|bingo|poker|jackpot/i;
const ADULTO = /porn|xxx|xvideos|xnxx|xhamster|onlyfans|privacy\.com\.br|camgirl|chaturbate|(^|[.-])sex|sexo|hentai|nsfw|brazzers|redtube|youporn|stripchat|bongacams/i;

// Links de clique de anuncio escondem o destino real num parametro.
const PARAMS_DESTINO = ["adurl", "url", "u", "dest", "destination", "redirect", "redir", "target", "to", "r"];

export function destinoReal(href) {
  try {
    const u = new URL(href);
    for (const p of PARAMS_DESTINO) {
      const v = u.searchParams.get(p);
      if (v && /^https?:\/\//i.test(v)) return v;
    }
  } catch { /* */ }
  return href;
}

export function classificarPorNome(raiz) {
  if (identificarGoverno(raiz).governo) return { nivel: "bom", motivo: "domínio de governo" };
  if (CONFIAVEIS.has(raiz)) return { nivel: "bom", motivo: "destino de boa reputação" };
  if (raiz.endsWith(".bet.br")) return { nivel: "medio", motivo: "aposta autorizada (.bet.br)" };
  if (APOSTA.test(raiz)) return { nivel: "baixo", motivo: "aposta fora de .bet.br (não autorizada no Brasil)" };
  if (ADULTO.test(raiz)) return { nivel: "baixo", motivo: "conteúdo adulto" };
  return null;
}

// Segue ate 3 saltos de um encurtador para descobrir o destino final.
async function expandir(orcamento, url) {
  let atual = url;
  for (let i = 0; i < 3 && orcamento.pode(); i++) {
    try {
      const res = await buscar(orcamento, atual, { method: "HEAD", redirect: "manual" }, 5000);
      const loc = res.headers.get("location");
      if (!loc || res.status < 300 || res.status >= 400) break;
      atual = new URL(loc, atual).toString();
      if (!ENCURTADORES.has(hostDe(atual))) break;
    } catch {
      break;
    }
  }
  return atual;
}

// Recebe [{href, zona, anuncio}] e devolve um mapa raiz -> classificacao.
// DoH "family" da Cloudflare bloqueia malware e adulto (responde 0.0.0.0):
// e o filtro gratuito usado para dominios que nao batem em nenhuma lista.
export async function classificarDestinos(orcamento, env, links, raizSite, maxFamily = 18, maxRadar = 8) {
  const porRaiz = new Map();
  for (const l of links) {
    let destino = destinoReal(l.href);
    const host = hostDe(destino);
    if (!host) continue;
    if (ENCURTADORES.has(host) && porRaiz.size < 200) {
      destino = await expandir(orcamento, destino);
    }
    const hostFinal = hostDe(destino);
    if (!hostFinal) continue;
    const raiz = dominioRaiz(hostFinal);
    if (raiz === raizSite) continue;
    const item = porRaiz.get(raiz) || { raiz, exemplos: [], zonas: new Set(), anuncio: false, encurtado: false };
    if (item.exemplos.length < 2) item.exemplos.push(destino.slice(0, 200));
    item.zonas.add(l.zona);
    item.anuncio ||= !!l.anuncio;
    item.encurtado ||= ENCURTADORES.has(host);
    porRaiz.set(raiz, item);
  }

  const itens = [...porRaiz.values()];
  const pendentes = [];
  for (const item of itens) {
    const c = classificarPorNome(item.raiz);
    if (c) Object.assign(item, c);
    else pendentes.push(item);
  }
  // Anuncios primeiro: e onde o filtro mais importa.
  pendentes.sort((a, b) => Number(b.anuncio) - Number(a.anuncio));
  const checar = pendentes.slice(0, Math.min(maxFamily, Math.max(0, orcamento.max - orcamento.usado - 8)));
  await Promise.all(checar.map(async (item) => {
    try {
      const r = await doh(orcamento, item.raiz, "A", DOH_FAMILY);
      const bloqueado = (r.Answer || []).some((a) => a.data === "0.0.0.0");
      Object.assign(item, bloqueado
        ? { nivel: "baixo", motivo: "bloqueado por filtro de malware/adulto (Cloudflare 1.1.1.3)" }
        : { nivel: "neutro", motivo: "sem registro negativo" });
    } catch {
      Object.assign(item, { nivel: "neutro", motivo: "não verificado" });
    }
  }));
  for (const item of pendentes) {
    if (!item.nivel) Object.assign(item, { nivel: "neutro", motivo: "não verificado (limite de consultas)" });
  }

  // Cloudflare Radar nos neutros restantes (anuncios primeiro): popular vira
  // bom, categoria de aposta/adulto/malware vira baixo. Reduz falso positivo
  // de "sem reputação conhecida" em dominio legitimo fora das listas.
  const neutros = pendentes.filter((i) => i.nivel === "neutro");
  const vagas = Math.min(maxRadar, Math.max(0, orcamento.max - orcamento.usado - 8));
  const radar = await consultarRadarLote(orcamento, env, neutros.map((i) => i.raiz), vagas);
  for (const item of neutros) {
    const r = radar.get(item.raiz);
    if (!r) continue;
    if (r.categoriaRuim) Object.assign(item, { nivel: "baixo", motivo: `categoria "${r.categoriaRuim}" (Cloudflare Radar)` });
    else if (r.estabelecido) Object.assign(item, { nivel: "bom", motivo: `domínio popular, ${rotuloPosicao(r.posicao)}` });
  }
  return itens.map((i) => ({ ...i, zonas: [...i.zonas] }));
}
