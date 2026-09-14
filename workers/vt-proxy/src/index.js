const ALLOWED_ORIGINS = ["https://itibere.tec.br", "https://itibere.github.io"];
const VT_BASE = "https://www.virustotal.com/api/v3";
const HASH_RE = /^[a-fA-F0-9]{32}$|^[a-fA-F0-9]{40}$|^[a-fA-F0-9]{64}$|^[a-fA-F0-9]{128}$/;

const RATE_LIMIT = 10; // requisicoes
const RATE_WINDOW_MS = 60_000; // por janela fixa de 60s

// Rate limit via Durable Object, por IP (mesmo padrao do worker rag-licitacoes,
// ver rag-portarias/portarias/worker/src/index.js): instancia unica autoritativa
// por chave (idFromName), sem condicao de corrida entre leitura e escrita.
// CORS so protege chamadas de navegador -- uma chamada direta (curl/script) contra
// a URL do worker ignora CORS e bateria sem limite na cota global da VT_API_KEY.
class RateLimiterDO {
  constructor(state) {
    this.state = state;
  }

  async fetch() {
    const agora = Date.now();
    const janela = Math.floor(agora / RATE_WINDOW_MS);
    const registro = (await this.state.storage.get("contador")) || { janela: -1, contagem: 0 };
    const contagemAtual = registro.janela === janela ? registro.contagem : 0;

    if (contagemAtual >= RATE_LIMIT) {
      return new Response(JSON.stringify({ success: false }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    await this.state.storage.put("contador", { janela, contagem: contagemAtual + 1 });
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}

export { RateLimiterDO };

async function checarLimite(env, ip) {
  if (!env.RATE_LIMITER_DO) return true; // fail-open se o binding faltar
  const id = env.RATE_LIMITER_DO.idFromName(ip);
  const stub = env.RATE_LIMITER_DO.get(id);
  const resp = await stub.fetch("https://rate-limiter/check");
  const { success } = await resp.json();
  return success;
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
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

async function handleHash(request, env) {
  const { hash } = await request.json().catch(() => ({}));
  if (typeof hash !== "string" || !HASH_RE.test(hash)) {
    return json(request, { error: "hash_invalido" }, 400);
  }

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

async function handleUrlSubmit(request, env) {
  const { url } = await request.json().catch(() => ({}));
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return json(request, { error: "url_invalida" }, 400);
  }

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
  return json(request, { queued: true, analysis_id: submitData.data?.id });
}

async function handleUrlPoll(request, env, analysisId) {
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

  const report = await vtFetch(`/urls/${urlId}`, env.VT_API_KEY);
  if (!report.ok) {
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
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const ip = request.headers.get("CF-Connecting-IP") || "sem-ip";
    const dentroDoLimite = await checarLimite(env, ip);
    if (!dentroDoLimite) {
      return json(request, { error: "rate_limit_excedido" }, 429);
    }

    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/hash") {
      return handleHash(request, env);
    }
    if (request.method === "POST" && url.pathname === "/url") {
      return handleUrlSubmit(request, env);
    }
    const pollMatch = url.pathname.match(/^\/url\/(.+)$/);
    if (request.method === "GET" && pollMatch) {
      return handleUrlPoll(request, env, pollMatch[1]);
    }

    return json(request, { error: "not_found" }, 404);
  },
};
