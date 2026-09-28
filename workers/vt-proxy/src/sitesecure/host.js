// Origem do host: organizacao dona do IP (RDAP de IP) e dicas de cabecalho,
// classificadas pela lista curada data/hosts_tier.json.
import tabela from "./data/hosts_tier.json";
import { buscarJson } from "./util.js";

const HOSTS = tabela.hosts.map((h) => ({ ...h, re: new RegExp(h.padrao, "i") }));

// Cabecalhos que denunciam a plataforma mesmo atras de CDN.
const DICAS = [
  ["x-vercel-id", "vercel"], ["x-nf-request-id", "netlify"], ["x-github-request-id", "github"],
  ["x-amz-cf-id", "amazon"], ["x-amz-request-id", "amazon"], ["x-azure-ref", "azure"],
  ["x-shopid", "shopify"], ["x-shopify-stage", "shopify"], ["x-vtex-cache-status", "vtex"],
  ["x-wix-request-id", "wix"], ["cf-ray", "cloudflare"], ["x-served-by", "fastly"],
];

function classificar(texto) {
  return HOSTS.find((h) => h.re.test(texto)) || null;
}

export async function identificarHost(orcamento, ips, headers) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const plataformas = DICAS.filter(([cab]) => h[cab]).map(([, nome]) => nome);
  if (h.server) plataformas.push(h.server);

  let organizacao = null;
  if (ips[0]) {
    // A ARIN redireciona para o RIR certo (LACNIC, RIPE...) quando o IP nao e dela.
    const r = await buscarJson(orcamento, `https://rdap.arin.net/registry/ip/${ips[0]}`, {
      redirect: "follow",
      headers: { Accept: "application/rdap+json" },
    }, 8000);
    if (!r._status) {
      const ent = (r.entities || []).find((e) => (e.roles || []).includes("registrant")) || (r.entities || [])[0];
      const fn = ent?.vcardArray?.[1]?.find((c) => c[0] === "fn")?.[3];
      organizacao = [r.name, fn].filter(Boolean).join(" / ") || null;
    }
  }

  // Plataforma declarada no cabecalho vale mais que o dono do IP (ex.: Vercel
  // em cima de AWS), exceto quando o IP e de provedor classificado como baixo.
  const porIp = organizacao ? classificar(organizacao) : null;
  const porCabecalho = plataformas.map(classificar).find(Boolean) || null;
  const escolhido = porIp?.tier === "baixo" ? porIp : porCabecalho || porIp;
  return {
    ip: ips[0] || null,
    organizacao,
    plataformas: [...new Set(plataformas)].slice(0, 4),
    nome: escolhido?.nome || organizacao || "desconhecido",
    // Fora da lista curada = neutro: so hospedagem de ma fama derruba a nota.
    tier: escolhido?.tier || "neutro",
    conhecido: !!escolhido,
  };
}
