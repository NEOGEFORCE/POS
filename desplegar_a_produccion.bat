@echo off
setlocal
if /I not "%~1"=="--confirm-deploy" (
    echo Despliegue cancelado.
    echo Use desplegar_a_produccion.bat --confirm-deploy despues de verificar respaldo, destino y ventana operativa.
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0desplegar_a_produccion.ps1" -ConfirmDeploy
exit /b %ERRORLEVEL%
