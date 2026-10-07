-- Pagos con préstamo reversibles y auditables.
--
-- Un pago de deuda con préstamo crea DOS efectos dentro de una transacción:
--   1) reduce expenses.remaining_amount / aumenta paid_amount en la deuda;
--   2) crea un expense PAID PRESTAMO y un loan_expense que consume principal.
--
-- Antes loan_expenses sólo apuntaba al expense de pago creado, no a la deuda
-- original. Al eliminar ese pago, ExpenseRepository.Delete hacía únicamente
-- soft-delete del expense: la deuda no reaparecía y SUM(amount_used) seguía
-- consumiendo principal. Estas columnas permiten guardar la contrapartida y
-- marcar la reversión sin destruir la auditoría.
--
-- Retrocompatibilidad: todas son NULL. Filas 019-021 siguen activas porque
-- reversed_at queda NULL. No se intenta adivinar source_expense_id en datos
-- históricos: una asociación incorrecta movería deuda real.

ALTER TABLE loan_expenses
    ADD COLUMN IF NOT EXISTS source_expense_id       INTEGER,
    ADD COLUMN IF NOT EXISTS source_status_before    VARCHAR(20),
    ADD COLUMN IF NOT EXISTS source_paid_before      NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS source_remaining_before NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS reversed_at             TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reversed_by_dni         VARCHAR(32);

-- Una misma deuda puede recibir varios abonos; no es UNIQUE.
CREATE INDEX IF NOT EXISTS idx_loan_expenses_source_expense
    ON loan_expenses(source_expense_id)
    WHERE source_expense_id IS NOT NULL;

-- Camino caliente de disponible = principal - SUM(usos activos).
CREATE INDEX IF NOT EXISTS idx_loan_expenses_active_by_loan
    ON loan_expenses(loan_id)
    WHERE reversed_at IS NULL;

COMMENT ON COLUMN loan_expenses.source_expense_id IS
    'Deuda original de expenses a la que se aplicó el pago. NULL cuando el préstamo financió un egreso nuevo.';
COMMENT ON COLUMN loan_expenses.source_status_before IS
    'Status de la deuda original antes del abono; permite restaurar su semántica al reversar.';
COMMENT ON COLUMN loan_expenses.source_paid_before IS
    'paid_amount de la deuda original inmediatamente antes del abono; snapshot de auditoría.';
COMMENT ON COLUMN loan_expenses.source_remaining_before IS
    'remaining_amount efectivo inmediatamente antes del abono; snapshot de auditoría.';
COMMENT ON COLUMN loan_expenses.reversed_at IS
    'Momento de reversión. NULL significa que amount_used sigue consumiendo principal.';
COMMENT ON COLUMN loan_expenses.reversed_by_dni IS
    'Administrador o superadministrador que reversó el uso del principal.';
