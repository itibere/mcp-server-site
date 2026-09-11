/* Painel de contratos de TIC vencendo — visual proprio (assets/vencendo.css),
   deliberadamente distinto do Cyber Console do resto do site. O eixo aqui e
   a data de VIGENCIA FINAL, nao a de publicacao, e os dados ja vieram
   filtrados pelo agente julgador (ver julgamentoAgente no dados.json).

   Multi-escopo: a pagina descobre os escopos disponiveis (esfera + UF) via
   escopos.json e monta abas por esfera (Federal/Estadual/Municipal) e,
   dentro da esfera ativa, sub-abas por UF. Trocar de aba/UF refaz o fetch
   do dados_<esfera>_<uf>.json daquele escopo e re-renderiza tudo — a logica
   de filtro/busca/paginacao abaixo e a mesma pra qualquer escopo. */
(function () {
  'use strict';

  var ESFERAS_ORDEM = [
    { code: 'F', nome: 'Federal' },
    { code: 'E', nome: 'Estadual' },
    { code: 'M', nome: 'Municipal' }
  ];

  var manifesto = null;
  var esferaAtiva = null;
  var escopoAtual = null;

  var dados = null;
  var estado = { tipo: '', busca: '', limite: 40, orgao: '', vencimento: '', valor: '' };

  var nfInt = new Intl.NumberFormat('pt-BR');
  var nfMoeda = new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2
  });

  function moeda(v) { return nfMoeda.format(v); }
  function moedaCurta(v) {
    if (v >= 1e9) return 'R$ ' + (v / 1e9).toFixed(1).replace('.', ',') + ' bi';
    if (v >= 1e6) return 'R$ ' + (v / 1e6).toFixed(1).replace('.', ',') + ' mi';
    if (v >= 1e3) return 'R$ ' + (v / 1e3).toFixed(1).replace('.', ',') + ' mil';
    return moeda(v);
  }
  function inteiro(v) { return nfInt.format(v); }
  function dataBR(iso) {
    var p = String(iso).split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function diasAte(iso) {
    var hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    var alvo = new Date(iso + 'T00:00:00');
    return Math.round((alvo - hoje) / 86400000);
  }

  function bandaVencimento(dias, banda) {
    if (banda === '6-8') return dias >= 180 && dias < 240;
    if (banda === '8-10') return dias >= 240 && dias < 300;
    if (banda === '10-12') return dias >= 300;
    return true;
  }
  function bandaValor(valor, banda) {
    if (!banda) return true;
    var partes = banda.split('-');
    var min = Number(partes[0]);
    var max = partes[1] ? Number(partes[1]) : Infinity;
    return valor >= min && valor < max;
  }

  function listaFiltrada() {
    var lista = dados.contratos;
    if (estado.tipo === 'servico') lista = lista.filter(function (r) { return r.servico; });
    if (estado.tipo === 'hardware') lista = lista.filter(function (r) { return !r.servico; });
    if (estado.orgao) lista = lista.filter(function (r) { return r.orgao === estado.orgao; });
    if (estado.vencimento) lista = lista.filter(function (r) { return bandaVencimento(diasAte(r.venceEm), estado.vencimento); });
    if (estado.valor) lista = lista.filter(function (r) { return bandaValor(r.valor || 0, estado.valor); });
    var termo = estado.busca.trim().toLowerCase();
    if (termo) {
      lista = lista.filter(function (r) {
        return (r.objeto + ' ' + r.orgao).toLowerCase().indexOf(termo) !== -1;
      });
    }
    return lista;
  }

  function popularFiltroOrgao() {
    var orgaos = Array.from(new Set(dados.contratos.map(function (r) { return r.orgao; })))
      .sort(function (a, b) { return a.localeCompare(b, 'pt-BR'); });
    var sel = document.getElementById('filtro-orgao');
    sel.innerHTML = '<option value="">Todos os órgãos</option>';
    orgaos.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      sel.appendChild(opt);
    });
  }

  function renderCabecalho() {
    var c = dados.cobertura || {};
    var janelaMeses = (c.mesesJanelaInicio != null && c.mesesJanelaFim != null)
      ? c.mesesJanelaInicio + ' a ' + c.mesesJanelaFim + ' meses' : '—';
    document.getElementById('lede-janela').textContent = janelaMeses;

    var lede = document.getElementById('lede-escopo');
    if (lede) {
      var esferaTxt = c.esfera ? c.esfera.toLowerCase() : '';
      lede.textContent = esferaTxt ? (esferaTxt + ', em ' + (c.uf || '—') + ',') : '';
    }

    document.getElementById('proc').innerHTML = [
      ['UF', c.uf], ['Esfera', c.esfera], ['Critério TIC', c.criterioTIC],
      ['Janela (datas)', (c.janelaVencimento || '').split(' a ').map(dataBR).join(' a ')],
      ['Leitura', dados.geradoEm ? dataBR(dados.geradoEm.slice(0, 10)) : '—']
    ].map(function (p) {
      return '<div><dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1] || '—') + '</dd></div>';
    }).join('');
    document.getElementById('foot-data').textContent = dados.geradoEm ? dataBR(dados.geradoEm.slice(0, 10)) : '—';

    var badge = document.getElementById('badge-atualizacao');
    if (badge && dados.geradoEm) {
      var dias = Math.floor((Date.now() - new Date(dados.geradoEm)) / 86400000);
      var texto = dias <= 0 ? 'atualizado hoje' : dias === 1 ? 'atualizado há 1 dia' : 'atualizado há ' + dias + ' dias';
      // varredura roda a cada 15 dias; folga de alguns dias antes de marcar como atrasado
      var estadoBadge = dias <= 18 ? 'v-fresh' : 'v-stale';
      badge.textContent = texto;
      badge.className = 'v-badge-atualizacao v-visivel ' + estadoBadge;
    }
  }

  function renderTiles(lista) {
    var total = lista.reduce(function (s, r) { return s + (r.valor || 0); }, 0);
    var servicos = lista.filter(function (r) { return r.servico; }).length;
    var orgaos = new Set(lista.map(function (r) { return r.orgao; })).size;
    document.getElementById('tiles').innerHTML =
      '<div class="v-stat"><p class="v-stat-num v-accent">' + inteiro(lista.length) + '</p><p class="v-stat-lbl">contratos na janela</p></div>' +
      '<div class="v-stat"><p class="v-stat-num">' + moedaCurta(total) + '</p><p class="v-stat-lbl">valor global somado</p></div>' +
      '<div class="v-stat"><p class="v-stat-num">' + inteiro(servicos) + '</p><p class="v-stat-lbl">classificados como serviço</p></div>' +
      '<div class="v-stat"><p class="v-stat-num">' + inteiro(orgaos) + '</p><p class="v-stat-lbl">órgãos distintos</p></div>';
  }

  function renderLista() {
    var filtrada = listaFiltrada();
    document.getElementById('conta-lista').textContent = inteiro(filtrada.length);

    var corpo = document.getElementById('corpo');
    var btn = document.getElementById('btn-mais');

    if (!filtrada.length) {
      corpo.innerHTML = '<tr><td colspan="5" class="v-vazio">Nada encontrado com os filtros atuais.</td></tr>';
      btn.style.display = 'none';
      renderTiles(filtrada);
      return;
    }

    var visiveis = filtrada.slice(0, estado.limite);
    corpo.innerHTML = visiveis.map(function (r) {
      var d = diasAte(r.venceEm);
      var diasClasse = d <= 270 ? 'v-dias-perto' : 'v-dias-longe';
      return '<tr>' +
        '<td class="v-orgao-cel">' + esc(r.orgao) + (r.servico ? '<br><span class="v-pill v-pill-servico">serviço</span>' : '') + '</td>' +
        '<td class="num">' + dataBR(r.venceEm) + '<br><span class="v-dias-badge ' + diasClasse + '">' + d + ' dias</span></td>' +
        '<td class="num">' + (r.valor > 0 ? moeda(r.valor) : '—') + '</td>' +
        '<td class="v-objeto">' + esc(r.objeto) + '</td>' +
        '<td>' + (r.link ? '<a class="v-link-pncp" href="' + esc(r.link) + '" target="_blank" rel="noopener noreferrer">Ver contrato →</a>' : '—') + '</td>' +
        '</tr>';
    }).join('');

    if (filtrada.length > visiveis.length) {
      btn.style.display = 'block';
      btn.textContent = 'Mostrar mais ' +
        Math.min(40, filtrada.length - visiveis.length) + ' de ' +
        inteiro(filtrada.length - visiveis.length) + ' restantes';
    } else {
      btn.style.display = 'none';
    }

    renderTiles(filtrada);
  }

  function renderJulgador() {
    var j = dados.julgamentoAgente;
    var alvo = document.getElementById('quadro-julgador');
    if (!j) { alvo.style.display = 'none'; return; }
    alvo.style.display = '';

    var taxa = Math.round(j.reprovados / j.total_antes * 100);
    document.getElementById('jul-antes').textContent = inteiro(j.total_antes);
    document.getElementById('jul-aprovados').textContent = inteiro(j.aprovados);
    document.getElementById('jul-reprovados').textContent = inteiro(j.reprovados);
    document.getElementById('jul-taxa').textContent = taxa + '%';

    var exemplos = (j.exemplosReprovados || []).slice(0, 10);
    document.getElementById('jul-exemplos').innerHTML = exemplos.map(function (e) {
      return '<li><span class="v-jul-orgao">' + esc(e.orgao) + '</span>' +
        '<span class="v-jul-motivo">' + esc(e.motivo) + '</span></li>';
    }).join('');
  }

  function resetEstadoEControles() {
    estado = { tipo: '', busca: '', limite: 40, orgao: '', vencimento: '', valor: '' };
    var chipServico = document.getElementById('chip-servico');
    var chipHardware = document.getElementById('chip-hardware');
    var busca = document.getElementById('busca');
    chipServico.setAttribute('aria-pressed', 'false');
    chipHardware.setAttribute('aria-pressed', 'false');
    busca.value = '';
    ['filtro-orgao', 'filtro-vencimento', 'filtro-valor'].forEach(function (id) {
      var sel = document.getElementById(id);
      sel.value = '';
      sel.classList.remove('v-select-ativo');
    });
  }

  function ligarControles() {
    var chipServico = document.getElementById('chip-servico');
    var chipHardware = document.getElementById('chip-hardware');

    function selecionarTipo(tipo) {
      estado.tipo = estado.tipo === tipo ? '' : tipo;
      estado.limite = 40;
      chipServico.setAttribute('aria-pressed', String(estado.tipo === 'servico'));
      chipHardware.setAttribute('aria-pressed', String(estado.tipo === 'hardware'));
      renderLista();
    }
    chipServico.addEventListener('click', function () { selecionarTipo('servico'); });
    chipHardware.addEventListener('click', function () { selecionarTipo('hardware'); });

    var busca = document.getElementById('busca');
    busca.addEventListener('input', function () {
      estado.busca = busca.value;
      estado.limite = 40;
      renderLista();
    });

    document.getElementById('btn-mais').addEventListener('click', function () {
      estado.limite += 40;
      renderLista();
    });

    var selOrgao = document.getElementById('filtro-orgao');
    var selVencimento = document.getElementById('filtro-vencimento');
    var selValor = document.getElementById('filtro-valor');

    function ligarSelectFiltro(sel, chave) {
      sel.addEventListener('change', function () {
        estado[chave] = sel.value;
        estado.limite = 40;
        sel.classList.toggle('v-select-ativo', !!sel.value);
        renderLista();
      });
    }
    ligarSelectFiltro(selOrgao, 'orgao');
    ligarSelectFiltro(selVencimento, 'vencimento');
    ligarSelectFiltro(selValor, 'valor');

    document.getElementById('btn-limpar-filtros').addEventListener('click', function () {
      resetEstadoEControles();
      renderLista();
    });
  }

  // ---- multi-escopo: abas de esfera + sub-abas de UF ----

  function escoposDaEsfera(code) {
    return (manifesto.escopos || []).filter(function (e) { return e.esferaCode === code; });
  }

  function renderAbasEsfera() {
    var alvo = document.getElementById('escopo-tabs');
    alvo.innerHTML = ESFERAS_ORDEM.map(function (esf) {
      var disponivel = escoposDaEsfera(esf.code).length > 0;
      var ativo = esf.code === esferaAtiva;
      var classes = 'v-esfera-tab' + (ativo ? ' v-esfera-tab-ativa' : '') + (!disponivel ? ' v-esfera-tab-em-breve' : '');
      return '<button type="button" class="' + classes + '" data-esfera="' + esf.code + '"' +
        (disponivel ? '' : ' disabled title="Em breve"') +
        ' role="tab" aria-selected="' + ativo + '">' + esc(esf.nome) +
        (disponivel ? '' : ' <span class="v-esfera-tab-badge">em breve</span>') +
        '</button>';
    }).join('');

    Array.from(alvo.querySelectorAll('button[data-esfera]:not([disabled])')).forEach(function (btn) {
      btn.addEventListener('click', function () { selecionarEsfera(btn.getAttribute('data-esfera')); });
    });
  }

  function renderSubabasUf() {
    var alvo = document.getElementById('escopo-subtabs');
    var escopos = escoposDaEsfera(esferaAtiva);
    alvo.innerHTML = escopos.map(function (e) {
      var ativo = escopoAtual && escopoAtual.uf === e.uf && escopoAtual.esferaCode === e.esferaCode;
      return '<button type="button" class="v-uf-tab' + (ativo ? ' v-uf-tab-ativa' : '') + '" data-uf="' + esc(e.uf) + '" role="tab" aria-selected="' + ativo + '">' +
        esc(e.ufNome || e.uf) + '</button>';
    }).join('');
    alvo.style.display = escopos.length ? '' : 'none';

    Array.from(alvo.querySelectorAll('button[data-uf]')).forEach(function (btn) {
      btn.addEventListener('click', function () { selecionarUf(btn.getAttribute('data-uf')); });
    });
  }

  function selecionarEsfera(code) {
    if (esferaAtiva === code) return;
    esferaAtiva = code;
    var escopos = escoposDaEsfera(code);
    renderAbasEsfera();
    renderSubabasUf();
    if (escopos.length) carregarEscopo(escopos[0]);
  }

  function selecionarUf(uf) {
    var escopo = escoposDaEsfera(esferaAtiva).filter(function (e) { return e.uf === uf; })[0];
    if (!escopo || escopo === escopoAtual) return;
    renderSubabasUf();
    carregarEscopo(escopo);
  }

  function carregarEscopo(escopo) {
    document.getElementById('carregando').style.display = '';
    document.getElementById('conteudo').style.display = 'none';
    fetch(escopo.arquivo, { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (json) {
        escopoAtual = escopo;
        dados = json;
        resetEstadoEControles();
        document.getElementById('conteudo').style.display = '';
        document.getElementById('carregando').style.display = 'none';
        renderAbasEsfera();
        renderSubabasUf();
        renderCabecalho();
        popularFiltroOrgao();
        renderLista();
        renderJulgador();
      })
      .catch(function (e) {
        document.getElementById('carregando').innerHTML =
          '<p class="v-vazio">Não foi possível carregar os dados (' + esc(e.message) + ').</p>';
      });
  }

  function iniciar() {
    fetch('escopos.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (json) {
        manifesto = json;
        if (!manifesto.escopos || !manifesto.escopos.length) throw new Error('nenhum escopo publicado');

        ligarControles();

        var primeiraEsfera = ESFERAS_ORDEM.filter(function (esf) { return escoposDaEsfera(esf.code).length; })[0];
        if (!primeiraEsfera) throw new Error('nenhum escopo publicado');
        esferaAtiva = primeiraEsfera.code;
        renderAbasEsfera();
        renderSubabasUf();
        carregarEscopo(escoposDaEsfera(esferaAtiva)[0]);
      })
      .catch(function (e) {
        document.getElementById('carregando').innerHTML =
          '<p class="v-vazio">Não foi possível carregar os dados (' + esc(e.message) + ').</p>';
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
