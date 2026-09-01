/**
 * Camada geografica: baixa e cacheia em disco
 *  - malha das UFs (GeoJSON, IBGE api/v3/malhas)
 *  - lista oficial de municipios (IBGE api/v1/localidades) + coordenadas (base IBGE derivada)
 * Nenhuma coordenada e digitada manualmente.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const GEO_DIR = path.join(__dirname, '..', 'data', 'geo');

const URL_MALHA_UF =
  'https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR' +
  '?formato=application/vnd.geo+json&qualidade=intermediaria&intrarregiao=UF';
const URL_UFS = 'https://servicodados.ibge.gov.br/api/v1/localidades/estados';
const URL_MUNICIPIOS = 'https://servicodados.ibge.gov.br/api/v1/localidades/municipios';
const URL_COORDS =
  'https://raw.githubusercontent.com/kelvins/municipios-brasileiros/main/csv/municipios.csv';

const RE_DIACRITICOS = /[̀-ͯ]/g;

/** Normaliza texto para comparacao: sem acento, sem pontuacao, maiusculo, espaco simples. */
export const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(RE_DIACRITICOS, '')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

/** Area assinada (shoelace) de um anel em lon/lat. Positiva = anti-horario. */
function areaAnel(anel) {
  let s = 0;
  for (let i = 0, n = anel.length; i < n - 1; i++) {
    s += anel[i][0] * anel[i + 1][1] - anel[i + 1][0] * anel[i][1];
  }
  return s / 2;
}

/**
 * Reorienta os aneis do GeoJSON para a convencao do **d3-geo**: anel externo no
 * sentido HORARIO (area shoelace negativa), buracos no anti-horario.
 *
 * Atencao: e o INVERSO da RFC 7946, e e assim que a malha do IBGE chega. O d3-geo
 * trabalha em geometria ESFERICA e le um anel anti-horario como "todo o globo menos
 * esta area". Medido nesta malha, antes da correcao: `geoBounds(SP)` devolvia
 * [[-180,-90],[180,90]] e `geoArea(SP)` dava 25,13 sr (o dobro da esfera); depois,
 * bounds corretos e 0,00613 sr = 248.800 km², a area real de SP.
 *
 * Sem isto o mapa nao funciona: `path.bounds`/`centroid` retornam o pais inteiro
 * para qualquer estado (zoom e rotulos quebrados) e cada estado e preenchido como
 * o COMPLEMENTO da sua area -- 27 retangulos gigantes sobrepostos no lugar do mapa.
 */
export function corrigirOrientacao(geojson) {
  let invertidos = 0;
  const ajustarPoligono = (poligono) => {
    poligono.forEach((anel, i) => {
      const externo = i === 0;
      const area = areaAnel(anel);
      // externo: horario (area < 0); buraco: anti-horario (area > 0)
      if ((externo && area > 0) || (!externo && area < 0)) {
        anel.reverse();
        invertidos++;
      }
    });
  };
  for (const f of geojson.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') ajustarPoligono(g.coordinates);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach(ajustarPoligono);
  }
  return invertidos;
}

async function baixar(url, destino, { json = true } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': 'mapa-comercial-fiber/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  const texto = await res.text();
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, texto);
  return json ? JSON.parse(texto) : texto;
}

function csvLinhas(texto) {
  const linhas = texto.trim().split(/\r?\n/);
  const cab = linhas[0].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  return linhas.slice(1).map((l) => {
    const cols = [];
    let atual = '';
    let dentro = false;
    for (const ch of l) {
      if (ch === '"') dentro = !dentro;
      else if (ch === ',' && !dentro) { cols.push(atual); atual = ''; }
      else atual += ch;
    }
    cols.push(atual);
    return Object.fromEntries(cab.map((c, i) => [c, cols[i]]));
  });
}

/** Baixa tudo (idempotente: reusa cache em disco, a menos que force=true). */
export async function prepararGeo({ force = false } = {}) {
  fs.mkdirSync(GEO_DIR, { recursive: true });
  const fMalha = path.join(GEO_DIR, 'uf.geojson');
  const fUfs = path.join(GEO_DIR, 'ufs.json');
  const fMun = path.join(GEO_DIR, 'municipios.json');
  const log = [];

  if (force || !fs.existsSync(fMalha)) {
    const malha = await baixar(URL_MALHA_UF, fMalha);
    const invertidos = corrigirOrientacao(malha);
    fs.writeFileSync(fMalha, JSON.stringify(malha));
    log.push(`malha das UFs baixada do IBGE (${invertidos} aneis reorientados)`);
  }
  if (force || !fs.existsSync(fUfs)) {
    await baixar(URL_UFS, fUfs);
    log.push('lista de UFs baixada do IBGE');
  }

  if (force || !fs.existsSync(fMun)) {
    const municipiosIbge = await baixar(URL_MUNICIPIOS, path.join(GEO_DIR, '_municipios-ibge.json'));
    const csv = await baixar(URL_COORDS, path.join(GEO_DIR, '_coords.csv'), { json: false });
    const coords = new Map();
    for (const r of csvLinhas(csv)) {
      const id = String(r.codigo_ibge || '').trim();
      const lat = Number(r.latitude);
      const lon = Number(r.longitude);
      if (id && Number.isFinite(lat) && Number.isFinite(lon)) coords.set(id, { lat, lon });
    }
    const ufs = JSON.parse(fs.readFileSync(fUfs, 'utf8'));
    const siglaPorId = new Map(ufs.map((u) => [String(u.id), u.sigla]));

    const municipios = municipiosIbge.map((m) => {
      const ufObj = m.microrregiao?.mesorregiao?.UF
        ?? m['regiao-imediata']?.['regiao-intermediaria']?.UF;
      const uf = ufObj?.sigla ?? siglaPorId.get(String(ufObj?.id)) ?? null;
      const c = coords.get(String(m.id)) || null;
      return {
        id: String(m.id),
        nome: m.nome,
        nome_norm: norm(m.nome),
        uf,
        lat: c?.lat ?? null,
        lon: c?.lon ?? null,
      };
    });
    fs.writeFileSync(fMun, JSON.stringify(municipios));
    const semCoord = municipios.filter((m) => m.lat === null).length;
    log.push(`${municipios.length} municipios do IBGE carregados; ${semCoord} sem coordenada`);
  }
  return log;
}

let _cacheMun = null;
export function carregarMunicipios() {
  if (_cacheMun) return _cacheMun;
  const f = path.join(GEO_DIR, 'municipios.json');
  if (!fs.existsSync(f)) throw new Error('Base de municipios ausente. Rode: npm run geo');
  const lista = JSON.parse(fs.readFileSync(f, 'utf8'));
  const porUf = new Map();
  for (const m of lista) {
    if (!porUf.has(m.uf)) porUf.set(m.uf, new Map());
    porUf.get(m.uf).set(m.nome_norm, m);
  }
  _cacheMun = { lista, porUf };
  return _cacheMun;
}

/**
 * Resolve cidade+UF do cadastro do ERP para um municipio oficial do IBGE.
 * Estrategia: exata -> variacoes de grafia -> similaridade (Levenshtein) dentro da UF.
 */
export function resolverMunicipio(cidadeRaw, ufRaw) {
  const uf = String(ufRaw ?? '').trim().toUpperCase();
  const alvo = norm(cidadeRaw);
  if (!uf || !alvo) return null;
  const { porUf } = carregarMunicipios();
  const mapa = porUf.get(uf);
  if (!mapa) return null;

  if (mapa.has(alvo)) return mapa.get(alvo);

  // grafias com apostrofo: "SANTA BARBARA D OESTE" x "SANTA BARBARA DOESTE"
  const variantes = new Set([
    alvo.replace(/\bD\s+/g, 'D'),
    alvo.replace(/\bD([AEIOU])/g, 'D $1'),
    alvo.replace(/\b(DO|DA|DE|DOS|DAS)\b/g, ' ').replace(/\s+/g, ' ').trim(),
    alvo.replace(/\bSAO\b/g, 'S').replace(/\s+/g, ' ').trim(),
    alvo.replace(/\s+(SP|RJ|MG|RS|SC|PR|BA|GO|DF|ES|MT|MS|PE|CE|PA|PB|RN|AL|SE|PI|MA|TO|RO|AC|AM|AP|RR)$/, ''),
  ]);
  for (const v of variantes) if (v && mapa.has(v)) return mapa.get(v);

  // similaridade dentro da mesma UF
  let melhor = null;
  let melhorDist = Infinity;
  for (const [nome, m] of mapa) {
    if (Math.abs(nome.length - alvo.length) > 3) continue;
    const d = levenshtein(nome, alvo);
    if (d < melhorDist) { melhorDist = d; melhor = m; }
  }
  const limite = alvo.length <= 6 ? 1 : 2;
  return melhorDist <= limite ? melhor : null;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

export const UFS_VALIDAS = new Set(
  'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' '),
);

export const NOME_UF = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapa', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceara',
  DF: 'Distrito Federal', ES: 'Espirito Santo', GO: 'Goias', MA: 'Maranhao',
  MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Para',
  PB: 'Paraiba', PR: 'Parana', PE: 'Pernambuco', PI: 'Piaui', RJ: 'Rio de Janeiro',
  RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondonia', RR: 'Roraima',
  SC: 'Santa Catarina', SP: 'Sao Paulo', SE: 'Sergipe', TO: 'Tocantins',
  EX: 'Exterior (exportacao)',
};

if (process.argv[1]?.endsWith('geo.js')) {
  const force = process.argv.includes('--force');
  prepararGeo({ force })
    .then((log) => {
      log.forEach((l) => console.log('  -', l));
      const { lista } = carregarMunicipios();
      console.log(`Base geografica pronta: ${lista.length} municipios.`);
    })
    .catch((e) => { console.error('ERRO geo:', e.message); process.exit(1); });
}
