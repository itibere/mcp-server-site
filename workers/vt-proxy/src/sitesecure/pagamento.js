// Plataforma de pagamento e PIX: o BR Code (EMV/Bacen) diz quem recebe o
// dinheiro; comparamos com a empresa que o site diz ser.
import { cnpjValido, formatarCnpj } from "./empresa.js";
import { hostDe, nomeCombina } from "./util.js";

const GATEWAYS = [
  ["mercadopago", "Mercado Pago"], ["mercadolibre", "Mercado Pago"], ["pagseguro", "PagSeguro/PagBank"],
  ["pagbank", "PagSeguro/PagBank"], ["stripe", "Stripe"], ["pagar.me", "Pagar.me"], ["pagarme", "Pagar.me"],
  ["asaas", "Asaas"], ["cielo", "Cielo"], ["getnet", "Getnet"], ["adyen", "Adyen"], ["paypal", "PayPal"],
  ["iugu", "Iugu"], ["efipay", "Efí"], ["gerencianet", "Efí"], ["appmax", "Appmax"], ["yampi", "Yampi"],
  ["vindi", "Vindi"], ["braintree", "Braintree"], ["rede.com.br", "Rede"], ["stone.com.br", "Stone"],
  ["picpay", "PicPay"], ["hotmart", "Hotmart"], ["kiwify", "Kiwify"], ["eduzz", "Eduzz"],
  ["monetizze", "Monetizze"], ["openpix", "OpenPix"], ["woovi", "Woovi"],
];

export function detectarPagamento(coleta) {
  const achados = new Set();
  for (const url of coleta.requisicoes) {
    const host = hostDe(url) || "";
    for (const [chave, nome] of GATEWAYS) if (host.includes(chave)) achados.add(nome);
  }
  // Citar "PIX" no texto nao faz do site uma plataforma de pagamento (portal
  // de noticia fala de PIX); conta so gateway carregado, form de cartao ou
  // BR Code (este ultimo marcado pelo orquestrador).
  const mencionaPix = /\bpix\b/i.test(coleta.texto) && /(copia e cola|qr ?code|checkout|finalizar compra)/i.test(coleta.texto);
  return { plataforma: coleta.cartao || achados.size > 0, gateways: [...achados], formularioCartao: !!coleta.cartao, mencionaPix };
}

// CRC16-CCITT (poly 0x1021, init 0xFFFF), exigido pelo manual do BR Code.
function crc16(texto) {
  let crc = 0xffff;
  for (let i = 0; i < texto.length; i++) {
    crc ^= texto.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function tlv(s) {
  const campos = {};
  let i = 0;
  while (i + 4 <= s.length) {
    const id = s.slice(i, i + 2);
    const tam = Number(s.slice(i + 2, i + 4));
    if (Number.isNaN(tam)) break;
    campos[id] = s.slice(i + 4, i + 4 + tam);
    i += 4 + tam;
  }
  return campos;
}

function tipoChave(chave) {
  const d = chave.replace(/\D/g, "");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chave)) return "aleatoria";
  if (chave.includes("@")) return "email";
  if (/^\+55\d{10,11}$/.test(chave)) return "telefone";
  if (d.length === 14 && d === chave.replace(/[.\-/]/g, "") && cnpjValido(d)) return "cnpj";
  if (d.length === 11 && d === chave.replace(/[.-]/g, "")) return "cpf";
  return "desconhecida";
}

export function lerBrCode(bruto) {
  // So quebras de linha saem: espacos fazem parte dos campos (nome, cidade).
  const s = (bruto || "").trim().replace(/[\r\n\t]+/g, "");
  if (!s.startsWith("000201") || s.length < 50) return { valido: false, motivo: "não é um PIX copia-e-cola" };
  const semCrc = s.slice(0, -4);
  const crcOk = semCrc.endsWith("6304") && crc16(semCrc) === s.slice(-4).toUpperCase();
  const c = tlv(s);
  const conta = tlv(c["26"] || "");
  if (!/^br\.gov\.bcb\.pix$/i.test(conta["00"] || "")) return { valido: false, motivo: "BR Code sem arranjo PIX" };
  const chave = conta["01"] || null;
  return {
    valido: true,
    crcOk,
    chave,
    tipoChave: chave ? tipoChave(chave) : null,
    dinamico: !!conta["25"],
    pspUrl: conta["25"] ? hostDe("https://" + conta["25"]) : null,
    recebedor: c["59"] || null,
    cidade: c["60"] || null,
    valor: c["54"] || null,
  };
}

export function acharBrCodes(texto) {
  return [...new Set((texto || "").match(/000201[0-9A-Za-z .\-@/:*+_]{40,}?6304[0-9A-Fa-f]{4}/g) || [])].slice(0, 3);
}

// Compara o recebedor do PIX com a empresa do site.
export function compararPix(pix, cnpjSite, empresa) {
  if (!pix?.valido) return null;
  const achados = [];
  let nivel = "bom";
  if (!pix.crcOk) {
    nivel = "medio";
    achados.push("código PIX com dígito de controle (CRC) inválido");
  }
  if (pix.tipoChave === "cnpj") {
    const chave = pix.chave.replace(/\D/g, "");
    if (!cnpjSite) {
      nivel = "medio";
      achados.push(`PIX para o CNPJ ${formatarCnpj(chave)}, mas o site não informa CNPJ para comparar`);
    } else if (chave === cnpjSite) {
      achados.push("chave PIX é o mesmo CNPJ do site");
    } else if (chave.slice(0, 8) === cnpjSite.slice(0, 8)) {
      achados.push("chave PIX é CNPJ de filial da mesma empresa");
    } else {
      nivel = "baixo";
      achados.push(`chave PIX é de outro CNPJ (${formatarCnpj(chave)}), não o do site`);
    }
  } else if (pix.tipoChave === "cpf") {
    nivel = "baixo";
    achados.push("PIX vai para CPF (pessoa física), não para a empresa");
  } else if (pix.tipoChave === "aleatoria" || pix.dinamico) {
    achados.push("chave aleatória/dinâmica: o titular não é público (DICT do Bacen), comparado só o nome do recebedor");
  }
  const intermediador = /mercado ?pago|pagseguro|pagbank|asaas|pagar\.?me|picpay|efi |gerencianet|iugu|stone|cielo|getnet|openpix|woovi|appmax|hotmart|kiwify|eduzz/i;
  if (pix.recebedor && intermediador.test(pix.recebedor)) {
    if (nivel === "bom") nivel = "medio";
    achados.push(`recebedor é o intermediador de pagamento (${pix.recebedor}), não identifica o lojista`);
  } else if (pix.recebedor && empresa?.encontrado) {
    const bate = nomeCombina(pix.recebedor, empresa.razaoSocial, empresa.nomeFantasia || "")
      || nomeCombina(`${empresa.razaoSocial} ${empresa.nomeFantasia || ""}`, pix.recebedor);
    if (bate) achados.push(`recebedor "${pix.recebedor}" condiz com a razão social`);
    else {
      nivel = "baixo";
      achados.push(`recebedor "${pix.recebedor}" não condiz com ${empresa.razaoSocial}`);
    }
  }
  return { nivel, achados, recebedor: pix.recebedor, cidade: pix.cidade, tipoChave: pix.tipoChave };
}
