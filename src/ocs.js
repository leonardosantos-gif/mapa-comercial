/**
 * Ordens de compra da MATRIZ (API v3) = previsao de entrada por SKU.
 *
 * Classificacao por MARCADOR, nao pelo texto das observacoes: muita OC tem
 * observacao vazia, e o recorte por texto subconta feio. O endpoint aceita
 * `marcadores=` na listagem, mas UM por chamada -- a colecao sai por intersecao
 * de ids entre as listas.
 *
 * Metade dos itens da OC e texto livre, sem produto cadastrado: o SKU vem
 * embutido na descricao, no fim (`Tenis Running Fire TFBRF-BLACK-V2-35`) ou no
 * comeco (`TFERC-BLUE-35 Cabedal Echoa`). Em vez de adivinhar por regex --
 * que tropeca nos SKUs Byonic, que tem barra (`JOLBFBR-BLACK/BLACK-G`) --
 * procuramos na descricao os SKUs que o catalogo B2B conhece, do mais longo
 * para o mais curto, para o codigo completo ganhar do prefixo.
 */
import { db, inserirOcItem, limparOcItens, setMeta } from './db.js';
import { getV3, estadoV3 } from './tiny-v3.js';

const SITUACAO = { 0: 'Em aberto', 1: 'Atendido', 2: 'Cancelado', 3: 'Em andamento' };

/** Situacoes que representam mercadoria que AINDA VAI ENTRAR. */
export const SITUACOES_PENDENTES = new Set(['Em aberto', 'Em andamento']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listarPorMarcador(tag) {
  const out = [];
  let total = Infinity;
  for (let off = 0; out.length < total; off += 100) {
    const d = await getV3(`/ordem-compra?limit=100&offset=${off}&marcadores=${encodeURIComponent(tag)}`);
    total = d?.paginacao?.total ?? 0;
    const itens = d?.itens ?? [];
    out.push(...itens);
    if (!itens.length) break;
  }
  return out;
}

/** SKUs do catalogo, do mais longo para o mais curto. */
function skusConhecidos() {
  return db
    .prepare('SELECT sku FROM catalogo_b2b ORDER BY LENGTH(sku) DESC')
    .all()
    .map((r) => r.sku);
}

/** Acha na descricao o SKU mais especifico que o catalogo conhece. */
function acharSku(texto, lista) {
  if (!texto) return null;
  const alvo = texto.toUpperCase();
  for (const sku of lista) {
    if (alvo.includes(sku.toUpperCase())) return sku;
  }
  return null;
}

const mesDe = (iso) => (iso && /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : null);

/**
 * Regrava `oc_itens` com as OCs marcadas como b2b.
 * Sem credencial v3 valida, NAO apaga o que ja existe -- a aba continua
 * mostrando a ultima previsao conhecida em vez de zerar.
 */
export async function sincronizarOcs(onProgresso) {
  const est = estadoV3();
  if (!est.pronto) {
    const n = db.prepare('SELECT COUNT(*) n FROM oc_itens').get().n;
    return { ok: false, motivo: est.motivo, itens_mantidos: n };
  }

  const [b2b, ouro, prata] = await Promise.all([
    listarPorMarcador('b2b'),
    listarPorMarcador('Coleção Ouro'),
    listarPorMarcador('Coleção Prata'),
  ]);
  const idsOuro = new Set(ouro.map((o) => o.id));
  const idsPrata = new Set(prata.map((o) => o.id));
  const colecaoDe = (o) => {
    const eOuro = idsOuro.has(o.id);
    const ePrata = idsPrata.has(o.id);
    if (eOuro && ePrata) return 'Ambas';
    if (eOuro) return 'Ouro';
    if (ePrata) return 'Prata';
    return '(sem coleção)';
  };

  // So detalha o que ainda vai entrar: OC atendida ou cancelada nao e previsao,
  // e cada detalhe e uma chamada que arrisca 429.
  const pendentes = b2b.filter((o) => SITUACOES_PENDENTES.has(SITUACAO[o.situacao] ?? String(o.situacao)));

  const lista = skusConhecidos();
  const linhas = [];
  let semSku = 0;

  for (let i = 0; i < pendentes.length; i++) {
    const o = pendentes[i];
    let itens = [];
    try {
      const d = await getV3(`/ordem-compra/${o.id}`);
      itens = d?.itens ?? [];
    } catch {
      // uma OC ilegivel nao pode derrubar a etapa inteira
    }
    const dataPrevista = o.dataPrevista || null;
    for (const it of itens) {
      const descricao = it.produto?.descricao || '';
      const sku = (it.produto?.sku || '').trim() || acharSku(descricao, lista);
      if (!sku) semSku++;
      linhas.push([
        String(o.id),
        String(o.numero ?? ''),
        dataPrevista,
        mesDe(dataPrevista),
        SITUACAO[o.situacao] ?? String(o.situacao),
        o.categoria?.nome ?? '',
        colecaoDe(o),
        sku,
        descricao,
        Number(it.quantidade || 0),
        1,
      ]);
    }
    onProgresso?.(i + 1, pendentes.length);
    await sleep(400);
  }

  limparOcItens();
  for (const l of linhas) inserirOcItem.run(...l);

  const resultado = {
    ok: true,
    ocs_b2b: b2b.length,
    ocs_pendentes: pendentes.length,
    itens: linhas.length,
    sem_sku: semSku,
    unidades: linhas.reduce((s, l) => s + l[9], 0),
    quando: new Date().toISOString(),
  };
  setMeta('ultima_sync_ocs', JSON.stringify(resultado));
  return resultado;
}
