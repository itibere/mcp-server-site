/* Dashboard PNCP — SVG puro, sem dependências.
   Todos os agregados são calculados aqui a partir de `registros`, para que
   os filtros da página e os gráficos nunca discordem entre si. */

(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var dados = null;
  var estado = { periodo: 'tudo', modalidades: new Set(), busca: '', limite: 25 };
  var tip = null;

  /* ---------- formatação ---------- */

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

  var MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun',
               'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  function mesBR(ym) {
    var p = ym.split('-');
    return MESES[parseInt(p[1], 10) - 1] + '/' + p[0].slice(2);
  }

  function fimDeMes(iso) {
    var p = String(iso).split('-');
    if (p.length !== 3) return false;
    var ultimo = new Date(Date.UTC(+p[0], +p[1], 0)).getUTCDate();
    return +p[2] === ultimo;
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

  /* ---------- filtro ---------- */

  function registrosFiltrados() {
    var lista = dados.registros;

    if (estado.periodo !== 'tudo') {
      var dias = parseInt(estado.periodo, 10);
      var limite = new Date(dados.cobertura.fim + 'T12:00:00');
      limite.setDate(limite.getDate() - dias);
      var corte = limite.toISOString().slice(0, 10);
      lista = lista.filter(function (r) { return r.data >= corte; });
    }

    if (estado.modalidades.size) {
      lista = lista.filter(function (r) { return estado.modalidades.has(r.modalidade); });
    }

    return lista;
  }

  function agrupar(lista, chave) {
    var mapa = new Map();
    lista.forEach(function (r) {
      var k = r[chave];
      var atual = mapa.get(k) || { rot: k, n: 0, valor: 0 };
      atual.n += 1;
      atual.valor += r.valor || 0;
      mapa.set(k, atual);
    });
    return Array.from(mapa.values());
  }

  /* ---------- tooltip ---------- */

  function ligarTip(alvo, rotulo, linhas) {
    alvo.addEventListener('mouseenter', function () {
      tip.innerHTML = '<span class="t-rot">' + esc(rotulo) + '</span>' +
        linhas.map(function (l) { return '<span class="t-val">' + esc(l) + '</span>'; }).join('<br>');
      tip.setAttribute('data-on', '1');
    });
    alvo.addEventListener('mousemove', function (ev) {
      var x = ev.clientX + 14;
      var y = ev.clientY + 14;
      var r = tip.getBoundingClientRect();
      if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - 14;
      if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - 14;
      tip.style.left = Math.max(8, x) + 'px';
      tip.style.top = Math.max(8, y) + 'px';
    });
    alvo.addEventListener('mouseleave', function () {
      tip.setAttribute('data-on', '0');
    });
  }

  /* ---------- helpers svg ---------- */

  function svgEl(nome, attrs) {
    var el = document.createElementNS(NS, nome);
    for (var k in attrs) if (attrs[k] !== undefined) el.setAttribute(k, attrs[k]);
    return el;
  }

  function escalaTopo(max) {
    if (max <= 0) return 1;
    var pot = Math.pow(10, Math.floor(Math.log10(max)));
    var passos = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < passos.length; i++) {
      if (passos[i] * pot >= max) return passos[i] * pot;
    }
    return 10 * pot;
  }

  /* ---------- gráfico: barras horizontais ---------- */

  function barrasH(card, itens, opts) {
    var plot = card.querySelector('.plot');
    plot.textContent = '';
    if (!itens.length) { plot.innerHTML = '<p class="vazio">Sem dados no recorte atual.</p>'; return; }

    var largura = Math.max(340, plot.clientWidth || 640);
    var estreito = largura < 520;
    var rotuloW = estreito ? 132 : Math.min(300, Math.round(largura * 0.30));
    var valorW = 78;
    var alturaBarra = 15;
    var passo = 30;
    var topo = 6;
    var altura = topo + itens.length * passo + 4;

    var max = Math.max.apply(null, itens.map(function (d) { return d.valor; })) || 1;
    var faixaW = Math.max(60, largura - rotuloW - valorW - 8);

    var svg = svgEl('svg', {
      width: largura, height: altura,
      viewBox: '0 0 ' + largura + ' ' + altura,
      role: 'img', 'aria-label': opts.aria
    });

    itens.forEach(function (d, i) {
      var y = topo + i * passo;
      var w = Math.max(2, (d.valor / max) * faixaW);
      var g = svgEl('g', { class: 'g-barra' });

      var rot = svgEl('text', {
        x: rotuloW - 10, y: y + alturaBarra - 3, 'text-anchor': 'end', class: 'rotulo'
      });
      rot.textContent = cortar(d.rot, estreito ? 18 : Math.max(24, Math.floor(rotuloW / 6.6)));
      g.appendChild(rot);

      g.appendChild(svgEl('rect', {
        x: rotuloW, y: y, width: w, height: alturaBarra, rx: 4,
        fill: d.cor || 'var(--accent)', class: 'barra'
      }));

      var val = svgEl('text', {
        x: rotuloW + w + 9, y: y + alturaBarra - 3, class: 'valor-fim'
      });
      val.textContent = opts.formatoRotulo(d);
      g.appendChild(val);

      var alvo = svgEl('rect', {
        x: 0, y: y - 6, width: largura, height: passo, class: 'alvo'
      });
      g.appendChild(alvo);
      ligarTip(alvo, d.rot, opts.linhasTip(d));

      svg.appendChild(g);
    });

    plot.appendChild(svg);
    tabelaTwin(card, itens, opts);
  }

  /* ---------- gráfico: barras verticais ---------- */

  function barrasV(card, itens, opts) {
    var plot = card.querySelector('.plot');
    plot.textContent = '';
    if (!itens.length) { plot.innerHTML = '<p class="vazio">Sem dados no recorte atual.</p>'; return; }

    var largura = Math.max(340, plot.clientWidth || 640);
    var faixaAltura = 190;

    var max = Math.max.apply(null, itens.map(function (d) { return d.valor; })) || 1;
    var topoEscala = escalaTopo(max);

    // O eixo Y precisa caber o maior rótulo formatado, senão ele é cortado.
    var maiorRotuloY = Math.max.apply(null, [0, 0.5, 1].map(function (f) {
      return String(opts.formatoEixo(topoEscala * f)).length;
    }));
    var eixoW = Math.max(46, Math.round(maiorRotuloY * 6.6) + 14);

    // quantas linhas o rótulo do eixo X ocupa
    var linhasX = Math.max.apply(null, itens.map(function (d, i) {
      return String(opts.rotuloEixo(d, i)).split('\n').length;
    }));
    var altura = faixaAltura + 20 + linhasX * 14 + 6;
    var faixaW = Math.max(80, largura - eixoW - 12);
    var passo = faixaW / itens.length;
    var barraW = Math.min(54, Math.max(10, passo - 14));

    var svg = svgEl('svg', {
      width: largura, height: altura,
      viewBox: '0 0 ' + largura + ' ' + altura,
      role: 'img', 'aria-label': opts.aria
    });

    [0, 0.5, 1].forEach(function (f) {
      var y = 8 + faixaAltura - f * faixaAltura;
      svg.appendChild(svgEl('line', {
        x1: eixoW, y1: y, x2: largura - 6, y2: y,
        class: f === 0 ? 'linha-base' : 'linha-grade'
      }));
      var t = svgEl('text', { x: eixoW - 9, y: y + 4, 'text-anchor': 'end', class: 'eixo' });
      t.textContent = opts.formatoEixo(topoEscala * f);
      svg.appendChild(t);
    });

    itens.forEach(function (d, i) {
      var h = Math.max(2, (d.valor / topoEscala) * faixaAltura);
      var x = eixoW + i * passo + (passo - barraW) / 2;
      var y = 8 + faixaAltura - h;
      var g = svgEl('g', { class: 'g-barra' });

      g.appendChild(svgEl('rect', {
        x: x, y: y, width: barraW, height: h, rx: 4,
        fill: d.cor || 'var(--accent)',
        'fill-opacity': d.parcial ? 0.45 : 1,
        class: 'barra'
      }));

      var linhas = String(opts.rotuloEixo(d, i)).split('\n');
      linhas.forEach(function (linha, j) {
        var t = svgEl('text', {
          x: eixoW + i * passo + passo / 2,
          y: 8 + faixaAltura + 17 + j * 13,
          'text-anchor': 'middle', class: 'eixo'
        });
        t.textContent = linha;
        svg.appendChild(t);
      });

      var alvo = svgEl('rect', {
        x: eixoW + i * passo, y: 0, width: passo, height: faixaAltura + 12, class: 'alvo'
      });
      g.appendChild(alvo);
      ligarTip(alvo, d.rot, opts.linhasTip(d));

      svg.appendChild(g);
    });

    plot.appendChild(svg);
    tabelaTwin(card, itens, opts);
  }

  /* ---------- tabela equivalente (acessibilidade) ---------- */

  function tabelaTwin(card, itens, opts) {
    var alvo = card.querySelector('.tabela-twin');
    if (!alvo) return;
    var linhas = itens.map(function (d) {
      return '<tr><td>' + esc(d.rot) + (d.parcial ? ' <span class="origem">parcial</span>' : '') +
        '</td><td class="num">' + inteiro(d.n) + '</td><td class="num">' + moeda(d.valor) + '</td></tr>';
    }).join('');
    alvo.innerHTML =
      '<div class="tabela-scroll"><table><thead><tr>' +
      '<th>' + esc(opts.colRotulo) + '</th>' +
      '<th class="num">Contratações</th><th class="num">Valor</th>' +
      '</tr></thead><tbody>' + linhas + '</tbody></table></div>';
  }

  /* ---------- render ---------- */

  function renderTiles(lista) {
    var total = lista.reduce(function (s, r) { return s + (r.valor || 0); }, 0);
    var comValor = lista.filter(function (r) { return r.valor > 0; })
                        .map(function (r) { return r.valor; })
                        .sort(function (a, b) { return a - b; });
    var mediana = 0;
    if (comValor.length) {
      var m = Math.floor(comValor.length / 2);
      mediana = comValor.length % 2 ? comValor[m] : (comValor[m - 1] + comValor[m]) / 2;
    }
    var orgaos = new Set(lista.map(function (r) { return r.orgao; })).size;
    var semValor = lista.length - comValor.length;

    document.getElementById('t-contratacoes').textContent = inteiro(lista.length);
    document.getElementById('t-valor').textContent = moedaCurta(total);
    document.getElementById('t-valor-sub').textContent =
      semValor ? inteiro(semValor) + ' sem valor estimado informado' : 'todas com valor informado';
    document.getElementById('t-mediana').textContent = moedaCurta(mediana);
    document.getElementById('t-orgaos').textContent = inteiro(orgaos);
  }

  function renderOrgaos(lista) {
    var itens = agrupar(lista, 'orgao').sort(function (a, b) { return b.valor - a.valor; });
    var topo = itens.slice(0, 10);
    var resto = itens.slice(10);
    if (resto.length) {
      topo.push({
        rot: 'Outros (' + resto.length + ' órgãos)',
        n: resto.reduce(function (s, d) { return s + d.n; }, 0),
        valor: resto.reduce(function (s, d) { return s + d.valor; }, 0),
        cor: 'var(--neutro)'
      });
    }
    barrasH(document.getElementById('g-orgaos'), topo, {
      aria: 'Valor contratado por órgão',
      colRotulo: 'Órgão',
      formatoRotulo: function (d) { return moedaCurta(d.valor); },
      linhasTip: function (d) {
        return [moeda(d.valor), inteiro(d.n) + (d.n === 1 ? ' contratação' : ' contratações')];
      }
    });
  }

  // rótulo curto para o eixo | rótulo completo para tabela e tooltip
  var FAIXAS = [
    ['até\n50 mil', 'Até R$ 50 mil', 0, 5e4, 'var(--ord-1)'],
    ['50–250\nmil', 'R$ 50 mil a 250 mil', 5e4, 2.5e5, 'var(--ord-2)'],
    ['250 mil\na 1 mi', 'R$ 250 mil a 1 milhão', 2.5e5, 1e6, 'var(--ord-3)'],
    ['1 mi\na 5 mi', 'R$ 1 milhão a 5 milhões', 1e6, 5e6, 'var(--ord-4)'],
    ['acima\nde 5 mi', 'Acima de R$ 5 milhões', 5e6, Infinity, 'var(--ord-5)']
  ];

  function renderFaixas(lista) {
    var itens = FAIXAS.map(function (f) {
      return { curto: f[0], rot: f[1], n: 0, valor: 0, cor: f[4], _min: f[2], _max: f[3] };
    });
    var sem = { curto: 'sem\nvalor', rot: 'Sem valor informado', n: 0, valor: 0, cor: 'var(--neutro)' };

    lista.forEach(function (r) {
      var v = r.valor || 0;
      if (v <= 0) { sem.n += 1; return; }
      for (var i = 0; i < itens.length; i++) {
        if (v >= itens[i]._min && v < itens[i]._max) { itens[i].n += 1; itens[i].valor += v; return; }
      }
    });
    if (sem.n) itens.push(sem);

    // O eixo aqui conta CONTRATAÇÕES; o valor somado vai no tooltip e na tabela.
    var paraGrafico = itens.map(function (d) {
      return { curto: d.curto, rot: d.rot, n: d.n, valor: d.n, _valorReal: d.valor, cor: d.cor };
    });

    barrasV(document.getElementById('g-faixas'), paraGrafico, {
      aria: 'Número de contratações por faixa de valor',
      colRotulo: 'Faixa de valor',
      formatoEixo: function (v) { return inteiro(Math.round(v)); },
      rotuloEixo: function (d) { return d.curto; },
      linhasTip: function (d) {
        return [inteiro(d.n) + (d.n === 1 ? ' contratação' : ' contratações'),
                d._valorReal > 0 ? 'Somam ' + moeda(d._valorReal) : 'Sem valor estimado informado'];
      }
    });

    // a tabela equivalente recebe contagem e valor reais
    tabelaTwin(document.getElementById('g-faixas'), itens.map(function (d) {
      return { rot: d.rot, n: d.n, valor: d.valor };
    }), { colRotulo: 'Faixa de valor' });
  }

  function renderMeses(lista) {
    var mapa = new Map();
    lista.forEach(function (r) {
      var ym = r.data.slice(0, 7);
      var atual = mapa.get(ym) || { rot: ym, n: 0, valor: 0 };
      atual.n += 1;
      atual.valor += r.valor || 0;
      mapa.set(ym, atual);
    });
    var chaves = Array.from(mapa.keys()).sort();
    // Mês parcial = mês cortado pela borda do recorte, logo não comparável
    // aos demais. A borda é a data real mais antiga/recente em tela.
    var datas = lista.map(function (r) { return r.data; }).sort();
    var primeira = datas[0] || '';
    var ultima = datas[datas.length - 1] || '';
    var itens = chaves.map(function (k) {
      var d = mapa.get(k);
      var parcial = (k === primeira.slice(0, 7) && !/-0?1$/.test(primeira)) ||
                    (k === ultima.slice(0, 7) && !fimDeMes(ultima));
      return { rot: mesBR(k), n: d.n, valor: d.valor, parcial: parcial };
    });

    barrasV(document.getElementById('g-meses'), itens, {
      aria: 'Valor contratado por mês de publicação',
      colRotulo: 'Mês',
      formatoEixo: function (v) { return moedaCurta(v); },
      rotuloEixo: function (d) { return d.rot; },
      linhasTip: function (d) {
        return [moeda(d.valor),
                inteiro(d.n) + (d.n === 1 ? ' contratação' : ' contratações'),
                d.parcial ? 'Mês parcial — recortado pela janela' : ''].filter(Boolean);
      }
    });
  }

  function renderLista(lista) {
    var termo = estado.busca.trim().toLowerCase();
    var filtrada = termo
      ? lista.filter(function (r) {
          return (r.objeto + ' ' + r.orgao).toLowerCase().indexOf(termo) !== -1;
        })
      : lista;

    var corpo = document.getElementById('corpo-lista');
    var conta = document.getElementById('conta-lista');
    var btn = document.getElementById('btn-mais');

    conta.textContent = filtrada.length
      ? inteiro(filtrada.length) + (filtrada.length === 1 ? ' contratação' : ' contratações')
      : 'nenhuma contratação';

    if (!filtrada.length) {
      corpo.innerHTML = '<tr><td colspan="5" class="vazio">Nada encontrado com os filtros atuais.</td></tr>';
      btn.style.display = 'none';
      return;
    }

    var visiveis = filtrada.slice(0, estado.limite);
    corpo.innerHTML = visiveis.map(function (r) {
      var obj = r.link
        ? '<a href="' + esc(r.link) + '" target="_blank" rel="noopener noreferrer">' + esc(r.objeto) + '</a>'
        : esc(r.objeto);
      return '<tr>' +
        '<td class="num">' + dataBR(r.data) + '</td>' +
        '<td class="orgao-cel">' + esc(cortar(r.orgao, 42)) + '</td>' +
        '<td class="objeto">' + obj + ' <span class="origem">' + esc(r.origem || '—') + '</span></td>' +
        '<td>' + esc(r.modalidade) + '</td>' +
        '<td class="num">' + (r.valor > 0 ? moeda(r.valor) : '—') + '</td>' +
        '</tr>';
    }).join('');

    if (filtrada.length > visiveis.length) {
      btn.style.display = 'block';
      btn.textContent = 'Mostrar mais ' +
        Math.min(25, filtrada.length - visiveis.length) + ' de ' +
        inteiro(filtrada.length - visiveis.length) + ' restantes';
    } else {
      btn.style.display = 'none';
    }
  }

  function renderChips() {
    var caixa = document.getElementById('chips-modalidade');
    var todas = agrupar(dados.registros, 'modalidade')
      .sort(function (a, b) { return b.n - a.n; });

    caixa.innerHTML = todas.map(function (d) {
      var on = estado.modalidades.has(d.rot);
      return '<button class="chip" type="button" data-mod="' + esc(d.rot) + '" ' +
        'aria-pressed="' + on + '">' + esc(d.rot) +
        '<span class="n">' + inteiro(d.n) + '</span></button>';
    }).join('');

    caixa.querySelectorAll('.chip').forEach(function (b) {
      b.addEventListener('click', function () {
        var m = b.getAttribute('data-mod');
        if (estado.modalidades.has(m)) estado.modalidades.delete(m);
        else estado.modalidades.add(m);
        estado.limite = 25;
        renderChips();
        renderTudo();
      });
    });
  }

  function renderTudo() {
    var lista = registrosFiltrados();
    renderTiles(lista);
    renderOrgaos(lista);
    renderFaixas(lista);
    renderMeses(lista);
    renderLista(lista);
  }

  /* ---------- procedência e avisos ---------- */

  function renderCabecalho() {
    var c = dados.cobertura || {};
    document.getElementById('p-janela').textContent =
      (c.inicio ? dataBR(c.inicio) : '—') + ' a ' + (c.fim ? dataBR(c.fim) : '—');
    document.getElementById('p-escopo').textContent =
      (c.esfera || '—') + ' · ' + ((c.ufs || []).join(', ') || '—');
    document.getElementById('p-criterio').textContent = c.criterio_tic || '—';
    document.getElementById('p-leitura').textContent =
      dados.gerado_em ? dataBR(dados.gerado_em.slice(0, 10)) : '—';

    if (dados.exemplo) document.getElementById('aviso-exemplo').style.display = 'flex';
  }

  /* ---------- início ---------- */

  function ligarControles() {
    document.querySelectorAll('[data-periodo]').forEach(function (b) {
      b.addEventListener('click', function () {
        estado.periodo = b.getAttribute('data-periodo');
        estado.limite = 25;
        document.querySelectorAll('[data-periodo]').forEach(function (o) {
          o.setAttribute('aria-pressed', String(o === b));
        });
        renderTudo();
      });
    });

    var busca = document.getElementById('busca');
    busca.addEventListener('input', function () {
      estado.busca = busca.value;
      estado.limite = 25;
      renderLista(registrosFiltrados());
    });

    document.getElementById('btn-mais').addEventListener('click', function () {
      estado.limite += 25;
      renderLista(registrosFiltrados());
    });

    document.querySelectorAll('.btn-tabela').forEach(function (b) {
      b.addEventListener('click', function () {
        var card = b.closest('.grafico');
        var tabela = card.getAttribute('data-vista') === 'tabela';
        card.setAttribute('data-vista', tabela ? 'grafico' : 'tabela');
        b.textContent = tabela ? 'Ver tabela' : 'Ver gráfico';
      });
    });

    var t;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(function () {
        var lista = registrosFiltrados();
        renderOrgaos(lista); renderFaixas(lista); renderMeses(lista);
      }, 180);
    });
  }

  function iniciar() {
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('data-on', '0');
    document.body.appendChild(tip);

    fetch('dados.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (json) {
        dados = json;
        if (!dados.registros || !dados.registros.length) throw new Error('sem registros');
        document.getElementById('conteudo').style.display = '';
        document.getElementById('carregando').style.display = 'none';
        renderCabecalho();
        renderChips();
        ligarControles();
        renderTudo();
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
