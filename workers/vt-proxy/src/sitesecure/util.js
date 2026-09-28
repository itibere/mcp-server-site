// Utilitarios compartilhados pelos modulos do sitesecure.

// O Workers Free permite 50 subrequests por invocacao. Cada modulo pede
// cota antes de chamar a rede; sem cota, a etapa sai como "nao concluida"
// em vez de derrubar a analise inteira.
export class Orcamento {
  constructor(max = 45) {
    this.max = max;
    this.usado = 0;
  }
  pode(n = 1) {
    return this.usado + n <= this.max;
  }
  usar(n = 1) {
    if (!this.pode(n)) throw new SemCota();
    this.usado += n;
  }
}

export class SemCota extends Error {
  constructor() {
    super("sem_cota_de_subrequests");
  }
}

// fetch do Worker nao manda User-Agent; varias APIs publicas recusam (403/429).
const UA = "Mozilla/5.0 (compatible; IJ-Sitesecure/1.0; +https://itibere.tec.br/sitesecure/)";

export async function buscar(orcamento, url, init = {}, ms = 8000) {
  orcamento.usar();
  const headers = { "User-Agent": UA, ...(init.headers || {}) };
  return fetch(url, { ...init, headers, signal: AbortSignal.timeout(ms) });
}

export async function buscarJson(orcamento, url, init = {}, ms = 8000) {
  const res = await buscar(orcamento, url, init, ms);
  if (!res.ok) return { _status: res.status };
  return res.json();
}

const DOH = "https://cloudflare-dns.com/dns-query";
export const DOH_FAMILY = "https://family.cloudflare-dns.com/dns-query";

export async function doh(orcamento, nome, tipo, servidor = DOH) {
  const u = `${servidor}?name=${encodeURIComponent(nome)}&type=${tipo}&do=1`;
  return buscarJson(orcamento, u, { headers: { Accept: "application/dns-json" } }, 5000);
}

// Segundo nivel usados como sufixo publico (lista curta, suficiente para BR
// e os casos mais comuns; nao e a Public Suffix List inteira).
const SUFIXOS_2 = new Set([
  "com.br", "net.br", "org.br", "gov.br", "edu.br", "art.br", "blog.br", "eco.br",
  "ind.br", "inf.br", "jus.br", "leg.br", "mil.br", "mp.br", "def.br", "bet.br", "app.br",
  "dev.br", "log.br", "tec.br", "srv.br", "emp.br", "adv.br", "med.br", "eng.br",
  "co.uk", "org.uk", "com.au", "com.ar", "com.mx", "co.jp", "com.pt", "com.co",
  "github.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "web.app",
  "firebaseapp.com", "herokuapp.com", "blogspot.com", "wixsite.com", "weebly.com",
  "000webhostapp.com", "glitch.me", "onrender.com", "fly.dev", "repl.co", "ngrok.io",
  "ngrok-free.app", "godaddysites.com", "square.site", "carrd.co", "wordpress.com",
]);

export function dominioRaiz(host) {
  const partes = host.toLowerCase().replace(/\.$/, "").split(".");
  if (partes.length <= 2) return partes.join(".");
  const ultimos2 = partes.slice(-2).join(".");
  if (SUFIXOS_2.has(ultimos2)) return partes.slice(-3).join(".");
  return ultimos2;
}

export function hostDe(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function diasDesde(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

export function normalizarTexto(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// Palavras que aparecem em quase toda razao social e nao identificam a empresa.
const GENERICAS = new Set([
  "ltda", "eireli", "epp", "me", "sa", "s/a", "comercio", "servicos", "industria",
  "brasil", "do", "da", "de", "dos", "das", "e", "com", "online", "loja", "grupo",
  "holding", "participacoes", "digital", "tecnologia", "solucoes", "varejo",
  "importacao", "exportacao", "distribuidora", "comercial", "empresa", "cia",
]);

export function tokensNome(s) {
  return normalizarTexto(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !GENERICAS.has(t));
}

// true se algum token significativo de `nome` aparece em algum dos textos.
export function nomeCombina(nome, ...textos) {
  const tokens = tokensNome(nome);
  if (!tokens.length) return false;
  const alvo = normalizarTexto(textos.join(" ")).replace(/[^a-z0-9]+/g, "");
  return tokens.some((t) => alvo.includes(t));
}

export const NIVEL = { BOM: "bom", MEDIO: "medio", BAIXO: "baixo", NA: "na" };
