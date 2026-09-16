/**
 * Estoque do ARMAZEM (OMS da TPL) -- a fonte de verdade de saldo do dashboard.
 *
 * Por que nao o Tiny (decisao do Leonardo, 16/09/2026): o saldo da conta B2B
 * carrega SKUs que o armazem nem conhece -- a geracao V1 do Running Fire tem
 * 268 un no Tiny e nao existe no OMS, e nenhum sync jamais a alcancou
 * justamente por isso. Somado a reversao do sync feita em 16/09, apenas 12 dos
 * 222 SKUs com saldo batiam entre os dois sistemas.
 *
 * CREDENCIAIS: ficam cifradas em `%USERPROFILE%\.claude-vault\tpl-oms.dpapi`,
 * que so este usuario do Windows decifra. Elas NAO sao copiadas para o .env --
 * abrir o DPAPI num subprocesso do PowerShell mantem a decisao de seguranca
 * original de pe. Sem Windows ou sem o arquivo, a etapa se desliga sozinha e o
 * dashboard segue com o ultimo saldo gravado.
 *
 * AUTH: o OMS emite um auth por HORA e recusa o segundo com "ja existe um auth
 * em uso". Por isso o cache em disco e compartilhado com o projeto
 * olist-integracao (mesmo caminho em %TEMP%): os dois processos reaproveitam o
 * mesmo token em vez de disputarem a cota.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db, upsertEstoqueOms } from './db.js';

const execFileP = promisify(execFile);

const BASE = 'https://oms.tpl.com.br/api';
const ARQ_DPAPI = path.join(os.homedir(), '.claude-vault', 'tpl-oms.dpapi');
const CACHE_AUTH = path.join(os.tmpdir(), 'tpl-oms-auth.json');

/** Ha credencial para consultar o OMS nesta maquina? */
export function estadoOms() {
  if (process.platform !== 'win32') {
    return { pronto: false, motivo: 'As credenciais do OMS usam DPAPI do Windows; nesta plataforma a etapa nao roda.' };
  }
  if (!fs.existsSync(ARQ_DPAPI)) {
    return { pronto: false, motivo: `Credencial do OMS nao encontrada em ${ARQ_DPAPI}.` };
  }
  return { pronto: true };
}

let credCache = null;

/** Abre o DPAPI via PowerShell e devolve as credenciais em memoria. */
async function credenciais() {
  if (credCache) return credCache;
  const est = estadoOms();
  if (!est.pronto) throw new Error(est.motivo);

  // Mesma sequencia do sync-estoque-tpl.cmd. A saida e so o JSON das chaves.
  const ps = [
    "$enc = Get-Content ($env:USERPROFILE + '\\.claude-vault\\tpl-oms.dpapi');",
    '$s = ConvertTo-SecureString $enc;',
    '$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);',
    '$j = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b);',
    '[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b);',
    'Write-Output $j',
  ].join(' ');

  const { stdout } = await execFileP('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { windowsHide: true, maxBuffer: 1 << 20 });

  const c = JSON.parse(stdout.trim());
  if (!c.TPL_OMS_APIKEY || !c.TPL_OMS_TOKEN || !c.TPL_OMS_EMAIL) {
    throw new Error('Credencial do OMS incompleta (faltam APIKEY/TOKEN/EMAIL).');
  }
  credCache = c;
  return c;
}

async function post(endpoint, payload) {
  const res = await fetch(`${BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const texto = await res.text();
  try {
    return JSON.parse(texto);
  } catch {
    throw new Error(`${endpoint}: resposta nao-JSON (HTTP ${res.status}): ${texto.slice(0, 200)}`);
  }
}

async function auth() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_AUTH, 'utf8'));
    if (c.auth && Date.now() - c.ts < 55 * 60_000) return c.auth;
  } catch { /* sem cache valido: pede um novo */ }

  const c = await credenciais();
  const r = await post('get/auth', {
    apikey: c.TPL_OMS_APIKEY, token: c.TPL_OMS_TOKEN, email: c.TPL_OMS_EMAIL,
  });
  // a documentacao chama de "auth", a API responde em "token"
  const a = r.auth ?? r.token;
  if (!a) {
    const msgs = {
      400: 'ja existe um auth em uso (o OMS libera um por hora)',
      402: 'dados invalidos',
      404: 'apikey/token nao identificados',
      500: 'cliente bloqueado',
    };
    throw new Error(`get/auth falhou (code ${r.code}): ${msgs[r.code] ?? JSON.stringify(r).slice(0, 200)}`);
  }
  try {
    fs.writeFileSync(CACHE_AUTH, JSON.stringify({ auth: a, id: r.id, ts: Date.now() }));
  } catch { /* cache e otimizacao, nao requisito */ }
  return a;
}

/** Saldo de todos os SKUs do armazem. */
export async function lerEstoqueOms() {
  const r = await post('get/products', { auth: await auth(), skus: [{ sku: '*' }] });
  if (r.code !== 200) throw new Error(`get/products falhou: code ${r.code}`);
  return r.stock ?? [];
}

/**
 * Regrava `estoque_oms`. So apaga o que havia DEPOIS de ter os dados novos em
 * maos: se a chamada falhar, o dashboard continua com o ultimo saldo bom em vez
 * de passar a dizer que nao ha estoque de nada.
 */
export async function sincronizarEstoqueOms() {
  const est = estadoOms();
  if (!est.pronto) {
    const n = db.prepare('SELECT COUNT(*) n FROM estoque_oms').get().n;
    return { ok: false, motivo: est.motivo, mantidos: n };
  }

  const itens = await lerEstoqueOms();
  if (!itens.length) throw new Error('OMS respondeu sem nenhum item; saldo anterior mantido.');

  const agora = new Date().toISOString();
  db.exec('DELETE FROM estoque_oms');
  for (const i of itens) {
    const sku = String(i.sku ?? '').trim();
    if (!sku) continue;
    upsertEstoqueOms.run(sku, i.descricao ?? '', i.ean ?? '', Number(i.amount ?? 0), agora);
  }

  const total = db.prepare('SELECT COUNT(*) n, SUM(saldo) un FROM estoque_oms').get();
  return { ok: true, skus: total.n, unidades: total.un ?? 0, quando: agora };
}
