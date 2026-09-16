@echo off
REM Fiber - Mapa Comercial: sincroniza e publica o snapshot no GitHub.
REM O log ACUMULA (append): serve para conferir dias anteriores.
set LOG=%~dp0publicar-snapshot.log
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0publicar-snapshot.ps1" >> "%LOG%" 2>&1
