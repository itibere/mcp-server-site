// Cabecalhos de seguranca HTTP e TLS (NIST SP 800-52r2, SP 800-53 SC-8/SC-23).
import { buscar } from "./util.js";

export function avaliarCabecalhos(headers, urlFinal, tls) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const csp = h["content-security-policy"] || "";
  const hsts = h["strict-transport-security"] || "";
  const maxAge = Number(hsts.match(/max-age=(\d+)/i)?.[1] || 0);
  const itens = {
    https: urlFinal.startsWith("https://"),
    hsts: maxAge >= 15_552_000, // >= 180 dias
    csp: !!csp,
    antiClickjacking: /frame-ancestors/i.test(csp) || /deny|sameorigin/i.test(h["x-frame-options"] || ""),
    nosniff: /nosniff/i.test(h["x-content-type-options"] || ""),
    referrerPolicy: !!h["referrer-policy"],
  };
  const faltando = Object.entries(itens).filter(([, ok]) => !ok).map(([k]) => k);
  let certificado = null;
  if (tls) {
    const dias = Math.floor((tls.validoAte - Date.now()) / 86_400_000);
    certificado = { emissor: tls.emissor, protocolo: tls.protocolo, diasParaVencer: dias };
  }
  return { itens, faltando, pontos: Object.values(itens).filter(Boolean).length, total: 6, certificado };
}

// HTTP puro redireciona para HTTPS?
export async function redirecionaParaHttps(orcamento, host) {
  try {
    const res = await buscar(orcamento, `http://${host}/`, { redirect: "manual" }, 6000);
    const destino = res.headers.get("location") || "";
    return res.status >= 300 && res.status < 400 && destino.startsWith("https://");
  } catch {
    return null;
  }
}
