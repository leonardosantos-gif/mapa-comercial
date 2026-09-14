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
 * Atualiza o saldo de cada SKU do catalogo que tem cadastro no Tiny.
 * Um erro num SKU nao derruba a etapa: o saldo anterior fica no banco.
 */
export async function sincronizarEstoque(onProgresso) {
  const alvos = db
    .prepare("SELECT sku, tiny_id FROM catalogo_b2b WHERE fake = 0 AND tiny_id IS NOT NULL AND tiny_id <> '' ORDER BY sku")
    .all();

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

  return { skus: alvos.length, ok, falhas, quando: agora };
}
