// Guarda anti-SSRF: a analise so busca sites publicos na internet.
import { doh } from "./util.js";

const HOSTS_PROIBIDOS = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|arpa|test|invalid|example)$/i;

function ipv4Privado(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

export function validarUrl(bruta) {
  if (typeof bruta !== "string" || bruta.length > 2048) return { erro: "url_invalida" };
  let texto = bruta.trim();
  if (!/^[a-z]+:\/\//i.test(texto)) texto = "https://" + texto;
  let u;
  try {
    u = new URL(texto);
  } catch {
    return { erro: "url_invalida" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { erro: "protocolo_nao_permitido" };
  if (u.port && u.port !== "80" && u.port !== "443") return { erro: "porta_nao_permitida" };
  if (u.username || u.password) return { erro: "url_com_credenciais" };
  const host = u.hostname.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return { erro: "ip_nao_permitido" };
  if (!host.includes(".") || HOSTS_PROIBIDOS.test(host)) return { erro: "host_nao_permitido" };
  u.hash = "";
  return { url: u };
}

// Resolve o host e recusa se qualquer A apontar para faixa privada/reservada.
// Devolve os IPs para o modulo de host reaproveitar (economiza subrequest).
export async function resolverPublico(orcamento, host) {
  const r = await doh(orcamento, host, "A");
  const ips = (r.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
  if (!ips.length) return { erro: "dominio_nao_resolve", dnssec: false, ips };
  if (ips.some(ipv4Privado)) return { erro: "ip_privado", dnssec: false, ips };
  return { ips, dnssec: r.AD === true };
}
