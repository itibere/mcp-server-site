// Cloudflare Radar: popularidade (ranking de dominios) e categoria de conteudo.
// Serve para nao tratar como "desconhecido" um dominio muito acessado, e para
// pegar aposta/adulto que as listas curadas nao cobrem. Token gratis
// (CF_RADAR_TOKEN); sem ele, o modulo nao faz nada.
import { buscarJson } from "./util.js";

const ESTABELECIDO = 100_000; // top 100 mil = dominio estabelecido
const CATEGORIA_RUIM = /gambling|adult|pornography|nudity|malware|phishing|spam|command and control|cryptomining|parked|questionable/i;

function faixa(det) {
  if (typeof det?.rank === "number") return det.rank;
  // bucket vem como texto ("200", "100000", ">200000"...): o numero e o teto da faixa.
  const b = String(det?.bucket || "");
  if (!b || b.startsWith(">")) return null;
  const n = Number(b.replace(/\D/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function consultarRadar(orcamento, env, dominio) {
  if (!env.CF_RADAR_TOKEN || !orcamento.pode()) return null;
  const r = await buscarJson(orcamento, `https://api.cloudflare.com/client/v4/radar/ranking/domain/${encodeURIComponent(dominio)}`, {
    headers: { Authorization: `Bearer ${env.CF_RADAR_TOKEN}` },
  }, 6000);
  if (r._status || !r.success) return { disponivel: false, motivo: r._status ? `erro_${r._status}` : "sem_dados" };
  const det = r.result?.details_0 || {};
  const posicao = faixa(det);
  const categorias = (det.categories || []).map((c) => c.name).filter(Boolean);
  return {
    disponivel: true,
    posicao,
    estabelecido: posicao != null && posicao <= ESTABELECIDO,
    categorias,
    categoriaRuim: categorias.find((c) => CATEGORIA_RUIM.test(c)) || null,
  };
}

// Consulta em paralelo os dominios pedidos, respeitando o orcamento.
export async function consultarRadarLote(orcamento, env, dominios, max) {
  const lista = [...new Set(dominios)].slice(0, max);
  const pares = await Promise.all(lista.map(async (d) => [d, await consultarRadar(orcamento, env, d).catch(() => null)]));
  return new Map(pares.filter(([, v]) => v?.disponivel));
}

export function rotuloPosicao(p) {
  if (p == null) return null;
  return p <= 1000 ? `entre os ${p.toLocaleString("pt-BR")} domínios mais acessados` : `no top ${p.toLocaleString("pt-BR")} de popularidade (Cloudflare Radar)`;
}
