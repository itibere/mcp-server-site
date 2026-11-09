// Guarda anti-SSRF: a analise so busca sites publicos na internet.
import { doh } from "./util.js";

const HOSTS_PROIBIDOS = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|arpa|test|invalid|example)$/i;
const MAX_SALTOS_NOVOS = 4;

export function ipv4Privado(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

// 8 grupos de 16 bits, ou null se o texto nao for um IPv6 valido.
export function expandirIpv6(texto) {
  let ip = String(texto).toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const v4 = ip.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const o = v4[2].split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    ip = `${v4[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const partes = ip.split("::");
  if (partes.length > 2) return null;
  const ler = (t) => (t ? t.split(":") : []);
  const cabeca = ler(partes[0]);
  const cauda = partes.length === 2 ? ler(partes[1]) : [];
  const falta = 8 - cabeca.length - cauda.length;
  if (partes.length === 1 ? falta !== 0 : falta < 1) return null;
  const grupos = [...cabeca, ...Array(partes.length === 2 ? falta : 0).fill("0"), ...cauda];
  if (grupos.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return grupos.map((g) => parseInt(g, 16));
}

export function ipv6Privado(ip) {
  const g = expandirIpv6(ip);
  if (!g) return true;
  const embutido = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return ipv4Privado(embutido(g[6], g[7]));
  return (
    (g[0] & 0xfe00) === 0xfc00 ||
    (g[0] & 0xffc0) === 0xfe80 ||
    (g[0] & 0xff00) === 0xff00 ||
    g[0] === 0x2002 ||
    (g[0] === 0x64 && g[1] === 0xff9b) ||
    (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) ||
    (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0)
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
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return { erro: "ip_nao_permitido" };
  if (!host.includes(".") || HOSTS_PROIBIDOS.test(host)) return { erro: "host_nao_permitido" };
  if (host !== u.hostname) u.hostname = host;
  u.hash = "";
  return { url: u };
}

// Resolve o host (A e AAAA) e recusa se qualquer endereco for privado/reservado.
// Devolve os IPv4 para o modulo de host reaproveitar (economiza subrequest).
export async function resolverPublico(orcamento, host) {
  const [a, aaaa] = await Promise.all([doh(orcamento, host, "A"), doh(orcamento, host, "AAAA")]);
  if (a._status || aaaa._status) return { erro: "dns_falhou", dnssec: false, ips: [] };
  const ips = (a.Answer || []).filter((r) => r.type === 1).map((r) => r.data);
  const ipv6 = (aaaa.Answer || []).filter((r) => r.type === 28).map((r) => r.data);
  if (!ips.length && !ipv6.length) return { erro: "dominio_nao_resolve", dnssec: false, ips };
  if (ips.some(ipv4Privado) || ipv6.some(ipv6Privado)) return { erro: "ip_privado", dnssec: false, ips };
  return { ips, ipv6, dnssec: a.AD === true };
}

// Confere o host de cada URL (sintaxe e DNS). `vistos` guarda os hosts ja
// resolvidos e publicos, para nao consultar o mesmo host duas vezes.
export async function verificarDestinos(orcamento, vistos, urls) {
  let novos = 0;
  for (const bruta of urls) {
    const v = validarUrl(bruta);
    if (v.erro) return { erro: v.erro };
    const host = v.url.hostname;
    if (vistos.has(host)) continue;
    if (++novos > MAX_SALTOS_NOVOS) return { erro: "redirecionamentos_demais" };
    const r = await resolverPublico(orcamento, host).catch(() => ({ erro: "dns_falhou" }));
    if (r.erro) return { erro: r.erro };
    vistos.add(host);
  }
  return {};
}
