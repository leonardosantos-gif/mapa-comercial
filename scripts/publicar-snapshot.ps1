# Publica o dado do dia para quem recebeu o repositorio (hoje o Daniel).
#
# Atualizar o banco local NAO atualiza o que os outros veem: o dashboard deles
# le `data/snapshot/mapa-fiber.db`, que so muda com commit + push. Este script
# fecha esse ciclo.
#
# Ordem: garantir servidor -> sincronizar -> snapshot -> commit -> push.
#
# A sincronizacao e disparada DENTRO do servidor (`POST /api/admin/sync`) em vez
# de rodar `npm run sync` aqui. Sao dois escritores no mesmo SQLite se as duas
# coisas acontecerem juntas, e o ciclo automatico de 60 min pode disparar a
# qualquer momento.
#
#   powershell -File publicar-snapshot.ps1 [-Porta 3110] [-MinutosLimite 40] [-PularSync]

param(
  [int]    $Porta = 3110,
  [int]    $MinutosLimite = 40,
  [switch] $PularSync
)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$base = "http://localhost:$Porta"
function Agora { Get-Date -Format 'dd/MM/yyyy HH:mm:ss' }

Write-Output "===== $(Agora) ====="

# ---------------------------------------------------------- 1. servidor de pe
& (Join-Path $PSScriptRoot 'manter-no-ar.ps1') -Porta $Porta
if ($LASTEXITCODE -ne 0) {
  Write-Output "[$(Agora)] ABORTADO: servidor nao subiu."
  exit 1
}

function EstadoSync {
  try { return Invoke-RestMethod -Uri "$base/api/admin/status" -TimeoutSec 10 } catch { return $null }
}

# ------------------------------------------------------------ 2. sincronizar
if (-not $PularSync) {
  $st = EstadoSync
  if ($st -and $st.sync_em_andamento) {
    Write-Output "[$(Agora)] uma sincronizacao ja estava rodando; aguardando ela."
  } else {
    try {
      Invoke-RestMethod -Uri "$base/api/admin/sync" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 20 | Out-Null
      Write-Output "[$(Agora)] sincronizacao disparada."
    } catch {
      # 403 = ambiente sem credenciais (somente leitura). Nao e motivo para
      # abortar: da para publicar o que ja esta no banco.
      Write-Output "[$(Agora)] AVISO: nao foi possivel disparar o sync ($($_.Exception.Message)). Seguindo com o banco atual."
    }
  }

  $limite = (Get-Date).AddMinutes($MinutosLimite)
  while ((Get-Date) -lt $limite) {
    Start-Sleep -Seconds 15
    $st = EstadoSync
    if ($st -and -not $st.sync_em_andamento) { break }
  }

  $st = EstadoSync
  if ($st -and $st.sync_em_andamento) {
    Write-Output "[$(Agora)] ABORTADO: sync passou de $MinutosLimite min. Snapshot no meio da escrita nao vai para o git."
    exit 1
  }
  $r = $st.ultimo_resultado
  if ($r) {
    Write-Output "[$(Agora)] sync ok: $($r.base_planilha) lancamentos, $($r.pedidos_olist) pedidos, $($r.erros) erros."
    if ($r.reposicao -and $r.reposicao.ocs_erro) {
      Write-Output "[$(Agora)] AVISO: previsao de entrada desatualizada -- $($r.reposicao.ocs_erro)"
    }
  }
}

# --------------------------------------------------------------- 3. snapshot
Push-Location $raiz
try {
  $node = (Get-Command node).Source
  & $node (Join-Path $raiz 'src\snapshot.js')
  if ($LASTEXITCODE -ne 0) { throw "snapshot.js saiu com codigo $LASTEXITCODE" }

  # --------------------------------------------------------- 4. commit e push
  # `git diff --quiet` distingue "nada mudou" de "deu erro": sem isso, um dia
  # sem movimento viraria commit vazio ou erro no log, todo dia.
  & git add 'data/snapshot/mapa-fiber.db' | Out-Null
  & git diff --cached --quiet 'data/snapshot/mapa-fiber.db'
  if ($LASTEXITCODE -eq 0) {
    Write-Output "[$(Agora)] snapshot identico ao publicado; nada a enviar."
    exit 0
  }

  # Arquivo, nao `node -e`: ver o cabecalho de resumo-snapshot.js. Passar JS
  # pela linha de comando do PowerShell 5.1 perde aspas duplas e expande `${...}`.
  $resumo = (& $node (Join-Path $PSScriptRoot 'resumo-snapshot.js')) -join ''
  if (-not $resumo) { $resumo = 'conteudo nao lido' }

  $msg = @"
Atualiza snapshot dos dados ($(Get-Date -Format 'dd/MM/yyyy HH:mm'))

$resumo.

Publicado pela tarefa agendada "Fiber - Mapa Comercial publicar".

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
"@
  $msg | & git commit -F - | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "git commit falhou (codigo $LASTEXITCODE)" }

  # Sem prompt: se a credencial sumir, falha na hora e aparece no log, em vez de
  # travar a tarefa esperando uma senha que ninguem vai digitar.
  $env:GIT_TERMINAL_PROMPT = '0'
  # NADA de `2>&1` aqui. No Windows PowerShell 5.1 isso embrulha cada linha de
  # stderr de um executavel nativo num ErrorRecord; o git escreve o progresso do
  # push em stderr, entao um push BEM-SUCEDIDO virava erro fatal e a tarefa saia
  # com codigo 1. O .cmd que chama este script ja redireciona no nivel do shell,
  # onde isso e inofensivo -- a saida do git aparece no log do mesmo jeito.
  & git push origin main
  if ($LASTEXITCODE -ne 0) {
    Write-Output "[$(Agora)] ERRO no push. O commit esta local; rode 'git push' na mao."
    exit 1
  }
  Write-Output "[$(Agora)] publicado: $resumo"
} finally {
  Pop-Location
}
