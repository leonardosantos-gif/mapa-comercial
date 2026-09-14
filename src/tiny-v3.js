/**
 * Cliente da API v3 do Olist Tiny para a conta MATRIZ.
 *
 * Por que so a Matriz: as ordens de compra existem apenas nessa conta, e apenas
 * na v3 -- a v2 nao tem endpoint de OC. O app OAuth e por conta ("ocs fiber",
 * redirect na porta 8765), entao renovar um token da Matriz com o client do B2B
 * responde "Token client and authorized client don't match".
 *
 * O LOGIN nao acontece aqui. Quem emite o token e o projeto `olist-integracao`
 * (`node src/v3-auth-matriz.mjs`), que sobe o servidor local do callback. Este
 * modulo apenas LE esse arquivo de tokens e renova o access_token enquanto o
 * refresh_token valer -- o refresh da Matriz dura 24 h, entao o login precisa
 * ser refeito com alguma frequencia.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TOKEN_URL = 'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token';
const API_BASE = process.env.TINY_V3_API_BASE || 'https://api.tiny.com.br/public-api/v3';

const CLIENT_ID = process.env.TINY_V3_CLIENT_ID_MATRIZ;
const CLIENT_SECRET = process.env.TINY_V3_CLIENT_SECRET_MATRIZ;

/** Arquivo de tokens da Matriz. Por padrao, o do projeto olist-integracao. */
export const TOKENS_FILE =
  process.env.TINY_V3_TOKENS_MATRIZ ||
  path.join(os.homedir(), 'olist-integracao', 'v3-tokens.matriz.json');

const b64 = (s) => Buffer.from(s).toString('base64');
const basicAuth = () => `Basic ${b64(`${CLIENT_ID}:${CLIENT_SECRET}`)}`;

function carregar() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function salvar(data, anterior) {
  const payload = {
    access_token: data.access_token,
    // o Keycloak nem sempre devolve refresh_token na renovacao
    refresh_token: data.refresh_token ?? anterior?.refresh_token,
    expires_at: Date.now() + Number(data.expires_in ?? 0) * 1000,
    refresh_expires_at: Date.now() + Number(data.refresh_expires_in ?? 0) * 1000,
    obtained_at: Date.now(),
  };
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(payload, null, 1));
  } catch { /* melhor seguir com o token em memoria do que falhar a etapa */ }
  return payload;
}

let tokens = carregar();

/**
 * Diagnostico da credencial v3, sem fazer chamada de rede.
 * `pronto` false explica por que -- e a mensagem vai para a tela de Dados.
 */
export function estadoV3() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return { pronto: false, motivo: 'Faltam TINY_V3_CLIENT_ID_MATRIZ / TINY_V3_CLIENT_SECRET_MATRIZ no .env.' };
  }
  const t = tokens ?? carregar();
  if (!t) {
    return { pronto: false, motivo: `Sem arquivo de tokens (${TOKENS_FILE}). Rode "node src/v3-auth-matriz.mjs" em olist-integracao.` };
  }
  if (t.refresh_expires_at && Date.now() >= t.refresh_expires_at) {
    return {
      pronto: false,
      expirado_em: new Date(t.refresh_expires_at).toISOString(),
      motivo: 'O refresh_token da Matriz venceu (dura 24 h). Refaca o login: "node src/v3-auth-matriz.mjs" em olist-integracao.',
    };
  }
  return { pronto: true, expira_em: t.refresh_expires_at ? new Date(t.refresh_expires_at).toISOString() : null };
}

async function renovar() {
  const atual = tokens ?? carregar();
  if (!atual?.refresh_token) throw new Error('Sem refresh_token da Matriz. Refaca o login em olist-integracao.');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: atual.refresh_token,
      client_id: CLIENT_ID,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Falha ao renovar o token da Matriz (HTTP ${res.status}). Refaca o login: "node src/v3-auth-matriz.mjs".`);
  }
  tokens = salvar(json, atual);
  return tokens.access_token;
}

async function accessToken() {
  tokens = tokens ?? carregar();
  const est = estadoV3();
  if (!est.pronto) throw new Error(est.motivo);
  if (!tokens.access_token || Date.now() >= tokens.expires_at - 60_000) return renovar();
  return tokens.access_token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET na v3 com backoff. A v3 devolve 429 com facilidade quando se percorre
 * `/ordem-compra/{id}` em serie.
 */
export async function getV3(caminho, tentativas = 5) {
  let espera = 1500;
  let ultimo;
  for (let t = 0; t < tentativas; t++) {
    const token = await accessToken();
    const res = await fetch(`${API_BASE}${caminho}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (res.ok) return res.json();
    ultimo = `HTTP ${res.status}`;
    if (res.status === 429 || res.status >= 500) {
      await sleep(espera);
      espera = Math.min(espera * 2, 20_000);
      continue;
    }
    if (res.status === 401) {
      await renovar();
      continue;
    }
    throw new Error(`${caminho} -> ${ultimo}`);
  }
  throw new Error(`${caminho} -> ${ultimo} apos ${tentativas} tentativas`);
}
