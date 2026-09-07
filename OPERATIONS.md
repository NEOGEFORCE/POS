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

## Orquestador de jobs

Los jobs programados (respaldo nocturno, restock, alertas de Telegram, refresco
del dashboard) ya no viven sólo en memoria. El paquete
`internal/infrastructure/orchestrator` los respalda en PostgreSQL con dos tablas
creadas por la migración `012_job_orchestrator.sql`:

- `job_definitions`: horario, timeout, intentos y el flag `enabled`.
- `job_runs`: una fila por ejecución, con estado, intentos, duración y error.

Qué cambia en la práctica:

- **Historial.** `GET /api/admin/jobs` responde qué corrió, cuándo y con qué
  resultado. Ya se puede contestar "¿se hizo el respaldo de anoche?".
- **Recuperación.** Los jobs con `catch_up` (respaldo, restock, alertas diarias)
  ejecutan la última ocurrencia perdida al encender el PC. Antes, si el equipo
  estaba apagado a las 21:20, el respaldo simplemente no ocurría.
- **Reintentos.** Backoff exponencial con techo de 5 minutos. El respaldo
  reintenta si falla el envío por Telegram.
- **Sin duplicados.** El índice único `(job_key, scheduled_for)` impide que dos
  instancias de `server.exe` corran el mismo job dos veces.
- **Apagado sin recompilar.** `PATCH /api/admin/jobs/<key>/enabled` con
  `{"enabled": false}`. El cambio se respeta en el siguiente disparo.
- **Disparo manual.** `POST /api/admin/jobs/<key>/run` queda registrado como
  `manual` y en la auditoría con el usuario que lo pidió.

Las cuatro rutas exigen rol `admin`: exponen errores internos y permiten lanzar
el respaldo de la base.

La migración 012 debe aplicarse antes de arrancar el binario nuevo, porque
`VerifyCurrent` aborta el arranque si el esquema no está al día. Se aplica con
`migrar_base_datos.ps1` en una ventana aprobada, como cualquier otra.

## Rendimiento de inventario y pedidos inteligentes

La migración `013_restock_hot_path.sql` sostiene dos optimizaciones. **No es
transaccional**, porque usa `CREATE INDEX CONCURRENTLY` para no bloquear
`stock_movements`, que es la tabla que escriben ventas, recepciones, mermas y
devoluciones.

- Índice parcial `idx_stock_movements_reception_barcode_date` sobre
  `(barcode, date DESC) WHERE reason = 'RECEPTION'`. El índice general de la
  011 cubre todos los `reason`, y como más del 90 % de las filas son ventas, el
  planificador escaneaba páginas de ruido para responder por recepciones.
- Columnas `last_reception_at` y `sold_since_reception` en
  `product_restock_metrics`. Antes, cada carga de Pedidos Inteligentes
  recalculaba en caliente `MAX(date)` sobre todo el kárdex y un `JOIN` sobre
  todo el histórico de ventas. Ahora eso lo hace el cálculo nocturno una vez y
  la pantalla sólo lee la fila.

### Paso obligatorio después de aplicar la 013

Correr el cálculo nocturno una vez para poblar las columnas nuevas:

```text
POST /api/admin/run-nightly-restock
```

Hasta que se ejecute, la señal de última recepción sale como "sin dato" en toda
la pantalla. Es degradación intencional: se prefirió mostrar el dato como
desconocido antes que mostrar ceros que parezcan reales.

## Códigos de barras retenidos por marcadores `[HISTORICO]`

`paquete_produccion/corregir_referencias.ps1` creó productos marcadores
inactivos llamados `[HISTORICO] <codigo>` para que las referencias huérfanas no
violaran la FK nueva. Esos marcadores **ocupan códigos de barras reales**, así
que un producto legítimo no puede tomar ese código y el error resulta
desconcertante, porque el marcador es invisible en el catálogo.

Cuántos hay:

```sql
SELECT COUNT(*) FROM products WHERE "productName" LIKE '[HISTORICO]%';
```

Para liberar uno, hay un endpoint sólo admin que fusiona el marcador con el
producto real en una sola transacción:

```text
POST /api/admin/products/merge-historical
{"realBarcode": "<codigo actual del producto>", "markerBarcode": "<codigo a liberar>"}
```

Mueve las referencias históricas de 14 tablas al producto real, borra el
marcador y renombra el producto. Valida todo antes de mutar y aborta sin tocar
nada si algo no cuadra. Queda en auditoría como acción crítica.

**Es una operación de datos, no una tarea de rutina.** Los movimientos de
kárdex, ventas y devoluciones del código histórico pasan a pertenecer al
producto real, que es lo correcto cuando de verdad es el mismo producto. Hacerlo
con respaldo reciente.

## Agenda de proveedores: configurada a mano vs aprendida

Cada proveedor tiene **dos** agendas, guardadas por separado a propósito:

- `visit_days` / `delivery_days` — los días que el dueño escribió a mano. **Ningún
  proceso automático los toca.** Un test estático
  (`TestNoAutoWriteToVisitDaysOrDeliveryDays`) escanea todo `internal/` y falla el
  build si alguien reintroduce una escritura automática sobre esas columnas.
- `learned_visit_days` / `learned_delivery_days` / `learned_lead_time_days` /
  `learned_sample_count` — lo que el sistema observó, calculado por el
  precálculo nocturno a partir de `confirmed_orders.confirmed_at` (cuándo vino el
  preventista) y `confirmed_orders.received_at` (cuándo llegó el pedido).
  Columnas creadas por la migración `014_supplier_learned_schedule.sql`.

Precedencia del lead time, expuesta en la API como `leadTimeSource`:

```text
configured_days > learned_days > explicit_lead_time > visit_frequency_learned > default (7)
```

Lo configurado a mano gana siempre. La pantalla de Pedidos Inteligentes muestra
las dos agendas en columnas separadas, con cuántos pedidos respaldan lo
aprendido, y destaca cuando se contradicen.

Umbrales del aprendizaje (en `internal/core/services/scheduling/learn.go`):
ventana de 90 días, mínimo 4 pedidos recibidos, un día se considera habitual si
aparece en al menos el 25 % de los pedidos y al menos 2 veces, lead time por
mediana (no promedio, para que un pedido demorado 30 días no arrastre el
resultado), y se descartan los datos sucios (sin fecha de llegada, o llegada
anterior al pedido).

### Por qué existen dos agendas

El mecanismo anterior hacía `UPDATE suppliers SET visit_days = visit_days || 'hoy'`
en cada egreso, cada orden de compra, cada recepción y cada confirmación de lista
de compras. Con el uso normal iba agregando días hasta dejar la semana completa,
borrando en silencio lo que el dueño había configurado. Eran ocho puntos de
código distintos; todos están desactivados.

## Migraciones pendientes

Al día 2026-08-31 hay tres migraciones escritas y **no aplicadas**: 012, 013 y
014. Correr `migrate status` para ver la lista real. Las 013 y 014 **no son
transaccionales** porque usan `CREATE INDEX CONCURRENTLY`.

Después de aplicarlas, correr **una vez** `POST /api/admin/run-nightly-restock`
para poblar las columnas de precálculo y la agenda aprendida. Antes de eso, la
pantalla muestra "sin dato" en esas señales, que es intencional.

## Migraciones

El despliegue sólo ejecuta `migrate status`, que es lectura. Nunca ejecuta `migrate up`. La migración 011 debe revisarse y aplicarse por separado siguiendo `backPOS-go/MIGRATIONS.md`, con respaldo y `--confirm`.

## Recuperación manual

Cada release conserva:

```text
\\servidor\...\POS\.rollback\YYYYMMDD-HHmmss\server.exe
\\servidor\...\POS\.rollback\YYYYMMDD-HHmmss\out\
```

Si el rollback automático no puede operar, detener `POS_Server`, restaurar ambos artefactos de la misma carpeta, iniciar el servicio y repetir healthcheck. No mezclar el binario de un release con el frontend de otro.
