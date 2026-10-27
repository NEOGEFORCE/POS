# Operación segura del POS

Estos scripts preparan una operación reproducible, pero **no autorizan ni ejecutan automáticamente un despliegue**. Deben usarse durante una ventana aprobada, con acceso al equipo destino y un operador responsable.

## Build local

```bat
build_prod.bat
```

Genera `backPOS/server.exe` y el export estático del frontend. No copia archivos ni reinicia servicios.

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

El despliegue sólo ejecuta `migrate status`, que es lectura. Nunca ejecuta `migrate up`. La migración 011 debe revisarse y aplicarse por separado siguiendo `backPOS/MIGRATIONS.md`, con respaldo y `--confirm`.

## Recuperación manual

Cada release conserva:

```text
\\servidor\...\POS\.rollback\YYYYMMDD-HHmmss\server.exe
\\servidor\...\POS\.rollback\YYYYMMDD-HHmmss\out\
```

Si el rollback automático no puede operar, detener `POS_Server`, restaurar ambos artefactos de la misma carpeta, iniciar el servicio y repetir healthcheck. No mezclar el binario de un release con el frontend de otro.


## Etiquetas y cajón de dinero (migración 016 pendiente)

La migración `016_label_generator_and_cash_drawer.sql` crea cinco tablas:
`label_size_templates`, `label_printer_profiles`, `label_codes`,
`label_print_jobs` y `cash_drawer_opens`. **La migración está escrita y
validada por `go test ./migrations` pero NO está aplicada.** Antes de usar
en producción las rutas `/api/labels/*` y `/api/cash-drawer/open`, el
operador debe aplicar la migración durante una ventana aprobada siguiendo
`backPOS/MIGRATIONS.md`.

- Modelos Go: `internal/core/domain/models/labels.go` — definidos fuera de
  `schemaModels()` a propósito para no alterar el checksum de la migración
  002 (model_schema). Las tablas físicas las crea exclusivamente la 016.
- Repositorio: `internal/adapters/repositories/label_repository.go`.
  - `EnsureCodeForProduct` es idempotente: reimprimir un barcode ya
    conocido devuelve el mismo `code`.
  - El generador consulta TRES fuentes de colisión dentro de la misma
    transacción: `products.barcode`, `products.alternateCodes` y
    `label_codes.code`.
  - `RecordCashDrawerOpen` valida las precondiciones del CHECK antes del
    INSERT para dar errores legibles.
- Handler: `internal/adapters/handlers/label_handler.go`.
- Rutas:
  - `GET  /api/labels/sizes` (empleado) — `POST` sólo admin.
  - `GET  /api/labels/printers` (empleado) — `POST` sólo admin.
  - `GET  /api/labels/codes/search?q=...` (empleado).
  - `POST /api/labels/codes` (empleado) — asegura código idempotente.
  - `POST /api/labels/print-jobs` (empleado) — audita el lote enviado.
  - `POST /api/cash-drawer/open` — regla "sin venta → requiere admin":
    responde `403 { code: "CASH_DRAWER_REQUIRES_SALE_OR_ADMIN" }`.

### Capacidades reales de hardware (importante)

El navegador NO puede escribir directamente a impresoras ESC/POS/TSPL
por USB ni enviar el pulso de kickout al cajón. Opciones viables:

- **Bridge local** (recomendado): servicio Node en `localhost` que expone
  `POST /print` y `POST /drawer`. Replicar el patrón de `scale-bridge/`.
  La pantalla `/labels` detecta `window.posBridge` y lo usa cuando está
  presente.
- **WebUSB**: Chromium only, HTTPS obligatorio, permiso explícito del
  usuario cada sesión. Fuera de alcance de este sprint.

Sin bridge: imprimir cae al diálogo del navegador y la apertura del
cajón queda **auditada pero no se produce físicamente**. La UI lo
documenta en pantalla.



## Despliegue Home/OTP de cajón — 2026-10-13

Despliegue completado en `DESKTOP-VK2U90S` con respaldo previo y ventana de
servicio controlada. No hubo commit ni push.

- Respaldo predeploy verificado:
  `C:\Users\surti\Desktop\POS\.predeploy-backups\2026-10-13_19-57-08`.
  Incluye `server.exe`, 308 archivos del `out` anterior, dump PostgreSQL custom
  de 5,291,534 bytes, catálogo de `pg_restore` (612 líneas), SHA-256 y
  `manifest.json`.
- Migraciones aplicadas con el API detenido: `024_internal_barcode_reservations`
  y `025_cash_drawer_otp_challenges`. Estado final: 25 aplicadas, 0 pendientes.
- Release anterior conservado en:
  `C:\Users\surti\Desktop\POS\.rollback\home-drawer-20261013-200211`.
- Hash SHA-256 del `server.exe` activo:
  `B82A7878FCD20B07B4E3AF94DD54E71E5BA0981A4F590C733CB101DC1CE90B5E`.
- Verificación posterior: `POS_Server` Running, `/api/health` 200,
  `/sales/new` 200, rutas OTP y override responden 401 sin sesión, tabla e
  índices/checks de OTP presentes y bundle Home detectado en el frontend.

### Pendiente físico JAL838L

El fabricante confirma que la Jaltech JAL838L (referencia 80282) soporta USB,
RJ45 LAN, RJ11 para cajón, TSPL y ESC/POS. En el servidor no hay una impresora
térmica/driver instalada, `label_printer_profiles` está vacío y no hay bridge
de impresión escuchando; por ello la autorización queda auditada pero el pulso
físico no funcionará todavía. La página oficial no expone un instalador directo
sin acceso de cliente. No se descargaron drivers de terceros no verificables.
Para Ethernet puede evitarse el driver Windows usando el bridge local y la IP
de la impresora en puerto 9100; para USB/SYSTEM se necesita el paquete oficial
de Jaltech y registrar el nombre del spooler.



## Cobro QR Bold / Bre-B

El módulo QR está implementado, pero su activación productiva requiere una ventana operativa separada. No se debe desplegar el binario nuevo antes de aplicar las migraciones `026_pos_qr_payment_intents` y `027_pos_qr_async_checkout` con respaldo verificado y el API detenido. Las dos van en la misma ventana: la 027 extiende aditivamente la tabla creada por la 026 y asume que ya está aplicada.

### Activo comercial

El QR real suministrado por el comercio está versionado en:

```text
FrontPOS/public/qr-bold-breb.png
```

La UI lo sirve como `/qr-bold-breb.png`. No reemplazarlo por un QR generado, un placeholder ni una captura diferente sin validar previamente en la aplicación bancaria que el titular mostrado sea Sebastian Sarmiento y que corresponda al comercio Bre-B `0093097755`.

### Variables de entorno

Para el QR Bre-B estático gratuito se utiliza exclusivamente el puente Android por LAN. Configurar en el entorno protegido del servicio:

- `BOLD_BRIDGE_TOKEN`: obligatorio para `POST /api/webhooks/bold-notificacion`.
- `BOLD_SECRET_KEY`, `BOLD_SIGNATURE_HEADER` y `BOLD_EVENT_SALE_APPROVED`: no son necesarios para el QR Bre-B estático; pueden permanecer sin configurar mientras no exista un contrato oficial de pasarela.

El token nunca debe incluirse en la URL ni en logs. MacroDroid debe enviarlo preferiblemente como header HTTP:

```text
X-Bridge-Token: <BOLD_BRIDGE_TOKEN>
Content-Type: application/json
```

Body LAN canónico:

```json
{
  "titulo": "{not_title}",
  "mensaje": "{not_text}",
  "app": "co.bold"
}
```

Por compatibilidad también se aceptan el header legacy `X-Bold-Bridge-Token` y el campo JSON `"token"`, pero `X-Bridge-Token` es el contrato recomendado. El servidor valida el token en tiempo constante, exige `app = co.bold`, combina título y mensaje para buscar el monto y rechaza negadores como reversado, anulado, pendiente, rechazado o cancelado.

Después de autenticar y validar `co.bold`, el servidor registra exactamente `titulo` y `mensaje` usando `%q` (saltos de línea escapados). Nunca registra el token, headers ni body crudo.

### Endpoints

Rutas POS autenticadas para cajero (`empleado` o superior):

- `POST /api/pos/pagos-qr/iniciar`
- `POST /api/pos/pagos-qr/encolar`
- `GET /api/pos/pagos-qr/estado?venta_temp_id=...`
- `GET /api/pos/pagos-qr/stream?venta_temp_id=...` (SSE del modal con `Authorization: Bearer`; nunca token en query)
- `GET /api/pos/pagos-qr/pendientes?caja_id=...&limit=20`
- `GET /api/pos/pagos-qr/caja-stream?caja_id=...` (SSE de la bandeja con `Authorization: Bearer`; nunca token en query)
- `POST /api/pos/pagos-qr/cancelar`

Ruta de emergencia, autenticada y restringida exclusivamente a `admin`:

- `POST /api/pos/pagos-qr/confirmar-manual` — no forma parte del flujo normal y el frontend de caja no la expone.

Endpoint LAN autenticado por token:

- `POST http://192.168.1.6:3000/api/webhooks/bold-notificacion`

El endpoint `/api/webhooks/bold` de pasarela permanece implementado pero no se publica ni se usa para el QR Bre-B estático.

El emparejamiento automático exige monto exacto y exactamente una intención pendiente vigente. El parser elimina centavos (`$300,00`, `$300.00` y `$ 300,0` se normalizan a `300`) antes de comparar contra `amount_cop BIGINT`.

El webhook responde `200` con un estado semántico cuando pudo procesar la notificación:

- `APPROVED`: encontró exactamente una intención, materializó/reutilizó la venta y vinculó su `saleId`.
- `UNMATCHED`: no había intención exacta; se conserva un evento de conciliación append-only y no se inventa una venta sin carrito.
- `AMBIGUOUS`: había dos o más pendientes del mismo monto; se conserva la conciliación y se factura cero automáticamente.
- `DUPLICATE`: el fingerprint ya había sido procesado.
- `ignored`: la notificación no representa un pago aprobable.

Sólo un fallo real de base de datos/infraestructura responde `500 QR_REQUEST_FAILED`. MacroDroid no entrega identificador externo: en ese canal `external_id` debe persistirse como `NULL`, nunca como `''`, porque `ck_pqwe_external_id_shape` rechaza la cadena vacía y revertiría el evento completo.

### Flujo asíncrono QR

1. Antes de mostrar el QR, el frontend llama `/iniciar` con un `venta_temp_id` estable, monto exacto, `sale_client_tx_id` y snapshots durables del carrito, cliente y totales. `queued_at` permanece `NULL` mientras el cajero espera en el modal.
2. El modal repite `/iniciar` con el contrato mínimo; el backend reutiliza idempotentemente la misma intención y nunca reemplaza el snapshot ni el `sale_client_tx_id` ya reservados.
3. Al pulsar **DEJAR EN ESPERA Y SEGUIR ATENDIENDO**, el frontend envía `/encolar` con el mismo `venta_temp_id`, monto, snapshot y `sale_client_tx_id`; el backend sólo marca `queued_at` sobre la misma fila.
4. El carrito sólo se libera después de que `/encolar` responde correctamente. Se elimina únicamente el carrito activo y se abre/selecciona uno limpio; los demás carritos y los QR pendientes no se modifican.
5. `/pendientes` repuebla la bandeja tras refresh y `/caja-stream` mantiene la escucha aunque el modal QR esté cerrado. Ambos SSE usan el token únicamente en el header `Authorization` y están excluidos de compresión/buffering.
6. Cuando el webhook encuentra exactamente una intención viva por monto, marca el pago como aprobado y dispara la finalización fuera de la transacción del matcher. El materializador reutiliza `SaleService.CreateSale` con el `sale_client_tx_id` persistido; así la venta, movimientos de stock y reintentos conservan la idempotencia canónica.
7. El evento `APPROVED` para modal/bandeja se publica sólo después de crear o recuperar idempotentemente la venta y vincular `related_sale_id`. Incluye `saleId`, monto y referencia. El frontend cierra/libera localmente el carrito, pero nunca vuelve a llamar `/sales/register`; la impresión queda en el flujo canónico de `SaleService`.
8. Un barredor de finalización se ejecuta periódicamente y recupera aprobaciones `NOT_STARTED`, fallos cuyo backoff venció y trabajos `IN_PROGRESS` atascados. Usa siempre el mismo `sale_client_tx_id`; no crea otra venta ni descuenta stock dos veces.
9. Las intenciones usan una vigencia de 15 minutos. `AMBIGUOUS` nunca inicia el materializador: dos o más pendientes del mismo monto producen cero facturación automática.
10. Una intención legacy aprobada sin snapshot se conserva como evidencia, responde `200` y no crea venta/stock. Debe conciliarse administrativamente; el sistema nunca reconstruye un carrito inexistente.

Estados operativos visibles en la bandeja: `ENQUEUED`, `APPROVED`, `AMBIGUOUS`, `UNMATCHED`, `EXPIRED`, `CANCELLED` y `ERROR`. Los estados no terminales o fallidos se pueden reabrir/consultar; cancelar exige una sesión autenticada y nunca revierte una venta ya finalizada.

### Activación

1. Crear y verificar respaldo completo.
2. Detener `POS_Server`.
3. Aplicar las migraciones 026 y 027 en orden con el runner canónico y confirmaciones operativas.
4. Configurar las variables anteriores en el entorno protegido del servicio.
5. Desplegar API y frontend del mismo build.
6. Iniciar el servicio y verificar `/api/health`.
7. Abrir el método QR con sesión autenticada; antes de que aparezca el código, confirmar que `/iniciar` dejó una sola fila con `queued_at IS NULL` y `cart_snapshot`, `client_snapshot`, `totals_snapshot` y `sale_client_tx_id` poblados.
8. Pulsar **DEJAR EN ESPERA Y SEGUIR ATENDIENDO** y confirmar que `/encolar` reutilizó la misma fila y únicamente pobló `queued_at`.
9. Validar MacroDroid con un pago real controlado y monto único; confirmar respuesta `200 {status:"APPROVED"}`, SSE post-commit, `finalization_status='SUCCEEDED'` y `related_sale_id` vinculado.
10. Repetir el webhook y confirmar `DUPLICATE`, sin otra venta ni movimiento de stock.
11. Probar un monto sin intención y confirmar `200 {status:"UNMATCHED"}` con evento de conciliación, sin venta automática.
12. Crear dos intenciones vivas del mismo monto en una prueba controlada; confirmar `200 {status:"AMBIGUOUS"}`, ausencia de `related_sale_id` y cero movimientos de stock/ventas automáticas.

No registrar ni compartir en capturas el valor de `BOLD_BRIDGE_TOKEN` o `BOLD_SECRET_KEY`.
