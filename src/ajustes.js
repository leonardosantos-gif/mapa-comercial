/**
 * Ajustes manuais de carteira: reatribuicao de representante por cliente.
 *
 * O representante vem da planilha (coluna VENDEDOR), que e a base. Quando a
 * carteira muda de dono e a planilha ainda nao reflete isso, o ajuste fica aqui
 * e sobrevive a qualquer sincronizacao -- editar direto no banco seria desfeito
 * no proximo sync, que reconstroi a tabela de fatos.
 *
 * Precedencia: ajuste > planilha > vendedor do ERP.
 *
 * O arquivo `config/representante-por-cliente.json` e a fonte; `vendedor_sheet` e
 * `vendedor_tiny` continuam gravados no banco, entao sempre da para ver o valor
 * original e o ajustado lado a lado.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { norm } from './geo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARQUIVO = path.join(__dirname, '..', 'config', 'representante-por-cliente.json');

const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');

let cache = null;

function carregar() {
  if (cache) return cache;
  let ajustes = [];
  let erro = null;
  try {
    if (fs.existsSync(ARQUIVO)) {
      const bruto = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
      ajustes = Array.isArray(bruto) ? bruto : (bruto.ajustes ?? []);
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
  cache = { ajustes, porCnpj, porNome, erro };
  return cache;
}

/** Limpa o cache (usado pela sincronizacao, para pegar edicoes do arquivo). */
export function recarregarAjustes() {
  cache = null;
  return carregar();
}

/** Representante ajustado para o cliente, ou null se nao houver ajuste. */
export function representanteAjustado(cnpj, nomeCliente) {
  const { porCnpj, porNome } = carregar();
  const doc = soDigitos(cnpj);
  if (doc && porCnpj.has(doc)) return porCnpj.get(doc);
  const n = norm(nomeCliente);
  if (n && porNome.has(n)) return porNome.get(n);
  return null;
}

/** Lista dos ajustes, para a tela de administracao. */
export function listarAjustes() {
  const { ajustes, erro } = carregar();
  return { arquivo: 'config/representante-por-cliente.json', total: ajustes.length, ajustes, erro };
}
