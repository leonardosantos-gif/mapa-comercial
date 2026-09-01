/**
 * Cliente da API v2 do Olist Tiny (server-side apenas -- o token nunca chega ao frontend).
 * Inclui fila serializada, throttle, backoff e log de erros.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '..', 'logs');
const BASE = 'https://api.tiny.com.br/api2';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Intervalo minimo entre chamadas por conta (a v2 limita ~60 req/min). */
const INTERVALO_MS = Number(process.env.TINY_INTERVALO_MS || 650);

export const estatisticas = {
  chamadas: 0,
  erros: 0,
  retries: 0,
  ultimoErro: null,
};

export function logErro(contexto, mensagem) {
  estatisticas.erros++;
  estatisticas.ultimoErro = { quando: new Date().toISOString(), contexto, mensagem };
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(LOG_DIR, 'erros.log'),
      `${new Date().toISOString()}\t${contexto}\t${mensagem}\n`,
    );
  } catch { /* log e best-effort */ }
}

export function makeClient(token, label = '') {
  let ultimaChamada = 0;
  let fila = Promise.resolve();

  async function executar(endpoint, params) {
    // Erro na CHAMADA, nao no import: sem isso o `server.js` nem sobe quando
    // falta o .env, e quem so quer consultar o banco ja sincronizado trava.
    if (!token) throw new Error(`Token ausente (${label}): defina TINY_TOKEN / TINY_TOKEN_MATRIZ no .env para sincronizar.`);
    const espera = INTERVALO_MS - (Date.now() - ultimaChamada);
    if (espera > 0) await sleep(espera);
    ultimaChamada = Date.now();

    const body = new URLSearchParams({ token, formato: 'json' });
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') body.append(k, String(v));
    }

    let ultimoErro;
    for (let tentativa = 0; tentativa < 5; tentativa++) {
      try {
        estatisticas.chamadas++;
        const res = await fetch(`${BASE}/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const retorno = json.retorno ?? json;
        const status = retorno.status ?? retorno.status_processamento;
        if (status && status !== 'OK' && status !== '3') {
          const erros = (retorno.erros ?? [])
            .map((e) => e.erro ?? (typeof e === 'string' ? e : JSON.stringify(e)))
            .join('; ');
          // consulta sem resultado nao e erro
          if (/n.o retornou registros|nenhum registro/i.test(erros)) return retorno;
          if (/bloquead|excedido|exceeded|momento/i.test(erros)) throw new Error(`RATE: ${erros}`);
          throw new Error(`${endpoint}: ${erros || JSON.stringify(retorno).slice(0, 300)}`);
        }
        return retorno;
      } catch (e) {
        ultimoErro = e;
        if (/RATE|HTTP 5|HTTP 429|fetch failed|ETIMEDOUT|ECONNRESET/i.test(e.message)) {
          estatisticas.retries++;
          await sleep(2500 * (tentativa + 1));
          ultimaChamada = Date.now();
          continue;
        }
        break;
      }
    }
    logErro(`${label}:${endpoint}`, ultimoErro?.message ?? 'desconhecido');
    throw ultimoErro;
  }

  // serializa: nunca duas chamadas simultaneas na mesma conta
  return function call(endpoint, params = {}) {
    const proxima = fila.then(() => executar(endpoint, params));
    fila = proxima.catch(() => {});
    return proxima;
  };
}

export const varejo = makeClient(process.env.TINY_TOKEN, 'b2b');
export const matriz = makeClient(process.env.TINY_TOKEN_MATRIZ, 'matriz');

/** Quais contas tem token. Permite rodar em modo somente-leitura sem .env. */
export const credenciais = {
  get b2b() { return Boolean(process.env.TINY_TOKEN); },
  get matriz() { return Boolean(process.env.TINY_TOKEN_MATRIZ); },
  get planilha() { return Boolean(process.env.PLANILHA_PUB_ID); },
  get completo() { return this.b2b && this.matriz && this.planilha; },
};

/** Percorre todas as paginas de pedidos.pesquisa.php. */
export async function pesquisarPedidos(client, filtro, onProgresso) {
  const out = [];
  let pagina = 1;
  let totalPaginas = 1;
  do {
    const r = await client('pedidos.pesquisa.php', { pagina, ...filtro });
    totalPaginas = Number(r.numero_paginas) || 1;
    for (const x of r.pedidos ?? []) out.push(x.pedido);
    onProgresso?.(pagina, totalPaginas, out.length);
    pagina++;
  } while (pagina <= totalPaginas);
  return out;
}

/** Testa a conexao das duas contas (usado pela tela de administracao). */
export async function testarConexao() {
  const resultado = {};
  for (const [nome, client] of [['b2b', varejo], ['matriz', matriz]]) {
    try {
      const r = await client('info.php', {});
      resultado[nome] = {
        ok: true,
        empresa: r.conta?.razao_social ?? r.razao_social ?? r.conta?.nome ?? null,
        cnpj: r.conta?.cnpj ?? r.cnpj ?? null,
      };
    } catch (e) {
      resultado[nome] = { ok: false, erro: e.message };
    }
  }
  return resultado;
}
