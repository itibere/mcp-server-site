// Cloudflare Turnstile: confere se quem pede a analise e um navegador humano.
// TURNSTILE_MODO (wrangler.toml [vars]):
//   "observar" -> confere e registra no log, mas nunca bloqueia (fase de teste)
//   "exigir"   -> sem token valido, a analise e recusada antes de gastar cota
// Sem TURNSTILE_SECRET, nada e conferido (fail-open, registrado no log).
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const HOSTS_PERMITIDOS = ["itibere.tec.br", "localhost", "127.0.0.1"];

export async function conferirTurnstile(env, token, ip) {
  const modo = env.TURNSTILE_MODO === "exigir" ? "exigir" : "observar";
  if (!env.TURNSTILE_SECRET) return { ok: true, modo, resultado: "sem_segredo" };
  if (!token || typeof token !== "string" || token.length > 2048) return decidir(modo, "sem_token");

  try {
    const corpo = new FormData();
    corpo.append("secret", env.TURNSTILE_SECRET);
    corpo.append("response", token);
    if (ip) corpo.append("remoteip", ip);
    const res = await fetch(SITEVERIFY, { method: "POST", body: corpo, signal: AbortSignal.timeout(5000) });
    const r = await res.json();
    // Chaves de teste da Cloudflare respondem hostname "example.com".
    const hostOk = !r.hostname || HOSTS_PERMITIDOS.includes(r.hostname) || r.hostname === "example.com";
    if (r.success && hostOk) return { ok: true, modo, resultado: "valido" };
    return decidir(modo, r.success ? "hostname_invalido" : (r["error-codes"] || ["invalido"]).join(","));
  } catch {
    // Falha da propria Cloudflare nao pode derrubar a ferramenta.
    return { ok: true, modo, resultado: "siteverify_indisponivel" };
  }
}

function decidir(modo, resultado) {
  return { ok: modo !== "exigir", modo, resultado };
}
