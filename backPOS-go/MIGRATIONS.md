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
