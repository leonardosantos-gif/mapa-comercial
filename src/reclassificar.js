/**
 * Recalcula produto-pai, categoria e linha de todos os itens ja gravados,
 * a partir do SKU e da descricao que vieram da API.
 *
 * Serve para evoluir as regras de classificacao sem refazer a coleta
 * (nenhuma chamada a API do Tiny e feita aqui).
 *
 *   node src/reclassificar.js
 */
import { db } from './db.js';
import { classificarProduto, produtoPai, canonizarProdutos } from './regras.js';

const itens = db.prepare('SELECT uid_pedido, seq, sku, descricao, produto, categoria FROM itens').all();
const atualizar = db.prepare(
  'UPDATE itens SET produto = ?, categoria = ?, linha = ? WHERE uid_pedido = ? AND seq = ?',
);

let alterados = 0;
db.exec('BEGIN');
try {
  for (const it of itens) {
    const produto = produtoPai(it.descricao);
    const { categoria, linha } = classificarProduto(it.sku, it.descricao);
    if (produto !== it.produto || categoria !== it.categoria) alterados++;
    atualizar.run(produto, categoria, linha, it.uid_pedido, it.seq);
  }
  const unificados = canonizarProdutos(db);
  if (unificados) console.log(`${unificados} nomes unificados por acento/caixa.`);
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('ERRO, nada foi alterado:', e.message);
  process.exit(1);
}

console.log(`${itens.length} itens reprocessados (${alterados} com classificacao alterada).\n`);
console.log('Distribuicao por categoria:');
for (const r of db.prepare(
  'SELECT categoria, ROUND(SUM(valor), 2) v, COUNT(DISTINCT produto) n FROM itens GROUP BY categoria ORDER BY v DESC',
).all()) {
  console.log(`  ${String(r.v).padStart(12)}  ${String(r.n).padStart(4)} produtos  ${r.categoria}`);
}
console.log('\nTop 10 produtos:');
for (const r of db.prepare(
  `SELECT i.produto, ROUND(SUM(i.valor), 2) v, SUM(i.qtd) q, MAX(i.categoria) cat
     FROM itens i JOIN pedidos p ON p.uid = i.uid_pedido
    WHERE p.valido = 1 GROUP BY i.produto ORDER BY v DESC LIMIT 10`,
).all()) {
  console.log(`  ${String(r.v).padStart(11)}  ${String(r.q).padStart(6)} un.  ${r.cat.padEnd(16)} ${r.produto}`);
}
