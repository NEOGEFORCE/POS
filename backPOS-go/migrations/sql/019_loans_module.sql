-- Sprint 13: módulo avanzado de Préstamos del negocio (loans / installments
-- / loan_expenses).
--
-- POR QUÉ existe esta migración
-- ============================================================================
-- El POS confunde hoy dos cosas con el mismo nombre "deuda":
--
--   1) El fiado del cliente (cartera por cobrar) vive en `sales.debtPending`
--      y lo gestiona /sales/debts. Esta migración NO lo toca.
--   2) La deuda del negocio (cuentas por pagar y préstamos recibidos) vive
--      hoy abusando de la tabla `expenses`, con `status='PENDING'` o
--      `paymentSource IN ('PRESTAMO','PREST.')`. El campo libre `lenderName`
--      hace de "acreedor" y `remainingAmount` de "saldo". No hay cronograma,
--      no hay interés, no hay cuotas, no hay rastreo de en qué se gastó el
--      principal; la UI es un modal que agrupa expenses por acreedor.
--
-- El dueño pidió un módulo real de préstamos: cronograma calculado al
-- recibir el dinero (NONE / SIMPLE en esta primera versión; FRENCH queda
-- reservado para una migración posterior), pago de cuota que descuenta
-- saldo, gastos que consumen el principal y pantallas de dashboard,
-- formulario con preview y detalle con amortización. Para eso hace falta
-- un esquema propio, con constraints a nivel BD, no una convención sobre
-- `expenses` que cualquier handler nuevo puede romper.
--
-- CONVIVENCIA CON LO EXISTENTE
-- ============================================================================
-- Esta migración NO migra datos. Los `expenses` legacy con
-- `paymentSource='PRESTAMO'` quedan intactos. El contrato operativo es:
--
--   - Los préstamos NUEVOS entran por POST /api/loans y viven en `loans`.
--   - Un pago de cuota genera UN `expenses` normal (status='PAID',
--     paymentSource='EFECTIVO|NEQUI|…', NUNCA 'PRESTAMO') y actualiza la
--     cuota apuntando a ese expense via `settlement_expense_id`. Así el
--     cuadre de caja y los reportes diarios lo siguen viendo sin que
--     `GetPendingDebtsSummary` lo cuente doble.
--   - Un uso del principal queda en `loan_expenses` apuntando al expense
--     real (hard spend) + al préstamo que lo financió.
--
-- La tarjeta "Cuentas por Pagar" del dashboard sumará el total legacy de
-- `GetPendingDebtsSummary` MÁS el saldo vivo de préstamos. La fórmula
-- actual no se toca (hay un guardián de test en
-- `expense_payables_guard_test.go` que lo prohíbe).
--
-- QUÉ SE CREA
-- ============================================================================
-- Tres tablas en snake_case, con constraints de dominio a nivel BD:
--
--   - loans              el préstamo recibido: acreedor, principal, tasa,
--                        modo de interés, plazo, frecuencia, estado global.
--   - loan_installments  el cronograma: una fila por cuota con principal e
--                        interés desglosados, saldo pagado y estado.
--   - loan_expenses      rastreo del uso del principal: a qué `expense`
--                        físico se asignó cada peso del préstamo. No es
--                        auditoría genérica, es el libro de "en qué se me
--                        fue el crédito".
--
-- Las columnas monetarias son NUMERIC(14,2). NO se usa `float` ni `double
-- precision`: cualquier redondeo binario sobre dinero es un bug esperando.
-- 14 dígitos deja hasta 999 999 999 999,99 COP (orden de billones), muy por
-- encima de cualquier préstamo real que vaya a pasar por este POS.
--
-- POR QUÉ EL MODELO Go NO ENTRA EN schemaModels()
-- ============================================================================
-- Igual que la 016 (labels) y la 017 (package_barcode_aliases): el modelo
-- `models.Loan` (y sus hermanos) se declara con `TableName()` pero NO se
-- agrega a `schemaModels()` en `migrations/catalog.go`. Si entrara,
-- cambiaría el payload literal de la migración 002 (`model_schema`), su
-- checksum, y el runner abortaría el arranque de todas las instalaciones
-- que ya la tienen aplicada. La tabla física la crea EXCLUSIVAMENTE esta
-- migración; el struct Go sólo refleja el esquema para `.Find`/`.Create`.
--
-- POR QUÉ NO HAY FK DURA A expenses
-- ============================================================================
-- `expenses` usa soft delete (gorm.DeletedAt). Si una FK dura con ON DELETE
-- CASCADE se evalúa sobre una fila con `deleted_at IS NOT NULL`, no se
-- dispara el CASCADE (la fila sigue existiendo físicamente), pero el día
-- que la purga definitiva borra el expense se perdería la cuota pagada o
-- el registro del uso del principal. Preferimos conservar el audit:
-- `loan_installments.settlement_expense_id` y `loan_expenses.expense_id`
-- son referencias soft (INTEGER sin REFERENCES), con el COMMENT que lo
-- explica. Es el mismo patrón que `cash_drawer_opens.sale_id` en la 016.
--
-- TRANSACCIONAL: SÍ
-- ============================================================================
-- Esta migración NO usa CREATE INDEX CONCURRENTLY. Todas las tablas son
-- nuevas, así que ningún CREATE INDEX bloquea tablas calientes. Corre
-- dentro de la transacción por defecto del runner, por lo que un fallo a
-- mitad deja la BD exactamente como estaba. Por eso catalog.go NO añade
-- la 019 a la lista de excepciones no transaccionales (hoy 8, 9, 11, 13,
-- 14, 15 y 18).
--
-- IDEMPOTENTE
-- ============================================================================
-- `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` y
-- `COMMENT ON` son re-ejecutables sin efecto adicional. Si una ejecución
-- previa quedó a medias (muy improbable estando dentro de una transacción,
-- pero posible si se corrió el SQL por fuera del runner), un reintento no
-- la rompe.
--
-- NO MODIFICA DATOS DE NEGOCIO
-- ============================================================================
-- Puramente DDL: CREATE TABLE, CREATE INDEX y COMMENT. Ni un UPDATE, ni un
-- DELETE, ni un INSERT. No hay backfill de préstamos legacy desde
-- `expenses.paymentSource='PRESTAMO'`: convertir esas filas en préstamos
-- con cronograma sintético requiere decisiones de negocio (¿qué tasa?,
-- ¿qué plazo?, ¿qué fechas?) que esta migración, por política, no toma.
-- Si en el futuro se decide hacerlo, debe ser una migración 020+ aparte,
-- con respaldo verificado y revisión del dueño.

-- ----------------------------------------------------------------------------
-- 1) loans: el préstamo recibido.
--
-- MODELO DE INTERÉS DE ESTA PRIMERA VERSIÓN: SIMPLE = FLAT TOTAL (no anual)
-- ----------------------------------------------------------------------------
-- `interest_rate_pct` es el PORCENTAJE TOTAL que el acreedor cobra sobre el
-- principal, no una tasa nominal anual. No depende de `payment_frequency`
-- ni se "anualiza": lo que diga la columna es lo que efectivamente se cobra
-- una vez. Ejemplo: principal 1 000 000, rate 10.000 → interés total
-- 100 000, independiente de si son 4 cuotas semanales o 12 mensuales.
-- Guardarla con tres decimales permite tasas realistas (10.5%, 1.333%)
-- sin perder precisión.
--
-- `interest_mode`:
--   NONE   → sin interés, cuota = principal / term_count
--   SIMPLE → interés total flat = principal * interest_rate_pct / 100,
--            cuota uniforme = (principal + interés total) / term_count,
--            el residuo de centavos lo absorbe la última cuota.
--
-- POR QUÉ FRENCH NO ESTÁ EN EL CHECK EN ESTA PRIMERA VERSIÓN
-- ----------------------------------------------------------------------------
-- El servicio Go bloquea el modo FRENCH con `ErrFrenchNotImplemented` en
-- `ValidateLoanScheduleRequest` (ver `loan_schedule.go`). Admitir el
-- valor en el CHECK sería dejar un hueco abierto: si un INSERT llegara por
-- fuera del servicio (admin SQL, carga de respaldo, script de datos), la
-- BD lo aceptaría y la UI de amortización pintaría cuotas incoherentes.
-- La BD tiene que ser el guardia más estricto, no el más laxo. Cuando el
-- servicio implemente la cuota francesa, una migración 020+ ampliará
-- este CHECK; mientras tanto sólo se aceptan NONE y SIMPLE.
--
-- `status`:
--   ACTIVE     → saldo pendiente, cuotas por pagar
--   PAID       → todas las cuotas liquidadas
--   DEFAULTED  → en mora reconocida por admin (puede volver a ACTIVE tras pago)
--   CANCELLED  → anulado administrativamente (soft, por eso vive `deleted_at`)
--
-- `disbursement_channel`: canal por el que llegó el dinero. Mismo vocabulario
-- que `expenses.paymentSource` (EFECTIVO, NEQUI, DAVIPLATA, FONDO...). No
-- se valida en CHECK porque el repertorio puede crecer; la validación vive
-- en el handler Go, igual que para `expenses`.
--
-- POR QUÉ `total_payable` Y `remaining_balance` SON COLUMNAS DEL PRÉSTAMO
-- ----------------------------------------------------------------------------
-- `total_payable = principal_amount + interés total` es el monto comprometido
-- al firmar el préstamo. `remaining_balance = total_payable - SUM(paid_amount)`
-- es lo que queda por pagar en cualquier instante. Guardarlos como columnas
-- NUMERIC(14,2) permite:
--
--   1) Leer un número en el dashboard y la lista de préstamos sin agregar
--      sobre `loan_installments` en cada refresh. El cronograma puede tener
--      hasta 600 filas por préstamo y la tarjeta "Cuentas por Pagar" se
--      pinta en el camino caliente.
--   2) Expresar la invariante `remaining_balance >= 0 AND remaining_balance
--      <= total_payable` como CHECK a nivel BD. Un bug que intente dejar
--      saldo negativo o mayor al total falla al UPDATE, no deja datos
--      corruptos esperando a que un reporte los descubra.
--
-- La relación `total_payable = principal + interés total` NO se declara
-- como CHECK porque "interés total" vive implícito en el cronograma (otra
-- tabla) y los CHECK de PostgreSQL no pueden hacer SELECT. El servicio Go
-- es quien debe mantener la invariante al crear el préstamo y en cada pago.
-- Las columnas se declaran con DEFAULT 0 para que la primera versión del
-- backend, que todavía no las persiste explícitamente, pueda crear préstamos
-- sin violar NOT NULL: el valor correcto llega después del INSERT, cuando
-- el servicio actualice la fila con el total del cronograma preview. Si
-- más adelante el servicio empieza a poblar las columnas desde el INSERT
-- inicial, no hace falta cambiar el schema.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS loans (
    id                   BIGSERIAL      PRIMARY KEY,
    lender_name          VARCHAR(120)   NOT NULL,
    lender_dni           VARCHAR(32),
    supplier_id          INTEGER        REFERENCES suppliers(id) ON DELETE SET NULL,
    principal_amount     NUMERIC(14,2)  NOT NULL CHECK (principal_amount > 0),
    interest_rate_pct    NUMERIC(7,3)   NOT NULL DEFAULT 0 CHECK (interest_rate_pct >= 0),
    interest_mode        VARCHAR(16)    NOT NULL DEFAULT 'SIMPLE'
                             CHECK (interest_mode IN ('NONE', 'SIMPLE')),
    term_count           INTEGER        NOT NULL CHECK (term_count >= 1 AND term_count <= 600),
    payment_frequency    VARCHAR(16)    NOT NULL DEFAULT 'MONTHLY'
                             CHECK (payment_frequency IN ('WEEKLY', 'BIWEEKLY', 'MONTHLY')),
    start_date           DATE           NOT NULL,
    first_payment_date   DATE           NOT NULL,
    disbursement_channel VARCHAR(32)    NOT NULL DEFAULT 'EFECTIVO',
    status               VARCHAR(16)    NOT NULL DEFAULT 'ACTIVE'
                             CHECK (status IN ('ACTIVE', 'PAID', 'DEFAULTED', 'CANCELLED')),
    total_payable        NUMERIC(14,2)  NOT NULL DEFAULT 0 CHECK (total_payable >= 0),
    remaining_balance    NUMERIC(14,2)  NOT NULL DEFAULT 0 CHECK (remaining_balance >= 0),
    note                 TEXT,
    created_by_dni       VARCHAR(32)    NOT NULL,
    created_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    deleted_at           TIMESTAMPTZ,
    CONSTRAINT ck_loans_first_payment_after_start
        CHECK (first_payment_date >= start_date),
    CONSTRAINT ck_loans_interest_requires_rate
        CHECK (interest_mode = 'NONE' OR interest_rate_pct > 0),
    CONSTRAINT ck_loans_remaining_within_total
        CHECK (remaining_balance <= total_payable)
);

CREATE INDEX IF NOT EXISTS ix_loans_status_active
    ON loans (created_at DESC)
    WHERE status = 'ACTIVE' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_loans_created_at
    ON loans (created_at DESC);

CREATE INDEX IF NOT EXISTS ix_loans_supplier
    ON loans (supplier_id)
    WHERE supplier_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_loans_lender_dni
    ON loans (lender_dni)
    WHERE lender_dni IS NOT NULL;

COMMENT ON TABLE loans IS
    'Préstamos recibidos por el negocio. NO se mezcla con expenses.PRESTAMO legacy: los nuevos préstamos entran por POST /api/loans; los legacy quedan intactos hasta que se decida una migración de datos separada.';
COMMENT ON COLUMN loans.lender_name IS
    'Nombre del acreedor como lo escribe el dueño. Se mantiene como campo libre (no FK a employees ni suppliers) porque muchos préstamos vienen de personas naturales sin cédula en el sistema.';
COMMENT ON COLUMN loans.lender_dni IS
    'DNI/cédula del acreedor cuando aplica. Nullable: permite préstamos informales sin dato de identidad en la base.';
COMMENT ON COLUMN loans.supplier_id IS
    'Proveedor que financió el préstamo (crédito de proveedor). FK dura con ON DELETE SET NULL para no perder el préstamo si el proveedor se elimina.';
COMMENT ON COLUMN loans.principal_amount IS
    'Capital recibido en COP. NUMERIC(14,2) elegida sobre decimal(10,2) de otras tablas monetarias para soportar préstamos grandes sin desbordar; los pagos agregados se mantienen bajo este techo.';
COMMENT ON COLUMN loans.interest_rate_pct IS
    'Porcentaje TOTAL FLAT que el acreedor cobra sobre el principal (ej. 10.000 = 10% total). NO es tasa nominal anual: no depende de payment_frequency y no se "anualiza". El interés total del préstamo es principal_amount * interest_rate_pct / 100.';
COMMENT ON COLUMN loans.interest_mode IS
    'NONE = sin interés; SIMPLE = interés total flat prorrateado en cuotas uniformes. FRENCH está reservado conceptualmente pero NO se admite en el CHECK porque el servicio Go lo bloquea con ErrFrenchNotImplemented; cuando se implemente, una migración 020+ ampliará el CHECK. El cronograma se calcula en loan_schedule.go y se persiste en loan_installments.';
COMMENT ON COLUMN loans.term_count IS
    'Número de cuotas del cronograma. Techo 600 (50 años mensuales) para que un typo accidental no genere un INSERT masivo de installments.';
COMMENT ON COLUMN loans.payment_frequency IS
    'Periodicidad entre cuotas: WEEKLY (7 días), BIWEEKLY (14 días), MONTHLY (mismo día del mes siguiente). El servicio Go calcula due_date usando America/Bogota para evitar off-by-one de zona horaria.';
COMMENT ON COLUMN loans.disbursement_channel IS
    'Canal por el que llegó el dinero (EFECTIVO, NEQUI, DAVIPLATA, FONDO, ...). Mismo repertorio que expenses.paymentSource; la validación de valores vive en el handler Go para no acoplar el vocabulario al esquema.';
COMMENT ON COLUMN loans.status IS
    'ACTIVE = con saldo pendiente; PAID = todas las cuotas liquidadas; DEFAULTED = en mora reconocida; CANCELLED = anulado administrativamente. El servicio lo recalcula tras cada pago/cambio.';
COMMENT ON COLUMN loans.total_payable IS
    'Monto total comprometido al firmar (principal + interés total flat). NUMERIC(14,2) para que la tarjeta "Cuentas por Pagar" del dashboard lea un número en vez de agregar sobre loan_installments. DEFAULT 0 porque la primera versión del backend aún no lo persiste explícitamente al INSERT; el servicio Go lo actualiza al terminar el cronograma. La relación principal_amount + interés total no se expresa como CHECK porque el interés vive en loan_installments.';
COMMENT ON COLUMN loans.remaining_balance IS
    'Saldo vivo del préstamo (total_payable - SUM(paid_amount)). CHECK remaining_balance >= 0 y la invariante table-level ck_loans_remaining_within_total garantizan que nunca sea negativo ni supere el total. DEFAULT 0 por el mismo motivo que total_payable: compatibilidad con el servicio actual, que todavía recalcula el saldo on-the-fly en ListWithStats.';
COMMENT ON COLUMN loans.deleted_at IS
    'Soft delete. El endpoint DELETE sólo lo setea si no hay cuotas pagadas (sin movimientos de dinero) y requiere rol admin. Los pagos ya hechos ANCLAN el préstamo: no se puede borrar un préstamo con pagos sin perder trazabilidad contable.';

-- ----------------------------------------------------------------------------
-- 2) loan_installments: el cronograma, una fila por cuota.
--
-- `principal_due` + `interest_due` = cuota total esperada. NO se declara
-- como columna generada (STORED) porque las migraciones actuales del POS
-- no usan GENERATED ALWAYS AS en ninguna otra tabla; mantenemos la
-- consistencia estilística y el servicio Go hace la suma en el único
-- lugar que la necesita (vista de amortización y validación de pago).
--
-- `paid_amount` es acumulador: cada pago parcial lo suma. Status derivado:
--   PENDING  → paid_amount = 0 y due_date >= hoy
--   PARTIAL  → 0 < paid_amount < principal_due + interest_due
--   PAID     → paid_amount >= principal_due + interest_due
--   LATE     → paid_amount < principal_due + interest_due y due_date < hoy
-- El CHECK de BD codifica el invariante mínimo: paid_amount nunca supera
-- la cuota más una pequeña tolerancia por redondeo (ver constraint).
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS loan_installments (
    id                      BIGSERIAL     PRIMARY KEY,
    loan_id                 BIGINT        NOT NULL
                                REFERENCES loans(id) ON DELETE CASCADE,
    number                  INTEGER       NOT NULL CHECK (number >= 1),
    due_date                DATE          NOT NULL,
    principal_due           NUMERIC(14,2) NOT NULL CHECK (principal_due >= 0),
    interest_due            NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (interest_due >= 0),
    paid_amount             NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
    paid_at                 TIMESTAMPTZ,
    settlement_expense_id   INTEGER,
    status                  VARCHAR(16)   NOT NULL DEFAULT 'PENDING'
                                CHECK (status IN ('PENDING', 'PARTIAL', 'PAID', 'LATE')),
    created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_loan_installment_number UNIQUE (loan_id, number),
    CONSTRAINT ck_loan_installment_total_positive
        CHECK (principal_due + interest_due > 0),
    CONSTRAINT ck_loan_installment_paid_within_total
        CHECK (paid_amount <= principal_due + interest_due + 0.01),
    CONSTRAINT ck_loan_installment_paid_at_requires_paid
        CHECK ((paid_at IS NULL) OR (paid_amount > 0))
);

CREATE INDEX IF NOT EXISTS ix_loan_installments_loan
    ON loan_installments (loan_id, number);

CREATE INDEX IF NOT EXISTS ix_loan_installments_due_open
    ON loan_installments (due_date)
    WHERE status <> 'PAID';

CREATE INDEX IF NOT EXISTS ix_loan_installments_status
    ON loan_installments (status);

CREATE INDEX IF NOT EXISTS ix_loan_installments_settlement
    ON loan_installments (settlement_expense_id)
    WHERE settlement_expense_id IS NOT NULL;

COMMENT ON TABLE loan_installments IS
    'Cronograma de cuotas de un préstamo. Lo genera el servicio Go al crear el loan y lo materializa aquí para que el detalle de amortización, los pagos y el cálculo de saldo sean lecturas simples. Si se renegocia el préstamo, el servicio debe anular las cuotas futuras (CANCELLED en el status del loan) y crear filas nuevas; NUNCA edita cuotas existentes.';
COMMENT ON COLUMN loan_installments.number IS
    'Secuencia 1..term_count. UNIQUE con loan_id para que no se dupliquen por una carrera. NO es la PK por diseño: GORM/Go prefiere un id autoincremental para joins.';
COMMENT ON COLUMN loan_installments.principal_due IS
    'Parte de capital de la cuota. En FRENCH varía por cuota; en SIMPLE y NONE es constante salvo el ajuste de redondeo en la última.';
COMMENT ON COLUMN loan_installments.interest_due IS
    'Parte de interés de la cuota. 0 cuando interest_mode = NONE. El residuo de redondeo se absorbe en la última cuota para que la suma del cronograma empate con principal + interés total.';
COMMENT ON COLUMN loan_installments.paid_amount IS
    'Acumulador de lo pagado sobre esta cuota. Un pago parcial lo suma; el CHECK ck_loan_installment_paid_within_total impide que supere la cuota (con 1 centavo de tolerancia por redondeo). El servicio recalcula status tras cada pago.';
COMMENT ON COLUMN loan_installments.settlement_expense_id IS
    'ID del último expense que liquidó o abonó esta cuota. Soft FK (INTEGER sin REFERENCES) porque expenses tiene soft delete; preservar el audit aun si el expense se da de baja. Mismo patrón que cash_drawer_opens.sale_id en la 016.';
COMMENT ON COLUMN loan_installments.status IS
    'PENDING = sin pago; PARTIAL = pago parcial; PAID = cuota saldada; LATE = vencida sin pagar o con pago parcial. El servicio lo recalcula tras cada pago y a diario (job orchestrator) para marcar las vencidas.';

-- ----------------------------------------------------------------------------
-- 3) loan_expenses: en qué se gastó el principal del préstamo.
--
-- Cuando el dueño paga una factura con el dinero del préstamo, el flujo es:
--
--   1) Se crea el `expenses` normal (categoría, proveedor, montos por canal).
--   2) Se inserta aquí la fila que ata ese gasto al préstamo con el monto
--      consumido del principal (`amount_used`). Normalmente coincide con
--      `expenses.amount`, pero pueden diferir si una parte del gasto se
--      cubrió con otra fuente.
--
-- La invariante "suma de amount_used <= principal_amount del loan" la valida
-- el servicio Go dentro de la transacción del INSERT. No se expresa como
-- CHECK a nivel de fila porque depende de SUM() sobre otras filas (los
-- CHECKs de PostgreSQL no pueden ser SELECT); se protege con SELECT
-- FOR UPDATE sobre el loan + conteo antes del INSERT.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS loan_expenses (
    id             BIGSERIAL     PRIMARY KEY,
    loan_id        BIGINT        NOT NULL
                       REFERENCES loans(id) ON DELETE CASCADE,
    expense_id     INTEGER,
    amount_used    NUMERIC(14,2) NOT NULL CHECK (amount_used > 0),
    purpose        VARCHAR(255),
    created_by_dni VARCHAR(32)   NOT NULL,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_loan_expenses_loan
    ON loan_expenses (loan_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_loan_expenses_expense
    ON loan_expenses (expense_id)
    WHERE expense_id IS NOT NULL;

COMMENT ON TABLE loan_expenses IS
    'Libro de "en qué se me fue el crédito": vincula un gasto físico (expenses) con el préstamo que lo financió, con el monto consumido del principal. La suma de amount_used por loan no debe superar loans.principal_amount; esa invariante la valida el servicio Go con SELECT FOR UPDATE del loan dentro de la transacción del INSERT.';
COMMENT ON COLUMN loan_expenses.expense_id IS
    'ID del expense físico que registró el egreso. Soft FK (INTEGER sin REFERENCES) porque expenses tiene soft delete; preservar el audit aun si el expense se da de baja. Nullable para permitir registrar un uso del principal sin expense asociado (ej. retiro en efectivo que no corresponde todavía a un gasto fiscal).';
COMMENT ON COLUMN loan_expenses.amount_used IS
    'Monto del principal consumido por este uso. Normalmente coincide con expenses.amount, pero puede ser menor si el gasto se cubrió parcialmente con otra fuente (caja, otro préstamo).';
COMMENT ON COLUMN loan_expenses.purpose IS
    'Descripción corta y libre del uso ("Pago factura Alpina", "Nómina quincena 2026-10-15"). Se usa en la pantalla de control de gastos del préstamo; no se busca ni se indexa.';
