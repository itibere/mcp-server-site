// Regras de nota. Cada bloco vira bom/medio/baixo com a lista de evidencias
// que levou a isso. Ajuste os limites aqui, num lugar so.
const LIMITES = {
  dominioNovoDias: 30,
  dominioJovemDias: 365,
  empresaNovaDias: 180,
  vtMaliciososBaixo: 2,
  hardeningMinimo: 4, // de 6 itens
  certificadoVencendoDias: 7,
  mediosParaNotaMedia: 2,
};

const ROTULO_HARDENING = {
  https: "HTTPS", hsts: "HSTS", csp: "CSP", antiClickjacking: "proteção contra clickjacking",
  nosniff: "X-Content-Type-Options", referrerPolicy: "Referrer-Policy",
};

function bloco(evid) {
  const nivel = evid.baixo.length ? "baixo" : evid.medio.length >= evid.mediosParaMedio ? "medio" : "bom";
  return { nivel, alertas: [...evid.baixo, ...evid.medio], positivos: evid.bom, observacoes: evid.obs };
}

function novo(mediosParaMedio = 1) {
  return { baixo: [], medio: [], bom: [], obs: [], mediosParaMedio };
}

export function notaReputacao(d) {
  const e = novo();
  const leves = []; // itens que so derrubam para medio se vierem 2 ou mais
  const { rdap, vt, gsbSite, urlhaus, dns, hardening, httpsRedirect, empresa, pagamento, pix, reclameAqui } = d;

  const idade = rdap?.idadeDias ?? (vt?.criadoEm ? Math.floor((Date.now() - Date.parse(vt.criadoEm)) / 86_400_000) : null);
  if (idade == null) leves.push("idade do domínio não informada pelo registro");
  else if (idade < LIMITES.dominioNovoDias && (hardening?.pontos ?? 0) < LIMITES.hardeningMinimo) e.baixo.push(`domínio criado há ${idade} dias e sem hardening`);
  else if (idade < LIMITES.dominioNovoDias) e.medio.push(`domínio criado há ${idade} dias`);
  else if (idade < LIMITES.dominioJovemDias) e.medio.push(`domínio com menos de 1 ano (${idade} dias)`);
  else e.bom.push(`domínio registrado há ${Math.floor(idade / 365)} ano(s)`);

  if (vt?.conhecido) {
    if (vt.maliciosos >= LIMITES.vtMaliciososBaixo) e.baixo.push(`${vt.maliciosos} engines do VirusTotal marcam como malicioso`);
    else if (vt.maliciosos || vt.suspeitos) e.medio.push(`${vt.maliciosos + vt.suspeitos} engine(s) do VirusTotal com alerta`);
    else e.bom.push(`${vt.total} engines do VirusTotal sem alerta`);
  } else if (vt?.disponivel) leves.push("domínio desconhecido no VirusTotal");

  if (gsbSite?.length) e.baixo.push(`Google Safe Browsing: ${gsbSite.join(", ")}`);
  else if (gsbSite) e.bom.push("Google Safe Browsing sem alerta");
  if (urlhaus?.listado && urlhaus.online) e.baixo.push(`URLhaus: ${urlhaus.online} URL(s) de malware ativas neste host`);
  else if (urlhaus?.listado) leves.push("URLhaus: histórico de malware neste host (hoje offline)");

  if (!hardening?.itens?.https) e.baixo.push("site sem HTTPS");
  else if (hardening.pontos < LIMITES.hardeningMinimo) leves.push(`hardening HTTP fraco: faltam ${hardening.faltando.map((k) => ROTULO_HARDENING[k]).join(", ")}`);
  else e.bom.push(`hardening HTTP ${hardening.pontos}/6`);
  if (httpsRedirect === false) leves.push("HTTP não redireciona para HTTPS");
  if (hardening?.certificado && hardening.certificado.diasParaVencer < LIMITES.certificadoVencendoDias) e.medio.push(`certificado TLS vence em ${hardening.certificado.diasParaVencer} dias`);

  if (dns && (!dns.politicaDmarc || dns.politicaDmarc === "none") && !dns.spfRestritivo) leves.push("sem SPF/DMARC que impeça falsificação de e-mail do domínio");
  else if (dns?.politicaDmarc === "reject" || dns?.politicaDmarc === "quarantine") e.bom.push(`DMARC p=${dns.politicaDmarc}`);

  if (empresa?.encontrado && !empresa.ativa) e.baixo.push(`CNPJ ${empresa.cnpj} com situação ${empresa.situacao}`);

  if (pagamento?.plataforma) {
    if (pix) (pix.nivel === "baixo" ? e.baixo : pix.nivel === "medio" ? e.medio : e.bom).push(...pix.achados);
    if (reclameAqui?.verificado) {
      const txt = `Reclame Aqui: ${reclameAqui.status}${reclameAqui.nota != null ? ` (nota ${reclameAqui.nota})` : ""}`;
      (reclameAqui.nivel === "baixo" ? e.baixo : reclameAqui.nivel === "medio" ? e.medio : e.bom).push(txt);
    } else {
      e.medio.push("site com pagamento e reputação no Reclame Aqui não confirmada automaticamente");
    }
  }

  if (leves.length >= 2) e.medio.push(...leves);
  else e.obs.push(...leves);
  return bloco(e);
}

export function notaLinks({ destinos, gsbLinks, redirecionouPara }) {
  const e = novo();
  const naoAnuncio = destinos.filter((d) => !d.anuncio);
  const ruins = naoAnuncio.filter((d) => d.nivel === "baixo");
  for (const r of ruins.slice(0, 6)) e.baixo.push(`${r.raiz}: ${r.motivo}`);
  for (const m of (gsbLinks || []).slice(0, 6)) e.baixo.push(`Safe Browsing marca ${m.url} (${m.tipo})`);
  if (redirecionouPara) e.medio.push(`o endereço informado redireciona para outro domínio: ${redirecionouPara}`);
  const encurtados = naoAnuncio.filter((d) => d.encurtado);
  if (encurtados.length) e.medio.push(`${encurtados.length} link(s) por encurtador (destino escondido)`);
  const medios = naoAnuncio.filter((d) => d.nivel === "medio");
  for (const m of medios.slice(0, 4)) e.medio.push(`${m.raiz}: ${m.motivo}`);
  const bons = naoAnuncio.filter((d) => d.nivel === "bom").length;
  const neutros = naoAnuncio.filter((d) => d.nivel === "neutro").length;
  e.bom.push(`${naoAnuncio.length} domínio(s) externo(s): ${bons} de boa reputação, ${neutros} sem registro negativo`);
  return bloco(e);
}

export function notaPropagandas(p) {
  if (!p.existe && !p.verificavel) {
    return { nivel: "na", alertas: ["navegador indisponível agora (cota diária ou tempo esgotado): anúncios carregados por JavaScript não foram verificados"], positivos: [], observacoes: [] };
  }
  const e = novo();
  if (!p.existe) {
    e.bom.push("nenhuma propaganda encontrada");
    return bloco(e);
  }
  if (p.redes.arriscadas.length) e.baixo.push(`redes de anúncio com histórico de malvertising/adulto: ${p.redes.arriscadas.join(", ")}`);
  for (const a of p.anunciantes.filter((x) => x.nivel === "baixo").slice(0, 6)) e.baixo.push(`anúncio leva a ${a.raiz}: ${a.motivo}`);
  const neutros = p.anunciantes.filter((x) => x.nivel === "neutro" || x.nivel === "medio");
  if (neutros.length) e.medio.push(`anúncios levam a sites sem reputação conhecida: ${neutros.slice(0, 5).map((x) => x.raiz).join(", ")}`);
  if (p.redes.confiaveis.length) e.bom.push(`redes de anúncio conhecidas: ${p.redes.confiaveis.join(", ")}`);
  const bons = p.anunciantes.filter((x) => x.nivel === "bom");
  if (bons.length) e.bom.push(`anúncios levam a lojas de boa reputação: ${bons.slice(0, 5).map((x) => x.raiz).join(", ")}`);
  return bloco(e);
}

export function notaHeaderFooter({ host, cnpjInfo, empresa, condiz, pagamento, destinos, coleta, rdap }) {
  const e = novo();
  const rotuloHost = `hospedado em ${host.nome}${host.organizacao && host.organizacao !== host.nome ? ` (${host.organizacao})` : ""}`;
  (host.tier === "baixo" ? e.baixo : host.tier === "medio" ? e.medio : e.bom).push(rotuloHost);

  if (!cnpjInfo) (pagamento?.plataforma ? e.baixo : e.medio).push(pagamento?.plataforma ? "site com pagamento e sem CNPJ no rodapé" : "nenhum CNPJ encontrado no rodapé");
  else if (empresa?.encontrado) {
    if (empresa.ativa) e.bom.push(`CNPJ ${empresa.cnpj} ativo (${cnpjInfo.origem}): ${empresa.razaoSocial}`);
    if (empresa.idadeDias != null && empresa.idadeDias < LIMITES.empresaNovaDias) e.medio.push(`empresa aberta há ${empresa.idadeDias} dias`);
    if (condiz === false) (pagamento?.plataforma ? e.medio : e.obs).push(`razão social (${empresa.razaoSocial}) não aparece no nome do site`);
  } else if (empresa?.encontrado === false) e.baixo.push(`CNPJ ${cnpjInfo.cnpj} não existe na Receita Federal`);
  else e.medio.push(`CNPJ ${cnpjInfo.cnpj} encontrado (${cnpjInfo.origem}), mas a consulta à Receita falhou agora`);

  if (cnpjInfo && rdap?.cnpjTitular && cnpjInfo.cnpj.slice(0, 8) !== rdap.cnpjTitular.slice(0, 8)) {
    e.medio.push("CNPJ do rodapé é diferente do titular do domínio no registro.br");
  }
  const ruinsMoldura = destinos.filter((d) => d.nivel === "baixo" && d.zonas.some((z) => z === "header" || z === "footer"));
  for (const r of ruinsMoldura.slice(0, 4)) e.baixo.push(`link no header/footer para ${r.raiz}: ${r.motivo}`);
  if (!coleta.temFooter) e.medio.push("página sem rodapé identificável");
  return bloco(e);
}

export function notaFinal(blocos) {
  const niveis = Object.values(blocos).map((b) => b.nivel).filter((n) => n !== "na");
  if (niveis.includes("baixo")) return "baixo";
  if (niveis.filter((n) => n === "medio").length >= LIMITES.mediosParaNotaMedia) return "medio";
  return "bom";
}
