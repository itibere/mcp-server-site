// Reclame Aqui: sem API publica e atras de protecao anti-bot. Tentativa
// best-effort nos endpoints que o proprio site usa; se bloquear, devolve so o
// link de busca. Nunca inventa nota.
import { buscarJson } from "./util.js";

const CABECALHOS = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  Origin: "https://www.reclameaqui.com.br",
  Referer: "https://www.reclameaqui.com.br/",
};

// Status do selo do Reclame Aqui -> nivel do laudo.
const STATUS = {
  RA1000: ["bom", "RA1000"],
  GREAT: ["bom", "Ótimo"],
  GOOD: ["bom", "Bom"],
  REGULAR: ["medio", "Regular"],
  BAD: ["baixo", "Ruim"],
  NOT_RECOMMENDED: ["baixo", "Não recomendada"],
  NO_INDEX: ["medio", "Sem índice (poucas avaliações)"],
};

export async function consultarReclameAqui(orcamento, termo) {
  const link = `https://www.reclameaqui.com.br/busca/?q=${encodeURIComponent(termo)}`;
  if (!termo || !orcamento.pode(2)) return { verificado: false, link };
  try {
    const busca = await buscarJson(orcamento,
      `https://iosearch.reclameaqui.com.br/raichu-io-site-search-v1/companies/search/${encodeURIComponent(termo)}`,
      { headers: CABECALHOS }, 8000);
    const empresa = busca?.companies?.[0];
    if (busca._status || !empresa?.shortname) return { verificado: false, link, motivo: busca._status ? "bloqueado" : "nao_encontrada" };
    const d = await buscarJson(orcamento,
      `https://iosite.reclameaqui.com.br/raichu-io-site-v1/company/shortname/${encodeURIComponent(empresa.shortname)}`,
      { headers: CABECALHOS }, 8000);
    const pagina = `https://www.reclameaqui.com.br/empresa/${empresa.shortname}/`;
    if (d._status) return { verificado: false, link: pagina, motivo: "bloqueado" };
    const periodo = (d.panels || d.indexes || [])[0] || d;
    const status = String(periodo.status || d.status || "").toUpperCase();
    const [nivel, rotulo] = STATUS[status] || [null, status || "desconhecido"];
    return {
      verificado: !!nivel,
      link: pagina,
      empresa: d.companyName || empresa.companyName || empresa.shortname,
      nota: periodo.finalScore ?? null,
      status: rotulo,
      nivel,
    };
  } catch {
    return { verificado: false, link };
  }
}
