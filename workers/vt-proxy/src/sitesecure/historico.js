// Historico das consultas do sitesecure, no D1 (binding HISTORICO).
// Grava so o necessario para saber o que foi consultado: data, tipo, dominio
// (nunca a URL completa, que pode trazer codigo pessoal na query), instituicao
// que recebe o PIX (nunca a chave nem o recebedor) e a nota do laudo.
// Nenhum IP. Sem o binding (dev local, testes), nao faz nada.
import { hostDe } from "./util.js";

// Linha do historico a partir do laudo; null se nao houver o que gravar.
export function linhaHistorico(laudo, { cache = false } = {}) {
  if (!laudo || !laudo.nota) return null;
  if (laudo.tipo === "pix") {
    return {
      tipo: "pix",
      dominio: null,
      instituicao: laudo.detalhes?.instituicao?.nome || null,
      nota: laudo.nota,
      cache: cache ? 1 : 0,
    };
  }
  const dominio = laudo.detalhes?.dominio?.raiz || hostDe(laudo.urlFinal || laudo.url || "") || null;
  if (!dominio) return null;
  return {
    tipo: "site",
    dominio: String(dominio).toLowerCase().slice(0, 253),
    instituicao: laudo.detalhes?.pagamento?.pix?.instituicao?.nome || null,
    nota: laudo.nota,
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
    ).bind(new Date().toISOString(), l.tipo, l.dominio, l.instituicao, l.nota, l.cache).run();
  } catch (err) {
    // Historico nunca derruba a analise.
    console.log(JSON.stringify({ evento: "historico_falhou", erro: String(err?.message || err).slice(0, 120) }));
  }
}
