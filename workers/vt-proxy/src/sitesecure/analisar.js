// POST /sitesecure/analisar {url, pix?}
// Resposta em NDJSON: um evento {etapa, status, ...} por etapa concluida, para
// o frontend animar o progresso; o ultimo evento e {etapa:"laudo", laudo}.
import { validarUrl, resolverPublico } from "./guard.js";
import { renderizar, coletarEstatico } from "./render.js";
import { consultarRdap, consultarDns } from "./dominio.js";
import { avaliarCabecalhos, redirecionaParaHttps } from "./hardening.js";
import { consultarVirusTotal, consultarSafeBrowsing, consultarUrlhaus } from "./reputacao.js";
import { classificarDestinos, classificarPorNome } from "./links.js";
import { identificarGoverno, imitaGoverno } from "./governo.js";
import { consultarRadar } from "./radar.js";
import { coletarExtras, avaliarBoasPraticas } from "./boaspraticas.js";
import { executarPix } from "./pixonly.js";
import { guarda, chaveCache } from "./guarda.js";
import { conferirTurnstile } from "./turnstile.js";
import { carregarRanking, identificarInstituicao, situacaoNoRanking } from "./bancocentral.js";
import { detectarRedes, avaliarPropagandas, idadeDosAnunciantes } from "./propagandas.js";
import { escolherCnpj, consultarCnpj, empresaCondiz } from "./empresa.js";
import { identificarHost } from "./host.js";
import { detectarPagamento, lerBrCode, acharBrCodes, compararPix } from "./pagamento.js";
import { consultarReclameAqui } from "./reclameaqui.js";
import { notaReputacao, notaLinks, notaPropagandas, notaHeaderFooter, notaFinal } from "./nota.js";
import { Orcamento, dominioRaiz, hostDe, tokensNome } from "./util.js";

async function etapa(emitir, nome, fn, padrao = null) {
  try {
    const r = await fn();
    await emitir({ etapa: nome, status: "ok" });
    return r;
  } catch (err) {
    await emitir({ etapa: nome, status: "falhou", motivo: String(err?.message || err).slice(0, 120) });
    return padrao;
  }
}

// Link, PIX ou os dois. Com os dois, sai um laudo de cada (primeiro o do site,
// depois o do PIX), dividindo o teto de 50 subrequests do plano gratuito.
async function executar(env, corpo, emitir) {
  const pixEntrada = typeof corpo?.pix === "string" ? corpo.pix.trim() : "";
  const temUrl = !!(corpo?.url || "").trim();
  if (pixEntrada.length > 1024) return emitir({ etapa: "erro", erro: "pix_invalido", detalhe: "código longo demais" });
  if (!temUrl && pixEntrada) return executarPix(env, pixEntrada, emitir, new Orcamento(20));

  // Teto de 50 subrequests do plano gratuito: sobram ~5 para a guarda
  // (Durable Objects: estado do IP, cache, limites e gravacao do cache).
  const orc = new Orcamento(pixEntrada ? 36 : 42);
  await executarSite(env, corpo, emitir, orc);
  if (pixEntrada) await executarPix(env, pixEntrada, emitir, new Orcamento(Math.max(4, 44 - orc.usado)));
}

async function executarSite(env, corpo, emitir, orc) {
  const v = validarUrl(corpo?.url);
  if (v.erro) return emitir({ etapa: "erro", erro: v.erro });
  const url = v.url;
  const host = url.hostname.toLowerCase();
  const raiz = dominioRaiz(host);

  const dnsHost = await resolverPublico(orc, host).catch(() => ({ erro: "dns_falhou" }));
  if (dnsHost.erro) return emitir({ etapa: "erro", erro: dnsHost.erro });

  // 1. Dominio (RDAP + DNS) em paralelo com a renderizacao, que e a parte lenta.
  const pDominio = etapa(emitir, "dominio", async () => {
    const [rdap, dns] = await Promise.all([consultarRdap(orc, raiz), consultarDns(orc, host, raiz)]);
    return { rdap, dns: { ...dns, dnssec: dnsHost.dnssec } };
  }, { rdap: null, dns: null });

  const pPagina = etapa(emitir, "pagina", async () => {
    try {
      // SEM_NAVEGADOR=1 no .dev.vars: teste local onde o Chrome nao sobe.
      if (!env.BROWSER || env.SEM_NAVEGADOR) throw new Error("sem_navegador");
      // Teto de 45 s: navegador preso (fila, site pesado) nao pode travar a analise.
      return await Promise.race([
        renderizar(env, url.toString()),
        new Promise((_, rej) => setTimeout(() => rej(new Error("navegador_timeout")), 45_000)),
      ]);
    } catch {
      return await coletarEstatico(orc, url.toString());
    }
  });

  const pReputacao = etapa(emitir, "reputacao", async () => {
    const [vt, urlhaus] = await Promise.all([consultarVirusTotal(orc, env, raiz), consultarUrlhaus(orc, env, host)]);
    return { vt, urlhaus };
  }, { vt: null, urlhaus: null });

  const [{ rdap, dns }, coleta, { vt, urlhaus }] = await Promise.all([pDominio, pPagina, pReputacao]);
  if (!coleta) return emitir({ etapa: "erro", erro: "site_inacessivel" });

  // Redirecionou para outro host? Nao seguir se o destino for IP/privado.
  const hostFinal = hostDe(coleta.urlFinal) || host;
  if (validarUrl(coleta.urlFinal).erro) return emitir({ etapa: "erro", erro: "redirecionou_para_destino_nao_permitido" });
  const raizFinal = dominioRaiz(hostFinal);
  const governo = identificarGoverno(hostFinal);
  const imitacao = imitaGoverno(hostFinal, raizFinal);

  // 2. Hardening HTTP/TLS, boas praticas extras (security.txt, HSTS preload),
  // popularidade no Radar e, se redirecionou, o registro do dominio final.
  const { hardening, httpsRedirect, extras, radarSite, rdapFinal } = await etapa(emitir, "hardening", async () => {
    const [httpsRedirect, extras, radarSite, rdapFinal] = await Promise.all([
      redirecionaParaHttps(orc, hostFinal),
      coletarExtras(orc, hostFinal, raizFinal),
      consultarRadar(orc, env, raizFinal).catch(() => null),
      raizFinal !== raiz ? consultarRdap(orc, raizFinal).catch(() => null) : null,
    ]);
    return { hardening: avaliarCabecalhos(coleta.headers, coleta.urlFinal, coleta.tls), httpsRedirect, extras, radarSite, rdapFinal };
  }, { hardening: null, httpsRedirect: null, extras: null, radarSite: null, rdapFinal: null });
  // Dados do dominio que o visitante realmente ve (o final, apos redirecionar).
  const rdapSite = rdapFinal?.encontrado ? rdapFinal : rdap;

  // Redirecionar so e suspeito se o destino nao for da mesma empresa (mesmo
  // CNPJ no registro.br), nem governo, nem dominio confiavel/popular.
  let redirecionamento = null;
  if (raizFinal !== raiz) {
    const mesmaEmpresa = !!(rdap?.cnpjTitular && rdapFinal?.cnpjTitular && rdap.cnpjTitular.slice(0, 8) === rdapFinal.cnpjTitular.slice(0, 8));
    const confiavel = classificarPorNome(raizFinal)?.nivel === "bom" || !!radarSite?.estabelecido;
    redirecionamento = {
      host: hostFinal,
      suspeito: !mesmaEmpresa && !confiavel,
      motivo: mesmaEmpresa ? "mesma empresa no registro.br" : confiavel ? "destino de boa reputação" : "",
    };
  }

  // 3. Links e propagandas.
  const destinos = await etapa(emitir, "links", () => classificarDestinos(orc, env, coleta.links, raizFinal), []);
  const propagandas = await etapa(emitir, "propagandas", async () => {
    await idadeDosAnunciantes(orc, destinos, consultarRdap);
    return avaliarPropagandas(detectarRedes(coleta.requisicoes, coleta.iframes), destinos, coleta.modo);
  },
  { existe: false, verificavel: false, redes: { confiaveis: [], arriscadas: [] }, anunciantes: [] });

  // Links internos entram tambem: pagina limpa pode apontar para download
  // malicioso no proprio dominio. Continua uma chamada so (lote ate 500).
  const internos = coleta.links.map((l) => l.href).filter((h) => dominioRaiz(hostDe(h) || "") === raizFinal).slice(0, 300);
  const gsb = await etapa(emitir, "safebrowsing", () => consultarSafeBrowsing(orc, env, [
    url.toString(), coleta.urlFinal, ...destinos.flatMap((d) => d.exemplos), ...internos,
  ]), null);
  const gsbMatches = gsb?.matches || [];
  const doSite = (m) => [host, hostFinal].includes(hostDe(m.url));
  const gsbSite = gsb?.disponivel ? gsbMatches.filter(doSite).map((m) => m.tipo) : null;
  const gsbLinks = gsbMatches.filter((m) => !doSite(m));

  // 4. Empresa e host.
  const cnpjInfo = governo.governo ? null : escolherCnpj(coleta, rdapSite);
  const [empresa, hostInfo] = await Promise.all([
    etapa(emitir, "empresa", () => (cnpjInfo ? consultarCnpj(orc, cnpjInfo.cnpj) : null), null),
    etapa(emitir, "host", () => identificarHost(orc, env, dnsHost.ips, coleta.headers),
      { nome: "desconhecido", tier: "neutro", plataformas: [] }),
  ]);

  // 5. Pagamento, PIX e Reclame Aqui.
  const pagamento = detectarPagamento(coleta);
  const pixBruto = (corpo?.pix || "").trim() || acharBrCodes(coleta.texto)[0] || null;
  const pixLido = pixBruto ? lerBrCode(pixBruto) : null;
  const pix = pixLido ? compararPix(pixLido, cnpjInfo?.cnpj || null, empresa) : null;
  if (pixLido?.valido) pagamento.plataforma = true;
  // Instituicao que recebe o PIX e sua posicao no ranking do BC (so informa).
  const instPix = pixLido?.valido ? identificarInstituicao(pixLido) : null;
  const bcPix = instPix ? situacaoNoRanking(await carregarRanking(orc).catch(() => null), instPix) : null;
  await emitir({ etapa: "pagamento", status: "ok" });

  let reclameAqui = null;
  if (pagamento.plataforma) {
    const termo = empresa?.nomeFantasia || tokensNome(empresa?.razaoSocial || "")[0] || raizFinal.split(".")[0];
    reclameAqui = await etapa(emitir, "reclameaqui", () => consultarReclameAqui(orc, termo), null);
  }

  // 6. Boas praticas e nota.
  const boas = avaliarBoasPraticas({ coleta, hardening, dns, rdap: rdapSite, cnpjInfo, pagamento, extras, governo });
  const blocos = {
    reputacaoDominio: notaReputacao({ rdap: rdapSite, vt, gsbSite, urlhaus, dns, hardening, httpsRedirect, empresa, pagamento, pix, reclameAqui, governo, imitacao, radarSite, boas, raiz: raizFinal }),
    confiancaLinks: notaLinks({ destinos, gsbLinks, redirecionamento }),
    propagandas: notaPropagandas(propagandas),
    headerFooter: notaHeaderFooter({ host: hostInfo, cnpjInfo, empresa, condiz: empresaCondiz(empresa, raizFinal, coleta), pagamento, destinos, coleta, rdap: rdapSite, governo, boas, raiz: raizFinal }),
  };

  await emitir({
    etapa: "laudo",
    laudo: {
      url: url.toString(),
      urlFinal: coleta.urlFinal,
      titulo: coleta.titulo.slice(0, 120),
      modo: coleta.modo,
      analisadoEm: new Date().toISOString(),
      nota: notaFinal(blocos),
      blocos,
      detalhes: {
        dominio: { raiz: raizFinal, criadoEm: rdapSite?.criadoEm || vt?.criadoEm || null, dnssec: !!dns?.dnssec, spf: !!dns?.spf, dmarc: dns?.politicaDmarc || null, governo: governo.governo ? governo.esfera : null },
        popularidade: radarSite?.disponivel ? { posicao: radarSite.posicao, categorias: radarSite.categorias } : null,
        boasPraticas: boas,
        hardening,
        virustotal: vt?.conhecido ? { maliciosos: vt.maliciosos, suspeitos: vt.suspeitos, total: vt.total, vendors: vt.vendors, categorias: vt.categorias } : null,
        fontesIndisponiveis: [
          !vt?.disponivel && "VirusTotal", !gsb?.disponivel && "Google Safe Browsing", !urlhaus?.disponivel && "URLhaus", !radarSite?.disponivel && "Cloudflare Radar",
        ].filter(Boolean),
        empresa,
        host: hostInfo,
        pagamento: { ...pagamento, pix: pix ? { ...pix, origem: corpo?.pix ? "informado" : "encontrado na página", instituicao: instPix ? { ...instPix, ranking: bcPix } : null } : null, pixInvalido: pixLido && !pixLido.valido ? pixLido.motivo : null },
        reclameAqui,
        destinos: destinos.slice(0, 40).map(({ raiz: r, nivel, motivo, anuncio, zonas }) => ({ raiz: r, nivel, motivo, anuncio, zonas })),
        subrequests: orc.usado,
      },
    },
  });
}

const NDJSON = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" };

// Ordem da guarda: IP bloqueado? -> laudo em cache (nao gasta cota) ->
// limite do IP (janela deslizante + diario) -> teto geral do dia -> analise.
export async function handleAnalisar(request, env, ctx, cors, ip) {
  const corpo = await request.json().catch(() => null);
  const recusa = (erro, tentarEm, status) =>
    new Response(JSON.stringify({ etapa: "erro", erro, tentarEm }) + "\n", { status, headers: { ...NDJSON, ...cors } });

  let chave = null;
  if (env.SITESECURE_DO) {
    const estado = await guarda.estadoIp(env, ip);
    if (estado.bloqueado) return recusa("bloqueado", estado.tentarEm, 429);
  }

  // Turnstile antes de qualquer cota. No modo "observar" so registra no log
  // (sem IP nem entrada): contagem de quem passaria e de quem falharia.
  const ts = await conferirTurnstile(env, corpo?.turnstile, ip);
  console.log(JSON.stringify({ evento: "turnstile", modo: ts.modo, resultado: ts.resultado, bloqueou: !ts.ok }));
  if (!ts.ok) return recusa("verificacao_humana", 0, 403);

  if (env.SITESECURE_DO) {
    chave = await chaveCache(corpo?.url, corpo?.pix);
    const cache = await guarda.lerCache(env, chave);
    if (cache) {
      const linhas = cache.eventos.map((ev) => JSON.stringify(ev.etapa === "laudo" ? { ...ev, laudo: { ...ev.laudo, doCache: cache.em } } : ev));
      return new Response(`${JSON.stringify({ etapa: "cache", em: cache.em })}\n${linhas.join("\n")}\n`, { headers: { ...NDJSON, ...cors } });
    }

    const ipOk = await guarda.consumirIp(env, ip);
    if (!ipOk.ok) return recusa(ipOk.motivo, ipOk.tentarEm, 429);
    const globalOk = await guarda.consumirGlobal(env);
    if (!globalOk.ok) return recusa(globalOk.motivo, globalOk.tentarEm, 503);
  }

  const { readable, writable } = new TransformStream();
  const escritor = writable.getWriter();
  const enc = new TextEncoder();
  const finais = []; // laudos e erros, guardados no cache se houver laudo
  const emitir = (obj) => {
    if (obj.etapa === "laudo" || obj.etapa === "erro") finais.push(obj);
    return escritor.write(enc.encode(JSON.stringify(obj) + "\n"));
  };

  const trabalho = (async () => {
    try {
      await executar(env, corpo, emitir);
      if (chave && finais.some((e) => e.etapa === "laudo")) await guarda.gravarCache(env, chave, finais).catch(() => {});
    } catch (err) {
      await emitir({ etapa: "erro", erro: "falha_interna", detalhe: String(err?.message || err).slice(0, 120) }).catch(() => {});
    } finally {
      await escritor.close().catch(() => {});
    }
  })();
  ctx.waitUntil(trabalho);

  return new Response(readable, { headers: { ...NDJSON, ...cors } });
}
