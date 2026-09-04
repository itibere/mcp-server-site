/* Painel de contratos de TIC vencendo — visual proprio (assets/vencendo.css),
   deliberadamente distinto do Cyber Console do resto do site. O eixo aqui e
   a data de VIGENCIA FINAL, nao a de publicacao, e os dados ja vieram
   filtrados pelo agente julgador (ver julgamentoAgente no dados.json). */
(function () {
  'use strict';

  var dados = null;
  var estado = { soServico: false, busca: '', limite: 40 };

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

  function listaFiltrada() {
    var lista = dados.contratos;
    if (estado.soServico) lista = lista.filter(function (r) { return r.servico; });
    var termo = estado.busca.trim().toLowerCase();
    if (termo) {
      lista = lista.filter(function (r) {
        return (r.objeto + ' ' + r.orgao).toLowerCase().indexOf(termo) !== -1;
      });
    }
    return lista;
  }

  function renderCabecalho() {
    var c = dados.cobertura || {};
    var janelaMeses = (c.mesesJanelaInicio != null && c.mesesJanelaFim != null)
      ? c.mesesJanelaInicio + ' a ' + c.mesesJanelaFim + ' meses' : '—';
    document.getElementById('lede-janela').textContent = janelaMeses;

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
      var estado = dias <= 18 ? 'v-fresh' : 'v-stale';
      badge.textContent = texto;
      badge.className = 'v-badge-atualizacao v-visivel ' + estado;
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

  function ligarControles() {
    var chipServico = document.getElementById('chip-servico');
    chipServico.addEventListener('click', function () {
      estado.soServico = !estado.soServico;
      estado.limite = 40;
      chipServico.setAttribute('aria-pressed', String(estado.soServico));
      renderLista();
    });

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
  }

  function iniciar() {
    fetch('dados.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (json) {
        dados = json;
        if (!dados.contratos || !dados.contratos.length) throw new Error('sem registros');
        document.getElementById('conteudo').style.display = '';
        document.getElementById('carregando').style.display = 'none';
        renderCabecalho();
        ligarControles();
        renderLista();
        renderJulgador();
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
