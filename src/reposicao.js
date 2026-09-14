/**
 * Aba Reposicao: venda, estoque e projecao por SKU do catalogo B2B.
 *
 * Junta tres fontes que vivem em lugares diferentes:
 *   - venda por SKU  -> tabela de fatos do proprio dashboard (`itens`)
 *   - saldo          -> conta B2B do Tiny, v2 (`estoque`)
 *   - entrada        -> ordens de compra da MATRIZ, v3 (`oc_itens`)
 *
 * A projecao repete a logica da planilha "Controle LEO | compras X Estoque":
 * media mensal a partir da venda de 90 dias e um saldo em cascata, mes a mes,
 * subtraindo a venda prevista e somando a entrada prevista. A diferenca e que
 * aqui o fator de sazonalidade sai do HISTORICO do proprio banco, em vez do
 * "novembro = 2x a media" fixo da planilha.
 */
import { db, getMeta } from './db.js';
import { estadoV3 } from './tiny-v3.js';

/** Quantos meses a projecao olha para a frente. */
const HORIZONTE = 4;

const chaveMes = "COALESCE(p.mes_ref, substr(p.data, 1, 7))";

const mesSeguinte = (mes, n = 1) => {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

const hojeISO = () => new Date().toISOString().slice(0, 10);
const mesAtual = () => hojeISO().slice(0, 7);

/**
 * Indice de sazonalidade por mes do calendario, tirado do historico de unidades.
 *
 * A base tem pouco mais de um ano, entao cada mes aparece uma ou duas vezes --
 * o indice e uma tendencia grosseira, nao uma serie temporal. Por isso e
 * limitado a [0,5 , 2,0]: sem o teto, um mes atipico (uma unica venda grande de
 * Decathlon) projetaria uma demanda que nunca vai existir.
 */
export function sazonalidade() {
  const linhas = db.prepare(`
    SELECT ${chaveMes} mes, SUM(i.qtd) un
      FROM pedidos p JOIN itens i ON i.uid_pedido = p.uid
     WHERE p.valido = 1 AND ${chaveMes} IS NOT NULL
     GROUP BY mes HAVING un > 0 ORDER BY mes`).all();

  if (linhas.length < 3) return { indices: {}, meses_base: linhas.length };

  // Meses PARCIAIS nao podem entrar: puxam o indice do mes para baixo como se
  // fosse baixa demanda. Sao dois -- o corrente, ainda em curso, e o primeiro da
  // base, que comeca no dia em que a planilha comeca (18/11/2025), o que fazia
  // novembro, o mes de PICO do negocio, aparecer como o mais fraco do ano.
  const primeira = db.prepare('SELECT MIN(data) d FROM pedidos WHERE valido = 1 AND data IS NOT NULL').get()?.d;
  const primeiroMesParcial = primeira && Number(primeira.slice(8, 10)) > 5 ? primeira.slice(0, 7) : null;

  const fechados = linhas.filter((l) => l.mes < mesAtual() && l.mes !== primeiroMesParcial);
  const base = fechados.length >= 3 ? fechados : linhas;
  const media = base.reduce((s, l) => s + l.un, 0) / base.length;

  const porMesCalendario = {};
  for (const l of base) {
    const mm = l.mes.slice(5, 7);
    (porMesCalendario[mm] ??= []).push(l.un);
  }

  const indices = {};
  for (const [mm, valores] of Object.entries(porMesCalendario)) {
    const m = valores.reduce((s, v) => s + v, 0) / valores.length;
    indices[mm] = media ? Math.min(2, Math.max(0.5, m / media)) : 1;
  }
  return { indices, meses_base: base.length, media_un_mes: media };
}

/** Venda em unidades por SKU: total dos ultimos 90 dias e do mes corrente. */
function vendaPorSku() {
  const corte = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const mes = mesAtual();

  const linhas = db.prepare(`
    SELECT i.sku sku,
           SUM(CASE WHEN p.data >= ? THEN i.qtd ELSE 0 END)        un_90d,
           SUM(CASE WHEN ${chaveMes} = ? THEN i.qtd ELSE 0 END)     un_mes,
           SUM(i.qtd)                                               un_total,
           MAX(p.data)                                              ultima_venda
      FROM pedidos p JOIN itens i ON i.uid_pedido = p.uid
     WHERE p.valido = 1 AND i.sku IS NOT NULL AND i.sku <> ''
     GROUP BY i.sku`).all(corte, mes);

  const mapa = new Map();
  for (const l of linhas) mapa.set(l.sku.toUpperCase(), l);
  return mapa;
}

/**
 * So MERCADORIA entra como previsao de entrada.
 *
 * Metade das OCs da Matriz e "Tercerizacao Mao de Obra" -- cabedal e componente,
 * que nao viram saldo vendavel. Nao basta filtrar pela categoria: ela e da OC
 * INTEIRA, e OCs classificadas como "Compra de produto pronto" carregam linhas
 * de mao de obra dentro (`MO-CAB-TFBU-WHITE-36`, "Mao de Obra - Cabedal ..."),
 * que entrariam como se fossem tenis pronto. Por isso o corte tambem olha o SKU
 * e a descricao do item.
 */
const SO_MERCADORIA = `
  (categoria IS NULL OR (categoria NOT LIKE '%Mão de Obra%' AND categoria NOT LIKE '%Mao de Obra%'))
  AND (sku IS NULL OR sku NOT LIKE 'MO-%')
  AND (descricao IS NULL OR (descricao NOT LIKE 'Mão de Obra%' AND descricao NOT LIKE 'Mao de Obra%'))
`;

/**
 * Entrada prevista por SKU: `{ transito, meses: {aaaa-mm: un} }`.
 *
 * `transito` e o que estava previsto para hoje ou antes e ainda nao chegou --
 * OC atrasada ou deste mes. Sem isso a maior fatia da previsao sumia da tela:
 * a projecao comeca no mes que vem, entao tudo que era para entrar em setembro
 * ficava fora de qualquer coluna.
 */
function entradaPorSku() {
  const mes0 = mesAtual();
  const linhas = db.prepare(`
    SELECT sku, mes_previsto mes, SUM(qtd) un
      FROM oc_itens
     WHERE sku IS NOT NULL AND sku <> '' AND mes_previsto IS NOT NULL
       AND ${SO_MERCADORIA}
     GROUP BY sku, mes_previsto`).all();

  const mapa = new Map();
  for (const l of linhas) {
    const k = l.sku.toUpperCase();
    if (!mapa.has(k)) mapa.set(k, { transito: 0, meses: {} });
    const alvo = mapa.get(k);
    if (l.mes <= mes0) alvo.transito += l.un;
    else alvo.meses[l.mes] = (alvo.meses[l.mes] ?? 0) + l.un;
  }
  return mapa;
}

/**
 * Linha por SKU com venda, estoque e a cascata de saldo projetado.
 * @param {{categoria?:string,busca?:string,situacao?:string}} q
 */
export function reposicao(q = {}) {
  const { indices, meses_base } = sazonalidade();
  // A base tem uma unica passagem por cada mes do calendario, entao o indice e
  // volatil (marco 2,00 x abril 0,53). Poder desligar e o que torna a projecao
  // conferivel: com sazonalidade ela respeita o historico, sem ela e a media
  // pura -- se as duas contam historias muito diferentes, o indice e que e fraco.
  const usarSazonalidade = q.sazonal !== '0' && q.sazonal !== false;
  const vendas = vendaPorSku();
  const entradas = entradaPorSku();

  const catalogo = db.prepare(`
    SELECT c.sku, c.produto, c.categoria, c.cor, c.tamanho, c.preco, c.fake,
           e.saldo, e.saldo_reservado, e.atualizado_em
      FROM catalogo_b2b c LEFT JOIN estoque e ON e.sku = c.sku
     ORDER BY c.categoria, c.produto, c.cor, c.tamanho`).all();

  const mes0 = mesAtual();
  const meses = Array.from({ length: HORIZONTE }, (_, i) => mesSeguinte(mes0, i + 1));

  const linhas = catalogo.map((c) => {
    const v = vendas.get(c.sku.toUpperCase()) ?? { un_90d: 0, un_mes: 0, un_total: 0, ultima_venda: null };
    const ent = entradas.get(c.sku.toUpperCase()) ?? { transito: 0, meses: {} };

    const media = v.un_90d / 3;
    const estoque = c.fake ? null : Number(c.saldo ?? 0);

    // A cascata parte do saldo de hoje MAIS o que ja deveria ter entrado e nao
    // entrou: essa mercadoria esta comprada, so nao chegou.
    let saldo = (estoque ?? 0) + ent.transito;
    const projecao = meses.map((m) => {
      const fator = usarSazonalidade ? (indices[m.slice(5, 7)] ?? 1) : 1;
      const previsaoVenda = media * fator;
      const entrada = ent.meses[m] ?? 0;
      saldo = saldo - previsaoVenda + entrada;
      return {
        mes: m,
        previsao_venda: Math.round(previsaoVenda),
        entrada: Math.round(entrada),
        saldo: Math.round(saldo),
      };
    });

    const entradaTotal = ent.transito + Object.values(ent.meses).reduce((s, n) => s + n, 0);
    // Meses de cobertura: quanto o estoque de hoje aguenta no ritmo atual.
    const cobertura = media > 0 && estoque !== null ? estoque / media : null;

    return {
      sku: c.sku,
      produto: c.produto,
      categoria: c.categoria,
      cor: c.cor,
      tamanho: c.tamanho,
      preco: c.preco,
      sem_cadastro: Boolean(c.fake),
      estoque,
      reservado: Number(c.saldo_reservado ?? 0),
      un_mes: v.un_mes,
      un_90d: v.un_90d,
      media_mes: Number(media.toFixed(1)),
      cobertura_meses: cobertura === null ? null : Number(cobertura.toFixed(1)),
      ultima_venda: v.ultima_venda,
      entrada_total: Math.round(entradaTotal),
      em_transito: Math.round(ent.transito),
      projecao,
      // Classificacao que da a cor da linha na tela.
      situacao: classificar({ estoque, media, cobertura, fake: c.fake, projecao }),
    };
  });

  return {
    meses,
    mes_atual: mes0,
    linhas: filtrar(linhas, q),
    resumo: resumir(linhas),
    // `fatores` = o multiplicador realmente aplicado a cada mes projetado, para
    // a tela poder mostrar de onde saiu o numero. Mes sem historico fechado fica
    // em 1 e aparece marcado como "sem base".
    sazonalidade: {
      ativa: usarSazonalidade,
      indices,
      meses_base,
      fatores: meses.map((m) => ({
        mes: m,
        fator: usarSazonalidade ? (indices[m.slice(5, 7)] ?? 1) : 1,
        sem_base: !(m.slice(5, 7) in indices),
      })),
    },
    fontes: fontes(),
  };
}

/**
 * Situacao da linha. A ordem importa: a primeira que casar vence.
 *  ruptura  - estoque ja zerado
 *  critico  - zera dentro de um mes
 *  atencao  - zera dentro do horizonte projetado
 *  ok       - atravessa o horizonte com saldo
 *  parado   - sem venda nos ultimos 90 dias
 *
 * As faixas sao por COBERTURA, nao por "a projecao fica negativa": como o
 * horizonte e de 4 meses, qualquer SKU com menos de 4 meses de cobertura fica
 * negativo em algum ponto -- usar isso como criterio de "critico" jogava quase
 * tudo no mesmo balde e deixava "atencao" inalcancavel.
 */
function classificar({ estoque, media, cobertura, fake, projecao }) {
  if (fake) return 'sem_cadastro';
  if (media <= 0) return estoque > 0 ? 'parado' : 'sem_movimento';
  if (estoque <= 0) return 'ruptura';
  if (cobertura < 1) return 'critico';
  if (projecao.some((p) => p.saldo < 0)) return 'atencao';
  return 'ok';
}

function filtrar(linhas, q) {
  let out = linhas;
  if (q.categoria && q.categoria !== 'todas') out = out.filter((l) => l.categoria === q.categoria);
  if (q.situacao && q.situacao !== 'todas') out = out.filter((l) => l.situacao === q.situacao);
  if (q.busca) {
    const t = String(q.busca).toUpperCase();
    out = out.filter((l) => `${l.sku} ${l.produto} ${l.cor} ${l.tamanho}`.toUpperCase().includes(t));
  }
  return out;
}

function resumir(linhas) {
  const ativos = linhas.filter((l) => !l.sem_cadastro);
  const conta = (s) => ativos.filter((l) => l.situacao === s).length;
  return {
    skus: ativos.length,
    sem_cadastro: linhas.length - ativos.length,
    estoque_un: ativos.reduce((s, l) => s + (l.estoque ?? 0), 0),
    estoque_valor: ativos.reduce((s, l) => s + (l.estoque ?? 0) * (l.preco ?? 0), 0),
    venda_mes_un: ativos.reduce((s, l) => s + l.un_mes, 0),
    venda_90d_un: ativos.reduce((s, l) => s + l.un_90d, 0),
    entrada_prevista_un: ativos.reduce((s, l) => s + l.entrada_total, 0),
    em_transito_un: ativos.reduce((s, l) => s + l.em_transito, 0),
    // Estoque sem giro: dinheiro parado, o outro lado da reposicao.
    parado_valor: ativos
      .filter((l) => l.situacao === 'parado' || l.situacao === 'sem_movimento')
      .reduce((s, l) => s + (l.estoque ?? 0) * (l.preco ?? 0), 0),
    ruptura: conta('ruptura'),
    critico: conta('critico'),
    atencao: conta('atencao'),
    ok: conta('ok'),
    parado: conta('parado') + conta('sem_movimento'),
  };
}

/** De quando e cada fonte -- a aba mostra isso no rodape. */
function fontes() {
  const est = db.prepare('SELECT MAX(atualizado_em) q, COUNT(*) n FROM estoque').get();
  let ocs = null;
  try { ocs = JSON.parse(getMeta('ultima_sync_ocs') ?? 'null'); } catch { /* meta ausente */ }
  const oc = db.prepare('SELECT COUNT(*) n, MAX(mes_previsto) ate FROM oc_itens').get();

  // "0 itens" e ambiguo: pode ser "nao ha OC em aberto" ou "nao consegui
  // perguntar". Quando a tabela esta vazia e nenhuma sincronizacao de OC foi
  // registrada, o motivo vem do estado da credencial v3 -- senao a tela afirma
  // que nao existe reposicao a caminho quando na verdade nem olhou.
  let erro = ocs?.ok === false ? ocs.motivo : null;
  if (!erro && !ocs && (oc?.n ?? 0) === 0) {
    const est3 = estadoV3();
    erro = est3.pronto ? 'ainda não sincronizado nesta base' : est3.motivo;
  }

  return {
    estoque: { quando: est?.q ?? null, skus: est?.n ?? 0 },
    ocs: { quando: ocs?.quando ?? null, itens: oc?.n ?? 0, ate: oc?.ate ?? null, erro },
    vendas: { quando: getMeta('ultima_sync') },
  };
}

/** Categorias do catalogo, para o filtro da tela. */
export function categoriasReposicao() {
  return db.prepare('SELECT DISTINCT categoria FROM catalogo_b2b WHERE categoria <> \'\' ORDER BY categoria')
    .all().map((r) => r.categoria);
}
