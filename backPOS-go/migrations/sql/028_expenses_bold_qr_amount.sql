-- Sprint B5 (2026-10-24): columna física expenses.bold_qr_amount para
-- egresos MIXTOS que combinan Bold QR / Bre-B con otros canales.
--
-- POR QUÉ existe esta migración
-- ============================================================================
-- Hasta la 027 el canal Bold QR no tenía columna propia en expenses. La
-- regla temporal (ver internal/core/services/expense_bold_qr_normalize.go y
-- internal/core/domain/models/payment_source_boldqr.go) se apoyaba sólo en
-- texto: paymentSource='BOLD_QR' con los cinco bolsillos físicos
-- (cash_amount, nequi_amount, daviplata_amount, fondo_amount, coins_amount)
-- en cero. Esa decisión fue explícita en payment_source_boldqr.go:
--
--     "Agregar una columna expenses.bold_qr_amount sería ideal para egresos
--      mixtos (BOLD_QR + CAJA en el mismo pago), pero exige una migración
--      de esquema y el dueño pidió evitarla en este sprint."
--
-- Y por eso validateAndNormalizeBoldQRExpense rechazaba cualquier egreso
-- BOLD_QR combinado con otro canal: era imposible desglosarlo sin esta
-- columna. El dueño ya aprobó la migración y pidió que los egresos puedan
-- repartirse (ej. $300.000 totales = $200.000 Bold QR + $100.000 CAJA) con
-- cada parte descontada de su canal real.
--
-- Esta migración instala el bolsillo faltante al mismo nivel que los demás:
-- mismo tipo (decimal(10,2)), mismo DEFAULT (0), misma convención
-- NOT NULL. La identificación por texto en paymentSource se mantiene por
-- compatibilidad, pero a partir de ahora el dinero vive en una columna
-- agrupable en SQL.
--
-- QUÉ CAMBIA EN LA PRÁCTICA
-- ============================================================================
-- - Nueva columna expenses.bold_qr_amount DECIMAL(10,2) NOT NULL DEFAULT 0.
-- - Backfill único y acotado: egresos puros BOLD_QR ya pagados (PAID) con
--   los cinco bolsillos en cero reciben bold_qr_amount = amount. Es la
--   definición de "egreso Bold QR puro" que ya aplicaba el agregador
--   legacy; el backfill no cambia totales, sólo mueve el valor del texto
--   a su columna propia para que después pueda consultarse por SQL.
-- - La vista materializada mv_dashboard_stats_monthly (migración 020) suma
--   amount + tax_amount, no suma bolsillos individuales, así que su total
--   total_expenses NO cambia con esta migración. No requiere refresh.
--
-- POR QUÉ NO BACKFILLEAR status='SETTLED'
-- ============================================================================
-- SETTLED es el status del PADRE (deuda original) cuando los abonos
-- acumulados lo cubren por completo. Expense_service.SettleExpense NO
-- escribe los bolsillos físicos sobre el padre: inserta un expense HIJO
-- status='PAID' por cada abono, y es ese hijo el que lleva cash_amount /
-- nequi_amount / daviplata_amount / fondo_amount (y a partir de ahora
-- bold_qr_amount) con el método real del abono. El padre sólo guarda
-- amount, paid_amount, remaining_amount y la fecha original.
--
-- Si marcáramos bold_qr_amount = amount sobre padres SETTLED cuyo flujo
-- de abonos pasó por Bold QR, estaríamos sumando dos veces el mismo
-- dinero: una vez en el abono hijo (status PAID, paymentSource BOLD_QR)
-- y otra en el padre. El backfill restringido a status='PAID' captura el
-- caso completo: egresos BOLD_QR creados en una sola operación y abonos
-- BOLD_QR a deudas (son filas HIJAS con status='PAID'). Lo mismo aplica a
-- status='PENDING': aún no hay dinero movido, no hay nada que trasladar.
--
-- POR QUÉ NO AGREGAR CHECK bold_qr_amount >= 0
-- ============================================================================
-- Los otros cinco bolsillos (cash_amount, nequi_amount, daviplata_amount,
-- fondo_amount, coins_amount) no tienen CHECK >= 0 en el esquema actual:
-- fueron creados por AutoMigrate (migración 002, model_schema) con la
-- misma forma DECIMAL(10,2) DEFAULT 0 y nada más. Añadir una restricción
-- asimétrica sobre bold_qr_amount introduciría un contrato distinto al
-- del resto de la familia y la validación tendría que suceder en dos
-- lugares distintos (handler + BD) sólo para esta columna. Si en un
-- futuro se decide blindar signos a nivel BD, debe ser una migración
-- consecutiva que extienda el CHECK a los seis bolsillos a la vez, no
-- a uno sólo.
--
-- TRANSACCIONAL: SÍ
-- ============================================================================
-- La migración es un ALTER TABLE ADD COLUMN (metadata-only en PostgreSQL
-- 11+ cuando el DEFAULT es constante y la columna es NOT NULL) más un
-- UPDATE acotado por un WHERE que ya resuelve por índice parcial
-- (idx_expenses_pending_debts_date de la 015 no aplica; aquí golpeamos
-- filas PAID por paymentSource, que son relativamente pocas). No usa
-- CREATE INDEX CONCURRENTLY, así que respeta el default transaccional de
-- catalog.go sin figurar en la lista de excepciones. Si por una partición
-- futura esta tabla crece a millones de filas, convendría convertir el
-- UPDATE en un backfill por lotes con cursor, pero hoy la ventana de
-- bloqueo es aceptable para una ventana operativa controlada.
--
-- RELACIÓN CON LA 027
-- ============================================================================
-- La 027 extendió pos_qr_payment_intents para el flujo asíncrono del QR
-- Bre-B (snapshots, finalization, bandeja). Esa migración vive del lado
-- de VENTAS. La 028 es paralela y vive del lado de EGRESOS: habilita que
-- un pago manual a proveedor usando el mismo QR Bold se descuente
-- correctamente del canal digital. No comparten tablas; no hay conflicto
-- de ejecución. Pueden aplicarse en la misma ventana operativa en orden
-- creciente, como cualquier otra migración.
--
-- NO MODIFICA DATOS FUERA DE LA DEFINICIÓN ANTERIOR
-- ============================================================================
-- El UPDATE sólo mueve valor del texto paymentSource='BOLD_QR' a la nueva
-- columna. El total del egreso (amount + tax_amount) no cambia. No se
-- toca ninguna otra tabla: ni sales, ni cashier_closures, ni audit_logs,
-- ni pos_qr_payment_intents. El respaldo DB-only previo
-- (respaldar_base_datos.ps1 → migrar_base_datos.ps1) es suficiente para
-- revertir si algún caso frontera no previsto apareciera después.

-- ----------------------------------------------------------------------------
-- 1) Columna nueva. Idempotente vía IF NOT EXISTS: si un reintento tras
--    fallo encuentra la columna ya creada, continúa con el UPDATE.
-- ----------------------------------------------------------------------------

ALTER TABLE expenses
    ADD COLUMN IF NOT EXISTS bold_qr_amount DECIMAL(10,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN expenses.bold_qr_amount IS
    'Parte del egreso pagada vía Bold QR / Bre-B. Convive con cash_amount, nequi_amount, daviplata_amount, fondo_amount y coins_amount para permitir egresos MIXTOS (ej. $200000 BOLD_QR + $100000 CAJA en el mismo pago). Antes de la migración 028 el canal se identificaba sólo por texto en paymentSource; esta columna lo lleva al mismo nivel físico que los otros cinco bolsillos. Tipo decimal(10,2) y default 0 para empatar con la familia y permitir que ADD COLUMN sea metadata-only en PostgreSQL 11+.';

-- ----------------------------------------------------------------------------
-- 2) Backfill único de egresos BOLD_QR puros ya pagados (PAID).
--
--    DEFINICIÓN DE "BOLD_QR PURO" (coincide con la rama legacy del
--    agregador postgres_expense_repository.go que agrupa por
--    UPPER(paymentSource)):
--
--      status = PAID
--      deleted_at IS NULL
--      UPPER(paymentSource) = 'BOLD_QR'
--      cash_amount = nequi_amount = daviplata_amount = fondo_amount
--                  = coins_amount = 0
--
--    Para esas filas la totalidad del dinero se cobró vía Bold QR; el
--    monto vive en la columna amount y lo trasladamos a bold_qr_amount.
--
--    GUARDAS DEFENSIVAS
--    ------------------
--    - COALESCE(..., 0) en cada bolsillo por si alguna fila heredada
--      quedó con NULL (los defaults son 0 pero bases muy antiguas,
--      pre-AutoMigrate con model nullable, podrían tenerlo).
--    - UPPER(COALESCE("paymentSource", '')) para no explotar en NULL y
--      cubrir variantes de casing. Nota: usamos la forma canónica
--      exacta 'BOLD_QR' (sin espacios ni guiones): egresos antiguos con
--      "BOLD QR" o "BOLDQR" quedarán sin backfill. Es intencional: la
--      función Go IsBoldQRPaymentSource acepta variantes amplias, pero
--      aquí sólo migramos los que ya pasaron por la normalización a la
--      constante canónica models.PaymentSourceBoldQR = "BOLD_QR" (ver
--      validateAndNormalizeBoldQRExpense). Las variantes legacy, si
--      existieran, deberán corregirse manualmente antes o después de
--      esta ventana, no automáticamente.
--    - amount > 0: nunca escribimos un valor negativo o cero que
--      corrompa el bolsillo. Si el amount fuera cero no hay nada que
--      trasladar.
--    - bold_qr_amount = 0: hace la migración idempotente. Un reintento
--      del UPDATE no sobrescribe filas ya tratadas.
--
--    POR QUÉ NO status IN ('PAID', 'SETTLED')
--    ---------------------------------------
--    SETTLED es el padre de una cadena de abonos (hijos status PAID). El
--    bolsillo real del dinero vive en el hijo, no en el padre: ver la
--    nota larga arriba y expense_service.go#SettleExpense.
-- ----------------------------------------------------------------------------

UPDATE expenses
   SET bold_qr_amount = amount
 WHERE UPPER(status) = 'PAID'
   AND deleted_at IS NULL
   AND UPPER(COALESCE("paymentSource", '')) = 'BOLD_QR'
   AND COALESCE(cash_amount, 0)      = 0
   AND COALESCE(nequi_amount, 0)     = 0
   AND COALESCE(daviplata_amount, 0) = 0
   AND COALESCE(fondo_amount, 0)     = 0
   AND COALESCE(coins_amount, 0)     = 0
   AND bold_qr_amount                = 0
   AND amount                        > 0;
