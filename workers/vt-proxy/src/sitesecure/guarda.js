// Guarda do sitesecure: limites por IP, castigo progressivo, teto geral diario
// e cache de laudos. Um Durable Object (SQLite, plano gratuito) por chave:
//   "ip:<ip>"       janela deslizante, limite diario e bloqueio do IP
//   "global"        teto de analises do dia, somando todos os IPs
//   "cache:<hash>"  eventos finais de uma analise (laudos), por 1 hora
// O nome do objeto e derivado do IP pelo proprio Cloudflare (idFromName); o IP
// nao e gravado no armazenamento. Todo estado se apaga sozinho (alarm).

import { expandirIpv6 } from "./guard.js";
import { resumoErro } from "./util.js";

export const LIMITES_SITESECURE = {
  porJanela: 5,
  janelaMs: 10 * 60_000, // janela deslizante: 5 analises em quaisquer 10 min
  porDia: 20,
  recusasParaBloqueio1h: 3,
  recusasParaBloqueio24h: 6,
  tetoGlobalDia: 150,
  cacheMs: 60 * 60_000,
  ipApagarMs: 48 * 3600_000, // estado de IP apagado 48 h depois do ultimo uso
};

const HORA = 3600_000;

// Dia civil de Brasilia (UTC-3, sem horario de verao desde 2019).
function diaBR(agora) {
  return new Date(agora - 3 * HORA).toISOString().slice(0, 10);
}
function segundosAteAmanhaBR(agora) {
  const inicioDia = Date.parse(`${diaBR(agora)}T00:00:00Z`) + 3 * HORA;
  return Math.ceil((inicioDia + 24 * HORA - agora) / 1000);
}

const json = (obj) => new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } });

export class SitesecureDO {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const u = new URL(request.url);
    const s = this.state.storage;
    const agora = Date.now();
    const L = LIMITES_SITESECURE;

    if (u.pathname === "/ip/estado") {
      const bloqueioAte = (await s.get("bloqueioAte")) || 0;
      if (bloqueioAte <= agora) return json({ bloqueado: false });
      // Insistir durante o bloqueio conta como recusa e pode estender para 24 h.
      const dia = diaBR(agora);
      let rec = (await s.get("recusas")) || { dia, n: 0 };
      if (rec.dia !== dia) rec = { dia, n: 0 };
      rec.n += 1;
      let ate = bloqueioAte;
      if (rec.n >= L.recusasParaBloqueio24h && bloqueioAte - agora < 23 * HORA) ate = agora + 24 * HORA;
      await s.put({ recusas: rec, bloqueioAte: ate });
      return json({ bloqueado: true, tentarEm: Math.ceil((ate - agora) / 1000) });
    }

    if (u.pathname === "/ip/consumir") {
      const dia = diaBR(agora);
      const log = ((await s.get("log")) || []).filter((t) => agora - t < L.janelaMs);
      let d = (await s.get("dia")) || { dia, n: 0 };
      if (d.dia !== dia) d = { dia, n: 0 };

      let motivo = null;
      let tentarEm = 0;
      if (d.n >= L.porDia) {
        motivo = "limite_diario";
        tentarEm = segundosAteAmanhaBR(agora);
      } else if (log.length >= L.porJanela) {
        motivo = "rate_limit_excedido";
        tentarEm = Math.ceil((log[0] + L.janelaMs - agora) / 1000);
      }

      if (motivo) {
        const extra = await this.registrarRecusa(dia, agora);
        if (extra.bloqueioAte) return json({ ok: false, motivo: "bloqueado", tentarEm: Math.ceil((extra.bloqueioAte - agora) / 1000) });
        return json({ ok: false, motivo, tentarEm });
      }

      log.push(agora);
      d.n += 1;
      await s.put({ log, dia: d });
      await s.setAlarm(agora + L.ipApagarMs);
      return json({ ok: true, restantesHoje: L.porDia - d.n });
    }

    if (u.pathname === "/ip/recusar") {
      const extra = await this.registrarRecusa(diaBR(agora), agora);
      return json({ ok: true, bloqueado: !!extra.bloqueioAte });
    }

    if (u.pathname === "/global/consumir") {
      const dia = diaBR(agora);
      let d = (await s.get("dia")) || { dia, n: 0 };
      if (d.dia !== dia) d = { dia, n: 0 };
      if (d.n >= L.tetoGlobalDia) return json({ ok: false, motivo: "teto_diario", tentarEm: segundosAteAmanhaBR(agora) });
      d.n += 1;
      await s.put("dia", d);
      return json({ ok: true, usadasHoje: d.n });
    }

    if (u.pathname === "/global/estornar") {
      const dia = diaBR(agora);
      const d = (await s.get("dia")) || { dia, n: 0 };
      if (d.dia === dia && d.n > 0) {
        d.n -= 1;
        await s.put("dia", d);
      }
      return json({ ok: true });
    }

    if (u.pathname === "/cache/get") {
      const c = await s.get("c");
      return json(c && agora - c.em < L.cacheMs ? c : null);
    }

    if (u.pathname === "/cache/put") {
      const eventos = await request.json();
      await s.put("c", { em: agora, eventos });
      await s.setAlarm(agora + L.cacheMs);
      return json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  }

  async registrarRecusa(dia, agora) {
    const s = this.state.storage;
    const L = LIMITES_SITESECURE;
    let rec = (await s.get("recusas")) || { dia, n: 0 };
    if (rec.dia !== dia) rec = { dia, n: 0 };
    rec.n += 1;
    const extra = {};
    if (rec.n >= L.recusasParaBloqueio24h) extra.bloqueioAte = agora + 24 * HORA;
    else if (rec.n >= L.recusasParaBloqueio1h) extra.bloqueioAte = agora + HORA;
    await s.put({ recusas: rec, ...extra });
    await s.setAlarm(agora + L.ipApagarMs);
    return extra;
  }

  // Alarme = fim da validade: apaga tudo deste objeto (cache ou estado do IP).
  async alarm() {
    await this.state.storage.deleteAll();
  }
}

// Falha do Durable Object (limite da conta, reinicio) vira um erro fixo: a
// mensagem interna nao sai para o cliente.
async function chamar(env, nome, caminho, init) {
  try {
    const stub = env.SITESECURE_DO.get(env.SITESECURE_DO.idFromName(nome));
    const res = await stub.fetch(`https://sitesecure${caminho}`, init);
    return await res.json();
  } catch (err) {
    console.log(JSON.stringify({ evento: "guarda_falhou", caminho, ...resumoErro(err) }));
    throw new Error("guarda_indisponivel");
  }
}

export const guarda = {
  estadoIp: (env, ip) => chamar(env, `ip:${ip}`, "/ip/estado"),
  consumirIp: (env, ip) => chamar(env, `ip:${ip}`, "/ip/consumir"),
  registrarRecusa: (env, ip) => chamar(env, `ip:${ip}`, "/ip/recusar"),
  consumirGlobal: (env) => chamar(env, "global", "/global/consumir"),
  estornarGlobal: (env) => chamar(env, "global", "/global/estornar"),
  lerCache: (env, chave) => chamar(env, `cache:${chave}`, "/cache/get"),
  gravarCache: (env, chave, eventos) => chamar(env, `cache:${chave}`, "/cache/put", { method: "POST", body: JSON.stringify(eventos) }),
};

// IPv6 de um mesmo /64 (a faixa de uma casa ou de um servidor) conta como um IP
// so; IPv4 mapeado em IPv6 vira o proprio IPv4.
export function agruparIp(ip) {
  if (!ip) return "sem-ip";
  if (!ip.includes(":")) return ip;
  const g = expandirIpv6(ip);
  if (!g) return "sem-ip";
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return `v6:${g.slice(0, 4).map((x) => x.toString(16)).join(":")}`;
}

// Chave do cache: hash SHA-256 da entrada ja normalizada (URL de validarUrl).
// A entrada nao fica guardada em claro nem no nome do objeto.
export async function chaveCache(url, pix) {
  const base = JSON.stringify({ url: url || "", pix: (pix || "").replace(/\s+/g, "") });
  const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(base));
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// O cache guarda o laudo sem dado da entrada (caminho e query da URL, nome e
// cidade do recebedor do PIX): em cada texto do laudo (so nos valores, nunca em
// chaves, numeros ou na estrutura) o trecho vira um marcador, e volta na leitura
// a partir da propria requisicao (a chave do cache e o hash dessa entrada).
// O marcador usa um caractere reservado; o caractere literal e dobrado, para a
// volta ser exata mesmo que o texto da pagina o contenha.
const MARCA = String.fromCharCode(0xe000);
const MIN_SEGREDO = 3;

function mapearTextos(valor, fn) {
  if (typeof valor === "string") return fn(valor);
  if (Array.isArray(valor)) return valor.map((v) => mapearTextos(v, fn));
  if (valor && typeof valor === "object") return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, mapearTextos(v, fn)]));
  return valor;
}

const escaparRegex = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function ocultarSegredos(eventos, segredos) {
  const lista = segredos.filter((s) => typeof s === "string" && s.length >= MIN_SEGREDO);
  const dobrar = (t) => t.split(MARCA).join(MARCA + MARCA);
  if (!lista.length) return mapearTextos(eventos, dobrar);
  const ordem = [...lista].sort((a, b) => b.length - a.length);
  const re = new RegExp(ordem.map(escaparRegex).join("|"), "g");
  return mapearTextos(eventos, (texto) => {
    let saida = "";
    let fim = 0;
    for (const m of texto.matchAll(re)) {
      saida += dobrar(texto.slice(fim, m.index)) + `${MARCA}${lista.indexOf(m[0])};`;
      fim = m.index + m[0].length;
    }
    return saida + dobrar(texto.slice(fim));
  });
}

export function restaurarSegredos(eventos, segredos) {
  const lista = segredos.filter((s) => typeof s === "string" && s.length >= MIN_SEGREDO);
  const re = new RegExp(`${MARCA}(${MARCA}|\\d+;)`, "g");
  return mapearTextos(eventos, (texto) => texto.replace(re, (_, g) => {
    if (g === MARCA) return MARCA;
    const s = lista[parseInt(g, 10)];
    if (s === undefined) throw new Error("marcador_invalido");
    return s;
  }));
}
