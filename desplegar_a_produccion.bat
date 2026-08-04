@echo off
echo ===================================================
echo 🚀 DESPLIEGUE COMPLETO A PRODUCCION (192.168.1.6)
echo ===================================================
echo.

echo 1. Compilando Backend Go (server.exe)...
cd /d "C:\Users\jaide\OneDrive\Desktop\POS\backPOS-go"
go build -o server.exe ./cmd/api

if %ERRORLEVEL% NEQ 0 (
    echo ❌ Error al compilar server.exe. Abortando.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo 2. Compilando Frontend (Next.js)...
cd /d "C:\Users\jaide\OneDrive\Desktop\POS\FrontPOS-main"
call npm run build

if %ERRORLEVEL% NEQ 0 (
    echo ❌ Error al compilar el frontend. Abortando.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo 3. Enviando server.exe y carpeta 'out' a \\192.168.1.6\pos...
copy /Y "C:\Users\jaide\OneDrive\Desktop\POS\backPOS-go\server.exe" "\\192.168.1.6\pos\server.exe"
xcopy /E /Y /I "C:\Users\jaide\OneDrive\Desktop\POS\backPOS-go\out" "\\192.168.1.6\pos\out"

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ===================================================
    echo ✅ ¡DESPLIEGUE COMPLETO EXITOSO A PRODUCCION!
    echo Backend (server.exe) y Frontend (out) actualizados
    echo en \\192.168.1.6\pos
    echo ===================================================
) else (
    echo.
    echo ⚠️ Intentando por nombre de equipo \\Desktop-gntmhfm\pos...
    copy /Y "C:\Users\jaide\OneDrive\Desktop\POS\backPOS-go\server.exe" "\\Desktop-gntmhfm\pos\server.exe"
    xcopy /E /Y /I "C:\Users\jaide\OneDrive\Desktop\POS\backPOS-go\out" "\\Desktop-gntmhfm\pos\out"
)

echo.
pause
