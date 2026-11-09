// POST /sitesecure/analisar {url, pix?}
// Resposta em NDJSON: um evento {etapa, status, ...} por etapa concluida, para
// o frontend animar o progresso; o ultimo evento e {etapa:"laudo", laudo}.
import { validarUrl, resolverPublico, verificarDestinos } from "./guard.js";
import { renderizar, coletarEstatico } from "./render.js";
import { consultarRdap, consultarDns } from "./dominio.js";
import { avaliarCabecalhos, redirecionaParaHttps } from "./hardening.js";
import { consultarVirusTotal, consultarSafeBrowsing, consultarUrlhaus } from "./reputacao.js";
import { classificarDestinos, classificarPorNome } from "./links.js";
import { identificarGoverno, imitaGoverno } from "./governo.js";
import { consultarRadar } from "./radar.js";
import { coletarExtras, avaliarBoasPraticas } from "./boaspraticas.js";
import { executarPix } from "./pixonly.js";
import { guarda, chaveCache, ocultarSegredos, restaurarSegredos } from "./guarda.js";
import { conferirTurnstile } from "./turnstile.js";
import { carregarRanking, carregarParticipantes, identificarInstituicao, situacaoNoRanking, situacaoParticipante } from "./bancocentral.js";
import { detectarRedes, avaliarPropagandas, idadeDosAnunciantes } from "./propagandas.js";
import { escolherCnpj, consultarCnpj, empresaCondiz } from "./empresa.js";
import { identificarHost } from "./host.js";
import { detectarPagamento, lerBrCode, acharBrCodes, compararPix } from "./pagamento.js";
import { consultarReclameAqui } from "./reclameaqui.js";
import { registrarConsulta } from "./historico.js";
import { notaReputacao, notaLinks, notaPropagandas, notaHeaderFooter, notaSemConteudo, notaFinal, resultadoNota, fontesEssenciaisIndisponiveis } from "./nota.js";
import { Orcamento, dominioRaiz, ehPlataforma, detectarDesafio, hostDe, tokensNome, etapa, lerJsonLimitado } from "./util.js";

const MSG_DESAFIO = "o site respondeu com uma verificação anti-robô: links e anúncios da página real não foram vistos. Abra o site no navegador e refaça a análise depois";

const LIMITE_CORPO = 4096;

// Valida a entrada inteira antes de qualquer cota ou consulta externa.
export function validarEntrada(corpo) {
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) return { erro: "corpo_invalido" };
  if (corpo.url != null && typeof corpo.url !== "string") return { erro: "url_invalida" };
  if (corpo.pix != null && typeof corpo.pix !== "string") return { erro: "pix_invalido" };
  const urlTxt = (corpo.url || "").trim();
  const pix = (corpo.pix || "").trim();
  if (pix.length > 1024) return { erro: "pix_invalido", detalhe: "código longo demais" };
  if (!urlTxt && !pix) return { erro: "url_invalida" };
  let url = null;
  let brCode = null;
  if (urlTxt) {
    const v = validarUrl(urlTxt);
    if (v.erro) return { erro: v.erro };
    url = v.url;
  }
  if (pix) {
    brCode = lerBrCode(pix);
    if (!brCode.valido) return { erro: "pix_invalido", detalhe: brCode.motivo };
  }
  return { url, pix: pix || null, brCode };
}

// Link, PIX ou os dois. Com os dois, sai um laudo de cada (primeiro o do site,
// depois o do PIX), dividindo o teto de 50 subrequests do plano gratuito.
async function executar(env, corpo, emitir) {
  const pixEntrada = typeof corpo?.pix === "string" ? corpo.pix.trim() : "";
  const temUrl = !!(corpo?.url || "").trim();
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
  const vistos = new Set([host]);
  let destinoProibido = false;

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
      try {
        return await coletarEstatico(orc, url.toString(), vistos);
      } catch (err) {
        if (err?.destinoProibido) destinoProibido = true;
        throw err;
      }
    }
  });

  const pReputacao = etapa(emitir, "reputacao", async () => {
    const [vt, urlhaus] = await Promise.all([consultarVirusTotal(orc, env, raiz), consultarUrlhaus(orc, env, host)]);
    return { vt, urlhaus };
  }, { vt: null, urlhaus: null });

  const [{ rdap, dns }, coleta, { vt: vtBruto, urlhaus }] = await Promise.all([pDominio, pPagina, pReputacao]);
  if (destinoProibido) return emitir({ etapa: "erro", erro: "redirecionou_para_destino_nao_permitido" });
  if (!coleta) return emitir({ etapa: "erro", erro: "site_inacessivel" });

  // Redirecionou para outro host? Cada salto e o destino final passam pela
  // mesma checagem de sintaxe e de DNS (A e AAAA) do endereco informado.
  const hostFinal = hostDe(coleta.urlFinal) || host;
  const saltos = await verificarDestinos(orc, vistos, [...(coleta.redirecionamentos || []), coleta.urlFinal]).catch(() => ({ erro: "dns_falhou" }));
  if (saltos.erro) return emitir({ etapa: "erro", erro: "redirecionou_para_destino_nao_permitido" });
  const raizFinal = dominioRaiz(hostFinal);
  // Subdominio de plataforma (appspot.com, myshopify.com...): a data de criacao
  // que o VirusTotal e o RDAP devolvem e a da plataforma, nao a do site.
  const plataforma = ehPlataforma(raizFinal);
  const vt = plataforma && vtBruto ? { ...vtBruto, criadoEm: null } : vtBruto;
  const desafio = detectarDesafio(coleta);
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
  const rdapSite = plataforma ? { encontrado: false } : rdapFinal?.encontrado ? rdapFinal : rdap;

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
  const partPix = instPix ? situacaoParticipante(await carregarParticipantes(orc).catch(() => null), instPix) : null;
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
    confiancaLinks: desafio ? notaSemConteudo(MSG_DESAFIO) : notaLinks({ destinos, gsbLinks, redirecionamento }),
    propagandas: desafio ? notaSemConteudo(MSG_DESAFIO) : notaPropagandas(propagandas),
    headerFooter: notaHeaderFooter({ host: hostInfo, cnpjInfo, empresa, condiz: empresaCondiz(empresa, raizFinal, coleta), pagamento, destinos, coleta, rdap: rdapSite, governo, boas, raiz: raizFinal }),
  };

  const fontesIndisponiveis = fontesEssenciaisIndisponiveis({ vt, gsb, urlhaus });
  await emitir({
    etapa: "laudo",
    laudo: {
      url: url.toString(),
      urlFinal: coleta.urlFinal,
      titulo: coleta.titulo.slice(0, 120),
      modo: coleta.modo,
      analisadoEm: new Date().toISOString(),
      ...resultadoNota(notaFinal(blocos), fontesIndisponiveis),
      blocos,
      detalhes: {
        dominio: { raiz: raizFinal, criadoEm: rdapSite?.criadoEm || vt?.criadoEm || null, dnssec: !!dns?.dnssec, spf: !!dns?.spf, dmarc: dns?.politicaDmarc || null, governo: governo.governo ? governo.esfera : null },
        popularidade: radarSite?.disponivel ? { posicao: radarSite.posicao, categorias: radarSite.categorias } : null,
        boasPraticas: boas,
        hardening,
        virustotal: vt?.conhecido ? { maliciosos: vt.maliciosos, suspeitos: vt.suspeitos, total: vt.total, vendors: vt.vendors, categorias: vt.categorias } : null,
        fontesIndisponiveis: [...fontesIndisponiveis, !radarSite?.disponivel && "Cloudflare Radar"].filter(Boolean),
        empresa,
        host: hostInfo,
        pagamento: { ...pagamento, pix: pix ? { ...pix, origem: corpo?.pix ? "informado" : "encontrado na página", instituicao: instPix ? { ...instPix, ranking: bcPix, participante: partPix } : null } : null, pixInvalido: pixLido && !pixLido.valido ? pixLido.motivo : null },
        reclameAqui,
        destinos: destinos.slice(0, 40).map(({ raiz: r, nivel, motivo, anuncio, zonas }) => ({ raiz: r, nivel, motivo, anuncio, zonas })),
        subrequests: orc.usado,
      },
    },
  });
}

const NDJSON = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" };

// O que o cache nao pode guardar em claro: a URL informada (com query) e o
// recebedor, a cidade e o valor do PIX.
function segredosDaEntrada(entrada) {
  const { url, brCode } = entrada;
  return [url?.toString(), url && url.search.length > 3 ? url.search : null, brCode?.recebedor, brCode?.cidade].filter(Boolean);
}

function limparParaCache(eventos, entrada) {
  const copia = ocultarSegredos(eventos, segredosDaEntrada(entrada));
  for (const ev of copia) if (ev.laudo?.detalhes?.pix) ev.laudo.detalhes.pix.valor = null;
  return copia;
}

function restaurarDoCache(eventos, entrada) {
  const copia = restaurarSegredos(eventos, segredosDaEntrada(entrada));
  for (const ev of copia) if (ev.laudo?.detalhes?.pix) ev.laudo.detalhes.pix.valor = entrada.brCode?.valor ?? null;
  return copia;
}

const laudosDe = (eventos) => eventos.filter((e) => e.etapa === "laudo").map((e) => e.laudo);

// Ordem: corpo e entrada validos (sem gastar cota) -> IP bloqueado? -> Turnstile
// -> laudo em cache (nao gasta cota) -> limite do IP (janela deslizante +
// diario) -> teto geral do dia -> analise. Sem laudo no fim, o teto do dia e
// devolvido: ele so cai com analises concluidas.
export async function handleAnalisar(request, env, ctx, cors, ip, ipBruto = ip) {
  const recusa = (erro, tentarEm, status) =>
    new Response(JSON.stringify({ etapa: "erro", erro, tentarEm }) + "\n", { status, headers: { ...NDJSON, ...cors } });

  const lido = await lerJsonLimitado(request, LIMITE_CORPO);
  if (lido.erro) return recusa(lido.erro, 0, lido.status);
  const corpo = lido.corpo;
  const entrada = validarEntrada(corpo);
  if (entrada.erro) return recusa(entrada.erro, 0, 400);

  const comGuarda = !!env.SITESECURE_DO;
  const tentar = async (fn, padrao) => {
    try {
      return await fn();
    } catch {
      return padrao;
    }
  };

  let chave = null;
  if (comGuarda) {
    const estado = await tentar(() => guarda.estadoIp(env, ip), { bloqueado: false });
    if (estado.bloqueado) return recusa("bloqueado", estado.tentarEm, 429);
  }

  // No modo "observar" so registra no log (sem IP nem entrada): contagem de
  // quem passaria e de quem falharia.
  const ts = await conferirTurnstile(env, corpo.turnstile, ipBruto);
  console.log(JSON.stringify({ evento: "turnstile", modo: ts.modo, resultado: ts.resultado, bloqueou: !ts.ok }));
  if (!ts.ok) return recusa("verificacao_humana", 0, 403);

  let consumiuGlobal = false;
  if (comGuarda) {
    chave = await chaveCache(entrada.url?.toString(), entrada.pix);
    const cache = await tentar(() => guarda.lerCache(env, chave), null);
    if (cache) {
      const eventos = restaurarDoCache(cache.eventos, entrada);
      const laudos = laudosDe(eventos);
      ctx.waitUntil(Promise.all(laudos.map((l) => registrarConsulta(env, l, { cache: true }))));
      const linhas = eventos.map((ev) => JSON.stringify(ev.etapa === "laudo" ? { ...ev, laudo: { ...ev.laudo, doCache: cache.em } } : ev));
      return new Response(`${JSON.stringify({ etapa: "cache", em: cache.em })}
${linhas.join("\n")}\n`, { headers: { ...NDJSON, ...cors } });
    }

    try {
      const ipOk = await guarda.consumirIp(env, ip);
      if (!ipOk.ok) return recusa(ipOk.motivo, ipOk.tentarEm, 429);
      const globalOk = await guarda.consumirGlobal(env);
      if (!globalOk.ok) return recusa(globalOk.motivo, globalOk.tentarEm, 503);
      consumiuGlobal = true;
    } catch {
      return recusa("servico_indisponivel", 60, 503);
    }
  }

  const { readable, writable } = new TransformStream();
  const escritor = writable.getWriter();
  const enc = new TextEncoder();
  const finais = []; // laudos e erros, guardados no cache se so houver laudos
  const emitir = async (obj) => {
    if (obj.etapa === "laudo" || obj.etapa === "erro") finais.push(obj);
    try {
      await escritor.write(enc.encode(JSON.stringify(obj) + "\n"));
    } catch { /* cliente desconectou: a analise termina e vai para o cache */ }
  };

  const trabalho = (async () => {
    try {
      await executar(env, corpo, emitir);
    } catch (err) {
      console.log(JSON.stringify({ evento: "analise_falhou", erro: String(err?.message || err).slice(0, 120) }));
      await emitir({ etapa: "erro", erro: "falha_interna" }).catch(() => {});
    }
    const laudos = laudosDe(finais);
    if (!laudos.length && consumiuGlobal) await tentar(() => guarda.estornarGlobal(env), null);
    if (chave && laudos.length && finais.every((e) => e.etapa === "laudo")) {
      await tentar(() => guarda.gravarCache(env, chave, limparParaCache(finais, entrada)), null);
    }
    for (const laudo of laudos) await registrarConsulta(env, laudo);
    await escritor.close().catch(() => {});
  })();
  ctx.waitUntil(trabalho);

  return new Response(readable, { headers: { ...NDJSON, ...cors } });
}
