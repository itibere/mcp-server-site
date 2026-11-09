const ALLOWED_ORIGINS = ["https://itibere.tec.br", "https://itibere.github.io"];
const VT_BASE = "https://www.virustotal.com/api/v3";
const HASH_RE = /^[a-fA-F0-9]{32}$|^[a-fA-F0-9]{40}$|^[a-fA-F0-9]{64}$|^[a-fA-F0-9]{128}$/;

import { handleAnalisar } from "./sitesecure/analisar.js";
import { agruparIp } from "./sitesecure/guarda.js";
import { conferirTurnstile } from "./sitesecure/turnstile.js";
import { limparHistorico } from "./sitesecure/historico.js";
import { lerJsonLimitado } from "./sitesecure/util.js";
export { SitesecureDO } from "./sitesecure/guarda.js";

const RATE_LIMIT = 10; // requisicoes
const RATE_WINDOW_MS = 60_000; // por janela fixa de 60s
const DIA_MS = 86_400_000;
// Cota do VirusTotal: 500 chamadas por dia e 4 por minuto, divididas com o Site
// Secure (1 chamada por analise). Os tetos abaixo contam CHAMADAS ao VirusTotal:
// /hash gasta 1; POST /url gasta 1 (2 se a URL ainda nao era conhecida); cada
// consulta de andamento que chega ao VirusTotal gasta 1 (2 quando a analise
// termina). Uma analise de URL custa de 3 a 4 chamadas, entao 360 cabem ~100.
// Por IP: 20 consultas por dia com Turnstile exigido, 10 sem ele (observar).
const VT_LIMITE_DIA_IP = { exigir: 20, observar: 10 };
const VT_TETOS = { hash: 60, url: 360 };
const VT_TETO_TOTAL = 420;
// Consulta de andamento so vale para o id emitido ao proprio IP, por 15 min, no
// maximo 30 consultas por id; so uma a cada 25 s chega ao VirusTotal (no maximo 8).
const ID_VALIDADE_MS = 15 * 60_000;
const ID_MAX_CONSULTAS = 30;
const ID_MAX_CHAMADAS_VT = 8;
const ID_INTERVALO_VT_MS = 25_000;

// Rate limit via Durable Object, por IP (mesmo padrao do worker rag-licitacoes,
// ver rag-portarias/portarias/worker/src/index.js): instancia unica autoritativa
// por chave (idFromName), sem condicao de corrida entre leitura e escrita.
// CORS so protege chamadas de navegador -- uma chamada direta (curl/script) contra
// a URL do worker ignora CORS e bateria sem limite na cota global da VT_API_KEY.
class RateLimiterDO {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const u = new URL(request.url);
    if (u.pathname.startsWith("/id/")) return this.fetchId(u);
    // Limite, janela e peso opcionais na query (o sitesecure usa um limite proprio);
    // sem parametros, vale o limite padrao de /hash e /url.
    const q = u.searchParams;
    const limite = Number(q.get("limite")) || RATE_LIMIT;
    const janelaMs = Number(q.get("janela")) || RATE_WINDOW_MS;
    const peso = Number(q.get("peso")) || 1;
    const agora = Date.now();
    const janela = Math.floor(agora / janelaMs);
    const registro = (await this.state.storage.get("contador")) || { janela: -1, contagem: 0 };
    const contagemAtual = registro.janela === janela ? registro.contagem : 0;

    if (u.pathname === "/estornar") {
      if (registro.janela === janela) await this.state.storage.put("contador", { janela, contagem: Math.max(0, contagemAtual - peso) });
      return resposta({ success: true });
    }

    if (contagemAtual + peso > limite) return resposta({ success: false });

    await this.state.storage.put("contador", { janela, contagem: contagemAtual + peso });
    return resposta({ success: true });
  }

  async fetchId(u) {
    const s = this.state.storage;
    const agora = Date.now();
    const ip = u.searchParams.get("ip");
    if (u.pathname === "/id/registrar") {
      await s.put("id", { ip, n: 0, vt: 0, ultima: agora, criado: agora });
      await s.setAlarm(agora + ID_VALIDADE_MS);
      return resposta({ ok: true });
    }
    const reg = await s.get("id");
    if (!reg || reg.ip !== ip || agora - reg.criado > ID_VALIDADE_MS) return resposta({ ok: false, motivo: "desconhecido" });
    if (reg.n >= ID_MAX_CONSULTAS || reg.vt >= ID_MAX_CHAMADAS_VT) return resposta({ ok: false, motivo: "limite" });
    reg.n += 1;
    const chamarVt = agora - reg.ultima >= ID_INTERVALO_VT_MS;
    if (chamarVt) {
      reg.vt += 1;
      reg.ultima = agora;
    }
    await s.put("id", reg);
    return resposta({ ok: true, chamarVt });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}

const resposta = (obj) => new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } });

export { RateLimiterDO };

async function checarLimite(env, chave, limite, janelaMs, peso = 1) {
  if (!env.RATE_LIMITER_DO) return true; // fail-open se o binding faltar
  const id = env.RATE_LIMITER_DO.idFromName(chave);
  const stub = env.RATE_LIMITER_DO.get(id);
  const params = limite ? `?limite=${limite}&janela=${janelaMs}&peso=${peso}` : "";
  const resp = await stub.fetch(`https://rate-limiter/check${params}`);
  const { success } = await resp.json();
  return success;
}

async function estornarLimite(env, chave, janelaMs, peso = 1) {
  if (!env.RATE_LIMITER_DO) return;
  const stub = env.RATE_LIMITER_DO.get(env.RATE_LIMITER_DO.idFromName(chave));
  await stub.fetch(`https://rate-limiter/estornar?janela=${janelaMs}&peso=${peso}`).catch(() => {});
}

async function chamarId(env, idAnalise, caminho, ipHash) {
  const stub = env.RATE_LIMITER_DO.get(env.RATE_LIMITER_DO.idFromName(`vt-id:${idAnalise}`));
  const resp = await stub.fetch(`https://rate-limiter${caminho}?ip=${encodeURIComponent(ipHash)}`);
  return resp.json();
}

async function hashDoIp(ip) {
  const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return [...new Uint8Array(dig)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  // DEV_ORIGIN (so no .dev.vars) libera o http.server local nos testes.
  const permitidas = env?.DEV_ORIGIN ? [...ALLOWED_ORIGINS, env.DEV_ORIGIN] : ALLOWED_ORIGINS;
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (origin && permitidas.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

function normalize(stats) {
  const malicious = stats?.malicious ?? 0;
  const suspicious = stats?.suspicious ?? 0;
  if (malicious > 0) return "malicioso";
  if (suspicious > 0) return "alerta";
  return "limpo";
}

const MESSAGES = {
  hash: {
    limpo: "O arquivo não possui assinaturas maliciosas, pode executar.",
    alerta: "Este arquivo pode ter um ou mais indicações de assinaturas maliciosas. Suspeite!",
    malicioso:
      "Este arquivo pode ser malicioso para o seu computador. Recomendação: Não executar e colocar em quarentena pela sua solução Anti-Vírus ou remova completamente de seu computador",
  },
  url: {
    limpo: "Este site é conhecido e seguro",
    alerta: "Este site pode não ser seguro.",
    malicioso: "Este site é classificado como malicioso. Recomendação: Não acesse ou clique em nada neste site.",
  },
};

function motivosFrom(results) {
  if (!results) return [];
  return Object.entries(results)
    .filter(([, r]) => r.category === "malicious" || r.category === "suspicious")
    .slice(0, 5)
    .map(([engine, r]) => `${engine}: ${r.category}`);
}

// Resumo agregado das verificacoes do VirusTotal -- sempre devolvido,
// independente do status (limpo, alerta ou malicioso). Antes, esse dado
// (quantos motores de antivirus/seguranca analisaram e o que cada grupo
// concluiu) so aparecia quando havia algo suspeito/malicioso; ficava
// escondido no caso mais comum (limpo), que e exatamente quando o usuario
// mais quer ver "quantos motores confirmaram que ta seguro".
function resumoFrom(stats) {
  if (!stats) return null;
  const harmless = stats.harmless ?? 0;
  const malicious = stats.malicious ?? 0;
  const suspicious = stats.suspicious ?? 0;
  const undetected = stats.undetected ?? 0;
  const timeout = stats.timeout ?? 0;
  const total = harmless + malicious + suspicious + undetected + timeout;
  if (total === 0) return null;

  const partes = [];
  if (harmless) partes.push(`${harmless} classificaram como seguro`);
  if (malicious) partes.push(`${malicious} classificaram como malicioso`);
  if (suspicious) partes.push(`${suspicious} classificaram como suspeito`);
  if (undetected) partes.push(`${undetected} não retornaram classificação`);
  if (timeout) partes.push(`${timeout} expiraram na análise`);

  return `${total} mecanismo${total === 1 ? "" : "s"} de segurança analisaram: ${partes.join(", ")}.`;
}

function urlIdFor(url) {
  const b64 = btoa(url).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return b64;
}

async function vtFetch(path, apiKey, init = {}) {
  return fetch(`${VT_BASE}${path}`, {
    ...init,
    headers: { "x-apikey": apiKey, ...(init.headers || {}) },
  });
}

function validarHash(corpo) {
  const hash = corpo?.hash;
  return typeof hash === "string" && HASH_RE.test(hash) ? { hash } : { erro: "hash_invalido" };
}

function validarUrlVt(corpo) {
  const bruta = corpo?.url;
  if (typeof bruta !== "string" || bruta.length > 2048) return { erro: "url_invalida" };
  try {
    const parsed = new URL(bruta);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { erro: "url_invalida" };
    return { parsed };
  } catch {
    return { erro: "url_invalida" };
  }
}

// Cobra, nesta ordem, o IP, o teto da rota e o teto combinado. Se uma cobranca
// for recusada, as anteriores sao devolvidas: recusa nao gasta cota de ninguem.
async function cobrarVt(env, cobrancas) {
  const feitas = [];
  const devolver = () => Promise.all(feitas.map((f) => estornarLimite(env, f.chave, DIA_MS, f.peso || 1)));
  try {
    for (const c of cobrancas) {
      if (!(await checarLimite(env, c.chave, c.limite, DIA_MS, c.peso || 1))) {
        await devolver();
        return c.recusa;
      }
      feitas.push(c);
    }
  } catch (err) {
    await devolver();
    throw err;
  }
  return null;
}

const RECUSA_IP = { erro: "limite_diario", status: 429 };
const RECUSA_TETO = { erro: "teto_diario", status: 503 };

const cobrancaDaRota = (rota, peso) => [
  { chave: `vt-teto-dia:${rota}`, limite: VT_TETOS[rota], peso, recusa: RECUSA_TETO },
  { chave: "vt-teto-total-dia", limite: VT_TETO_TOTAL, peso, recusa: RECUSA_TETO },
];

// Chamada extra ao VirusTotal no meio de uma requisicao ja cobrada.
const gastarVt = (env, rota) => cobrarVt(env, cobrancaDaRota(rota, 1)).catch(() => RECUSA_TETO);

async function handleHash(request, env, hash) {
  const res = await vtFetch(`/files/${hash}`, env.VT_API_KEY);
  if (res.status === 404) {
    return json(request, { found: false });
  }
  if (res.status === 429) {
    return json(request, { error: "quota_excedida" }, 503);
  }
  if (!res.ok) {
    return json(request, { error: "erro_virustotal" }, 502);
  }

  const data = await res.json();
  const stats = data.data?.attributes?.last_analysis_stats;
  const status = normalize(stats);
  return json(request, {
    found: true,
    status,
    message: MESSAGES.hash[status],
    resumo: resumoFrom(stats),
    motivos: motivosFrom(data.data?.attributes?.last_analysis_results),
  });
}

async function handleUrlSubmit(request, env, parsed, { gastar, registrarId }) {
  const urlId = urlIdFor(parsed.toString());
  const existing = await vtFetch(`/urls/${urlId}`, env.VT_API_KEY);
  if (existing.status === 429) {
    return json(request, { error: "quota_excedida" }, 503);
  }
  if (existing.ok) {
    const data = await existing.json();
    const attrs = data.data?.attributes;
    const status = normalize(attrs?.last_analysis_stats);
    return json(request, {
      done: true,
      status,
      message: MESSAGES.url[status],
      resumo: resumoFrom(attrs?.last_analysis_stats),
      motivos: motivosFrom(attrs?.last_analysis_results),
    });
  }

  const recusa = await gastar();
  if (recusa) return json(request, { error: recusa.erro }, recusa.status);
  const submit = await vtFetch(`/urls`, env.VT_API_KEY, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `url=${encodeURIComponent(parsed.toString())}`,
  });
  if (submit.status === 429) {
    return json(request, { error: "quota_excedida" }, 503);
  }
  if (!submit.ok) {
    return json(request, { error: "erro_virustotal" }, 502);
  }
  const submitData = await submit.json();
  const analysisId = submitData.data?.id;
  if (typeof analysisId === "string") await registrarId(analysisId);
  return json(request, { queued: true, analysis_id: analysisId });
}

async function handleUrlPoll(request, env, analysisId, gastar) {
  const res = await vtFetch(`/analyses/${analysisId}`, env.VT_API_KEY);
  if (res.status === 429) {
    return json(request, { error: "quota_excedida" }, 503);
  }
  if (!res.ok) {
    return json(request, { error: "erro_virustotal" }, 502);
  }
  const data = await res.json();
  const attrs = data.data?.attributes;
  if (attrs?.status !== "completed") {
    return json(request, { done: false });
  }

  const urlId = data.meta?.url_info?.id;
  if (!urlId) {
    const status = normalize(attrs?.stats);
    return json(request, { done: true, status, message: MESSAGES.url[status], resumo: resumoFrom(attrs?.stats) });
  }

  const report = (await gastar()) ? null : await vtFetch(`/urls/${urlId}`, env.VT_API_KEY);
  if (!report?.ok) {
    const status = normalize(attrs?.stats);
    return json(request, { done: true, status, message: MESSAGES.url[status], resumo: resumoFrom(attrs?.stats) });
  }
  const reportData = await report.json();
  const reportAttrs = reportData.data?.attributes;
  const status = normalize(reportAttrs?.last_analysis_stats);
  return json(request, {
    done: true,
    status,
    message: MESSAGES.url[status],
    resumo: resumoFrom(reportAttrs?.last_analysis_stats),
    motivos: motivosFrom(reportAttrs?.last_analysis_results),
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const ipBruto = request.headers.get("CF-Connecting-IP") || "";
    const ip = agruparIp(ipBruto);
    const url = new URL(request.url);

    // Sitesecure: guarda propria (sitesecure/guarda.js) com janela deslizante,
    // limite diario, bloqueio progressivo, teto geral e cache; separada do
    // limite de /hash e /url.
    if (request.method === "POST" && url.pathname === "/sitesecure/analisar") {
      return handleAnalisar(request, env, ctx, corsHeaders(request, env), ip, ipBruto);
    }

    try {
      if (!(await checarLimite(env, ip))) {
        return json(request, { error: "rate_limit_excedido" }, 429);
      }
    } catch {
      return json(request, { error: "servico_indisponivel" }, 503);
    }

    const ehHash = request.method === "POST" && url.pathname === "/hash";
    const ehUrl = request.method === "POST" && url.pathname === "/url";
    if (ehHash || ehUrl) {
      // Entrada valida e Turnstile antes de cobrar o limite diario e o teto.
      const lido = await lerJsonLimitado(request);
      if (lido.erro) return json(request, { error: lido.erro }, lido.status);
      const entrada = ehHash ? validarHash(lido.corpo) : validarUrlVt(lido.corpo);
      if (entrada.erro) return json(request, { error: entrada.erro }, 400);

      const ts = await conferirTurnstile(env, lido.corpo?.turnstile, ipBruto, env.TURNSTILE_VT_MODO || "observar", "vt");
      console.log(JSON.stringify({ evento: "turnstile_vt", modo: ts.modo, resultado: ts.resultado, bloqueou: !ts.ok }));
      if (ts.indisponivel) return json(request, { error: "verificacao_indisponivel" }, 503);
      if (!ts.ok) return json(request, { error: "verificacao_humana" }, 403);

      const rota = ehHash ? "hash" : "url";
      try {
        const recusa = await cobrarVt(env, [
          { chave: `vt-dia:${ip}`, limite: VT_LIMITE_DIA_IP[ts.modo], recusa: RECUSA_IP },
          ...cobrancaDaRota(rota, 1),
        ]);
        if (recusa) return json(request, { error: recusa.erro }, recusa.status);
      } catch {
        return json(request, { error: "servico_indisponivel" }, 503);
      }
      if (ehHash) return handleHash(request, env, entrada.hash);
      return handleUrlSubmit(request, env, entrada.parsed, {
        gastar: () => gastarVt(env, "url"),
        registrarId: async (id) => {
          if (!env.RATE_LIMITER_DO) return;
          await chamarId(env, id, "/id/registrar", await hashDoIp(ip)).catch(() => {});
        },
      });
    }
    const pollMatch = url.pathname.match(/^\/url\/([A-Za-z0-9_=-]{1,200})$/);
    if (request.method === "GET" && pollMatch) {
      try {
        if (env.RATE_LIMITER_DO) {
          const consulta = await chamarId(env, pollMatch[1], "/id/consultar", await hashDoIp(ip));
          if (!consulta.ok) {
            return consulta.motivo === "limite"
              ? json(request, { error: "limite_consultas" }, 429)
              : json(request, { error: "not_found" }, 404);
          }
          if (!consulta.chamarVt) return json(request, { done: false });
        }
        const recusa = await gastarVt(env, "url");
        if (recusa) return json(request, { error: recusa.erro }, recusa.status);
      } catch {
        return json(request, { error: "servico_indisponivel" }, 503);
      }
      return handleUrlPoll(request, env, pollMatch[1], () => gastarVt(env, "url"));
    }

    return json(request, { error: "not_found" }, 404);
  },

  async scheduled(event, env, ctx) {
    await limparHistorico(env);
  },
};
