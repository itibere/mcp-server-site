// Boas praticas oficiais ("goodlist"): o que o site cumpre conta a favor dele.
// Nunca anula alerta grave; so alivia alerta leve na nota.
//
// Fontes: Decreto 7.962/2013 art. 2 (e-commerce), CDC art. 49 (arrependimento),
// LGPD art. 9 (transparencia), NIST SP 800-52r2 (TLS), NIST SP 800-177 (e-mail),
// CISA BOD 18-01 (HTTPS/HSTS/DMARC), OWASP Secure Headers, RFC 9116 (security.txt),
// RFC 8659 (CAA).
import { buscar, buscarJson } from "./util.js";

// Busca security.txt e status na lista de HSTS preload: 2 subrequests.
export async function coletarExtras(orcamento, host, raiz) {
  const [securityTxt, preload] = await Promise.all([
    (async () => {
      if (!orcamento.pode()) return null;
      try {
        const res = await buscar(orcamento, `https://${host}/.well-known/security.txt`, { redirect: "follow" }, 5000);
        if (!res.ok || !/text\/plain/i.test(res.headers.get("content-type") || "")) return false;
        const texto = (await res.text()).slice(0, 4000);
        return /^\s*contact\s*:/im.test(texto);
      } catch {
        return null;
      }
    })(),
    (async () => {
      if (!orcamento.pode()) return null;
      const r = await buscarJson(orcamento, `https://hstspreload.org/api/v2/status?domain=${encodeURIComponent(raiz)}`, {}, 5000).catch(() => ({ _status: 0 }));
      return r._status ? null : r.status === "preloaded";
    })(),
  ]);
  return { securityTxt, preload };
}

const RE = {
  privacidade: /privacidade|privacy|lgpd|protecao-de-dados|dados-pessoais/i,
  trocas: /troca|devolu|arrependimento|reembolso|cancelamento/i,
  contato: /fale-conosco|fale conosco|contato|atendimento|\bsac\b|ouvidoria|central-de-ajuda|ajuda/i,
  email: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  telefone: /(0800[\s-]?\d{3}[\s-]?\d{4})|(\(?\d{2}\)?\s?9?\d{4}[\s-]?\d{4})/,
  endereco: /\b\d{5}-?\d{3}\b|\b(rua|r\.|avenida|av\.|rodovia|rod\.|alameda|travessa|estrada|praça)\s+[a-zà-ú]/i,
};

function temLink(links, re) {
  return links.some((l) => re.test(l.href) || re.test(l.texto || ""));
}

export function avaliarBoasPraticas({ coleta, hardening, dns, rdap, cnpjInfo, pagamento, extras, governo }) {
  const h = Object.fromEntries(Object.entries(coleta.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const https = coleta.urlFinal.startsWith("https://");
  const itens = [];
  const add = (grupo, nome, ok, fonte) => itens.push({ grupo, nome, ok, fonte });

  // Tecnicas
  // Sem navegador nao ha dado de TLS: vale so o HTTPS.
  const tlsOk = coleta.tls ? /TLS 1\.[23]/.test(coleta.tls.protocolo || "") : true;
  add("técnica", "HTTPS com TLS 1.2 ou superior", https && tlsOk, "NIST SP 800-52r2");
  add("técnica", "HSTS ativo (mínimo 180 dias)", !!hardening?.itens?.hsts, "CISA BOD 18-01");
  add("técnica", "Na lista de pré-carregamento HSTS", extras?.preload ?? null, "hstspreload.org");
  add("técnica", "Content-Security-Policy", !!hardening?.itens?.csp, "OWASP Secure Headers");
  add("técnica", "Proteção contra clickjacking", !!hardening?.itens?.antiClickjacking, "OWASP Secure Headers");
  add("técnica", "X-Content-Type-Options: nosniff", !!hardening?.itens?.nosniff, "OWASP Secure Headers");
  add("técnica", "Referrer-Policy", !!hardening?.itens?.referrerPolicy, "OWASP Secure Headers");
  add("técnica", "Permissions-Policy", !!h["permissions-policy"], "OWASP Secure Headers");
  add("técnica", "security.txt com contato de segurança", extras?.securityTxt ?? null, "RFC 9116 / CISA");
  add("técnica", "DNSSEC", dns ? !!(dns.dnssec || rdap?.dnssecDelegado) : null, "NIST SP 800-177");
  add("técnica", "Registro CAA (quem pode emitir certificado)", dns ? !!dns.caa : null, "RFC 8659");
  add("técnica", "DMARC restritivo (quarantine/reject)", dns ? dns.politicaDmarc === "quarantine" || dns.politicaDmarc === "reject" : null, "NIST SP 800-177 / BOD 18-01");
  if (coleta.modo === "navegador" && https) {
    const misto = coleta.requisicoes.some((u) => u.startsWith("http://"));
    add("técnica", "Sem conteúdo misto (HTTP em página HTTPS)", !misto, "OWASP");
  }

  // Transparencia e consumidor
  const links = coleta.links || [];
  add("consumidor", "Política de privacidade", temLink(links, RE.privacidade), "LGPD art. 9º");
  if (pagamento?.plataforma && !governo?.governo) {
    const textoRodape = `${coleta.footerTexto || ""} ${coleta.texto?.slice(-6000) || ""}`;
    add("consumidor", "Razão social e CNPJ visíveis", !!cnpjInfo && cnpjInfo.origem !== "titular do domínio (registro.br)", "Decreto 7.962/2013, art. 2º, I");
    add("consumidor", "Endereço físico", RE.endereco.test(textoRodape), "Decreto 7.962/2013, art. 2º, II");
    add("consumidor", "Canal de contato (e-mail, telefone ou SAC)", RE.email.test(textoRodape) || RE.telefone.test(textoRodape) || temLink(links, RE.contato), "Decreto 7.962/2013, art. 2º, II");
    add("consumidor", "Política de trocas e devoluções", temLink(links, RE.trocas), "CDC art. 49");
    if (rdap?.cnpjTitular && cnpjInfo) {
      add("consumidor", "CNPJ do site igual ao titular do domínio", cnpjInfo.cnpj.slice(0, 8) === rdap.cnpjTitular.slice(0, 8), "registro.br");
    }
  }

  const avaliados = itens.filter((i) => i.ok !== null);
  const cumpridos = avaliados.filter((i) => i.ok).length;
  const consumidor = avaliados.filter((i) => i.grupo === "consumidor" && i.nome !== "Política de privacidade");
  return {
    cumpridos,
    total: avaliados.length,
    proporcao: avaliados.length ? cumpridos / avaliados.length : 0,
    itens,
    faltandoConsumidor: consumidor.filter((i) => !i.ok).map((i) => i.nome),
  };
}
