/**
 * KPIs executivos herdados do Cockpit Comercial B2B, recalculados sobre a base
 * do Mapa (planilha comercial como fonte + enriquecimento do Olist).
 *
 * As formulas sao as mesmas do cockpit original:
 *  - concentracao: share(n), clientes para 80% da receita, indice HHI
 *  - recencia: ativo / em risco / dormente medidos contra o ULTIMO MES FECHADO
 *  - YoY: colunas 2024/2025/2026 da linha "Mes referencia" das abas mensais
 *
 * Tudo respeita os mesmos filtros dos outros agregados.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getMeta } from './db.js';
import { construirFiltro } from './agregados.js';
import { norm } from './geo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MESES_ABREV = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const nomeMes = (mesRef) => (mesRef ? MESES_ABREV[Number(mesRef.slice(5, 7)) - 1] : '—');

/** Situacoes que representam pedido ainda nao faturado (nao inclui "Nao informado"). */
const EM_ABERTO = "('Em Aberto','Em aberto','Preparando Envio','Preparando envio')";

/** Ranking de clientes por faturamento, com participacao. */
function rankingClientes(q) {
  const { where, par } = construirFiltro(q);
  // Cidade, UF e representante entram aqui porque a aba Clientes, que era o
  // unico lugar onde apareciam, foi removida -- o dado nao podia sair junto.
  // Vem do pedido MAIS RECENTE do cliente, nao de um MAX: MAX devolveria o
  // maior texto em ordem alfabetica, o que mostraria uma cidade antiga em quem
  // mudou de endereco.
  const doUltimoPedido = (campo) => `(
    SELECT x.${campo} FROM pedidos x
     WHERE x.cliente_chave = p.cliente_chave AND x.${campo} IS NOT NULL AND x.${campo} <> ''
     ORDER BY x.data DESC LIMIT 1)`;

  const linhas = db.prepare(`
    SELECT p.cliente_chave, p.cliente_nome,
           COALESCE(SUM(p.total), 0) v,
           COUNT(DISTINCT p.uid) n,
           MAX(p.mes_ref) ultimo_mes,
           MIN(p.mes_ref) primeiro_mes,
           ${doUltimoPedido('cidade')}        cidade,
           ${doUltimoPedido('uf')}            uf,
           ${doUltimoPedido('representante')} representante
      FROM pedidos p WHERE ${where}
     GROUP BY p.cliente_chave
     ORDER BY v DESC`).all(...par);
  const total = linhas.reduce((s, l) => s + l.v, 0);
  return linhas.map((l) => ({
    ...l,
    part: total ? l.v / total : 0,
    ticket: l.n ? l.v / l.n : 0,
  }));
}

/**
 * Concentracao de receita: Pareto + HHI.
 * HHI = soma dos quadrados das participacoes em pontos percentuais (0..10.000).
 * Acima de 2.500 e considerado concentracao alta.
 */
export function concentracao(q) {
  const rk = rankingClientes(q);
  const total = rk.reduce((s, c) => s + c.v, 0);
  const share = (n) => (total ? rk.slice(0, n).reduce((s, c) => s + c.v, 0) / total : 0);

  let acumulado = 0;
  let clientesPara80 = rk.length;
  for (let i = 0; i < rk.length; i++) {
    acumulado += rk[i].v;
    if (total && acumulado / total >= 0.8) { clientesPara80 = i + 1; break; }
  }
  const hhi = rk.reduce((s, c) => s + ((c.part || 0) * 100) ** 2, 0);
  const recorrentes = rk.filter((c) => c.n > 1);

  return {
    total,
    clientes: rk.length,
    top3: share(3),
    top5: share(5),
    top10: share(10),
    top20: share(20),
    valor_top10: rk.slice(0, 10).reduce((s, c) => s + c.v, 0),
    cauda_clientes: Math.max(rk.length - 20, 0),
    cauda_share: 1 - share(20),
    clientes_para_80: clientesPara80,
    hhi: Math.round(hhi),
    // faixas de leitura do HHI usadas no cockpit
    hhi_nivel: hhi > 2500 ? 'alta' : hhi > 1500 ? 'moderada-alta' : 'moderada',
    recorrentes: recorrentes.length,
    recorrentes_share: total ? recorrentes.reduce((s, c) => s + c.v, 0) / total : 0,
    pareto: rk.slice(0, 10).map((c, i) => ({
      cliente_chave: c.cliente_chave,
      cliente_nome: c.cliente_nome,
      cidade: c.cidade,
      uf: c.uf,
      representante: c.representante,
      valor: c.v,
      pedidos: c.n,
      part: c.part,
      acumulado: rk.slice(0, i + 1).reduce((s, x) => s + x.v, 0) / (total || 1),
    })),
  };
}

/** Ultimo mes com lancamento e ultimo mes FECHADO (o anterior ao corrente). */
function mesesReferencia(q) {
  const { where, par } = construirFiltro(q);
  const meses = db.prepare(`
    SELECT p.mes_ref FROM pedidos p WHERE ${where} AND p.mes_ref IS NOT NULL
     GROUP BY p.mes_ref ORDER BY p.mes_ref`).all(...par).map((r) => r.mes_ref);
  if (!meses.length) return { meses, mesCorrente: null, mesAtual: null, ultimoFechado: null, emCurso: false };
  const hoje = new Date();
  const mesCorrente = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
  // Fechado = mes anterior ao calendario corrente. Em 01/09, agosto JA e fechado
  // -- comparar com o ultimo mes que tem dado daria julho, atrasando a referencia
  // de recencia em um mes inteiro.
  const fechados = meses.filter((m) => m < mesCorrente);
  const ultimoFechado = fechados[fechados.length - 1] ?? meses[meses.length - 1];
  const emCurso = meses.includes(mesCorrente);
  return { meses, mesCorrente, mesAtual: emCurso ? mesCorrente : ultimoFechado, ultimoFechado, emCurso };
}

/**
 * Carteira por recencia, na regra do cockpit: a referencia e o ultimo mes
 * fechado. Comprou nele ou depois = ativo; 1 a 2 meses sem comprar = risco;
 * 3 ou mais = dormente.
 */
export function carteira(q) {
  const rk = rankingClientes(q);
  const { meses, ultimoFechado } = mesesReferencia(q);
  const idx = new Map(meses.map((m, i) => [m, i]));
  const refIdx = idx.get(ultimoFechado) ?? meses.length - 1;
  const total = rk.reduce((s, c) => s + c.v, 0);

  const classificar = (c) => {
    const i = idx.get(c.ultimo_mes);
    if (i == null) return 'dormente';
    const d = refIdx - i;
    return d <= 0 ? 'ativo' : d <= 2 ? 'risco' : 'dormente';
  };

  const baldes = { ativo: [], risco: [], dormente: [] };
  const top10 = new Set(rk.slice(0, 10).map((c) => c.cliente_chave));
  for (const c of rk) {
    const estado = classificar(c);
    baldes[estado].push({
      cliente_chave: c.cliente_chave,
      cliente_nome: c.cliente_nome,
      cidade: c.cidade,
      uf: c.uf,
      representante: c.representante,
      valor: c.v,
      pedidos: c.n,
      part: c.part,
      ticket: c.ticket,
      ultimo_mes: c.ultimo_mes,
      meses_sem_comprar: Math.max(0, refIdx - (idx.get(c.ultimo_mes) ?? -99)),
      estado,
      top10: top10.has(c.cliente_chave),
    });
  }
  const soma = (arr) => arr.reduce((s, c) => s + c.valor, 0);
  const compraUnica = rk.filter((c) => c.n === 1);

  return {
    referencia: ultimoFechado,
    referencia_nome: nomeMes(ultimoFechado),
    total,
    ativo: { clientes: baldes.ativo.length, valor: soma(baldes.ativo), share: total ? soma(baldes.ativo) / total : 0 },
    risco: { clientes: baldes.risco.length, valor: soma(baldes.risco), share: total ? soma(baldes.risco) / total : 0 },
    dormente: { clientes: baldes.dormente.length, valor: soma(baldes.dormente), share: total ? soma(baldes.dormente) / total : 0 },
    compra_unica: { clientes: compraUnica.length, valor: compraUnica.reduce((s, c) => s + c.v, 0) },
    // radar de reativacao: risco + dormentes por receita
    radar: [...baldes.dormente, ...baldes.risco].sort((a, b) => b.valor - a.valor),
    clientes: [...baldes.ativo, ...baldes.risco, ...baldes.dormente].sort((a, b) => b.valor - a.valor),
  };
}

/**
 * Evolucao mensal com comparativo YoY. Os anos anteriores vem do cabecalho
 * "Mes referencia" das abas mensais (a planilha nao tem lancamento de 2024/2025).
 */
export function vendasMensais(q) {
  const { where, par } = construirFiltro(q);
  const linhas = db.prepare(`
    SELECT p.mes_ref,
           COALESCE(SUM(p.total), 0) valor,
           COUNT(DISTINCT p.uid) pedidos,
           COUNT(DISTINCT p.cliente_chave) clientes
      FROM pedidos p WHERE ${where} AND p.mes_ref IS NOT NULL
     GROUP BY p.mes_ref ORDER BY p.mes_ref`).all(...par);

  // clientes novos: mes da PRIMEIRA compra de cada cliente, dentro do filtro
  const primeiras = db.prepare(`
    SELECT p.cliente_chave, MIN(p.mes_ref) primeiro
      FROM pedidos p WHERE ${where} AND p.mes_ref IS NOT NULL
     GROUP BY p.cliente_chave`).all(...par);
  const novosPorMes = new Map();
  for (const p of primeiras) novosPorMes.set(p.primeiro, (novosPorMes.get(p.primeiro) ?? 0) + 1);

  let declarados = [];
  try { declarados = JSON.parse(getMeta('totais_planilha') ?? '[]'); } catch { declarados = []; }
  const porMesDeclarado = new Map(declarados.map((d) => [d.mes_ref, d]));

  const series = linhas.map((l) => {
    const dec = porMesDeclarado.get(l.mes_ref);
    const anoAtual = dec?.ano_atual ?? l.valor;
    const ano1 = dec?.ano_menos_1 ?? null;
    const ano2 = dec?.ano_menos_2 ?? null;
    return {
      mes_ref: l.mes_ref,
      nome: nomeMes(l.mes_ref),
      valor: l.valor,
      pedidos: l.pedidos,
      clientes_ativos: l.clientes,
      clientes_novos: novosPorMes.get(l.mes_ref) ?? 0,
      declarado: dec?.total_planilha ?? null,
      ano_atual: anoAtual,
      ano_menos_1: ano1,
      ano_menos_2: ano2,
      yoy_1: ano1 ? anoAtual / ano1 - 1 : null,
      yoy_2: ano2 ? anoAtual / ano2 - 1 : null,
    };
  });

  const totalValor = series.reduce((s, l) => s + l.valor, 0);
  return {
    series,
    total: totalValor,
    media_mensal: series.length ? totalValor / series.length : 0,
    // um cliente e 'novo' uma vez: no mes da primeira compra dentro do filtro
    clientes_novos_total: primeiras.length,
  };
}

/** Visao geral: os cartoes de topo do cockpit. */
export function visaoGeral(q) {
  const { where, par } = construirFiltro(q);
  const { mesAtual, ultimoFechado, meses, emCurso, mesCorrente } = mesesReferencia(q);

  const faturado = db.prepare(`
    SELECT COALESCE(SUM(p.total), 0) total, COUNT(DISTINCT p.uid) pedidos,
           COUNT(DISTINCT p.cliente_chave) clientes
      FROM pedidos p WHERE ${where} AND p.faturado = 1`).get(...par);
  const aberto = db.prepare(`
    SELECT COALESCE(SUM(p.total), 0) total, COUNT(DISTINCT p.uid) pedidos
      FROM pedidos p WHERE ${where} AND p.faturado = 0 AND p.situacao IN ${EM_ABERTO}`).get(...par);
  const semSituacao = db.prepare(`
    SELECT COALESCE(SUM(p.total), 0) total, COUNT(DISTINCT p.uid) pedidos
      FROM pedidos p WHERE ${where} AND p.faturado = 0 AND p.situacao NOT IN ${EM_ABERTO}`).get(...par);

  // cadastro -> faturamento, so onde as duas datas existem
  const tempo = db.prepare(`
    SELECT AVG(JULIANDAY(p.data_faturamento) - JULIANDAY(p.data)) dias, COUNT(*) n
      FROM pedidos p WHERE ${where}
        AND p.data IS NOT NULL AND p.data_faturamento IS NOT NULL
        AND JULIANDAY(p.data_faturamento) >= JULIANDAY(p.data)`).get(...par);

  const doMes = (mes) => (mes
    ? db.prepare(`SELECT COALESCE(SUM(p.total),0) valor, COUNT(DISTINCT p.uid) pedidos,
                    COUNT(DISTINCT p.cliente_chave) clientes
                   FROM pedidos p WHERE ${where} AND p.mes_ref = ?`).get(...par, mes)
    : { valor: 0, pedidos: 0, clientes: 0 });

  const mensal = vendasMensais(q);
  const cancelados = db.prepare(`
    SELECT COALESCE(SUM(total),0) valor, COUNT(*) pedidos FROM pedidos
     WHERE valido = 0 AND motivo_exclusao = 'pedido cancelado'`).get();

  return {
    faturado: {
      ...faturado,
      ticket: faturado.pedidos ? faturado.total / faturado.pedidos : 0,
    },
    aberto: {
      ...aberto,
      ticket: aberto.pedidos ? aberto.total / aberto.pedidos : 0,
    },
    sem_situacao: semSituacao,
    tempo_medio_faturamento: tempo?.dias ?? null,
    tempo_medio_base: tempo?.n ?? 0,
    mes_corrente: mesCorrente,
    mes_em_curso: emCurso,
    mes_atual: { mes_ref: mesAtual, nome: nomeMes(mesAtual), em_curso: emCurso, ...doMes(mesAtual) },
    ultimo_fechado: { mes_ref: ultimoFechado, nome: nomeMes(ultimoFechado), ...doMes(ultimoFechado) },
    meses_com_venda: meses.length,
    media_mensal: mensal.media_mensal,
    clientes_novos: mensal.clientes_novos_total,
    cancelados,
  };
}

/** Amostras e brindes (aba AMOSTRAS -- fora do faturamento). */
export function amostras(q) {
  const meses = mesesSelecionados(q);
  const cond = meses.length ? `WHERE mes_ref IN (${meses.map(() => '?').join(',')})` : '';
  const par = meses;
  const total = db.prepare(`
    SELECT COUNT(*) envios, COALESCE(SUM(valor),0) valor,
           COUNT(DISTINCT cliente_chave) clientes FROM amostras ${cond}`).get(...par);
  const porMes = db.prepare(`
    SELECT mes_ref, COUNT(*) envios, COALESCE(SUM(valor),0) valor FROM amostras ${cond}
     GROUP BY mes_ref ORDER BY mes_ref`).all(...par);
  // Agrupado por CLIENTE: a lista de datas fica sob demanda (ver amostrasDoCliente).
  const porCliente = db.prepare(`
    SELECT cliente_chave, MAX(cliente) cliente, COUNT(*) envios,
           COALESCE(SUM(valor),0) valor, MAX(data) ultimo_envio, MIN(data) primeiro_envio,
           COUNT(DISTINCT mes_ref) meses
      FROM amostras ${cond}
     GROUP BY cliente_chave ORDER BY valor DESC`).all(...par);
  const ranking = porCliente.slice(0, 25);
  const mesesAtivos = porMes.length;
  const totalValor = porCliente.reduce((s, c) => s + c.valor, 0);
  return {
    ...total,
    media_mensal_envios: mesesAtivos ? total.envios / mesesAtivos : 0,
    media_mensal_valor: mesesAtivos ? total.valor / mesesAtivos : 0,
    por_mes: porMes,
    ranking,
    por_cliente: porCliente.map((c) => ({
      ...c,
      pct_valor: totalValor ? (c.valor / totalValor) * 100 : 0,
      valor_medio: c.envios ? c.valor / c.envios : 0,
    })),
  };
}

/** Envios de amostra de um cliente, por data (aberto ao clicar na linha). */
export function amostrasDoCliente(chave, q) {
  const meses = mesesSelecionados(q);
  const cond = meses.length ? `AND mes_ref IN (${meses.map(() => '?').join(',')})` : '';
  const par = [chave, ...meses];
  const cab = db.prepare(`
    SELECT MAX(cliente) cliente, COUNT(*) envios, COALESCE(SUM(valor),0) valor,
           MAX(data) ultimo_envio, MIN(data) primeiro_envio
      FROM amostras WHERE cliente_chave = ? ${cond}`).get(...par);
  if (!cab || !cab.envios) return null;
  const registros = db.prepare(`
    SELECT data, mes_ref, pedido, valor, nf, envio, observacoes
      FROM amostras WHERE cliente_chave = ? ${cond}
     ORDER BY data DESC, id DESC`).all(...par);
  const porMes = db.prepare(`
    SELECT mes_ref, COUNT(*) envios, COALESCE(SUM(valor),0) valor
      FROM amostras WHERE cliente_chave = ? ${cond}
     GROUP BY mes_ref ORDER BY mes_ref`).all(...par);
  return {
    ...cab,
    cliente_chave: chave,
    valor_medio: cab.envios ? cab.valor / cab.envios : 0,
    registros,
    por_mes: porMes,
  };
}

/**
 * Custo da prospeccao, de `config/custos-prospeccao.json`.
 * Cobrado por mensagem ENTREGUE -- disparo que falhou nao custa.
 */
function tabelaDeCustos() {
  const padrao = { custo_por_mensagem_entregue: 0, por_canal: {}, definido_em: null };
  try {
    const f = path.join(__dirname, '..', 'config', 'custos-prospeccao.json');
    if (!fs.existsSync(f)) return padrao;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return {
      custo_por_mensagem_entregue: Number(j.custo_por_mensagem_entregue) || 0,
      por_canal: j.por_canal ?? {},
      definido_em: j.definido_em ?? null,
    };
  } catch {
    return padrao;
  }
}

/** Preco por entrega do canal (o especifico vence o padrao). */
function custoDoCanal(canal, custos) {
  const alvo = norm(canal);
  for (const [chave, valor] of Object.entries(custos.por_canal ?? {})) {
    if (alvo.includes(norm(chave))) return Number(valor) || 0;
  }
  return custos.custo_por_mensagem_entregue;
}

/** Prospeccao B2B (aba LEADS), com custo, ROAS/ROI e custo por lead. */
export function prospeccao(q) {
  const meses = mesesSelecionados(q);
  const cond = meses.length ? `WHERE mes_ref IN (${meses.map(() => '?').join(',')})` : '';
  const par = meses;
  const t = db.prepare(`
    SELECT COUNT(*) n_campanhas, COALESCE(SUM(enviados),0) enviados,
           COALESCE(SUM(falhas),0) falhas, COALESCE(SUM(entregues),0) entregues,
           COALESCE(SUM(retornos),0) retornos, COALESCE(SUM(vendas),0) vendas
      FROM leads ${cond}`).get(...par);
  // a entrega so e medida em parte das campanhas (e-mail antigo nao media)
  const comEntrega = db.prepare(`
    SELECT COALESCE(SUM(enviados),0) enviados FROM leads
     ${cond ? `${cond} AND` : 'WHERE'} (entregues > 0 OR falhas > 0)`).get(...par);
  const porCanal = db.prepare(`
    SELECT COALESCE(canal,'—') canal, COUNT(*) campanhas,
           COALESCE(SUM(enviados),0) enviados, COALESCE(SUM(entregues),0) entregues,
           COALESCE(SUM(falhas),0) falhas, COALESCE(SUM(retornos),0) retornos,
           COALESCE(SUM(vendas),0) vendas
      FROM leads ${cond} GROUP BY COALESCE(canal,'—') ORDER BY enviados DESC`).all(...par);
  const porSegmento = db.prepare(`
    SELECT COALESCE(segmento,'—') segmento, COUNT(*) campanhas,
           COALESCE(SUM(enviados),0) enviados, COALESCE(SUM(retornos),0) retornos,
           COALESCE(SUM(vendas),0) vendas
      FROM leads ${cond} GROUP BY COALESCE(segmento,'—') ORDER BY enviados DESC`).all(...par);
  const porMes = db.prepare(`
    SELECT mes_ref, COUNT(*) campanhas, COALESCE(SUM(enviados),0) enviados,
           COALESCE(SUM(entregues),0) entregues, COALESCE(SUM(falhas),0) falhas,
           COALESCE(SUM(retornos),0) retornos, COALESCE(SUM(vendas),0) vendas
      FROM leads ${cond} GROUP BY mes_ref ORDER BY mes_ref`).all(...par);
  // `mes_ref` e obrigatorio aqui: o custo por mes e o CAC agrupam as campanhas
  // por mes, e sem esta coluna ficavam zerados.
  const campanhas = db.prepare(`
    SELECT data, data_raw, mes_ref, canal, campanha, segmento, uf, enviados, falhas,
           entregues, retornos, vendas
      FROM leads ${cond} ORDER BY data DESC, id DESC`).all(...par);

  // ---- custo, retorno e eficiencia ----
  const custos = tabelaDeCustos();
  const comCusto = (linha) => {
    const preco = custoDoCanal(linha.canal ?? '', custos);
    const custo = (linha.entregues ?? 0) * preco;
    return {
      ...linha,
      custo_unitario: preco,
      custo,
      roas: custo > 0 ? (linha.vendas ?? 0) / custo : null,
      roi: custo > 0 ? ((linha.vendas ?? 0) - custo) / custo : null,
      cpl: linha.retornos ? custo / linha.retornos : null,
    };
  };
  const canaisComCusto = porCanal.map(comCusto);
  const custoTotal = canaisComCusto.reduce((s, c) => s + c.custo, 0);
  const campanhasComCusto = campanhas.map(comCusto);
  const mesesComCusto = porMes.map((m) => {
    // o mes pode ter mais de um canal: recalcula pelas campanhas daquele mes
    const custo = campanhasComCusto
      .filter((c) => c.mes_ref === m.mes_ref || (!c.mes_ref && !m.mes_ref))
      .reduce((s, c) => s + c.custo, 0);
    return {
      ...m,
      custo,
      roas: custo > 0 ? m.vendas / custo : null,
      roi: custo > 0 ? (m.vendas - custo) / custo : null,
      cpl: m.retornos ? custo / m.retornos : null,
    };
  });

  // CAC: a planilha nao liga campanha -> cliente, entao o denominador possivel e
  // "clientes novos no periodo coberto pelas campanhas". Atribui TODOS os novos a
  // prospeccao, o que subestima o CAC -- vem rotulado como estimativa.
  const mesesLeads = [...new Set(campanhas.map((c) => c.mes_ref).filter(Boolean))];
  let clientesNovos = 0;
  if (mesesLeads.length) {
    const marcas = mesesLeads.map(() => '?').join(',');
    clientesNovos = db.prepare(`
      SELECT COUNT(*) n FROM (
        SELECT cliente_chave, MIN(mes_ref) primeiro FROM pedidos
         WHERE valido = 1 AND mes_ref IS NOT NULL GROUP BY cliente_chave
      ) WHERE primeiro IN (${marcas})`).all(...mesesLeads)[0]?.n ?? 0;
  }

  return {
    ...t,
    enviados_com_entrega: comEntrega.enviados,
    taxa_entrega: comEntrega.enviados ? t.entregues / comEntrega.enviados : null,
    taxa_resposta: (t.entregues || t.enviados) ? t.retornos / (t.entregues || t.enviados) : null,
    // custo e eficiencia
    custo_unitario_padrao: custos.custo_por_mensagem_entregue,
    custo_por_canal: custos.por_canal,
    custo_total: custoTotal,
    roas: custoTotal > 0 ? t.vendas / custoTotal : null,
    roi: custoTotal > 0 ? (t.vendas - custoTotal) / custoTotal : null,
    cpl: t.retornos ? custoTotal / t.retornos : null,
    cpm: t.entregues ? (custoTotal / t.entregues) * 1000 : null,
    custo_por_real_vendido: t.vendas ? custoTotal / t.vendas : null,
    clientes_novos_periodo: clientesNovos,
    cac_estimado: clientesNovos ? custoTotal / clientesNovos : null,
    meses_das_campanhas: mesesLeads.sort(),
    por_canal: canaisComCusto,
    por_segmento: porSegmento,
    por_mes: mesesComCusto,
    campanhas: campanhasComCusto,
  };
}

/**
 * Amostras e leads sao tabelas proprias, sem representante/UF/cliente_chave dos
 * pedidos -- delas so aproveita o filtro de MESES. Devolve a lista de meses
 * selecionados (vazio = todos).
 */
function mesesSelecionados(q) {
  return String(q?.meses ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}
