// Ranking de reclamacoes do Banco Central (bancos, financeiras e instituicoes
// de pagamento). Serve para dizer quem e a instituicao que recebe um PIX e como
// ela aparece no ranking. So informa: nao mexe na nota, porque instituicao
// grande e legitima tambem tem indice alto.
// Fonte: https://dadosabertos.bcb.gov.br/dataset/ranking-de-instituicoes-por-indice-de-reclamacoes
import psps from "./data/psp_bcb.json";
import { buscar, buscarJson, hostDe } from "./util.js";

const BASE = "https://www3.bcb.gov.br/rdrweb/rest/ext/ranking";
const PSPS = psps.instituicoes.map((p) => ({ ...p, re: new RegExp(p.padrao, "i") }));

// Cache no isolate: o ranking muda por trimestre, nao ha por que baixar a cada analise.
let cache = null;
const CACHE_MS = 12 * 3600 * 1000;

function ultimoTrimestre(lista) {
  let melhor = null;
  for (const a of lista.anos || []) {
    for (const p of a.periodicidades || []) {
      if (p.periodicidade !== "TRIMESTRAL") continue;
      for (const per of p.periodos || []) {
        if (!(per.tipos || []).some((t) => t.tipo === "Bancos e financeiras")) continue;
        const chave = Number(a.ano) * 10 + per.periodo;
        if (!melhor || chave > melhor.chave) melhor = { chave, ano: a.ano, periodo: per.periodo };
      }
    }
  }
  return melhor;
}

// CSV em windows-1252: os bytes 0x00-0xFF viram o mesmo code point (latin-1);
// o unico caractere de 0x80-0x9F usado no arquivo e o travessao (0x96).
function decodificar(buf) {
  let s = "";
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += b[i] === 0x96 ? "–" : String.fromCharCode(b[i]);
  return s;
}

const numero = (v) => {
  const t = String(v || "").trim();
  if (!t) return null;
  const n = Number(t.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

export async function carregarRanking(orcamento) {
  if (cache && Date.now() - cache.em < CACHE_MS) return cache.dados;
  if (!orcamento.pode(2)) return null;
  const lista = await buscarJson(orcamento, BASE, {}, 10_000);
  const ult = lista._status ? null : ultimoTrimestre(lista);
  if (!ult) return null;
  const res = await buscar(orcamento, `${BASE}/arquivo?ano=${ult.ano}&periodicidade=TRIMESTRAL&periodo=${ult.periodo}&tipo=Bancos+e+financeiras`, {}, 15_000);
  if (!res.ok) return null;
  const linhas = decodificar(await res.arrayBuffer()).split(/\r?\n/).slice(1).filter(Boolean);
  const instituicoes = linhas.map((l) => l.split(";")).filter((c) => c.length > 11).map((c) => ({
    nome: c[5].trim(),
    indice: numero(c[6]),
    procedentes: numero(c[8]),
    clientes: numero(c[11]),
  }));
  const indices = instituicoes.map((i) => i.indice).filter((n) => n != null).sort((a, b) => a - b);
  const dados = {
    periodo: `${ult.periodo}º trimestre de ${ult.ano}`,
    instituicoes,
    mediana: indices.at(Math.floor(indices.length / 2)) ?? null,
    p75: indices.at(Math.floor(indices.length * 0.75)) ?? null,
    total: instituicoes.length,
  };
  cache = { em: Date.now(), dados };
  return dados;
}

// Instituicao de pagamento a partir do endereco do QR dinamico e do nome do
// recebedor (quando o recebedor e o proprio intermediador).
export function identificarInstituicao(pix) {
  const alvos = [pix?.pspUrl ? hostDe(`https://${pix.pspUrl}`) || pix.pspUrl : null, pix?.recebedor].filter(Boolean);
  for (const alvo of alvos) {
    const p = PSPS.find((x) => x.re.test(alvo));
    if (p) return { nome: p.nome, bcb: p.bcb, pelo: alvo === pix?.recebedor ? "nome do recebedor" : "endereço do QR dinâmico" };
  }
  return null;
}

export function situacaoNoRanking(ranking, inst) {
  if (!ranking || !inst) return null;
  const achada = ranking.instituicoes.find((i) => i.nome.toUpperCase().startsWith(inst.bcb.toUpperCase()));
  if (!achada) return { periodo: ranking.periodo, encontrada: false };
  let faixa = "sem índice no período (poucas reclamações analisadas)";
  if (achada.indice != null && ranking.mediana != null) {
    faixa = achada.indice <= ranking.mediana ? "abaixo da mediana do ranking" : achada.indice <= ranking.p75 ? "acima da mediana do ranking" : "entre os 25% com mais reclamações";
  }
  return {
    periodo: ranking.periodo,
    encontrada: true,
    nome: achada.nome,
    indice: achada.indice,
    procedentes: achada.procedentes,
    clientes: achada.clientes,
    mediana: ranking.mediana,
    faixa,
  };
}
