import { SitesecureDO } from "../../src/sitesecure/guarda.js";
import { RateLimiterDO } from "../../src/index.js";
import { crc16 } from "../../src/sitesecure/pagamento.js";

export function armazenamentoFalso() {
  const dados = new Map();
  return {
    dados,
    async get(k) {
      return dados.has(k) ? structuredClone(dados.get(k)) : undefined;
    },
    async put(k, v) {
      if (typeof k === "object") for (const [a, b] of Object.entries(k)) dados.set(a, structuredClone(b));
      else dados.set(k, structuredClone(v));
    },
    async setAlarm() {},
    async deleteAll() {
      dados.clear();
    },
  };
}

// Binding de Durable Object em memoria: um objeto por nome, como idFromName.
export function bindingFalso(Classe) {
  const objetos = new Map();
  const chamadas = [];
  const binding = {
    objetos,
    chamadas,
    idFromName: (nome) => nome,
    get(nome) {
      if (!objetos.has(nome)) objetos.set(nome, { armazenamento: armazenamentoFalso() });
      const o = objetos.get(nome);
      o.instancia ||= new Classe({ storage: o.armazenamento });
      return {
        fetch: async (url, init) => {
          chamadas.push({ nome, caminho: new URL(url).pathname });
          return o.instancia.fetch(new Request(url, init));
        },
      };
    },
  };
  return binding;
}

export const bindingSitesecure = () => bindingFalso(SitesecureDO);
export const bindingLimitador = () => bindingFalso(RateLimiterDO);

export function contexto() {
  const pendentes = [];
  return { waitUntil: (p) => pendentes.push(p), esperar: () => Promise.all(pendentes) };
}

export function pedido(corpo, { url = "https://api.itibere.tec.br/sitesecure/analisar", headers = {}, bruto = false } = {}) {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: bruto ? corpo : JSON.stringify(corpo) });
}

export async function eventos(resposta) {
  const txt = await resposta.text();
  return txt.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Troca o fetch global durante um teste; sem rede real.
export function simularRede(t, resolver) {
  const original = globalThis.fetch;
  const chamadas = [];
  globalThis.fetch = async (url, init) => {
    chamadas.push(String(url));
    return resolver(String(url), init);
  };
  t.after(() => { globalThis.fetch = original; });
  return chamadas;
}

export const semRede = () => { throw new Error("rede indisponivel no teste"); };

export function dns(respostas) {
  return (url) => {
    const u = new URL(url);
    if (!u.hostname.includes("cloudflare-dns.com")) return semRede();
    const nome = u.searchParams.get("name");
    const tipo = u.searchParams.get("type");
    const lista = respostas[nome]?.[tipo] || [];
    const code = { A: 1, AAAA: 28 }[tipo];
    return Response.json({ Status: 0, AD: false, Answer: lista.map((data) => ({ type: code, data })) });
  };
}

const campo = (id, v) => id + String(v.length).padStart(2, "0") + v;

export function brCode({ chave, recebedor = "LOJA EXEMPLO", cidade = "SAO PAULO", valor, psp, corromper = false }) {
  const conta = campo("00", "br.gov.bcb.pix") + (chave ? campo("01", chave) : "") + (psp ? campo("25", psp) : "");
  const s = campo("00", "01") + campo("26", conta) + campo("52", "0000") + campo("53", "986") + (valor ? campo("54", valor) : "")
    + campo("58", "BR") + campo("59", recebedor) + campo("60", cidade) + campo("62", campo("05", "***")) + "6304";
  const crc = crc16(s);
  return s + (corromper ? (crc === "0000" ? "0001" : "0000") : crc);
}
