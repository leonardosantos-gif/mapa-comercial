/**
 * Catalogo do Portal B2B + saldo de estoque da conta B2B.
 *
 * O saldo vem de `produto.obter.estoque.php`, uma chamada por SKU -- a v2 nao
 * tem endpoint que devolva saldo em lote (`produtos.pesquisa.php` traz preco e
 * situacao, mas nao saldo). Com ~260 SKUs cadastrados e o throttle de 650 ms do
 * cliente, a etapa leva cerca de 3 minutos.
 *
 * O `tinyId` ja vem no catalogo do Portal, entao nao e preciso procurar o
 * produto por codigo antes -- isso economiza uma chamada por SKU.
 */
import { varejo } from './tiny.js';
import { db, upsertCatalogoB2B, upsertEstoque } from './db.js';
import { lerCatalogoB2B, caminhoCatalogo } from './catalogo-b2b.js';

/**
 * Regrava `catalogo_b2b` a partir do arquivo do Portal.
 * Quando o Portal nao esta na maquina, mantem o que ja estava no banco
 * (veio do snapshot) em vez de zerar a aba.
 */
export function sincronizarCatalogo() {
  const lista = lerCatalogoB2B();
  if (!lista.length) {
    const n = db.prepare('SELECT COUNT(*) n FROM catalogo_b2b').get().n;
    return { skus: n, origem: n ? 'banco (Portal indisponivel)' : 'nenhuma' };
  }
  // SKU que saiu do catalogo do Portal nao deve continuar na aba.
  const atuais = new Set(lista.map((x) => x.sku));
  for (const { sku } of db.prepare('SELECT sku FROM catalogo_b2b').all()) {
    if (!atuais.has(sku)) db.prepare('DELETE FROM catalogo_b2b WHERE sku = ?').run(sku);
  }
  for (const c of lista) {
    upsertCatalogoB2B.run(c.sku, c.tiny_id, c.produto, c.categoria, c.cor, c.tamanho, c.preco, c.fake);
  }
  return { skus: lista.length, origem: caminhoCatalogo() };
}

/**
 * Todo SKU que precisa de saldo: os do catalogo do Portal mais os que aparecem
 * em PEDIDO EM ABERTO (grades antigas que nao estao mais no catalogo).
 *
 * O `tiny_id` vem de graca quando o catalogo do Portal o registrou. Quando nao
 * registrou, ele e resolvido por busca de codigo -- e o resultado fica gravado
 * em `estoque.tiny_id`, entao a busca acontece uma vez so por SKU.
 *
 * ATENCAO ao motivo disto existir: a flag `fake` do catalogo significa "o
 * Portal nao trouxe o tinyId", e eu tratava isso como "nao existe no ERP". Sao
 * coisas diferentes. `SFBRBIN-0930-20/21` e `TFBF-BLACK-36` estao ativos no
 * Tiny e apareciam sem estoque nenhum, porque caiam no vao entre os dois
 * filtros: fora do recorte do catalogo (que exigia fake = 0) e fora do recorte
 * dos extras (que exigia nao estar no catalogo).
 */
async function resolverAlvos(onBusca) {
  const doCatalogo = db.prepare(`
    SELECT sku, tiny_id FROM catalogo_b2b
     WHERE tiny_id IS NOT NULL AND tiny_id <> '' ORDER BY sku`).all();

  const jaTem = new Set(doCatalogo.map((x) => x.sku));

  // Sem tiny_id conhecido: do catalogo e dos pedidos em aberto.
  const pendentes = db.prepare(`
    SELECT DISTINCT sku FROM (
      SELECT sku FROM catalogo_b2b WHERE tiny_id IS NULL OR tiny_id = ''
      UNION
      SELECT i.sku FROM planilha_linhas l JOIN itens_olist i ON i.uid_pedido = l.uid_olist
       WHERE l.tipo_aba = 'aberto' AND i.sku IS NOT NULL AND i.sku <> ''
    ) ORDER BY sku`).all().map((r) => r.sku).filter((s) => !jaTem.has(s));

  const extras = [];
  for (let i = 0; i < pendentes.length; i++) {
    const sku = pendentes[i];
    const cache = db.prepare('SELECT tiny_id FROM estoque WHERE sku = ? AND tiny_id IS NOT NULL').get(sku);
    if (cache?.tiny_id) {
      extras.push({ sku, tiny_id: cache.tiny_id });
      continue;
    }
    onBusca?.(i + 1, pendentes.length, sku);
    try {
      const r = await varejo('produtos.pesquisa.php', { pesquisa: sku, pagina: 1 });
      const achado = (r.produtos ?? []).map((x) => x.produto)
        .find((p) => String(p.codigo ?? '').toUpperCase() === sku.toUpperCase());
      if (achado?.id) extras.push({ sku, tiny_id: String(achado.id) });
    } catch { /* sem cadastro mesmo: fica sem saldo e a tela mostra isso */ }
  }

  return { doCatalogo, extras, todos: [...doCatalogo, ...extras] };
}

/**
 * Atualiza o saldo de todos os SKUs que o dashboard precisa conhecer.
 * Um erro num SKU nao derruba a etapa: o saldo anterior fica no banco.
 */
export async function sincronizarEstoque(onProgresso) {
  const { doCatalogo, extras, todos: alvos } = await resolverAlvos();

  const agora = new Date().toISOString();
  let ok = 0;
  let falhas = 0;

  for (let i = 0; i < alvos.length; i++) {
    const { sku, tiny_id } = alvos[i];
    try {
      const r = await varejo('produto.obter.estoque.php', { id: tiny_id });
      const p = r.produto ?? {};
      upsertEstoque.run(sku, tiny_id, Number(p.saldo ?? 0), Number(p.saldoReservado ?? 0), agora);
      ok++;
    } catch {
      falhas++;
    }
    onProgresso?.(i + 1, alvos.length, sku);
  }

  return { skus: alvos.length, catalogo: doCatalogo.length, extras: extras.length, ok, falhas, quando: agora };
}
