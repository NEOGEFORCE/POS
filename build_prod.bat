@echo off
echo ==============================================
echo        SISTEMA POS PRO - BUILD DE PRODUCCION
echo ==============================================
echo.

echo Compilando Frontend (Next.js)...
cd FrontPOS-main
call npm run build
if %ERRORLEVEL% neq 0 (
    echo ❌ ERROR EN LA COMPILACION DEL FRONTEND
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo Compilando Backend (Go)...
cd ../backPOS-go
go build -o server_prod.exe cmd/api/main.go
if %ERRORLEVEL% neq 0 (
    echo ❌ ERROR EN LA COMPILACION DEL BACKEND
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ==============================================
echo ✅ SISTEMA COMPILADO CON EXITO. Archivos listos para el PC de Produccion.
echo ==============================================
pause
