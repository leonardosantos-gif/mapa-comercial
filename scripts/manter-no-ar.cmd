@echo off
REM Fiber - Mapa Comercial: garante o servidor no ar (porta 3110).
REM Idempotente; o log guarda apenas a ultima execucao.
set LOG=%~dp0manter-no-ar.log
echo [%DATE% %TIME%] > "%LOG%"
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0manter-no-ar.ps1" >> "%LOG%" 2>&1
