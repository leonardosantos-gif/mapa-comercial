/**
 * Consultas agregadas do dashboard.
 * Tudo sai do banco local (nenhuma chamada a API por requisicao do usuario) e
 * todo agregado respeita exatamente o mesmo conjunto de filtros.
 *
 * Regra de contagem: um pedido nunca e somado duas vezes -- a unidade e o `uid`
 * (conta:id_pedido) e o valor e sempre `pedidos.total` (= valor da NF).
 */
import { db, getMeta } from './db.js';
import { NOME_UF } from './geo.js';

const lista = (v) =>
  String(v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Monta a clausula WHERE compartilhada por todos os agregados.
 * Aceita: rep, cliente, uf, municipio, meses, de, ate, tipo, produto, sku, situacao.
 */
export function construirFiltro(q = {}, { alias = 'p' } = {}) {
  const a = alias;
  const cond = [`${a}.valido = 1`];
  const par = [];

  const addIn = (coluna, valores) => {
    if (!valores.length) return;
    cond.push(`${coluna} IN (${valores.map(() => '?').join(',')})`);
    par.push(...valores);
  };

  addIn(`${a}.representante`, lista(q.rep));
  addIn(`${a}.cliente_chave`, lista(q.cliente));
  addIn(`${a}.uf`, lista(q.uf).map((x) => x.toUpperCase()));
  addIn(`${a}.municipio_id`, lista(q.municipio));
  addIn(`${a}.tipo_operacao`, lista(q.tipo).map((x) => x.toUpperCase()));
  addIn(`${a}.mes_ref`, lista(q.meses));

  if (q.de) { cond.push(`${a}.mes_ref >= ?`); par.push(String(q.de)); }
  if (q.ate) { cond.push(`${a}.mes_ref <= ?`); par.push(String(q.ate)); }

  if (q.faturado === '1') cond.push(`${a}.faturado = 1`);

  // busca livre por cliente/cidade
  if (q.busca) {
    cond.push(`(UPPER(${a}.cliente_nome) LIKE ? OR UPPER(${a}.cidade) LIKE ?)`);
    const t = `%${String(q.busca).toUpperCase()}%`;
    par.push(t, t);
  }

  // filtro por produto/SKU: pedido que contenha o item
  const produtos = lista(q.produto);
  if (produtos.length) {
    cond.push(`EXISTS (SELECT 1 FROM itens i WHERE i.uid_pedido = ${a}.uid AND i.produto IN (${produtos.map(() => '?').join(',')}))`);
    par.push(...produtos);
  }
  const skus = lista(q.sku);
  if (skus.length) {
    cond.push(`EXISTS (SELECT 1 FROM itens i WHERE i.uid_pedido = ${a}.uid AND i.sku IN (${skus.map(() => '?').join(',')}))`);
    par.push(...skus);
  }

  return { where: cond.join(' AND '), par };
}

/** KPIs do topo. */
export function resumo(q) {
  const { where, par } = construirFiltro(q);
  const r = db.prepare(`
    SELECT
      COALESCE(SUM(p.total), 0)               AS valor,
      COALESCE(SUM(CASE WHEN p.faturado = 1 THEN p.total ELSE 0 END), 0) AS valor_faturado,
      COUNT(DISTINCT p.uid)                   AS pedidos,
      COUNT(DISTINCT p.cliente_chave)         AS clientes,
      -- "EX" e exportacao, nao uma UF brasileira: fica fora da contagem de estados
      COUNT(DISTINCT CASE WHEN p.uf <> 'EX' THEN p.uf END) AS estados,
      COUNT(DISTINCT p.municipio_id)          AS cidades,
      COUNT(DISTINCT p.representante)         AS representantes,
      COALESCE(SUM(p.qtd_pecas), 0)           AS pecas,
      COALESCE(SUM(CASE WHEN p.uf = 'EX' THEN p.total ELSE 0 END), 0) AS valor_exterior,
      -- valor que nao tem area no mapa (exportacao ou cadastro sem cidade)
      COALESCE(SUM(CASE WHEN p.municipio_id IS NULL THEN p.total ELSE 0 END), 0) AS valor_sem_local
    FROM pedidos p WHERE ${where}`).get(...par);
  r.ticket_medio = r.pedidos ? r.valor / r.pedidos : 0;
  r.valor_por_cliente = r.clientes ? r.valor / r.clientes : 0;
  return r;
}

/** Agregado por UF -- alimenta o heat map e o ranking de estados. */
export function porEstado(q) {
  const { where, par } = construirFiltro(q);
  const linhas = db.prepare(`
    SELECT p.uf,
           COALESCE(SUM(p.total), 0)      AS valor,
           COUNT(DISTINCT p.uid)          AS pedidos,
           COUNT(DISTINCT p.cliente_chave) AS clientes,
           COUNT(DISTINCT p.municipio_id) AS cidades,
           COALESCE(SUM(p.qtd_pecas), 0)  AS pecas
      FROM pedidos p
     WHERE ${where} AND p.uf IS NOT NULL
     GROUP BY p.uf`).all(...par);

  // principal cliente do estado e sua participacao DENTRO do estado
  const porClienteUf = db.prepare(`
    SELECT p.uf, p.cliente_nome, p.cliente_chave, SUM(p.total) v
      FROM pedidos p WHERE ${where} AND p.uf IS NOT NULL
     GROUP BY p.uf, p.cliente_chave
     ORDER BY v DESC`).all(...par);
  const principal = new Map();
  for (const d of porClienteUf) {
    if (!principal.has(d.uf)) principal.set(d.uf, d);
  }
  // principal cidade, para o balao do mapa
  const porCidadeUf = db.prepare(`
    SELECT p.uf, p.cidade, SUM(p.total) v
      FROM pedidos p WHERE ${where} AND p.uf IS NOT NULL AND p.cidade IS NOT NULL
     GROUP BY p.uf, p.municipio_id
     ORDER BY v DESC`).all(...par);
  const principalCidade = new Map();
  for (const d of porCidadeUf) {
    if (!principalCidade.has(d.uf)) principalCidade.set(d.uf, d);
  }

  const totalValor = linhas.reduce((s, l) => s + l.valor, 0);
  const totalPedidos = linhas.reduce((s, l) => s + l.pedidos, 0);
  const totalPecas = linhas.reduce((s, l) => s + l.pecas, 0);
  return linhas
    .map((l) => {
      const pc = principal.get(l.uf);
      const cid = principalCidade.get(l.uf);
      return {
        ...l,
        nome: NOME_UF[l.uf] ?? l.uf,
        pct_valor: totalValor ? (l.valor / totalValor) * 100 : 0,
        pct_pedidos: totalPedidos ? (l.pedidos / totalPedidos) * 100 : 0,
        pct_pecas: totalPecas ? (l.pecas / totalPecas) * 100 : 0,
        ticket_medio: l.pedidos ? l.valor / l.pedidos : 0,
        principal_cliente: pc?.cliente_nome ?? null,
        principal_cliente_chave: pc?.cliente_chave ?? null,
        principal_cliente_valor: pc?.v ?? 0,
        // participacao do maior cliente DENTRO do estado
        principal_cliente_pct: l.valor ? ((pc?.v ?? 0) / l.valor) * 100 : 0,
        principal_cidade: cid?.cidade ?? null,
        principal_cidade_valor: cid?.v ?? 0,
        principal_cidade_pct: l.valor ? ((cid?.v ?? 0) / l.valor) * 100 : 0,
      };
    })
    .sort((a, b) => b.valor - a.valor);
}

/** Agregado por municipio -- bolhas do mapa e ranking de cidades. */
export function porCidade(q) {
  const { where, par } = construirFiltro(q);
  const linhas = db.prepare(`
    SELECT p.municipio_id, p.cidade, p.uf, p.lat, p.lon,
           COALESCE(SUM(p.total), 0)       AS valor,
           COUNT(DISTINCT p.uid)           AS pedidos,
           COUNT(DISTINCT p.cliente_chave) AS clientes,
           COALESCE(SUM(p.qtd_pecas), 0)   AS pecas
      FROM pedidos p
     WHERE ${where} AND p.municipio_id IS NOT NULL
     GROUP BY p.municipio_id
     ORDER BY valor DESC`).all(...par);

  // Principal cliente da cidade (maior valor).
  const porClienteCidade = db.prepare(`
    SELECT p.municipio_id, p.cliente_nome, SUM(p.total) v
      FROM pedidos p
     WHERE ${where} AND p.municipio_id IS NOT NULL
     GROUP BY p.municipio_id, p.cliente_chave
     ORDER BY v DESC`).all(...par);
  const principal = new Map();
  for (const d of porClienteCidade) {
    if (!principal.has(d.municipio_id)) principal.set(d.municipio_id, d.cliente_nome);
  }

  // Representante responsavel pela cidade = o de maior valor vendido ali.
  // Consulta propria (agrupada por representante) para nao depender de coluna
  // solta num GROUP BY, que o SQLite resolveria de forma arbitraria.
  const porRepCidade = db.prepare(`
    SELECT p.municipio_id, p.representante, SUM(p.total) v
      FROM pedidos p
     WHERE ${where} AND p.municipio_id IS NOT NULL AND p.representante IS NOT NULL
     GROUP BY p.municipio_id, p.representante
     ORDER BY v DESC`).all(...par);
  const repCidade = new Map();
  for (const d of porRepCidade) {
    if (!repCidade.has(d.municipio_id)) repCidade.set(d.municipio_id, d.representante);
  }
  const total = linhas.reduce((s, l) => s + l.valor, 0);
  return linhas.map((l) => ({
    ...l,
    pct_valor: total ? (l.valor / total) * 100 : 0,
    principal_cliente: principal.get(l.municipio_id) ?? null,
    representante: repCidade.get(l.municipio_id) ?? null,
  }));
}

/** Clientes (opcionalmente de uma cidade/UF). */
export function porCliente(q) {
  const { where, par } = construirFiltro(q);
  const limite = Math.min(Number(q.limite) || 500, 5000);
  const linhas = db.prepare(`
    SELECT p.cliente_chave, p.cliente_nome, p.cnpj,
           MAX(p.cidade) AS cidade, MAX(p.uf) AS uf, MAX(p.municipio_id) AS municipio_id,
           COALESCE(SUM(p.total), 0)     AS valor,
           COUNT(DISTINCT p.uid)         AS pedidos,
           COALESCE(SUM(p.qtd_pecas), 0) AS pecas,
           MAX(p.data)                   AS ultima_compra,
           MIN(p.data)                   AS primeira_compra
      FROM pedidos p
     WHERE ${where}
     GROUP BY p.cliente_chave
     ORDER BY valor DESC
     LIMIT ${limite}`).all(...par);

  // representante mais recente de cada cliente
  const reps = db.prepare(`
    SELECT p.cliente_chave, p.representante, MAX(p.data) d
      FROM pedidos p WHERE ${where} AND p.representante IS NOT NULL
     GROUP BY p.cliente_chave, p.representante ORDER BY d DESC`).all(...par);
  const mapaRep = new Map();
  for (const r of reps) if (!mapaRep.has(r.cliente_chave)) mapaRep.set(r.cliente_chave, r.representante);

  // top 3 produtos por cliente
  const tops = db.prepare(`
    SELECT p.cliente_chave, i.produto, SUM(i.qtd) q, SUM(i.valor) v
      FROM pedidos p JOIN itens i ON i.uid_pedido = p.uid
     WHERE ${where}
     GROUP BY p.cliente_chave, i.produto
     ORDER BY v DESC`).all(...par);
  const mapaTop = new Map();
  for (const t of tops) {
    const arr = mapaTop.get(t.cliente_chave) ?? [];
    if (arr.length < 3) arr.push({ produto: t.produto, qtd: t.q, valor: t.v });
    mapaTop.set(t.cliente_chave, arr);
  }

  const total = linhas.reduce((s, l) => s + l.valor, 0);
  return linhas.map((l) => ({
    ...l,
    pct_valor: total ? (l.valor / total) * 100 : 0,
    ticket_medio: l.pedidos ? l.valor / l.pedidos : 0,
    representante: mapaRep.get(l.cliente_chave) ?? null,
    principais_produtos: mapaTop.get(l.cliente_chave) ?? [],
  }));
}

/** Detalhe de um cliente: cabecalho, produtos comprados e pedidos. */
export function detalheCliente(chave, q) {
  const filtro = { ...q, cliente: chave };
  const { where, par } = construirFiltro(filtro);
  const cab = db.prepare(`
    SELECT p.cliente_chave, p.cliente_nome, p.cnpj,
           MAX(p.cidade) cidade, MAX(p.uf) uf, MAX(p.municipio_id) municipio_id,
           COALESCE(SUM(p.total),0) valor, COUNT(DISTINCT p.uid) pedidos,
           COALESCE(SUM(p.qtd_pecas),0) pecas,
           MAX(p.data) ultima_compra, MIN(p.data) primeira_compra
      FROM pedidos p WHERE ${where} GROUP BY p.cliente_chave`).get(...par);
  if (!cab) return null;

  const rep = db.prepare(`
    SELECT p.representante FROM pedidos p WHERE ${where} AND p.representante IS NOT NULL
     ORDER BY p.data DESC LIMIT 1`).get(...par);

  const ordem = ordenarProdutos(q.ordem);
  const produtos = db.prepare(`
    SELECT i.produto, i.sku, i.descricao, i.categoria, i.linha,
           SUM(i.qtd) qtd, SUM(i.valor) valor, COUNT(DISTINCT p.uid) pedidos
      FROM pedidos p JOIN itens i ON i.uid_pedido = p.uid
     WHERE ${where}
     GROUP BY i.sku
     ORDER BY ${ordem}`).all(...par);

  // nome distinto de `cab.pedidos` (que e a CONTAGEM) para nao sobrescrever o KPI
  const listaPedidos = db.prepare(`
    SELECT p.uid, p.numero, p.data, p.situacao, p.faturado, p.total, p.qtd_pecas,
           p.representante, p.cidade, p.uf, p.tipo_operacao, p.lista_preco
      FROM pedidos p WHERE ${where} ORDER BY p.data DESC`).all(...par);

  const porMes = db.prepare(`
    SELECT p.mes_ref, COALESCE(SUM(p.total),0) valor, COUNT(DISTINCT p.uid) pedidos
      FROM pedidos p WHERE ${where} GROUP BY p.mes_ref ORDER BY p.mes_ref`).all(...par);

  return {
    ...cab,
    ticket_medio: cab.pedidos ? cab.valor / cab.pedidos : 0,
    representante: rep?.representante ?? null,
    produtos,
    lista_pedidos: listaPedidos,
    por_mes: porMes,
  };
}

function ordenarProdutos(ordem) {
  switch (String(ordem || 'valor_desc')) {
    case 'qtd_desc': return 'qtd DESC';
    case 'qtd_asc': return 'qtd ASC';
    case 'valor_asc': return 'valor ASC';
    case 'nome_asc': return 'i.descricao ASC';
    default: return 'valor DESC';
  }
}

/** Ranking de produtos (agrupado por produto pai ou por SKU). */
export function porProduto(q) {
  const { where, par } = construirFiltro(q);
  const porSku = String(q.nivel || 'produto') === 'sku';
  const chave = porSku ? 'i.sku' : 'i.produto';
  const ordem = ordenarProdutos(q.ordem);
  const limite = Math.min(Number(q.limite) || 200, 2000);
  const linhas = db.prepare(`
    SELECT ${chave} AS chave,
           MAX(i.produto) produto, ${porSku ? 'MAX(i.sku)' : 'NULL'} sku,
           MAX(i.descricao) descricao, MAX(i.categoria) categoria, MAX(i.linha) linha,
           SUM(i.qtd) qtd, SUM(i.valor) valor,
           COUNT(DISTINCT p.uid) pedidos,
           COUNT(DISTINCT p.cliente_chave) clientes,
           COUNT(DISTINCT p.uf) estados
      FROM pedidos p JOIN itens i ON i.uid_pedido = p.uid
     WHERE ${where} AND ${chave} IS NOT NULL AND ${chave} <> ''
     GROUP BY ${chave}
     ORDER BY ${ordem}
     LIMIT ${limite}`).all(...par);
  const total = linhas.reduce((s, l) => s + l.valor, 0);
  return linhas.map((l) => ({ ...l, pct_valor: total ? (l.valor / total) * 100 : 0 }));
}

/**
 * Detalhe de um produto: a grade de SKUs por dentro dele.
 *
 * Serve as analises de projecao de venda e compra -- a curva de grade (quanto cada
 * tamanho/cor representa do produto) e a evolucao mes a mes de cada SKU.
 *
 * Atencao: o filtro geral restringe os PEDIDOS; aqui os ITENS tambem sao
 * restritos ao produto pedido, senao viriam todos os itens dos pedidos que
 * contem o produto.
 */
export function detalheProduto(nomeProduto, q) {
  const { where, par } = construirFiltro(q);
  const base = `FROM pedidos p JOIN itens i ON i.uid_pedido = p.uid
                WHERE ${where} AND i.produto = ?`;
  const p2 = [...par, nomeProduto];

  // As contagens usam prefixo n_ para nao colidirem com as LISTAS de mesmo nome
  // devolvidas mais abaixo (clientes, estados, skus) -- o spread sobrescreveria.
  const cab = db.prepare(`
    SELECT MAX(i.produto) produto, MAX(i.categoria) categoria, MAX(i.linha) linha,
           SUM(i.qtd) qtd, SUM(i.valor) valor,
           COUNT(DISTINCT p.uid) pedidos,
           COUNT(DISTINCT p.cliente_chave) n_clientes,
           COUNT(DISTINCT p.uf) n_estados,
           COUNT(DISTINCT i.sku) n_skus,
           MAX(p.data) ultima_venda, MIN(p.data) primeira_venda
      ${base}`).get(...p2);
  if (!cab || !cab.produto) return null;
  cab.preco_medio = cab.qtd ? cab.valor / cab.qtd : 0;

  const ordem = ordenarProdutos(q.ordem);
  const skus = db.prepare(`
    SELECT i.sku, MAX(i.descricao) descricao,
           SUM(i.qtd) qtd, SUM(i.valor) valor,
           COUNT(DISTINCT p.uid) pedidos,
           COUNT(DISTINCT p.cliente_chave) clientes,
           MAX(p.data) ultima_venda
      ${base} AND i.sku IS NOT NULL AND i.sku <> ''
     GROUP BY i.sku
     ORDER BY ${ordem}`).all(...p2);

  const totalQtd = skus.reduce((s, x) => s + x.qtd, 0);
  const totalValor = skus.reduce((s, x) => s + x.valor, 0);

  // evolucao mensal do produto e de cada SKU (mix de grade mes a mes)
  const porMes = db.prepare(`
    SELECT p.mes_ref, SUM(i.qtd) qtd, SUM(i.valor) valor, COUNT(DISTINCT p.uid) pedidos
      ${base} AND p.mes_ref IS NOT NULL
     GROUP BY p.mes_ref ORDER BY p.mes_ref`).all(...p2);
  const porMesSku = db.prepare(`
    SELECT p.mes_ref, i.sku, SUM(i.qtd) qtd, SUM(i.valor) valor
      ${base} AND p.mes_ref IS NOT NULL AND i.sku IS NOT NULL AND i.sku <> ''
     GROUP BY p.mes_ref, i.sku ORDER BY p.mes_ref`).all(...p2);

  const clientes = db.prepare(`
    SELECT p.cliente_nome, p.cliente_chave, MAX(p.uf) uf,
           SUM(i.qtd) qtd, SUM(i.valor) valor, COUNT(DISTINCT p.uid) pedidos
      ${base}
     GROUP BY p.cliente_chave ORDER BY valor DESC LIMIT 15`).all(...p2);

  const estados = db.prepare(`
    SELECT p.uf, SUM(i.qtd) qtd, SUM(i.valor) valor
      ${base} AND p.uf IS NOT NULL
     GROUP BY p.uf ORDER BY valor DESC`).all(...p2);

  // SKUs que ja venderam alguma vez mas nao no filtro atual: para projecao de
  // compra, o tamanho que PAROU de sair importa tanto quanto o que mais sai.
  const vendidos = new Set(skus.map((s) => s.sku));
  const skusSemVenda = db.prepare(`
    SELECT i.sku, MAX(i.descricao) descricao, MAX(p.data) ultima_venda, SUM(i.qtd) qtd_historica
      FROM pedidos p JOIN itens i ON i.uid_pedido = p.uid
     WHERE p.valido = 1 AND i.produto = ? AND i.sku IS NOT NULL AND i.sku <> ''
     GROUP BY i.sku ORDER BY i.sku`).all(nomeProduto)
    .filter((s) => !vendidos.has(s.sku));

  return {
    ...cab,
    skus: skus.map((s) => ({
      ...s,
      pct_qtd: totalQtd ? (s.qtd / totalQtd) * 100 : 0,
      pct_valor: totalValor ? (s.valor / totalValor) * 100 : 0,
      preco_medio: s.qtd ? s.valor / s.qtd : 0,
    })),
    por_mes: porMes,
    por_mes_sku: porMesSku,
    clientes,
    estados,
    skus_sem_venda: skusSemVenda,
  };
}

/** Performance por representante. */
export function porRepresentante(q) {
  const { where, par } = construirFiltro(q);
  const linhas = db.prepare(`
    SELECT COALESCE(p.representante, 'Sem representante') AS representante,
           COALESCE(SUM(p.total), 0)       AS valor,
           COALESCE(SUM(CASE WHEN p.faturado = 1 THEN p.total ELSE 0 END), 0) AS valor_faturado,
           COUNT(DISTINCT p.uid)           AS pedidos,
           COUNT(DISTINCT p.cliente_chave) AS clientes,
           COUNT(DISTINCT p.uf)            AS estados,
           COUNT(DISTINCT p.municipio_id)  AS cidades,
           COALESCE(SUM(p.qtd_pecas), 0)   AS pecas
      FROM pedidos p WHERE ${where}
     GROUP BY COALESCE(p.representante, 'Sem representante')
     ORDER BY valor DESC`).all(...par);
  const total = linhas.reduce((s, l) => s + l.valor, 0);
  return linhas.map((l) => ({
    ...l,
    pct_valor: total ? (l.valor / total) * 100 : 0,
    ticket_medio: l.pedidos ? l.valor / l.pedidos : 0,
  }));
}

/** Serie temporal (para acompanhar a mudanca de concentracao mes a mes). */
export function porMes(q) {
  const { where, par } = construirFiltro(q);
  return db.prepare(`
    SELECT p.mes_ref,
           COALESCE(SUM(p.total), 0)       AS valor,
           COUNT(DISTINCT p.uid)           AS pedidos,
           COUNT(DISTINCT p.cliente_chave) AS clientes,
           COUNT(DISTINCT p.uf)            AS estados,
           COUNT(DISTINCT p.municipio_id)  AS cidades,
           COALESCE(SUM(p.qtd_pecas), 0)   AS pecas
      FROM pedidos p WHERE ${where} AND p.mes_ref IS NOT NULL
     GROUP BY p.mes_ref ORDER BY p.mes_ref`).all(...par);
}

/**
 * Faturamento mensal da aba PEDIDOS FATURADOS, como o sync leu da planilha.
 *
 * E um total por mes, agrupado pela coluna FATURAMENTO da aba, sem passar pelas
 * regras de deduplicacao da base -- serve para bater com o que o comercial ve
 * somando a coluna na planilha. Por isso NAO responde aos filtros.
 */
export function faturamentoMensal() {
  try {
    const bruto = JSON.parse(getMeta('faturamento_mensal') ?? 'null');
    if (bruto?.meses) return bruto;
  } catch { /* meta ausente ou invalido: cai no vazio abaixo */ }
  return { aba: null, meses: [], total: 0, linhas: 0, sem_data: 0 };
}

/** Concentracao por UF ao longo dos meses (share % por mes). */
export function concentracaoMensal(q) {
  const { where, par } = construirFiltro(q);
  const linhas = db.prepare(`
    SELECT p.mes_ref, p.uf, COALESCE(SUM(p.total),0) valor
      FROM pedidos p WHERE ${where} AND p.uf IS NOT NULL AND p.mes_ref IS NOT NULL
     GROUP BY p.mes_ref, p.uf`).all(...par);
  const totalMes = new Map();
  for (const l of linhas) totalMes.set(l.mes_ref, (totalMes.get(l.mes_ref) ?? 0) + l.valor);
  return linhas.map((l) => ({
    ...l,
    pct: totalMes.get(l.mes_ref) ? (l.valor / totalMes.get(l.mes_ref)) * 100 : 0,
  }));
}

/** Opcoes disponiveis para os filtros (sempre do universo total, nao do filtrado). */
export function opcoesFiltro() {
  const representantes = db.prepare(`
    SELECT COALESCE(representante,'Sem representante') valor, COUNT(DISTINCT uid) n,
           COALESCE(SUM(total),0) total
      FROM pedidos WHERE valido = 1
     GROUP BY COALESCE(representante,'Sem representante') ORDER BY total DESC`).all();
  const clientes = db.prepare(`
    SELECT cliente_chave valor, cliente_nome nome, cnpj, MAX(uf) uf, MAX(cidade) cidade,
           COALESCE(SUM(total),0) total, COUNT(DISTINCT uid) n
      FROM pedidos WHERE valido = 1
     GROUP BY cliente_chave ORDER BY total DESC`).all();
  const meses = db.prepare(`
    SELECT mes_ref valor, COALESCE(SUM(total),0) total, COUNT(DISTINCT uid) n
      FROM pedidos WHERE valido = 1 AND mes_ref IS NOT NULL
     GROUP BY mes_ref ORDER BY mes_ref DESC`).all();
  const estados = db.prepare(`
    SELECT uf valor, COALESCE(SUM(total),0) total, COUNT(DISTINCT uid) n
      FROM pedidos WHERE valido = 1 AND uf IS NOT NULL
     GROUP BY uf ORDER BY total DESC`).all();
  const produtos = db.prepare(`
    SELECT i.produto valor, SUM(i.valor) total, SUM(i.qtd) qtd
      FROM pedidos p JOIN itens i ON i.uid_pedido = p.uid
     WHERE p.valido = 1 AND i.produto IS NOT NULL AND i.produto <> ''
     GROUP BY i.produto ORDER BY total DESC`).all();
  const tipos = db.prepare(`
    SELECT tipo_operacao valor, COUNT(DISTINCT uid) n FROM pedidos
     WHERE valido = 1 GROUP BY tipo_operacao ORDER BY n DESC`).all();
  return {
    representantes,
    clientes: clientes.map((c) => ({ ...c, nome: c.nome ?? c.valor })),
    meses,
    estados: estados.map((e) => ({ ...e, nome: NOME_UF[e.valor] ?? e.valor })),
    produtos,
    tipos,
  };
}

/** Pedidos individuais (drill-down final e conferencia). */
export function listarPedidos(q) {
  const { where, par } = construirFiltro(q);
  const limite = Math.min(Number(q.limite) || 200, 2000);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const total = db.prepare(`SELECT COUNT(*) n FROM pedidos p WHERE ${where}`).get(...par).n;
  const linhas = db.prepare(`
    SELECT p.uid, p.conta, p.numero, p.data, p.situacao, p.faturado, p.cliente_nome, p.cnpj,
           p.cidade, p.uf, p.representante, p.total, p.qtd_pecas, p.tipo_operacao,
           p.natureza, p.lista_preco, p.fontes
      FROM pedidos p WHERE ${where}
     ORDER BY p.data DESC, p.numero DESC
     LIMIT ${limite} OFFSET ${offset}`).all(...par);
  return { total, limite, offset, linhas };
}

/** Itens de um pedido. */
export function itensDoPedido(uid) {
  return db.prepare(`
    SELECT seq, sku, descricao, produto, categoria, linha, qtd, valor_unit, valor
      FROM itens WHERE uid_pedido = ? ORDER BY seq`).all(uid);
}

/** Pedidos excluidos da contagem (transparencia das regras). */
export function pedidosExcluidos() {
  return db.prepare(`
    SELECT motivo_exclusao, COUNT(*) pedidos, COALESCE(SUM(total),0) valor
      FROM pedidos WHERE valido = 0
     GROUP BY motivo_exclusao ORDER BY valor DESC`).all();
}

export function alertas() {
  const porTipo = db.prepare(`
    SELECT tipo, gravidade, COUNT(*) n, COALESCE(SUM(valor),0) valor
      FROM alertas GROUP BY tipo, gravidade
     ORDER BY CASE gravidade WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, n DESC`).all();
  const itens = db.prepare(`
    SELECT tipo, gravidade, chave, detalhe, valor FROM alertas
     ORDER BY CASE gravidade WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, tipo
     LIMIT 800`).all();
  return { por_tipo: porTipo, itens };
}
