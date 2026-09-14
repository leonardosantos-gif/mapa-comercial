/**
 * Le o catalogo do Portal de Pedidos B2B e devolve a lista plana de SKUs.
 *
 * O catalogo mora em OUTRO projeto (`Desktop/Portal-Pedidos-B2B-Fiber`). Quem
 * clona este repositorio nao tem aquela pasta, entao o arquivo e lido apenas
 * no momento do sync e o resultado e GRAVADO NO BANCO -- assim o snapshot
 * versionado carrega o catalogo junto e o dashboard funciona sem o Portal.
 *
 * O arquivo e um `.js` (`window.FIBER_CATALOGO = {...}`), nao um JSON: a
 * extracao recorta o objeto entre o primeiro `{` e o ultimo `}` e faz parse.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Caminhos onde o catalogo do Portal costuma estar. CATALOGO_B2B_PATH tem prioridade. */
function candidatos() {
  const lista = [];
  if (process.env.CATALOGO_B2B_PATH) lista.push(process.env.CATALOGO_B2B_PATH);
  const rel = path.join('Portal-Pedidos-B2B-Fiber', 'frontend', 'assets', 'data', 'catalogo.js');
  lista.push(path.join(os.homedir(), 'Desktop', rel));
  lista.push(path.join(os.homedir(), 'OneDrive', 'Desktop', rel));
  return lista;
}

export function caminhoCatalogo() {
  return candidatos().find((p) => p && fs.existsSync(p)) ?? null;
}

/**
 * Extrai o objeto do catalogo. Usa recorte + JSON.parse em vez de `eval`:
 * o arquivo e gerado por build e so contem um literal.
 */
function lerObjeto(arquivo) {
  const texto = fs.readFileSync(arquivo, 'utf8');
  const ini = texto.indexOf('{');
  const fim = texto.lastIndexOf('}');
  if (ini < 0 || fim <= ini) throw new Error('catalogo.js sem objeto reconhecivel');
  const bruto = texto.slice(ini, fim + 1).replace(/;\s*$/, '');
  return JSON.parse(bruto);
}

/**
 * Lista plana de SKUs do catalogo B2B.
 * @returns {{sku:string,tiny_id:string|null,produto:string,categoria:string,cor:string,tamanho:string,preco:number,fake:0|1}[]}
 */
export function lerCatalogoB2B() {
  const arquivo = caminhoCatalogo();
  if (!arquivo) return [];

  const cat = lerObjeto(arquivo);
  const out = [];
  const vistos = new Set();

  for (const categoria of cat.categorias ?? []) {
    for (const produto of categoria.produtos ?? []) {
      for (const cor of produto.cores ?? []) {
        for (const item of cor.grade ?? []) {
          const sku = String(item.sku ?? '').trim();
          if (!sku) continue;
          // O mesmo SKU aparece repetido quando duas linhas compartilham grade
          // (Echoa Recovery x Pulse). Fica a primeira ocorrencia.
          if (vistos.has(sku)) continue;
          vistos.add(sku);
          out.push({
            sku,
            tiny_id: item.tinyId ? String(item.tinyId) : null,
            produto: produto.nome ?? '',
            categoria: categoria.nome ?? '',
            cor: cor.cor ?? '',
            tamanho: item.tamanho ?? '',
            preco: Number(item.preco ?? 0),
            // SKU sintetico do portal, sem cadastro no Tiny: nunca tera estoque.
            fake: /^FB-/i.test(sku) || !item.tinyId ? 1 : 0,
          });
        }
      }
    }
  }
  return out;
}
