# Operación segura del POS

Estos scripts preparan una operación reproducible, pero **no autorizan ni ejecutan automáticamente un despliegue**. Deben usarse durante una ventana aprobada, con acceso al equipo destino y un operador responsable.

## Build local

```bat
build_prod.bat
```

Genera `backPOS-go/server.exe` y el export estático del frontend. No copia archivos ni reinicia servicios.

## Respaldo verificable

Requiere `POS_DB_PASSWORD`; opcionalmente acepta `POS_BACKUP_ROOT`, `POS_PG_DUMP`, `DB_HOST`, `DB_USER` y `DB_NAME`.

```powershell
.\hacer_respaldo.ps1 -ProductionShare "\\DESKTOP-VK2U90S\Users\surti\Desktop\POS"
```

El respaldo excluye `.env*`, llaves y certificados; falla si `robocopy` o `pg_dump` fallan y genera `manifest.json` con SHA-256.

### Respaldo exclusivo de PostgreSQL

`respaldar_base_datos.ps1` no copia código ni archivos de producción. Requiere `DB_HOST`, `DB_USER`, `DB_NAME` y `POS_DB_PASSWORD`; acepta `DB_PORT` y las rutas `POS_PG_DUMP`, `POS_PG_RESTORE` y `POS_DB_BACKUP_ROOT`.

```powershell
.\respaldar_base_datos.ps1 -ConfirmBackup
```

Genera un dump PostgreSQL `custom`, lo valida con `pg_restore --list`, conserva el catálogo de restauración y crea `manifest.json` con tamaño y SHA-256. La contraseña viaja únicamente en `PGPASSWORD` durante el proceso y se restaura/elimina al finalizar; nunca se incluye en argumentos, logs o manifest. Por defecto conserva los últimos 14 respaldos de la base.

### Migración automática de todas las pendientes

El API debe estar detenido y el operador debe escribir exactamente el destino esperado. El script crea primero el respaldo DB-only anterior, valida `go test ./migrations`, consulta el estado, ejecuta todo el catálogo pendiente mediante el runner canónico y vuelve a consultar el estado.

```powershell
.\migrar_base_datos.ps1 `
  -ConfirmMigrate `
  -ConfirmServiceStopped `
  -ExpectedTarget "<host>:5432/<base>"
```

El comando interno de mutación es `go run ./cmd/migrate up --confirm --timeout=30m`; no aplica semillas. Si cualquier paso falla, se detiene, conserva el respaldo verificado y deja un log dentro de su carpeta. No restaura automáticamente porque una restauración sobrescribe datos y requiere una decisión operativa separada.

Estos dos scripts no forman parte del arranque del API ni del despliegue automático. Sólo deben ejecutarse en una ventana aprobada, después de verificar las variables de entorno y el destino mostrado.

## Servicio NSSM

Ejecutar una sola vez **en el PC de producción**, desde una consola administrativa:

```powershell
.\instalar_pos_service.ps1 -ConfirmInstall
```

Configura `POS_Server` con directorio de trabajo, arranque automático, reinicio tras fallo, demora de 5 segundos y rotación de logs de 10 MB. Revisar después:

```powershell
.\nssm.exe status POS_Server
Get-Content .\logs\server-err.log -Tail 100
```

La instalación real del servicio, sus credenciales y las pruebas de caída controlada requieren una ventana operativa; no se realizan durante builds o tests.

## Despliegue con rollback

El wrapper cancela si no recibe confirmación:

```bat
desplegar_a_produccion.bat --confirm-deploy
```

Flujo del runner PowerShell:

1. Verifica rutas, share y NSSM.
2. Ejecuta respaldo completo y comprobable.
3. Ejecuta tests, vet, estado de migraciones en modo lectura, pruebas frontend, tipos y build.
4. Copia a `.deploy-staging` y compara SHA-256 del servidor.
5. Detiene `POS_Server` mediante PowerShell Remoting.
6. Conserva servidor y frontend anteriores bajo `.rollback/<timestamp>`.
7. Activa artefactos staged y arranca NSSM.
8. Reintenta el healthcheck hasta cinco veces.
9. Si falla, restaura automáticamente el release anterior y vuelve a iniciar el servicio.

Parámetros como share, equipo, servicio y health URL se pueden sobrescribir al invocar directamente `desplegar_a_produccion.ps1`.

## Migraciones

El despliegue sólo ejecuta `migrate status`, que es lectura. Nunca ejecuta `migrate up`. La migración 011 debe revisarse y aplicarse por separado siguiendo `backPOS-go/MIGRATIONS.md`, con respaldo y `--confirm`.

## Recuperación manual

Cada release conserva:

```text
\\servidor\...\POS\.rollback\YYYYMMDD-HHmmss\server.exe
\\servidor\...\POS\.rollback\YYYYMMDD-HHmmss\out\
```

Si el rollback automático no puede operar, detener `POS_Server`, restaurar ambos artefactos de la misma carpeta, iniciar el servicio y repetir healthcheck. No mezclar el binario de un release con el frontend de otro.
