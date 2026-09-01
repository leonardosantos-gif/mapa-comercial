/**
 * Sincronizacao das duas fontes -> banco local.
 *
 * HIERARQUIA: a **planilha comercial e a base** (define quais pedidos existem, o
 * valor e o mes de competencia); o **Olist/Tiny entra como conferencia e
 * enriquecimento** (cidade/UF para o mapa, CNPJ, SKU/quantidade, situacao).
 *
 * Etapas:
 *  1. base geografica (IBGE)
 *  2. snapshot do Olist (com cache incremental por assinatura)
 *  3. leitura da planilha e escolha das linhas que formam a base
 *  4. materializacao da tabela de fatos (planilha + enriquecimento do Olist)
 *  5. alertas de dados
 */
import 'dotenv/config';
import {
  db, setMeta, getMeta, limparAlertas, inserirAlerta, limparFatos,
  upsertPedidoOlist, apagarItensOlist, inserirItemOlist,
  inserirPedido, inserirItem, inserirAmostra, inserirLead,
} from './db.js';
import { varejo, matriz, pesquisarPedidos, estatisticas, logErro } from './tiny.js';
import { prepararGeo, resolverMunicipio, UFS_VALIDAS, norm } from './geo.js';
import { lerPlanilha, lerTotaisMensais, lerAmostras, lerLeads, lerFaturamentoMensal } from './planilha.js';
import { representanteAjustado, recarregarAjustes, listarAjustes } from './ajustes.js';
import {
  ALVO_MATRIZ, avaliarPedido, ehFaturado, ehCancelado, classificarProduto, produtoPai,
  padronizarRepresentante, chaveCliente, dataIso, canonizarProdutos, tituloCanonico,
} from './regras.js';

const agora = () => new Date().toISOString();

/** Quebra uma janela dd/mm/aaaa..dd/mm/aaaa em janelas de um ano-calendario. */
export function fatiarPorAno(de, ate) {
  const [d1, m1, a1] = de.split('/').map(Number);
  const [d2, m2, a2] = ate.split('/').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const janelas = [];
  for (let ano = a1; ano <= a2; ano++) {
    const ini = ano === a1 ? `${pad(d1)}/${pad(m1)}/${ano}` : `01/01/${ano}`;
    const fim = ano === a2 ? `${pad(d2)}/${pad(m2)}/${ano}` : `31/12/${ano}`;
    janelas.push({ dataInicial: ini, dataFinal: fim });
  }
  return janelas;
}

export const estadoSync = {
  rodando: false, etapa: null, progresso: 0, total: 0,
  iniciadoEm: null, ultimoResultado: null,
};

function carregarCacheNatureza() {
  const bruto = getMeta('natureza_cache');
  try { return bruto ? JSON.parse(bruto) : {}; } catch { return {}; }
}

async function resolverNatureza(client, idNatureza, idNf, cache) {
  if (!idNatureza) return null;
  if (idNatureza in cache) return cache[idNatureza];
  if (!idNf || idNf === '0') return null;
  try {
    const nf = await client('nota.fiscal.obter.php', { id: idNf });
    const nome = nf.nota_fiscal?.naturezaOperacao ?? nf.nota_fiscal?.natureza_operacao ?? null;
    if (nome) cache[idNatureza] = nome;
    return nome;
  } catch (e) {
    logErro('natureza', `${idNatureza}: ${e.message}`);
    return null;
  }
}

/** Monta o registro do snapshot do ERP a partir do detalhe da API. */
function montarPedidoOlist({ conta, grupo, p, natureza, assinatura }) {
  const data = dataIso(p.data_pedido);
  const cidadeRaw = p.cliente?.cidade ?? null;
  const ufRaw = (p.cliente?.uf ?? '').trim().toUpperCase() || null;
  const mun = UFS_VALIDAS.has(ufRaw) ? resolverMunicipio(cidadeRaw, ufRaw) : null;
  const exterior = ufRaw === 'EX' || norm(cidadeRaw) === 'EXTERIOR';

  const clienteNome = (p.cliente?.nome ?? '').replace(/\s+/g, ' ').trim();
  const cnpj = p.cliente?.cpf_cnpj ?? null;
  const { valido, motivo, tipo_operacao } = avaliarPedido({
    situacao: p.situacao, natureza, cliente: clienteNome, cnpj,
  });

  const total = Number(p.total_pedido) || 0;
  const totalProdutos = Number(p.total_produtos) || 0;

  const itens = (p.itens ?? []).map((wrapper, i) => {
    const it = wrapper.item ?? wrapper;
    const qtd = Number(it.quantidade) || 0;
    const unit = Number(it.valor_unitario) || 0;
    const { categoria, linha } = classificarProduto(it.codigo, it.descricao);
    return {
      seq: i,
      sku: it.codigo || null,
      descricao: it.descricao || null,
      produto: produtoPai(it.descricao),
      categoria, linha, qtd,
      valor_unit: unit,
      valor_bruto: qtd * unit,
    };
  });

  return {
    uid: `${conta}:${p.id}`,
    conta, grupo,
    id_tiny: String(p.id),
    numero: String(p.numero ?? ''),
    data,
    mes_ref: data ? data.slice(0, 7) : null,
    situacao: p.situacao ?? null,
    faturado: ehFaturado(p.situacao) ? 1 : 0,
    cliente_nome: clienteNome,
    cnpj,
    cidade_raw: cidadeRaw,
    uf_raw: ufRaw,
    municipio_id: mun?.id ?? null,
    cidade: mun?.nome ?? null,
    uf: mun?.uf ?? (exterior ? 'EX' : (UFS_VALIDAS.has(ufRaw) ? ufRaw : null)),
    lat: mun?.lat ?? null,
    lon: mun?.lon ?? null,
    vendedor_tiny: padronizarRepresentante(p.nome_vendedor),
    id_natureza: p.id_natureza_operacao ?? null,
    natureza: natureza ?? null,
    tipo_operacao,
    id_nf: p.id_nota_fiscal && p.id_nota_fiscal !== '0' ? String(p.id_nota_fiscal) : null,
    lista_preco: p.descricao_lista_preco ?? null,
    total,
    total_produtos: totalProdutos,
    desconto: Number(p.valor_desconto) || 0,
    qtd_pecas: itens.reduce((s, i) => s + i.qtd, 0),
    operacao_valida: valido,
    motivo_exclusao: motivo,
    assinatura,
    itens,
  };
}

function gravarPedidoOlist(reg) {
  upsertPedidoOlist.run(
    reg.uid, reg.conta, reg.grupo, reg.id_tiny, reg.numero, reg.data, reg.mes_ref,
    reg.situacao, reg.faturado, reg.cliente_nome, reg.cnpj,
    reg.cidade_raw, reg.uf_raw, reg.municipio_id, reg.cidade, reg.uf, reg.lat, reg.lon,
    reg.vendedor_tiny, reg.id_natureza, reg.natureza, reg.tipo_operacao, reg.id_nf,
    reg.lista_preco, reg.total, reg.total_produtos, reg.desconto, reg.qtd_pecas,
    reg.operacao_valida, reg.motivo_exclusao, reg.assinatura, agora(),
  );
  apagarItensOlist.run(reg.uid);
  for (const it of reg.itens) {
    inserirItemOlist.run(reg.uid, it.seq, it.sku, it.descricao, it.produto,
      it.categoria, it.linha, it.qtd, it.valor_unit, it.valor_bruto);
  }
}

/**
 * Escolhe as linhas da planilha que compoem o universo do dashboard.
 *
 * As **abas mensais sao o livro-caixa** (a soma das linhas bate com o total que o
 * comercial declara no topo da aba). As abas de status entram apenas com pedidos
 * cujo numero NAO aparece em nenhuma aba mensal -- e o que traz janeiro/fevereiro
 * e 2025 sem contar duas vezes: hoje 167 das 239 linhas de status repetem pedidos
 * das mensais, o que somaria R$ 1,5 milhao em dobro.
 */
export function definirBase(linhas) {
  const pedidosMensais = new Set();
  const mesesFechados = new Set();
  for (const l of linhas) {
    if (l.tipo_aba !== 'mensal') continue;
    for (const n of l.pedidos_ref) pedidosMensais.add(n);
    if (l.mes_aba) mesesFechados.add(l.mes_aba);
  }
  const vistosStatus = new Set();
  return linhas.map((l) => {
    if (l.tipo_aba === 'mensal') return { ...l, base: 1, motivo_nao_base: null };

    const jaNoMes = l.pedidos_ref.some((n) => pedidosMensais.has(n));
    if (jaNoMes) {
      return { ...l, base: 0, motivo_nao_base: 'pedido ja lancado em aba mensal' };
    }
    // Mes que tem aba mensal esta FECHADO: quem manda nele e a aba, senao o total
    // do dashboard passaria do total que o comercial declara. As abas de status
    // servem para cobrir os meses sem aba mensal (jan/fev e 2025).
    const mesDaLinha = l.data ? l.data.slice(0, 7) : null;
    if (mesDaLinha && mesesFechados.has(mesDaLinha)) {
      return { ...l, base: 0, motivo_nao_base: `mes ${mesDaLinha} fechado pela aba mensal` };
    }
    // dentro das abas de status, o mesmo pedido pode repetir entre abas
    const chave = l.pedidos_ref.join(',') || `sem-numero:${norm(l.cliente)}:${l.valor}`;
    if (vistosStatus.has(chave)) {
      return { ...l, base: 0, motivo_nao_base: 'linha repetida entre abas de status' };
    }
    vistosStatus.add(chave);
    if (!l.valor) return { ...l, base: 0, motivo_nao_base: 'linha sem valor' };
    return { ...l, base: 1, motivo_nao_base: null };
  });
}

/** Sincronizacao completa. `full: true` ignora o cache de assinatura do Olist. */
export async function sincronizar({ full = false, dataInicial, dataFinal, onLog } = {}) {
  if (estadoSync.rodando) throw new Error('Uma sincronizacao ja esta em andamento');
  estadoSync.rodando = true;
  estadoSync.iniciadoEm = agora();
  estadoSync.progresso = 0;
  estadoSync.total = 0;

  const inicio = agora();
  const log = (msg) => { onLog?.(msg); console.log(msg); };
  const de = dataInicial || process.env.SYNC_DATA_INICIAL || '01/01/2025';
  const hoje = new Date();
  const ate = dataFinal || `31/12/${hoje.getFullYear()}`;
  const cacheNatureza = carregarCacheNatureza();
  let novos = 0, atualizados = 0, reaproveitados = 0;

  try {
    // ---- 1. geografia ----
    estadoSync.etapa = 'base geografica';
    (await prepararGeo({ force: false })).forEach((l) => log(`geo: ${l}`));

    // ---- 2. snapshot do Olist ----
    const resumos = [];
    estadoSync.etapa = 'Olist: conta B2B';
    log(`Olist -- buscando pedidos da conta B2B (${de} a ${ate})...`);
    for (const janela of fatiarPorAno(de, ate)) {
      try {
        const s = await pesquisarPedidos(varejo, janela,
          (pag, tot) => log(`  B2B ${janela.dataInicial.slice(6)} pagina ${pag}/${tot}`));
        s.forEach((x) => resumos.push({ conta: 'b2b', grupo: null, client: varejo, s: x }));
        log(`B2B ${janela.dataInicial.slice(6)}: ${s.length} pedidos`);
      } catch (e) {
        logErro('pesquisa.b2b', `${janela.dataInicial}: ${e.message}`);
        log(`B2B ${janela.dataInicial.slice(6)}: FALHOU (${e.message.split('\n')[0]})`);
      }
    }

    estadoSync.etapa = 'Olist: clientes-alvo da Matriz';
    for (const alvo of ALVO_MATRIZ) {
      let n = 0;
      for (const janela of fatiarPorAno(de, ate)) {
        try {
          const s = await pesquisarPedidos(matriz, { ...janela, cpf_cnpj: alvo.cnpj });
          s.forEach((x) => resumos.push({ conta: 'matriz', grupo: alvo.grupo, client: matriz, s: x }));
          n += s.length;
        } catch (e) {
          logErro('pesquisa.matriz', `${alvo.cnpj} ${janela.dataInicial}: ${e.message}`);
        }
      }
      log(`Matriz ${alvo.grupo} ${alvo.cnpj}: ${n} pedidos`);
    }

    const vistos = new Set();
    const unicos = resumos.filter((r) => {
      const k = `${r.conta}:${r.s.id}`;
      if (vistos.has(k)) return false;
      vistos.add(k);
      return true;
    });

    const assinaturas = new Map(
      db.prepare('SELECT uid, assinatura FROM pedidos_olist').all().map((r) => [r.uid, r.assinatura]),
    );

    estadoSync.etapa = 'Olist: detalhando pedidos';
    estadoSync.total = unicos.length;
    log(`Detalhando ${unicos.length} pedidos do Olist...`);
    for (let i = 0; i < unicos.length; i++) {
      const { conta, grupo, client, s } = unicos[i];
      estadoSync.progresso = i + 1;
      const uid = `${conta}:${s.id}`;
      const assinatura = `${s.situacao}|${Number(s.valor) || 0}`;
      if (!full && assinaturas.get(uid) === assinatura) { reaproveitados++; continue; }
      let detalhe;
      try {
        detalhe = await client('pedido.obter.php', { id: s.id });
      } catch (e) {
        logErro('pedido.obter', `${uid}: ${e.message}`);
        continue;
      }
      const p = detalhe.pedido;
      const natureza = await resolverNatureza(client, p.id_natureza_operacao, p.id_nota_fiscal, cacheNatureza);
      gravarPedidoOlist(montarPedidoOlist({ conta, grupo, p, natureza, assinatura }));
      if (assinaturas.has(uid)) atualizados++; else novos++;
      if ((i + 1) % 25 === 0) log(`  ${i + 1}/${unicos.length} (novos ${novos}, atualizados ${atualizados}, cache ${reaproveitados})`);
    }
    setMeta('natureza_cache', cacheNatureza);

    // ---- 3. planilha (a base) ----
    recarregarAjustes();
    const infoAjustes = listarAjustes();
    if (infoAjustes.erro) log(`AVISO: config/representante-por-cliente.json invalido: ${infoAjustes.erro}`);
    else if (infoAjustes.total) log(`ajustes de carteira: ${infoAjustes.total_clientes} cliente(s) + ${infoAjustes.total_pedidos} pedido(s) com representante reatribuido`);
    estadoSync.etapa = 'planilha comercial (base)';
    log('Lendo a planilha comercial publicada...');
    const planilha = await lerPlanilha();
    const linhas = definirBase(planilha.linhas);
    planilha.avisos.forEach((a) => log(`planilha AVISO: ${a}`));

    // indice do Olist por numero de pedido (para enriquecer)
    const olistPorNumero = new Map();
    for (const p of db.prepare('SELECT * FROM pedidos_olist').all()) {
      const n = String(Number(p.numero));
      // conta b2b tem precedencia (numeracao propria); matriz entra se nao houver
      if (!olistPorNumero.has(n) || p.conta === 'b2b') olistPorNumero.set(n, p);
    }
    const itensOlist = db.prepare('SELECT * FROM itens_olist WHERE uid_pedido = ? ORDER BY seq');

    db.exec('DELETE FROM planilha_linhas');
    const insPl = db.prepare(`INSERT INTO planilha_linhas
      (aba, gid, tipo_aba, mes_aba, cliente, pedido_olist, pedidos_ref, parcial,
       data_raw, data, data_faturamento, vendedor, valor, nf, situacao, observacoes,
       base, motivo_nao_base, uid_olist, conciliado)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    // ---- 4. tabela de fatos ----
    estadoSync.etapa = 'consolidando';
    limparFatos();

    // Nome de cliente -> CNPJ, aprendido das linhas que casaram com o Olist.
    // A planilha nao tem CNPJ; sem este mapa o mesmo cliente se fragmentaria
    // entre as linhas com e sem correspondencia no ERP.
    const cnpjPorCliente = new Map();
    for (const l of linhas) {
      const o = l.pedidos_ref.map((n) => olistPorNumero.get(n)).find(Boolean);
      if (o?.cnpj) cnpjPorCliente.set(norm(l.cliente), o.cnpj);
    }
    // Localizacao por cliente: a planilha nao tem cidade/UF, e um mesmo cliente
    // compra sempre do mesmo endereco. Assim uma linha sem numero de pedido (ou
    // com pedido ausente do Olist) ainda entra no mapa pelo endereco conhecido do
    // cliente. Municipio tem precedencia; na falta dele vale a UF -- e o caso da
    // exportacao (UF "EX"), que precisa ficar rotulada como Exterior e nao como
    // "sem localizacao".
    const localPorCliente = new Map();
    for (const l of linhas) {
      const o = l.pedidos_ref.map((n) => olistPorNumero.get(n)).find(Boolean);
      if (!o) continue;
      const chave = norm(l.cliente);
      const atual = localPorCliente.get(chave);
      if (!atual || (!atual.municipio_id && o.municipio_id)) {
        if (o.municipio_id || o.uf) localPorCliente.set(chave, o);
      }
    }

    // Meses que tem aba mensal estao fechados pelo comercial.
    const mesesFechados = new Set(linhas.filter((l) => l.tipo_aba === 'mensal' && l.mes_aba)
      .map((l) => l.mes_aba));

    let totalItens = 0;
    let semLocal = 0;
    let semOlist = 0;
    for (const l of linhas) {
      const olist = l.pedidos_ref.map((n) => olistPorNumero.get(n)).find(Boolean) ?? null;
      const data = l.data ?? olist?.data ?? null;
      // mes de competencia: a aba mensal manda (e o fechamento comercial)
      const mesRef = l.mes_aba ?? (data ? data.slice(0, 7) : null);

      // Reaplica a regra do mes fechado agora que a data do Olist e conhecida:
      // linha de aba de status sem data propria herda a data do ERP e poderia
      // cair num mes ja fechado, estourando o total declarado.
      let base = l.base;
      let motivoNaoBase = l.motivo_nao_base;
      if (base && l.tipo_aba !== 'mensal' && mesRef && mesesFechados.has(mesRef)) {
        base = 0;
        motivoNaoBase = `mes ${mesRef} fechado pela aba mensal (data veio do Olist)`;
      }

      const idLinha = insPl.run(
        l.aba, l.gid, l.tipo_aba, l.mes_aba, l.cliente, l.pedido_olist,
        l.pedidos_ref.join(','), l.parcial ? 1 : 0, l.data_raw, l.data, l.data_faturamento, l.vendedor,
        l.valor, l.nf, l.situacao, l.observacoes, base, motivoNaoBase,
        olist?.uid ?? null, olist ? 1 : 0,
      ).lastInsertRowid;
      if (!base) continue;

      const uid = `pl:${idLinha}`;
      const local = (olist?.municipio_id || olist?.uf) ? olist
        : (localPorCliente.get(norm(l.cliente)) ?? null);
      // A planilha grava a situacao em caixa alta ("ENTREGUE") e o Olist em caixa
      // mista ("Entregue"): sem padronizar, o mesmo estado apareceria duas vezes
      // em qualquer agrupamento. Sem situacao em nenhuma fonte -> "Nao informado",
      // que NAO e o mesmo que "em aberto".
      const situacao = tituloCanonico(l.situacao ?? olist?.situacao ?? '') || 'Nao informado';
      const cnpj = olist?.cnpj ?? cnpjPorCliente.get(norm(l.cliente)) ?? null;
      const total = l.valor ?? 0;

      const cancelado = ehCancelado(situacao) || l.tipo_aba === 'cancelado';
      const valido = cancelado ? 0 : 1;
      const motivo = cancelado ? 'pedido cancelado' : null;

      if (!olist) semOlist++;
      if (!local?.municipio_id) semLocal++;

      inserirPedido.run(
        uid, idLinha, l.aba, l.tipo_aba, l.pedido_olist, l.pedidos_ref.join(','),
        l.parcial ? 1 : 0, data, l.data_faturamento ?? null, mesRef,
        mesRef ? Number(mesRef.slice(0, 4)) : null,
        situacao, ehFaturado(situacao) ? 1 : 0,
        l.cliente, chaveCliente(l.cliente, cnpj), cnpj,
        olist?.cidade_raw ?? null, olist?.uf_raw ?? null,
        local?.municipio_id ?? null, local?.cidade ?? null, local?.uf ?? null,
        local?.lat ?? null, local?.lon ?? null,
        l.vendedor, olist?.vendedor_tiny ?? null,
        // precedencia: ajuste por pedido > ajuste por cliente > planilha > ERP
        representanteAjustado(cnpj, l.cliente, l.pedido_olist, l.pedidos_ref) ?? l.vendedor ?? olist?.vendedor_tiny ?? null,
        olist?.natureza ?? null, olist?.tipo_operacao ?? 'VENDA',
        olist?.id_nf ?? null, l.nf, olist?.lista_preco ?? null,
        total, olist?.total ?? null, 0,
        valido, motivo, olist?.conta ?? null, olist?.uid ?? null,
        olist ? 'planilha+olist' : 'planilha', agora(),
      );

      // itens vem do Olist, reescalados para fechar com o VALOR da planilha
      if (olist) {
        const its = itensOlist.all(olist.uid);
        const somaBruta = its.reduce((s, it) => s + it.valor_bruto, 0);
        const fator = somaBruta > 0 ? total / somaBruta : 0;
        let pecas = 0;
        for (const it of its) {
          // pedido parcial: a proporcao dos itens vale, o valor absoluto e o da linha
          inserirItem.run(uid, it.seq, it.sku, it.descricao, it.produto, it.categoria,
            it.linha, it.qtd, it.valor_unit, it.valor_bruto, it.valor_bruto * fator);
          pecas += it.qtd;
          totalItens++;
        }
        const escalaQtd = l.parcial && olist.total > 0 ? total / olist.total : 1;
        db.prepare('UPDATE pedidos SET qtd_pecas = ? WHERE uid = ?')
          .run(pecas * (l.parcial ? escalaQtd : 1), uid);
      }
    }

    const nBase = db.prepare("SELECT COUNT(*) n FROM planilha_linhas WHERE base = 1").get().n;
    log(`base: ${nBase} lancamentos da planilha (${linhas.length - nBase} linhas fora da base)`);
    log(`enriquecimento: ${nBase - semOlist}/${nBase} com pedido no Olist; ${semLocal} sem localizacao`);

    canonizarProdutos(db);

    // ---- amostras e prospeccao (abas proprias, fora do faturamento) ----
    estadoSync.etapa = 'amostras e prospeccao';
    try {
      const { linhas: amostras, aba } = await lerAmostras();
      db.exec('DELETE FROM amostras');
      for (const a of amostras) {
        inserirAmostra.run(a.cliente, chaveCliente(a.cliente, null), a.pedido, a.data,
          a.mes_ref, a.valor, a.nf, a.envio, a.observacoes);
      }
      log(`amostras: ${amostras.length} envios${aba ? ` (aba ${aba})` : ''}`);
    } catch (e) {
      logErro('amostras', e.message);
      log(`amostras: FALHOU (${e.message})`);
    }
    try {
      const { campanhas, aba } = await lerLeads();
      db.exec('DELETE FROM leads');
      for (const c of campanhas) {
        inserirLead.run(c.data, c.data_raw, c.mes_ref, c.canal, c.campanha, c.segmento,
          c.uf, c.enviados, c.falhas, c.entregues, c.retornos, c.vendas);
      }
      log(`prospeccao: ${campanhas.length} campanhas${aba ? ` (aba ${aba})` : ''}`);
    } catch (e) {
      logErro('leads', e.message);
      log(`prospeccao: FALHOU (${e.message})`);
    }

    const totaisMensais = await lerTotaisMensais();
    setMeta('totais_planilha', totaisMensais);

    // Faturamento mensal lido direto da aba PEDIDOS FATURADOS, agrupado pela
    // coluna FATURAMENTO. Fica fora da tabela de fatos de proposito: e o numero
    // que o comercial confere somando a coluna na planilha, sem deduplicacao.
    const faturamento = await lerFaturamentoMensal();
    setMeta('faturamento_mensal', faturamento);
    if (faturamento.erro) log(`AVISO: faturamento mensal nao lido: ${faturamento.erro}`);
    else log(`faturamento (aba ${faturamento.aba}): ${faturamento.meses.length} meses, ${faturamento.linhas} linhas`);
    setMeta('abas_planilha', planilha.abas);

    // ---- 5. alertas ----
    estadoSync.etapa = 'alertas de dados';
    const nAlertas = gerarAlertas(totaisMensais);

    const fim = agora();
    const resultado = {
      inicio, fim, status: 'ok',
      base_planilha: nBase,
      linhas_planilha: linhas.length,
      pedidos_olist: unicos.length,
      olist_novos: novos, olist_atualizados: atualizados,
      reaproveitados_do_cache: reaproveitados,
      sem_correspondencia_no_olist: semOlist,
      sem_localizacao: semLocal,
      itens: totalItens,
      chamadas_api: estatisticas.chamadas,
      erros: estatisticas.erros,
      alertas: nAlertas,
      janela: { de, ate },
    };
    db.prepare(`INSERT INTO sync_log (inicio, fim, status, pedidos, itens, chamadas, erros, detalhe)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(inicio, fim, 'ok', nBase, totalItens, estatisticas.chamadas, estatisticas.erros,
           JSON.stringify(resultado));
    setMeta('ultima_sync', fim);
    setMeta('ultimo_resultado', resultado);
    estadoSync.ultimoResultado = resultado;
    log(`\nCONCLUIDO: ${nBase} lancamentos na base (planilha), ${unicos.length} pedidos no Olist, ${nAlertas} alertas.`);
    return resultado;
  } catch (e) {
    const fim = agora();
    db.prepare(`INSERT INTO sync_log (inicio, fim, status, pedidos, itens, chamadas, erros, detalhe)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(inicio, fim, 'erro', 0, 0, estatisticas.chamadas, estatisticas.erros + 1, e.message);
    logErro('sync', e.message);
    throw e;
  } finally {
    estadoSync.rodando = false;
    estadoSync.etapa = null;
  }
}

/** Detecta e grava inconsistencias de dados. */
export function gerarAlertas(totaisMensais = []) {
  limparAlertas();
  const ts = agora();
  const add = (tipo, gravidade, chave, detalhe, valor = null) =>
    inserirAlerta.run(tipo, gravidade, chave, detalhe, valor, ts);

  // --- lancamentos da planilha que o Olist nao confirma ---
  for (const r of db.prepare(
    `SELECT numero, cliente_nome, aba, total FROM pedidos
      WHERE valido = 1 AND uid_olist IS NULL ORDER BY total DESC`).all()) {
    add('sem_pedido_no_olist', 'alta', r.numero ?? '(sem numero)',
      `${r.cliente_nome} (aba ${r.aba}): pedido ${r.numero ?? 'sem numero'} nao encontrado no Olist -- sem cidade, SKU nem quantidade`,
      r.total);
  }
  // Exportacao (UF "EX") nao e erro de cadastro: nao existe area no mapa do Brasil
  // para ela. Fica de fora deste alerta e aparece como "Exterior" no ranking.
  for (const r of db.prepare(
    `SELECT numero, cliente_nome, total FROM pedidos
      WHERE valido = 1 AND municipio_id IS NULL AND COALESCE(uf, '') <> 'EX'
      ORDER BY total DESC`).all()) {
    add('sem_localizacao', 'alta', r.numero ?? '(sem numero)',
      `${r.cliente_nome}: sem cidade/UF -- fica fora do mapa`, r.total);
  }
  for (const r of db.prepare(
    `SELECT numero, cliente_nome, total FROM pedidos
      WHERE valido = 1 AND (representante IS NULL OR representante = '')`).all()) {
    add('sem_representante', 'media', r.numero ?? '(sem numero)',
      `${r.cliente_nome}: sem representante na planilha nem no Olist`, r.total);
  }
  for (const r of db.prepare(
    `SELECT numero, cliente_nome FROM pedidos WHERE valido = 1 AND numero IS NULL`).all()) {
    add('linha_sem_numero', 'media', '(sem numero)',
      `${r.cliente_nome}: linha da planilha sem numero de pedido -- nao da para conferir no Olist`);
  }

  // --- divergencia de valor planilha x Olist (parciais ficam de fora) ---
  for (const x of db.prepare(
    `SELECT numero, cliente_nome, total, total_olist FROM pedidos
      WHERE valido = 1 AND parcial = 0 AND total_olist IS NOT NULL AND total_olist > 0
        AND ABS(total - total_olist) > 0.02 * total_olist
        AND ABS(total - total_olist) > 50 ORDER BY ABS(total - total_olist) DESC`).all()) {
    add('divergencia_valor', 'media', x.numero,
      `Pedido ${x.numero} (${x.cliente_nome}): planilha R$ ${x.total.toFixed(2)} x Olist R$ ${x.total_olist.toFixed(2)}`,
      Math.abs(x.total - x.total_olist));
  }

  // --- pedidos faturados no Olist que a planilha nao lista ---
  for (const r of db.prepare(
    `SELECT o.numero, o.conta, o.cliente_nome, o.mes_ref, o.total
       FROM pedidos_olist o
      WHERE o.operacao_valida = 1
        AND NOT EXISTS (
          SELECT 1 FROM planilha_linhas pl
           WHERE ',' || pl.pedidos_ref || ',' LIKE '%,' || CAST(o.numero AS INTEGER) || ',%')
      ORDER BY o.total DESC`).all()) {
    add('ausente_na_planilha', 'media', r.numero,
      `Olist ${r.conta} #${r.numero} (${r.cliente_nome}, ${r.mes_ref}) nao esta na planilha -- fora dos numeros do dashboard`,
      r.total);
  }

  // --- itens/SKU ---
  for (const r of db.prepare(
    `SELECT p.numero, i.descricao FROM itens i JOIN pedidos p ON p.uid = i.uid_pedido
      WHERE p.valido = 1 AND (i.sku IS NULL OR i.sku = '') GROUP BY p.numero, i.descricao`).all()) {
    add('sku_ausente', 'media', r.numero, `Item sem SKU no pedido ${r.numero}: ${r.descricao}`);
  }
  for (const r of db.prepare(
    `SELECT sku, COUNT(DISTINCT produto) n, GROUP_CONCAT(DISTINCT produto) nomes,
            ROUND(SUM(valor), 2) v FROM itens
      WHERE sku IS NOT NULL AND sku <> '' GROUP BY sku HAVING n > 1 ORDER BY v DESC`).all()) {
    add('sku_nomes_divergentes', 'media', r.sku,
      `SKU ${r.sku} tem ${r.n} descricoes diferentes no ERP: ${r.nomes}`, r.v);
  }

  // --- conferencia do total mensal declarado ---
  for (const t of totaisMensais) {
    if (!t.total_planilha) continue;
    const api = db.prepare('SELECT COALESCE(SUM(total),0) s FROM pedidos WHERE valido = 1 AND mes_ref = ?')
      .get(t.mes_ref).s;
    const dif = api - t.total_planilha;
    if (Math.abs(dif) > 0.005 * t.total_planilha) {
      add('divergencia_mes', 'baixa', t.mes_ref,
        `${t.aba}: total declarado R$ ${t.total_planilha.toFixed(2)} x consolidado R$ ${api.toFixed(2)} (dif R$ ${dif.toFixed(2)})`,
        dif);
    }
  }
  return db.prepare('SELECT COUNT(*) n FROM alertas').get().n;
}

if (process.argv[1]?.endsWith('sync.js')) {
  const full = process.argv.includes('--full');
  const arg = (nome) => {
    const i = process.argv.indexOf(nome);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  sincronizar({ full, dataInicial: arg('--de'), dataFinal: arg('--ate') })
    .then(() => process.exit(0))
    .catch((e) => { console.error('ERRO no sync:', e.message); process.exit(1); });
}
