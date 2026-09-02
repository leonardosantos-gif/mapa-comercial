/**
 * Leitura e padronizacao da planilha comercial publicada ("PEDIDOS FIBER B2B").
 *
 * Esta e a BASE do dashboard: ela define quais pedidos existem, o valor e o mes
 * de competencia. As abas sao descobertas automaticamente -- meses novos entram
 * sem alterar codigo.
 */
import 'dotenv/config';
import { norm } from './geo.js';
import { padronizarRepresentante, padronizarCliente, MESES_PT } from './regras.js';
import { getMeta, setMeta } from './db.js';

const PUB_ID = process.env.PLANILHA_PUB_ID;
const BASE = `https://docs.google.com/spreadsheets/d/e/${PUB_ID}`;

/**
 * Abas ja vistas em qualquer sincronizacao anterior (`meta.gids_conhecidos`).
 *
 * Aba OCULTA na planilha sai da listagem do `pubhtml`, mas o CSV por gid
 * continua respondendo. Sem lembrar dos gids, ocultar uma aba derruba os
 * numeros em silencio -- foi o que aconteceu em 01/09/2026, quando as abas
 * MARCO..JULHO2026 foram ocultadas e o total caiu R$ 244.815.
 *
 * O registro e CUMULATIVO de proposito: `meta.abas_planilha` guarda so o que o
 * ultimo sync viu, entao serviria de nada -- na primeira leitura sem a aba, o
 * gid dela se perderia junto.
 */
function abasLembradas() {
  try {
    return JSON.parse(getMeta('gids_conhecidos') ?? '[]')
      .filter((a) => a?.nome && a?.gid)
      .map((a) => ({ nome: a.nome, gid: String(a.gid) }));
  } catch {
    return [];
  }
}

/** Soma as abas recem-vistas ao registro cumulativo, sem remover nenhuma. */
function registrarAbas(abas) {
  try {
    const porGid = new Map(abasLembradas().map((a) => [a.gid, a]));
    for (const a of abas) porGid.set(String(a.gid), { nome: a.nome, gid: String(a.gid) });
    setMeta('gids_conhecidos', [...porGid.values()]);
  } catch { /* registro e conveniencia: falhar aqui nao pode parar o sync */ }
}

/**
 * Descobre as abas (nome + gid) a partir do HTML publicado, somadas as que ja
 * foram vistas antes. Uma aba lembrada so e mantida se o CSV dela ainda
 * responder: assim aba OCULTA continua entrando, e aba DELETADA sai.
 */
export async function descobrirAbas() {
  const res = await fetch(`${BASE}/pubhtml`, {
    headers: { 'User-Agent': 'mapa-comercial-fiber/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao abrir a planilha publicada`);
  const html = await res.text();
  const re = /\{name:\s*"([^"]*)"[\s\S]{0,800}?gid:\s*"(\d+)"/g;
  const abas = [];
  let m;
  while ((m = re.exec(html))) {
    abas.push({ nome: m[1].replace(/\\\//g, '/').trim(), gid: m[2] });
  }
  if (!abas.length) throw new Error('Nao foi possivel descobrir as abas da planilha publicada');

  const listados = new Set(abas.map((a) => a.gid));
  for (const lembrada of abasLembradas()) {
    if (listados.has(lembrada.gid)) continue;
    // uma tentativa so: se a aba foi deletada, nao vale insistir a cada sync
    try {
      await baixarCsv(lembrada.gid, 1);
      abas.push({ ...lembrada, oculta: true });
    } catch { /* aba deletada ou sem acesso: fica de fora */ }
  }
  registrarAbas(abas);
  return abas;
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Baixa uma aba em CSV. O Google devolve 409/429 quando as abas sao pedidas em
 * sequencia rapida -- sem retry, uma aba inteira sumia da leitura silenciosamente.
 */
export async function baixarCsv(gid, tentativas = 4) {
  const url = `${BASE}/pub?gid=${gid}&single=true&output=csv`;
  let ultimo;
  for (let t = 0; t < tentativas; t++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'mapa-comercial-fiber/1.0' } });
    if (res.ok) return res.text();
    ultimo = `HTTP ${res.status} ao baixar a aba ${gid}`;
    if (![409, 429, 500, 502, 503].includes(res.status)) break;
    await espera(900 * (t + 1));
  }
  throw new Error(ultimo);
}

/** Parser de CSV que respeita aspas e quebras de linha dentro do campo. */
export function parseCsv(texto) {
  const linhas = [];
  let linha = [];
  let campo = '';
  let dentroAspas = false;
  const t = texto.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (dentroAspas) {
      if (ch === '"') {
        if (t[i + 1] === '"') { campo += '"'; i++; }
        else dentroAspas = false;
      } else campo += ch;
      continue;
    }
    if (ch === '"') { dentroAspas = true; continue; }
    if (ch === ',') { linha.push(campo); campo = ''; continue; }
    if (ch === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; continue; }
    campo += ch;
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}

/**
 * Converte valor monetario brasileiro em numero.
 * Aceita "R$13 737,50", "R$244 756,05", "203.893,21", "48426,46", "1149,6".
 */
export function valorBr(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v)
    .replace(/ /g, ' ')
    .replace(/R\$/gi, '')
    .replace(/\s/g, '')
    .trim();
  if (!s || /^-$/.test(s)) return null;
  const negativo = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[()\-]/g, '');
  if (!/[\d]/.test(s)) return null;

  const temPonto = s.includes('.');
  const temVirgula = s.includes(',');
  if (temPonto && temVirgula) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (temVirgula) {
    s = s.replace(',', '.');
  } else if (temPonto) {
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negativo ? -n : n;
}

/**
 * Numeros de pedido Olist referenciados numa celula.
 * A planilha usa formas compostas que NAO podem ser lidas como digitos colados:
 *   "178"      -> [178]
 *   "127-3"    -> [127]        (pedido 127, remessa/parcela 3)
 *   "75 / 196" -> [75, 196]    (uma NF cobrindo dois pedidos)
 * Devolve tambem `parcial`: a celula aponta parte de um pedido ou mais de um
 * pedido, entao o valor da linha nao equivale ao total do pedido.
 */
export function numerosPedido(v) {
  const bruto = String(v ?? '').trim();
  if (!bruto) return { numeros: [], parcial: false };
  const partes = bruto.split(/[\/;+]|\se\s/).map((p) => p.trim()).filter(Boolean);
  const numeros = [];
  let parcial = partes.length > 1;
  for (const parte of partes) {
    const m = parte.match(/(\d+)/);
    if (!m) continue;
    if (/^\s*\d+\s*[-.]\s*\d+/.test(parte)) parcial = true;
    numeros.push(String(Number(m[1])));
  }
  return { numeros: [...new Set(numeros)], parcial };
}

export function numeroPedido(v) {
  return numerosPedido(v).numeros[0] ?? null;
}

/** "JUNHO2026" / "MARÇO2026" -> "2026-06". */
export function mesRefDoNomeAba(nomeAba) {
  const n = norm(nomeAba);
  const m = n.match(/^([A-Z]+)\s*(\d{4})$/);
  if (!m) return null;
  const idx = MESES_PT.findIndex((mes) => norm(mes) === m[1]);
  if (idx < 0) return null;
  return `${m[2]}-${String(idx + 1).padStart(2, '0')}`;
}

/**
 * Data da planilha -> ISO. Aceita "13/04/2026" e "06/05" (sem ano).
 * Sem ano, usa o ano da aba mensal; sem isso, devolve null (o Olist supre depois).
 */
export function dataPlanilha(raw, anoDica) {
  const s = String(raw ?? '').trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m) return `20${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m && anoDica) return `${anoDica}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/** Localiza a linha de cabecalho que contem as colunas pedidas. */
function acharCabecalho(linhas, obrigatorias) {
  for (let i = 0; i < Math.min(linhas.length, 15); i++) {
    const cols = linhas[i].map(norm);
    if (obrigatorias.every((o) => cols.some((c) => c === norm(o) || c.startsWith(norm(o))))) {
      return { indice: i, cols };
    }
  }
  return null;
}

function indiceDe(cols, ...nomes) {
  for (const nome of nomes) {
    const alvo = norm(nome);
    let i = cols.findIndex((c) => c === alvo);
    if (i >= 0) return i;
    i = cols.findIndex((c) => c.startsWith(alvo));
    if (i >= 0) return i;
  }
  return -1;
}

/** Classifica a aba pelo nome. */
export function tipoDaAba(nomeAba) {
  if (mesRefDoNomeAba(nomeAba)) return 'mensal';
  const n = norm(nomeAba);
  if (/^PEDIDOS FATURADOS/.test(n)) return 'faturados';
  if (/^PEDIDOS EM ABERTO/.test(n)) return 'aberto';
  if (/^PEDIDOS CANCELADOS/.test(n)) return 'cancelado';
  if (n === 'REPS') return 'reps';
  return 'ignorada';
}

const SITUACAO_POR_TIPO = {
  faturados: 'Faturado',
  aberto: 'Em aberto',
  cancelado: 'Cancelado',
};

/**
 * Le a planilha inteira e devolve as linhas padronizadas.
 * Cada linha e um LANCAMENTO comercial: cliente, pedido, vendedor, valor, mes.
 */
export async function lerPlanilha() {
  const abas = await descobrirAbas();
  const linhasSaida = [];
  const abasLidas = [];
  const avisos = [];

  for (const aba of abas) {
    const tipo = tipoDaAba(aba.nome);
    if (tipo === 'ignorada') {
      abasLidas.push({ nome: aba.nome, gid: aba.gid, tipo, mes_ref: null, linhas: 0 });
      continue;
    }

    let csv;
    try {
      csv = await baixarCsv(aba.gid);
    } catch (e) {
      avisos.push(`aba "${aba.nome}": ${e.message}`);
      continue;
    }
    const linhas = parseCsv(csv);
    const mesAba = mesRefDoNomeAba(aba.nome);
    const anoDica = mesAba ? mesAba.slice(0, 4) : null;

    // cabecalho depende do tipo de aba
    const obrigatorias = tipo === 'mensal' ? ['CLIENTE', 'PEDIDO OLIST']
      : tipo === 'reps' ? ['PEDIDO'] : ['NOME DO CLIENTE'];
    const cab = acharCabecalho(linhas, obrigatorias);
    if (!cab) { avisos.push(`aba "${aba.nome}": cabecalho nao encontrado`); continue; }
    const { indice, cols } = cab;

    const iCli = tipo === 'reps' ? 0 : indiceDe(cols, 'CLIENTE', 'NOME DO CLIENTE');
    const iPed = indiceDe(cols, 'PEDIDO OLIST', 'PEDIDO');
    const iVen = indiceDe(cols, 'VENDEDOR', 'REPRESENTANTE', 'RESPONSAVEL');
    const iVal = indiceDe(cols, 'VALOR');
    const iNf = indiceDe(cols, 'NF');
    const iObs = indiceDe(cols, 'OBSERVACOES', 'OBS');
    const iData = indiceDe(cols, 'CADASTRO', 'DATA');
    const iSit = indiceDe(cols, 'SITUACAO', 'STATUS');
    // Nas abas de status a coluna FATURAMENTO tem a data; em PEDIDOS EM ABERTO ela
    // traz texto ("estoque ok"), que o parser de data descarta sozinho.
    const iFat = indiceDe(cols, 'FATURAMENTO');

    // aba REPS: o representante esta no titulo ("Pedidos THIAGO RAPPA")
    let repDaAba = null;
    if (tipo === 'reps') {
      const titulo = (linhas[0] ?? []).find((c) => /pedidos/i.test(String(c))) ?? '';
      repDaAba = padronizarRepresentante(String(titulo).replace(/pedidos/i, '').trim());
    }

    let lidas = 0;
    for (let i = indice + 1; i < linhas.length; i++) {
      const l = linhas[i];
      const cliente = padronizarCliente(l[iCli]);
      const ref = numerosPedido(l[iPed]);
      if (!cliente && !ref.numeros.length) continue;
      if (/^TOTAL/i.test(norm(cliente))) continue;

      const dataRaw = iData >= 0 ? String(l[iData] ?? '').trim() : '';
      const situacaoCol = iSit >= 0 ? String(l[iSit] ?? '').trim() : '';
      linhasSaida.push({
        aba: aba.nome,
        gid: aba.gid,
        tipo_aba: tipo,
        mes_aba: mesAba,
        cliente,
        pedido_olist: ref.numeros[0] ?? null,
        pedidos_ref: ref.numeros,
        parcial: ref.parcial,
        data_raw: dataRaw || null,
        data: dataPlanilha(dataRaw, anoDica),
        data_faturamento: iFat >= 0 ? dataPlanilha(String(l[iFat] ?? '').trim(), anoDica) : null,
        vendedor: repDaAba ?? (iVen >= 0 ? padronizarRepresentante(l[iVen]) : null),
        valor: valorBr(l[iVal]),
        nf: iNf >= 0 ? String(l[iNf] ?? '').trim() || null : null,
        situacao: situacaoCol || SITUACAO_POR_TIPO[tipo] || null,
        observacoes: iObs >= 0 ? String(l[iObs] ?? '').trim() || null : null,
      });
      lidas++;
    }
    abasLidas.push({ nome: aba.nome, gid: aba.gid, tipo, mes_ref: mesAba, linhas: lidas });
  }

  return { linhas: linhasSaida, abas: abasLidas, avisos };
}

/**
 * Total mensal declarado no topo das abas mensais.
 *
 * A linha "Mes referencia" traz UMA COLUNA POR ANO (2024 | 2025 | 2026), que e a
 * fonte do comparativo YoY -- os anos anteriores nao existem como lancamento na
 * planilha, so nesse cabecalho.
 */
export async function lerTotaisMensais() {
  const abas = await descobrirAbas();
  const totais = [];
  for (const aba of abas) {
    const mes = mesRefDoNomeAba(aba.nome);
    if (!mes) continue;
    let linhas;
    try { linhas = parseCsv(await baixarCsv(aba.gid)); } catch { continue; }
    const iCab = linhas.findIndex((l) => norm(l[0]) === 'MES REFERENCIA');
    if (iCab < 0 || !linhas[iCab + 1]) continue;
    const cab = linhas[iCab].map(norm);
    const dados = linhas[iCab + 1];
    const ano = Number(mes.slice(0, 4));

    const porAno = {};
    cab.forEach((c, i) => {
      if (/^\d{4}$/.test(c)) porAno[c] = valorBr(dados[i]);
    });
    totais.push({
      mes_ref: mes,
      aba: aba.nome,
      total_planilha: porAno[String(ano)] ?? null,
      ano_atual: porAno[String(ano)] ?? null,
      ano_menos_1: porAno[String(ano - 1)] ?? null,
      ano_menos_2: porAno[String(ano - 2)] ?? null,
      anos: porAno,
    });
  }
  return totais;
}

/**
 * Aba AMOSTRAS: brindes e amostras enviadas. Ficam FORA do faturamento (nao sao
 * venda), em tabela propria, para alimentar o painel de amostras sem contaminar
 * os numeros comerciais.
 */
export async function lerAmostras() {
  const abas = await descobrirAbas();
  const aba = abas.find((a) => norm(a.nome) === 'AMOSTRAS');
  if (!aba) return { linhas: [], aba: null };
  const linhas = parseCsv(await baixarCsv(aba.gid));
  const cab = acharCabecalho(linhas, ['NOME DO CLIENTE']);
  if (!cab) return { linhas: [], aba: aba.nome };
  const { indice, cols } = cab;
  const iCli = indiceDe(cols, 'NOME DO CLIENTE', 'CLIENTE');
  const iPed = indiceDe(cols, 'PEDIDO OLIST', 'PEDIDO');
  const iData = indiceDe(cols, 'DATA', 'CADASTRO');
  const iVal = indiceDe(cols, 'VALOR');
  const iNf = indiceDe(cols, 'NF');
  const iEnvio = indiceDe(cols, 'ENVIO');
  const iObs = indiceDe(cols, 'OBS');

  const saida = [];
  for (let i = indice + 1; i < linhas.length; i++) {
    const l = linhas[i];
    const cliente = padronizarCliente(l[iCli]);
    const valor = valorBr(l[iVal]);
    if (!cliente && !valor) continue;
    const data = dataPlanilha(String(l[iData] ?? '').trim());
    saida.push({
      cliente,
      pedido: iPed >= 0 ? numeroPedido(l[iPed]) : null,
      data,
      mes_ref: data ? data.slice(0, 7) : null,
      valor: valor ?? 0,
      nf: iNf >= 0 ? String(l[iNf] ?? '').trim() || null : null,
      envio: iEnvio >= 0 ? String(l[iEnvio] ?? '').trim() || null : null,
      observacoes: iObs >= 0 ? String(l[iObs] ?? '').trim() || null : null,
    });
  }
  return { linhas: saida, aba: aba.nome };
}

/**
 * Aba LEADS: campanhas de prospeccao B2B (envio, canal, campanha, segmento, UF,
 * enviados, falhas, entregues, retornos, vendas).
 */
export async function lerLeads() {
  const abas = await descobrirAbas();
  const aba = abas.find((a) => norm(a.nome) === 'LEADS');
  if (!aba) return { campanhas: [], aba: null };
  const linhas = parseCsv(await baixarCsv(aba.gid));
  const cab = acharCabecalho(linhas, ['CANAL']);
  if (!cab) return { campanhas: [], aba: aba.nome };
  const { indice, cols } = cab;
  const iData = indiceDe(cols, 'ENVIO', 'DATA');
  const iCanal = indiceDe(cols, 'CANAL');
  const iCamp = indiceDe(cols, 'CAMPANHA');
  const iSeg = indiceDe(cols, 'SEGMENTO');
  const iUf = indiceDe(cols, 'ESTADO', 'UF');
  const iEnv = indiceDe(cols, 'ENVIADOS');
  const iFal = indiceDe(cols, 'FALHAS');
  const iEnt = indiceDe(cols, 'ENTREGUES');
  const iRet = indiceDe(cols, 'RETORNOS');
  const iVen = indiceDe(cols, 'VENDAS');
  const inteiro = (v) => {
    const n = parseInt(String(v ?? '').replace(/\D/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  };
  const anoCorrente = String(new Date().getFullYear());

  const campanhas = [];
  for (let i = indice + 1; i < linhas.length; i++) {
    const l = linhas[i];
    const canal = String(l[iCanal] ?? '').replace(/\s+/g, ' ').trim();
    const campanha = String(l[iCamp] ?? '').replace(/\s+/g, ' ').trim();
    const dataRaw = String(l[iData] ?? '').trim();
    if (!canal && !campanha && !dataRaw) continue;
    // a aba escreve so dia/mes: o ano do envio e o corrente
    const data = dataPlanilha(dataRaw, anoCorrente);
    const enviados = inteiro(l[iEnv]);
    const entregues = inteiro(l[iEnt]);
    const falhas = inteiro(l[iFal]);
    const retornos = inteiro(l[iRet]);
    campanhas.push({
      data, data_raw: dataRaw || null,
      mes_ref: data ? data.slice(0, 7) : null,
      canal: canal || null,
      campanha: campanha || null,
      segmento: String(l[iSeg] ?? '').replace(/\s+/g, ' ').trim() || null,
      uf: String(l[iUf] ?? '').replace(/\s+/g, ' ').trim() || null,
      enviados, falhas, entregues, retornos,
      vendas: valorBr(l[iVen]) ?? 0,
      // entrega so e medida em parte das campanhas (e-mail antigo nao media)
      taxa_entrega: enviados ? entregues / enviados : null,
      taxa_resposta: (entregues || enviados) ? retornos / (entregues || enviados) : null,
    });
  }
  return { campanhas, aba: aba.nome };
}

/**
 * Faturamento mensal conforme a aba PEDIDOS FATURADOS.
 *
 * Agrupa pela coluna FATURAMENTO (data em que o pedido foi faturado), nao pela
 * CADASTRO (data em que o pedido entrou) -- sao colunas diferentes na aba, e
 * usar a de cadastro faz junho/2026 aparecer com R$ 451 mil em vez de R$ 615
 * mil, porque pedido cadastrado em maio e faturado em junho cai no mes errado.
 *
 * Le a aba direto, SEM as regras de deduplicacao da base: o objetivo deste
 * numero e bater com o que o comercial ve ao somar a coluna na planilha. Por
 * isso ele nao responde aos filtros do dashboard -- a tela avisa.
 */
export async function lerFaturamentoMensal() {
  const abas = await descobrirAbas();
  const aba = abas.find((a) => tipoDaAba(a.nome) === 'faturados');
  if (!aba) return { aba: null, meses: [], total: 0, linhas: 0, sem_data: 0 };

  let linhas;
  try {
    linhas = parseCsv(await baixarCsv(aba.gid));
  } catch (e) {
    // Sem engolir: uma falha aqui zeraria o grafico sem explicar por que.
    return { aba: aba.nome, meses: [], total: 0, linhas: 0, sem_data: 0, erro: e.message };
  }

  const iCab = linhas.findIndex((l) => norm(l[0]) === 'NOME DO CLIENTE');
  if (iCab < 0) return { aba: aba.nome, meses: [], total: 0, linhas: 0, sem_data: 0, erro: 'cabecalho nao encontrado' };
  const cab = linhas[iCab].map(norm);
  const iData = cab.indexOf('FATURAMENTO');
  const iValor = cab.indexOf('VALOR');
  if (iData < 0 || iValor < 0) {
    return { aba: aba.nome, meses: [], total: 0, linhas: 0, sem_data: 0, erro: 'colunas FATURAMENTO/VALOR nao encontradas' };
  }

  const porMes = new Map();
  let total = 0; let n = 0; let semData = 0;
  for (const l of linhas.slice(iCab + 1)) {
    if (!String(l[0] ?? '').trim()) continue;
    const valor = valorBr(l[iValor]);
    if (!valor) continue;
    n += 1;
    total += valor;
    const d = dataPlanilha(l[iData]);
    if (!d) { semData += 1; continue; }
    const mes = d.slice(0, 7);
    const atual = porMes.get(mes) ?? { mes_ref: mes, valor: 0, linhas: 0 };
    atual.valor += valor;
    atual.linhas += 1;
    porMes.set(mes, atual);
  }

  return {
    aba: aba.nome,
    meses: [...porMes.values()].sort((a, b) => a.mes_ref.localeCompare(b.mes_ref)),
    total,
    linhas: n,
    sem_data: semData,
  };
}
