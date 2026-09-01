# Mapa Comercial Interativo · Fiber

Dashboard de concentração geográfica das vendas B2B da Fiber. Heat map do Brasil por
estado, drill-down até o produto comprado por cliente, com filtros combinados de
representante, cliente, período, estado e tipo de operação.

**Não há dado fictício em nenhuma tela.** Tudo vem de duas fontes reais:

| Fonte | Papel |
|---|---|
| **Planilha comercial publicada** ("PEDIDOS FIBER B2B") | **BASE.** Define quais pedidos existem, o valor e o mês de competência, o cliente e o representante. É a fonte mais atualizada e organizada. |
| **API v2 do Olist Tiny** (contas B2B e Matriz) | **Conferência e enriquecimento.** Cidade/UF (o que posiciona o mapa), CNPJ, SKU, quantidade, situação — e a comparação de valor pedido a pedido. |
| **IBGE** | malha das UFs (GeoJSON) e os 5.571 municípios com coordenadas |

---

## Subir

O repositório já vem com um **snapshot dos dados** (`data/snapshot/mapa-fiber.db`) e
com a **base geográfica do IBGE** (`data/geo/`). Quem só quer consultar não precisa de
credencial nenhuma:

```bash
npm install && npm start
```

Abre em <http://localhost:3110>. Na primeira execução o snapshot é copiado para o
banco de trabalho (`data/mapa-fiber.db`, fora do git) e o servidor entra em **modo
somente-leitura**: mostra todos os números, mas não consegue atualizá-los. É o modo
esperado para quem recebeu o repositório compartilhado.

Requisito: **Node.js 22.5 ou superior** (usa o SQLite nativo, `node:sqlite`). Confira
com `node -v`; se faltar, baixe em <https://nodejs.org>.

### Para manter os dados atualizados

Só quem tem as credenciais. Copie `.env.example` para `.env`, preencha `TINY_TOKEN`,
`TINY_TOKEN_MATRIZ` e `PLANILHA_PUB_ID`, e então:

```bash
npm run geo    # atualiza a base geográfica do IBGE (opcional: já vem no repo)
```

```bash
npm run sync   # carrega pedidos da API + planilha para o banco local
```

```bash
npm start      # http://localhost:3110
```

A sincronização também roda pela interface, em **Dados → Sincronizar dados agora**.

### Atualizar o snapshot que os outros veem

O banco de trabalho muda a cada hora e **não** vai para o git — se fosse versionado,
todo sync deixaria o `git status` sujo e o histórico ganharia alguns MB de binário por
commit. O que vai para o repositório é um snapshot explícito:

```bash
npm run snapshot
```

Gera `data/snapshot/mapa-fiber.db` com `VACUUM INTO` (consolida o WAL, desfragmenta, e
funciona com o servidor no ar). Depois:

```bash
git add data/snapshot/mapa-fiber.db && git commit -m "Atualiza snapshot dos dados"
```

Quem já clonou antes recebe o snapshot novo com `git pull`, mas o banco de trabalho
dele **não** é sobrescrito (a cópia só acontece quando não existe banco). Para forçar,
apague `data/mapa-fiber.db` e suba o servidor de novo.

### Atualização automática

Com o servidor no ar, o sync roda **a cada 60 min** sozinho (`SYNC_INTERVALO_MIN` no
`.env`; 0 desliga). Roda dentro do processo do servidor de propósito: uma Tarefa
Agendada externa gravaria no mesmo SQLite em paralelo com as consultas do dashboard —
aqui existe um único escritor, e um ciclo é pulado se o anterior ainda estiver rodando.
O próximo horário aparece em **Dados**.

Para evoluir as regras de classificação de produto sem refazer a coleta (nenhuma
chamada à API):

```bash
node src/reclassificar.js
```

---

## Como os números são calculados

A unidade de contagem é a **linha da planilha** (um lançamento comercial). O valor é o
`VALOR` da planilha e o mês de competência é o da aba mensal — é o que faz o dashboard
fechar com o número que o comercial divulga.

### Quais linhas formam a base

As abas se sobrepõem, então somar todas contaria em dobro (167 das 239 linhas de status
repetem pedidos das abas mensais — R$ 1,5 milhão duplicado). A regra tem duas partes:

1. **Abas mensais são o livro-caixa.** Todas as suas linhas entram.
2. **Abas de status** (PEDIDOS FATURADOS / EM ABERTO / CANCELADOS / REPS) entram só com
   pedidos que não estão em nenhuma aba mensal **e** cujo mês não tem aba mensal — mês
   com aba é mês fechado. É o que cobre janeiro/fevereiro e 2025 sem inflar os meses já
   fechados.

Referência de pedido composta é tratada: `127-3` é o pedido 127 remessa 3, `75 / 196` é
uma NF cobrindo dois pedidos. Linhas assim ficam marcadas como parciais e não entram na
comparação de valor com o ERP.

### Regras de contagem

- **Cancelados** não contam como venda (aba PEDIDOS CANCELADOS ou situação cancelada no
  ERP). Ficam visíveis em *Alertas → Pedidos fora da contagem*.
- **Faturado** = situação em `Faturado`, `Pronto para envio`, `Enviado`, `Entregue`
  (não pela presença de NF — existe "Faturado sem NF").
- **Atribuição de valor por produto**: os itens vêm do Olist e são reescalados para
  fechar com o `VALOR` da planilha, para o ranking de produtos somar o mesmo que os KPIs.
- **Representante**: ajuste manual > coluna VENDEDOR da planilha > vendedor do ERP.
- **Exportação** aparece como `Exterior (exportação)` no ranking: é venda real, entra nos
  KPIs, mas não tem área no mapa do Brasil. O KPI de Cidades mostra quanto valor está
  fora do mapa, para o total e o mapa nunca parecerem discordar.

### Conferência com o total declarado

**Dados → Conferência: planilha × consolidado** compara o total do topo de cada aba
mensal com o consolidado. Hoje 4 dos 6 meses batem ao centavo. Maio (+8.903,68) e Junho
(−3.049,20) divergem porque **a própria planilha não fecha** nessas abas: o total do topo
não é igual à soma das suas linhas. O dashboard reproduz as linhas — a divergência é
exibida, não corrigida em silêncio.

### O que fica fora dos números

- Pedidos faturados no Olist que a planilha não lista (*Alertas → No Olist, ausente na
  planilha*): não entram, porque a planilha é a base.
- Linhas da planilha cujo pedido não existe no Olist (*Alertas → Na planilha, ausente no
  Olist*): entram no valor, mas sem cidade, SKU nem quantidade.

---

## Unificação com o Cockpit Comercial

Os KPIs executivos do **Cockpit Comercial B2B**
(`github.com/rafaeltondin/cockpit-comercial-fiber`) foram recriados aqui, com as
fórmulas originais, mas calculados sobre a base deste projeto. O Cockpit deixa de ser
um app separado.

| Aba nova | O que traz do Cockpit |
|---|---|
| **Vendas** | faturado no período, pedidos em aberto, média mensal, mês em curso / último fechado, clientes novos, cadastro → faturamento (dias), evolução mensal e **comparativo YoY** (3 anos) |
| **Carteira** | concentração (Top 5/10/20, clientes para 80%, **índice HHI**, recorrentes), curva de Pareto e **recência**: ativos / em risco / dormentes / compra única |
| **Prospecção** | campanhas da aba LEADS — enviados, entregues, falhas, retornos, taxa de resposta, vendas atribuídas, por canal e por segmento — e as **amostras** da aba AMOSTRAS |

Fórmulas mantidas iguais às do Cockpit:

- `share(n)` = soma dos n maiores clientes / total; `clientes p/ 80%` = quantos
  acumulam 80% da receita; **HHI** = soma dos quadrados das participações em pontos
  percentuais (0–10.000; acima de 2.500 = concentração alta).
- **Recência** medida contra o **último mês fechado**: comprou nele ou depois = ativo;
  1 a 2 meses sem comprar = em risco; 3+ = dormente.
- **YoY** vem das colunas `2024 | 2025 | 2026` da linha "Mês referência" no topo das abas
  mensais — os anos anteriores não existem como lançamento, só nesse cabeçalho.
  Conferido: agosto dá +16,4%, o mesmo que a coluna "Crescimento" da planilha.

**O que NÃO foi trazido:** Descontinuados/Ofensores (a pedido) e a aba Insights, que
segue oculta junto com os Alertas.

**Os números mudam em relação ao Cockpit** — e é esperado. O Cockpit usava seed próprio
e separava faturado × aberto sobre um universo menor (149 pedidos, 61 clientes ativos,
R$ 2.019.942). Aqui a base é a planilha inteira com o mês da aba mensal: R$ 2.235.378
lançados, dos quais R$ 1.795.916 faturados em 194 pedidos e 71 clientes.

Duas fontes novas ficam em tabelas próprias, **fora do faturamento**: `amostras` (aba
AMOSTRAS — brindes não são venda) e `leads` (aba LEADS). Elas só respeitam o filtro de
período, porque não têm representante/UF/cliente dos pedidos.

---

## Ajustes de carteira (representante por cliente)

O representante vem da coluna VENDEDOR da planilha (e, na falta dela, do vendedor do
ERP). Quando a carteira troca de dono e a planilha ainda não reflete isso, edite
`config/representante-por-cliente.json`:

```json
{
  "cnpj": "40.192.126/0001-20",
  "cliente": "JACK HOPS & CO LTDA",
  "representante": "Leonardo Cruz",
  "definido_em": "2026-08-31",
  "obs": "reatribuição de carteira"
}
```

Precedência: **ajuste > planilha > vendedor do ERP**. Vale para todos os pedidos do
cliente, inclusive os históricos, e sobrevive à sincronização — editar direto no banco
seria desfeito, porque o sync reconstrói a tabela de fatos. O casamento é por CNPJ
(preferido) ou pelo nome do cliente.

Os ajustes ativos aparecem em **Dados → Ajustes de carteira**, e as colunas
`vendedor_sheet` / `vendedor_tiny` continuam gravadas no banco — sempre dá para ver o
valor original ao lado do ajustado.

---
## Produto -> grade de SKUs (projeção de venda e compra)

Na tela **Produtos**, clique numa linha (ou numa barra do ranking, no dashboard) para
abrir a grade do produto:

- **Curva de grade**: quanto cada SKU representa da quantidade do produto — é o número
  que orienta a compra. Ex.: Sapatilha Training = 36/37 16,3% · 38/39 16,0% ·
  40/41 15,7% · 34/35 8,5% · 42/43 8,5% · 44/45/46 3,2%.
- Ordenação por **maior/menor quantidade** e maior/menor faturamento — o menor isola
  os SKUs de giro baixo.
- Preço médio por SKU, pedidos, clientes e **última venda** (giro parado).
- **Evolução mensal** do produto, para ver se a participação da grade está mudando.
- **Quem compra** (clicável, abre o cliente) e distribuição por estado.
- **SKUs sem venda no filtro atual** que já venderam antes — a lista de atenção na
  reposição.

Endpoint: `GET /api/produto-detalhe?produto=<nome>` (aceita os mesmos filtros).
O nome do produto vai por query string porque pode conter acento e barra.

---
## Ranking de produtos: agrupamento

O ERP grava a mesma peça com descrições diferentes. O tratamento é conservador:

- a descrição da variação perde cor e grade para formar o **produto-pai**
  ("Tênis Running Fire - 37 - Preto" → "Tênis Running Fire");
- nomes que diferem só por **acento ou caixa** são unificados, adotando a variante
  acentuada ("TENIS BAREFOOT ULTRA" → "Tênis Barefoot Ultra Fiber");
- nomes que diferem em **palavras** NÃO são unificados por conta própria (ex.
  "Sapatilha Training Fiber" × "Sapatilha Fiber Training"). Eles aparecem separados e,
  quando compartilham o mesmo SKU, viram o alerta *SKU com nomes diferentes no ERP* —
  a correção é no cadastro, não no dashboard.

Use **Por SKU** na tela de Produtos para ver a variação exata, sem agrupamento.

## Alertas de dados

> **A aba "Alertas" está oculta no menu** (escolha do usuário). A apuração continua
> rodando normalmente: os endpoints `/api/alertas` e `/api/excluidos` respondem, e a
> conferência mensal segue em *Dados*. Para trazer a aba de volta, troque
> `MOSTRAR_ALERTAS` para `true` no topo de `public/app.js` — nada mais precisa mudar.

| Alerta | O que indica |
|---|---|
| Na planilha, ausente no Olist | linha da planilha sem pedido correspondente no ERP — entra no valor, mas sem cidade, SKU nem quantidade |
| No Olist, ausente na planilha | pedido faturado no ERP que a planilha não lista — fica **fora** dos números |
| Sem cidade/UF (fora do mapa) | cadastro do cliente incompleto no ERP (exportação não conta aqui) |
| Linha sem número de pedido | não dá para conferir no Olist |
| Pedidos sem representante | ausente na planilha, no ERP e nos ajustes |
| Divergência de valor | planilha × Olist no mesmo pedido (remessas parciais ficam de fora) |
| Divergência do total do mês | total declarado no topo da aba × consolidado |
| Itens sem SKU | item lançado sem código |
| SKU com nomes diferentes no ERP | mesma peça com descrições distintas — fragmenta o ranking |

## Armadilhas do mapa (nao repetir)

**1. Orientacao dos aneis do GeoJSON.** A malha do IBGE chega com o anel externo
anti-horario (RFC 7946). O **d3-geo espera o inverso** (horario) porque trabalha em
geometria esferica: com a orientacao errada ele le cada estado como "todo o globo
menos esta area". Sintomas medidos: `geoBounds(SP)` = [[-180,-90],[180,90]],
`geoArea(SP)` = 25,13 sr (o dobro da esfera), `path.bounds`/`centroid` iguais para
todas as UFs (zoom sem efeito, rotulos empilhados) e cada estado pintado como o
COMPLEMENTO da sua area -- 27 retangulos sobrepostos no lugar do mapa. O `d` do path
sai correto mesmo assim, entao o bug passa por qualquer conferencia que olhe so cor e
contagem. `corrigirOrientacao()` em `src/geo.js` reorienta ao cachear a malha; apos a
correcao `geoArea(SP)` = 0,00613 sr = 248.800 km², a area real de Sao Paulo.

**2. Cache da malha.** Um `Cache-Control: max-age` longo em `/api/geo/estados' faz o
navegador continuar usando a malha antiga depois de corrigida -- isso mascarou a
correcao acima. Hoje o endpoint responde com `must-revalidate` + ETag e o `mapa.js`
busca com `cache: 'no-cache'`.

**3. Tudo que é visual precisa dividir pelo zoom.** Rótulos, traços e **raio das
bolhas** ficam dentro do `<g>` que recebe o transform do zoom, então crescem junto: com
raio 26 e zoom 6× a bolha virava ~150px de raio na tela. A faixa de raio é definida em
**pixels de tela** e dividida por `k` no desenho (`escalarRotulos`), assim a bolha tem o
mesmo tamanho em qualquer zoom — medido: zoom 38,85× → raio 0,498 no viewBox = 19,3px na
tela.

**3b. A colisão das bolhas usa a escala de DESTINO, não a atual.** Ao abrir um estado,
`focar()` ainda está animando e o zoom corrente é 1; calcular a separação com esse valor
dá raios enormes em unidades do viewBox e empurra as bolhas longe da cidade real (SP tem
só ~86 unidades de largura). Usando `escalaAlvo(uf)`, o deslocamento médio caiu para
0,3% da largura do estado.

**4. Atributo `hidden` vs `display`.** `.gaveta` (flex) e `.mapa-vazio` (grid) ficavam
visiveis apesar de `[hidden]`, porque regra de `display` do autor vence o UA. O CSS tem
`[hidden] { display: none !important }` no topo.

---
## Geolocalização

Cidade e UF vêm do cadastro do cliente no pedido e são resolvidas contra a lista
oficial de municípios do IBGE (nome exato → variações de grafia → similaridade dentro
da UF). Coordenada nenhuma é digitada à mão. O que não resolve vira alerta em
**Alertas → Cidades fora da base do IBGE**, com o pedido e o valor envolvido.

---

## Performance

- Os dados são processados no sync e gravados em SQLite (`data/mapa-fiber.db`);
  **nenhuma requisição do usuário chama a API do Tiny**.
- Carga por nível, sob demanda: `/api/estados` → `/api/cidades?uf=` →
  `/api/clientes?municipio=` → `/api/cliente/:chave`.
- `/api/dashboard` devolve KPIs + estados + meses + representantes + top produtos em
  uma chamada só.
- Cache em memória de 60 s por combinação de filtros; tabelas grandes paginadas.
- **Sync incremental**: pedido cuja assinatura (`situação|valor`) não mudou não gera
  nova chamada de detalhe. Use *Recarregar tudo* para ignorar o cache.
  Medido nesta base: sync completo ≈ 430 chamadas / ~7 min; sync incremental
  **22 chamadas / 80 s** com 405 dos 406 pedidos vindos do cache.
- A busca de pedidos é fatiada por ano — a API v2 derruba a consulta em janelas longas
  ("Ocorreu um erro ao executar a consulta"), sobretudo na conta Matriz.

---

## Segurança

Os tokens ficam só no `.env`, lido pelo backend. O frontend nunca recebe credencial:
consome exclusivamente os endpoints agregados.

O `.env` **não vai para o repositório**, e não deve ir. Um token do Tiny commitado
fica no histórico do git para sempre — um commit posterior removendo o arquivo não
apaga o blob, e a v2 da API permite escrita (criar pedido, alterar cadastro), não só
leitura. Para dar acesso a alguém, mande o `.env` por canal privado (gerenciador de
senhas, mensagem direta) em vez de versionar.

O que **vai** para o repositório é o snapshot do banco — números de venda, nomes de
cliente, CNPJ e representante, sem nenhuma credencial. É dado comercial interno: o
repositório precisa continuar **privado**.

---

## Estrutura

```
server.js              API + estáticos
src/tiny.js            cliente da API v2 (fila, throttle, retry, log de erro)
src/geo.js             IBGE: malha das UFs, municípios, resolução cidade→coordenada
src/regras.js          regras de negócio (natureza, exclusões, produto, representante)
src/planilha.js        leitura da planilha publicada (abas descobertas automaticamente)
src/db.js              schema SQLite
src/sync.js            orquestração das fontes + conciliação + alertas
src/agregados.js       consultas agregadas com filtros combinados
src/comercial.js       KPIs do Cockpit (concentração, carteira, amostras, prospecção)
src/ajustes.js         reatribuição de representante por cliente (config/)
src/reclassificar.js   recalcula categoria/produto dos itens sem tocar na API
src/snapshot.js        gera o snapshot do banco que vai para o repositório
public/                frontend (index.html, styles.css, app.js, mapa.js, d3 local)
data/                  banco de trabalho (fora do git)
data/snapshot/         snapshot versionado: o que quem clona vê
data/geo/              base geográfica do IBGE (versionada)
logs/                  erros de API e saída dos syncs
```

## Endpoints

| Rota | Uso |
|---|---|
| `GET /api/dashboard` | KPIs, estados, meses, representantes, top produtos |
| `GET /api/estados` | agregado por UF (heat map + ranking) |
| `GET /api/cidades?uf=` | agregado por município (bolhas do mapa + cidades dentro de Estados) |
| `GET /api/clientes?municipio=` | clientes da cidade |
| `GET /api/cliente/:chave` | cabeçalho, produtos, pedidos e série mensal do cliente |
| `GET /api/produtos?nivel=produto\|sku` | ranking de produtos |
| `GET /api/representantes` | performance por representante |
| `GET /api/concentracao` | share % por UF por mês |
| `GET /api/alertas`, `/api/excluidos` | qualidade de dados |
| `GET /api/admin/status`, `/api/admin/conexao` | estado da sincronização |
| `POST /api/admin/sync` | sincronizar (`{"full":true}` ignora o cache) |

Todos aceitam os mesmos filtros: `rep`, `cliente`, `uf`, `municipio`, `meses`,
`de`, `ate`, `tipo`, `produto`, `sku`, `busca`.
