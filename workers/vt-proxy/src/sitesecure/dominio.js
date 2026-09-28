// Idade/titular do dominio (RDAP) e registros DNS de protecao (NIST SP 800-177).
import { buscarJson, doh, diasDesde } from "./util.js";

export async function consultarRdap(orcamento, raiz) {
  const base = raiz.endsWith(".br") ? "https://rdap.registro.br/domain/" : "https://rdap.org/domain/";
  const r = await buscarJson(orcamento, base + encodeURIComponent(raiz), { redirect: "follow" }, 8000);
  if (r._status) return { encontrado: false };
  const evento = (acao) => (r.events || []).find((e) => e.eventAction === acao)?.eventDate || null;
  const registrante = (r.entities || []).find((e) => (e.roles || []).includes("registrant"));
  const cnpjTitular = (registrante?.publicIds || []).find((p) => p.type === "cnpj")?.identifier?.replace(/\D/g, "") || null;
  const criadoEm = evento("registration");
  return {
    encontrado: true,
    criadoEm,
    idadeDias: criadoEm ? diasDesde(criadoEm) : null,
    expiraEm: evento("expiration"),
    cnpjTitular,
    dnssecDelegado: r.secureDNS?.delegationSigned === true,
  };
}

function txts(resposta) {
  return (resposta.Answer || []).filter((a) => a.type === 16).map((a) => a.data.replace(/^"|"$/g, "").replace(/"\s*"/g, ""));
}

export async function consultarDns(orcamento, host, raiz) {
  const [txtRaiz, dmarc, caa] = await Promise.all([
    doh(orcamento, raiz, "TXT"),
    doh(orcamento, `_dmarc.${raiz}`, "TXT"),
    doh(orcamento, raiz, "CAA"),
  ]);
  const spf = txts(txtRaiz).find((t) => t.toLowerCase().startsWith("v=spf1")) || null;
  const dmarcTxt = txts(dmarc).find((t) => t.toLowerCase().startsWith("v=dmarc1")) || null;
  const politicaDmarc = dmarcTxt?.match(/p=(\w+)/i)?.[1]?.toLowerCase() || null;
  return {
    spf,
    spfRestritivo: !!spf && /[-~]all/.test(spf),
    dmarc: dmarcTxt,
    politicaDmarc,
    caa: (caa.Answer || []).some((a) => a.type === 257),
  };
}
