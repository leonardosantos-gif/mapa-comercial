/* global d3 */
/**
 * Mapa do Brasil: heat map por UF -> zoom no estado -> bolhas por cidade.
 * A malha das UFs vem do IBGE (/api/geo/estados) e as coordenadas das cidades
 * vem da base de municipios do IBGE (resolvidas no backend).
 */
const MapaBrasil = (() => {
  // Rampa do vermelho da marca, dessaturada nos tons medios: areas grandes com
  // vermelho cheio ficam agressivas e competem com os rotulos e os cartoes.
  const RAMPA = ['#fbeef0', '#f6dade', '#eab8c0', '#dc909f', '#c96579', '#b23f57', '#8e2338'];
  const NEUTRO = '#edf0f4'; // estado sem venda: visualmente neutro

  let svg, gUf, gRot, gBolhas, gRotBolhas, projecao, caminho, zoom;
  let geo = null;
  let mapaUf = new Map();      // codigo IBGE -> sigla
  let dadosEstados = new Map(); // sigla -> agregado
  let escala = null;
  let ufSelecionada = null;
  let municipioSelecionado = null;
  let cidades = [];
  let cfg = {};
  let larg = 0, alt = 0;

  const val = (d, metrica) =>
    metrica === 'pedidos' ? d.pedidos : metrica === 'produtos' ? d.pecas : d.valor;

  async function iniciar(seletor, opcoes) {
    cfg = opcoes;
    svg = d3.select(seletor);
    svg.selectAll('*').remove();

    const gRaiz = svg.append('g').attr('class', 'raiz');
    gUf = gRaiz.append('g').attr('class', 'camada-uf');
    gRot = gRaiz.append('g').attr('class', 'camada-rot-uf');
    gBolhas = gRaiz.append('g').attr('class', 'camada-bolhas');
    gRotBolhas = gRaiz.append('g').attr('class', 'camada-rot-bolhas');

    // `cache: 'no-cache'` revalida sempre (304 quando nao mudou). Sem isso, uma
    // malha antiga cacheada continua sendo usada mesmo depois de corrigida no
    // servidor -- foi o que escondeu a correcao de orientacao dos aneis.
    const semCache = { cache: 'no-cache' };
    const [malha, ufs] = await Promise.all([
      fetch('/api/geo/estados', semCache).then((r) => r.json()),
      fetch('/api/geo/ufs', semCache).then((r) => r.json()),
    ]);
    geo = malha;
    mapaUf = new Map(ufs.map((u) => [String(u.codigo), u.sigla]));
    const nomes = new Map(ufs.map((u) => [u.sigla, u.nome]));
    geo.features.forEach((f) => {
      f.properties.sigla = mapaUf.get(String(f.properties.codarea)) ?? null;
      f.properties.nome = nomes.get(f.properties.sigla) ?? f.properties.sigla;
    });

    zoom = d3.zoom()
      .scaleExtent([1, 42])
      .on('zoom', (ev) => {
        gRaiz.attr('transform', ev.transform);
        // mantem espessura de traco e tamanho de rotulo estaveis no zoom
        const k = ev.transform.k;
        // style() e obrigatorio aqui: font-size/stroke-width definidos como ATRIBUTO
        // perdem para a regra CSS da classe, e os rotulos nao encolheriam no zoom.
        escalarRotulos(k);
      });
    svg.call(zoom).on('dblclick.zoom', null);

    dimensionar();
    window.addEventListener('resize', () => { if (dimensionar()) desenhar(); });
    // O container mede 0 enquanto a aba do dashboard esta oculta. O observer
    // reprojeta assim que ele ganha tamanho real, sem esperar um resize da janela.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        if (dimensionar()) {
          desenhar();
          if (ufSelecionada) focar(ufSelecionada, { animar: false });
        }
      }).observe(svg.node());
    }
    return true;
  }

  /**
   * Mantem rotulos e tracos com tamanho constante na tela, qualquer que seja o zoom.
   *
   * Usa style() de proposito: font-size/stroke-width definidos como ATRIBUTO de
   * apresentacao perdem para a regra CSS da classe (.uf-rot / .bolha-rot). Era o
   * que fazia os nomes das cidades e das UFs virarem letras gigantes sobrepostas
   * ao dar zoom num estado.
   */
  function escalarRotulos(k) {
    const escalaAtual = k ?? (svg.node() ? d3.zoomTransform(svg.node()).k : 1) ?? 1;
    gUf.selectAll('path').style('stroke-width', `${0.7 / escalaAtual}px`);
    gRot.selectAll('text')
      .style('font-size', `${10 / escalaAtual}px`)
      .style('stroke-width', `${1.6 / escalaAtual}px`);
    gRotBolhas.selectAll('text')
      .style('font-size', `${9.5 / escalaAtual}px`)
      .style('stroke-width', `${1.8 / escalaAtual}px`)
      // o rotulo acompanha o raio, que tambem muda com o zoom
      .attr('y', (d) => d.y - (d.rTela ?? 0) / escalaAtual - 3 / escalaAtual);
    gBolhas.selectAll('circle')
      .style('stroke-width', `${1.1 / escalaAtual}px`)
      .attr('r', (d) => (d.rTela ?? 0) / escalaAtual);
  }

  /** Reprojeta para o tamanho atual. Devolve true se o tamanho mudou. */
  function dimensionar() {
    const no = svg.node();
    if (!no) return false;
    const r = no.getBoundingClientRect();
    const l = Math.max(Math.round(r.width), 320);
    const a = Math.max(Math.round(r.height), 360);
    if (l === larg && a === alt) return false;
    larg = l;
    alt = a;
    svg.attr('viewBox', `0 0 ${larg} ${alt}`);
    projecao = d3.geoMercator().fitExtent([[16, 16], [larg - 16, alt - 16]], geo);
    caminho = d3.geoPath(projecao);
    return true;
  }

  /** Recebe os agregados por UF e redesenha o heat map. */
  function definirEstados(linhas) {
    dadosEstados = new Map(linhas.map((l) => [l.uf, l]));
    const valores = linhas.map((l) => val(l, cfg.metrica())).filter((v) => v > 0);
    escala = valores.length
      ? d3.scaleQuantile().domain(valores).range(RAMPA)
      : null;
    desenhar();
    cfg.onLegenda?.(faixasLegenda());
  }

  function faixasLegenda() {
    if (!escala) return null;
    return {
      cores: RAMPA,
      limites: RAMPA.map((c) => escala.invertExtent(c)).filter((e) => Number.isFinite(e[0])),
      metrica: cfg.metrica(),
    };
  }

  function corDe(sigla) {
    const d = dadosEstados.get(sigla);
    if (!d || !escala) return NEUTRO;
    const v = val(d, cfg.metrica());
    return v > 0 ? escala(v) : NEUTRO;
  }

  function claro(cor) {
    const c = d3.color(cor);
    if (!c) return true;
    return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255 > 0.62;
  }

  function desenhar() {
    if (!geo) return;

    const paths = gUf.selectAll('path').data(geo.features, (d) => d.properties.codarea);
    paths.enter()
      .append('path')
      .attr('class', 'uf')
      .on('click', (ev, d) => { ev.stopPropagation(); cfg.onCliqueEstado?.(d.properties.sigla, ev); })
      .on('mousemove', (ev, d) => cfg.onHoverEstado?.(ev, d.properties.sigla, dadosEstados.get(d.properties.sigla)))
      .on('mouseleave', () => cfg.onSairHover?.())
      .merge(paths)
      .attr('d', caminho)
      .classed('selecionada', (d) => d.properties.sigla === ufSelecionada)
      // fill aplicado de forma sincrona: a suavizacao vem da transicao CSS da
      // classe .uf. Depender de transicao do d3 aqui deixaria o mapa em branco
      // enquanto o requestAnimationFrame estiver suspenso (aba em segundo plano).
      .attr('fill', (d) => corDe(d.properties.sigla));

    // rotulo da sigla apenas onde ha venda (evita poluicao visual)
    const comVenda = geo.features.filter((f) => {
      const d = dadosEstados.get(f.properties.sigla);
      return d && val(d, cfg.metrica()) > 0;
    });
    const rots = gRot.selectAll('text').data(comVenda, (d) => d.properties.codarea);
    rots.exit().remove();
    rots.enter()
      .append('text')
      .attr('class', 'uf-rot')
      .attr('text-anchor', 'middle')
      .merge(rots)
      .attr('x', (d) => caminho.centroid(d)[0])
      .attr('y', (d) => caminho.centroid(d)[1] + 3)
      .attr('class', (d) => `uf-rot${claro(corDe(d.properties.sigla)) ? ' escura' : ''}`)
      .text((d) => d.properties.sigla);

    desenharBolhas();
    escalarRotulos();
  }

  /** Escala de zoom em que o mapa para ao focar uma UF. */
  function escalaAlvo(sigla) {
    const f = geo?.features.find((x) => x.properties.sigla === sigla);
    if (!f || !caminho) return 1;
    const [[x0, y0], [x1, y1]] = caminho.bounds(f);
    const maior = Math.max((x1 - x0) / larg, (y1 - y0) / alt);
    return maior > 0 ? Math.min(30, 0.82 / maior) : 1;
  }

  /** Bolhas das cidades do estado selecionado. */
  function definirCidades(linhas) {
    cidades = (linhas ?? []).filter((c) => c.lat != null && c.lon != null);
    desenharBolhas();
  }

  function desenharBolhas() {
    const metrica = cfg.metrica();
    const visiveis = ufSelecionada ? cidades : [];
    const maxV = d3.max(visiveis, (c) => val(c, metrica)) || 1;
    const k = d3.zoomTransform(svg.node()).k || 1;

    // A colisao usa a escala em que o mapa VAI parar, nao a atual: quando o
    // estado e aberto, `focar()` ainda esta animando e o zoom corrente e 1, o
    // que daria raios grandes em unidades do viewBox e empurraria as bolhas
    // longe da cidade real.
    const kLayout = ufSelecionada ? escalaAlvo(ufSelecionada) : k;

    // Raio por AREA (sqrt): a percepcao de tamanho acompanha o valor.
    //
    // A faixa e em PIXELS DE TELA e o raio desenhado e dividido pelo zoom, igual
    // aos rotulos. Sem isso a bolha entra no transform do zoom e cresce junto:
    // com raio 26 e zoom ~6x virava ~150px na tela, engolindo o estado. O maximo
    // acompanha a altura do mapa para funcionar em qualquer tamanho de painel.
    const raioMaxTela = Math.max(11, Math.min(20, alt * 0.045));
    const raio = d3.scaleSqrt().domain([0, maxV]).range([3, raioMaxTela]);

    // separacao para nao sobrepor cidades vizinhas (em unidades do viewBox)
    const nos = visiveis.map((c) => {
      const [x, y] = projecao([c.lon, c.lat]) ?? [null, null];
      const rTela = raio(val(c, metrica));
      return { ...c, x0: x, y0: y, x, y, rTela, r: rTela / k };
    }).filter((n) => n.x0 != null);

    if (nos.length > 1) {
      d3.forceSimulation(nos)
        .force('x', d3.forceX((d) => d.x0).strength(0.86))
        .force('y', d3.forceY((d) => d.y0).strength(0.86))
        .force('colisao', d3.forceCollide((d) => (d.rTela + 1.2) / kLayout).iterations(3))
        .stop()
        .tick(90);
    }

    const circulos = gBolhas.selectAll('circle').data(nos, (d) => d.municipio_id);
    circulos.exit().remove();
    // Bolhas novas ja nascem na posicao/raio final (sem depender de animacao para
    // aparecer); apenas as que mudam de valor/posicao sao animadas.
    const novas = circulos.enter()
      .append('circle')
      .attr('class', 'bolha')
      .on('click', (ev, d) => { ev.stopPropagation(); cfg.onCliqueCidade?.(d); })
      .on('mousemove', (ev, d) => cfg.onHoverCidade?.(ev, d))
      .on('mouseleave', () => cfg.onSairHover?.())
      .attr('cx', (d) => d.x)
      .attr('cy', (d) => d.y)
      .attr('r', (d) => d.r);

    novas.merge(circulos)
      .classed('selecionada', (d) => d.municipio_id === municipioSelecionado);

    circulos.transition().duration(300)
      .attr('cx', (d) => d.x)
      .attr('cy', (d) => d.y)
      .attr('r', (d) => d.r);

    // rotula so as maiores, para manter legibilidade
    const rotulaveis = nos.slice().sort((a, b) => b.rTela - a.rTela).slice(0, 8);
    const rb = gRotBolhas.selectAll('text').data(rotulaveis, (d) => d.municipio_id);
    rb.exit().remove();
    rb.enter()
      .append('text')
      .attr('class', 'bolha-rot')
      .attr('text-anchor', 'middle')
      .merge(rb)
      .attr('x', (d) => d.x);

    escalarRotulos(k);
  }

  /** Zoom animado para a UF (ou volta ao Brasil quando sigla = null). */
  function focar(sigla, { animar = true } = {}) {
    // trocar de estado descarta a cidade selecionada; refocar o mesmo estado
    // (troca de filtro, volta para a aba do dashboard) preserva a selecao
    if (sigla !== ufSelecionada) municipioSelecionado = null;
    ufSelecionada = sigla;
    gUf.selectAll('path').classed('selecionada', (d) => d.properties.sigla === sigla);

    const dur = animar ? 720 : 0;
    if (!sigla) {
      svg.transition().duration(dur).ease(d3.easeCubicOut)
        .call(zoom.transform, d3.zoomIdentity);
      cidades = [];
      desenharBolhas();
      return;
    }
    const f = geo.features.find((x) => x.properties.sigla === sigla);
    if (!f) return;
    const [[x0, y0], [x1, y1]] = caminho.bounds(f);
    const k = escalaAlvo(sigla);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    svg.transition().duration(dur).ease(d3.easeCubicOut)
      .call(zoom.transform,
        d3.zoomIdentity.translate(larg / 2, alt / 2).scale(k).translate(-cx, -cy));
  }

  function selecionarCidade(municipioId) {
    municipioSelecionado = municipioId;
    gBolhas.selectAll('circle').classed('selecionada', (d) => d.municipio_id === municipioId);
  }

  return {
    iniciar, definirEstados, definirCidades, focar, selecionarCidade,
    faixasLegenda, redesenhar: desenhar,
    // o svg fica com tamanho 0 enquanto a aba do dashboard esta oculta
    redimensionar() {
      const mudou = dimensionar();
      desenhar();
      if (mudou && ufSelecionada) focar(ufSelecionada, { animar: false });
    },
    get ufAtual() { return ufSelecionada; },
  };
})();
