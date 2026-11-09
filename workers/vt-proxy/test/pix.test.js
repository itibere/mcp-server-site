import { test } from "node:test";
import assert from "node:assert/strict";
import { crc16, tlv, tipoChave, lerBrCode, acharBrCodes, compararPix, detectarPagamento, INTERMEDIADOR } from "../src/sitesecure/pagamento.js";
import { mascarar } from "../src/sitesecure/pixonly.js";
import { casaDominio } from "../src/sitesecure/util.js";
import { brCode } from "./apoio/ambiente.js";

const ALEATORIA = "123e4567-e89b-12d3-a456-426614174000";
const CNPJ = "11222333000181";
const CPF = "52998224725";

test("crc16: vetor padrao CCITT-FALSE", () => {
  assert.equal(crc16("123456789"), "29B1");
  assert.equal(crc16(""), "FFFF");
});

test("tlv: le campos e ignora tamanho malformado", () => {
  assert.deepEqual(tlv("000201" + "0403abc"), { "00": "01", "04": "abc" });
  assert.deepEqual(tlv("00ZZ01" + "0403abc"), {});
  assert.deepEqual(tlv("00  01"), {});
});

test("tipoChave: reconhece cada formato", () => {
  assert.equal(tipoChave(ALEATORIA), "aleatoria");
  assert.equal(tipoChave("fulano@exemplo.com.br"), "email");
  assert.equal(tipoChave("+5511987654321"), "telefone");
  assert.equal(tipoChave(CNPJ), "cnpj");
  assert.equal(tipoChave("11.222.333/0001-81"), "cnpj");
  assert.equal(tipoChave(CPF), "cpf");
  assert.equal(tipoChave("12345678000100"), "desconhecida");
  assert.equal(tipoChave("qualquer coisa"), "desconhecida");
});

test("lerBrCode: PIX estatico com CNPJ, CRC integro", () => {
  const r = lerBrCode(brCode({ chave: CNPJ, recebedor: "LOJA EXEMPLO LTDA", cidade: "SAO PAULO", valor: "49.90" }));
  assert.equal(r.valido, true);
  assert.equal(r.crcOk, true);
  assert.equal(r.tipoChave, "cnpj");
  assert.equal(r.chave, CNPJ);
  assert.equal(r.recebedor, "LOJA EXEMPLO LTDA");
  assert.equal(r.cidade, "SAO PAULO");
  assert.equal(r.valor, "49.90");
  assert.equal(r.dinamico, false);
});

test("lerBrCode: QR dinamico traz o endereco do PSP", () => {
  const r = lerBrCode(brCode({ psp: "pix.exemplo-psp.com.br/qr/v2/abc123" }));
  assert.equal(r.valido, true);
  assert.equal(r.dinamico, true);
  assert.equal(r.pspUrl, "pix.exemplo-psp.com.br");
  assert.equal(r.chave, null);
});

test("lerBrCode: CRC adulterado e codigo que nao e PIX", () => {
  assert.equal(lerBrCode(brCode({ chave: ALEATORIA, corromper: true })).crcOk, false);
  assert.equal(lerBrCode("texto qualquer").valido, false);
  assert.equal(lerBrCode("").valido, false);
  assert.equal(lerBrCode(null).valido, false);
  assert.equal(lerBrCode("000201" + "x".repeat(60)).valido, false);
});

test("acharBrCodes: extrai o codigo do texto da pagina", () => {
  const codigo = brCode({ chave: ALEATORIA });
  assert.deepEqual(acharBrCodes(`Pague com PIX copia e cola: ${codigo} obrigado`), [codigo]);
  assert.deepEqual(acharBrCodes("sem pix aqui"), []);
});

test("compararPix: CNPJ igual, filial, outro CNPJ, CPF", () => {
  const pix = (chave) => lerBrCode(brCode({ chave, recebedor: "LOJA EXEMPLO LTDA" }));
  assert.equal(compararPix(pix(CNPJ), CNPJ, null).nivel, "bom");
  assert.equal(compararPix(pix(CNPJ), "11222333000262", null).nivel, "bom");
  assert.equal(compararPix(pix(CNPJ), "99888777000100", null).nivel, "baixo");
  assert.equal(compararPix(pix(CNPJ), null, null).nivel, "medio");
  assert.equal(compararPix(pix(CPF), CNPJ, null).nivel, "baixo");
  assert.equal(compararPix({ valido: false }, CNPJ, null), null);
});

test("compararPix: CRC invalido e recebedor que nao condiz com a empresa", () => {
  const ruim = lerBrCode(brCode({ chave: ALEATORIA, corromper: true }));
  assert.equal(compararPix(ruim, null, null).nivel, "medio");
  const empresa = { encontrado: true, razaoSocial: "PADARIA ESTRELA LTDA", nomeFantasia: "ESTRELA" };
  const outro = lerBrCode(brCode({ chave: ALEATORIA, recebedor: "JOSE DA SILVA" }));
  assert.equal(compararPix(outro, null, empresa).nivel, "baixo");
});

test("intermediador: palavra inteira, nao trecho do nome", () => {
  assert.equal(INTERMEDIADOR.test("MERCADO PAGO IP LTDA"), true);
  assert.equal(INTERMEDIADOR.test("PAGSEGURO INTERNET"), true);
  assert.equal(INTERMEDIADOR.test("EFI S.A."), true);
  assert.equal(INTERMEDIADOR.test("MILESTONE COMERCIO LTDA"), false);
  assert.equal(INTERMEDIADOR.test("PEFIL CALCADOS"), false);
});

test("compararPix: recebedor Milestone nao e tratado como intermediador", () => {
  const empresa = { encontrado: true, razaoSocial: "MILESTONE COMERCIO LTDA", nomeFantasia: "" };
  const p = lerBrCode(brCode({ chave: ALEATORIA, recebedor: "MILESTONE COMERCIO LTDA" }));
  const r = compararPix(p, null, empresa);
  assert.equal(r.nivel, "bom");
  assert.ok(r.achados.some((a) => a.includes("condiz com a razão social")));
});

test("mascarar: CPF, e-mail, telefone, aleatoria e desconhecida nunca saem em claro", () => {
  assert.equal(mascarar(CPF, "cpf"), "***.982.247-**");
  assert.equal(mascarar("fulano@exemplo.com.br", "email"), "f***@exemplo.com.br");
  assert.equal(mascarar("+5511987654321", "telefone"), "+5511*****4321");
  assert.equal(mascarar(CNPJ, "cnpj"), "11.222.333/0001-81");
  const aleatoria = mascarar(ALEATORIA, "aleatoria");
  assert.equal(aleatoria, "123e…4000");
  assert.ok(!aleatoria.includes("426614174"));
  assert.equal(mascarar("ABCDEFGHIJKL", "desconhecida"), "ABCD…IJKL");
  assert.equal(mascarar("curta", "desconhecida"), "****");
  assert.equal(mascarar(null, "cpf"), null);
});

test("casaDominio: rotulo inteiro, nunca trecho", () => {
  assert.equal(casaDominio("stone.com.br", "stone.com.br"), true);
  assert.equal(casaDominio("api.stone.com.br", "stone.com.br"), true);
  assert.equal(casaDominio("milestone.com.br", "stone.com.br"), false);
  assert.equal(casaDominio("parede.com.br", "rede.com.br"), false);
  assert.equal(casaDominio("stone.com.br.golpe.com", "stone.com.br"), false);
  assert.equal(casaDominio("API.STONE.COM.BR.", "stone.com.br"), true);
  assert.equal(casaDominio(null, "stone.com.br"), false);
});

test("detectarPagamento: gateway por dominio inteiro", () => {
  const coleta = (...reqs) => ({ requisicoes: reqs, texto: "", cartao: false });
  assert.deepEqual(detectarPagamento(coleta("https://api.stone.com.br/v1/x")).gateways, ["Stone"]);
  assert.deepEqual(detectarPagamento(coleta("https://js.stripe.com/v3/")).gateways, ["Stripe"]);
  assert.deepEqual(detectarPagamento(coleta("https://www.mercadopago.com.br/sdk.js")).gateways, ["Mercado Pago"]);
  assert.equal(detectarPagamento(coleta("https://api.stone.com.br/v1/x")).plataforma, true);
});

test("detectarPagamento: hosts parecidos nao viram gateway (milestone, parede, predial-rede)", () => {
  const coleta = {
    requisicoes: [
      "https://cdn.milestone.com.br/app.js", "https://parede.com.br/a.js", "https://predial-rede.com.br/b.js",
      "https://cielofoods.com/c.js", "https://vindictive.com/d.js", "https://stone.com.br.golpe.com/e.js",
      "https://yampimoveis.com.br/f.js", "https://iugumail.com/g.js",
    ],
    texto: "",
    cartao: false,
  };
  const r = detectarPagamento(coleta);
  assert.deepEqual(r.gateways, []);
  assert.equal(r.plataforma, false);
});

test("detectarPagamento: formulario de cartao liga plataforma mesmo sem gateway", () => {
  const r = detectarPagamento({ requisicoes: [], texto: "", cartao: true });
  assert.equal(r.plataforma, true);
  assert.equal(r.formularioCartao, true);
});
