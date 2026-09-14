/* global d3, MapaBrasil */
/**
 * Aplicacao do Mapa Comercial Fiber.
 * Hierarquia: BRASIL -> ESTADO -> CIDADE -> CLIENTES -> PRODUTOS COMPRADOS.
 * Todos os agregados vem do backend e respeitam os mesmos filtros.
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ estado
  const st = {
    filtros: { rep: [], cliente: [], meses: [], uf: [], tipo: [] },
    metrica: 'valor',
    view: 'dashboard',
    nivel: { uf: null, municipio: null, cidade: null, cliente: null, clienteNome: null },
    ordemRanking: 'desc',
    ordemProdutos: 'valor_desc',
    nivelProduto: 'produto',
    opcoes: null,
    estados: [],
    // estados SEM o recorte de UF: base do balao e do clique em outro estado
    panorama: [],
    cidades: [],
    carregando: 0,
  };

  const ROT_TIPO = { VENDA: 'Venda', BONIFICACAO: 'Bonificação / amostra' };

  /**
   * Aba "Alertas" visivel no menu. Desligada por escolha do usuario.
   * A apuracao continua rodando (endpoints /api/alertas e /api/excluidos, e a
   * conferencia mensal em Dados) -- so a aba e o contador saem da tela. Trocar
   * para `true` traz tudo de volta, sem nenhuma outra alteracao.
   */
  const MOSTRAR_ALERTAS = false;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  // ---------------------------------------------------------------- formato
  const fMoeda = (v) => (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  const fMoedaC = (v) => (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fNum = (v) => (v ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const fPct = (v) => `${(v ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  const fCompacto = (v) => {
    const n = Math.abs(v ?? 0);
    if (n >= 1e6) return `R$ ${(v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}M`;
    if (n >= 1e3) return `R$ ${(v / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}k`;
    return fMoeda(v);
  };
  const fData = (iso) => {
    if (!iso) return '—';
    const [a, m, d] = iso.split('-');
    return `${d}/${m}/${a}`;
  };
  const MESES_ABREV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const fMes = (ref) => {
    if (!ref) return '—';
    const [a, m] = ref.split('-');
    return `${MESES_ABREV[Number(m) - 1]}/${a.slice(2)}`;
  };
  const fMesLongo = (ref) => {
    if (!ref) return '—';
    const [a, m] = ref.split('-');
    const nomes = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    return `${nomes[Number(m) - 1]}/${a}`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Valor da metrica corrente em um agregado. */
  const valMetrica = (d) => (st.metrica === 'pedidos' ? d.pedidos : st.metrica === 'produtos' ? d.pecas : d.valor);
  /** Percentual coerente com a metrica escolhida (o backend devolve os tres). */
  const pctMetrica = (d) => (st.metrica === 'pedidos' ? (d.pct_pedidos ?? d.pct_valor)
    : st.metrica === 'produtos' ? (d.pct_pecas ?? d.pct_valor) : d.pct_valor);
  const rotMetrica = () => (st.metrica === 'pedidos' ? 'pedidos' : st.metrica === 'produtos' ? 'produtos' : 'valor vendido');
  const fMetrica = (v) => (st.metrica === 'valor' ? fMoeda(v) : fNum(v));

  // --------------------------------------------------------------- consultas
  function paramsBase(extra = {}) {
    const p = new URLSearchParams();
    const f = st.filtros;
    if (f.rep.length) p.set('rep', f.rep.join(','));
    if (f.cliente.length) p.set('cliente', f.cliente.join(','));
    if (f.meses.length) p.set('meses', f.meses.join(','));
    if (f.uf.length) p.set('uf', f.uf.join(','));
    if (f.tipo.length) p.set('tipo', f.tipo.join(','));
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && v !== null && v !== '') p.set(k, v);
    }
    return p;
  }

  /**
   * Mesma consulta, ignorando o recorte de UF.
   *
   * Quando um estado esta selecionado, `st.estados` traz so ele -- e ai o balao
   * nao teria como calcular "% do total nacional" nem achar os dados de outro
   * estado que o usuario clicasse no mapa. O panorama resolve os dois casos.
   * Trocar `st.filtros.uf` aqui e seguro: `paramsBase` le o filtro de forma
   * sincrona, antes de qualquer await, e o `finally` restaura em seguida.
   */
  async function apiPanorama(rota, extra = {}) {
    const guardado = st.filtros.uf;
    st.filtros.uf = [];
    try {
      return await api(rota, extra);
    } finally {
      st.filtros.uf = guardado;
    }
  }

  async function api(rota, extra = {}) {
    st.carregando++;
    $('#carregando').hidden = false;
    try {
      const p = paramsBase(extra).toString();
      const r = await fetch(`/api/${rota}${p ? `?${p}` : ''}`);
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.erro || `HTTP ${r.status}`);
      }
      return await r.json();
    } finally {
      st.carregando--;
      if (st.carregando <= 0) $('#carregando').hidden = true;
    }
  }

  // ----------------------------------------------------------------- filtros
  function montarDropdowns() {
    const o = st.opcoes;
    montarDropdown('rep', 'Representante', o.representantes.map((r) => ({
      valor: r.valor, nome: r.valor, sub: `${r.n} pedidos`, val: fCompacto(r.total),
    })), false);
    montarDropdown('cliente', 'Cliente', o.clientes.map((c) => ({
      valor: c.valor, nome: c.nome, sub: [c.cidade, c.uf].filter(Boolean).join(' · ') || c.cnpj || '',
      val: fCompacto(c.total),
    })), true);
    montarDropdown('meses', 'Período', o.meses.map((m) => ({
      valor: m.valor, nome: fMesLongo(m.valor), sub: `${m.n} pedidos`, val: fCompacto(m.total),
    })), false, true);
    montarDropdown('uf', 'Estado', o.estados.map((e) => ({
      valor: e.valor, nome: `${e.nome} (${e.valor})`, sub: `${e.n} pedidos`, val: fCompacto(e.total),
    })), true);
    montarDropdown('tipo', 'Operação', o.tipos.map((t) => ({
      valor: t.valor, nome: ROT_TIPO[t.valor] ?? t.valor, sub: `${t.n} pedidos`, val: '',
    })), false);
  }

  function montarDropdown(chave, rotulo, itens, comBusca, comIntervalo) {
    const dd = $(`#dd-${chave}`);
    dd.innerHTML = `
      ${comBusca ? `<div class="dd-busca"><input type="text" placeholder="Buscar ${rotulo.toLowerCase()}..."></div>` : ''}
      <div class="dd-acoes">
        <button data-acao="todos">Todos</button>
        <button data-acao="nenhum">Nenhum</button>
        ${comIntervalo ? '<button data-acao="intervalo">Intervalo</button>' : ''}
      </div>
      <div class="dd-lista"></div>`;

    const lista = dd.querySelector('.dd-lista');
    const render = (termo = '') => {
      const t = termo.trim().toUpperCase();
      const vis = t ? itens.filter((i) => `${i.nome} ${i.sub}`.toUpperCase().includes(t)) : itens;
      if (!vis.length) { lista.innerHTML = '<div class="dd-vazio">Nada encontrado</div>'; return; }
      lista.innerHTML = vis.slice(0, 400).map((i) => `
        <label class="dd-op">
          <input type="checkbox" value="${esc(i.valor)}" ${st.filtros[chave].includes(i.valor) ? 'checked' : ''}>
          <span class="op-nome">${esc(i.nome)}${i.sub ? `<span class="op-sub"> · ${esc(i.sub)}</span>` : ''}</span>
          <span class="op-val">${esc(i.val)}</span>
        </label>`).join('');
    };
    render();

    dd.querySelector('.dd-busca input')?.addEventListener('input', (e) => render(e.target.value));
    lista.addEventListener('change', (e) => {
      const cb = e.target;
      if (cb.type !== 'checkbox') return;
      const arr = st.filtros[chave];
      const i = arr.indexOf(cb.value);
      if (cb.checked && i < 0) arr.push(cb.value);
      if (!cb.checked && i >= 0) arr.splice(i, 1);
      aplicarFiltros();
    });
    dd.querySelector('.dd-acoes').addEventListener('click', (e) => {
      const acao = e.target.dataset.acao;
      if (!acao) return;
      if (acao === 'todos') st.filtros[chave] = itens.map((i) => i.valor);
      if (acao === 'nenhum') st.filtros[chave] = [];
      if (acao === 'intervalo') {
        // seleciona do primeiro ao ultimo marcado (util para "janeiro a marco")
        const sel = st.filtros[chave];
        if (sel.length >= 2) {
          const ordenados = itens.map((i) => i.valor).sort();
          const marcados = sel.slice().sort();
          const ini = ordenados.indexOf(marcados[0]);
          const fim = ordenados.indexOf(marcados[marcados.length - 1]);
          st.filtros[chave] = ordenados.slice(ini, fim + 1);
        }
      }
      render(dd.querySelector('.dd-busca input')?.value ?? '');
      aplicarFiltros();
    });
  }

  function atualizarRotulosFiltro() {
    const rots = {
      rep: ['Todos', (n) => `${n} representantes`],
      cliente: ['Todos', (n) => `${n} clientes`],
      meses: ['Todos', (n) => `${n} meses`],
      uf: ['Todos', (n) => `${n} estados`],
      tipo: ['Todas', (n) => `${n} operações`],
    };
    for (const [chave, [vazio, muitos]] of Object.entries(rots)) {
      const arr = st.filtros[chave];
      const el = $(`#rot-${chave}`);
      const pai = document.querySelector(`.filtro[data-filtro="${chave}"]`);
      if (!arr.length) el.textContent = vazio;
      else if (arr.length === 1) el.textContent = nomeDe(chave, arr[0]);
      else el.textContent = muitos(arr.length);
      pai.classList.toggle('tem', arr.length > 0);
    }
    renderChips();
  }

  function nomeDe(chave, valor) {
    const o = st.opcoes;
    if (!o) return valor;
    if (chave === 'cliente') return o.clientes.find((c) => c.valor === valor)?.nome ?? valor;
    if (chave === 'uf') return o.estados.find((e) => e.valor === valor)?.nome ?? valor;
    if (chave === 'meses') return fMesLongo(valor);
    if (chave === 'tipo') return ROT_TIPO[valor] ?? valor;
    return valor;
  }

  function renderChips() {
    const cont = $('#chips');
    const rots = { rep: 'Representante', cliente: 'Cliente', meses: 'Período', uf: 'Estado', tipo: 'Operação' };
    const partes = [];
    for (const [chave, rot] of Object.entries(rots)) {
      for (const v of st.filtros[chave]) {
        partes.push(`<span class="chip"><b>${rot}:</b> <span>${esc(nomeDe(chave, v))}</span>
          <button data-chave="${chave}" data-valor="${esc(v)}" title="Remover">×</button></span>`);
      }
    }
    cont.innerHTML = partes.join('');
  }

  $('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-chave]');
    if (!b) return;
    const arr = st.filtros[b.dataset.chave];
    const i = arr.indexOf(b.dataset.valor);
    if (i >= 0) arr.splice(i, 1);
    montarDropdowns();
    aplicarFiltros();
  });

  // abre/fecha dropdowns
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.filtro-btn');
    const dentro = e.target.closest('.dropdown');
    if (btn) {
      const pai = btn.parentElement;
      const jaAberto = pai.classList.contains('aberto');
      $$('.filtro').forEach((f) => f.classList.remove('aberto'));
      if (!jaAberto) pai.classList.add('aberto');
      return;
    }
    if (!dentro) $$('.filtro').forEach((f) => f.classList.remove('aberto'));
  });

  $('#btn-limpar').addEventListener('click', () => {
    st.filtros = { rep: [], cliente: [], meses: [], uf: [], tipo: [] };
    st.nivel = { uf: null, municipio: null, cidade: null, cliente: null, clienteNome: null };
    MapaBrasil.focar(null);
    montarDropdowns();
    aplicarFiltros();
  });

  /** Contador da aba Alertas (nao faz nada quando a aba esta oculta). */
  function atualizarBadgeAlertas(n) {
    if (!MOSTRAR_ALERTAS) return;
    $('#badge-alertas').textContent = n || '';
    $('#badge-alertas').classList.toggle('tem', !!n);
  }

  function aplicarVisibilidadeAlertas() {
    if (MOSTRAR_ALERTAS) return;
    $('.nav-item[data-view="alertas"]')?.setAttribute('hidden', '');
    $('#badge-alertas')?.setAttribute('hidden', '');
  }

  // --------------------------------------------------------------- navegacao
  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item');
    if (!b) return;
    irPara(b.dataset.view);
  });

  /** Abas cujos numeros nao saem do recorte de vendas do topo. */
  const SEM_FILTROS = new Set(['reposicao', 'admin']);

  function irPara(view) {
    st.view = view;
    $$('.nav-item').forEach((n) => n.classList.toggle('ativo', n.dataset.view === view));
    $$('.view').forEach((v) => v.classList.toggle('ativa', v.id === `view-${view}`));
    // Esconder e mais honesto que deixar visivel sem efeito: em Reposicao o
    // estoque e a OC sao saldos de hoje, e mexer no periodo nao muda nada.
    $('#filtros').hidden = SEM_FILTROS.has(view);
    $('#chips').hidden = SEM_FILTROS.has(view);
    renderView();
  }

  function renderView() {
    const v = st.view;
    if (v === 'dashboard') { MapaBrasil.redimensionar(); return; }
    if (v === 'estados') return renderTabEstados();
    if (v === 'clientes') return renderTabClientes();
    if (v === 'produtos') return renderTabProdutos();
    if (v === 'representantes') return renderTabReps();
    if (v === 'vendas') return renderVendas();
    if (v === 'carteira') return renderCarteira();
    if (v === 'reposicao') return renderReposicao();
    if (v === 'prospeccao') return renderProspeccao();
    if (v === 'alertas') return renderAlertas();
    if (v === 'admin') return renderAdmin();
  }

  // ---------------------------------------------------------------- tooltip
  const tip = $('#tooltip');
  function mostrarTip(ev, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let x = ev.clientX + 14;
    let y = ev.clientY + 14;
    if (x + r.width > window.innerWidth - 10) x = ev.clientX - r.width - 14;
    if (y + r.height > window.innerHeight - 10) y = ev.clientY - r.height - 14;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }
  const esconderTip = () => { tip.hidden = true; };

  // ------------------------------------------------------------------- KPIs
  function renderKpis(r) {
    const cards = [
      { rot: 'Vendas', val: fMoeda(r.valor), sub: `${fPct(r.valor ? (r.valor_faturado / r.valor) * 100 : 0)} faturado`, destaque: true },
      { rot: 'Pedidos', val: fNum(r.pedidos), sub: `ticket ${fMoeda(r.ticket_medio)}` },
      { rot: 'Clientes', val: fNum(r.clientes), sub: `${fMoeda(r.valor_por_cliente)} por cliente` },
      { rot: 'Estados', val: fNum(r.estados), sub: r.valor_exterior ? `+ ${fCompacto(r.valor_exterior)} exportação` : 'com venda no período' },
      {
        rot: 'Cidades',
        val: fNum(r.cidades),
        // explicita o valor sem area no mapa, senao KPI e mapa parecem discordar
        sub: r.valor_sem_local
          ? `${fCompacto(r.valor_sem_local)} fora do mapa`
          : 'com venda no período',
      },
      { rot: 'Produtos', val: fNum(r.pecas), sub: 'peças vendidas' },
    ];
    $('#kpis').innerHTML = cards.map((c) => `
      <div class="kpi${c.destaque ? ' destaque' : ''}">
        <div class="kpi-rot">${c.rot}</div>
        <div class="kpi-val">${c.val}</div>
        <div class="kpi-sub">${c.sub}</div>
      </div>`).join('');
  }

  // -------------------------------------------------------------- breadcrumb
  function renderBreadcrumb() {
    const n = st.nivel;
    const p = ['<button data-nivel="brasil">Brasil</button>'];
    if (n.uf) {
      p.push('<span class="sep">›</span>');
      const nome = st.opcoes?.estados.find((e) => e.valor === n.uf)?.nome ?? n.uf;
      p.push(n.municipio ? `<button data-nivel="uf">${esc(nome)}</button>` : `<span class="atual">${esc(nome)}</span>`);
    }
    if (n.municipio) {
      p.push('<span class="sep">›</span>');
      p.push(n.cliente ? `<button data-nivel="cidade">${esc(n.cidade)}</button>` : `<span class="atual">${esc(n.cidade)}</span>`);
    }
    if (n.cliente) {
      p.push('<span class="sep">›</span>');
      p.push(`<span class="atual">${esc(n.clienteNome)}</span>`);
    }
    $('#breadcrumb').innerHTML = p.join(' ');
  }

  $('#breadcrumb').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-nivel]');
    if (!b) return;
    const n = b.dataset.nivel;
    if (n === 'brasil') return voltarBrasil();
    if (n === 'uf') { fecharGaveta(); st.nivel.municipio = null; st.nivel.cidade = null; st.nivel.cliente = null; MapaBrasil.selecionarCidade(null); renderBreadcrumb(); return; }
    if (n === 'cidade') return abrirCidade({ municipio_id: st.nivel.municipio, cidade: st.nivel.cidade, uf: st.nivel.uf });
  });

  function voltarBrasil() {
    fecharGaveta();
    fecharBalao();
    st.nivel = { uf: null, municipio: null, cidade: null, cliente: null, clienteNome: null };
    // Um estado selecionado tambem recorta os KPIs e os graficos, entao voltar
    // ao Brasil precisa limpar o filtro -- senao o mapa volta e os numeros nao.
    if (st.filtros.uf.length) {
      st.filtros.uf = [];
      montarDropdowns();
      return aplicarFiltros();
    }
    MapaBrasil.focar(null);
    MapaBrasil.definirCidades([]);
    renderBreadcrumb();
    renderRankingLateral();
    return undefined;
  }
  $('#btn-brasil').addEventListener('click', voltarBrasil);

  // ------------------------------------------------------------------ mapa
  async function iniciarMapa() {
    await MapaBrasil.iniciar('#mapa', {
      metrica: () => st.metrica,
      onLegenda: renderLegenda,
      onCliqueEstado: (sigla, ev) => sigla && selecionarEstado(sigla, ev),
      onHoverEstado: (ev, sigla, d) => {
        const nome = st.opcoes?.estados.find((e) => e.valor === sigla)?.nome ?? sigla ?? '—';
        if (!d) {
          mostrarTip(ev, `<div class="tt-tit">${esc(nome)}</div><div class="tt-linha">Sem vendas no filtro atual</div>`);
          return;
        }
        mostrarTip(ev, `
          <div class="tt-tit">${esc(nome)} (${esc(sigla)})</div>
          <div class="tt-linha"><span>Valor de vendas</span><b>${fMoedaC(d.valor)}</b></div>
          <div class="tt-linha"><span>% do total</span><b>${fPct(d.pct_valor)}</b></div>
          <div class="tt-sep"></div>
          <div class="tt-linha"><span>Pedidos</span><b>${fNum(d.pedidos)}</b></div>
          <div class="tt-linha"><span>Clientes</span><b>${fNum(d.clientes)}</b></div>
          <div class="tt-linha"><span>Cidades atendidas</span><b>${fNum(d.cidades)}</b></div>
          <div class="tt-dica">Clique para ver as cidades</div>`);
      },
      onCliqueCidade: (c) => abrirCidade(c),
      onHoverCidade: (ev, c) => {
        mostrarTip(ev, `
          <div class="tt-tit">${esc(c.cidade)} · ${esc(c.uf)}</div>
          <div class="tt-linha"><span>Valor vendido</span><b>${fMoedaC(c.valor)}</b></div>
          <div class="tt-linha"><span>% do estado</span><b>${fPct(c.pct_valor)}</b></div>
          <div class="tt-sep"></div>
          <div class="tt-linha"><span>Pedidos</span><b>${fNum(c.pedidos)}</b></div>
          <div class="tt-linha"><span>Clientes</span><b>${fNum(c.clientes)}</b></div>
          <div class="tt-linha"><span>Principal cliente</span><b>${esc(c.principal_cliente ?? '—')}</b></div>
          <div class="tt-linha"><span>Representante</span><b>${esc(c.representante ?? '—')}</b></div>
          <div class="tt-dica">Clique para ver os clientes</div>`);
      },
      onSairHover: esconderTip,
    });
  }

  function renderLegenda(faixas) {
    const el = $('#legenda');
    if (!faixas || !faixas.limites.length) { el.innerHTML = ''; return; }
    const lims = faixas.limites;
    const min = lims[0][0];
    const max = lims[lims.length - 1][1];
    const fmt = st.metrica === 'valor' ? fCompacto : fNum;
    el.innerHTML = `
      <div class="legenda-rot">${rotMetrica()}</div>
      <div class="legenda-escala">${faixas.cores.map((c) => `<span class="legenda-passo" style="background:${c}"></span>`).join('')}</div>
      <div class="legenda-lim"><span>${fmt(min)}</span><span>${fmt(max)}</span></div>`;
  }

  $('#seg-metrica').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-metrica]');
    if (!b) return;
    st.metrica = b.dataset.metrica;
    $$('#seg-metrica button').forEach((x) => x.classList.toggle('ativo', x === b));
    MapaBrasil.definirEstados(st.estados);
    if (st.nivel.uf) MapaBrasil.definirCidades(st.cidades);
    renderRankingLateral();
  });

  // ------------------------------------------------------- ranking lateral
  $('#ordem-ranking').addEventListener('click', () => {
    st.ordemRanking = st.ordemRanking === 'desc' ? 'asc' : 'desc';
    $('#ordem-ranking').textContent = st.ordemRanking === 'desc' ? '↓ Maior' : '↑ Menor';
    renderRankingLateral();
  });

  function renderRankingLateral() {
    const naCidade = !!st.nivel.uf;
    $('#titulo-ranking').textContent = naCidade
      ? `Cidades · ${st.nivel.uf}`
      : 'Ranking de estados';

    const base = naCidade ? st.cidades : st.estados;
    const linhas = base.slice().sort((a, b) =>
      st.ordemRanking === 'desc' ? valMetrica(b) - valMetrica(a) : valMetrica(a) - valMetrica(b));
    const max = d3.max(base, valMetrica) || 1;

    if (!linhas.length) {
      $('#ranking-lateral').innerHTML = '<div class="g-vazio">Nenhuma venda no filtro atual.</div>';
      return;
    }

    $('#ranking-lateral').innerHTML = linhas.map((l, i) => {
      const v = valMetrica(l);
      const nome = naCidade ? l.cidade : (st.opcoes?.estados.find((e) => e.valor === l.uf)?.nome ?? l.uf);
      const sub = naCidade
        ? `${fNum(l.pedidos)} pedidos · ${fNum(l.clientes)} clientes`
        : `${fNum(l.pedidos)} pedidos · ${fNum(l.cidades)} cidades`;
      const chave = naCidade ? `data-municipio="${esc(l.municipio_id)}" data-cidade="${esc(l.cidade)}" data-uf="${esc(l.uf)}"` : `data-uf="${esc(l.uf)}"`;
      const ativo = naCidade ? l.municipio_id === st.nivel.municipio : l.uf === st.nivel.uf;
      return `
        <div class="rk${ativo ? ' ativo' : ''}" ${chave}>
          <span class="rk-pos">${st.ordemRanking === 'desc' ? i + 1 : linhas.length - i}</span>
          <div><div class="rk-nome">${esc(nome)}</div><div class="rk-sub">${sub}</div></div>
          <div><div class="rk-val">${fMetrica(v)}</div><div class="rk-pct">${fPct(pctMetrica(l))}</div></div>
          <div class="rk-barra"><i style="width:${max ? (v / max) * 100 : 0}%"></i></div>
        </div>`;
    }).join('');
  }

  $('#ranking-lateral').addEventListener('click', (e) => {
    const rk = e.target.closest('.rk');
    if (!rk) return;
    if (rk.dataset.municipio) {
      abrirCidade({ municipio_id: rk.dataset.municipio, cidade: rk.dataset.cidade, uf: rk.dataset.uf });
    } else if (rk.dataset.uf) {
      selecionarEstado(rk.dataset.uf, e);
    }
  });

  // ------------------------------------------------------- drill: ESTADO
  // ------------------------------------------------------- drill: CIDADE
  async function abrirCidade(c) {
    st.nivel.uf = c.uf ?? st.nivel.uf;
    st.nivel.municipio = c.municipio_id;
    st.nivel.cidade = c.cidade;
    st.nivel.cliente = null;
    st.nivel.clienteNome = null;
    if (MapaBrasil.ufAtual !== st.nivel.uf) {
      MapaBrasil.focar(st.nivel.uf);
      st.cidades = await api('cidades', { uf: st.nivel.uf });
      MapaBrasil.definirCidades(st.cidades);
    }
    MapaBrasil.selecionarCidade(c.municipio_id);
    renderBreadcrumb();
    renderRankingLateral();

    const clientes = await api('clientes', { municipio: c.municipio_id });
    const total = clientes.reduce((s, x) => s + x.valor, 0);
    abrirGaveta(
      `${st.nivel.cidade} · ${st.nivel.uf}`,
      `${clientes.length} cliente${clientes.length === 1 ? '' : 's'} · ${fMoedaC(total)}`,
      `<div class="g-sec">
         <div class="g-sec-topo"><h4>Clientes da cidade</h4><span class="dica">clique para ver os produtos</span></div>
         <div class="g-lista">
           ${clientes.length ? clientes.map((cl) => `
             <div class="g-item" data-cliente="${esc(cl.cliente_chave)}" data-nome="${esc(cl.cliente_nome)}">
               <div>
                 <div class="g-item-nome">${esc(cl.cliente_nome)}</div>
                 <div class="g-item-sub">${esc(cl.cnpj ?? 's/ CNPJ')} · ${esc(cl.representante ?? 'sem representante')} · ${fNum(cl.pedidos)} pedidos</div>
               </div>
               <div>
                 <div class="g-item-val">${fMoedaC(cl.valor)}</div>
                 <div class="g-item-pct">${fPct(cl.pct_valor)} da cidade</div>
               </div>
             </div>`).join('') : '<div class="g-vazio">Nenhum cliente no filtro atual.</div>'}
         </div>
       </div>`,
    );
  }

  // ------------------------------------------------------- drill: CLIENTE
  async function abrirCliente(chave, nome) {
    st.nivel.cliente = chave;
    st.nivel.clienteNome = nome;
    renderBreadcrumb();
    const d = await api(`cliente/${encodeURIComponent(chave)}`, { ordem: st.ordemProdutos });
    if (!d) return;
    const maxQ = d3.max(d.produtos, (p) => p.valor) || 1;

    abrirGaveta(esc(d.cliente_nome), `${esc(d.cidade ?? '—')} · ${esc(d.uf ?? '—')}`, `
      <div class="g-kpis">
        <div class="g-kpi"><div class="r">Total comprado</div><div class="v">${fMoeda(d.valor)}</div></div>
        <div class="g-kpi"><div class="r">Pedidos</div><div class="v">${fNum(d.pedidos)}</div></div>
        <div class="g-kpi"><div class="r">Peças</div><div class="v">${fNum(d.pecas)}</div></div>
        <div class="g-kpi"><div class="r">Ticket médio</div><div class="v">${fMoeda(d.ticket_medio)}</div></div>
      </div>

      <dl class="g-dados">
        <dt>CNPJ</dt><dd>${esc(d.cnpj ?? '—')}</dd>
        <dt>Cidade / Estado</dt><dd>${esc(d.cidade ?? '—')} / ${esc(d.uf ?? '—')}</dd>
        <dt>Representante</dt><dd>${esc(d.representante ?? '—')}</dd>
        <dt>Primeira compra</dt><dd>${fData(d.primeira_compra)}</dd>
        <dt>Última compra</dt><dd>${fData(d.ultima_compra)}</dd>
      </dl>

      <div class="g-sec">
        <div class="g-sec-topo">
          <h4>Produtos comprados</h4>
          <select class="select-mini" id="ordem-prod-cliente">
            <option value="valor_desc"${st.ordemProdutos === 'valor_desc' ? ' selected' : ''}>Maior valor vendido</option>
            <option value="valor_asc"${st.ordemProdutos === 'valor_asc' ? ' selected' : ''}>Menor valor vendido</option>
            <option value="qtd_desc"${st.ordemProdutos === 'qtd_desc' ? ' selected' : ''}>Maior quantidade</option>
            <option value="qtd_asc"${st.ordemProdutos === 'qtd_asc' ? ' selected' : ''}>Menor quantidade</option>
          </select>
        </div>
        <div class="tabela-wrap">
          <table class="tabela">
            <thead><tr><th>Produto</th><th>SKU</th><th class="num">Qtd</th><th class="num">Valor vendido</th></tr></thead>
            <tbody>
              ${d.produtos.map((p) => `
                <tr>
                  <td>${esc(p.descricao ?? p.produto)}</td>
                  <td><span class="pill">${esc(p.sku ?? '—')}</span></td>
                  <td class="num">${fNum(p.qtd)}</td>
                  <td class="num forte">${fMoedaC(p.valor)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="g-sec">
        <div class="g-sec-topo"><h4>Ranking de produtos deste cliente</h4></div>
        <div class="barras" style="padding:0">
          ${d.produtos.slice().sort((a, b) => b.valor - a.valor).slice(0, 10).map((p) => `
            <div class="barra">
              <div>
                <div class="barra-nome">${esc(p.descricao ?? p.produto)}</div>
                <div class="barra-trilha"><i style="width:${(p.valor / maxQ) * 100}%"></i></div>
              </div>
              <div><div class="barra-val">${fCompacto(p.valor)}</div><div class="barra-qtd">${fNum(p.qtd)} un.</div></div>
            </div>`).join('')}
        </div>
      </div>

      <div class="g-sec">
        <div class="g-sec-topo"><h4>Pedidos</h4><span class="dica">${d.lista_pedidos.length} no filtro atual</span></div>
        <div class="tabela-wrap">
          <table class="tabela">
            <thead><tr><th>Pedido</th><th>Data</th><th>Situação</th><th class="num">Peças</th><th class="num">Valor</th></tr></thead>
            <tbody>
              ${d.lista_pedidos.map((p) => `
                <tr>
                  <td class="forte">#${esc(p.numero)}</td>
                  <td>${fData(p.data)}</td>
                  <td><span class="pill ${p.faturado ? 'ok' : 'aberto'}">${esc(p.situacao)}</span></td>
                  <td class="num">${fNum(p.qtd_pecas)}</td>
                  <td class="num forte">${fMoedaC(p.total)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`);

    $('#ordem-prod-cliente')?.addEventListener('change', (e) => {
      st.ordemProdutos = e.target.value;
      abrirCliente(chave, nome);
    });
  }

  // ------------------------------------------------- balao do estado
  /**
   * Popup persistente aberto ao clicar num estado (no mapa ou no ranking).
   * Diferente do tooltip, que e passageiro: aqui da para ler com calma e seguir
   * para as cidades. Posicionado acima do ponto clicado, com a seta apontando.
   */
  /**
   * Clique num estado: recorta TODO o dashboard para ele e abre o balao.
   *
   * Clicar de novo no estado ja selecionado desfaz o recorte -- sem isso o
   * usuario ficaria preso no estado, dependendo do botao "Ver Brasil".
   */
  async function selecionarEstado(uf, ev) {
    const jaSelecionado = st.filtros.uf.length === 1 && st.filtros.uf[0] === uf;
    if (jaSelecionado) {
      fecharBalao();
      st.filtros.uf = [];
      st.nivel.uf = null;
      montarDropdowns();
      return aplicarFiltros();
    }
    fecharGaveta();
    st.nivel.municipio = null;
    st.nivel.cidade = null;
    st.nivel.cliente = null;
    // o balao primeiro, com o panorama em maos: mostra o % nacional do estado
    abrirBalao(uf, ev);
    st.filtros.uf = [uf];
    montarDropdowns();
    return aplicarFiltros();
  }

  function abrirBalao(uf, ev) {
    // panorama, nao `st.estados`: com um estado ja recortado, `st.estados` traz
    // so ele, e o "% do total nacional" viraria 100% para qualquer estado.
    const base = st.panorama?.length ? st.panorama : st.estados;
    const d = base.find((e) => e.uf === uf);
    const balao = $('#balao');
    if (!d) { balao.hidden = true; return; }
    const nome = st.opcoes?.estados.find((e) => e.valor === uf)?.nome ?? uf;
    const exterior = uf === 'EX';

    $('#balao-corpo').innerHTML = `
      <div class="balao-topo">
        <div class="balao-uf">${exterior ? 'Exportação' : `Estado · ${esc(uf)}`}</div>
        <div class="balao-tit">${esc(nome)}</div>
        <div class="balao-val">${fMoedaC(d.valor)}
          <small>${fPct(d.pct_valor)} do total nacional</small></div>
      </div>
      <div class="balao-linhas">
        <div class="balao-linha"><span>Pedidos</span><b>${fNum(d.pedidos)}</b></div>
        <div class="balao-linha"><span>Ticket médio</span><b>${fMoeda(d.ticket_medio)}</b></div>
        <div class="balao-linha"><span>Clientes</span><b>${fNum(d.clientes)}</b></div>
        ${exterior ? '' : `<div class="balao-linha"><span>Cidades atendidas</span><b>${fNum(d.cidades)}</b></div>`}
        <div class="balao-linha"><span>Peças</span><b>${fNum(d.pecas)}</b></div>
        <div class="balao-linha destaque">
          <span>Principal cliente<span class="sub">${fPct(d.principal_cliente_pct)} do estado</span></span>
          <b>${esc(d.principal_cliente ?? '—')}<span class="sub">${fCompacto(d.principal_cliente_valor)}</span></b>
        </div>
        ${exterior || !d.principal_cidade ? '' : `
        <div class="balao-linha">
          <span>Principal cidade<span class="sub">${fPct(d.principal_cidade_pct)} do estado</span></span>
          <b>${esc(d.principal_cidade)}<span class="sub">${fCompacto(d.principal_cidade_valor)}</span></b>
        </div>`}
      </div>
      ${exterior || !d.cidades ? '' : `
      <div class="balao-nota">As ${fNum(d.cidades)} cidades já estão no mapa, ao lado.</div>`}`;

    balao.hidden = false;
    // sem `ev`: a posicao vem do mapa, nao do ponto clicado
    posicionarBalao();
    balao.dataset.uf = uf;
  }

  /**
   * Ancora o balao no canto superior DIREITO da area do mapa.
   *
   * Antes ele abria sobre o ponto clicado, o que cobria justamente o estado que
   * acabara de receber o zoom e as bolhas das cidades. Fixo a direita, o mapa
   * fica visivel e da para ler as cidades e o resumo ao mesmo tempo. Sem seta,
   * porque nao aponta mais para um ponto.
   */
  function posicionarBalao() {
    const balao = $('#balao');
    const mapa = $('.mapa-wrap') ?? $('#mapa');
    const r = balao.getBoundingClientRect();
    const m = mapa.getBoundingClientRect();
    const folga = 12;
    let x = m.right - r.width - folga;
    let y = m.top + folga;
    // nunca sair da janela, mesmo com o mapa parcialmente fora da viewport
    x = Math.max(10, Math.min(x, window.innerWidth - r.width - 10));
    y = Math.max(10, Math.min(y, window.innerHeight - r.height - 10));
    balao.style.left = `${x}px`;
    balao.style.top = `${y}px`;
  }

  const fecharBalao = () => { $('#balao').hidden = true; };
  $('#balao-fechar').addEventListener('click', fecharBalao);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharBalao(); });
  // reposiciona em vez de fechar: o balao esta ancorado no mapa, que se move
  window.addEventListener('resize', () => { if (!$('#balao').hidden) posicionarBalao(); });

  // ------------------------------------- cidades de um estado (gaveta)
  /** Cidades do estado, com as vendas. Substitui a antiga aba Cidades. */
  async function abrirCidadesDoEstado(uf) {
    const nome = st.opcoes?.estados.find((e) => e.valor === uf)?.nome ?? uf;
    const cidades = await api('cidades', { uf });
    const total = cidades.reduce((s, c) => s + c.valor, 0);
    const max = d3.max(cidades, (c) => c.valor) || 1;

    abrirGaveta(`${esc(nome)} · ${esc(uf)}`,
      `${cidades.length} cidade${cidades.length === 1 ? '' : 's'} com venda · ${fMoedaC(total)}`, `
      <div class="g-sec">
        <div class="g-sec-topo"><h4>Cidades</h4>
          <span class="dica">clique para ver os clientes</span></div>
        <div class="g-lista">
          ${cidades.length ? cidades.map((c) => `
            <div class="g-item" data-municipio="${esc(c.municipio_id)}" data-cidade="${esc(c.cidade)}" data-uf="${esc(c.uf)}">
              <div>
                <div class="g-item-nome">${esc(c.cidade)}</div>
                <div class="g-item-sub">${fNum(c.pedidos)} pedidos · ${fNum(c.clientes)} clientes · ${esc(c.principal_cliente ?? '—')}</div>
                <div class="barra-trilha" style="margin-top:5px"><i style="width:${(c.valor / max) * 100}%"></i></div>
              </div>
              <div>
                <div class="g-item-val">${fMoedaC(c.valor)}</div>
                <div class="g-item-pct">${fPct(c.pct_valor)} do estado</div>
              </div>
            </div>`).join('') : '<div class="g-vazio">Nenhuma cidade com venda no filtro atual.</div>'}
        </div>
      </div>`);
  }

  // ------------------------------------------------- drill: PRODUTO -> SKUs
  /**
   * Grade de SKUs de um produto. Pensada para projecao de venda e compra:
   * a coluna "% da grade" diz quanto cada tamanho/cor puxa do produto, e a
   * evolucao mensal mostra se essa participacao esta mudando.
   */
  async function abrirProduto(nome) {
    const d = await api('produto-detalhe', { produto: nome, ordem: st.ordemProdutos });
    if (!d) return;

    const maxQtd = d3.max(d.skus, (s) => s.qtd) || 1;
    const maxMes = d3.max(d.por_mes, (m) => m.qtd) || 1;
    const maxCli = d3.max(d.clientes, (c) => c.valor) || 1;
    const maxUf = d3.max(d.estados, (e) => e.qtd) || 1;

    abrirGaveta(esc(d.produto), `${esc(d.categoria ?? '—')} · ${fNum(d.n_skus)} SKUs com venda`, `
      <div class="g-kpis">
        <div class="g-kpi"><div class="r">Qtd vendida</div><div class="v">${fNum(d.qtd)}</div></div>
        <div class="g-kpi"><div class="r">Faturamento</div><div class="v">${fMoeda(d.valor)}</div></div>
        <div class="g-kpi"><div class="r">Preço médio</div><div class="v">${fMoedaC(d.preco_medio)}</div></div>
        <div class="g-kpi"><div class="r">Pedidos</div><div class="v">${fNum(d.pedidos)}</div></div>
        <div class="g-kpi"><div class="r">Clientes</div><div class="v">${fNum(d.n_clientes)}</div></div>
      </div>

      <div class="g-sec">
        <div class="g-sec-topo">
          <h4>Curva de grade — SKUs deste produto</h4>
          <select class="select-mini" id="ordem-skus">
            <option value="qtd_desc"${st.ordemProdutos === 'qtd_desc' ? ' selected' : ''}>Maior quantidade</option>
            <option value="qtd_asc"${st.ordemProdutos === 'qtd_asc' ? ' selected' : ''}>Menor quantidade</option>
            <option value="valor_desc"${st.ordemProdutos === 'valor_desc' ? ' selected' : ''}>Maior faturamento</option>
            <option value="valor_asc"${st.ordemProdutos === 'valor_asc' ? ' selected' : ''}>Menor faturamento</option>
          </select>
        </div>
        <div class="tabela-wrap"><table class="tabela" id="tab-skus-produto"></table></div>
      </div>

      <div class="g-sec">
        <div class="g-sec-topo"><h4>Evolução mensal</h4><span class="dica">quantidade vendida</span></div>
        <div class="barras" style="padding:0">
          ${d.por_mes.map((m) => `
            <div class="barra">
              <div>
                <div class="barra-nome">${fMesLongo(m.mes_ref)}</div>
                <div class="barra-trilha"><i style="width:${(m.qtd / maxMes) * 100}%"></i></div>
              </div>
              <div><div class="barra-val">${fNum(m.qtd)} un.</div><div class="barra-qtd">${fCompacto(m.valor)}</div></div>
            </div>`).join('')}
        </div>
      </div>

      <div class="g-sec">
        <div class="g-sec-topo"><h4>Quem compra</h4><span class="dica">clique para abrir o cliente</span></div>
        <div class="g-lista">
          ${d.clientes.map((c) => `
            <div class="g-item" data-cliente="${esc(c.cliente_chave)}" data-nome="${esc(c.cliente_nome)}">
              <div>
                <div class="g-item-nome">${esc(c.cliente_nome)}</div>
                <div class="g-item-sub">${esc(c.uf ?? '—')} · ${fNum(c.pedidos)} pedidos</div>
                <div class="barra-trilha" style="margin-top:5px"><i style="width:${(c.valor / maxCli) * 100}%"></i></div>
              </div>
              <div><div class="g-item-val">${fNum(c.qtd)} un.</div><div class="g-item-pct">${fCompacto(c.valor)}</div></div>
            </div>`).join('')}
        </div>
      </div>

      <div class="g-sec">
        <div class="g-sec-topo"><h4>Distribuição por estado</h4></div>
        <div class="barras" style="padding:0">
          ${d.estados.map((e) => `
            <div class="barra">
              <div>
                <div class="barra-nome">${esc(e.uf === 'EX' ? 'Exterior' : e.uf)}</div>
                <div class="barra-trilha"><i style="width:${(e.qtd / maxUf) * 100}%"></i></div>
              </div>
              <div><div class="barra-val">${fNum(e.qtd)} un.</div><div class="barra-qtd">${fCompacto(e.valor)}</div></div>
            </div>`).join('')}
        </div>
      </div>

      ${d.skus_sem_venda.length ? `
      <div class="g-sec">
        <div class="g-sec-topo"><h4>SKUs sem venda no filtro atual</h4>
          <span class="dica">já venderam antes — atenção na reposição</span></div>
        <div class="tabela-wrap">
          <table class="tabela">
            <thead><tr><th>SKU</th><th>Variação</th><th>Última venda</th><th class="num">Qtd histórica</th></tr></thead>
            <tbody>${d.skus_sem_venda.map((s) => `
              <tr>
                <td><span class="pill">${esc(s.sku)}</span></td>
                <td>${esc(s.descricao ?? '—')}</td>
                <td>${fData(s.ultima_venda)}</td>
                <td class="num">${fNum(s.qtd_historica)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>` : ''}
    `);

    tabela('#tab-skus-produto', [
      { chave: 'sku', rot: 'SKU', forte: true, render: (s) => `<span class="pill">${esc(s.sku)}</span>` },
      { chave: 'descricao', rot: 'Variação', render: (s) => esc(s.descricao ?? '—') },
      { chave: 'qtd', rot: 'Qtd', num: true, forte: true, render: (s) => fNum(s.qtd) },
      {
        chave: 'pct_qtd', rot: '% da grade', num: true,
        render: (s) => `${fPct(s.pct_qtd)} <span class="mini-barra"><i style="width:${(s.qtd / maxQtd) * 100}%"></i></span>`,
      },
      { chave: 'valor', rot: 'Valor', num: true, forte: true, render: (s) => fMoedaC(s.valor) },
      { chave: 'preco_medio', rot: 'Preço médio', num: true, render: (s) => fMoedaC(s.preco_medio) },
      { chave: 'pedidos', rot: 'Pedidos', num: true, render: (s) => fNum(s.pedidos) },
      { chave: 'clientes', rot: 'Clientes', num: true, render: (s) => fNum(s.clientes) },
      { chave: 'ultima_venda', rot: 'Última venda', render: (s) => fData(s.ultima_venda) },
    ], d.skus, {
      ordem: {
        col: st.ordemProdutos.startsWith('qtd') ? 'qtd' : 'valor',
        dir: st.ordemProdutos.endsWith('asc') ? 'asc' : 'desc',
      },
    });

    $('#ordem-skus')?.addEventListener('change', (e) => {
      st.ordemProdutos = e.target.value;
      abrirProduto(nome);
    });
  }

  // ----------------------------------------------------------------- gaveta
  function abrirGaveta(titulo, sub, html) {
    $('#gaveta-titulo').innerHTML = titulo;
    $('#gaveta-sub').innerHTML = sub;
    $('#gaveta-corpo').innerHTML = html;
    $('#gaveta').hidden = false;
    $('#gaveta-fundo').hidden = false;
    $('#gaveta-corpo').scrollTop = 0;
  }
  function fecharGaveta() {
    $('#gaveta').hidden = true;
    $('#gaveta-fundo').hidden = true;
  }
  $('#gaveta-fechar').addEventListener('click', () => {
    fecharGaveta();
    if (st.nivel.cliente) { st.nivel.cliente = null; st.nivel.clienteNome = null; renderBreadcrumb(); }
  });
  $('#gaveta-fundo').addEventListener('click', () => $('#gaveta-fechar').click());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#gaveta').hidden) $('#gaveta-fechar').click();
      else $$('.filtro').forEach((f) => f.classList.remove('aberto'));
    }
  });
  $('#gaveta-corpo').addEventListener('click', (e) => {
    const it = e.target.closest('.g-item[data-cliente]');
    if (it) { abrirCliente(it.dataset.cliente, it.dataset.nome); return; }
    const cid = e.target.closest('.g-item[data-municipio]');
    if (cid) abrirCidade({ municipio_id: cid.dataset.municipio, cidade: cid.dataset.cidade, uf: cid.dataset.uf });
    const am = e.target.closest('.g-item[data-amostra]');
    if (am) abrirAmostrasCliente(am.dataset.amostra, am.dataset.nome);
  });

  // Barras de produto abrem a grade de SKUs. No dashboard sao sempre produtos;
  // na tela de Produtos, so quando o nivel exibido e "produto" (no nivel SKU a
  // chave da barra ja e um SKU, que nao tem grade por dentro).
  $('#barras-produtos').addEventListener('click', (e) => {
    const b = e.target.closest('.barra[data-produto]');
    if (b) abrirProduto(b.dataset.produto);
  });
  $('#barras-produtos-full').addEventListener('click', (e) => {
    const b = e.target.closest('.barra[data-produto]');
    if (b && st.nivelProduto === 'produto') abrirProduto(b.dataset.produto);
  });

  // ------------------------------------------------------- produtos (dash)
  function renderBarrasProdutos(alvo, produtos) {
    const porQtd = st.ordemProdutos.startsWith('qtd');
    const max = d3.max(produtos, (p) => (porQtd ? p.qtd : p.valor)) || 1;
    if (!produtos.length) { $(alvo).innerHTML = '<div class="g-vazio">Nenhum produto no filtro atual.</div>'; return; }
    $(alvo).innerHTML = produtos.map((p) => {
      const v = porQtd ? p.qtd : p.valor;
      return `
        <div class="barra" data-produto="${esc(p.chave)}">
          <div>
            <div class="barra-nome">${esc(p.produto ?? p.descricao ?? p.chave)}</div>
            <div class="barra-trilha"><i style="width:${(v / max) * 100}%"></i></div>
          </div>
          <div>
            <div class="barra-val">${porQtd ? `${fNum(p.qtd)} un.` : fCompacto(p.valor)}</div>
            <div class="barra-qtd">${porQtd ? fCompacto(p.valor) : `${fNum(p.qtd)} un.`}</div>
          </div>
        </div>`;
    }).join('');
  }

  $('#ordem-prod-dash').addEventListener('change', async (e) => {
    st.ordemProdutos = e.target.value;
    renderBarrasProdutos('#barras-produtos', await api('produtos', { limite: 15, ordem: st.ordemProdutos }));
  });

  // ------------------------------------------------------ grafico de meses
  function renderGraficoMeses(meses, alvo = '#grafico-meses') {
    const el = $(alvo);
    el.innerHTML = '';
    if (!meses.length) { el.innerHTML = '<div class="g-vazio">Sem período no filtro atual.</div>'; return; }
    const larg = el.clientWidth || 520;
    const alt = 220;
    const m = { t: 14, d: 16, b: 30, e: 54 };
    const svg = d3.select(el).append('svg')
      .attr('viewBox', `0 0 ${larg} ${alt}`)
      .attr('width', '100%').attr('height', alt);

    const x = d3.scaleBand().domain(meses.map((d) => d.mes_ref)).range([m.e, larg - m.d]).padding(0.28);
    const y = d3.scaleLinear().domain([0, d3.max(meses, (d) => d.valor) * 1.1 || 1]).nice().range([alt - m.b, m.t]);

    svg.append('g').attr('transform', `translate(0,${alt - m.b})`)
      .call(d3.axisBottom(x).tickFormat(fMes).tickSize(0))
      .call((g) => g.select('.domain').attr('stroke', '#e4e8ee'))
      .call((g) => g.selectAll('text').attr('fill', '#5b6472').attr('font-size', 10));
    svg.append('g').attr('transform', `translate(${m.e},0)`)
      .call(d3.axisLeft(y).ticks(4).tickFormat(fCompacto).tickSize(-(larg - m.e - m.d)))
      .call((g) => g.select('.domain').remove())
      .call((g) => g.selectAll('line').attr('stroke', '#eef1f5'))
      .call((g) => g.selectAll('text').attr('fill', '#8a94a3').attr('font-size', 10));

    svg.append('g').selectAll('rect').data(meses).join('rect')
      .attr('x', (d) => x(d.mes_ref))
      .attr('width', x.bandwidth())
      .attr('y', (d) => y(d.valor))
      .attr('height', (d) => Math.max(0, alt - m.b - y(d.valor)))
      .attr('rx', 3)
      .attr('fill', '#d71f3f')
      .style('cursor', 'pointer')
      .on('mousemove', (ev, d) => mostrarTip(ev, `
        <div class="tt-tit">${fMesLongo(d.mes_ref)}</div>
        <div class="tt-linha"><span>Valor vendido</span><b>${fMoedaC(d.valor)}</b></div>
        <div class="tt-linha"><span>Pedidos</span><b>${fNum(d.pedidos)}</b></div>
        <div class="tt-linha"><span>Clientes</span><b>${fNum(d.clientes)}</b></div>
        <div class="tt-linha"><span>Estados</span><b>${fNum(d.estados)}</b></div>
        <div class="tt-linha"><span>Cidades</span><b>${fNum(d.cidades)}</b></div>
        <div class="tt-dica">Clique para filtrar só este mês</div>`))
      .on('mouseleave', esconderTip)
      .on('click', (ev, d) => {
        st.filtros.meses = [d.mes_ref];
        montarDropdowns();
        aplicarFiltros();
      });
  }

  /**
   * Faturamento mensal da aba PEDIDOS FATURADOS.
   *
   * Serie propria, vinda direto da planilha: agrupa pela coluna FATURAMENTO (o
   * mes em que o pedido foi faturado), nao pela CADASTRO. Usar a de cadastro
   * fazia junho/2026 aparecer com R$ 451 mil em vez dos R$ 615 mil que a aba
   * soma. Como e um total de aba, nao responde aos filtros -- a nota avisa.
   */
  function renderGraficoFaturamento(fat, alvo = '#grafico-faturamento') {
    const el = $(alvo);
    el.innerHTML = '';
    const meses = fat?.meses ?? [];

    if (!meses.length) {
      el.innerHTML = `<div class="g-vazio">${fat?.erro ? `Não foi possível ler a aba: ${esc(fat.erro)}` : 'A aba PEDIDOS FATURADOS não retornou meses.'}</div>`;
      return;
    }

    const larg = el.clientWidth || 520;
    const alt = 220;
    const m = { t: 14, d: 16, b: 30, e: 54 };
    const svg = d3.select(el).append('svg')
      .attr('viewBox', `0 0 ${larg} ${alt}`)
      .attr('width', '100%').attr('height', alt);

    const x = d3.scaleBand().domain(meses.map((d) => d.mes_ref)).range([m.e, larg - m.d]).padding(0.28);
    const y = d3.scaleLinear().domain([0, d3.max(meses, (d) => d.valor) * 1.1 || 1]).nice().range([alt - m.b, m.t]);

    svg.append('g').attr('transform', `translate(0,${alt - m.b})`)
      .call(d3.axisBottom(x).tickFormat(fMes).tickSize(0))
      .call((g) => g.select('.domain').attr('stroke', '#e4e8ee'))
      .call((g) => g.selectAll('text').attr('fill', '#5b6472').attr('font-size', 10));
    svg.append('g').attr('transform', `translate(${m.e},0)`)
      .call(d3.axisLeft(y).ticks(4).tickFormat(fCompacto).tickSize(-(larg - m.e - m.d)))
      .call((g) => g.select('.domain').remove())
      .call((g) => g.selectAll('line').attr('stroke', '#eef1f5'))
      .call((g) => g.selectAll('text').attr('fill', '#8a94a3').attr('font-size', 10));

    const media = meses.reduce((s, d) => s + d.valor, 0) / meses.length;
    svg.append('line')
      .attr('x1', m.e).attr('x2', larg - m.d)
      .attr('y1', y(media)).attr('y2', y(media))
      .attr('stroke', '#b6bfcc').attr('stroke-width', 1).attr('stroke-dasharray', '4 3');

    svg.append('g').selectAll('rect').data(meses).join('rect')
      .attr('x', (d) => x(d.mes_ref))
      .attr('width', x.bandwidth())
      .attr('y', (d) => y(d.valor))
      .attr('height', (d) => Math.max(0, alt - m.b - y(d.valor)))
      .attr('rx', 3)
      .attr('fill', '#8e2338')
      .on('mousemove', (ev, d) => mostrarTip(ev, `
        <div class="tt-tit">${fMesLongo(d.mes_ref)}</div>
        <div class="tt-linha"><span>Faturado</span><b>${fMoedaC(d.valor)}</b></div>
        <div class="tt-linha"><span>Pedidos na aba</span><b>${fNum(d.linhas)}</b></div>
        <div class="tt-linha"><span>Média do período</span><b>${fMoedaC(media)}</b></div>`))
      .on('mouseleave', esconderTip);
  }

  /**
   * Barras agrupadas por mes: um grupo por mes, uma barra por ano.
   * Os anos anteriores vem do cabecalho das abas mensais (mesma fonte da tabela
   * "Comparativo histórico"), entao o grafico e a tabela contam a mesma coisa.
   */
  function renderGraficoYoY(series, alvo) {
    const el = $(alvo);
    el.innerHTML = '';
    if (!series.length) { el.innerHTML = '<div class="g-vazio">Sem período no filtro atual.</div>'; return; }

    const anoAtual = Number(series[series.length - 1].mes_ref.slice(0, 4));
    const anos = [
      { chave: 'ano_menos_2', rot: String(anoAtual - 2), cor: '#c9d1dc' },
      { chave: 'ano_menos_1', rot: String(anoAtual - 1), cor: '#8e97a6' },
      { chave: 'ano_atual', rot: String(anoAtual), cor: 'var(--fbr)' },
    ].filter((a) => a.chave === 'ano_atual' || series.some((s) => s[a.chave]));

    const larg = el.clientWidth || 520;
    const alt = 250;
    const m = { t: 26, d: 16, b: 30, e: 54 };
    const svg = d3.select(el).append('svg')
      .attr('viewBox', `0 0 ${larg} ${alt}`).attr('width', '100%').attr('height', alt);

    const x = d3.scaleBand().domain(series.map((s) => s.mes_ref))
      .range([m.e, larg - m.d]).padding(0.24);
    const xAno = d3.scaleBand().domain(anos.map((a) => a.chave))
      .range([0, x.bandwidth()]).padding(0.08);
    const maxV = d3.max(series, (s) => d3.max(anos, (a) => s[a.chave] ?? 0)) || 1;
    const y = d3.scaleLinear().domain([0, maxV * 1.1]).nice().range([alt - m.b, m.t]);

    svg.append('g').attr('transform', `translate(0,${alt - m.b})`)
      .call(d3.axisBottom(x).tickFormat(fMes).tickSize(0))
      .call((g) => g.select('.domain').attr('stroke', '#e4e8ee'))
      .call((g) => g.selectAll('text').attr('fill', '#5b6472').attr('font-size', 10));
    svg.append('g').attr('transform', `translate(${m.e},0)`)
      .call(d3.axisLeft(y).ticks(4).tickFormat(fCompacto).tickSize(-(larg - m.e - m.d)))
      .call((g) => g.select('.domain').remove())
      .call((g) => g.selectAll('line').attr('stroke', '#eef1f5'))
      .call((g) => g.selectAll('text').attr('fill', '#8a94a3').attr('font-size', 10));

    const grupos = svg.append('g').selectAll('g').data(series).join('g')
      .attr('transform', (s) => `translate(${x(s.mes_ref)},0)`);
    grupos.selectAll('rect').data((s) => anos.map((a) => ({ ...a, mes: s, v: s[a.chave] ?? 0 })))
      .join('rect')
      .attr('x', (d) => xAno(d.chave))
      .attr('width', xAno.bandwidth())
      .attr('y', (d) => y(d.v))
      .attr('height', (d) => Math.max(0, alt - m.b - y(d.v)))
      .attr('rx', 2)
      .attr('fill', (d) => d.cor)
      .style('cursor', (d) => (d.chave === 'ano_atual' ? 'pointer' : 'default'))
      .on('mousemove', (ev, d) => {
        const s = d.mes;
        mostrarTip(ev, `
          <div class="tt-tit">${fMesLongo(s.mes_ref)}</div>
          ${anos.slice().reverse().map((a) => `
            <div class="tt-linha"><span>${a.rot}</span><b>${s[a.chave] ? fMoedaC(s[a.chave]) : '—'}</b></div>`).join('')}
          ${s.yoy_1 == null ? '' : `<div class="tt-sep"></div>
            <div class="tt-linha"><span>vs ${anoAtual - 1}</span><b>${s.yoy_1 >= 0 ? '+' : ''}${fPct(s.yoy_1 * 100)}</b></div>`}
          ${s.yoy_2 == null ? '' : `<div class="tt-linha"><span>vs ${anoAtual - 2}</span><b>${s.yoy_2 >= 0 ? '+' : ''}${fPct(s.yoy_2 * 100)}</b></div>`}
          <div class="tt-sep"></div>
          <div class="tt-linha"><span>Pedidos</span><b>${fNum(s.pedidos)}</b></div>
          <div class="tt-linha"><span>Clientes ativos</span><b>${fNum(s.clientes_ativos)}</b></div>`);
      })
      .on('mouseleave', esconderTip)
      .on('click', (ev, d) => {
        if (d.chave !== 'ano_atual') return;
        st.filtros.meses = [d.mes.mes_ref];
        montarDropdowns();
        aplicarFiltros();
      });

    // legenda dos anos
    const leg = svg.append('g').attr('transform', `translate(${m.e},14)`);
    let dx = 0;
    anos.forEach((a) => {
      const g = leg.append('g').attr('transform', `translate(${dx},0)`);
      g.append('rect').attr('width', 9).attr('height', 9).attr('y', -8).attr('rx', 2).attr('fill', a.cor);
      g.append('text').attr('x', 13).attr('font-size', 10.5).attr('fill', '#5b6472').text(a.rot);
      dx += 13 + a.rot.length * 6.5 + 14;
    });
  }

  // ------------------------------------------------------------- tabelas
  function tabela(alvo, colunas, linhas, opcoes = {}) {
    const el = $(alvo);
    const ord = opcoes.ordem ?? { col: null, dir: 'desc' };
    let dados = linhas.slice();
    if (ord.col) {
      const c = colunas.find((x) => x.chave === ord.col);
      dados.sort((a, b) => {
        const va = c.ordenaPor ? c.ordenaPor(a) : a[c.chave];
        const vb = c.ordenaPor ? c.ordenaPor(b) : b[c.chave];
        if (typeof va === 'number' && typeof vb === 'number') return ord.dir === 'desc' ? vb - va : va - vb;
        return ord.dir === 'desc'
          ? String(vb ?? '').localeCompare(String(va ?? ''), 'pt-BR')
          : String(va ?? '').localeCompare(String(vb ?? ''), 'pt-BR');
      });
    }
    el.innerHTML = `
      <thead><tr>${colunas.map((c) => `
        <th class="${c.num ? 'num ' : ''}${c.semOrdem ? 'n-ord' : ''}" data-col="${c.chave}">
          ${c.rot}${ord.col === c.chave ? `<span class="seta"> ${ord.dir === 'desc' ? '▼' : '▲'}</span>` : ''}
        </th>`).join('')}</tr></thead>
      <tbody>${dados.length ? dados.map((l) => `
        <tr class="${opcoes.clicavel ? 'clicavel' : ''}" ${opcoes.dataset ? opcoes.dataset(l) : ''}>
          ${colunas.map((c) => `<td class="${c.num ? 'num' : ''} ${c.forte ? 'forte' : ''}">${c.render(l)}</td>`).join('')}
        </tr>`).join('') : `<tr><td colspan="${colunas.length}"><div class="g-vazio">Nada no filtro atual.</div></td></tr>`}
      </tbody>`;

    el.querySelector('thead').onclick = (e) => {
      const th = e.target.closest('th[data-col]');
      if (!th) return;
      const c = colunas.find((x) => x.chave === th.dataset.col);
      if (!c || c.semOrdem) return;
      const novaDir = ord.col === c.chave && ord.dir === 'desc' ? 'asc' : 'desc';
      tabela(alvo, colunas, linhas, { ...opcoes, ordem: { col: c.chave, dir: novaDir } });
    };
  }

  async function renderTabEstados() {
    const linhas = st.estados;
    $('#dica-estados').textContent = `${linhas.length} estados com venda · clique na linha para ver as cidades`;
    tabela('#tab-estados', [
      { chave: 'nome', rot: 'Estado', forte: true, render: (l) => `${esc(l.nome)} <span class="pill">${esc(l.uf)}</span>` },
      { chave: 'valor', rot: 'Valor vendido', num: true, forte: true, render: (l) => fMoedaC(l.valor) },
      { chave: 'pct_valor', rot: '% nacional', num: true, render: (l) => `${fPct(l.pct_valor)} <span class="mini-barra"><i style="width:${Math.min(100, l.pct_valor)}%"></i></span>` },
      { chave: 'pedidos', rot: 'Pedidos', num: true, render: (l) => fNum(l.pedidos) },
      { chave: 'clientes', rot: 'Clientes', num: true, render: (l) => fNum(l.clientes) },
      { chave: 'cidades', rot: 'Cidades', num: true, render: (l) => fNum(l.cidades) },
      { chave: 'pecas', rot: 'Peças', num: true, render: (l) => fNum(l.pecas) },
      { chave: 'ticket', rot: 'Ticket médio', num: true, ordenaPor: (l) => (l.pedidos ? l.valor / l.pedidos : 0), render: (l) => fMoeda(l.pedidos ? l.valor / l.pedidos : 0) },
    ], linhas, {
      ordem: { col: 'valor', dir: 'desc' },
      clicavel: true,
      dataset: (l) => `data-uf="${esc(l.uf)}"`,
    });
    $('#tab-estados').onclick = (e) => {
      const tr = e.target.closest('tr[data-uf]');
      if (tr) abrirCidadesDoEstado(tr.dataset.uf);
    };
  }

  async function renderTabClientes() {
    const linhas = await api('clientes', { municipio: st.nivel.municipio ?? '' });
    const termo = $('#busca-cliente').value.trim().toUpperCase();
    const vis = termo ? linhas.filter((l) => `${l.cliente_nome} ${l.cnpj ?? ''} ${l.cidade ?? ''}`.toUpperCase().includes(termo)) : linhas;
    tabela('#tab-clientes', [
      { chave: 'cliente_nome', rot: 'Cliente', forte: true, render: (l) => esc(l.cliente_nome) },
      { chave: 'cnpj', rot: 'CNPJ', render: (l) => esc(l.cnpj ?? '—') },
      { chave: 'cidade', rot: 'Cidade', render: (l) => esc(l.cidade ?? '—') },
      { chave: 'uf', rot: 'UF', render: (l) => `<span class="pill">${esc(l.uf ?? '—')}</span>` },
      { chave: 'representante', rot: 'Representante', render: (l) => esc(l.representante ?? '—') },
      { chave: 'valor', rot: 'Total comprado', num: true, forte: true, render: (l) => fMoedaC(l.valor) },
      { chave: 'pedidos', rot: 'Pedidos', num: true, render: (l) => fNum(l.pedidos) },
      { chave: 'ultima_compra', rot: 'Última compra', render: (l) => fData(l.ultima_compra) },
      { chave: 'principais', rot: 'Principais produtos', semOrdem: true, render: (l) => esc(l.principais_produtos.map((p) => p.produto).join(', ') || '—') },
    ], vis, {
      ordem: { col: 'valor', dir: 'desc' },
      clicavel: true,
      dataset: (l) => `data-cliente="${esc(l.cliente_chave)}" data-nome="${esc(l.cliente_nome)}"`,
    });
    $('#tab-clientes').onclick = (e) => {
      const tr = e.target.closest('tr[data-cliente]');
      if (!tr) return;
      abrirCliente(tr.dataset.cliente, tr.dataset.nome);
    };
  }
  $('#busca-cliente').addEventListener('input', () => renderTabClientes());

  async function renderTabProdutos() {
    const linhas = await api('produtos', { nivel: st.nivelProduto, ordem: st.ordemProdutos, limite: 500 });
    const termo = $('#busca-produto').value.trim().toUpperCase();
    const vis = termo ? linhas.filter((l) => `${l.produto ?? ''} ${l.descricao ?? ''} ${l.sku ?? ''}`.toUpperCase().includes(termo)) : linhas;
    renderBarrasProdutos('#barras-produtos-full', vis.slice(0, 20));
    tabela('#tab-produtos', [
      { chave: 'produto', rot: st.nivelProduto === 'sku' ? 'Variação' : 'Produto', forte: true, render: (l) => esc(st.nivelProduto === 'sku' ? (l.descricao ?? l.produto) : l.produto) },
      { chave: 'sku', rot: 'SKU', render: (l) => `<span class="pill">${esc(l.sku ?? '—')}</span>` },
      { chave: 'categoria', rot: 'Categoria', render: (l) => esc(l.categoria ?? '—') },
      { chave: 'qtd', rot: 'Qtd vendida', num: true, forte: true, render: (l) => fNum(l.qtd) },
      { chave: 'valor', rot: 'Valor vendido', num: true, forte: true, render: (l) => fMoedaC(l.valor) },
      { chave: 'pct_valor', rot: '% do total', num: true, render: (l) => fPct(l.pct_valor) },
      { chave: 'pedidos', rot: 'Pedidos', num: true, render: (l) => fNum(l.pedidos) },
      { chave: 'clientes', rot: 'Clientes', num: true, render: (l) => fNum(l.clientes) },
      { chave: 'estados', rot: 'Estados', num: true, render: (l) => fNum(l.estados) },
    ], vis, {
      ordem: { col: st.ordemProdutos.startsWith('qtd') ? 'qtd' : 'valor', dir: st.ordemProdutos.endsWith('asc') ? 'asc' : 'desc' },
      // no nivel "produto" a linha abre a grade de SKUs; no nivel SKU nao ha o que abrir
      clicavel: st.nivelProduto === 'produto',
      dataset: (l) => (st.nivelProduto === 'produto' ? `data-produto="${esc(l.produto)}"` : ''),
    });
    $('#tab-produtos').onclick = (e) => {
      const tr = e.target.closest('tr[data-produto]');
      if (tr) abrirProduto(tr.dataset.produto);
    };
  }
  $('#busca-produto').addEventListener('input', () => renderTabProdutos());
  $('#seg-nivel').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-nivel]');
    if (!b) return;
    st.nivelProduto = b.dataset.nivel;
    $$('#seg-nivel button').forEach((x) => x.classList.toggle('ativo', x === b));
    renderTabProdutos();
  });

  async function renderTabReps() {
    const linhas = await api('representantes');
    tabela('#tab-reps', [
      { chave: 'representante', rot: 'Representante', forte: true, render: (l) => esc(l.representante) },
      { chave: 'valor', rot: 'Valor vendido', num: true, forte: true, render: (l) => fMoedaC(l.valor) },
      { chave: 'pct_valor', rot: '% do total', num: true, render: (l) => `${fPct(l.pct_valor)} <span class="mini-barra"><i style="width:${Math.min(100, l.pct_valor)}%"></i></span>` },
      { chave: 'valor_faturado', rot: 'Faturado', num: true, render: (l) => fMoedaC(l.valor_faturado) },
      { chave: 'pedidos', rot: 'Pedidos', num: true, render: (l) => fNum(l.pedidos) },
      { chave: 'clientes', rot: 'Clientes', num: true, render: (l) => fNum(l.clientes) },
      { chave: 'estados', rot: 'Estados', num: true, render: (l) => fNum(l.estados) },
      { chave: 'cidades', rot: 'Cidades', num: true, render: (l) => fNum(l.cidades) },
      { chave: 'ticket_medio', rot: 'Ticket médio', num: true, render: (l) => fMoeda(l.ticket_medio) },
    ], linhas, {
      ordem: { col: 'valor', dir: 'desc' },
      clicavel: true,
      dataset: (l) => `data-rep="${esc(l.representante)}"`,
    });
    $('#tab-reps').onclick = (e) => {
      const tr = e.target.closest('tr[data-rep]');
      if (!tr) return;
      st.filtros.rep = [tr.dataset.rep];
      montarDropdowns();
      irPara('dashboard');
      aplicarFiltros();
    };
  }

  /** Cartoes de KPI num container, no mesmo formato dos do dashboard. */
  function renderCards(alvo, cards) {
    $(alvo).innerHTML = cards.map((c) => `
      <div class="kpi${c.destaque ? ' destaque' : ''}">
        <div class="kpi-rot">${c.rot}</div>
        <div class="kpi-val">${c.val}</div>
        <div class="kpi-sub">${c.sub}</div>
      </div>`).join('');
  }

  /** Variacao percentual com sinal e cor. */
  function variacao(v) {
    if (v == null) return '—';
    return `<span class="pill ${v >= 0 ? 'ok' : 'alta'}">${v >= 0 ? '+' : ''}${fPct(v * 100)}</span>`;
  }

  // ============================ VENDAS (YoY) ============================
  async function renderVendas() {
    const [v, d] = await Promise.all([api('comercial/visao'), api('comercial/vendas')]);
    renderCards('#kpis-vendas', [
      { rot: 'Faturado no período', val: fMoeda(v.faturado.total), destaque: true,
        sub: `${fNum(v.faturado.pedidos)} pedidos · ticket ${fMoeda(v.faturado.ticket)}` },
      { rot: 'Pedidos em aberto', val: fMoeda(v.aberto.total),
        sub: `${fNum(v.aberto.pedidos)} pedidos · ticket ${fMoeda(v.aberto.ticket)}` },
      { rot: 'Média mensal', val: fMoeda(v.media_mensal),
        sub: `${fNum(v.meses_com_venda)} meses com venda` },
      { rot: v.mes_atual.em_curso ? 'Mês em curso' : 'Último mês fechado',
        val: fMoeda(v.mes_atual.valor),
        sub: `${v.mes_atual.nome} · ${fNum(v.mes_atual.pedidos)} pedidos` },
      { rot: 'Clientes novos', val: fNum(v.clientes_novos), sub: 'primeira compra no período' },
      { rot: 'Cadastro → faturamento',
        val: v.tempo_medio_faturamento == null ? '—' : `${v.tempo_medio_faturamento.toFixed(1)} d`,
        sub: v.tempo_medio_base
          ? `média de ${fNum(v.tempo_medio_base)} pedidos com as duas datas`
          : 'sem data de faturamento na planilha' },
    ]);

    renderGraficoYoY(d.series, '#grafico-vendas-mes');

    tabela('#tab-yoy', [
      { chave: 'mes_ref', rot: 'Mês', forte: true, render: (l) => fMesLongo(l.mes_ref) },
      { chave: 'ano_menos_2', rot: 'Ano −2', num: true, render: (l) => (l.ano_menos_2 ? fMoedaC(l.ano_menos_2) : '—') },
      { chave: 'ano_menos_1', rot: 'Ano −1', num: true, render: (l) => (l.ano_menos_1 ? fMoedaC(l.ano_menos_1) : '—') },
      { chave: 'ano_atual', rot: 'Atual', num: true, forte: true, render: (l) => fMoedaC(l.ano_atual) },
      { chave: 'yoy_1', rot: 'YoY', num: true, render: (l) => variacao(l.yoy_1) },
      { chave: 'yoy_2', rot: '2 anos', num: true, render: (l) => variacao(l.yoy_2) },
    ], d.series.filter((s) => s.ano_menos_1 || s.ano_menos_2), { ordem: { col: 'mes_ref', dir: 'desc' } });

    tabela('#tab-vendas-mes', [
      { chave: 'mes_ref', rot: 'Mês', forte: true, render: (l) => fMesLongo(l.mes_ref) },
      { chave: 'valor', rot: 'Valor', num: true, forte: true, render: (l) => fMoedaC(l.valor) },
      { chave: 'pedidos', rot: 'Pedidos', num: true, render: (l) => fNum(l.pedidos) },
      { chave: 'ticket', rot: 'Ticket médio', num: true,
        ordenaPor: (l) => (l.pedidos ? l.valor / l.pedidos : 0),
        render: (l) => fMoeda(l.pedidos ? l.valor / l.pedidos : 0) },
      { chave: 'clientes_ativos', rot: 'Clientes ativos', num: true, render: (l) => fNum(l.clientes_ativos) },
      { chave: 'clientes_novos', rot: 'Clientes novos', num: true, render: (l) => fNum(l.clientes_novos) },
      { chave: 'declarado', rot: 'Declarado na planilha', num: true, render: (l) => (l.declarado ? fMoedaC(l.declarado) : '—') },
    ], d.series, { ordem: { col: 'mes_ref', dir: 'desc' } });
  }

  // ================= CARTEIRA: concentracao + recencia =================
  let carteiraCache = null;
  let filtroEstadoCarteira = 'todos';

  async function renderCarteira() {
    const [co, ca] = await Promise.all([api('comercial/concentracao'), api('comercial/carteira')]);
    carteiraCache = ca;

    renderCards('#kpis-concentracao', [
      { rot: 'Top 5 clientes', val: fPct(co.top5 * 100), destaque: true,
        sub: 'da receita em apenas 5 clientes' },
      { rot: 'Top 10 clientes', val: fPct(co.top10 * 100), sub: `${fCompacto(co.valor_top10)} faturados` },
      { rot: 'Top 20 clientes', val: fPct(co.top20 * 100),
        sub: `cauda: ${fNum(co.cauda_clientes)} clientes somam ${fPct(co.cauda_share * 100)}` },
      { rot: 'Clientes p/ 80%', val: fNum(co.clientes_para_80),
        sub: `de ${fNum(co.clientes)} fazem 80% da receita` },
      { rot: 'Índice HHI', val: fNum(co.hhi),
        sub: `concentração ${co.hhi_nivel}${co.hhi > 2500 ? ' (acima de 2.500)' : ''}` },
      { rot: 'Recorrentes', val: fNum(co.recorrentes),
        sub: `${fPct(co.recorrentes_share * 100)} da receita (2+ pedidos)` },
    ]);

    const maxP = d3.max(co.pareto, (p) => p.valor) || 1;
    $('#barras-pareto').innerHTML = co.pareto.map((p, i) => `
      <div class="barra" data-cliente="${esc(p.cliente_chave)}" data-nome="${esc(p.cliente_nome)}">
        <div>
          <div class="barra-nome">${i + 1}. ${esc(p.cliente_nome)}</div>
          <div class="barra-trilha"><i style="width:${(p.valor / maxP) * 100}%"></i></div>
        </div>
        <div>
          <div class="barra-val">${fCompacto(p.valor)}</div>
          <div class="barra-qtd">${fPct(p.part * 100)} · acum. ${fPct(p.acumulado * 100)}</div>
        </div>
      </div>`).join('');

    $('#dica-carteira').textContent = `referência: ${fMesLongo(ca.referencia)} (último mês fechado)`;
    const baldes = [
      { k: 'ativo', rot: 'Ativos', cls: '', sub: 'compraram no mês de referência ou depois' },
      { k: 'risco', rot: 'Em risco', cls: 'media', sub: '1 a 2 meses sem comprar' },
      { k: 'dormente', rot: 'Dormentes', cls: 'alta', sub: '3+ meses sem comprar' },
    ];
    $('#cards-carteira').innerHTML = baldes.map((b) => `
      <div class="ca ${b.cls}">
        <div class="r">${b.rot}</div>
        <div class="v">${fNum(ca[b.k].clientes)}</div>
        <div class="s">${fCompacto(ca[b.k].valor)} · ${fPct(ca[b.k].share * 100)} da receita<br>${b.sub}</div>
      </div>`).join('')
      + `<div class="ca"><div class="r">Compra única</div><div class="v">${fNum(ca.compra_unica.clientes)}</div>
         <div class="s">${fCompacto(ca.compra_unica.valor)} · um pedido só no período</div></div>`;

    renderTabCarteira();
  }

  function renderTabCarteira() {
    if (!carteiraCache) return;
    const termo = $('#busca-carteira').value.trim().toUpperCase();
    let linhas = carteiraCache.clientes;
    if (filtroEstadoCarteira !== 'todos') linhas = linhas.filter((c) => c.estado === filtroEstadoCarteira);
    if (termo) linhas = linhas.filter((c) => (c.cliente_nome ?? '').toUpperCase().includes(termo));
    const rotEstado = { ativo: 'ATIVO', risco: 'EM RISCO', dormente: 'DORMENTE' };
    const clsEstado = { ativo: 'ok', risco: 'media', dormente: 'alta' };
    tabela('#tab-carteira', [
      { chave: 'cliente_nome', rot: 'Cliente', forte: true,
        render: (l) => `${esc(l.cliente_nome)}${l.top10 ? ' <span class="pill">TOP 10</span>' : ''}` },
      { chave: 'estado', rot: 'Situação',
        render: (l) => `<span class="pill ${clsEstado[l.estado]}">${rotEstado[l.estado]}</span>` },
      { chave: 'valor', rot: 'Faturado', num: true, forte: true, render: (l) => fMoedaC(l.valor) },
      { chave: 'part', rot: '% da receita', num: true, render: (l) => fPct(l.part * 100) },
      { chave: 'pedidos', rot: 'Pedidos', num: true, render: (l) => fNum(l.pedidos) },
      { chave: 'ticket', rot: 'Ticket médio', num: true, render: (l) => fMoeda(l.ticket) },
      { chave: 'ultimo_mes', rot: 'Última compra', render: (l) => fMesLongo(l.ultimo_mes) },
      { chave: 'meses_sem_comprar', rot: 'Meses parado', num: true, render: (l) => fNum(l.meses_sem_comprar) },
    ], linhas, {
      ordem: { col: 'valor', dir: 'desc' },
      clicavel: true,
      dataset: (l) => `data-cliente="${esc(l.cliente_chave)}" data-nome="${esc(l.cliente_nome)}"`,
    });
    $('#tab-carteira').onclick = (e) => {
      const tr = e.target.closest('tr[data-cliente]');
      if (tr) abrirCliente(tr.dataset.cliente, tr.dataset.nome);
    };
  }

  // =================== PROSPECCAO + AMOSTRAS ===================
  let campanhasCache = [];

  async function renderProspeccao() {
    const [p, am] = await Promise.all([api('comercial/prospeccao'), api('comercial/amostras')]);
    campanhasCache = p.campanhas;

    const fMult = (v) => (v == null ? '—' : `${v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}×`);
    renderCards('#kpis-prospeccao', [
      { rot: 'Investimento', val: fMoedaC(p.custo_total), destaque: true,
        sub: `${fNum(p.entregues)} entregas × ${fMoedaC(p.custo_unitario_padrao)}` },
      { rot: 'Vendas atribuídas', val: fMoeda(p.vendas), sub: 'informado na aba LEADS' },
      { rot: 'ROAS', val: fMult(p.roas),
        sub: p.roas == null ? 'sem custo apurado' : `R$ ${p.roas.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} vendidos por cada R$ 1 investido` },
      { rot: 'ROI', val: p.roi == null ? '—' : `${p.roi >= 0 ? '+' : ''}${fPct(p.roi * 100)}`,
        sub: p.roi == null ? '—' : `retorno de ${fMoedaC(p.vendas - p.custo_total)}` },
      { rot: 'Custo por lead', val: p.cpl == null ? '—' : fMoedaC(p.cpl),
        sub: `${fNum(p.retornos)} respostas · CPM ${fMoedaC(p.cpm)}` },
      { rot: 'CAC estimado', val: p.cac_estimado == null ? '—' : fMoedaC(p.cac_estimado),
        sub: `${fNum(p.clientes_novos_periodo)} clientes novos nos meses das campanhas` },
    ]);
    renderCards('#kpis-prospeccao-2', [
      { rot: 'Mensagens enviadas', val: fNum(p.enviados), sub: `${fNum(p.n_campanhas)} campanhas` },
      { rot: 'Entregues', val: fNum(p.entregues),
        sub: p.taxa_entrega == null ? 'entrega não medida' : `${fPct(p.taxa_entrega * 100)} dos disparos medidos` },
      { rot: 'Falhas', val: fNum(p.falhas), sub: 'não entregues — sem custo' },
      { rot: 'Retornos', val: fNum(p.retornos), sub: `taxa de resposta ${fPct((p.taxa_resposta ?? 0) * 100)}` },
      { rot: 'Custo por R$ 1 vendido', val: p.custo_por_real_vendido == null ? '—' : fMoedaC(p.custo_por_real_vendido),
        sub: 'quanto se gasta para vender R$ 1' },
      { rot: 'Canais', val: fNum(p.por_canal.length),
        sub: p.por_canal.map((c) => c.canal).join(' · ') || '—' },
    ]);

    const taxaResposta = (l) => (l.entregues || l.enviados ? l.retornos / (l.entregues || l.enviados) : 0);
    tabela('#tab-leads-canal', [
      { chave: 'canal', rot: 'Canal', forte: true, render: (l) => esc(l.canal) },
      { chave: 'campanhas', rot: 'Campanhas', num: true, render: (l) => fNum(l.campanhas) },
      { chave: 'enviados', rot: 'Enviados', num: true, forte: true, render: (l) => fNum(l.enviados) },
      { chave: 'entregues', rot: 'Entregues', num: true, render: (l) => fNum(l.entregues) },
      { chave: 'retornos', rot: 'Retornos', num: true, render: (l) => fNum(l.retornos) },
      { chave: 'resposta', rot: '% resposta', num: true, ordenaPor: taxaResposta,
        render: (l) => fPct(taxaResposta(l) * 100) },
      { chave: 'custo', rot: 'Investimento', num: true, render: (l) => fMoedaC(l.custo) },
      { chave: 'vendas', rot: 'Vendas', num: true, forte: true, render: (l) => fMoedaC(l.vendas) },
      { chave: 'roas', rot: 'ROAS', num: true, ordenaPor: (l) => l.roas ?? -1,
        render: (l) => (l.roas == null ? '—' : l.roas.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + 'x') },
      { chave: 'cpl', rot: 'Custo/lead', num: true, ordenaPor: (l) => l.cpl ?? -1,
        render: (l) => (l.cpl == null ? '—' : fMoedaC(l.cpl)) },
    ], p.por_canal, { ordem: { col: 'enviados', dir: 'desc' } });

    tabela('#tab-leads-segmento', [
      { chave: 'segmento', rot: 'Segmento', forte: true, render: (l) => esc(l.segmento) },
      { chave: 'campanhas', rot: 'Campanhas', num: true, render: (l) => fNum(l.campanhas) },
      { chave: 'enviados', rot: 'Enviados', num: true, forte: true, render: (l) => fNum(l.enviados) },
      { chave: 'retornos', rot: 'Retornos', num: true, render: (l) => fNum(l.retornos) },
      { chave: 'vendas', rot: 'Vendas', num: true, render: (l) => fMoedaC(l.vendas) },
    ], p.por_segmento, { ordem: { col: 'enviados', dir: 'desc' } });

    renderTabCampanhas();

    renderCards('#kpis-amostras', [
      { rot: 'Envios', val: fNum(am.envios), sub: `${fNum(am.clientes)} clientes atendidos` },
      { rot: 'Valor acumulado', val: fMoeda(am.valor), sub: 'não entra no faturamento' },
      { rot: 'Média mensal', val: am.media_mensal_envios.toFixed(1),
        sub: `envios/mês em ${fNum(am.por_mes.length)} meses` },
      { rot: 'Valor médio', val: fMoedaC(am.envios ? am.valor / am.envios : 0), sub: 'por envio' },
    ]);

    tabela('#tab-amostras', [
      { chave: 'cliente', rot: 'Cliente / pessoa', forte: true, render: (l) => esc(l.cliente) },
      { chave: 'envios', rot: 'Envios', num: true, forte: true, render: (l) => fNum(l.envios) },
      { chave: 'valor', rot: 'Valor total', num: true, forte: true, render: (l) => fMoedaC(l.valor) },
      { chave: 'pct_valor', rot: '% do total', num: true, render: (l) => `${fPct(l.pct_valor)} <span class="mini-barra"><i style="width:${Math.min(100, l.pct_valor)}%"></i></span>` },
      { chave: 'valor_medio', rot: 'Valor médio', num: true, render: (l) => fMoedaC(l.valor_medio) },
      { chave: 'meses', rot: 'Meses', num: true, render: (l) => fNum(l.meses) },
      { chave: 'ultimo_envio', rot: 'Último envio', render: (l) => fData(l.ultimo_envio) },
    ], am.por_cliente, {
      ordem: { col: 'valor', dir: 'desc' },
      clicavel: true,
      dataset: (l) => `data-amostra="${esc(l.cliente_chave)}" data-nome="${esc(l.cliente)}"`,
    });
    $('#tab-amostras').onclick = (e) => {
      const tr = e.target.closest('tr[data-amostra]');
      if (tr) abrirAmostrasCliente(tr.dataset.amostra, tr.dataset.nome);
    };

  }

  /** Envios de amostra de um cliente, por data. Aberto ao clicar na linha. */
  async function abrirAmostrasCliente(chave, nome) {
    const d = await api('comercial/amostras-cliente', { cliente: chave });
    if (!d) return;
    const maxMes = d3.max(d.por_mes, (m) => m.valor) || 1;

    abrirGaveta(esc(d.cliente ?? nome), `${fNum(d.envios)} envio${d.envios === 1 ? '' : 's'} · amostras e brindes`, `
      <div class="g-kpis">
        <div class="g-kpi"><div class="r">Envios</div><div class="v">${fNum(d.envios)}</div></div>
        <div class="g-kpi"><div class="r">Valor total</div><div class="v">${fMoeda(d.valor)}</div></div>
        <div class="g-kpi"><div class="r">Valor médio</div><div class="v">${fMoedaC(d.valor_medio)}</div></div>
      </div>

      <dl class="g-dados">
        <dt>Primeiro envio</dt><dd>${fData(d.primeiro_envio)}</dd>
        <dt>Último envio</dt><dd>${fData(d.ultimo_envio)}</dd>
      </dl>

      <div class="g-sec">
        <div class="g-sec-topo"><h4>Envios por data</h4></div>
        <div class="tabela-wrap">
          <table class="tabela">
            <thead><tr><th>Data</th><th class="num">Valor</th><th>NF</th><th>Envio</th><th>Situação</th></tr></thead>
            <tbody>${d.registros.map((r) => `
              <tr>
                <td class="forte">${fData(r.data)}</td>
                <td class="num forte">${fMoedaC(r.valor)}</td>
                <td><span class="pill">${esc(r.nf ?? '—')}</span></td>
                <td>${esc(r.envio ?? '—')}</td>
                <td>${esc(r.observacoes ?? '—')}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>

      ${d.por_mes.length > 1 ? `
      <div class="g-sec">
        <div class="g-sec-topo"><h4>Por mês</h4></div>
        <div class="barras" style="padding:0">
          ${d.por_mes.map((m) => `
            <div class="barra">
              <div>
                <div class="barra-nome">${fMesLongo(m.mes_ref)}</div>
                <div class="barra-trilha"><i style="width:${(m.valor / maxMes) * 100}%"></i></div>
              </div>
              <div><div class="barra-val">${fMoedaC(m.valor)}</div><div class="barra-qtd">${fNum(m.envios)} envios</div></div>
            </div>`).join('')}
        </div>
      </div>` : ''}
    `);
  }

  function renderTabCampanhas() {
    const termo = $('#busca-campanha').value.trim().toUpperCase();
    const vis = termo
      ? campanhasCache.filter((c) => `${c.campanha ?? ''} ${c.segmento ?? ''} ${c.uf ?? ''} ${c.canal ?? ''}`.toUpperCase().includes(termo))
      : campanhasCache;
    tabela('#tab-campanhas', [
      { chave: 'data', rot: 'Envio', render: (l) => (l.data ? fData(l.data) : esc(l.data_raw ?? '—')) },
      { chave: 'canal', rot: 'Canal', render: (l) => esc(l.canal ?? '—') },
      { chave: 'campanha', rot: 'Campanha', forte: true, render: (l) => esc(l.campanha ?? '—') },
      { chave: 'segmento', rot: 'Segmento', render: (l) => esc(l.segmento ?? '—') },
      { chave: 'uf', rot: 'UF', render: (l) => `<span class="pill">${esc(l.uf ?? '—')}</span>` },
      { chave: 'enviados', rot: 'Enviados', num: true, forte: true, render: (l) => fNum(l.enviados) },
      { chave: 'entregues', rot: 'Entregues', num: true, render: (l) => fNum(l.entregues) },
      { chave: 'retornos', rot: 'Retornos', num: true, render: (l) => fNum(l.retornos) },
      { chave: 'vendas', rot: 'Vendas', num: true, render: (l) => fMoedaC(l.vendas) },
    ], vis, { ordem: { col: 'data', dir: 'desc' } });
  }

  $('#busca-carteira').addEventListener('input', renderTabCarteira);
  $('#busca-campanha').addEventListener('input', renderTabCampanhas);
  $('#seg-carteira').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-estado]');
    if (!b) return;
    filtroEstadoCarteira = b.dataset.estado;
    $('#seg-carteira button').forEach((x) => x.classList.toggle('ativo', x === b));
    renderTabCarteira();
  });
  $('#barras-pareto').addEventListener('click', (e) => {
    const b = e.target.closest('.barra[data-cliente]');
    if (b) abrirCliente(b.dataset.cliente, b.dataset.nome);
  });

  // ------------------------------------------------------------- reposicao
  // Esta aba NAO responde aos filtros do topo (representante, periodo, UF):
  // estoque e ordem de compra sao saldos de hoje, nao um recorte de vendas.
  // Por isso a barra de filtros some quando ela esta aberta.
  const REP_SITUACOES = [
    { chave: 'ruptura', rot: 'Em ruptura', dica: 'estoque zerado' },
    { chave: 'critico', rot: 'Crítico', dica: 'menos de 1 mês de cobertura' },
    { chave: 'atencao', rot: 'Atenção', dica: 'zera dentro da projeção' },
    { chave: 'ok', rot: 'Saudável', dica: 'atravessa a projeção com saldo' },
    { chave: 'parado', rot: 'Sem giro', dica: 'nenhuma venda em 90 dias' },
  ];

  const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const rotuloMes = (m) => `${MESES_CURTOS[Number(m.split('-')[1]) - 1]}/${m.slice(2, 4)}`;

  /** Classe de cor do saldo projetado. */
  const corSaldo = (n) => (n < 0 ? 'neg' : n === 0 ? 'zero' : 'pos');

  async function renderReposicao() {
    const d = await api('reposicao', {
      categoria: st.repCategoria ?? 'todas',
      situacao: st.repSituacao ?? 'todas',
      busca: $('#busca-reposicao').value.trim(),
      sazonal: st.repSazonal ?? '1',
    });

    // Categorias so na primeira carga, para nao perder a selecao atual.
    const sel = $('#cat-reposicao');
    if (sel.options.length <= 1) {
      const cats = await api('reposicao/categorias');
      sel.innerHTML = '<option value="todas">Todas as categorias</option>'
        + cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
      sel.value = st.repCategoria ?? 'todas';
    }

    const r = d.resumo;
    renderCards('#kpis-reposicao', [
      { rot: 'SKUs acompanhados', val: fNum(r.skus), sub: `${fNum(r.sem_cadastro)} sem cadastro no ERP` },
      { rot: 'Estoque hoje', val: `${fNum(r.estoque_un)} un`, sub: `${fMoeda(r.estoque_valor)} a preço de tabela`, destaque: true },
      { rot: 'Vendido no mês', val: `${fNum(r.venda_mes_un)} un`, sub: `${fNum(r.venda_90d_un)} un em 90 dias` },
      { rot: 'Entrada prevista', val: `${fNum(r.entrada_prevista_un)} un`, sub: `${fNum(r.em_transito_un)} un já a caminho` },
      { rot: 'Precisa de compra', val: fNum(r.ruptura + r.critico), sub: `${fNum(r.ruptura)} zerados · ${fNum(r.critico)} críticos` },
      { rot: 'Estoque sem giro', val: fNum(r.parado), sub: `${fMoeda(r.parado_valor)} parados há 90 dias` },
    ]);

    $('#rep-situacoes').innerHTML = [{ chave: 'todas', rot: 'Todos', dica: 'sem filtro de situação' }, ...REP_SITUACOES]
      .map((s) => {
        const n = s.chave === 'todas' ? r.skus : r[s.chave];
        const ativo = (st.repSituacao ?? 'todas') === s.chave;
        return `<button class="rep-chip ${s.chave} ${ativo ? 'ativo' : ''}" data-sit="${s.chave}" title="${esc(s.dica)}">
                  <i></i>${s.rot}<b>${fNum(n)}</b></button>`;
      }).join('');

    const faixas = d.sazonalidade.fatores.map((f) => {
      const txt = f.sem_base ? 'sem base histórica' : `${f.fator.toFixed(2)}× a média`;
      return `<span class="rep-fator ${f.sem_base ? 'sem-base' : ''}">${rotuloMes(f.mes)}: ${txt}</span>`;
    }).join('');
    $('#rep-legenda').innerHTML = d.sazonalidade.ativa
      ? `<span class="rep-legenda-rot">Peso na projeção:</span>${faixas}
         <span class="rep-legenda-obs">base de ${d.sazonalidade.meses_base} meses fechados</span>`
      : '<span class="rep-legenda-rot">Sem sazonalidade:</span><span class="rep-fator">todo mês repete a média de 90 dias</span>';

    const colsMes = d.meses.map((m, i) => ({
      chave: `m${i}`,
      rot: rotuloMes(m),
      num: true,
      ordenaPor: (l) => l.projecao[i].saldo,
      render: (l) => {
        const p = l.projecao[i];
        const entrada = p.entrada > 0 ? `<span class="rep-entrada" title="entrada prevista de ordem de compra">+${fNum(p.entrada)}</span>` : '';
        return `<span class="rep-saldo ${corSaldo(p.saldo)}">${fNum(p.saldo)}</span>${entrada}`;
      },
    }));

    tabela('#tab-reposicao', [
      {
        chave: 'produto',
        rot: 'Produto',
        forte: true,
        render: (l) => `<span class="rep-prod">${esc(l.produto)}</span>`
          + `<span class="rep-var">${esc([l.cor, l.tamanho].filter(Boolean).join(' · '))}</span>`,
      },
      {
        chave: 'sku',
        rot: 'SKU',
        render: (l) => `<span class="pill">${esc(l.sku)}</span>`
          + (l.sem_cadastro ? '<span class="rep-tag" title="SKU do portal sem cadastro no Tiny: fica sem estoque e sem projeção">sem ERP</span>' : ''),
      },
      { chave: 'estoque', rot: 'Estoque', num: true, forte: true, render: (l) => (l.estoque === null ? '<span class="rep-sem">—</span>' : fNum(l.estoque)) },
      // Rotulos curtos: a coluna tem ~99px no layout fixo e "Vendas do mês"
      // era cortado no meio. O contexto da aba ja diz que sao unidades vendidas.
      { chave: 'un_mes', rot: 'Mês atual', num: true, render: (l) => fNum(l.un_mes) },
      { chave: 'un_90d', rot: '90 dias', num: true, render: (l) => fNum(l.un_90d) },
      { chave: 'media_mes', rot: 'Média mês', num: true, forte: true, render: (l) => fNum(Math.round(l.media_mes)) },
      {
        chave: 'cobertura_meses',
        rot: 'Cobertura',
        num: true,
        // sem venda nao tem cobertura: vai para o fim da ordenacao, nao para o topo
        ordenaPor: (l) => (l.cobertura_meses === null ? 9999 : l.cobertura_meses),
        render: (l) => {
          if (l.cobertura_meses === null) return '<span class="rep-sem">—</span>';
          const largura = Math.min(100, (l.cobertura_meses / 6) * 100);
          return `<span class="rep-cob ${l.situacao}">${l.cobertura_meses.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} m</span>`
            + `<span class="mini-barra"><i style="width:${largura}%"></i></span>`;
        },
      },
      {
        chave: 'entrada_total',
        rot: 'Entrada',
        num: true,
        render: (l) => {
          if (!l.entrada_total) return '<span class="rep-sem">—</span>';
          // "a caminho" ja esta somado ao saldo inicial da cascata; marcar deixa
          // claro que aquelas unidades nao aparecem em nenhuma coluna de mes.
          const transito = l.em_transito
            ? `<span class="rep-entrada" title="previsto para este mês ou atrasado; já somado ao saldo de partida">${fNum(l.em_transito)} a caminho</span>`
            : '';
          return `${fNum(l.entrada_total)}${transito}`;
        },
      },
      ...colsMes,
    ], d.linhas, {
      ordem: { col: 'cobertura_meses', dir: 'asc' },
      dataset: (l) => `data-sit="${l.situacao}"`,
    });

    const f = d.fontes;
    const quando = (x) => (x ? new Date(x).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca');
    $('#rep-rodape').innerHTML = `
      <span class="rep-fonte">Estoque (Tiny B2B): ${fNum(f.estoque.skus)} SKUs · ${quando(f.estoque.quando)}</span>
      <span class="rep-fonte">Vendas (planilha + ERP): ${quando(f.vendas.quando)}</span>
      ${f.ocs.erro
        ? `<span class="rep-fonte erro">Previsão de entrada indisponível — ${esc(f.ocs.erro)}</span>`
        : `<span class="rep-fonte">Ordens de compra (Matriz): ${fNum(f.ocs.itens)} itens · ${quando(f.ocs.quando)}</span>`}`;
  }

  $('#busca-reposicao').addEventListener('input', () => renderReposicao());
  $('#cat-reposicao').addEventListener('change', (e) => {
    st.repCategoria = e.target.value;
    renderReposicao();
  });
  $('#rep-situacoes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sit]');
    if (!b) return;
    st.repSituacao = b.dataset.sit;
    renderReposicao();
  });
  $('#seg-sazonal').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sazonal]');
    if (!b) return;
    st.repSazonal = b.dataset.sazonal;
    $$('#seg-sazonal button').forEach((x) => x.classList.toggle('ativo', x === b));
    renderReposicao();
  });

  async function renderAlertas() {
    const [al, ex] = await Promise.all([api('alertas'), api('excluidos')]);
    const rots = {
      sem_pedido_no_olist: 'Na planilha, ausente no Olist',
      sem_localizacao: 'Sem cidade/UF (fora do mapa)',
      ausente_na_planilha: 'No Olist, ausente na planilha',
      linha_sem_numero: 'Linha sem número de pedido',
      sem_estado: 'Clientes sem estado',
      sem_cidade: 'Clientes sem cidade',
      cidade_nao_geolocalizada: 'Cidades fora da base do IBGE',
      uf_invalida: 'Estados inválidos',
      sem_representante: 'Pedidos sem representante',
      sku_ausente: 'Itens sem SKU',
      sku_nomes_divergentes: 'SKU com nomes diferentes no ERP',
      pedido_duplicado: 'Pedidos duplicados',
      planilha_sem_pedido: 'Na planilha, ausente na API',
      divergencia_valor: 'Divergência de valor',
      divergencia_mes: 'Divergência do total do mês',
    };
    $('#resumo-alertas').innerHTML = al.por_tipo.length
      ? al.por_tipo.map((t) => `
        <div class="ca ${esc(t.gravidade)}">
          <div class="r">${esc(rots[t.tipo] ?? t.tipo)}</div>
          <div class="v">${fNum(t.n)}</div>
          <div class="s">gravidade ${esc(t.gravidade)}${t.valor ? ` · ${fCompacto(t.valor)}` : ''}</div>
        </div>`).join('')
      : '<div class="g-vazio">Nenhuma inconsistência encontrada.</div>';

    tabela('#tab-alertas', [
      { chave: 'gravidade', rot: 'Gravidade', render: (l) => `<span class="pill ${esc(l.gravidade)}">${esc(l.gravidade)}</span>` },
      { chave: 'tipo', rot: 'Tipo', render: (l) => esc(rots[l.tipo] ?? l.tipo) },
      { chave: 'chave', rot: 'Referência', forte: true, render: (l) => esc(l.chave ?? '—') },
      { chave: 'detalhe', rot: 'Detalhe', render: (l) => esc(l.detalhe) },
      { chave: 'valor', rot: 'Valor', num: true, render: (l) => (l.valor ? fMoedaC(l.valor) : '—') },
    ], al.itens, { ordem: { col: 'gravidade', dir: 'asc' } });

    tabela('#tab-excluidos', [
      { chave: 'motivo_exclusao', rot: 'Motivo', forte: true, render: (l) => esc(l.motivo_exclusao ?? '—') },
      { chave: 'pedidos', rot: 'Pedidos', num: true, render: (l) => fNum(l.pedidos) },
      { chave: 'valor', rot: 'Valor', num: true, render: (l) => fMoedaC(l.valor) },
    ], ex, { ordem: { col: 'valor', dir: 'desc' } });
  }

  // ------------------------------------------------------------------ admin
  async function renderAdmin() {
    const s = await api('admin/status');
    const b = s.banco;
    const ur = s.ultimo_resultado;
    const dt = s.ultima_sync
      ? new Date(s.ultima_sync).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
      : 'nunca';

    $('#admin-status').innerHTML = `
      <div class="as ${s.ultima_sync ? 'ok' : 'ruim'}">
        <div class="r">Última atualização</div><div class="v">${dt}</div>
        <div class="s">${s.sync_em_andamento ? `em andamento: ${esc(s.etapa ?? '')} ${s.total_progresso ? `(${s.progresso}/${s.total_progresso})` : ''}` : 'concluída'}</div>
      </div>
      <div class="as"><div class="r">Pedidos sincronizados</div><div class="v">${fNum(b.pedidos)}</div>
        <div class="s">${fNum(b.validos)} contam como venda · ${fNum(b.itens)} itens</div></div>
      <div class="as"><div class="r">Clientes</div><div class="v">${fNum(b.clientes)}</div>
        <div class="s">${fNum(b.estados)} estados · ${fNum(b.cidades)} cidades</div></div>
      <div class="as"><div class="r">Período coberto</div><div class="v">${fData(b.primeira)} → ${fData(b.ultima)}</div>
        <div class="s">janela ${esc(ur?.janela?.de ?? '—')} a ${esc(ur?.janela?.ate ?? '—')}</div></div>
      <div class="as"><div class="r">Planilha comercial</div><div class="v">${fNum(s.planilha.linhas)} linhas</div>
        <div class="s">${fNum(s.planilha.conciliadas)} conciliadas com a API</div></div>
      <div class="as ${s.api.erros ? 'ruim' : 'ok'}"><div class="r">Chamadas à API</div><div class="v">${fNum(s.api.chamadas)}</div>
        <div class="s">${fNum(s.api.erros)} erros${s.api.ultimo_erro ? ` · último: ${esc(String(s.api.ultimo_erro.contexto))}` : ''}</div></div>
      <div class="as ${s.alertas ? '' : 'ok'}"><div class="r">Alertas de dados</div><div class="v">${fNum(s.alertas)}</div>
        <div class="s">${ur ? `${fNum(ur.reaproveitados_do_cache ?? 0)} pedidos vindos do cache` : ''}</div></div>`;

    // Modo somente-leitura: sem credenciais nao ha o que sincronizar. Esconder
    // os botoes evita o pior caso -- clicar, ler "iniciado" e nada mudar.
    const aviso = $('#aviso-leitura');
    for (const id of ['#btn-sync', '#btn-sync-full', '#btn-conexao']) {
      $(id).hidden = Boolean(s.somente_leitura);
    }
    aviso.hidden = !s.somente_leitura;
    if (s.somente_leitura) {
      aviso.innerHTML = 'Modo somente-leitura: este computador não tem as credenciais da API. '
        + 'Os dados vêm do snapshot que veio no repositório'
        + (s.banco_do_snapshot ? ' (adotado nesta inicialização)' : '')
        + '. Para receber dados novos: <code>git pull</code> e reinicie o servidor.';
    }

    atualizarBadgeAlertas(s.alertas);

    const conf = s.planilha.totais_mensais ?? [];
    const mesesApi = await api('meses');
    const mapaApi = new Map(mesesApi.map((m) => [m.mes_ref, m.valor]));
    tabela('#tab-conferencia', [
      { chave: 'mes_ref', rot: 'Mês', forte: true, render: (l) => fMesLongo(l.mes_ref) },
      { chave: 'total_planilha', rot: 'Planilha', num: true, render: (l) => fMoedaC(l.total_planilha) },
      { chave: 'api', rot: 'Consolidado', num: true, ordenaPor: (l) => mapaApi.get(l.mes_ref) ?? 0, render: (l) => fMoedaC(mapaApi.get(l.mes_ref) ?? 0) },
      {
        chave: 'dif', rot: 'Diferença', num: true,
        ordenaPor: (l) => (mapaApi.get(l.mes_ref) ?? 0) - (l.total_planilha ?? 0),
        render: (l) => {
          const d = (mapaApi.get(l.mes_ref) ?? 0) - (l.total_planilha ?? 0);
          const pct = l.total_planilha ? (d / l.total_planilha) * 100 : 0;
          return `<span class="pill ${Math.abs(pct) <= 5 ? 'ok' : 'media'}">${d >= 0 ? '+' : ''}${fMoeda(d)} (${fPct(pct)})</span>`;
        },
      },
    ], conf, { ordem: { col: 'mes_ref', dir: 'desc' } });

    tabela('#tab-abas', [
      { chave: 'nome', rot: 'Aba', forte: true, render: (l) => esc(l.nome) },
      { chave: 'tipo', rot: 'Tipo', render: (l) => `<span class="pill ${l.tipo === 'ignorada' ? '' : 'ok'}">${esc(l.tipo)}</span>` },
      { chave: 'mes_ref', rot: 'Mês', render: (l) => (l.mes_ref ? fMesLongo(l.mes_ref) : '—') },
      { chave: 'linhas', rot: 'Linhas lidas', num: true, render: (l) => fNum(l.linhas) },
    ], s.planilha.abas ?? [], { ordem: { col: 'linhas', dir: 'desc' } });

    // Ajustes manuais de carteira: ficam visiveis para nao virarem regra oculta
    const aj = s.ajustes_carteira ?? { ajustes: [], total: 0 };
    $('#dica-ajustes').textContent = aj.erro
      ? `erro em ${aj.arquivo}: ${aj.erro}`
      : `${aj.total} cliente(s) · editável em ${aj.arquivo}`;
    tabela('#tab-ajustes', [
      { chave: 'cliente', rot: 'Cliente', forte: true, render: (l) => esc(l.cliente ?? '—') },
      { chave: 'cnpj', rot: 'CNPJ', render: (l) => esc(l.cnpj ?? '—') },
      { chave: 'representante', rot: 'Passa a ser', render: (l) => esc(l.representante) },
      { chave: 'definido_em', rot: 'Definido em', render: (l) => esc(l.definido_em ?? '—') },
      { chave: 'obs', rot: 'Motivo', render: (l) => esc(l.obs ?? '—') },
    ], aj.ajustes ?? [], { ordem: { col: 'cliente', dir: 'asc' } });
  }

  let pollSync = null;
  async function dispararSync(full) {
    const saida = $('#admin-saida');
    saida.hidden = false;
    saida.textContent = `Iniciando sincronização${full ? ' completa' : ''}...\n`;
    $('#btn-sync').disabled = true;
    $('#btn-sync-full').disabled = true;
    try {
      const r = await fetch('/api/admin/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.erro ?? 'falha ao iniciar');
      clearInterval(pollSync);
      pollSync = setInterval(async () => {
        const s = await api('admin/status');
        saida.textContent = `Etapa: ${s.etapa ?? '—'}${s.total_progresso ? ` (${s.progresso}/${s.total_progresso})` : ''}\n`
          + `Chamadas à API: ${s.api.chamadas} · erros: ${s.api.erros}\n`;
        if (!s.sync_em_andamento) {
          clearInterval(pollSync);
          saida.textContent += `\nConcluída em ${new Date(s.ultima_sync).toLocaleString('pt-BR')}\n`
            + JSON.stringify(s.ultimo_resultado, null, 2);
          $('#btn-sync').disabled = false;
          $('#btn-sync-full').disabled = false;
          await carregarOpcoes();
          await aplicarFiltros();
          renderAdmin();
        }
      }, 2500);
    } catch (e) {
      saida.textContent += `ERRO: ${e.message}\n`;
      $('#btn-sync').disabled = false;
      $('#btn-sync-full').disabled = false;
    }
  }
  $('#btn-sync').addEventListener('click', () => dispararSync(false));
  $('#btn-sync-full').addEventListener('click', () => dispararSync(true));
  $('#btn-conexao').addEventListener('click', async () => {
    const saida = $('#admin-saida');
    saida.hidden = false;
    saida.textContent = 'Testando conexão com a API do Tiny/Olist...\n';
    try {
      const j = await api('admin/conexao');
      saida.textContent = Object.entries(j).map(([conta, r]) => r.ok
        ? `[OK]   conta ${conta}: ${r.empresa ?? '(sem razão social)'}${r.cnpj ? ` · ${r.cnpj}` : ''}`
        : `[FALHA] conta ${conta}: ${r.erro}`).join('\n');
    } catch (e) {
      saida.textContent = `ERRO: ${e.message}`;
    }
  });

  // ------------------------------------------------------------ orquestracao
  async function carregarOpcoes() {
    st.opcoes = await api('filtros');
    montarDropdowns();
  }

  async function aplicarFiltros() {
    atualizarRotulosFiltro();
    // o filtro de UF manda no mapa: se o usuario escolher um estado, entra nele
    if (st.filtros.uf.length === 1 && st.filtros.uf[0] !== 'EX' && st.nivel.uf !== st.filtros.uf[0]) {
      st.nivel.uf = st.filtros.uf[0];
    } else if (st.filtros.uf.length > 0 && st.nivel.uf && !st.filtros.uf.includes(st.nivel.uf)) {
      st.nivel.uf = null;
    }
    if (st.nivel.uf === 'EX') st.nivel.uf = null;

    const d = await api('dashboard');
    st.estados = d.estados;
    // Panorama para o balao e para o clique em outro estado. Sem recorte de UF
    // os dois sao a mesma coisa, e ai nao vale uma segunda chamada.
    st.panorama = st.filtros.uf.length ? await apiPanorama('estados') : d.estados;
    renderKpis(d.resumo);
    MapaBrasil.definirEstados(st.estados);
    renderGraficoMeses(d.meses);
    renderGraficoFaturamento(d.faturamento);
    renderBarrasProdutos('#barras-produtos', d.produtos);

    if (st.nivel.uf) {
      st.cidades = await api('cidades', { uf: st.nivel.uf });
      // `focar` ANTES de `definirCidades`: `desenharBolhas` só desenha quando o
      // mapa ja tem uma UF selecionada (`visiveis = ufSelecionada ? cidades : []`).
      // Na ordem inversa as bolhas nao apareciam -- a camada ficava vazia.
      MapaBrasil.focar(st.nivel.uf, { animar: false });
      MapaBrasil.definirCidades(st.cidades);
    } else {
      st.cidades = [];
      MapaBrasil.definirCidades([]);
    }
    renderBreadcrumb();
    renderRankingLateral();
    $('#mapa-vazio').hidden = st.estados.length > 0;
    if (st.view !== 'dashboard') renderView();
  }

  async function iniciar() {
    try {
      aplicarVisibilidadeAlertas();
      await carregarOpcoes();
      await iniciarMapa();
      await aplicarFiltros();
      const s = await api('admin/status');
      atualizarBadgeAlertas(s.alertas);
      if (!s.banco.pedidos) {
        irPara('admin');
        $('#admin-saida').hidden = false;
        $('#admin-saida').textContent = 'Banco vazio. Clique em "Sincronizar dados agora" para carregar os pedidos da API e da planilha.';
      }
    } catch (e) {
      document.body.insertAdjacentHTML('afterbegin',
        `<div style="padding:14px 20px;background:#fdeaee;color:#a3162f;font-size:13px">
           Falha ao iniciar: ${esc(e.message)}
         </div>`);
      console.error(e);
    }
  }

  iniciar();
})();
