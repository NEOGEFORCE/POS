@echo off
if /I not "%~1"=="--confirm-update" (
    echo Operacion cancelada. Use actualizar.bat --confirm-update despues de verificar destino y respaldo.
    exit /b 1
)

echo ==========================================
echo    ACTUALIZANDO SERVIDOR POS PRO
echo ==========================================
taskkill /F /IM server.exe 2>nul
timeout /t 2 /nobreak >nul
if exist server_update.exe (
    copy /Y server_update.exe server.exe
    del server_update.exe
    echo Servidor actualizado exitosamente.
)
echo Iniciando servidor...
start server.exe
echo Servidor en ejecucion.
