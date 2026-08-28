@echo off
setlocal
cd /d "%~dp0"

echo [1/2] Compilando frontend...
pushd FrontPOS-main
call npm run build
if errorlevel 1 exit /b %ERRORLEVEL%
popd

echo [2/2] Compilando backend...
pushd backPOS-go
go build -trimpath -o server.exe ./cmd/api
if errorlevel 1 exit /b %ERRORLEVEL%
popd

echo Build local completado. No se copio ni reinicio produccion.
exit /b 0
