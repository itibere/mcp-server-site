const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const API_BASE = LOCAL ? "http://127.0.0.1:8799" : "https://api.itibere.tec.br";

const TURNSTILE_SITEKEY = LOCAL ? "1x00000000000000000000AA" : "0x4AAAAAAFHu40JzGk0ox6vd";
let turnstileId = null;

(function iniciarTurnstile(tentativas = 0) {
  const caixa = document.getElementById("caixa-turnstile");
  if (!caixa) return;
  if (typeof window.turnstile?.render === "function") {
    turnstileId = window.turnstile.render("#caixa-turnstile", { sitekey: TURNSTILE_SITEKEY, theme: "dark", size: "flexible", action: "analisar", language: "pt-br" });
  } else if (tentativas < 40) {
    setTimeout(() => iniciarTurnstile(tentativas + 1), 250);
  } else {
    caixa.textContent = "A verificação de segurança não carregou. Desative bloqueadores de anúncio para este site e recarregue a página.";
    caixa.className = "text-sm text-amber-300";
  }
})();

function tokenTurnstile() {
  try {
    return turnstileId != null ? window.turnstile.getResponse(turnstileId) || "" : "";
  } catch {
    return "";
  }
}

function renovarTurnstile() {
  try {
    if (turnstileId != null) window.turnstile.reset(turnstileId);
  } catch {
    turnstileId = null;
  }
}

const ETAPAS = [
  ["dominio", "Idade e registro do domínio"],
  ["reputacao", "Reputação (VirusTotal, URLhaus)"],
  ["pagina", "Carregando a página"],
  ["hardening", "HTTPS e cabeçalhos de segurança"],
  ["links", "Para onde os links levam"],
  ["propagandas", "Propagandas e anunciantes"],
  ["safebrowsing", "Google Safe Browsing"],
  ["empresa", "CNPJ na Receita Federal"],
  ["host", "Origem da hospedagem"],
  ["pagamento", "Plataforma de pagamento e PIX"],
  ["reclameaqui", "Reclame Aqui"],
];

const ETAPAS_PIX = [
  ["pix-leitura", "Leitura do código PIX"],
  ["pix-titular", "Titular da chave"],
  ["pix-reputacao", "Endereço do QR dinâmico"],
  ["pix-instituicao", "Instituição de pagamento (Banco Central)"],
];

const BLOCOS = [
  ["reputacaoDominio", "Reputação do domínio"],
  ["confiancaLinks", "Destino dos links"],
  ["propagandas", "Segurança dos anúncios"],
  ["headerFooter", "Identificação do responsável"],
];

const ROTULO = { bom: "Sem alertas", medio: "Atenção", baixo: "Risco alto", na: "Não verificado" };
const ICONE = { bom: "✓", medio: "!", baixo: "✕", na: "?", incompleta: "?" };
const ROTULO_NOTA_PADRAO = { bom: "Parece segura", medio: "Atenção", baixo: "Risco alto" };
const ROTULO_INCOMPLETA = "Análise incompleta";

const VEREDITO_SITE = {
  bom: {
    resumo: "Nenhum sinal de risco relevante nas fontes consultadas.",
    acao: "Mesmo assim, confira se o endereço na barra do navegador é exatamente o do site que você quer antes de digitar senha ou dados do cartão.",
  },
  medio: {
    resumo: "Há pontos de atenção neste site.",
    acao: "Leia os pontos abaixo antes de comprar ou informar dados. Na dúvida, não pague e procure a loja pelo buscador ou pelo aplicativo oficial.",
  },
  baixo: {
    resumo: "Foram encontrados sinais de risco neste site.",
    acao: "Não compre, não pague e não informe senha, CPF nem cartão neste site. Se já pagou ou informou dados, avise seu banco o quanto antes.",
  },
  incompleta: {
    resumo: "Não deu para consultar todas as fontes de segurança agora.",
    acao: "Tente de novo em alguns minutos. Até lá, não decida pagar só com este resultado.",
  },
};

const VEREDITO_PIX = {
  bom: {
    resumo: "Nenhum sinal de risco no código.",
    acao: "Antes de pagar, confira no aplicativo do banco o nome e o documento de quem vai receber.",
  },
  medio: {
    resumo: "Há pontos de atenção neste código PIX.",
    acao: "Leia os pontos abaixo e confira no aplicativo do banco o nome e o documento de quem recebe antes de pagar.",
  },
  baixo: {
    resumo: "Foram encontrados sinais de risco neste código PIX.",
    acao: "Não pague por este código. Se já pagou, procure seu banco e peça a devolução pelo Mecanismo Especial de Devolução (MED) do Pix.",
  },
  incompleta: VEREDITO_SITE.incompleta,
};

const DICAS = {
  email: "SPF e DMARC informam quais servidores podem enviar e-mails em nome do domínio; DNSSEC protege a consulta do endereço do site contra adulteração. Sem eles, fica mais fácil falsificar e-mails do domínio.",
  cabecalhos: "HSTS faz o navegador usar sempre a conexão segura (HTTPS). CSP limita o que a página pode carregar. Anti-clickjacking impede que o site seja escondido dentro de outro. A falta de um item técnico, sozinha, não prova golpe.",
  tls: "O certificado TLS é o cadeado do navegador: criptografa a conexão e confirma para qual endereço ela vale.",
  engines: "Engines são os antivírus e serviços de segurança que o VirusTotal consulta ao mesmo tempo.",
  crc: "O CRC é um dígito de controle no fim do código. Se não confere, o código foi alterado ou copiado errado.",
  qr: "No QR dinâmico, os dados do pagamento ficam no servidor da instituição e podem mudar a cada cobrança.",
  boas: "Itens que sites sérios costumam cumprir. A falta de um deles, sozinha, não prova golpe. ✓ cumpre, ✗ não cumpre.",
};

const ERROS = {
  url_invalida: "Link inválido. Cole o endereço completo do site, começando com https://",
  protocolo_nao_permitido: "Esse tipo de endereço não pode ser analisado. Cole o endereço do site, começando com https://",
  porta_nao_permitida: "Esse endereço usa uma porta fora do comum e não pode ser analisado. Cole o endereço normal do site, começando com https://",
  ip_nao_permitido: "Informe o nome do site (por exemplo, loja-exemplo.com.br), não um número de IP.",
  host_nao_permitido: "Esse endereço é interno ou reservado e não pode ser analisado.",
  url_com_credenciais: "Remova usuário e senha do link e tente de novo.",
  dominio_nao_resolve: "Esse site não existe ou não está respondendo. Confira se o endereço está certo.",
  ip_privado: "Esse endereço aponta para uma rede interna e não pode ser analisado.",
  dns_falhou: "Não foi possível localizar o site agora. Tente de novo em instantes.",
  site_inacessivel: "O site não respondeu. Ele pode estar fora do ar ou bloqueando consultas automáticas. Isso, por si só, não prova golpe nem segurança.",
  redirecionou_para_destino_nao_permitido: "Este site leva a um endereço que aponta para uma rede interna ou reservada, e isso não pode ser analisado. Esse comportamento, por si só, é suspeito.",
  redirecionamento_dns_falhou: "Este site leva a outro endereço que não foi possível localizar agora. Tente de novo em instantes.",
  redirecionamentos_demais: "Este site encadeia redirecionamentos demais e não pôde ser analisado. Esse comportamento, por si só, merece atenção.",
  verificacao_indisponivel: "A verificação de segurança está fora do ar no momento. Tente de novo em alguns minutos.",
  rate_limit_excedido: "Muitas análises em pouco tempo. Aguarde um pouco e tente de novo.",
  limite_diario: "Você já usou todas as análises de hoje. Volte amanhã.",
  bloqueado: "Houve muitas tentativas seguidas e o acesso foi bloqueado por um tempo.",
  teto_diario: "A ferramenta atingiu o limite de análises de hoje. Volte amanhã.",
  verificacao_humana: "A verificação de segurança (a caixinha abaixo do campo) não terminou ou falhou. Espere ela ficar marcada e tente de novo. Se ela não aparecer, desative bloqueadores de anúncio para este site.",
  corpo_grande: "O texto enviado é grande demais. Cole só o link do site ou o código PIX, sem outro texto.",
  corpo_invalido: "Não foi possível ler o que foi enviado. Recarregue a página e tente de novo.",
  servico_indisponivel: "O serviço está temporariamente indisponível. Tente de novo em alguns minutos.",
  falha_interna: "A análise falhou. Tente de novo em instantes.",
  pix_invalido: "Esse texto não é um PIX copia-e-cola válido. Copie o código inteiro, que começa com 000201.",
  falha_rede: "Não foi possível falar com o servidor. Verifique sua conexão e tente de novo.",
  falha_resposta: "O servidor respondeu de um jeito inesperado. Tente de novo em instantes.",
};

const ERRO_POR_STATUS = { 400: "corpo_invalido", 403: "verificacao_humana", 413: "corpo_grande", 429: "rate_limit_excedido", 503: "servico_indisponivel" };

const $ = (id) => document.getElementById(id);

function el(tag, classe, texto) {
  const n = document.createElement(tag);
  if (classe) n.className = classe;
  if (texto != null) n.textContent = texto;
  return n;
}

function simbolo(texto) {
  const s = el("span", "shrink-0", texto);
  s.setAttribute("aria-hidden", "true");
  return s;
}

function selo(nivel, texto) {
  const s = el("span", `nivel-${nivel} inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-xs font-mono-code font-semibold whitespace-nowrap`);
  s.append(simbolo(ICONE[nivel] || "?"), el("span", null, texto || ROTULO[nivel]));
  return s;
}

function anunciar(texto) {
  const r = $("anuncio");
  r.textContent = "";
  setTimeout(() => { r.textContent = texto; }, 60);
}

function mostrar(view) {
  for (const v of ["view-form", "view-scan", "view-laudo"]) $(v).classList.toggle("hidden", v !== view);
}

function erroForm(msg) {
  const p = $("form-erro");
  p.textContent = msg || "";
  p.classList.toggle("hidden", !msg);
}

function montarEtapas(lista) {
  const ul = $("scan-etapas");
  ul.replaceChildren();
  for (const [id, nome] of lista) {
    const li = el("li", "flex items-center gap-2 text-slate-400");
    li.dataset.etapa = id;
    li.append(simbolo("·"), el("span", null, nome));
    li.firstChild.className = "w-4 text-center";
    ul.append(li);
  }
}

function marcarEtapa(id, status) {
  const li = $("scan-etapas").querySelector(`[data-etapa="${id}"]`);
  if (!li) return;
  const ok = status === "ok";
  li.className = `flex items-center gap-2 ${ok ? "text-emerald-300" : "text-amber-300"}`;
  li.firstChild.textContent = ok ? "✓" : "!";
  li.querySelector(".sr-only")?.remove();
  li.append(el("span", "sr-only", ok ? "concluída" : "não concluída"));
}

function listaItens(itens, classe, marcador) {
  const ul = el("ul", "space-y-1 text-sm");
  for (const t of itens) {
    const li = el("li", `flex gap-2 ${classe}`);
    li.append(simbolo(marcador), el("span", null, t));
    ul.append(li);
  }
  return ul;
}

function grupo(titulo, itens, classe, marcador) {
  const g = el("div", "space-y-1.5");
  g.append(el("p", "text-xs font-mono-code font-semibold text-slate-300", titulo), listaItens(itens, classe, marcador));
  return g;
}

function montarBlocos(box, blocos, lista = BLOCOS) {
  box.replaceChildren();
  for (const [chave, nome] of lista) {
    const b = blocos[chave];
    const det = el("details", "group");
    const sum = el("summary", "flex items-center justify-between gap-3 cursor-pointer list-none min-h-[44px] p-5 sm:p-6");
    const seta = el("span", "seta text-slate-400");
    seta.setAttribute("aria-hidden", "true");
    seta.textContent = "▾";
    const dir = el("span", "flex items-center gap-3");
    dir.append(selo(b.nivel), seta);
    sum.append(el("span", "font-mono-code text-sm sm:text-base text-white font-semibold", `${nome}:`), dir);
    det.append(sum);
    const corpo = el("div", "px-5 pb-5 sm:px-6 sm:pb-6 space-y-4");
    if (b.alertas.length) corpo.append(grupo("O que preocupa", b.alertas, "text-slate-200", "▲"));
    if (b.positivos.length) corpo.append(grupo("O que está certo", b.positivos, "text-slate-300", "✓"));
    if (b.observacoes?.length) corpo.append(grupo("Para saber", b.observacoes, "text-slate-300", "·"));
    det.append(corpo);
    if (b.nivel !== "bom") det.open = true;
    box.append(det);
  }
}

function tipoNota(l) {
  if (l.notaRotulo === ROTULO_INCOMPLETA) return "incompleta";
  return ROTULO_NOTA_PADRAO[l.nota] ? l.nota : "medio";
}

function montarVeredito(box, l, titleId) {
  const tipo = tipoNota(l);
  const textos = (l.tipo === "pix" ? VEREDITO_PIX : VEREDITO_SITE)[tipo];
  box.className = `rounded-2xl border p-6 sm:p-8 space-y-4 nivel-${tipo}`;
  box.replaceChildren();

  const topo = el("div", "flex items-center gap-4");
  const icone = el("span", "text-4xl sm:text-5xl font-extrabold leading-none w-10 text-center", ICONE[tipo]);
  icone.setAttribute("aria-hidden", "true");
  const titulos = el("div");
  titulos.append(
    el("p", "text-xs font-mono-code text-slate-200", "Resultado da análise"),
    el("h3", "text-3xl sm:text-4xl font-extrabold", l.notaRotulo || ROTULO_NOTA_PADRAO[l.nota] || ROTULO_INCOMPLETA),
  );
  titulos.lastChild.id = titleId;
  topo.append(icone, titulos);
  box.append(topo, el("p", "text-base text-slate-100", textos.resumo));

  const acao = el("p", "text-sm text-slate-100");
  acao.append(el("strong", null, "O que fazer agora: "), document.createTextNode(textos.acao));
  box.append(acao);

  if (l.analiseIncompleta) {
    const parcial = el("div", "rounded-lg border border-slate-600 bg-slate-900/60 p-4 space-y-1 text-slate-100");
    parcial.append(
      el("p", "text-sm font-semibold", "Análise parcial"),
      el("p", "text-sm", `Não foi possível consultar agora: ${(l.fontesIndisponiveis || []).join(", ") || "uma das fontes de segurança"}. O resultado pode mudar quando essas fontes voltarem.`),
    );
    box.append(parcial);
  }
}

function linha(dl, rotulo, valor, dica) {
  if (valor == null || valor === "") return;
  dl.append(
    el("dt", "text-slate-400 text-xs font-mono-code", rotulo),
    el("dd", `text-slate-200 text-sm ${dica ? "mb-0.5" : "mb-2"} break-words`, String(valor)),
  );
  if (dica) dl.append(el("dd", "text-slate-400 text-xs mb-2 break-words", dica));
}

function secao(titulo, dica) {
  const s = el("div", "space-y-2");
  s.append(el("h4", "text-xs font-mono-code text-emerald-400 tracking-wider", titulo));
  if (dica) s.append(el("p", "text-xs text-slate-400", dica));
  const dl = el("dl");
  s.append(dl);
  return [s, dl];
}

function dataBr(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toLocaleDateString("pt-BR");
}

function notasDoLaudo(l) {
  const notas = [];
  if (l.doCache) notas.push("Resultado guardado de uma análise recente do mesmo item (até 1 hora); não gastou sua cota.");
  const fontes = l.detalhes.fontesIndisponiveis;
  if (fontes?.length) notas.push(`Fontes que não responderam agora: ${fontes.join(", ")}.`);
  notas.push(`Análise automática feita em ${new Date(l.analisadoEm).toLocaleString("pt-BR")}. Ela não substitui a sua atenção.`);
  return listaItens(notas, "text-slate-300", "·");
}

function montarDetalhes(box, l) {
  const d = l.detalhes;
  box.replaceChildren(el("h3", "text-base font-bold text-white font-mono-code", "Detalhes técnicos"));

  const [sDom, dlDom] = secao("DOMÍNIO");
  linha(dlDom, "Domínio", d.dominio.raiz);
  if (d.dominio.governo) linha(dlDom, "Órgão público", `${d.dominio.governo} (domínio de registro restrito a governo)`);
  if (d.popularidade?.posicao) linha(dlDom, "Popularidade (Cloudflare Radar)", `top ${d.popularidade.posicao.toLocaleString("pt-BR")}`);
  if (d.popularidade?.categorias?.length) linha(dlDom, "Categoria (Cloudflare Radar)", d.popularidade.categorias.join(", "));
  linha(dlDom, "Registrado em", dataBr(d.dominio.criadoEm));
  linha(dlDom, "Proteção de e-mail", `SPF ${d.dominio.spf ? "sim" : "não"} · DMARC ${d.dominio.dmarc || "ausente"} · DNSSEC ${d.dominio.dnssec ? "sim" : "não"}`, DICAS.email);
  if (d.hardening) {
    const nomes = { https: "HTTPS", hsts: "HSTS", csp: "CSP", antiClickjacking: "anti-clickjacking", nosniff: "X-Content-Type-Options", referrerPolicy: "Referrer-Policy" };
    const faltam = d.hardening.faltando.length ? ` (faltam: ${d.hardening.faltando.map((k) => nomes[k] || k).join(", ")})` : "";
    linha(dlDom, "Cabeçalhos de segurança", `${d.hardening.pontos}/${d.hardening.total}${faltam}`, DICAS.cabecalhos);
    if (d.hardening.certificado) {
      const c = d.hardening.certificado;
      linha(dlDom, "Certificado TLS", [c.emissor, c.protocolo, `vence em ${c.diasParaVencer} dias`].filter(Boolean).join(" · "), DICAS.tls);
    }
  }
  box.append(sDom);

  if (d.boasPraticas?.total) {
    const bp = d.boasPraticas;
    const [s] = secao(`BOAS PRÁTICAS OFICIAIS: ${bp.cumpridos} DE ${bp.total}`, DICAS.boas);
    const ul = el("ul", "space-y-1");
    for (const i of bp.itens.filter((x) => x.ok !== null)) {
      const li = el("li", "flex flex-wrap items-baseline gap-2 text-xs");
      const marca = simbolo(i.ok ? "✓" : "✗");
      marca.className = `${i.ok ? "text-emerald-400" : "text-red-400"} w-3`;
      li.append(
        marca,
        el("span", i.ok ? "text-slate-200" : "text-slate-300", i.nome),
        el("span", "sr-only", i.ok ? "cumpre" : "não cumpre"),
        el("span", "text-slate-400 font-mono-code", i.fonte),
      );
      ul.append(li);
    }
    s.append(ul);
    box.append(s);
  }

  if (d.virustotal) {
    const [s, dl] = secao("FORNECEDORES DE SEGURANÇA (VIRUSTOTAL)");
    linha(dl, "Resultado", `${d.virustotal.maliciosos} malicioso(s), ${d.virustotal.suspeitos} suspeito(s) em ${d.virustotal.total} engines`, DICAS.engines);
    for (const v of d.virustotal.vendors) linha(dl, v.nome, v.resultado || v.categoria);
    if (d.virustotal.categorias?.length) linha(dl, "Categorias", d.virustotal.categorias.join(", "));
    box.append(s);
  }

  const [sEmp, dlEmp] = secao("EMPRESA E HOSPEDAGEM");
  if (d.empresa?.encontrado) {
    linha(dlEmp, "CNPJ", `${d.empresa.cnpj} · ${d.empresa.situacao}`);
    linha(dlEmp, "Razão social", d.empresa.razaoSocial);
    linha(dlEmp, "Nome fantasia", d.empresa.nomeFantasia);
    linha(dlEmp, "Abertura", dataBr(d.empresa.abertura));
    linha(dlEmp, "Município", d.empresa.municipio);
    linha(dlEmp, "Atividade", d.empresa.atividade);
  } else {
    linha(dlEmp, "CNPJ", "não encontrado ou não consultado");
  }
  linha(dlEmp, "Hospedagem", `${d.host.nome}${d.host.ip ? ` (IP ${d.host.ip})` : ""}`);
  box.append(sEmp);

  if (d.pagamento?.plataforma || d.pagamento?.pix || d.pagamento?.pixInvalido) {
    const [s, dl] = secao("PAGAMENTO");
    linha(dl, "Meios detectados", [d.pagamento.formularioCartao && "formulário de cartão", ...d.pagamento.gateways].filter(Boolean).join(", ") || "PIX");
    if (d.pagamento.pix) {
      linha(dl, `PIX (${d.pagamento.pix.origem})`, `recebedor ${d.pagamento.pix.recebedor || "?"}${d.pagamento.pix.cidade ? `, ${d.pagamento.pix.cidade}` : ""} · chave ${d.pagamento.pix.tipoChave}`);
      for (const a of d.pagamento.pix.achados) linha(dl, "", a);
    }
    if (d.pagamento.pix?.instituicao) linhaInstituicao(dl, d.pagamento.pix.instituicao);
    if (d.pagamento.pixInvalido) linha(dl, "PIX informado", d.pagamento.pixInvalido);
    if (d.reclameAqui) {
      const ra = d.reclameAqui;
      const dd = el("dd", "text-sm mb-2");
      if (ra.verificado) dd.append(el("span", "text-slate-200", `${ra.status}${ra.nota != null ? ` · nota ${ra.nota}` : ""} · `));
      else dd.append(el("span", "text-slate-300", "Leitura automática bloqueada. "));
      const a = el("a", "underline text-cyan-400 hover:text-cyan-300 inline-block py-2", "conferir no Reclame Aqui");
      a.href = ra.link;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      dd.append(a);
      dl.append(el("dt", "text-slate-400 text-xs font-mono-code", "Reclame Aqui"), dd);
    }
    box.append(s);
  }

  if (d.destinos?.length) {
    const [s] = secao("DOMÍNIOS EXTERNOS");
    const ul = el("ul", "space-y-1");
    for (const x of d.destinos) {
      const li = el("li", "flex flex-wrap items-center gap-2 text-xs");
      const nivel = x.nivel === "neutro" ? "na" : x.nivel;
      li.append(selo(nivel, x.nivel === "neutro" ? "neutro" : ROTULO[x.nivel]), el("span", "font-mono-code text-slate-200", x.raiz));
      if (x.anuncio) li.append(el("span", "text-amber-300", "anúncio"));
      li.append(el("span", "text-slate-400", x.motivo));
      ul.append(li);
    }
    s.append(ul);
    box.append(s);
  }

  box.append(notasDoLaudo(l));
}

function linhaInstituicao(dl, inst) {
  const r = inst.ranking;
  let txt = `${inst.nome} (pelo ${inst.pelo})`;
  if (r?.encontrada) {
    const idx = r.indice != null ? `índice ${r.indice.toLocaleString("pt-BR")} reclamações procedentes por milhão de clientes, ${r.faixa}` : r.faixa;
    txt += ` · Banco Central, ${r.periodo}: ${idx}`;
  } else if (r) txt += ` · não consta no ranking do Banco Central (${r.periodo})`;
  linha(dl, "Instituição de pagamento", txt);
  const p = inst.participante;
  if (p) {
    linha(dl, "Participante do Pix", p.participante
      ? `sim: ${p.nome}${p.autorizada ? ", autorizada pelo Banco Central" : ""} (lista oficial de ${p.data})`
      : `não consta na lista oficial de participantes (lista de ${p.data})`);
  }
}

function montarDetalhesPix(box, l) {
  const d = l.detalhes;
  box.replaceChildren(el("h3", "text-base font-bold text-white font-mono-code", "Detalhes técnicos"));
  const [s, dl] = secao("CÓDIGO PIX");
  const p = d.pix;
  const nomesChave = { cnpj: "CNPJ", cpf: "CPF", email: "e-mail", telefone: "telefone", aleatoria: "chave aleatória", desconhecida: "não identificada" };
  linha(dl, "Recebedor", `${p.recebedor || "?"}${p.cidade ? ` · ${p.cidade}` : ""}`);
  linha(dl, "Chave", p.tipoChave ? `${nomesChave[p.tipoChave] || p.tipoChave}${p.chave ? `: ${p.chave}` : ""}` : "não vem no código (QR dinâmico: fica no servidor da instituição)");
  if (p.valor) linha(dl, "Valor", `R$ ${Number(p.valor).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`);
  linha(dl, "Tipo de QR", p.dinamico ? `dinâmico, gerado em ${p.enderecoQr || "?"}` : "estático", p.dinamico ? DICAS.qr : null);
  linha(dl, "Dígito de controle (CRC)", p.crcOk ? "confere" : "não confere", DICAS.crc);
  if (d.instituicao) linhaInstituicao(dl, d.instituicao);
  box.append(s);
  if (d.empresa?.encontrado) {
    const [s2, dl2] = secao("TITULAR DA CHAVE (RECEITA FEDERAL)");
    linha(dl2, "CNPJ", `${d.empresa.cnpj} · ${d.empresa.situacao}`);
    linha(dl2, "Razão social", d.empresa.razaoSocial);
    linha(dl2, "Nome fantasia", d.empresa.nomeFantasia);
    linha(dl2, "Abertura", dataBr(d.empresa.abertura));
    linha(dl2, "Município", d.empresa.municipio);
    box.append(s2);
  }
  box.append(notasDoLaudo(l));
}

async function copiarLaudo(raiz, botao) {
  const blocos = [...raiz.querySelectorAll("details")];
  const abertos = blocos.map((d) => d.open);
  blocos.forEach((d) => { d.open = true; });
  botao.hidden = true;
  const texto = raiz.innerText.trim();
  botao.hidden = false;
  blocos.forEach((d, i) => { d.open = abertos[i]; });
  let ok = false;
  try {
    await navigator.clipboard.writeText(texto);
    ok = true;
  } catch {
    const area = el("textarea");
    area.value = texto;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.remove();
  }
  botao.textContent = ok ? "Copiado" : "Não foi possível copiar";
  anunciar(ok ? "Laudo copiado." : "Não foi possível copiar o laudo.");
  setTimeout(() => { botao.textContent = "Copiar laudo"; }, 2000);
}

let contadorLaudos = 0;

function criarCartao(rotulo, alvo, subtitulo) {
  const n = ++contadorLaudos;
  const raiz = el("article", "space-y-6");
  raiz.setAttribute("aria-labelledby", `laudo-titulo-${n}`);
  const topo = el("div", "rounded-2xl border border-slate-800 bg-[#090e17] p-6 sm:p-8 space-y-2");
  const titulo = el("h2", "text-xs font-mono-code text-slate-300 tracking-wider", rotulo);
  titulo.id = `laudo-titulo-${n}`;
  titulo.tabIndex = -1;
  topo.append(titulo, el("p", "font-mono-code text-sm text-cyan-400 break-all", alvo));
  if (subtitulo) topo.append(el("p", "text-sm text-slate-300", subtitulo));
  const copiar = el("button", "min-h-[44px] px-4 py-2 rounded-lg border border-slate-700 text-xs font-mono-code text-slate-300 hover:border-emerald-500/60 hover:text-emerald-300 transition", "Copiar laudo");
  copiar.type = "button";
  copiar.addEventListener("click", () => copiarLaudo(raiz, copiar));
  topo.append(copiar);
  const veredito = el("div");
  const blocos = el("div", "rounded-2xl border border-slate-800 bg-[#090e17] divide-y divide-slate-800");
  const detalhes = el("div", "rounded-2xl border border-slate-800 bg-[#090e17] p-6 sm:p-8 space-y-5 text-sm");
  raiz.append(topo, veredito, blocos, detalhes);
  $("laudos").append(raiz);
  return { veredito, blocos, detalhes, n };
}

function montarLaudo(l) {
  if (l.tipo === "pix") {
    const c = criarCartao("LAUDO DO PIX", "PIX copia-e-cola", l.detalhes.pix.recebedor ? `Recebedor: ${l.detalhes.pix.recebedor}` : "");
    montarVeredito(c.veredito, l, `veredito-${c.n}`);
    montarBlocos(c.blocos, l.blocos, [["pix", "Validação do PIX"]]);
    montarDetalhesPix(c.detalhes, l);
    return;
  }
  const c = criarCartao("LAUDO DO SITE", l.urlFinal !== l.url ? `${l.url} → ${l.urlFinal}` : l.url, l.titulo || "");
  montarVeredito(c.veredito, l, `veredito-${c.n}`);
  montarBlocos(c.blocos, l.blocos);
  montarDetalhes(c.detalhes, l);
}

async function lerErroHttp(res) {
  let ev = null;
  try {
    const primeira = (await res.text()).split("\n").find((x) => x.trim());
    ev = primeira ? JSON.parse(primeira) : null;
  } catch {
    ev = null;
  }
  const codigo = ev?.erro || ev?.error;
  if (codigo && ERROS[codigo]) return { erro: codigo, tentarEm: ev.tentarEm };
  return { erro: ERRO_POR_STATUS[res.status] || "falha_resposta", tentarEm: ev?.tentarEm };
}

function aplicarEvento(ev, laudos, erros) {
  if (ev.etapa === "laudo") laudos.push(ev.laudo);
  else if (ev.etapa === "erro") erros.push(ev);
  else if (ev.etapa === "cache") document.querySelectorAll("#scan-etapas li").forEach((li) => marcarEtapa(li.dataset.etapa, "ok"));
  else marcarEtapa(ev.etapa, ev.status);
}

async function lerStream(res, laudos, erros) {
  const leitor = res.body.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const linhaTxt = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (linhaTxt) aplicarEvento(JSON.parse(linhaTxt), laudos, erros);
    }
  }
}

function tempo(seg) {
  if (seg < 90) {
    const s = Math.max(1, Math.round(seg));
    return `${s} ${s === 1 ? "segundo" : "segundos"}`;
  }
  if (seg < 5400) return `${Math.round(seg / 60)} minutos`;
  return `${Math.round(seg / 3600)} horas`;
}

function mensagem(e) {
  const base = ERROS[e?.erro] || ERROS.falha_resposta;
  return e?.tentarEm > 0 && e.erro !== "teto_diario" ? `${base} Tente de novo em ${tempo(e.tentarEm)}.` : base;
}

async function analisar(url, pix) {
  montarEtapas([...(url ? ETAPAS : []), ...(pix ? ETAPAS_PIX : [])]);
  $("scan-alvo").textContent = [url, pix && "PIX copia-e-cola"].filter(Boolean).join(" + ");
  mostrar("view-scan");
  $("scan-titulo").focus();
  $("submit").disabled = true;
  const laudos = [];
  const erros = [];
  try {
    let res = null;
    try {
      res = await fetch(`${API_BASE}/sitesecure/analisar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, pix: pix || undefined, turnstile: tokenTurnstile() || undefined }),
      });
    } catch {
      erros.push({ erro: "falha_rede" });
    }
    if (res && !res.ok) erros.push(await lerErroHttp(res));
    else if (res) {
      try {
        await lerStream(res, laudos, erros);
      } catch {
        erros.push({ erro: "falha_resposta" });
      }
    }
  } finally {
    $("submit").disabled = false;
    renovarTurnstile();
  }

  if (laudos.length) {
    contadorLaudos = 0;
    $("laudos").replaceChildren();
    for (const l of laudos) montarLaudo(l);
    const aviso = $("laudo-aviso");
    aviso.textContent = erros.length ? erros.map(mensagem).join(" ") : "";
    aviso.classList.toggle("hidden", !erros.length);
    mostrar("view-laudo");
    history.pushState({ tela: "laudo" }, "", "#resultado");
    window.scrollTo({ top: 0 });
    anunciar(`Análise concluída. Resultado: ${laudos.map((l) => l.notaRotulo || ROTULO_NOTA_PADRAO[l.nota]).join(" e ")}.`);
    $("laudos").querySelector("h2")?.focus({ preventScroll: true });
    return;
  }
  mostrar("view-form");
  erroForm(erros.map(mensagem).join(" ") || mensagem());
  $("url-input").focus();
}

const ehPix = (t) => /^000201/.test(t.replace(/\s+/g, ""));

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  erroForm("");
  const entrada = $("url-input").value.trim();
  const url = entrada && !ehPix(entrada) ? entrada : "";
  const pix = entrada && ehPix(entrada) ? entrada : "";
  if (!url && !pix) {
    erroForm("Cole o link do site (por exemplo https://loja-exemplo.com.br) ou um PIX copia-e-cola.");
    return;
  }
  if (url && !/\./.test(url)) {
    erroForm("Esse link não parece um endereço de site. Exemplo: https://loja-exemplo.com.br");
    return;
  }
  analisar(url, pix);
});

for (const botao of document.querySelectorAll("[data-exemplo]")) {
  botao.addEventListener("click", () => {
    $("url-input").value = botao.dataset.exemplo;
    erroForm("");
    $("submit").focus();
  });
}

function voltarAoFormulario() {
  $("url-input").value = "";
  erroForm("");
  mostrar("view-form");
  window.scrollTo({ top: 0 });
  $("url-input").focus();
}

$("nova").addEventListener("click", () => {
  if (history.state?.tela === "laudo") history.back();
  else voltarAoFormulario();
});

window.addEventListener("popstate", (e) => {
  if (e.state?.tela !== "laudo") voltarAoFormulario();
  else if ($("laudos").children.length) mostrar("view-laudo");
});

if (location.hash === "#resultado") history.replaceState(null, "", location.pathname + location.search);
