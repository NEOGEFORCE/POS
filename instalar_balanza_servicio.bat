@echo off
REM ============================================================
REM  INSTALAR BALANZA COMO SERVICIO WINDOWS (NSSM)
REM  Ejecutar este .bat COMO ADMINISTRADOR en el PC de produccion
REM  Solo se necesita ejecutar UNA VEZ.
REM ============================================================

SET NSSM=C:\Users\surti\Desktop\POS\nssm.exe
SET SERVICE_NAME=scale-bridge-balanza
SET NODE_EXE=C:\Users\surti\Desktop\lector-balanza-portatil\node.exe
SET SCRIPT=C:\Users\surti\Desktop\lector-balanza-portatil\index.js
SET WORKDIR=C:\Users\surti\Desktop\lector-balanza-portatil

echo.
echo ========================================================
echo   INSTALANDO BALANZA COMO SERVICIO WINDOWS
echo ========================================================
echo.

REM Detener y eliminar servicio anterior si existe
echo [1/5] Limpiando instalacion anterior (si existe)...
%NSSM% stop %SERVICE_NAME% 2>nul
%NSSM% remove %SERVICE_NAME% confirm 2>nul

REM Instalar el servicio
echo [2/5] Instalando servicio "%SERVICE_NAME%"...
%NSSM% install %SERVICE_NAME% "%NODE_EXE%" "%SCRIPT%"

REM Configurar directorio de trabajo
echo [3/5] Configurando directorio de trabajo...
%NSSM% set %SERVICE_NAME% AppDirectory "%WORKDIR%"

REM Configurar nombre del servicio en Windows
%NSSM% set %SERVICE_NAME% DisplayName "Balanza Serial Bridge"
%NSSM% set %SERVICE_NAME% Description "Puente serial WebSocket para la balanza. Inicia automaticamente con Windows."

REM Configurar inicio automatico
echo [4/5] Configurando inicio automatico con Windows...
%NSSM% set %SERVICE_NAME% Start SERVICE_AUTO_START

REM Configurar reinicio automatico si falla (espera 3 segundos)
%NSSM% set %SERVICE_NAME% AppRestartDelay 3000

REM Iniciar el servicio ahora
echo [5/5] Iniciando el servicio...
%NSSM% start %SERVICE_NAME%

echo.
echo ========================================================
echo   VERIFICACION
echo ========================================================
%NSSM% status %SERVICE_NAME%
echo.
echo LISTO. La balanza ahora:
echo  - Esta corriendo en este momento
echo  - Arrancara AUTOMATICAMENTE cada vez que enciendas el PC
echo  - Si falla, se reinicia sola en 3 segundos
echo.
echo Para verificar: %NSSM% status scale-bridge-balanza
echo.
pause
