// Cloudflare Turnstile: confere se quem pede a analise e um navegador humano.
// TURNSTILE_MODO (wrangler.toml [vars]):
//   "observar" -> confere e registra no log, mas nunca bloqueia (fase de teste)
//   "exigir"   -> sem token valido, a analise e recusada antes de gastar cota
// Sem TURNSTILE_SECRET: no modo "exigir" tudo e recusado; no "observar" passa, e
// os dois casos registram erro no log. Se o siteverify estiver fora do ar, o modo
// "exigir" recusa com `indisponivel` (o chamador responde 503) e o "observar" passa.
// `conta` so e verdadeiro para token presente e rejeitado de fato pelo siteverify;
// so esse caso entra no bloqueio progressivo do IP.
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const HOSTS_DO_SITE = ["itibere.tec.br", "itibere.github.io"];
const HOSTS_DEV = ["localhost", "127.0.0.1", "example.com"];

export async function conferirTurnstile(env, token, ip, modoConfigurado = env.TURNSTILE_MODO, acao = "analisar") {
  const modo = modoConfigurado === "exigir" ? "exigir" : "observar";
  if (!env.TURNSTILE_SECRET) {
    console.error(JSON.stringify({ evento: "turnstile_sem_segredo", modo }));
    return decidir(modo, "sem_segredo");
  }
  if (!token || typeof token !== "string" || token.length > 2048) return decidir(modo, "sem_token");

  try {
    const corpo = new FormData();
    corpo.append("secret", env.TURNSTILE_SECRET);
    corpo.append("response", token);
    if (ip) corpo.append("remoteip", ip);
    const res = await fetch(SITEVERIFY, { method: "POST", body: corpo, signal: AbortSignal.timeout(5000) });
    const r = await res.json();
    const dev = !!env.DEV_ORIGIN;
    const hostOk = typeof r.hostname === "string" && (HOSTS_DO_SITE.includes(r.hostname) || (dev && HOSTS_DEV.includes(r.hostname)));
    const acaoOk = dev || r.action === acao;
    if (r.success && hostOk && acaoOk) return { ok: true, modo, resultado: "valido" };
    if (r.success) return decidir(modo, hostOk ? "action_invalida" : "hostname_invalido", true);
    const codigos = Array.isArray(r["error-codes"]) ? r["error-codes"] : ["invalido"];
    return decidir(modo, codigos.join(","), codigos.includes("invalid-input-response"));
  } catch {
    console.error(JSON.stringify({ evento: "turnstile_siteverify_indisponivel", modo }));
    if (modo === "exigir") return { ok: false, modo, resultado: "siteverify_indisponivel", indisponivel: true, conta: false };
    return { ok: true, modo, resultado: "siteverify_indisponivel" };
  }
}

function decidir(modo, resultado, conta = false) {
  return { ok: modo !== "exigir", modo, resultado, conta: modo === "exigir" && conta };
}
