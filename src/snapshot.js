/**
 * Gera `data/snapshot/mapa-fiber.db` -- a copia do banco que VAI para o
 * repositorio, para quem clona ver os dados sem ter as credenciais.
 *
 * Usa `VACUUM INTO` em vez de copiar o arquivo: consolida o WAL (que aqui
 * chega a ter alguns MB pendentes), desfragmenta e produz um arquivo
 * consistente mesmo com o servidor no ar escrevendo no banco de trabalho.
 *
 * Uso:  npm run snapshot
 */
import fs from 'node:fs';
import path from 'node:path';
import { db, DB_PATH, SNAPSHOT_PATH } from './db.js';

const dir = path.dirname(SNAPSHOT_PATH);
fs.mkdirSync(dir, { recursive: true });

// VACUUM INTO exige destino inexistente.
for (const sufixo of ['', '-wal', '-shm']) {
  fs.rmSync(SNAPSHOT_PATH + sufixo, { force: true });
}

const escapado = SNAPSHOT_PATH.replace(/'/g, "''");
db.exec(`VACUUM INTO '${escapado}'`);

const kb = (f) => (fs.existsSync(f) ? (fs.statSync(f).size / 1024).toFixed(0) : '0');
const conta = (t) => {
  try { return db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return '?'; }
};

console.log(`Snapshot gerado: ${path.relative(process.cwd(), SNAPSHOT_PATH)}`);
console.log(`  origem : ${path.relative(process.cwd(), DB_PATH)} (${kb(DB_PATH)} KB + ${kb(DB_PATH + '-wal')} KB de WAL)`);
console.log(`  destino: ${kb(SNAPSHOT_PATH)} KB`);
console.log(`  conteudo: ${conta('pedidos')} pedidos, ${conta('itens')} itens, ` +
  `${conta('amostras')} amostras, ${conta('leads')} campanhas`);
console.log('\nCommite o arquivo para atualizar o que os demais veem:');
console.log('  git add data/snapshot/mapa-fiber.db && git commit -m "Atualiza snapshot dos dados"');
