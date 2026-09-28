// POST /sitesecure/analisar {url, pix?}
// Resposta em NDJSON: um evento {etapa, status, ...} por etapa concluida, para
// o frontend animar o progresso; o ultimo evento e {etapa:"laudo", laudo}.
import { validarUrl, resolverPublico } from "./guard.js";
import { renderizar, coletarEstatico } from "./render.js";
import { consultarRdap, consultarDns } from "./dominio.js";
import { avaliarCabecalhos, redirecionaParaHttps } from "./hardening.js";
import { consultarVirusTotal, consultarSafeBrowsing, consultarUrlhaus } from "./reputacao.js";
import { classificarDestinos } from "./links.js";
import { detectarRedes, avaliarPropagandas } from "./propagandas.js";
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

async function executar(env, corpo, emitir) {
  const v = validarUrl(corpo?.url);
  if (v.erro) return emitir({ etapa: "erro", erro: v.erro });
  const url = v.url;
  const host = url.hostname.toLowerCase();
  const raiz = dominioRaiz(host);
  const orc = new Orcamento(45);

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

  // 2. Hardening HTTP/TLS.
  const { hardening, httpsRedirect } = await etapa(emitir, "hardening", async () => ({
    hardening: avaliarCabecalhos(coleta.headers, coleta.urlFinal, coleta.tls),
    httpsRedirect: await redirecionaParaHttps(orc, hostFinal),
  }), { hardening: null, httpsRedirect: null });

  // 3. Links e propagandas.
  const destinos = await etapa(emitir, "links", () => classificarDestinos(orc, coleta.links, raizFinal), []);
  const propagandas = await etapa(emitir, "propagandas", async () =>
    avaliarPropagandas(detectarRedes(coleta.requisicoes, coleta.iframes), destinos, coleta.modo),
  { existe: false, verificavel: false, redes: { confiaveis: [], arriscadas: [] }, anunciantes: [] });

  const gsb = await etapa(emitir, "safebrowsing", () => consultarSafeBrowsing(orc, env, [
    url.toString(), coleta.urlFinal, ...destinos.flatMap((d) => d.exemplos),
  ]), null);
  const gsbMatches = gsb?.matches || [];
  const doSite = (m) => [host, hostFinal].includes(hostDe(m.url));
  const gsbSite = gsb?.disponivel ? gsbMatches.filter(doSite).map((m) => m.tipo) : null;
  const gsbLinks = gsbMatches.filter((m) => !doSite(m));

  // 4. Empresa e host.
  const cnpjInfo = escolherCnpj(coleta, rdap);
  const [empresa, hostInfo] = await Promise.all([
    etapa(emitir, "empresa", () => (cnpjInfo ? consultarCnpj(orc, cnpjInfo.cnpj) : null), null),
    etapa(emitir, "host", () => identificarHost(orc, dnsHost.ips, coleta.headers),
      { nome: "desconhecido", tier: "medio", plataformas: [] }),
  ]);

  // 5. Pagamento, PIX e Reclame Aqui.
  const pagamento = detectarPagamento(coleta);
  const pixBruto = (corpo?.pix || "").trim() || acharBrCodes(coleta.texto)[0] || null;
  const pixLido = pixBruto ? lerBrCode(pixBruto) : null;
  const pix = pixLido ? compararPix(pixLido, cnpjInfo?.cnpj || null, empresa) : null;
  if (pixLido?.valido) pagamento.plataforma = true;
  await emitir({ etapa: "pagamento", status: "ok" });

  let reclameAqui = null;
  if (pagamento.plataforma) {
    const termo = empresa?.nomeFantasia || tokensNome(empresa?.razaoSocial || "")[0] || raizFinal.split(".")[0];
    reclameAqui = await etapa(emitir, "reclameaqui", () => consultarReclameAqui(orc, termo), null);
  }

  // 6. Nota.
  const blocos = {
    reputacaoDominio: notaReputacao({ rdap, vt, gsbSite, urlhaus, dns, hardening, httpsRedirect, empresa, pagamento, pix, reclameAqui }),
    confiancaLinks: notaLinks({ destinos, gsbLinks, redirecionouPara: raizFinal !== raiz ? hostFinal : null }),
    propagandas: notaPropagandas(propagandas),
    headerFooter: notaHeaderFooter({ host: hostInfo, cnpjInfo, empresa, condiz: empresaCondiz(empresa, raizFinal, coleta), pagamento, destinos, coleta, rdap }),
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
        dominio: { raiz: raizFinal, criadoEm: rdap?.criadoEm || vt?.criadoEm || null, dnssec: !!dns?.dnssec, spf: !!dns?.spf, dmarc: dns?.politicaDmarc || null },
        hardening,
        virustotal: vt?.conhecido ? { maliciosos: vt.maliciosos, suspeitos: vt.suspeitos, total: vt.total, vendors: vt.vendors, categorias: vt.categorias } : null,
        fontesIndisponiveis: [
          !vt?.disponivel && "VirusTotal", !gsb?.disponivel && "Google Safe Browsing", !urlhaus?.disponivel && "URLhaus",
        ].filter(Boolean),
        empresa,
        host: hostInfo,
        pagamento: { ...pagamento, pix: pix ? { ...pix, origem: corpo?.pix ? "informado" : "encontrado na página" } : null, pixInvalido: pixLido && !pixLido.valido ? pixLido.motivo : null },
        reclameAqui,
        destinos: destinos.slice(0, 40).map(({ raiz: r, nivel, motivo, anuncio, zonas }) => ({ raiz: r, nivel, motivo, anuncio, zonas })),
        subrequests: orc.usado,
      },
    },
  });
}

export function handleAnalisar(request, env, ctx, cors) {
  const { readable, writable } = new TransformStream();
  const escritor = writable.getWriter();
  const enc = new TextEncoder();
  const emitir = (obj) => escritor.write(enc.encode(JSON.stringify(obj) + "\n"));

  const trabalho = (async () => {
    try {
      const corpo = await request.json().catch(() => null);
      await executar(env, corpo, emitir);
    } catch (err) {
      await emitir({ etapa: "erro", erro: "falha_interna", detalhe: String(err?.message || err).slice(0, 120) }).catch(() => {});
    } finally {
      await escritor.close().catch(() => {});
    }
  })();
  ctx.waitUntil(trabalho);

  return new Response(readable, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", ...cors },
  });
}
