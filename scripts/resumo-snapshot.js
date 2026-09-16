/**
 * Uma linha descrevendo o que o snapshot versionado contem. Vai para a
 * mensagem do commit que a tarefa agendada cria.
 *
 * Existe como ARQUIVO, e nao como `node -e "..."` dentro do PowerShell, porque
 * passar JavaScript pela linha de comando do PS 5.1 e um campo minado: `${...}`
 * e sintaxe de variavel, a crase e escape, e as aspas duplas somem na chamada de
 * executavel nativo. As tres coisas mutilaram o script antes de virar arquivo.
 *
 *   node scripts/resumo-snapshot.js [caminho-do-db]
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const alvo = process.argv[2] ?? path.join(__dirname, '..', 'data', 'snapshot', 'mapa-fiber.db');

const db = new DatabaseSync(alvo, { readOnly: true });
const n = (tabela) => {
  try {
    return db.prepare(`SELECT COUNT(*) n FROM ${tabela}`).get().n;
  } catch {
    return '?'; // tabela ainda nao existe neste banco
  }
};

process.stdout.write(
  `${n('pedidos')} lancamentos, ${n('itens')} itens, `
  + `${n('estoque')} SKUs com estoque, ${n('oc_itens')} itens de OC`,
);
db.close();
