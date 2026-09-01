/**
 * Regras de negocio da Fiber para contagem de vendas.
 * Espelham as regras ja validadas no dashboard de vendas 2026 (olist-integracao).
 */
import { norm } from './geo.js';

const RE_ACENTOS = /[̀-ͯ]/g;

/** Clientes da conta MATRIZ que entram na analise comercial (o resto da Matriz e outro negocio). */
export const ALVO_MATRIZ = [
  { grupo: 'IGUASPORT', cnpj: '02.314.041/0001-88' },
  { grupo: 'IGUASPORT', cnpj: '02.314.041/0033-65' },
  { grupo: 'SBF', cnpj: '06.347.409/0296-51' },
  { grupo: 'SBF', cnpj: '06.347.409/0329-54' },
  { grupo: 'SBF', cnpj: '06.347.409/0154-30' },
  { grupo: 'SBF', cnpj: '06.347.409/0009-12' },
  { grupo: 'SBF', cnpj: '06.347.409/0026-13' },
  { grupo: 'LORENZO', cnpj: '60.161.620/0001-34' },
];

/** Situacoes que caracterizam pedido faturado (nao usar presenca de NF: existe "Faturado sem NF"). */
const SITUACOES_FATURADAS = new Set([
  'faturado', 'pronto para envio', 'enviado', 'entregue',
]);

export const ehFaturado = (situacao) =>
  SITUACOES_FATURADAS.has(String(situacao ?? '').trim().toLowerCase());

export const ehCancelado = (situacao) =>
  /cancelad/i.test(String(situacao ?? ''));

/**
 * Classifica a natureza de operacao.
 * VENDA        -> conta como venda
 * BONIFICACAO  -> amostra gratis / bonificacao (conta, mas separavel por filtro)
 * TRANSFERENCIA-> entre estabelecimentos do mesmo titular: NAO e venda
 * REMESSA      -> mudanca de endereco, eventos/feiras, consignacao, simples remessa: NAO e venda
 */
export function classificarNatureza(nomeNatureza) {
  const n = norm(nomeNatureza);
  if (!n) return 'INDEFINIDO';
  if (/TRANSFERENCIA/.test(n)) return 'TRANSFERENCIA';
  if (/AMOSTRA/.test(n)) return 'BONIFICACAO';
  if (/MUDANCA DE ENDERECO|EVENTOS|FEIRAS|CONSIGNACAO|SIMPLES REMESSA/.test(n)) return 'REMESSA';
  if (/^REMESSA/.test(n)) return 'REMESSA';
  if (/VENDA/.test(n)) return 'VENDA';
  return 'INDEFINIDO';
}

/** Razoes sociais internas da Fiber: pedido para si mesma nunca e venda. */
export function ehClienteInterno(nomeCliente, cnpj) {
  const n = norm(nomeCliente);
  const doc = String(cnpj ?? '').replace(/\D/g, '');
  if (doc.startsWith('26153970')) return true; // CNPJ raiz da Fiber Company
  return /^FIBER COMPANY/.test(n);
}

/**
 * Decide se o pedido entra nos numeros de venda.
 * Retorna { valido, motivo, tipo_operacao }.
 */
export function avaliarPedido({ situacao, natureza, cliente, cnpj }) {
  const tipo = classificarNatureza(natureza);
  if (ehClienteInterno(cliente, cnpj)) {
    return { valido: 0, motivo: 'cliente interno (Fiber)', tipo_operacao: tipo };
  }
  if (ehCancelado(situacao)) {
    return { valido: 0, motivo: 'pedido cancelado', tipo_operacao: tipo };
  }
  if (tipo === 'TRANSFERENCIA') {
    return { valido: 0, motivo: 'transferencia entre estabelecimentos', tipo_operacao: tipo };
  }
  if (tipo === 'REMESSA') {
    return { valido: 0, motivo: 'remessa (evento/consignacao/mudanca de endereco)', tipo_operacao: tipo };
  }
  return { valido: 1, motivo: null, tipo_operacao: tipo === 'INDEFINIDO' ? 'VENDA' : tipo };
}

/** Categoria/linha do produto a partir do SKU e da descricao. */
export function classificarProduto(sku, descricao) {
  const s = norm(sku);
  const d = norm(descricao);
  const t = `${s} ${d}`;

  // itens que nao sao produto de venda, mas aparecem em pedidos reais
  if (/^EXPO|EXPOSITOR|DISPLAY DE LOJA/.test(t)) return { categoria: 'Material de PDV', linha: 'Expositor' };
  if (/CAIXA CORRUGADA|EMBALAGEM|SLEEVE|ETIQUETA/.test(t)) return { categoria: 'Embalagem', linha: 'Embalagem' };

  if (/BYONIC|PUNHO|COTOVELO|JOELHO|TORNOZELO|ANTEBRACO|PANTURRILHA|ARMBND|COMPRESS/.test(t)) {
    return { categoria: 'Byonic', linha: 'Byonic' };
  }
  // grips e straps de treino (maior volume da carteira B2B)
  if (/GFPYTN|STRAP PYTHON/.test(t)) {
    return { categoria: 'Grips e Straps', linha: /CROSS|PYTHON X/.test(t) ? 'Strap Python X' : 'Strap Python' };
  }
  if (/OCMXGRIP|OCTO ?MAX ?GRIP|OCTO MAXGRIP/.test(t)) {
    return { categoria: 'Grips e Straps', linha: 'Octo Max Grip' };
  }
  if (/ARC[- ]?CLIP/.test(t)) return { categoria: 'Acessorios', linha: 'Arc Clip' };
  if (/ARMORBAG|ARMOR BAG|CAPA PARA MALA/.test(t)) return { categoria: 'Acessorios', linha: 'Armor Bag' };
  if (/BERMUDA|BPLY|BPNY/.test(t)) return { categoria: 'Vestuario', linha: 'Bermudas' };
  if (/SLIDE|CHINELO/.test(t)) return { categoria: 'Chinelos', linha: 'Slide Orbit' };
  if (/SAPATILHA|SFBM|SFBR/.test(t)) {
    if (/TRAINING|TFER/.test(t)) return { categoria: 'Sapatilhas', linha: 'Sapatilha Training' };
    if (/BALANCE/.test(t)) return { categoria: 'Sapatilhas', linha: 'Sapatilha Balance' };
    return { categoria: 'Sapatilhas', linha: 'Sapatilhas' };
  }
  if (/TENIS|TFBU|TFBRF|FBRFLY|BAREFOOT|RUNNING/.test(t)) {
    if (/FLY RECOVERY|FBRFLY/.test(t)) return { categoria: 'Tenis', linha: 'Fly Recovery' };
    if (/BAREFOOT ULTRA|TFBU/.test(t)) return { categoria: 'Tenis', linha: 'Barefoot Ultra' };
    if (/BAREFOOT FREE/.test(t)) return { categoria: 'Tenis', linha: 'Barefoot Free' };
    if (/RUNNING FIRE|TFBRF/.test(t)) return { categoria: 'Tenis', linha: 'Running Fire' };
    return { categoria: 'Tenis', linha: 'Tenis' };
  }
  if (/MEIA|SOCK/.test(t)) return { categoria: 'Acessorios', linha: 'Meias' };
  if (/PALMILHA|PAD PULSE|PADPLS|CALCANHEIRA/.test(t)) return { categoria: 'Acessorios', linha: 'Palmilhas/Pads' };
  if (/BOLSA|FITBAG|MOCHILA|NECESSAIRE/.test(t)) return { categoria: 'Acessorios', linha: 'Bolsas' };
  if (/OCULOS/.test(t)) return { categoria: 'Acessorios', linha: 'Oculos' };
  if (/AIRPACE|RESPIRATORIO/.test(t)) return { categoria: 'Acessorios', linha: 'Airpace' };
  if (/CAMISETA|SHORT|CALCA|CASACO|REGATA|TOP|LEGGING|BONE|VESTUARIO/.test(t)) {
    return { categoria: 'Vestuario', linha: 'Vestuario' };
  }
  return { categoria: 'Outros', linha: 'Outros' };
}

/**
 * Produto "pai": remove cor e tamanho da descricao da variacao para agrupar o ranking.
 * "Tenis Running Fire - 37 - Preto" -> "Tenis Running Fire"
 */
export function produtoPai(descricao) {
  const d = String(descricao ?? '').trim();
  if (!d) return d;
  const partes = d.split(/\s+-\s+/);
  // Atencao: norm() troca "/" e "-" por espaco, entao "40/41" chega como "40 41".
  const CORES = new Set(('PRETO PRETA BRANCO BRANCA BLACK ALLBLACK WHITE GREEN BLUE RED '
    + 'CINZA GRAY GREY AZUL VERDE VERMELHO VERMELHA ROSA PINK BEGE NUDE MARROM AMARELO '
    + 'AMARELA LARANJA ROXO ROXA LILAS LILAC CREAM CLEAN CLEAR NAVY GRAFITE CHUMBO MESCLA '
    + 'CORAL VINHO CARAMELO GOLD SILVER PRATA MULTI MAGENTA TRANSPARENTE PURPLE PURPURA '
    + 'ORANGE YELLOW BEIGE BROWN OLIVA LEMON SAND').split(' '));
  const MODIF = new Set(('ALL OFF FULL LIGHT DARK CLARO ESCURO E COM'.split(' ')));
  const TAMANHOS = new Set('PP P M G GG XG XGG U UNI UNICO UNIC'.split(' '));

  const ehVariacao = (p) => {
    const x = norm(p);
    if (!x) return true;
    // 37 | 40 41 (era "40/41") | 44 45 46 | 44 45 4 (descricao truncada no ERP)
    if (/^\d{2}(\s+\d{1,2})*$/.test(x)) return true;
    if (/^\d{2}\s+A\s+\d{2}$/.test(x)) return true;       // 36 a 39
    const tokens = x.split(' ');
    if (tokens.every((t) => TAMANHOS.has(t))) return true;
    // cor: todo token e cor ou modificador, com ao menos uma cor ("ALL BLACK", "GREEN BLACK")
    const soCorOuModif = tokens.every((t) => CORES.has(t) || MODIF.has(t));
    return soCorOuModif && tokens.some((t) => CORES.has(t));
  };
  while (partes.length > 1 && ehVariacao(partes[partes.length - 1])) partes.pop();

  // Parte do cadastro nao usa " - " e escreve cor/grade solta no fim
  // ("Sapatilha Fiber Training All Black 36/37"). Aqui a variacao e removida
  // token a token: primeiro a grade, depois o bloco de cor (que pode ter mais
  // de uma palavra, como "All Black").
  const ehTamanho = (t) => /^\d{2}(\s+\d{1,2})*$/.test(t) || TAMANHOS.has(t);
  const ehBlocoDeCor = (bloco) => {
    const tokens = norm(bloco).split(' ').filter(Boolean);
    return tokens.length > 0
      && tokens.every((t) => CORES.has(t) || MODIF.has(t))
      && tokens.some((t) => CORES.has(t));
  };
  const tokens = partes.join(' - ').trim().split(/\s+/);
  for (let guarda = 0; guarda < 8 && tokens.length > 1; guarda++) {
    if (ehTamanho(norm(tokens[tokens.length - 1]))) { tokens.pop(); continue; }
    let removeu = false;
    for (let k = Math.min(3, tokens.length - 1); k >= 1; k--) {
      if (ehBlocoDeCor(tokens.slice(-k).join(' '))) { tokens.splice(-k); removeu = true; break; }
    }
    if (!removeu) break;
  }
  return tituloCanonico(tokens.join(' ').replace(/\s+-\s*$/, '').trim());
}

/**
 * Caixa canonica do nome do produto. O ERP tem a mesma descricao gravada em
 * caixa alta e em caixa mista ("STRAP PYTHON FIBER" x "Strap Python Fiber");
 * sem isso o mesmo produto apareceria duas vezes no ranking.
 */
export function tituloCanonico(nome) {
  const s = String(nome ?? '').trim();
  if (!s) return s;
  const MINUSCULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'para', 'com', 'em', 'a', 'o']);
  const MAIUSCULAS = new Set(['pdv', 'pp', 'xg', 'xgg', 'gg', 'un', 'kit', 'x']);
  return s
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((tok) => {
      if (/^\s+$/.test(tok) || tok === '-') return tok;
      if (MAIUSCULAS.has(tok)) return tok.toUpperCase();
      if (MINUSCULAS.has(tok)) return tok;
      if (/\d/.test(tok)) return tok.toUpperCase();
      return tok.charAt(0).toUpperCase() + tok.slice(1);
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    // primeira palavra sempre com inicial maiuscula
    .replace(/^./, (c) => c.toUpperCase());
}

/** Padroniza o nome do representante (planilha e ERP escrevem diferente). */
const MAPA_REPRESENTANTE = new Map([
  ['LEO', 'Leonardo Cruz'],
  ['LEONARDO', 'Leonardo Cruz'],
  ['LEONARDO CRUZ', 'Leonardo Cruz'],
  ['THIAGO RAPPA', 'Thiago Rappa'],
  ['THIAGO', 'Thiago Rappa'],
  ['DANIEL SARTORI', 'Daniel Sartori'],
  ['DANIEL', 'Daniel Sartori'],
  ['FATIMA', 'Fatima'],
  ['LACERDA JR', 'Lacerda Jr'],
  ['LACERDA REP', 'Lacerda Jr'],
  ['LACERDA', 'Lacerda Jr'],
  ['KEY ACCOUNTS', 'Key Accounts'],
  ['DECATHLON', 'Key Accounts'],
  ['JOAO VITOR BONANNO', 'Joao Vitor Bonanno'],
  ['JOAO VITOR', 'Joao Vitor Bonanno'],
  ['CAROL', 'Carol'],
  ['ANGELA', 'Angela'],
  ['BERNARDO', 'Bernardo'],
]);

export function padronizarRepresentante(nome) {
  const n = norm(nome);
  if (!n) return null;
  if (MAPA_REPRESENTANTE.has(n)) return MAPA_REPRESENTANTE.get(n);

  const palavras = n.split(' ');
  // primeiro nome ("Thiago" -> Thiago Rappa)
  if (MAPA_REPRESENTANTE.has(palavras[0])) return MAPA_REPRESENTANTE.get(palavras[0]);
  // sobrenome isolado ("Rappa" / "Bonanno" -> nome completo canonico)
  for (const [chave, valor] of MAPA_REPRESENTANTE) {
    const partes = chave.split(' ');
    if (partes.length > 1 && palavras.length === 1 && partes.includes(palavras[0])) return valor;
  }
  // title case como fallback (preserva quem nao esta no mapa)
  return String(nome).trim().toLowerCase()
    .replace(/(^|\s|')\S/g, (c) => c.toUpperCase());
}

/** Padroniza nome de cliente para agrupar variacoes de digitacao. */
export function padronizarCliente(nome) {
  return String(nome ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*[-–]\s*$/, '');
}

/** Chave canonica de cliente: CNPJ raiz quando existir, senao nome normalizado. */
export function chaveCliente(nome, cnpj) {
  const doc = String(cnpj ?? '').replace(/\D/g, '');
  if (doc.length === 14) return `J:${doc}`;
  if (doc.length === 11) return `F:${doc}`;
  return `N:${norm(nome)}`;
}

/** Data dd/mm/aaaa -> ISO aaaa-mm-dd. */
export function dataIso(br) {
  const m = String(br ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Unifica nomes de produto que diferem apenas por acento/caixa
 * ("Tenis Barefoot Ultra Fiber" x "Tênis Barefoot Ultra Fiber").
 *
 * Nao inventa equivalencia: agrupa pela forma sem acento e adota como exibicao
 * a variante mais acentuada (a digitada corretamente). Nomes com palavras
 * diferentes continuam separados e viram alerta `sku_nomes_divergentes`.
 */
export function canonizarProdutos(db) {
  const atualizar = db.prepare('UPDATE itens SET produto = ? WHERE produto = ?');
  let unificados = 0;

  // ---- passo 1: variantes que diferem so por acento/caixa ----
  const nomes = db.prepare(
    "SELECT produto, COUNT(*) n FROM itens WHERE produto IS NOT NULL AND produto <> '' GROUP BY produto",
  ).all();
  const porNorm = new Map();
  for (const { produto, n } of nomes) {
    const chave = norm(produto);
    if (!porNorm.has(chave)) porNorm.set(chave, []);
    porNorm.get(chave).push({ produto, n });
  }
  const contarAcentos = (s) => (s.normalize('NFD').match(RE_ACENTOS) ?? []).length;
  for (const variantes of porNorm.values()) {
    if (variantes.length < 2) continue;
    const escolhido = variantes.slice().sort((a, b) =>
      contarAcentos(b.produto) - contarAcentos(a.produto) || b.n - a.n
      || a.produto.localeCompare(b.produto, 'pt-BR'))[0].produto;
    for (const v of variantes) {
      if (v.produto !== escolhido) { atualizar.run(escolhido, v.produto); unificados++; }
    }
  }

  // ---- passo 2: mesmo produto sob nomes diferentes, confirmado pelo SKU ----
  unificados += unificarPorFamiliaDeSku(db, atualizar);

  // ---- passo 3: mesmas palavras em outra ordem / sem espaco ----
  unificados += unificarPorReordenacao(db, atualizar);
  return unificados;
}

/**
 * Une nomes que sao o MESMO texto reescrito: mesmas palavras em outra ordem
 * ("Sapatilha Fiber Training" x "Sapatilha Training Fiber") ou apenas com espaco
 * diferente ("Octo MaxGrip" x "Octo Max Grip").
 *
 * Nao depende de SKU -- e o unico jeito de alcancar os itens lancados sem codigo --
 * e continua seguro porque exige equivalencia exata do conjunto de palavras (ou do
 * texto colado): nao funde nomes que tenham qualquer palavra a mais ou a menos.
 * Exibe o nome de maior valor vendido.
 */
function unificarPorReordenacao(db, atualizar) {
  const rows = db.prepare(`
    SELECT produto, SUM(valor) v FROM itens
     WHERE produto IS NOT NULL AND produto <> '' GROUP BY produto`).all();

  // Duas equivalencias independentes (palavras reordenadas OU texto colado igual),
  // unidas por union-find: quem casa por qualquer uma das duas cai no mesmo grupo.
  const pai = new Map(rows.map((r) => [r.produto, r.produto]));
  const raiz = (x) => { while (pai.get(x) !== x) x = pai.get(x); return x; };
  const unir = (a, b) => {
    const ra = raiz(a);
    const rb = raiz(b);
    if (ra !== rb) pai.set(ra, rb);
  };
  const primeiroCom = new Map();
  for (const r of rows) {
    const n = norm(r.produto);
    const chaves = [
      `P:${n.split(' ').filter(Boolean).sort().join(' ')}`,
      `C:${n.replace(/ /g, '')}`,
    ];
    for (const k of chaves) {
      if (primeiroCom.has(k)) unir(r.produto, primeiroCom.get(k));
      else primeiroCom.set(k, r.produto);
    }
  }

  const porGrupo = new Map();
  for (const r of rows) {
    const g = raiz(r.produto);
    if (!porGrupo.has(g)) porGrupo.set(g, []);
    porGrupo.get(g).push(r);
  }

  let unificados = 0;
  for (const lista of porGrupo.values()) {
    if (lista.length < 2) continue;
    const escolhido = lista.slice().sort((a, b) => b.v - a.v
      || a.produto.localeCompare(b.produto, 'pt-BR'))[0].produto;
    for (const r of lista) {
      if (r.produto !== escolhido) { atualizar.run(escolhido, r.produto); unificados++; }
    }
  }
  return unificados;
}

/**
 * Une nomes de produto que o ERP gravou de formas diferentes para a MESMA peca.
 *
 * O SKU e a chave confiavel: `SFBMUL-*` é sempre Sapatilha Training (a "V2" é a
 * grade nova) e `SFBMULC-*` é sempre Sapatilha Balance. Mas a familia do SKU
 * sozinha nao basta -- `FAIXA-*` cobre Pulso, Joelho e Cotovelo, `OCULOS-*` cobre
 * 14 modelos e `FB-*` mistura "Barefoot Free" com "Arc Clip". Entao exige-se
 * DUAS condicoes: mesma familia de SKU **e** um nome contido no outro
 * (mesmas palavras em outra ordem, ou um sendo extensao do outro).
 *
 * Exibe o nome mais curto (o do produto, sem sobra de cor/tamanho); empate
 * resolve pelo maior valor vendido.
 */
function unificarPorFamiliaDeSku(db, atualizar) {
  const rows = db.prepare(`
    SELECT sku, produto, SUM(valor) v FROM itens
     WHERE sku IS NOT NULL AND sku <> '' AND produto IS NOT NULL AND produto <> ''
     GROUP BY sku, produto`).all();

  // Segmento do SKU que distingue MODELO (nao cor/tamanho): entra na chave da
  // familia para nao juntar submodelos. Ex.: GFPYTN-CROSS-* e o "Strap Python X",
  // produto diferente do Strap Python comum, embora a familia base seja a mesma.
  const MARCADORES_SKU = new Set(['CROSS', 'X', 'PRO', 'PLUS', 'INF', 'INFANTIL', 'KIDS']);
  const familias = new Map();
  for (const r of rows) {
    const seg = String(r.sku).split('-');
    const base = seg[0].toUpperCase();
    const seg2 = (seg[1] ?? '').toUpperCase();
    const familia = MARCADORES_SKU.has(seg2) ? `${base}-${seg2}` : base;
    if (!familias.has(familia)) familias.set(familia, new Map());
    const m = familias.get(familia);
    m.set(r.produto, (m.get(r.produto) ?? 0) + r.v);
  }

  // Palavras que denotam submodelo/geracao: se a diferenca entre dois nomes inclui
  // uma delas, sao produtos distintos ("Strap Python" x "Strap Python X",
  // "Fly Recovery V4" x "V5", versao adulta x infantil).
  const MARCADORES_NOME = new Set(['X', 'CROSS', 'PRO', 'PLUS', 'INFANTIL', 'KIDS', 'JUNIOR']);
  const palavras = (s) => new Set(norm(s).split(' ').filter(Boolean));
  const colado = (s) => norm(s).replace(/ /g, '');
  const mesmoProduto = (a, b) => {
    const pa = palavras(a);
    const pb = palavras(b);
    const diferenca = [...pa].filter((w) => !pb.has(w)).concat([...pb].filter((w) => !pa.has(w)));
    if (diferenca.some((w) => MARCADORES_NOME.has(w) || /^V\d+$/.test(w))) return false;
    const contido = [...pa].every((w) => pb.has(w)) || [...pb].every((w) => pa.has(w));
    const ca = colado(a);
    const cb = colado(b);
    // "Octo Max Grip" x "Octo Maxgrip - Fiber Black Unico": tokens diferem, texto colado nao
    return contido || ca.startsWith(cb) || cb.startsWith(ca);
  };

  let unificados = 0;
  for (const mapaNomes of familias.values()) {
    const nomes = [...mapaNomes.keys()];
    if (nomes.length < 2) continue;

    // union-find sobre os nomes da familia
    const pai = new Map(nomes.map((n) => [n, n]));
    const raiz = (x) => { while (pai.get(x) !== x) x = pai.get(x); return x; };
    for (let i = 0; i < nomes.length; i++) {
      for (let j = i + 1; j < nomes.length; j++) {
        if (mesmoProduto(nomes[i], nomes[j])) {
          const ri = raiz(nomes[i]);
          const rj = raiz(nomes[j]);
          if (ri !== rj) pai.set(ri, rj);
        }
      }
    }

    const grupos = new Map();
    for (const n of nomes) {
      const r = raiz(n);
      if (!grupos.has(r)) grupos.set(r, []);
      grupos.get(r).push(n);
    }

    for (const grupo of grupos.values()) {
      if (grupo.length < 2) continue;
      const escolhido = grupo.slice().sort((a, b) =>
        palavras(a).size - palavras(b).size
        || (mapaNomes.get(b) ?? 0) - (mapaNomes.get(a) ?? 0)
        || a.localeCompare(b, 'pt-BR'))[0];
      for (const n of grupo) {
        if (n !== escolhido) { atualizar.run(escolhido, n); unificados++; }
      }
    }
  }
  return unificados;
}

export const MESES_PT = [
  'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];
