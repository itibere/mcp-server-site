const ALLOWED_ORIGINS = ["https://itibere.tec.br", "https://itibere.github.io"];
const VT_BASE = "https://www.virustotal.com/api/v3";
const HASH_RE = /^[a-fA-F0-9]{32}$|^[a-fA-F0-9]{40}$|^[a-fA-F0-9]{64}$|^[a-fA-F0-9]{128}$/;

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
  const status = normalize(data.data?.attributes?.last_analysis_stats);
  return json(request, { found: true, status, message: MESSAGES.hash[status] });
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
      message: MESSAGES.url[status] + (status !== "limpo" ? ` Motivos: ${motivosFrom(attrs?.last_analysis_results).join("; ")}` : ""),
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
    return json(request, { done: true, status, message: MESSAGES.url[status] });
  }

  const report = await vtFetch(`/urls/${urlId}`, env.VT_API_KEY);
  if (!report.ok) {
    const status = normalize(attrs?.stats);
    return json(request, { done: true, status, message: MESSAGES.url[status] });
  }
  const reportData = await report.json();
  const reportAttrs = reportData.data?.attributes;
  const status = normalize(reportAttrs?.last_analysis_stats);
  return json(request, {
    done: true,
    status,
    message: MESSAGES.url[status] + (status !== "limpo" ? ` Motivos: ${motivosFrom(reportAttrs?.last_analysis_results).join("; ")}` : ""),
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
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
