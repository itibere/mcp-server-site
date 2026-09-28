// Guarda do sitesecure: limites por IP, castigo progressivo, teto geral diario
// e cache de laudos. Um Durable Object (SQLite, plano gratuito) por chave:
//   "ip:<ip>"       janela deslizante, limite diario e bloqueio do IP
//   "global"        teto de analises do dia, somando todos os IPs
//   "cache:<hash>"  eventos finais de uma analise (laudos), por 1 hora
// O nome do objeto e derivado do IP pelo proprio Cloudflare (idFromName); o IP
// nao e gravado no armazenamento. Todo estado se apaga sozinho (alarm).

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
        let rec = (await s.get("recusas")) || { dia, n: 0 };
        if (rec.dia !== dia) rec = { dia, n: 0 };
        rec.n += 1;
        const extra = {};
        if (rec.n >= L.recusasParaBloqueio24h) extra.bloqueioAte = agora + 24 * HORA;
        else if (rec.n >= L.recusasParaBloqueio1h) extra.bloqueioAte = agora + HORA;
        await s.put({ recusas: rec, ...extra });
        if (extra.bloqueioAte) return json({ ok: false, motivo: "bloqueado", tentarEm: Math.ceil((extra.bloqueioAte - agora) / 1000) });
        return json({ ok: false, motivo, tentarEm });
      }

      log.push(agora);
      d.n += 1;
      await s.put({ log, dia: d });
      await s.setAlarm(agora + L.ipApagarMs);
      return json({ ok: true, restantesHoje: L.porDia - d.n });
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

  // Alarme = fim da validade: apaga tudo deste objeto (cache ou estado do IP).
  async alarm() {
    await this.state.storage.deleteAll();
  }
}

async function chamar(env, nome, caminho, init) {
  const stub = env.SITESECURE_DO.get(env.SITESECURE_DO.idFromName(nome));
  const res = await stub.fetch(`https://sitesecure${caminho}`, init);
  return res.json();
}

export const guarda = {
  estadoIp: (env, ip) => chamar(env, `ip:${ip}`, "/ip/estado"),
  consumirIp: (env, ip) => chamar(env, `ip:${ip}`, "/ip/consumir"),
  consumirGlobal: (env) => chamar(env, "global", "/global/consumir"),
  lerCache: (env, chave) => chamar(env, `cache:${chave}`, "/cache/get"),
  gravarCache: (env, chave, eventos) => chamar(env, `cache:${chave}`, "/cache/put", { method: "POST", body: JSON.stringify(eventos) }),
};

// Chave do cache: hash SHA-256 da entrada normalizada. O PIX nao fica guardado
// em claro nem no nome do objeto.
export async function chaveCache(url, pix) {
  const base = JSON.stringify({ url: (url || "").trim().toLowerCase().replace(/\/+$/, ""), pix: (pix || "").replace(/\s+/g, "") });
  const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(base));
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
