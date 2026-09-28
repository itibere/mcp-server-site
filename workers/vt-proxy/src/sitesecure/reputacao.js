// Reputacao em bases de ameaca: VirusTotal (agrega ~90 engines, incluindo
// Fortinet, Sophos, Kaspersky, BitDefender...), Google Safe Browsing e URLhaus.
import { buscar, buscarJson } from "./util.js";

// Vendors citados pelo usuario ou de mercado; aparecem no laudo quando o
// VirusTotal trouxer veredito deles para o dominio.
const VENDORS_DESTAQUE = /fortinet|palo alto|cisco|sophos|kaspersky|bitdefender|eset|forcepoint|webroot|trend ?micro|check ?point|google safebrowsing|crowdstrike|sucuri/i;

export async function consultarVirusTotal(orcamento, env, raiz) {
  if (!env.VT_API_KEY) return { disponivel: false, motivo: "sem_chave" };
  const res = await buscar(orcamento, `https://www.virustotal.com/api/v3/domains/${encodeURIComponent(raiz)}`, {
    headers: { "x-apikey": env.VT_API_KEY },
  }, 10_000);
  if (res.status === 429) return { disponivel: false, motivo: "cota_virustotal" };
  if (res.status === 404) return { disponivel: true, conhecido: false };
  if (!res.ok) return { disponivel: false, motivo: "erro_virustotal" };
  const a = (await res.json()).data?.attributes || {};
  const stats = a.last_analysis_stats || {};
  const resultados = a.last_analysis_results || {};
  const vendors = Object.entries(resultados)
    .filter(([nome]) => VENDORS_DESTAQUE.test(nome))
    .map(([nome, r]) => ({ nome, categoria: r.category, resultado: r.result }));
  const alertas = Object.entries(resultados)
    .filter(([, r]) => r.category === "malicious" || r.category === "suspicious")
    .slice(0, 8)
    .map(([nome, r]) => `${nome}: ${r.result}`);
  return {
    disponivel: true,
    conhecido: true,
    maliciosos: stats.malicious || 0,
    suspeitos: stats.suspicious || 0,
    inofensivos: stats.harmless || 0,
    total: Object.values(stats).reduce((s, n) => s + n, 0),
    reputacao: a.reputation ?? 0,
    categorias: [...new Set(Object.values(a.categories || {}))].slice(0, 6),
    criadoEm: a.creation_date ? new Date(a.creation_date * 1000).toISOString() : null,
    vendors,
    alertas,
  };
}

// Safe Browsing em lote: o site e todos os destinos externos numa chamada so.
export async function consultarSafeBrowsing(orcamento, env, urls) {
  if (!env.GSB_API_KEY) return { disponivel: false, motivo: "sem_chave" };
  const lista = [...new Set(urls)].slice(0, 500);
  const r = await buscarJson(orcamento, `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${env.GSB_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client: { clientId: "ij-sitesecure", clientVersion: "1.0" },
      threatInfo: {
        threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
        platformTypes: ["ANY_PLATFORM"],
        threatEntryTypes: ["URL"],
        threatEntries: lista.map((url) => ({ url })),
      },
    }),
  });
  if (r._status) return { disponivel: false, motivo: `erro_${r._status}` };
  const matches = (r.matches || []).map((m) => ({ url: m.threat?.url, tipo: m.threatType }));
  return { disponivel: true, verificadas: lista.length, matches };
}

export async function consultarUrlhaus(orcamento, env, host) {
  if (!env.URLHAUS_AUTH_KEY) return { disponivel: false, motivo: "sem_chave" };
  const r = await buscarJson(orcamento, "https://urlhaus-api.abuse.ch/v1/host/", {
    method: "POST",
    headers: { "Auth-Key": env.URLHAUS_AUTH_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: `host=${encodeURIComponent(host)}`,
  });
  if (r._status) return { disponivel: false, motivo: `erro_${r._status}` };
  if (r.query_status !== "ok") return { disponivel: true, listado: false };
  const online = (r.urls || []).filter((u) => u.url_status === "online").length;
  return { disponivel: true, listado: true, urls: Number(r.url_count) || 0, online };
}
