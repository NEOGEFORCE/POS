@echo off
REM ============================================================
REM  AUTO-INICIO INVISIBLE DE LA BALANZA (Y ACCESO POR RED)
REM  Ejecutar como Administrador UNA SOLA VEZ
REM ============================================================

echo.
echo ========================================================
echo   CONFIGURANDO AUTO-INICIO INVISIBLE DE LA BALANZA
echo ========================================================
echo.

REM 1. Detener y quitar servicio NSSM previo
echo [1/5] Limpiando servicio previo...
C:\Users\surti\Desktop\POS\nssm.exe stop scale-bridge-balanza 2>nul
C:\Users\surti\Desktop\POS\nssm.exe remove scale-bridge-balanza confirm 2>nul

REM 2. Cerrar cualquier instancia previa de node
echo [2/5] Liberando puerto COM...
taskkill /F /IM node.exe 2>nul

REM 3. Abrir puerto 9876 en el Firewall para que celulares/otros PCs por IP puedan leer la balanza
echo [3/5] Configurando regla de Firewall (puerto 9876)...
netsh advfirewall firewall delete rule name="Balanza_WebSocket_9876" 2>nul
netsh advfirewall firewall add rule name="Balanza_WebSocket_9876" dir=in action=allow protocol=TCP localport=9876

REM 4. Crear tarea programada para que arranque invisible al iniciar sesion
echo [4/5] Configurando auto-arranque con Windows...
schtasks /delete /tn "BalanzaAutostart" /f 2>nul
schtasks /create /tn "BalanzaAutostart" /tr "wscript.exe \"C:\Users\surti\Desktop\POS\lector-balanza-portatil\iniciar_oculto.vbs\"" /sc onlogon /rl highest /f

REM Tambien agregar al Startup folder para redundancia
copy /Y "C:\Users\surti\Desktop\POS\lector-balanza-portatil\iniciar_oculto.vbs" "C:\Users\surti\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\iniciar_balanza.vbs" 2>nul

REM 5. Iniciar ahora mismo en segundo plano invisible
echo [5/5] Iniciando balanza en segundo plano (invisible)...
wscript.exe "C:\Users\surti\Desktop\POS\lector-balanza-portatil\iniciar_oculto.vbs"

timeout /t 2 /nobreak >nul

echo.
echo ========================================================
echo   VERIFICACION
echo ========================================================
tasklist /FI "IMAGENAME eq node.exe"
echo.
echo ========================================================
echo   LISTO! La balanza ya esta corriendo en segundo plano:
echo   - 100%% invisible (sin ventana negra en pantalla)
echo   - Arrancara sola cada vez que enciendas el computador
echo   - Disponible por red para registrar desde tu celular
echo ========================================================
echo.
pause
