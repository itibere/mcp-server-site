// Dominios de governo: so orgao publico consegue registrar. Isso comprova a
// identidade, nao a limpeza: site de prefeitura invadido com spam de aposta e
// comum, entao as checagens de ameaca continuam valendo.

// Sufixos restritos no Brasil (registro.br exige comprovacao de orgao publico).
const BR = [
  [".gov.br", "Poder Executivo"],
  [".leg.br", "Poder Legislativo"],
  [".jus.br", "Poder Judiciário"],
  [".mp.br", "Ministério Público"],
  [".mil.br", "Forças Armadas"],
  [".def.br", "Defensoria Pública"],
];

// Governo de outros paises (sufixos restritos na propria politica do registro).
// "(^|\.)": a raiz pode vir sem subdominio (ex.: "gov.uk").
const EXTERIOR = /((^|\.)(gov|mil|int)$)|((^|\.)(gov|gob|gouv|go|govt)\.[a-z]{2}$)|((^|\.)gc\.ca$)|((^|\.)europa\.eu$)/i;

export function identificarGoverno(host) {
  const h = `.${host.toLowerCase()}`;
  for (const [sufixo, esfera] of BR) {
    if (h.endsWith(sufixo)) return { governo: true, pais: "BR", esfera };
  }
  if (EXTERIOR.test(host)) return { governo: true, pais: "exterior", esfera: "governo estrangeiro" };
  return { governo: false };
}

// Termos de golpe que imitam servico publico. Termos genericos ("receita",
// "caixa", "pix") ficam de fora: pegariam site de receita de bolo e loja de caixa.
const IMITACAO = [
  /(^|[.-])gov-?br([.-]|$)/i,          // gov-br.com, govbr.site
  /(^|[.-])gov\.br\./i,                // gov.br.qualquer.com
  /(^|[.-])(meu|portal|acesso|consulta)-?gov([.-]|$)/i,
  /receita-?federal|restituicao|irpf/i,
  /(^|[.-])(meu)?-?inss([.-]|$)/i,
  /(^|[.-])detran/i,
  /cadunico|bolsa-?familia|auxilio-?brasil|valores-?a-?receber|svr-?bcb/i,
  /(^|[.-])correios/i,
  /(^|[.-])serpro([.-]|$)/i,
];

// Marcas publicas cujo dominio oficial nao e .gov.br.
const OFICIAIS = new Set(["correios.com.br"]);

export function imitaGoverno(host, raiz) {
  if (identificarGoverno(host).governo || OFICIAIS.has(raiz)) return null;
  const casou = IMITACAO.find((re) => re.test(host));
  return casou ? `o endereço usa termo de serviço público (${host}) mas não é domínio de governo` : null;
}
