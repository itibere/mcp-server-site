// Empresa por tras do site: CNPJ no rodape (ou do titular do .br no RDAP),
// situacao cadastral na Receita via BrasilAPI.
import { buscarJson, diasDesde, nomeCombina } from "./util.js";

export function cnpjValido(c) {
  const d = String(c).replace(/\D/g, "");
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const calc = (base) => {
    let soma = 0;
    let peso = base.length - 7;
    for (const n of base) {
      soma += Number(n) * peso--;
      if (peso < 2) peso = 9;
    }
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(d.slice(0, 12)) === Number(d[12]) && calc(d.slice(0, 13)) === Number(d[13]);
}

export function acharCnpjs(texto) {
  const achados = (texto || "").match(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g) || [];
  return [...new Set(achados.map((c) => c.replace(/\D/g, "")))].filter(cnpjValido);
}

export function formatarCnpj(d) {
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

// Reserva: CNPJ.ws publico (3 consultas/min), usado quando a BrasilAPI falha.
async function consultarCnpjWs(orcamento, cnpj) {
  if (!orcamento.pode()) return { encontrado: null, motivo: "sem_cota" };
  const r = await buscarJson(orcamento, `https://publica.cnpj.ws/cnpj/${cnpj}`, {}, 10_000);
  if (r._status === 404 || r._status === 400) return { encontrado: false };
  if (r._status) return { encontrado: null, motivo: `erro_${r._status}` };
  const est = r.estabelecimento || {};
  const situacao = est.situacao_cadastral || "";
  return {
    encontrado: true,
    cnpj: formatarCnpj(cnpj),
    razaoSocial: r.razao_social,
    nomeFantasia: est.nome_fantasia || null,
    situacao,
    ativa: situacao.toUpperCase() === "ATIVA",
    abertura: est.data_inicio_atividade,
    idadeDias: est.data_inicio_atividade ? diasDesde(est.data_inicio_atividade) : null,
    municipio: est.cidade?.nome && est.estado?.sigla ? `${est.cidade.nome}/${est.estado.sigla}` : null,
    atividade: est.atividade_principal?.descricao || null,
  };
}

export async function consultarCnpj(orcamento, cnpj) {
  const r = await buscarJson(orcamento, `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, {}, 10_000);
  if (r._status === 404) return { encontrado: false };
  if (r._status) return consultarCnpjWs(orcamento, cnpj);
  return {
    encontrado: true,
    cnpj: formatarCnpj(cnpj),
    razaoSocial: r.razao_social,
    nomeFantasia: r.nome_fantasia || null,
    situacao: r.descricao_situacao_cadastral,
    ativa: String(r.descricao_situacao_cadastral || "").toUpperCase() === "ATIVA",
    abertura: r.data_inicio_atividade,
    idadeDias: r.data_inicio_atividade ? diasDesde(r.data_inicio_atividade) : null,
    municipio: r.municipio && r.uf ? `${r.municipio}/${r.uf}` : null,
    atividade: r.cnae_fiscal_descricao || null,
  };
}

// Escolhe o CNPJ: rodape > titular do dominio .br > corpo da pagina.
export function escolherCnpj(coleta, rdap) {
  const rodape = acharCnpjs(coleta.footerTexto);
  if (rodape.length) return { cnpj: rodape[0], origem: "rodapé" };
  if (rdap?.cnpjTitular && cnpjValido(rdap.cnpjTitular)) return { cnpj: rdap.cnpjTitular, origem: "titular do domínio (registro.br)" };
  const corpo = acharCnpjs(coleta.texto);
  if (corpo.length) return { cnpj: corpo[0], origem: "corpo da página" };
  return null;
}

export function empresaCondiz(empresa, raiz, coleta) {
  if (!empresa?.encontrado) return null;
  return nomeCombina(`${empresa.razaoSocial} ${empresa.nomeFantasia || ""}`, raiz, coleta.titulo, coleta.footerTexto.slice(0, 2000));
}
