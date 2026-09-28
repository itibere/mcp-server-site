// IJ Sitesecure: envia o link ao worker, anima as etapas pelo stream NDJSON
// e monta o laudo. Todo texto vindo da análise entra via textContent.
const API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname)
  ? "http://127.0.0.1:8799"
  : "https://api.itibere.tec.br";

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

const BLOCOS = [
  ["reputacaoDominio", "Reputação do Domínio"],
  ["confiancaLinks", "Confiança dos links"],
  ["propagandas", "Existência de propagandas"],
  ["headerFooter", "Validação de header e footer"],
];

const ROTULO = { bom: "Bom", medio: "Médio", baixo: "Baixo", na: "Não verificado" };
const ROTULO_NOTA = { bom: "Boa", medio: "Média", baixo: "Baixa" };
const FRASE_NOTA = {
  bom: "Nenhum sinal de risco relevante nas fontes consultadas.",
  medio: "Há pontos de atenção. Confira os detalhes antes de comprar ou informar dados.",
  baixo: "Sinais de risco encontrados. Evite comprar, pagar ou informar dados neste site.",
};

const ERROS = {
  url_invalida: "Link inválido. Cole o endereço completo do site.",
  protocolo_nao_permitido: "Só links http:// ou https://.",
  porta_nao_permitida: "Só sites nas portas padrão (80/443).",
  ip_nao_permitido: "Informe o domínio do site, não um endereço IP.",
  host_nao_permitido: "Endereço interno ou reservado não pode ser analisado.",
  url_com_credenciais: "Remova usuário e senha do link.",
  dominio_nao_resolve: "Esse domínio não existe ou não responde no DNS.",
  ip_privado: "Esse domínio aponta para uma rede interna e não pode ser analisado.",
  dns_falhou: "Não foi possível resolver o domínio agora. Tente de novo.",
  site_inacessivel: "O site não respondeu. Ele pode estar fora do ar ou bloqueando acesso automatizado.",
  redirecionou_para_destino_nao_permitido: "O site redireciona para um endereço interno ou IP. Isso por si só é suspeito.",
  rate_limit_excedido: "Limite de 5 análises a cada 10 minutos atingido. Aguarde e tente de novo.",
  falha_interna: "Falha na análise. Tente de novo em instantes.",
  pix_invalido: "Esse texto não é um PIX copia-e-cola válido. Copie o código inteiro, que começa com 000201.",
};

const $ = (id) => document.getElementById(id);

function el(tag, classe, texto) {
  const n = document.createElement(tag);
  if (classe) n.className = classe;
  if (texto != null) n.textContent = texto;
  return n;
}

function selo(nivel, texto) {
  return el("span", `nivel-${nivel} inline-block px-2.5 py-0.5 rounded-full border text-xs font-mono-code font-semibold whitespace-nowrap`, texto || ROTULO[nivel]);
}

// O formulario continua visivel acima do laudo, para analisar outro site.
const VISIVEIS = { "view-form": ["view-form"], "view-scan": ["view-scan"], "view-laudo": ["view-form", "view-laudo"] };

function mostrar(view) {
  for (const v of ["view-form", "view-scan", "view-laudo"]) $(v).classList.toggle("hidden", !VISIVEIS[view].includes(v));
}

function erroForm(msg) {
  const p = $("form-erro");
  p.textContent = msg || "";
  p.classList.toggle("hidden", !msg);
}

// ---------- ETAPAS ----------
const ETAPAS_PIX = [
  ["pix-leitura", "Leitura do código PIX"],
  ["pix-titular", "Titular da chave"],
  ["pix-reputacao", "Endereço do QR dinâmico"],
  ["pix-instituicao", "Instituição de pagamento (Banco Central)"],
];

function montarEtapas(lista = ETAPAS) {
  const ul = $("scan-etapas");
  ul.replaceChildren();
  for (const [id, nome] of lista) {
    const li = el("li", "flex items-center gap-2 text-slate-500");
    li.dataset.etapa = id;
    li.append(el("span", "w-4 text-center", "·"), el("span", null, nome));
    ul.append(li);
  }
}

function marcarEtapa(id, status) {
  const li = $("scan-etapas").querySelector(`[data-etapa="${id}"]`);
  if (!li) return;
  const ok = status === "ok";
  li.className = `flex items-center gap-2 ${ok ? "text-emerald-300" : "text-amber-300"}`;
  li.firstChild.textContent = ok ? "✓" : "!";
}

// ---------- LAUDO ----------
function listaItens(itens, classe, marcador) {
  const ul = el("ul", "space-y-1 text-xs sm:text-sm");
  for (const t of itens) {
    const li = el("li", `flex gap-2 ${classe}`);
    li.append(el("span", "shrink-0", marcador), el("span", null, t));
    ul.append(li);
  }
  return ul;
}

function montarBlocos(box, blocos, lista = BLOCOS) {
  box.replaceChildren();
  for (const [chave, nome] of lista) {
    const b = blocos[chave];
    const det = el("details", "group p-5 sm:p-6");
    const sum = el("summary", "flex items-center justify-between gap-3 cursor-pointer list-none");
    sum.append(el("span", "font-mono-code text-sm sm:text-base text-white font-semibold", `${nome}:`), selo(b.nivel));
    det.append(sum);
    const corpo = el("div", "mt-4 space-y-3");
    if (b.alertas.length) corpo.append(listaItens(b.alertas, "text-slate-200", "▲"));
    if (b.positivos.length) corpo.append(listaItens(b.positivos, "text-slate-400", "✓"));
    if (b.observacoes?.length) corpo.append(listaItens(b.observacoes, "text-slate-500", "·"));
    det.append(corpo);
    if (b.nivel !== "bom") det.open = true;
    box.append(det);
  }
}

function montarNota(box, nota) {
  box.className = `rounded-2xl border p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center gap-4 nivel-${nota}`;
  box.replaceChildren();
  const esq = el("div", "flex items-center gap-3");
  esq.append(el("span", "font-mono-code text-sm text-slate-300", "Nota:"), el("span", "text-3xl sm:text-4xl font-extrabold", ROTULO_NOTA[nota]));
  box.append(esq, el("p", "text-sm text-slate-200 sm:ml-4", FRASE_NOTA[nota]));
}

function linha(dl, rotulo, valor) {
  if (valor == null || valor === "") return;
  dl.append(el("dt", "text-slate-500 text-xs font-mono-code", rotulo), el("dd", "text-slate-200 text-sm mb-2 break-words", String(valor)));
}

function secao(titulo) {
  const s = el("div", "space-y-2");
  s.append(el("h3", "text-xs font-mono-code text-emerald-400 tracking-wider", titulo));
  const dl = el("dl");
  s.append(dl);
  return [s, dl];
}

function dataBr(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toLocaleDateString("pt-BR");
}

function montarDetalhes(box, l) {
  const d = l.detalhes;
  box.replaceChildren(el("h2", "text-base font-bold text-white font-mono-code", "Detalhes"));

  const [sDom, dlDom] = secao("DOMÍNIO");
  linha(dlDom, "Domínio", d.dominio.raiz);
  if (d.dominio.governo) linha(dlDom, "Órgão público", `${d.dominio.governo} (domínio de registro restrito a governo)`);
  if (d.popularidade?.posicao) linha(dlDom, "Popularidade (Cloudflare Radar)", `top ${d.popularidade.posicao.toLocaleString("pt-BR")}`);
  if (d.popularidade?.categorias?.length) linha(dlDom, "Categoria (Cloudflare Radar)", d.popularidade.categorias.join(", "));
  linha(dlDom, "Registrado em", dataBr(d.dominio.criadoEm));
  linha(dlDom, "Proteção de e-mail", `SPF ${d.dominio.spf ? "sim" : "não"} · DMARC ${d.dominio.dmarc || "ausente"} · DNSSEC ${d.dominio.dnssec ? "sim" : "não"}`);
  if (d.hardening) {
    const nomes = { https: "HTTPS", hsts: "HSTS", csp: "CSP", antiClickjacking: "anti-clickjacking", nosniff: "X-Content-Type-Options", referrerPolicy: "Referrer-Policy" };
    const faltam = d.hardening.faltando.length ? ` (faltam: ${d.hardening.faltando.map((k) => nomes[k] || k).join(", ")})` : "";
    linha(dlDom, "Cabeçalhos de segurança", `${d.hardening.pontos}/${d.hardening.total}${faltam}`);
    if (d.hardening.certificado) linha(dlDom, "Certificado TLS", `${d.hardening.certificado.emissor} · ${d.hardening.certificado.protocolo} · vence em ${d.hardening.certificado.diasParaVencer} dias`);
  }
  box.append(sDom);

  if (d.boasPraticas?.total) {
    const bp = d.boasPraticas;
    const [s] = secao(`BOAS PRÁTICAS OFICIAIS: ${bp.cumpridos} DE ${bp.total}`);
    const ul = el("ul", "space-y-1");
    for (const i of bp.itens.filter((x) => x.ok !== null)) {
      const li = el("li", "flex flex-wrap items-baseline gap-2 text-xs");
      li.append(
        el("span", i.ok ? "text-emerald-400 w-3" : "text-red-400 w-3", i.ok ? "✓" : "✗"),
        el("span", i.ok ? "text-slate-200" : "text-slate-400", i.nome),
        el("span", "text-slate-600 font-mono-code", i.fonte),
      );
      ul.append(li);
    }
    s.append(ul);
    box.append(s);
  }

  if (d.virustotal) {
    const [s, dl] = secao("FORNECEDORES DE SEGURANÇA (VIRUSTOTAL)");
    linha(dl, "Resultado", `${d.virustotal.maliciosos} malicioso(s), ${d.virustotal.suspeitos} suspeito(s) em ${d.virustotal.total} engines`);
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
      else dd.append(el("span", "text-slate-400", "Leitura automática bloqueada. "));
      const a = el("a", "underline text-cyan-400 hover:text-cyan-300", "conferir no Reclame Aqui");
      a.href = ra.link;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      dd.append(a);
      dl.append(el("dt", "text-slate-500 text-xs font-mono-code", "Reclame Aqui"), dd);
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
      li.append(el("span", "text-slate-500", x.motivo));
      ul.append(li);
    }
    s.append(ul);
    box.append(s);
  }

  const notas = [];
  if (l.modo === "estatico") notas.push("Página lida sem navegador (HTML estático): anúncios injetados por JavaScript podem não ter sido vistos.");
  if (d.fontesIndisponiveis?.length) notas.push(`Fontes indisponíveis nesta análise: ${d.fontesIndisponiveis.join(", ")}.`);
  notas.push(`Analisado em ${new Date(l.analisadoEm).toLocaleString("pt-BR")}.`);
  box.append(listaItens(notas, "text-slate-500", "·"));
}

// Instituicao de pagamento + ranking de reclamacoes do Banco Central.
function linhaInstituicao(dl, inst) {
  const r = inst.ranking;
  let txt = `${inst.nome} (pelo ${inst.pelo})`;
  if (r?.encontrada) {
    const idx = r.indice != null ? `índice ${r.indice.toLocaleString("pt-BR")} reclamações procedentes por milhão de clientes, ${r.faixa}` : r.faixa;
    txt += ` · Banco Central, ${r.periodo}: ${idx}`;
  } else if (r) txt += ` · não consta no ranking do Banco Central (${r.periodo})`;
  linha(dl, "Instituição de pagamento", txt);
}

function montarDetalhesPix(box, l) {
  const d = l.detalhes;
  box.replaceChildren(el("h2", "text-base font-bold text-white font-mono-code", "Detalhes"));
  const [s, dl] = secao("CÓDIGO PIX");
  const p = d.pix;
  const nomesChave = { cnpj: "CNPJ", cpf: "CPF", email: "e-mail", telefone: "telefone", aleatoria: "chave aleatória", desconhecida: "não identificada" };
  linha(dl, "Recebedor", `${p.recebedor || "?"}${p.cidade ? ` · ${p.cidade}` : ""}`);
  linha(dl, "Chave", p.tipoChave ? `${nomesChave[p.tipoChave] || p.tipoChave}${p.chave ? `: ${p.chave}` : ""}` : "não vem no código (QR dinâmico: fica no servidor da instituição)");
  if (p.valor) linha(dl, "Valor", `R$ ${Number(p.valor).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`);
  linha(dl, "Tipo de QR", p.dinamico ? `dinâmico, gerado em ${p.enderecoQr || "?"}` : "estático");
  linha(dl, "Dígito de controle (CRC)", p.crcOk ? "confere" : "não confere");
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
  const notas = [];
  if (d.fontesIndisponiveis?.length) notas.push(`Fontes indisponíveis nesta análise: ${d.fontesIndisponiveis.join(", ")}.`);
  notas.push("O ranking do Banco Central só informa: não altera a nota.");
  notas.push(`Analisado em ${new Date(l.analisadoEm).toLocaleString("pt-BR")}.`);
  box.append(listaItens(notas, "text-slate-500", "·"));
}

// Um cartao por laudo (site e/ou PIX), um abaixo do outro em #laudos.
function criarCartao(rotulo, alvo, subtitulo) {
  const raiz = el("article", "space-y-6");
  const topo = el("div", "rounded-2xl border border-slate-800 bg-[#090e17] p-6 sm:p-8 space-y-2");
  topo.append(
    el("p", "text-xs font-mono-code text-slate-500", rotulo),
    el("p", "font-mono-code text-sm text-cyan-400 break-all", alvo),
  );
  if (subtitulo) topo.append(el("p", "text-sm text-slate-400", subtitulo));
  const blocos = el("div", "rounded-2xl border border-slate-800 bg-[#090e17] divide-y divide-slate-800");
  const nota = el("div");
  const detalhes = el("div", "rounded-2xl border border-slate-800 bg-[#090e17] p-6 sm:p-8 space-y-5 text-sm");
  raiz.append(topo, blocos, nota, detalhes);
  $("laudos").append(raiz);
  return { blocos, nota, detalhes };
}

function montarLaudo(l) {
  if (l.tipo === "pix") {
    const c = criarCartao("LAUDO DO PIX", "PIX copia-e-cola", l.detalhes.pix.recebedor ? `Recebedor: ${l.detalhes.pix.recebedor}` : "");
    montarBlocos(c.blocos, l.blocos, [["pix", "Validação do PIX"]]);
    montarNota(c.nota, l.nota);
    montarDetalhesPix(c.detalhes, l);
    return;
  }
  const c = criarCartao("LAUDO DO SITE", l.urlFinal !== l.url ? `${l.url} → ${l.urlFinal}` : l.url, l.titulo || "");
  montarBlocos(c.blocos, l.blocos);
  montarNota(c.nota, l.nota);
  montarDetalhes(c.detalhes, l);
}

// ---------- ENVIO ----------
async function analisar(url, pix) {
  montarEtapas([...(url ? ETAPAS : []), ...(pix ? ETAPAS_PIX : [])]);
  $("scan-alvo").textContent = [url, pix && "PIX copia-e-cola"].filter(Boolean).join(" + ");
  mostrar("view-scan");
  $("submit").disabled = true;
  const laudos = [];
  const erros = [];
  try {
    const res = await fetch(`${API_BASE}/sitesecure/analisar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, pix: pix || undefined }),
    });
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
        if (!linhaTxt) continue;
        const ev = JSON.parse(linhaTxt);
        if (ev.etapa === "laudo") laudos.push(ev.laudo);
        else if (ev.etapa === "erro") erros.push(ev.erro);
        else marcarEtapa(ev.etapa, ev.status);
      }
    }
  } catch {
    erros.push("falha_rede");
  } finally {
    $("submit").disabled = false;
  }

  const mensagem = (e) => ERROS[e] || "Não foi possível concluir a análise. Verifique sua conexão e tente de novo.";
  if (laudos.length) {
    $("laudos").replaceChildren();
    for (const l of laudos) montarLaudo(l);
    // Com site + PIX, um pode falhar e o outro sair: o aviso diz qual faltou.
    const aviso = $("laudo-aviso");
    aviso.textContent = erros.length ? erros.map(mensagem).join(" ") : "";
    aviso.classList.toggle("hidden", !erros.length);
    mostrar("view-laudo");
    $("view-laudo").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  mostrar("view-form");
  erroForm(erros.map(mensagem).join(" ") || mensagem());
}

// Campo unico: link ou PIX. Todo BR Code comeca com "000201".
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

$("nova").addEventListener("click", () => {
  $("url-input").value = "";
  mostrar("view-form");
  window.scrollTo({ top: 0, behavior: "smooth" });
  $("url-input").focus();
});
