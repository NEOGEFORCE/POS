# Migraciones de PostgreSQL

El API no crea bases, tablas, índices, roles, vistas ni semillas durante un arranque normal. `ConnectDB` sólo abre PostgreSQL, configura el pool y ejecuta `PingContext`; `cmd/api` comprueba en modo lectura que el catálogo completo esté aplicado.

## Comandos

Desde `backPOS-go`:

```powershell
# Sólo lectura
 go run ./cmd/migrate status

# Mutación explícita: requiere respaldo y ventana controlada
 go run ./cmd/migrate up --confirm

# Semillas canónicas, después de migrar
 go run ./cmd/seed --confirm --admin-dni ADMIN
```

`--create-default-admin` sólo debe usarse conscientemente en una instalación vacía: crea `ADMIN` con la contraseña temporal heredada `123456`, que debe cambiarse inmediatamente. En instalaciones normales es preferible crear el administrador mediante el flujo de setup.

Desde la raíz del proyecto, `migrar_base_datos.ps1` automatiza de forma protegida el respaldo custom verificable, `status`, aplicación de todas las pendientes y `status` final. Exige `-ConfirmMigrate`, `-ConfirmServiceStopped` y un `-ExpectedTarget` idéntico a `<DB_HOST>:<DB_PORT>/<DB_NAME>`. No ejecuta semillas ni restaura automáticamente.

## Flujo de despliegue

1. Confirmar la base destino (`DB_HOST` y `DB_NAME`).
2. Crear y verificar un respaldo restaurable.
3. Detener el API para evitar escrituras concurrentes de la aplicación.
4. Ejecutar `migrate status`.
5. Revisar el preflight de `009_sprint2_integrity`: los `clientTxId` duplicados abortan sin corregir datos automáticamente.
6. Ejecutar `migrate up --confirm`.
7. Ejecutar nuevamente `migrate status`; todas las versiones deben figurar como `APLICADA`.
8. Iniciar el API y ejecutar health checks y smokes contables.

No existe un modo de "baseline a ciegas". Una instalación heredada ejecuta las versiones idempotentes y sólo registra cada una después de completarla. Si una validación de FK o de datos falla, se corrigen los datos de forma explícita y se reintenta.

## Garantías del runner

- Catálogo `001` a `011` embebido en el binario.
- Historial en `schema_migrations` con nombre, SHA-256, fecha y duración.

## Índices operativos Sprint 7 (versión 011)

`migrations/sql/011_operational_indexes.sql` es la única fuente ejecutable de esta versión. Agrega índices compuestos para búsquedas de kárdex por referencia/razón y producto/fecha, egresos por categoría/proveedor/fecha y auditoría por módulo/empleado/fecha. Usa exclusivamente `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, por lo que el catálogo la marca como no transaccional e idempotente.

Las copias históricas `migrations/005_*.sql` a `009_*.sql` de la raíz son marcadores no ejecutables; las fuentes canónicas viven en `migrations/sql`. La versión 011 no se aplica al compilar ni al iniciar el API: requiere respaldo, revisión de `migrate status` y `migrate up --confirm` durante una ventana operativa.

- Rechazo de checksums modificados y de esquemas más nuevos que el binario.
- `pg_advisory_lock` evita dos runners simultáneos.
- Migraciones transaccionales por defecto.
- `008`, `009` y `011` corren en autocommit porque usan `CREATE INDEX CONCURRENTLY`; sus sentencias son idempotentes para permitir reintentos después de un fallo parcial.
- El comando `up` exige `--confirm` y nunca crea la base PostgreSQL.

## Añadir una migración

1. Crear el siguiente archivo consecutivo en `migrations/sql`, por ejemplo `011_descripcion.sql`.
2. No editar archivos que ya hayan sido aplicados: el checksum impedirá el arranque.
3. Si requiere `CREATE INDEX CONCURRENTLY`, marcar esa versión como no transaccional en `migrations/catalog.go` y añadir una prueba.
4. Ejecutar `go test ./migrations` y la validación completa del backend.


## Compatibilidad y ventanas de bloqueo

La versión `002_model_schema` ejecuta el `AutoMigrate` heredado **únicamente desde el comando explícito de migración**, nunca desde el API. En una base grande puede tomar locks o reescribir columnas, por lo que se debe ejecutar con el servicio detenido y tiempo suficiente. Las versiones futuras deben ser SQL numerado; no se debe confiar en editar la versión 002 después de aplicada.

RLS se habilita sin `FORCE` porque el POS es single-tenant y actualmente no hace `SET ROLE` por solicitud. La política `PUBLIC` no concede permisos de tabla: sólo evita bloquear a roles que ya tengan `GRANT`. Si se introduce aislamiento multi-tenant, deberá diseñarse una migración nueva junto con el contexto de rol por conexión.


## Smart Restock V2 (versión 010)

La única fuente ejecutable es `migrations/sql/010_smart_restock_v2.sql`; el archivo SQL histórico de la raíz no debe aplicarse. La versión 010 agrega snapshots diarios, métricas precalculadas, cantidad en tránsito y `suppliers.lead_time_days` nullable. El fallback logístico es `lead_time_days > visit_frequency_days > 7`.

El cron corre a las 21:00 en `America/Bogota`. Calcula todos los productos activos en batch y persiste snapshots y métricas en una transacción. El recálculo manual es `POST /api/admin/run-nightly-restock` y requiere rol admin. Las sugerencias se consultan por `GET /api/restock/suggestions-v2` usando exclusivamente `Authorization: Bearer`; el token por query string está reservado para `/api/sse`.

Antes de habilitar Sprint 8 en producción:

1. Completar y validar los bloqueantes de seguridad e integridad identificados para Sprint 5.
2. Crear respaldo restaurable y seguir la ventana de migración descrita arriba.
3. Ejecutar `migrate status`, revisar la versión 010 y sólo entonces usar `migrate up --confirm`.
4. Ejecutar una vez el recálculo manual o esperar al cron de las 21:00; hasta entonces la API puede devolver una lista vacía.
5. Verificar con datos controlados un producto A, uno B, uno C y un producto con tránsito. Categoría C debe conservar `suggested_order_qty = 0`.

Este cambio no requiere ni autoriza devoluciones de mercancía estancada. No se debe editar la versión 010 después de aplicarla; cualquier corrección posterior debe ser una migración 011 consecutiva.


## Código y operaciones legacy aisladas

La única fuente de migraciones ejecutables es `migrations/catalog.go` junto con `migrations/sql/*.sql`. No se deben aplicar manualmente copias SQL históricas ni convertir scripts ad hoc en migraciones sin asignarles una versión nueva y pruebas del runner.

`cmd/migrate_old`, `cmd/reset_pass`, `scripts/backfill_users`, `scripts/fix_superadmin`, `gen_pdf_82.go` y todo `cmd/tools/*.go` requieren el build tag `tools_legacy`; quedan fuera de builds, tests y despliegues normales. Son archivos históricos, no comandos operativos soportados. Los DSN embebidos fueron neutralizados. Para recuperar alguna lógica se debe crear un comando nuevo con variables de entorno obligatorias, `--dry-run`, confirmación explícita, destino visible y respaldo verificado.

Los batch `actualizar.bat` y `actualizar_servidor.bat` ahora cancelan salvo que reciban `--confirm-update`. Esa bandera sólo evita ejecuciones accidentales: no sustituye revisión del destino, respaldo ni ventana de despliegue.


## Checkout asíncrono QR (versión 027)

`migrations/sql/027_pos_qr_async_checkout.sql` extiende aditivamente la tabla `pos_qr_payment_intents` creada por la 026 para soportar el flujo 100 % asíncrono del cobro QR Bre-B. Es **transaccional** (no usa `CREATE INDEX CONCURRENTLY`) y **puramente DDL**: ADD COLUMN con defaults seguros, seis ADD CONSTRAINT envueltos en bloques `DO $$` idempotentes, cinco CREATE INDEX parciales y COMMENT ON. No modifica datos, no backfillea, no toca otras tablas.

Qué agrega:

- `cart_snapshot` / `client_snapshot` / `totals_snapshot` (JSONB): foto inmutable del carrito, cliente y totales al momento de emitir la intención. Permite que el servidor materialice la venta sin volver a preguntar al frontend cuando el webhook aprueba.
- `sale_client_tx_id` (VARCHAR 8..64, UNIQUE parcial): clave de idempotencia reservada al emitir. Combina con la UNIQUE partial de `sales."clientTxId"` (migración 009) para cerrar la ventana de doble materialización ante reintentos o reconexiones.
- `queued_at` (TIMESTAMPTZ NULL): marca de "cajero pulsó Dejar en espera y seguir atendiendo". No es un estado del pago (el `status` sigue en PENDIENTE); es sólo una señal para que la bandeja global de `/sales/new` muestre la intención sin bloquear el carrito activo.
- `finalization_status` (`NOT_STARTED` → `IN_PROGRESS` → `SUCCEEDED` | `FAILED`) con sus `finalization_started_at`, `finalization_completed_at`, `finalization_attempts`, `finalization_last_error` (255 chars, sin stack trace ni secretos), `finalization_next_retry_at`. Describe el lifecycle de la MATERIALIZACIÓN de la venta en `sales`, separado del lifecycle del PAGO.
- `cashier_notified_at`: última vez que el servidor emitió por SSE el evento post-commit (alerta grande + sonido + impresión). Idempotente: la venta ya está materializada, el frontend decide con un token local si repite el sonido.
- UNIQUE parcial sobre `related_sale_id` (biyección "una intención ↔ una venta"), e índices parciales para la bandeja encolada por caja, los reintentos pendientes y la detección de atascos `IN_PROGRESS`.

Reglas que la BD codifica a nivel CHECK:

1. `SUCCEEDED` requiere que `status` sea `APROBADA` o `CONFIRMADA_MANUAL` (una venta no se materializa sin pago aprobado).
2. `SUCCEEDED` requiere `related_sale_id IS NOT NULL AND sale_client_tx_id IS NOT NULL`.
3. `FAILED` requiere `finalization_last_error IS NOT NULL AND related_sale_id IS NULL`.
4. `finalization_attempts` ∈ [0, 100]; cien intentos es señal de bug sostenido.
5. Secretos (`BOLD_BRIDGE_TOKEN`, `BOLD_SECRET_KEY`, firma HMAC) siguen fuera del esquema; `finalization_last_error` nunca debe contener el token ni el payload crudo (el handler recorta antes de persistir).

Esta migración se aplica después de la 026 en la misma ventana operativa:

1. Respaldo verificable (`respaldar_base_datos.ps1`) con API detenido.
2. `migrate status` para confirmar que la 026 ya está `APLICADA` y la 027 figura `PENDIENTE`.
3. `migrate up --confirm` dentro de `migrar_base_datos.ps1` con `-ConfirmMigrate` y `-ExpectedTarget` validados.
4. `migrate status` final; la 027 debe pasar a `APLICADA`.
5. Iniciar el servicio y verificar `/api/health`; probar `POST /api/pos/pagos-qr/iniciar` con sesión autenticada y validar que el snapshot queda persistido (consulta ad-hoc en la fila nueva).

No se debe editar la 027 después de aplicada: cualquier corrección posterior debe ser una migración 028 consecutiva.


## Bolsillo Bold QR en egresos (versión 028)

`migrations/sql/028_expenses_bold_qr_amount.sql` agrega la columna física `expenses.bold_qr_amount DECIMAL(10,2) NOT NULL DEFAULT 0` para permitir egresos **mixtos** que combinan Bold QR / Bre-B con otros canales (p. ej. $200 000 BOLD_QR + $100 000 CAJA en el mismo pago), con cada parte descontándose de su propio bolsillo. Es **transaccional** y **puramente aditiva**: un `ALTER TABLE ADD COLUMN IF NOT EXISTS` metadata-only (DEFAULT constante en PostgreSQL 11+) y un `UPDATE` acotado por `UPPER(status)='PAID'` para trasladar los egresos BOLD_QR puros existentes a la columna nueva sin cambiar `amount`.

Qué cambia:

- Antes de la 028, el canal Bold QR vivía sólo en el texto `paymentSource` (ver `internal/core/domain/models/payment_source_boldqr.go`) y `validateAndNormalizeBoldQRExpense` rechazaba cualquier egreso que mezclara BOLD con otro bolsillo porque no existía dónde desglosarlo.
- A partir de la 028 el canal se trata al mismo nivel que `cash_amount`, `nequi_amount`, `daviplata_amount`, `fondo_amount` y `coins_amount`. El handler y el agregador SQL pueden sumar `bold_qr_amount` directamente.
- La vista materializada `mv_dashboard_stats_monthly` (migración 020) suma `amount + tax_amount`, no bolsillos individuales, así que su `total_expenses` NO cambia con esta migración. **No requiere `REFRESH MATERIALIZED VIEW`.**

Reglas que la BD codifica:

1. `bold_qr_amount` es `NOT NULL DEFAULT 0`: toda fila existente queda con el bolsillo en cero y el `ADD COLUMN` es metadata-only.
2. El `UPDATE` sólo traslada dinero donde la fila cumple TODAS estas condiciones: `UPPER(status)='PAID'`, `deleted_at IS NULL`, `UPPER(COALESCE("paymentSource",''))='BOLD_QR'`, los cinco bolsillos físicos en cero (`COALESCE(..., 0) = 0`), `bold_qr_amount = 0` (idempotencia) y `amount > 0`.
3. **`SETTLED` NO se backfillea.** `SETTLED` es el status del PADRE de una cadena de abonos (hijos `status='PAID'`). `expense_service.SettleExpense` escribe los bolsillos físicos en el HIJO abono, no en el padre; marcar `bold_qr_amount = amount` sobre padres duplicaría el dinero. Lo mismo aplica a `PENDING`: aún no hay movimiento que trasladar.
4. **No se agrega `CHECK bold_qr_amount >= 0`.** Los otros cinco bolsillos no tienen `CHECK` a nivel BD (sólo `DEFAULT 0` desde AutoMigrate en la 002). Añadir una restricción asimétrica para una sola columna rompería la familia; si se decide blindar signos, debe ser una migración consecutiva que cubra los seis bolsillos a la vez.

Esta migración se aplica en una ventana operativa como cualquier otra, respetando el flujo canónico:

1. Respaldo verificable (`respaldar_base_datos.ps1`) con el API detenido.
2. `migrate status` para confirmar que la 027 ya está `APLICADA` y la 028 figura `PENDIENTE`.
3. `migrate up --confirm` dentro de `migrar_base_datos.ps1` con `-ConfirmMigrate` y `-ExpectedTarget` validados.
4. `migrate status` final; la 028 debe pasar a `APLICADA`.
5. Iniciar el servicio y verificar `/api/health`; probar `POST /api/expenses` con un pago mixto (`BOLD_QR + CAJA`) y confirmar que `cash_amount` y `bold_qr_amount` reciben las partes correctas, y que `GetGlobalPaidExpensesByMethod` reporta ambos canales por separado.

No se debe editar la 028 después de aplicada: cualquier corrección posterior debe ser una migración 029 consecutiva.
