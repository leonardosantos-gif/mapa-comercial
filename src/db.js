/**
 * Banco local (SQLite nativo do Node).
 *
 * Duas camadas, refletindo a hierarquia das fontes:
 *
 *  - `pedidos_olist` / `itens_olist` : snapshot do ERP (Olist/Tiny). Serve para
 *    ENRIQUECER (cidade/UF, CNPJ, SKU, quantidade, situacao) e para CONFERIR.
 *  - `pedidos` / `itens` : tabela de fatos do dashboard, construida a partir da
 *    PLANILHA COMERCIAL (a base). O valor e o mes vem da planilha; o resto e
 *    completado pelo Olist quando o pedido e encontrado.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
export const DB_PATH = path.join(DATA_DIR, 'mapa-fiber.db');

/**
 * Snapshot versionado. O banco de trabalho (`DB_PATH`) e gerado pelo sync e
 * fica fora do git -- muda a cada hora. Sem o snapshot, quem clona o
 * repositorio sobe o dashboard vazio, porque nao tem como rodar o sync sem as
 * credenciais. Na primeira execucao copiamos o snapshot para o banco de
 * trabalho: o arquivo versionado nunca e escrito, entao o `git status` de quem
 * sincroniza continua limpo.
 */
export const SNAPSHOT_PATH = path.join(DATA_DIR, 'snapshot', 'mapa-fiber.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

export let veioDoSnapshot = false;
if (!fs.existsSync(DB_PATH) && fs.existsSync(SNAPSHOT_PATH)) {
  fs.copyFileSync(SNAPSHOT_PATH, DB_PATH);
  veioDoSnapshot = true;
  console.log('Banco inicializado a partir do snapshot do repositorio.');
}

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
-- ------------------------------------------------ snapshot do ERP (conferencia)
CREATE TABLE IF NOT EXISTS pedidos_olist (
  uid              TEXT PRIMARY KEY,   -- conta:id_pedido
  conta            TEXT NOT NULL,      -- b2b | matriz
  grupo            TEXT,
  id_tiny          TEXT,
  numero           TEXT,
  data             TEXT,
  mes_ref          TEXT,
  situacao         TEXT,
  faturado         INTEGER DEFAULT 0,
  cliente_nome     TEXT,
  cnpj             TEXT,
  cidade_raw       TEXT,
  uf_raw           TEXT,
  municipio_id     TEXT,
  cidade           TEXT,
  uf               TEXT,
  lat              REAL,
  lon              REAL,
  vendedor_tiny    TEXT,
  id_natureza      TEXT,
  natureza         TEXT,
  tipo_operacao    TEXT,
  id_nf            TEXT,
  lista_preco      TEXT,
  total            REAL DEFAULT 0,
  total_produtos   REAL DEFAULT 0,
  desconto         REAL DEFAULT 0,
  qtd_pecas        REAL DEFAULT 0,
  operacao_valida  INTEGER DEFAULT 1,  -- 0 = transferencia/remessa/interno/cancelado
  motivo_exclusao  TEXT,
  assinatura       TEXT,               -- situacao|valor: evita rechamar o detalhe
  atualizado_em    TEXT
);
CREATE INDEX IF NOT EXISTS ix_po_numero ON pedidos_olist(numero);

CREATE TABLE IF NOT EXISTS itens_olist (
  uid_pedido   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  sku          TEXT,
  descricao    TEXT,
  produto      TEXT,
  categoria    TEXT,
  linha        TEXT,
  qtd          REAL DEFAULT 0,
  valor_unit   REAL DEFAULT 0,
  valor_bruto  REAL DEFAULT 0,
  PRIMARY KEY (uid_pedido, seq),
  FOREIGN KEY (uid_pedido) REFERENCES pedidos_olist(uid) ON DELETE CASCADE
);

-- ------------------------------- linhas cruas da planilha (rastreabilidade)
CREATE TABLE IF NOT EXISTS planilha_linhas (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  aba           TEXT,
  gid           TEXT,
  tipo_aba      TEXT,      -- mensal | faturados | aberto | cancelado | reps
  mes_aba       TEXT,      -- aaaa-mm quando a aba e mensal
  cliente       TEXT,
  pedido_olist  TEXT,
  pedidos_ref   TEXT,
  parcial       INTEGER DEFAULT 0,
  data_raw      TEXT,
  data          TEXT,      -- ISO aaaa-mm-dd
  data_faturamento TEXT,
  vendedor      TEXT,
  valor         REAL,
  nf            TEXT,
  situacao      TEXT,
  observacoes   TEXT,
  base          INTEGER DEFAULT 0,  -- 1 = entra no universo do dashboard
  motivo_nao_base TEXT,
  uid_olist     TEXT,               -- pedido do ERP correspondente
  conciliado    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_pl_pedido ON planilha_linhas(pedido_olist);
CREATE INDEX IF NOT EXISTS ix_pl_base ON planilha_linhas(base);

-- ------------------------------------------ tabela de fatos (planilha e a base)
CREATE TABLE IF NOT EXISTS pedidos (
  uid              TEXT PRIMARY KEY,   -- pl:<id da linha da planilha>
  linha_planilha   INTEGER,
  aba              TEXT,
  tipo_aba         TEXT,
  numero           TEXT,
  pedidos_ref      TEXT,
  parcial          INTEGER DEFAULT 0,
  data             TEXT,
  data_faturamento TEXT,               -- coluna FATURAMENTO da planilha (cadastro -> faturamento)
  mes_ref          TEXT,               -- da aba mensal (fechamento comercial)
  ano              INTEGER,
  situacao         TEXT,
  faturado         INTEGER DEFAULT 0,
  cliente_nome     TEXT,
  cliente_chave    TEXT,
  cnpj             TEXT,
  cidade_raw       TEXT,
  uf_raw           TEXT,
  municipio_id     TEXT,
  cidade           TEXT,
  uf               TEXT,
  lat              REAL,
  lon              REAL,
  vendedor_sheet   TEXT,
  vendedor_tiny    TEXT,
  representante    TEXT,
  natureza         TEXT,
  tipo_operacao    TEXT,
  id_nf            TEXT,
  nf_planilha      TEXT,
  lista_preco      TEXT,
  total            REAL DEFAULT 0,     -- VALOR da planilha (autoritativo)
  total_olist      REAL,               -- total do ERP, para conferencia
  qtd_pecas        REAL DEFAULT 0,
  valido           INTEGER DEFAULT 1,
  motivo_exclusao  TEXT,
  conta            TEXT,
  uid_olist        TEXT,
  fontes           TEXT,               -- planilha | planilha+olist
  atualizado_em    TEXT
);
CREATE INDEX IF NOT EXISTS ix_ped_uf     ON pedidos(uf);
CREATE INDEX IF NOT EXISTS ix_ped_mes    ON pedidos(mes_ref);
CREATE INDEX IF NOT EXISTS ix_ped_rep    ON pedidos(representante);
CREATE INDEX IF NOT EXISTS ix_ped_cli    ON pedidos(cliente_chave);
CREATE INDEX IF NOT EXISTS ix_ped_valido ON pedidos(valido);
CREATE INDEX IF NOT EXISTS ix_ped_mun    ON pedidos(municipio_id);

CREATE TABLE IF NOT EXISTS itens (
  uid_pedido   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  sku          TEXT,
  descricao    TEXT,
  produto      TEXT,
  categoria    TEXT,
  linha        TEXT,
  qtd          REAL DEFAULT 0,
  valor_unit   REAL DEFAULT 0,
  valor_bruto  REAL DEFAULT 0,
  valor        REAL DEFAULT 0,   -- ajustado para fechar com o VALOR da planilha
  PRIMARY KEY (uid_pedido, seq),
  FOREIGN KEY (uid_pedido) REFERENCES pedidos(uid) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_item_sku ON itens(sku);
CREATE INDEX IF NOT EXISTS ix_item_prod ON itens(produto);

-- Amostras/brindes (aba AMOSTRAS). Tabela propria: NAO sao venda e nao entram
-- em nenhum numero de faturamento.
CREATE TABLE IF NOT EXISTS amostras (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente      TEXT,
  cliente_chave TEXT,
  pedido       TEXT,
  data         TEXT,
  mes_ref      TEXT,
  valor        REAL DEFAULT 0,
  nf           TEXT,
  envio        TEXT,
  observacoes  TEXT
);
CREATE INDEX IF NOT EXISTS ix_am_mes ON amostras(mes_ref);

-- Campanhas de prospeccao (aba LEADS).
CREATE TABLE IF NOT EXISTS leads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  data         TEXT,
  data_raw     TEXT,
  mes_ref      TEXT,
  canal        TEXT,
  campanha     TEXT,
  segmento     TEXT,
  uf           TEXT,
  enviados     INTEGER DEFAULT 0,
  falhas       INTEGER DEFAULT 0,
  entregues    INTEGER DEFAULT 0,
  retornos     INTEGER DEFAULT 0,
  vendas       REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_leads_mes ON leads(mes_ref);

CREATE TABLE IF NOT EXISTS alertas (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo     TEXT,
  gravidade TEXT,
  chave    TEXT,
  detalhe  TEXT,
  valor    REAL,
  criado_em TEXT
);
CREATE INDEX IF NOT EXISTS ix_al_tipo ON alertas(tipo);

CREATE TABLE IF NOT EXISTS meta (
  chave TEXT PRIMARY KEY,
  valor TEXT
);

CREATE TABLE IF NOT EXISTS sync_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  inicio     TEXT,
  fim        TEXT,
  status     TEXT,
  pedidos    INTEGER,
  itens      INTEGER,
  chamadas   INTEGER,
  erros      INTEGER,
  detalhe    TEXT
);
`);

export function setMeta(chave, valor) {
  db.prepare('INSERT INTO meta (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor')
    .run(chave, typeof valor === 'string' ? valor : JSON.stringify(valor));
}

export function getMeta(chave, padrao = null) {
  const r = db.prepare('SELECT valor FROM meta WHERE chave = ?').get(chave);
  return r ? r.valor : padrao;
}

// ---------------------------------------------------------- snapshot do Olist
export const upsertPedidoOlist = db.prepare(`
INSERT INTO pedidos_olist (
  uid, conta, grupo, id_tiny, numero, data, mes_ref, situacao, faturado,
  cliente_nome, cnpj, cidade_raw, uf_raw, municipio_id, cidade, uf, lat, lon,
  vendedor_tiny, id_natureza, natureza, tipo_operacao, id_nf, lista_preco,
  total, total_produtos, desconto, qtd_pecas, operacao_valida, motivo_exclusao,
  assinatura, atualizado_em
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?
)
ON CONFLICT(uid) DO UPDATE SET
  grupo=excluded.grupo, numero=excluded.numero, data=excluded.data, mes_ref=excluded.mes_ref,
  situacao=excluded.situacao, faturado=excluded.faturado, cliente_nome=excluded.cliente_nome,
  cnpj=excluded.cnpj, cidade_raw=excluded.cidade_raw, uf_raw=excluded.uf_raw,
  municipio_id=excluded.municipio_id, cidade=excluded.cidade, uf=excluded.uf,
  lat=excluded.lat, lon=excluded.lon, vendedor_tiny=excluded.vendedor_tiny,
  id_natureza=excluded.id_natureza, natureza=excluded.natureza,
  tipo_operacao=excluded.tipo_operacao, id_nf=excluded.id_nf, lista_preco=excluded.lista_preco,
  total=excluded.total, total_produtos=excluded.total_produtos, desconto=excluded.desconto,
  qtd_pecas=excluded.qtd_pecas, operacao_valida=excluded.operacao_valida,
  motivo_exclusao=excluded.motivo_exclusao, assinatura=excluded.assinatura,
  atualizado_em=excluded.atualizado_em
`);

export const apagarItensOlist = db.prepare('DELETE FROM itens_olist WHERE uid_pedido = ?');
export const inserirItemOlist = db.prepare(`
INSERT INTO itens_olist (uid_pedido, seq, sku, descricao, produto, categoria, linha, qtd, valor_unit, valor_bruto)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// ------------------------------------------------------- tabela de fatos
export const inserirPedido = db.prepare(`
INSERT INTO pedidos (
  uid, linha_planilha, aba, tipo_aba, numero, pedidos_ref, parcial, data, data_faturamento, mes_ref, ano,
  situacao, faturado, cliente_nome, cliente_chave, cnpj,
  cidade_raw, uf_raw, municipio_id, cidade, uf, lat, lon,
  vendedor_sheet, vendedor_tiny, representante, natureza, tipo_operacao,
  id_nf, nf_planilha, lista_preco, total, total_olist, qtd_pecas,
  valido, motivo_exclusao, conta, uid_olist, fontes, atualizado_em
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?
)
`);

export const inserirItem = db.prepare(`
INSERT INTO itens (uid_pedido, seq, sku, descricao, produto, categoria, linha, qtd, valor_unit, valor_bruto, valor)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function limparFatos() {
  db.exec('DELETE FROM itens; DELETE FROM pedidos;');
}

export const inserirAmostra = db.prepare(`
INSERT INTO amostras (cliente, cliente_chave, pedido, data, mes_ref, valor, nf, envio, observacoes)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export const inserirLead = db.prepare(`
INSERT INTO leads (data, data_raw, mes_ref, canal, campanha, segmento, uf,
                   enviados, falhas, entregues, retornos, vendas)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function limparAlertas() {
  db.exec('DELETE FROM alertas');
}

export const inserirAlerta = db.prepare(`
INSERT INTO alertas (tipo, gravidade, chave, detalhe, valor, criado_em)
VALUES (?, ?, ?, ?, ?, ?)
`);
