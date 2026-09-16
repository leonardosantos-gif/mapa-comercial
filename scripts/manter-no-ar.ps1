# Garante que o servidor do Mapa Comercial esteja no ar.
#
# Idempotente: se a porta ja responde, nao faz nada. Pode rodar no logon e de
# novo a cada hora sem risco de subir dois processos -- dois servidores no mesmo
# SQLite seria justamente o que este projeto evita.
#
# O servidor precisa ficar de pe por dois motivos alem do mapa em si:
#   - o ciclo de sincronizacao de 60 min vive DENTRO do processo;
#   - o refresh_token da Matriz dura 24 h e se renova a cada sync. Servidor
#     parado por mais de um dia = login manual de novo.
#
#   powershell -File manter-no-ar.ps1 [-Porta 3110] [-EsperaSegundos 90]

param(
  [int] $Porta = 3110,
  [int] $EsperaSegundos = 90
)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$carimbo = Get-Date -Format 'dd/MM/yyyy HH:mm:ss'

function Responde {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$Porta/api/resumo" -TimeoutSec 4 -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (Responde) {
  Write-Output "[$carimbo] ja estava no ar na porta $Porta."
  exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Output "[$carimbo] ERRO: node nao encontrado no PATH."
  exit 1
}

# `node server.js` em vez de `npm start`: o processo criado E o servidor, entao
# da para encontra-lo e derruba-lo pela porta. Com o npm no meio, matar o
# wrapper deixa o node orfao segurando a 3110 -- ja aconteceu.
Write-Output "[$carimbo] subindo o servidor..."
Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $raiz -WindowStyle Hidden

$limite = (Get-Date).AddSeconds($EsperaSegundos)
while ((Get-Date) -lt $limite) {
  Start-Sleep -Seconds 2
  if (Responde) {
    Write-Output "[$carimbo] no ar em http://localhost:$Porta"
    exit 0
  }
}

Write-Output "[$carimbo] ERRO: nao respondeu em $EsperaSegundos s."
exit 1
