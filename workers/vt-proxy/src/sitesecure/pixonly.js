// Consulta so do PIX copia-e-cola, sem o link do site.
// Le o BR Code, confere o titular da chave (quando e CNPJ), a reputacao do
// endereco do QR dinamico e a instituicao de pagamento no ranking do BC.
import { lerBrCode } from "./pagamento.js";
import { consultarCnpj, formatarCnpj } from "./empresa.js";
import { consultarRdap } from "./dominio.js";
import { consultarSafeBrowsing } from "./reputacao.js";
import { carregarRanking, identificarInstituicao, situacaoNoRanking } from "./bancocentral.js";
import { identificarGoverno } from "./governo.js";
import { Orcamento, dominioRaiz, nomeCombina } from "./util.js";

const INTERMEDIADOR = /mercado ?pago|pagseguro|pagbank|asaas|pagar\.?me|picpay|\befi\b|gerencianet|iugu|stone|cielo|getnet|openpix|woovi|appmax|hotmart|kiwify|eduzz|infinitepay|cloudwalk/i;

// A chave aparece mascarada no laudo: CPF e e-mail sao dado pessoal.
function mascarar(chave, tipo) {
  if (!chave) return null;
  if (tipo === "cpf") return `***.${chave.replace(/\D/g, "").slice(3, 6)}.${chave.replace(/\D/g, "").slice(6, 9)}-**`;
  if (tipo === "email") return chave.replace(/^(.)[^@]*(@.*)$/, "$1***$2");
  if (tipo === "telefone") return chave.replace(/^(\+55\d{2})\d+(\d{4})$/, "$1*****$2");
  if (tipo === "cnpj") return formatarCnpj(chave.replace(/\D/g, ""));
  return chave;
}

async function etapa(emitir, nome, fn, padrao = null) {
  try {
    const r = await fn();
    await emitir({ etapa: nome, status: "ok" });
    return r;
  } catch (err) {
    await emitir({ etapa: nome, status: "falhou", motivo: String(err?.message || err).slice(0, 120) });
    return padrao;
  }
}

export async function executarPix(env, bruto, emitir, orc = new Orcamento(20)) {
  const pix = lerBrCode(bruto);
  await emitir({ etapa: "pix-leitura", status: "ok" });
  if (!pix.valido) return emitir({ etapa: "erro", erro: "pix_invalido", detalhe: pix.motivo });

  const baixo = [], medio = [], bom = [], obs = [];

  if (pix.crcOk) bom.push("código íntegro: o dígito de controle (CRC) confere");
  else baixo.push("código alterado ou incompleto: o dígito de controle (CRC) não confere. O app do banco deve recusar; não tente corrigir à mão");

  // Titular da chave
  const empresa = await etapa(emitir, "pix-titular", async () => {
    if (pix.tipoChave === "cnpj") return consultarCnpj(orc, pix.chave.replace(/\D/g, ""));
    if (pix.tipoChave === "email") {
      const raiz = dominioRaiz(pix.chave.split("@")[1] || "");
      const r = raiz ? await consultarRdap(orc, raiz) : null;
      return { email: true, raiz, idadeDias: r?.idadeDias ?? null };
    }
    return null;
  }, null);

  if (pix.tipoChave === "cnpj") {
    if (empresa?.encontrado === false) baixo.push("a chave é um CNPJ que não existe na Receita Federal");
    else if (empresa?.encontrado) {
      if (!empresa.ativa) baixo.push(`a chave é o CNPJ ${empresa.cnpj}, com situação ${empresa.situacao}`);
      else bom.push(`a chave é o CNPJ ${empresa.cnpj}, ativo: ${empresa.razaoSocial}`);
      if (empresa.idadeDias != null && empresa.idadeDias < 180) medio.push(`empresa aberta há ${empresa.idadeDias} dias`);
      const bate = pix.recebedor && (nomeCombina(pix.recebedor, empresa.razaoSocial, empresa.nomeFantasia || "") || nomeCombina(`${empresa.razaoSocial} ${empresa.nomeFantasia || ""}`, pix.recebedor));
      if (pix.recebedor && !bate && !INTERMEDIADOR.test(pix.recebedor)) baixo.push(`o nome do recebedor ("${pix.recebedor}") não condiz com a razão social do CNPJ da chave`);
      else if (bate) bom.push(`o nome do recebedor condiz com a razão social`);
    } else obs.push("não foi possível consultar o CNPJ da chave na Receita agora");
  } else if (pix.tipoChave === "cpf") {
    medio.push("a chave é um CPF: o dinheiro vai para uma pessoa física. Numa compra em loja, isso é sinal de atenção");
  } else if (pix.tipoChave === "email" && empresa?.idadeDias != null) {
    if (empresa.idadeDias < 30) baixo.push(`a chave é um e-mail de domínio criado há ${empresa.idadeDias} dias (${empresa.raiz})`);
    else if (empresa.idadeDias < 365) medio.push(`a chave é um e-mail de domínio com menos de 1 ano (${empresa.raiz})`);
  } else if (pix.tipoChave === "aleatoria" || pix.dinamico) {
    obs.push("chave aleatória ou QR dinâmico: o titular não é público (base DICT do Banco Central); confira o nome e o documento no app do banco antes de pagar");
  }

  // QR dinamico: o endereco do payload e da instituicao de pagamento
  let gsb = null;
  let hostIdade = null;
  if (pix.dinamico && pix.pspUrl) {
    const raizPsp = dominioRaiz(pix.pspUrl);
    const [g, r] = await etapa(emitir, "pix-reputacao", () => Promise.all([
      consultarSafeBrowsing(orc, env, [`https://${pix.pspUrl}/`]).catch(() => null),
      consultarRdap(orc, raizPsp).catch(() => null),
    ]), [null, null]);
    gsb = g;
    hostIdade = r?.idadeDias ?? null;
    if (gsb?.matches?.length) baixo.push(`o endereço do QR dinâmico (${pix.pspUrl}) está marcado pelo Google Safe Browsing`);
    if (hostIdade != null && hostIdade < 30) baixo.push(`o endereço do QR dinâmico usa domínio criado há ${hostIdade} dias (${raizPsp})`);
  }

  // Instituicao de pagamento e ranking do Banco Central (so informa)
  const inst = identificarInstituicao(pix);
  const ranking = await etapa(emitir, "pix-instituicao", () => (inst ? carregarRanking(orc) : null), null);
  const bc = situacaoNoRanking(ranking, inst);
  if (inst) bom.push(`instituição de pagamento: ${inst.nome} (identificada pelo ${inst.pelo})`);
  else if (pix.dinamico && pix.pspUrl && !identificarGoverno(pix.pspUrl).governo) {
    medio.push(`o QR dinâmico está hospedado em ${pix.pspUrl}, que não é de instituição de pagamento conhecida`);
  }
  if (pix.recebedor && INTERMEDIADOR.test(pix.recebedor)) obs.push(`o recebedor é o intermediador (${pix.recebedor}), não identifica o lojista`);

  obs.push("antes de confirmar, confira no app do banco o nome e o documento de quem vai receber");

  const nivel = baixo.length ? "baixo" : medio.length ? "medio" : "bom";
  await emitir({
    etapa: "laudo",
    laudo: {
      tipo: "pix",
      analisadoEm: new Date().toISOString(),
      nota: nivel,
      blocos: { pix: { nivel, alertas: [...baixo, ...medio], positivos: bom, observacoes: obs } },
      detalhes: {
        pix: {
          recebedor: pix.recebedor,
          cidade: pix.cidade,
          valor: pix.valor,
          tipoChave: pix.tipoChave,
          chave: mascarar(pix.chave, pix.tipoChave),
          dinamico: pix.dinamico,
          enderecoQr: pix.pspUrl,
          crcOk: pix.crcOk,
        },
        empresa: pix.tipoChave === "cnpj" ? empresa : null,
        instituicao: inst ? { ...inst, ranking: bc } : null,
        fontesIndisponiveis: [pix.dinamico && gsb && !gsb.disponivel && "Google Safe Browsing"].filter(Boolean),
        subrequests: orc.usado,
      },
    },
  });
}
