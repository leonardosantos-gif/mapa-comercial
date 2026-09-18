/**
 * Mapa Comercial Interativo Fiber -- backend.
 *
 * Todas as credenciais ficam aqui (server-side). O frontend so consome os
 * endpoints agregados: /api/estados -> /api/cidades -> /api/clientes -> /api/cliente/:chave,
 * carregando cada nivel sob demanda.
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db, getMeta, veioDoSnapshot } from './src/db.js';
import * as ag from './src/agregados.js';
import * as com from './src/comercial.js';
import * as rep from './src/reposicao.js';
import * as abertos from './src/pedidos-abertos.js';
import { sincronizar, estadoSync, gerarAlertas } from './src/sync.js';
import { testarConexao, estatisticas, credenciais } from './src/tiny.js';
import { GEO_DIR } from './src/geo.js';
import { listarAjustes } from './src/ajustes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3110);

app.use(cors());
app.use(express.json());

/** Cache curto em memoria: os agregados sao deterministicos entre syncs. */
const cache = new Map();
const TTL_MS = 60_000;
function comCache(chave, fn) {
  const hit = cache.get(chave);
  if (hit && Date.now() - hit.quando < TTL_MS) return hit.valor;
  const valor = fn();
  cache.set(chave, { quando: Date.now(), valor });
  return valor;
}
function limparCache() { cache.clear(); }

const rota = (fn) => (req, res) => {
  try {
    res.json(fn(req));
  } catch (e) {
    console.error('ERRO', req.path, e);
    res.status(500).json({ erro: e.message });
  }
};

const chaveDe = (req) => `${req.path}?${new URLSearchParams(req.query).toString()}`;

// ---------------------------------------------------------------- agregados
app.get('/api/filtros', rota(() => comCache('filtros', () => ag.opcoesFiltro())));
app.get('/api/resumo', rota((req) => comCache(chaveDe(req), () => ag.resumo(req.query))));
app.get('/api/estados', rota((req) => comCache(chaveDe(req), () => ag.porEstado(req.query))));
app.get('/api/cidades', rota((req) => comCache(chaveDe(req), () => ag.porCidade(req.query))));
app.get('/api/clientes', rota((req) => comCache(chaveDe(req), () => ag.porCliente(req.query))));
app.get('/api/produtos', rota((req) => comCache(chaveDe(req), () => ag.porProduto(req.query))));
app.get('/api/representantes', rota((req) => comCache(chaveDe(req), () => ag.porRepresentante(req.query))));
app.get('/api/meses', rota((req) => comCache(chaveDe(req), () => ag.porMes(req.query))));
app.get('/api/concentracao', rota((req) => comCache(chaveDe(req), () => ag.concentracaoMensal(req.query))));
app.get('/api/pedidos', rota((req) => ag.listarPedidos(req.query)));
app.get('/api/pedido/:uid/itens', rota((req) => ag.itensDoPedido(req.params.uid)));
app.get('/api/alertas', rota(() => comCache('alertas', () => ag.alertas())));
app.get('/api/excluidos', rota(() => comCache('excluidos', () => ag.pedidosExcluidos())));

// ------------------------------- KPIs executivos (herdados do Cockpit) -----
app.get('/api/comercial/visao', rota((req) => comCache(chaveDe(req), () => com.visaoGeral(req.query))));
app.get('/api/comercial/vendas', rota((req) => comCache(chaveDe(req), () => com.vendasMensais(req.query))));
app.get('/api/comercial/concentracao', rota((req) => comCache(chaveDe(req), () => com.concentracao(req.query))));
app.get('/api/comercial/carteira', rota((req) => comCache(chaveDe(req), () => com.carteira(req.query))));
app.get('/api/comercial/amostras', rota((req) => comCache(chaveDe(req), () => com.amostras(req.query))));
app.get('/api/comercial/prospeccao', rota((req) => comCache(chaveDe(req), () => com.prospeccao(req.query))));

// ---------------------------------------- reposicao (venda x estoque x OC) --
// Nao passa pelo cache dos agregados: o estoque e a OC vem de tabelas proprias,
// atualizadas em etapas separadas do sync, e o cache e invalidado pelo sync.
app.get('/api/reposicao', rota((req) => rep.reposicao(req.query)));
app.get('/api/reposicao/categorias', rota(() => rep.categoriasReposicao()));

/** Pedidos em aberto: o que da para faturar hoje e o que o estoque esta travando. */
app.get('/api/pedidos-abertos', rota((req) => abertos.pedidosAbertos(req.query)));

/** Envios de amostra de um cliente (a lista de datas abre ao clicar na linha). */
app.get('/api/comercial/amostras-cliente', (req, res) => {
  try {
    if (!req.query.cliente) return res.status(400).json({ erro: 'informe ?cliente=' });
    const d = com.amostrasDoCliente(String(req.query.cliente), req.query);
    if (!d) return res.status(404).json({ erro: 'Cliente sem amostras no filtro atual' });
    res.json(d);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/** Grade de SKUs de um produto (o nome vai por query: pode ter "/" e acento). */
app.get('/api/produto-detalhe', (req, res) => {
  try {
    if (!req.query.produto) return res.status(400).json({ erro: 'informe ?produto=' });
    const d = ag.detalheProduto(String(req.query.produto), req.query);
    if (!d) return res.status(404).json({ erro: 'Produto sem venda no filtro atual' });
    res.json(d);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/cliente/:chave', (req, res) => {
  try {
    const d = ag.detalheCliente(req.params.chave, req.query);
    if (!d) return res.status(404).json({ erro: 'Cliente sem pedidos no filtro atual' });
    res.json(d);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/** Painel do dashboard em uma chamada (evita 6 requisicoes na carga inicial). */
app.get('/api/dashboard', rota((req) => comCache(chaveDe(req), () => ({
  resumo: ag.resumo(req.query),
  estados: ag.porEstado(req.query),
  meses: ag.porMes(req.query),
  // total por mes da aba PEDIDOS FATURADOS: nao responde aos filtros (ver agregados.js)
  faturamento: ag.faturamentoMensal(),
  representantes: ag.porRepresentante(req.query),
  produtos: ag.porProduto({ ...req.query, limite: 15 }),
}))));

// ------------------------------------------------------------------ geo
app.get('/api/geo/estados', (req, res) => {
  const f = path.join(GEO_DIR, 'uf.geojson');
  if (!fs.existsSync(f)) return res.status(503).json({ erro: 'Base geografica ausente. Rode: npm run geo' });
  // `sendFile` gera ETag/Last-Modified; com must-revalidate o navegador confere a
  // cada carga e nao fica preso numa malha antiga (um max-age longo aqui ja
  // mascarou a correcao de orientacao dos aneis por um dia).
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.type('application/json');
  res.sendFile(f);
});

/** Codigo IBGE da UF -> sigla/nome (a malha traz apenas `codarea`). */
app.get('/api/geo/ufs', rota(() => {
  const f = path.join(GEO_DIR, 'ufs.json');
  const ufs = JSON.parse(fs.readFileSync(f, 'utf8'));
  return ufs.map((u) => ({ codigo: String(u.id), sigla: u.sigla, nome: u.nome, regiao: u.regiao?.nome }));
}));

// --------------------------------------------------------------- administracao
app.get('/api/admin/status', async (req, res) => {
  try {
    const ultimoResultado = getMeta('ultimo_resultado');
    const linhas = db.prepare(`
      SELECT COUNT(*) pedidos,
             SUM(valido) validos,
             COUNT(DISTINCT cliente_chave) clientes,
             COUNT(DISTINCT uf) estados,
             COUNT(DISTINCT municipio_id) cidades,
             MIN(data) primeira, MAX(data) ultima
        FROM pedidos`).get();
    const itens = db.prepare('SELECT COUNT(*) n FROM itens').get().n;
    const planilha = db.prepare('SELECT COUNT(*) n, SUM(conciliado) conciliados FROM planilha_linhas').get();
    const historico = db.prepare('SELECT inicio, fim, status, pedidos, erros FROM sync_log ORDER BY id DESC LIMIT 10').all();
    const nAlertas = db.prepare('SELECT COUNT(*) n FROM alertas').get().n;
    res.json({
      ultima_sync: getMeta('ultima_sync'),
      ultimo_resultado: ultimoResultado ? JSON.parse(ultimoResultado) : null,
      sync_em_andamento: estadoSync.rodando,
      etapa: estadoSync.etapa,
      progresso: estadoSync.progresso,
      total_progresso: estadoSync.total,
      banco: { ...linhas, itens },
      planilha: {
        linhas: planilha.n,
        conciliadas: planilha.conciliados,
        abas: JSON.parse(getMeta('abas_planilha') ?? '[]'),
        totais_mensais: JSON.parse(getMeta('totais_planilha') ?? '[]'),
      },
      alertas: nAlertas,
      // modo somente-leitura: quem recebeu o repositorio nao tem .env e ve os
      // dados do snapshot. A tela usa isso para nao oferecer o botao de sync.
      somente_leitura: !credenciais.completo,
      credenciais: { tiny_b2b: credenciais.b2b, tiny_matriz: credenciais.matriz, planilha: credenciais.planilha },
      banco_do_snapshot: veioDoSnapshot,
      ajustes_carteira: listarAjustes(),
      agendamento,
      api: {
        // o contador em memoria zera a cada reinicio do servidor; sem chamada
        // neste processo, mostra o que a ultima sincronizacao registrou
        chamadas: estatisticas.chamadas || (ultimoResultado ? JSON.parse(ultimoResultado).chamadas_api ?? 0 : 0),
        erros: estatisticas.erros,
        desta_sessao: estatisticas.chamadas,
        ultimo_erro: estatisticas.ultimoErro,
      },
      historico_sync: historico,
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/admin/conexao', async (req, res) => {
  try {
    res.json(await testarConexao());
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/admin/sync', async (req, res) => {
  // Sem credenciais nao da para sincronizar. Recusar aqui e essencial: a
  // resposta e enviada ANTES do sync rodar, entao sem esta guarda o botao
  // responderia "iniciado" e a falha morreria no console do servidor -- quem
  // recebeu o repositorio veria sucesso e nenhum dado novo.
  if (!credenciais.completo) {
    return res.status(403).json({
      erro: 'Este ambiente esta em modo somente-leitura (sem credenciais no .env). '
        + 'Os dados vem do snapshot do repositorio: para atualizar, rode "git pull" '
        + 'e reinicie o servidor.',
      somente_leitura: true,
    });
  }
  if (estadoSync.rodando) {
    return res.status(409).json({ erro: 'Sincronizacao ja em andamento', etapa: estadoSync.etapa });
  }
  const full = req.body?.full === true || req.query.full === '1';
  res.json({ iniciado: true, full });
  // roda fora do ciclo da resposta; o progresso e lido em /api/admin/status
  sincronizar({ full })
    .then(() => limparCache())
    .catch((e) => console.error('sync falhou:', e.message));
});

app.post('/api/admin/alertas/recalcular', (req, res) => {
  try {
    const totais = JSON.parse(getMeta('totais_planilha') ?? '[]');
    const n = gerarAlertas(totais);
    limparCache();
    res.json({ alertas: n });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ------------------------------------------------------------------ estatico
// rota de API inexistente deve falhar como API, nao devolver o index.html
app.use('/api', (req, res) => res.status(404).json({ erro: `Rota nao encontrada: ${req.path}` }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/**
 * Atualizacao automatica.
 *
 * Roda DENTRO do servidor de proposito: um processo externo (Tarefa Agendada)
 * gravaria no mesmo SQLite em paralelo com as consultas do dashboard. Aqui existe
 * um unico escritor, e o `estadoSync.rodando` impede sobreposicao.
 *
 * Requer o servidor no ar. Intervalo em `SYNC_INTERVALO_MIN` (0 desliga).
 */
const INTERVALO_MIN = Number(process.env.SYNC_INTERVALO_MIN ?? 60);
export const agendamento = { ativo: false, intervalo_min: INTERVALO_MIN, proxima: null, ultima: null };

function agendarSync() {
  if (!INTERVALO_MIN || INTERVALO_MIN <= 0) {
    console.log('Atualizacao automatica desligada (SYNC_INTERVALO_MIN=0).');
    return;
  }
  // Sem credenciais nao ha o que sincronizar. Desligar aqui evita um erro por
  // hora no log de quem so consulta o banco que veio no repositorio.
  if (!credenciais.completo) {
    agendamento.motivo_inativo = 'credenciais ausentes (.env)';
    console.log('Atualizacao automatica desligada: falta .env (modo somente-leitura).');
    return;
  }
  const ms = INTERVALO_MIN * 60_000;
  agendamento.ativo = true;
  agendamento.proxima = new Date(Date.now() + ms).toISOString();

  const rodar = async () => {
    agendamento.proxima = new Date(Date.now() + ms).toISOString();
    if (estadoSync.rodando) {
      console.log('[auto] sync anterior ainda em andamento, pulando este ciclo');
      return;
    }
    try {
      console.log(`[auto] iniciando sincronizacao (a cada ${INTERVALO_MIN} min)`);
      const r = await sincronizar({});
      limparCache();
      agendamento.ultima = { quando: r.fim, status: 'ok', base: r.base_planilha };
      console.log(`[auto] concluida: ${r.base_planilha} lancamentos, ${r.chamadas_api} chamadas a API`);
    } catch (e) {
      agendamento.ultima = { quando: new Date().toISOString(), status: 'erro', erro: e.message };
      console.error('[auto] falhou:', e.message);
    }
  };

  const timer = setInterval(rodar, ms);
  timer.unref?.();
  console.log(`Atualizacao automatica a cada ${INTERVALO_MIN} min (primeira em ${INTERVALO_MIN} min).`);
}

app.listen(PORT, () => {
  const n = db.prepare('SELECT COUNT(*) n FROM pedidos').get().n;
  console.log(`\nMapa Comercial Fiber em http://localhost:${PORT}`);
  console.log(`Banco: ${n} pedidos | ultima sync: ${getMeta('ultima_sync') ?? 'nunca'}`);
  if (!n) console.log('AVISO: banco vazio. Rode "npm run sync" para carregar os dados.');
  if (!credenciais.completo) {
    const faltam = [
      credenciais.b2b ? null : 'TINY_TOKEN',
      credenciais.matriz ? null : 'TINY_TOKEN_MATRIZ',
      credenciais.planilha ? null : 'PLANILHA_PUB_ID',
    ].filter(Boolean);
    console.log('Modo somente-leitura: sem ' + faltam.join(', ') + ' no .env.');
    console.log('O dashboard mostra os dados do banco; nao consegue atualizar.');
  }
  agendarSync();
});
