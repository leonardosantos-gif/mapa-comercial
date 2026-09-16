/**
 * Pedidos em aberto: quanto da para faturar hoje e o que esta travando.
 *
 * FONTE: a aba "EM ABERTO" da planilha comercial, lida da tabela CRUA
 * (`planilha_linhas`), nao da tabela de fatos. Esses 14 lancamentos ficam de
 * fora da base do dashboard de proposito -- a regra de deduplicacao so aceita
 * linha de aba de status quando o mes nao tem aba mensal --, entao `pedidos`
 * simplesmente nao os contem. O total daqui bate com o cabecalho da propria
 * aba (R$ 158.653,11), e NAO com o faturamento do resto do dashboard.
 *
 * Os ITENS vem do Olist (`itens_olist`), que e quem tem SKU e quantidade; o
 * VALOR continua vindo da planilha, que e a base. Quando os dois discordam, o
 * valor parcial e calculado pela PROPORCAO dos itens disponiveis aplicada ao
 * valor da planilha -- assim as somas fecham com o numero que o comercial
 * reconhece.
 */
import { db } from './db.js';

/** Itens cujo SKU nao e mercadoria (frete, desconto lancado como item, etc.). */
const IGNORAR_SKU = /^(FRETE|DESCONTO|ACRESCIMO)/i;

const hoje = () => new Date();
const diasDesde = (iso) => {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  return Math.max(0, Math.round((hoje() - d) / 86_400_000));
};

/**
 * Situacao de cada pedido em aberto, com alocacao de estoque.
 *
 * A alocacao e por ORDEM DE CADASTRO (mais antigo primeiro). Sem isso, dois
 * pedidos que disputam o mesmo SKU apareceriam os dois como faturaveis e a
 * soma prometeria um faturamento que o estoque nao cobre. Hoje sao poucos SKUs
 * em disputa, mas a soma e justamente o que a tela promete.
 */
export function pedidosAbertos() {
  const linhas = db.prepare(`
    SELECT l.id, l.cliente, l.pedido_olist numero, l.data, l.data_raw, l.valor,
           l.situacao, l.observacoes, l.uid_olist,
           p.cliente_nome, p.cidade, p.uf, p.situacao situacao_olist
      FROM planilha_linhas l
      LEFT JOIN pedidos_olist p ON p.uid = l.uid_olist
     WHERE l.tipo_aba = 'aberto'
     ORDER BY l.data`).all();

  const itensPorPedido = new Map();
  for (const l of linhas) {
    // Saldo do ARMAZEM (OMS), nao do Tiny -- ver src/oms.js. O do Tiny vem junto
    // so para a tela mostrar quando o ERP promete peca que nao existe no galpao.
    const itens = l.uid_olist
      ? db.prepare(`
          SELECT i.sku, i.descricao, i.produto, i.qtd, i.valor_unit, i.valor_bruto,
                 o.saldo AS saldo, o.sku AS no_armazem,
                 e.saldo AS saldo_tiny, o.atualizado_em
            FROM itens_olist i
            LEFT JOIN estoque_oms o ON o.sku = i.sku
            LEFT JOIN estoque     e ON e.sku = i.sku
           WHERE i.uid_pedido = ? ORDER BY i.seq`).all(l.uid_olist)
      : [];
    itensPorPedido.set(l.id, itens.filter((i) => !IGNORAR_SKU.test(i.sku ?? '')));
  }

  // Saldo disponivel por SKU, consumido conforme a fila anda.
  // Fora do armazem = ZERO, nao "desconhecido": o OMS lista tudo que existe
  // fisicamente. E o caso dos sete SKUs V1 do Running Fire, que o Tiny mostra
  // com saldo e o galpao nao tem -- tres deles atendiam o pedido 409.
  const disponivel = new Map();
  for (const itens of itensPorPedido.values()) {
    for (const i of itens) {
      if (i.sku && !disponivel.has(i.sku)) {
        disponivel.set(i.sku, i.no_armazem ? Number(i.saldo ?? 0) : 0);
      }
    }
  }

  const pedidos = linhas.map((l) => {
    const itens = itensPorPedido.get(l.id) ?? [];
    const valorItens = itens.reduce((s, i) => s + Number(i.valor_bruto ?? 0), 0);

    let valorDisponivel = 0;
    let faltamItens = 0;
    let semInfo = 0;

    const detalhe = itens.map((i) => {
      const qtd = Number(i.qtd ?? 0);
      const saldo = disponivel.get(i.sku) ?? 0;
      const conhecido = Boolean(i.no_armazem);
      const atende = Math.max(0, Math.min(qtd, saldo));
      disponivel.set(i.sku, saldo - atende);
      // Nao esta no armazem: conta como indisponivel e e sinalizado, porque a
      // causa provavel e cadastro (SKU de geracao antiga), nao falta de compra.
      if (!conhecido) semInfo++;

      const falta = qtd - atende;
      if (falta > 0) faltamItens++;

      const unit = qtd > 0 ? Number(i.valor_bruto ?? 0) / qtd : 0;
      valorDisponivel += unit * atende;

      return {
        sku: i.sku,
        descricao: i.descricao ?? i.produto ?? '',
        qtd,
        saldo: conhecido ? saldo : null,
        saldo_tiny: i.saldo_tiny === null || i.saldo_tiny === undefined ? null : Number(i.saldo_tiny),
        no_armazem: conhecido,
        atende,
        falta,
        valor: Number(i.valor_bruto ?? 0),
        estado: !conhecido ? 'fora_do_armazem' : falta === 0 ? 'ok' : atende > 0 ? 'parcial' : 'falta',
      };
    });

    const valor = Number(l.valor ?? 0);
    // Proporcao dos itens, aplicada ao valor da planilha (que e a base).
    const fracao = valorItens > 0 ? valorDisponivel / valorItens : 0;
    const completo = itens.length > 0 && faltamItens === 0;

    return {
      id: l.id,
      numero: l.numero,
      cliente: l.cliente_nome || l.cliente,
      cidade: l.cidade,
      uf: l.uf,
      data: l.data,
      data_raw: l.data_raw,
      dias: diasDesde(l.data),
      valor,
      valor_faturavel: completo ? valor : valor * fracao,
      situacao: l.situacao,
      situacao_olist: l.situacao_olist,
      observacoes: l.observacoes,
      itens: detalhe,
      n_itens: detalhe.length,
      n_faltando: faltamItens,
      n_sem_info: semInfo,
      estado: itens.length === 0 ? 'sem_itens' : completo ? 'completo' : 'travado',
    };
  });

  return { pedidos, resumo: resumir(pedidos), estoque_de: estoqueDe() };
}

/**
 * As quatro somatorias pedidas.
 *
 * `total` = `faturavel_total` + `travado`. Ja `parcial` corta na transversal:
 * inclui os pedidos completos inteiros MAIS a parte que da para separar dos
 * travados -- por isso e sempre >= `faturavel_total`.
 */
function resumir(pedidos) {
  const soma = (f, filtro = () => true) => pedidos.filter(filtro).reduce((s, p) => s + f(p), 0);
  const completos = (p) => p.estado === 'completo';
  const travados = (p) => p.estado !== 'completo';

  return {
    n: pedidos.length,
    total: soma((p) => p.valor),
    n_completos: pedidos.filter(completos).length,
    faturavel_total: soma((p) => p.valor, completos),
    n_travados: pedidos.filter(travados).length,
    travado: soma((p) => p.valor, travados),
    parcial: soma((p) => p.valor_faturavel),
    // O que sobra se faturar tudo que da: e o buraco de estoque, em dinheiro.
    represado: soma((p) => p.valor) - soma((p) => p.valor_faturavel),
    itens_sem_info: soma((p) => p.n_sem_info),
    dias_max: pedidos.reduce((m, p) => Math.max(m, p.dias ?? 0), 0),
  };
}

function estoqueDe() {
  const r = db.prepare('SELECT MAX(atualizado_em) q, COUNT(*) n FROM estoque_oms').get();
  return { fonte: 'OMS (armazém TPL)', quando: r?.q ?? null, skus: r?.n ?? 0 };
}
