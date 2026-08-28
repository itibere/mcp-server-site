/* Painel de contratos de TIC vencendo — reaproveita os tokens/componentes
   de dashboard.css, mas com regras de estado próprias: aqui o eixo é a
   data de VIGÊNCIA FINAL, não a data de publicação. */
(function () {
  'use strict';

  var dados = null;
  var estado = { soServico: false, busca: '', limite: 30 };

  var nfInt = new Intl.NumberFormat('pt-BR');
  var nfMoeda = new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency: 'BRL', maximumFractionDigits: 0
  });

  function moeda(v) { return nfMoeda.format(Math.round(v)); }
  function moedaCurta(v) {
    if (v >= 1e9) return 'R$ ' + (v / 1e9).toFixed(1).replace('.', ',') + ' bi';
    if (v >= 1e6) return 'R$ ' + (v / 1e6).toFixed(1).replace('.', ',') + ' mi';
    if (v >= 1e3) return 'R$ ' + Math.round(v / 1e3) + ' mil';
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
  function cortar(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
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
    document.getElementById('p-uf').textContent = c.uf || '—';
    document.getElementById('p-esfera').textContent = c.esfera || '—';
    document.getElementById('p-criterio').textContent = c.criterioTIC || '—';
    document.getElementById('p-janela').textContent = c.janelaVencimento
      ? c.janelaVencimento.split(' a ').map(dataBR).join(' a ')
      : '—';
    document.getElementById('p-leitura').textContent =
      dados.geradoEm ? dataBR(dados.geradoEm.slice(0, 10)) : '—';
  }

  function renderTiles(lista) {
    var total = lista.reduce(function (s, r) { return s + (r.valor || 0); }, 0);
    var servicos = lista.filter(function (r) { return r.servico; }).length;
    var orgaos = new Set(lista.map(function (r) { return r.orgao; })).size;

    document.getElementById('t-total').textContent = inteiro(lista.length);
    document.getElementById('t-valor').textContent = moedaCurta(total);
    document.getElementById('t-servicos').textContent = inteiro(servicos);
    document.getElementById('t-orgaos').textContent = inteiro(orgaos);
  }

  function renderLista() {
    var filtrada = listaFiltrada();
    var corpo = document.getElementById('corpo-lista');
    var conta = document.getElementById('conta-lista');
    var btn = document.getElementById('btn-mais');

    conta.textContent = filtrada.length
      ? inteiro(filtrada.length) + (filtrada.length === 1 ? ' contrato' : ' contratos')
      : 'nenhum contrato';

    if (!filtrada.length) {
      corpo.innerHTML = '<tr><td colspan="5" class="vazio">Nada encontrado com os filtros atuais.</td></tr>';
      btn.style.display = 'none';
      renderTiles(filtrada);
      return;
    }

    var visiveis = filtrada.slice(0, estado.limite);
    corpo.innerHTML = visiveis.map(function (r) {
      var d = diasAte(r.venceEm);
      var urgencia = d <= 30 ? ' style="color:var(--warn);font-weight:620"' : '';
      var obj = r.link
        ? '<a href="' + esc(r.link) + '" target="_blank" rel="noopener noreferrer">' + esc(r.objeto) + '</a>'
        : esc(r.objeto);
      return '<tr>' +
        '<td class="num"' + urgencia + '>' + dataBR(r.venceEm) +
          '<br><span class="origem" title="dias até o vencimento">' + d + ' dias</span></td>' +
        '<td class="orgao-cel">' + esc(cortar(r.orgao, 42)) + '</td>' +
        '<td class="objeto">' + obj + ' ' +
          (r.servico ? '<span class="origem">serviço</span>' : '') + '</td>' +
        '<td>' + esc(r.modalidade || '—') + '</td>' +
        '<td class="num">' + (r.valor > 0 ? moeda(r.valor) : '—') + '</td>' +
        '</tr>';
    }).join('');

    if (filtrada.length > visiveis.length) {
      btn.style.display = 'block';
      btn.textContent = 'Mostrar mais ' +
        Math.min(30, filtrada.length - visiveis.length) + ' de ' +
        inteiro(filtrada.length - visiveis.length) + ' restantes';
    } else {
      btn.style.display = 'none';
    }

    renderTiles(filtrada);
  }

  function ligarControles() {
    var chipServico = document.getElementById('chip-servico');
    chipServico.addEventListener('click', function () {
      estado.soServico = !estado.soServico;
      estado.limite = 30;
      chipServico.setAttribute('aria-pressed', String(estado.soServico));
      renderLista();
    });

    var busca = document.getElementById('busca');
    busca.addEventListener('input', function () {
      estado.busca = busca.value;
      estado.limite = 30;
      renderLista();
    });

    document.getElementById('btn-mais').addEventListener('click', function () {
      estado.limite += 30;
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
      })
      .catch(function (e) {
        document.getElementById('carregando').innerHTML =
          '<p class="vazio">Não foi possível carregar os dados (' + esc(e.message) + ').</p>';
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
