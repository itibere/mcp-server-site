// Historico das consultas do sitesecure, no D1 (binding HISTORICO).
// Grava so o necessario para saber o que foi consultado: data, tipo, dominio
// (nunca a URL completa, que pode trazer codigo pessoal na query), instituicao
// que recebe o PIX (nunca a chave nem o recebedor) e a nota do laudo.
// Nenhum IP. A data e so o dia (Brasilia), sem hora. Linhas com mais de 12 meses
// sao apagadas por limparHistorico (cron diario, ver wrangler.toml).
// Sem o binding (dev local, testes), nao faz nada.
import { hostDe, resumoErro } from "./util.js";
import { ROTULO_INCOMPLETA } from "./nota.js";

const RETENCAO_MESES = 12;
const LOTE_LIMPEZA = 5000;
const MAX_LOTES = 10;
const HORA = 3600_000;

export function diaBR(agora = Date.now()) {
  return new Date(agora - 3 * HORA).toISOString().slice(0, 10);
}

export function diaLimiteRetencao(agora = Date.now()) {
  const d = new Date(agora - 3 * HORA);
  const dia = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - RETENCAO_MESES);
  // 29/fev vira 28/fev do ano sem bissexto, em vez de transbordar para 1/mar.
  d.setUTCDate(Math.min(dia, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  return d.toISOString().slice(0, 10);
}

const notaDoLaudo = (laudo) => (laudo.notaRotulo === ROTULO_INCOMPLETA ? "incompleta" : laudo.nota);

// Linha do historico a partir do laudo; null se nao houver o que gravar.
export function linhaHistorico(laudo, { cache = false } = {}) {
  if (!laudo || !laudo.nota) return null;
  if (laudo.tipo === "pix") {
    return {
      tipo: "pix",
      dominio: null,
      instituicao: laudo.detalhes?.instituicao?.nome || null,
      nota: notaDoLaudo(laudo),
      cache: cache ? 1 : 0,
    };
  }
  const dominio = laudo.detalhes?.dominio?.raiz || hostDe(laudo.urlFinal || laudo.url || "") || null;
  if (!dominio) return null;
  return {
    tipo: "site",
    dominio: String(dominio).toLowerCase().slice(0, 253),
    instituicao: laudo.detalhes?.pagamento?.pix?.instituicao?.nome || null,
    nota: notaDoLaudo(laudo),
    cache: cache ? 1 : 0,
  };
}

export async function registrarConsulta(env, laudo, opcoes) {
  if (!env.HISTORICO) return;
  const l = linhaHistorico(laudo, opcoes);
  if (!l) return;
  try {
    await env.HISTORICO.prepare(
      "INSERT INTO consultas (em, tipo, dominio, instituicao, nota, cache) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(diaBR(), l.tipo, l.dominio, l.instituicao, l.nota, l.cache).run();
  } catch (err) {
    // Historico nunca derruba a analise.
    console.log(JSON.stringify({ evento: "historico_falhou", erro: String(err?.message || err).slice(0, 120) }));
  }
}

// Apaga o que passou da retencao, em lotes (cada linha apagada conta como
// varias escritas no D1). Chamada pelo cron diario; o que sobrar do teto de
// lotes sai na proxima execucao. Em falha, registra e relanca: o cron precisa
// aparecer como falho no painel.
export async function limparHistorico(env, agora = Date.now()) {
  if (!env.HISTORICO) return;
  const corte = diaLimiteRetencao(agora);
  let apagadas = 0;
  try {
    for (let lote = 0; lote < MAX_LOTES; lote++) {
      const r = await env.HISTORICO.prepare(
        "DELETE FROM consultas WHERE id IN (SELECT id FROM consultas WHERE em < ? ORDER BY em LIMIT ?)",
      ).bind(corte, LOTE_LIMPEZA).run();
      const n = r?.meta?.changes ?? 0;
      apagadas += n;
      if (n < LOTE_LIMPEZA) return;
    }
    console.log(JSON.stringify({ evento: "limpeza_historico_parcial", apagadas, corte }));
  } catch (err) {
    console.log(JSON.stringify({ evento: "limpeza_historico_falhou", apagadas, corte, ...resumoErro(err) }));
    throw err;
  }
}
