/**
 * Ajustes manuais de carteira: reatribuicao de representante.
 *
 * O representante vem da planilha (coluna VENDEDOR), que e a base. Quando a
 * carteira muda de dono e a planilha ainda nao reflete isso, o ajuste fica aqui
 * e sobrevive a qualquer sincronizacao -- editar direto no banco seria desfeito
 * no proximo sync, que reconstroi a tabela de fatos.
 *
 * Duas granularidades, em `config/representante-por-cliente.json`:
 *
 *  - `ajustes`    : por CLIENTE (casado por CNPJ ou nome). Vale para todos os
 *                   pedidos dele, inclusive os futuros.
 *  - `por_pedido` : por NUMERO DE PEDIDO. Existe porque ha cliente com pedidos
 *                   divididos entre representantes -- Lorenzo Ramos da Rosa tem
 *                   pedidos com tres donos diferentes, e um ajuste por cliente
 *                   atropelaria os demais.
 *
 * Precedencia: pedido > cliente > planilha > vendedor do ERP. O mais especifico
 * vence, entao da para reatribuir um cliente inteiro e abrir excecao para um
 * pedido dele.
 *
 * `vendedor_sheet` e `vendedor_tiny` continuam gravados no banco, entao sempre
 * da para ver o valor original e o ajustado lado a lado.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { norm } from './geo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARQUIVO = path.join(__dirname, '..', 'config', 'representante-por-cliente.json');

const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');
/** Numero de pedido como texto sem zeros a esquerda: "076" e "76" sao o mesmo. */
const chavePedido = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return /^\d+$/.test(s) ? String(Number(s)) : s.toUpperCase();
};

let cache = null;

function carregar() {
  if (cache) return cache;
  let ajustes = [];
  let porPedidoLista = [];
  let erro = null;
  try {
    if (fs.existsSync(ARQUIVO)) {
      const bruto = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
      ajustes = Array.isArray(bruto) ? bruto : (bruto.ajustes ?? []);
      porPedidoLista = Array.isArray(bruto) ? [] : (bruto.por_pedido ?? []);
    }
  } catch (e) {
    erro = e.message;
  }
  const porCnpj = new Map();
  const porNome = new Map();
  for (const a of ajustes) {
    if (!a?.representante) continue;
    const doc = soDigitos(a.cnpj);
    if (doc) porCnpj.set(doc, a.representante);
    if (a.cliente) porNome.set(norm(a.cliente), a.representante);
  }
  const porPedido = new Map();
  for (const a of porPedidoLista) {
    if (!a?.representante) continue;
    const k = chavePedido(a.numero);
    if (k) porPedido.set(k, a.representante);
  }
  cache = { ajustes, porPedidoLista, porCnpj, porNome, porPedido, erro };
  return cache;
}

/** Limpa o cache (usado pela sincronizacao, para pegar edicoes do arquivo). */
export function recarregarAjustes() {
  cache = null;
  return carregar();
}

/**
 * Representante ajustado, ou null se nao houver ajuste.
 * `refs` cobre pedido composto na planilha ("127-3", "75 / 196").
 */
export function representanteAjustado(cnpj, nomeCliente, numeroPedido, refs) {
  const { porCnpj, porNome, porPedido } = carregar();

  // 1) numero do pedido -- o mais especifico vence
  if (porPedido.size) {
    for (const n of [numeroPedido, ...(refs ?? [])]) {
      const k = chavePedido(n);
      if (k && porPedido.has(k)) return porPedido.get(k);
    }
  }

  // 2) cliente, por CNPJ e depois por nome
  const doc = soDigitos(cnpj);
  if (doc && porCnpj.has(doc)) return porCnpj.get(doc);
  const nome = norm(nomeCliente);
  if (nome && porNome.has(nome)) return porNome.get(nome);

  return null;
}

/** Lista dos ajustes, para a tela de administracao. */
export function listarAjustes() {
  const { ajustes, porPedidoLista, erro } = carregar();
  return {
    arquivo: 'config/representante-por-cliente.json',
    total: ajustes.length + porPedidoLista.length,
    total_clientes: ajustes.length,
    total_pedidos: porPedidoLista.length,
    ajustes,
    por_pedido: porPedidoLista,
    erro,
  };
}
