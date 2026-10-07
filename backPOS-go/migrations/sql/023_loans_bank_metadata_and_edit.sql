-- Sprint 14 (cont.): metadata bancaria editable del préstamo.
--
-- POR QUÉ existe esta migración
-- ============================================================================
-- Las 019 y 021 modelaron la mecánica interna del préstamo (principal,
-- cronograma, interés en modos NONE/SIMPLE/FRENCH, seguro mensual, FGA
-- diferido). La 022 habilitó pagos de deuda reversibles contra el
-- principal.
--
-- Lo que no modelaron es la metadata que trae un crédito bancario real
-- y que el dueño necesita ver y editar sin tocar la aritmética del
-- cronograma: número de crédito del banco, tipo (CONSUMO,
-- HIPOTECARIO...), titular/deudor (distinto del lender), moneda, tipo
-- de tasa (FIJO/VARIABLE), tasa de mora EA, pago automático,
-- vencimiento final (distinto de first_payment_date), desembolso neto,
-- desglose de IVA/GMF del FGA, snapshot del banco (saldo consultado +
-- fecha + saldo pagado), y la cuota oficial próxima que reporta el
-- banco por su lado.
--
-- Esta migración SÓLO abre los huecos en el esquema para que el flujo
-- de edición (PUT /api/loans/:id) y el formulario de alta puedan
-- persistir esos campos. NO cambia nada del cálculo contable interno
-- (remaining_balance, cronograma, interés). NO backfillea préstamos
-- heredados: todos los campos nuevos quedan con defaults seguros o
-- NULL hasta que un admin los edite.
--
-- SEMÁNTICA DECIDIDA (crítica, leer antes de tocar nada)
-- ============================================================================
-- Hay DOS tipos de dato distintos que esta migración introduce y que
-- NUNCA deben mezclarse:
--
--   (A) Metadata editable del crédito. El dueño la escribe/edita. Es
--       parte del contrato con el banco pero NO alimenta el cálculo
--       del cronograma estimado por este POS.
--
--         credit_number, loan_type, holder_name, holder_dni,
--         currency, rate_type, auto_debit, maturity_date,
--         late_annual_effective_rate_pct, net_disbursement_amount,
--         fga_iva_amount, fga_gmf_amount
--
--   (B) Snapshot autoritativo del banco. El dueño lo copia tal cual
--       del extracto. El POS lo persiste y lo muestra al lado del
--       saldo contable interno, pero NUNCA lo usa para reescribir
--       remaining_balance ni para "corregir" la cuota estimada: una
--       conciliación automática silenciosa es exactamente el bug que
--       se evita con la separación.
--
--         bank_balance_amount, bank_balance_as_of, bank_paid_amount,
--         official_next_installment_amount,
--         official_next_installment_date
--
-- La separación persiste en la BD precisamente para que la UI, los
-- reportes y cualquier job que lea estas columnas no puedan confundir
-- "lo que el banco dice que debo" con "lo que el POS calculó que
-- debo". La reconciliación es una decisión operativa.
--
-- POR QUÉ loan_type SÍ ES CHECK ESTRICTO Y currency TAMBIÉN
-- ============================================================================
-- Igual que interest_mode (019/021) o status, el repertorio aquí es
-- cerrado y la BD debe ser el guardián más estricto. Si un handler
-- nuevo deja pasar 'VEHICULOS' (plural) o 'HIPOTECA' (sin -ARIO), el
-- dashboard que agrupa por tipo quedaría con categorías duplicadas y
-- habría que limpiar datos a mano. CHECK IN(...) es la forma más
-- barata de evitarlo. Si el día de mañana aparece un tipo nuevo
-- (p. ej. 'EDUCATIVO'), una migración 024+ lo amplía con DROP + ADD
-- CONSTRAINT (patrón de la 021 para interest_mode).
--
-- Nota ortográfica: `VEHICULO` sin tilde a propósito. El dato va a
-- ejes de agregación y a filtros de URL; `VEHÍCULO` arrastraría
-- problemas de encoding en logs, exportes CSV y DISTINCT sobre
-- fuentes que normalicen Unicode. La UI puede mostrar el acento al
-- usuario, el valor persistido es ASCII.
--
-- POR QUÉ EL "DESGLOSE DEL FGA" NO ES UNA COLUMNA DERIVADA
-- ============================================================================
-- Hoy loans.fga_total_amount es "el FGA que la entidad cobra una
-- vez". Pero el banco reporta tres líneas: FGA puro, IVA sobre el
-- FGA, y GMF. Para que la pantalla "Datos del banco" muestre lo que
-- el usuario ve en el extracto sin recalcular, se persisten las dos
-- líneas adicionales como columnas propias (fga_iva_amount,
-- fga_gmf_amount). El total con impuestos (fga_total_amount +
-- fga_iva_amount + fga_gmf_amount) lo suma el frontend; NO se
-- declara como GENERATED ALWAYS AS STORED porque las migraciones del
-- POS no usan generadas en ninguna otra tabla y mezclar estilos
-- genera confusión al leer el esquema. En NONE/SIMPLE y en préstamos
-- heredados las dos columnas quedan en 0 por DEFAULT; no cambia nada.
--
-- POR QUÉ EL SNAPSHOT DEL BANCO ES UN TRIO ATADO
-- ============================================================================
-- Un `bank_balance_amount` sin `bank_balance_as_of` es un dato huérfano:
-- no sé cuándo fue consultado, así que no sé si está desactualizado.
-- Un `bank_balance_as_of` sin monto es basura: sé que miré el banco
-- pero no sé qué vi. El CHECK `ck_loans_bank_snapshot_coherent`
-- amarra ambos: o los dos existen o los dos son NULL. `bank_paid_amount`
-- queda ligado al snapshot: no tiene sentido sin él.
--
-- Mismo tratamiento para `official_next_installment_amount` y
-- `official_next_installment_date`: si el banco reporta una próxima
-- cuota, viene con monto Y fecha. Un sólo lado huérfano sería ruido
-- en la UI.
--
-- POR QUÉ maturity_date >= start_date
-- ============================================================================
-- `start_date` es la fecha del desembolso. `maturity_date` es cuándo
-- vence el crédito según el banco. Un vencimiento anterior al
-- desembolso es un dato imposible. El CHECK admite NULL para no
-- forzar un backfill de los préstamos existentes (que no tienen
-- maturity_date informado), pero prohíbe inconsistencias de los
-- préstamos nuevos.
--
-- No se declara una comparación entre `maturity_date` y
-- `first_payment_date` ni con el final del cronograma: el banco a
-- veces reporta vencimientos que no coinciden al día con n cuotas
-- (p. ej. último día hábil, redondeos de cronograma oficial vs
-- estimado). Esos deltas se muestran en UI, no se corrigen por CHECK.
--
-- POR QUÉ late_annual_effective_rate_pct ES COLUMNA Y NO JUSTO EN RATE
-- ============================================================================
-- La tasa de mora es un contrato distinto al de corriente: puede ser
-- cero (como en el caso real que motivó la migración), puede ser
-- mayor que la EA corriente, o puede ser legalmente fijada por tope.
-- Mezclarla con `annual_effective_rate_pct` requeriría contexto para
-- distinguir "tasa de la cuota" de "tasa de mora", y los reportes se
-- confundirían. Columna propia + techo defensivo 1000% EA (mismo
-- patrón que `annual_effective_rate_pct` en la 021) + DEFAULT 0 para
-- que los préstamos heredados no violen NOT NULL.
--
-- POR QUÉ ÍNDICE SÓLO SOBRE credit_number
-- ============================================================================
-- Los demás campos son cardinales bajos (tipo, moneda, rate_type,
-- auto_debit) o descriptivos (holder_name, holder_dni): un índice
-- plano no justificaría el costo de mantenimiento (INSERT y UPDATE
-- de loans no son tabla fría). `credit_number` sí es alta cardinalidad
-- y la operación "buscar el préstamo por número de crédito del banco"
-- es realista desde la pantalla de administración, así que un índice
-- parcial sobre no-NULL vale la pena. No es UNIQUE a propósito: el
-- mismo número de crédito podría replicarse si un préstamo se
-- registra dos veces por error, y la unicidad la aplicamos en el
-- flujo de alta/edición (409 LOAN_DUPLICATE_CREDIT_NUMBER) donde
-- hay contexto operativo para resolverlo.
--
-- NO MODIFICA DATOS DE NEGOCIO
-- ============================================================================
-- Puramente DDL: ALTER TABLE ADD COLUMN IF NOT EXISTS con defaults
-- constantes, ALTER TABLE ADD CONSTRAINT con guardias de existencia,
-- CREATE INDEX IF NOT EXISTS y COMMENT ON COLUMN. Ni un UPDATE, ni
-- un DELETE, ni un INSERT. Los préstamos existentes NO se recalculan:
-- quedan con `loan_type='OTRO'`, `currency='COP'`, `rate_type='FIJO'`,
-- `auto_debit=FALSE`, `late_annual_effective_rate_pct=0` y el resto en
-- NULL. Un admin los edita por PUT /api/loans/:id cuando corresponda.
-- Un backfill masivo requeriría decisiones por préstamo (¿qué tipo
-- es?, ¿cuál es la mora?) que esta migración, por política, no toma.
--
-- TRANSACCIONAL: SÍ
-- ============================================================================
-- No usa CREATE INDEX CONCURRENTLY. Todas las operaciones son ALTER
-- TABLE con defaults constantes (fast-path desde PostgreSQL 11, no
-- reescribe la tabla), ADD CONSTRAINT con guardia DO y CREATE INDEX
-- IF NOT EXISTS plano sobre `credit_number`. Corre dentro de la
-- transacción por defecto del runner; un fallo deja la BD intacta.
-- Por eso catalog.go NO añade la 023 a la lista de excepciones no
-- transaccionales (hoy 8, 9, 11, 13, 14, 15 y 18).
--
-- IDEMPOTENTE
-- ============================================================================
-- ADD COLUMN IF NOT EXISTS para cada columna, bloques DO que
-- verifican pg_constraint antes de ADD CONSTRAINT, CREATE INDEX IF
-- NOT EXISTS y COMMENT ON (idempotente por naturaleza). Un reintento
-- después de un fallo parcial (muy improbable estando en transacción,
-- pero posible si alguien corre el SQL por fuera del runner) no la
-- rompe.
--
-- DEPENDE SEMÁNTICAMENTE DE 019/021 (NO DE 022)
-- ============================================================================
-- Toca sólo la tabla `loans`, cuyas columnas base vienen de la 019 y
-- de la 021 (annual_effective_rate_pct existe desde la 021 y la
-- comparación con mora EA ocurre en el servicio, no aquí). La 022
-- toca `loan_expenses`: esta migración no la asume aplicada y no la
-- bloquea. Operativamente, cuando el equipo abra una ventana, aplica
-- 022 y 023 en orden en la misma ventana (el runner valida
-- contiguidad por checksum). Si por error se aplicara 023 sin 022,
-- el esquema de `loans` queda correcto; el flujo de reversión de
-- pagos sólo opera cuando la 022 también exista.

-- ----------------------------------------------------------------------------
-- 1) loans: columnas nuevas de metadata editable y snapshot bancario.
--
-- NUMERIC(14,2) para dinero, por consistencia con la 019/021.
-- NUMERIC(9,6) para la tasa de mora EA, por consistencia con
-- annual_effective_rate_pct.
-- VARCHAR con límites por consistencia con lender_name (120) y
-- lender_dni (32); credit_number acepta hasta 64 chars porque los
-- bancos usan formatos con guiones (ej. "0013-0021-96-00322102"
-- son 21 chars pero conviene dejar aire).
-- holder_name queda en 160 (más grande que lender_name) porque los
-- titulares bancarios usan nombres compuestos legales (NN1 NN2 AP1 AP2)
-- que superan 120 en una fracción no despreciable de clientes.
-- ----------------------------------------------------------------------------

ALTER TABLE loans
    ADD COLUMN IF NOT EXISTS credit_number                    VARCHAR(64),
    ADD COLUMN IF NOT EXISTS loan_type                        VARCHAR(16)   NOT NULL DEFAULT 'OTRO',
    ADD COLUMN IF NOT EXISTS holder_name                      VARCHAR(160),
    ADD COLUMN IF NOT EXISTS holder_dni                       VARCHAR(32),
    ADD COLUMN IF NOT EXISTS currency                         VARCHAR(8)    NOT NULL DEFAULT 'COP',
    ADD COLUMN IF NOT EXISTS rate_type                        VARCHAR(16)   NOT NULL DEFAULT 'FIJO',
    ADD COLUMN IF NOT EXISTS auto_debit                       BOOLEAN       NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS maturity_date                    DATE,
    ADD COLUMN IF NOT EXISTS late_annual_effective_rate_pct   NUMERIC(9,6)  NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS net_disbursement_amount          NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS fga_iva_amount                   NUMERIC(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS fga_gmf_amount                   NUMERIC(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS bank_balance_amount              NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS bank_balance_as_of               TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS bank_paid_amount                 NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS official_next_installment_amount NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS official_next_installment_date   DATE;

-- CHECKs declarados con nombre + guardia de existencia. El esquema de la
-- 021 ya demostró que es el único patrón robusto frente a bases heredadas
-- donde los nombres autogenerados pueden colisionar o diferir del nombre
-- esperado.
DO $$
BEGIN
    -- Enum cerrado de tipos de crédito. 'OTRO' es el bucket para
    -- préstamos informales o legacy que no encajan en una categoría
    -- bancaria clara.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loans'::regclass
          AND conname = 'ck_loans_loan_type'
    ) THEN
        ALTER TABLE loans
            ADD CONSTRAINT ck_loans_loan_type
            CHECK (loan_type IN ('CONSUMO', 'HIPOTECARIO', 'LIBRANZA', 'COMERCIAL', 'VEHICULO', 'OTRO'));
    END IF;

    -- Enum cerrado de tipo de tasa. FIJO = la EA no cambia durante la
    -- vida del crédito; VARIABLE = sí (DTF+spread o IBR+spread, por
    -- ejemplo). El motor de amortización HOY asume FIJO; VARIABLE se
    -- persiste como metadata para que la UI lo advierta y para
    -- preparar el terreno a recálculos periódicos en el futuro.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loans'::regclass
          AND conname = 'ck_loans_rate_type'
    ) THEN
        ALTER TABLE loans
            ADD CONSTRAINT ck_loans_rate_type
            CHECK (rate_type IN ('FIJO', 'VARIABLE'));
    END IF;

    -- Moneda cerrada: COP y USD. Si llegara EUR u otra, se amplía por
    -- migración (DROP + ADD, patrón 021). No se admite texto libre
    -- para que agregaciones y conversiones no vean valores sucios.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loans'::regclass
          AND conname = 'ck_loans_currency_known'
    ) THEN
        ALTER TABLE loans
            ADD CONSTRAINT ck_loans_currency_known
            CHECK (currency IN ('COP', 'USD'));
    END IF;

    -- Tasa de mora EA no negativa y con techo defensivo. Mismo rango que
    -- annual_effective_rate_pct (ver 021): a partir de 1000% EA es más
    -- probable un typo del operador que una tasa real.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loans'::regclass
          AND conname = 'ck_loans_late_rate_range'
    ) THEN
        ALTER TABLE loans
            ADD CONSTRAINT ck_loans_late_rate_range
            CHECK (late_annual_effective_rate_pct >= 0 AND late_annual_effective_rate_pct <= 1000);
    END IF;

    -- Vencimiento no puede ser anterior al desembolso. Admite NULL para
    -- no forzar backfill en préstamos heredados.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loans'::regclass
          AND conname = 'ck_loans_maturity_after_start'
    ) THEN
        ALTER TABLE loans
            ADD CONSTRAINT ck_loans_maturity_after_start
            CHECK (maturity_date IS NULL OR maturity_date >= start_date);
    END IF;

    -- Desglose del FGA: cada línea no negativa. DEFAULT 0 cubre a los
    -- préstamos heredados y a los nuevos NONE/SIMPLE donde el FGA no
    -- aplica.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loans'::regclass
          AND conname = 'ck_loans_fga_breakdown_non_negative'
    ) THEN
        ALTER TABLE loans
            ADD CONSTRAINT ck_loans_fga_breakdown_non_negative
            CHECK (fga_iva_amount >= 0 AND fga_gmf_amount >= 0);
    END IF;

    -- Desembolso neto: si se informa, debe ser no negativo. NULLable
    -- porque los préstamos heredados no tienen este dato y la UI lo
    -- debe mostrar como "sin dato" en vez de un cero engañoso.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loans'::regclass
          AND conname = 'ck_loans_net_disbursement_non_negative'
    ) THEN
        ALTER TABLE loans
            ADD CONSTRAINT ck_loans_net_disbursement_non_negative
            CHECK (net_disbursement_amount IS NULL OR net_disbursement_amount >= 0);
    END IF;

    -- Snapshot bancario: coherencia del trio.
    --   * bank_balance_amount y bank_balance_as_of van siempre juntos: o
    --     ambos NULL (sin consulta registrada) o ambos NOT NULL
    --     (consulta con fecha). Un lado huérfano es ruido.
    --   * bank_paid_amount sólo tiene sentido si el snapshot existe (el
    --     "pagado al banco" es relativo a un momento consultado).
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loans'::regclass
          AND conname = 'ck_loans_bank_snapshot_coherent'
    ) THEN
        ALTER TABLE loans
            ADD CONSTRAINT ck_loans_bank_snapshot_coherent
            CHECK (
                (bank_balance_amount IS NULL AND bank_balance_as_of IS NULL)
                OR
                (bank_balance_amount IS NOT NULL AND bank_balance_as_of IS NOT NULL)
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loans'::regclass
          AND conname = 'ck_loans_bank_paid_requires_snapshot'
    ) THEN
        ALTER TABLE loans
            ADD CONSTRAINT ck_loans_bank_paid_requires_snapshot
            CHECK (bank_paid_amount IS NULL OR bank_balance_amount IS NOT NULL);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loans'::regclass
          AND conname = 'ck_loans_bank_balance_non_negative'
    ) THEN
        ALTER TABLE loans
            ADD CONSTRAINT ck_loans_bank_balance_non_negative
            CHECK (bank_balance_amount IS NULL OR bank_balance_amount >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loans'::regclass
          AND conname = 'ck_loans_bank_paid_non_negative'
    ) THEN
        ALTER TABLE loans
            ADD CONSTRAINT ck_loans_bank_paid_non_negative
            CHECK (bank_paid_amount IS NULL OR bank_paid_amount >= 0);
    END IF;

    -- Cuota oficial próxima: monto y fecha van juntos. Ambos NULL o
    -- ambos NOT NULL.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loans'::regclass
          AND conname = 'ck_loans_official_next_coherent'
    ) THEN
        ALTER TABLE loans
            ADD CONSTRAINT ck_loans_official_next_coherent
            CHECK (
                (official_next_installment_amount IS NULL AND official_next_installment_date IS NULL)
                OR
                (official_next_installment_amount IS NOT NULL AND official_next_installment_date IS NOT NULL)
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loans'::regclass
          AND conname = 'ck_loans_official_installment_non_negative'
    ) THEN
        ALTER TABLE loans
            ADD CONSTRAINT ck_loans_official_installment_non_negative
            CHECK (official_next_installment_amount IS NULL OR official_next_installment_amount >= 0);
    END IF;
END $$;

-- Índice parcial sobre credit_number. Se omite UNIQUE a propósito: la
-- unicidad la impone el handler Go al crear/editar un préstamo
-- (409 LOAN_DUPLICATE_CREDIT_NUMBER), donde hay contexto operativo
-- para resolver si una colisión es un error humano o un préstamo
-- duplicado real a reconciliar. Un UNIQUE a nivel BD obligaría a
-- borrar o marcar duplicados durante una migración, decisión que no
-- queremos tomar en el DDL.
CREATE INDEX IF NOT EXISTS ix_loans_credit_number
    ON loans (credit_number)
    WHERE credit_number IS NOT NULL;

-- ----------------------------------------------------------------------------
-- COMMENT ON COLUMN: cada columna nueva lleva su justificación persistida
-- con el esquema. pg_dump --schema-only la arrastra; auditorías
-- posteriores leen la razón sin tener que abrir el archivo .sql.
-- ----------------------------------------------------------------------------

COMMENT ON COLUMN loans.credit_number IS
    'Número de crédito tal como lo reporta la entidad financiera (ej. "0013-0021-96-00322102"). Dato editable, NULL en préstamos informales o heredados. No es UNIQUE a nivel BD: la validación de duplicados vive en el handler Go al crear/editar con contexto operativo.';
COMMENT ON COLUMN loans.loan_type IS
    'Tipo de crédito según la entidad (CONSUMO, HIPOTECARIO, LIBRANZA, COMERCIAL, VEHICULO, OTRO). "VEHICULO" sin tilde a propósito: el valor persistido es ASCII para evitar problemas de encoding en exportes y DISTINCT; la UI muestra la tilde al usuario. Default "OTRO" para préstamos heredados y nuevos no bancarios.';
COMMENT ON COLUMN loans.holder_name IS
    'Nombre del titular/deudor del crédito, distinto del lender (acreedor). En préstamos bancarios suele ser el dueño del negocio; en préstamos informales puede coincidir con lender_name. Nullable para préstamos heredados y campo libre (sin FK a employees) para contemplar titulares que no están en el sistema.';
COMMENT ON COLUMN loans.holder_dni IS
    'DNI/cédula del titular/deudor cuando aplica. Nullable: no todos los contratos exigen DNI en el POS, y los préstamos heredados no lo tienen.';
COMMENT ON COLUMN loans.currency IS
    'Moneda del crédito. Enum cerrado (COP, USD) para que agregaciones y conversiones no vean texto sucio. Default COP; una futura migración podrá ampliar el enum si aparece otra moneda operativa.';
COMMENT ON COLUMN loans.rate_type IS
    'FIJO = la EA no cambia; VARIABLE = sí (DTF+spread, IBR+spread, etc.). El motor de amortización asume FIJO; VARIABLE se persiste como metadata para que la UI lo advierta y para preparar recálculos periódicos. Default FIJO.';
COMMENT ON COLUMN loans.auto_debit IS
    'TRUE si el banco debita automáticamente la cuota de una cuenta del titular. Es informativo para la UI y la planificación de caja; el POS no ejecuta débitos automáticos. Default FALSE.';
COMMENT ON COLUMN loans.maturity_date IS
    'Fecha de vencimiento final del crédito según el contrato bancario. Puede diferir del due_date de la última cuota del cronograma estimado (redondeos, día hábil). Nullable para préstamos heredados; cuando se informa debe ser >= start_date.';
COMMENT ON COLUMN loans.late_annual_effective_rate_pct IS
    'Tasa Efectiva Anual porcentual que cobra la entidad por mora. Columna separada de annual_effective_rate_pct porque los contratos y los reportes diferencian "tasa corriente" de "tasa de mora". Default 0 para que los préstamos heredados no violen NOT NULL; techo defensivo 1000% EA.';
COMMENT ON COLUMN loans.net_disbursement_amount IS
    'Monto neto efectivamente desembolsado al titular. Para créditos bancarios es principal_amount - FGA - IVA del FGA - GMF. Nullable: los préstamos heredados no tienen este desglose y la UI debe mostrarlo como "sin dato" en vez de un cero que parezca real.';
COMMENT ON COLUMN loans.fga_iva_amount IS
    'IVA cobrado sobre el FGA al desembolso. Separado de fga_total_amount para que la UI reproduzca el extracto bancario línea por línea. Default 0; en NONE/SIMPLE y préstamos heredados queda en 0.';
COMMENT ON COLUMN loans.fga_gmf_amount IS
    'GMF (gravamen a los movimientos financieros, 4x1000 en Colombia) cobrado al desembolso por el FGA. Separado de fga_total_amount por la misma razón que fga_iva_amount. Default 0.';
COMMENT ON COLUMN loans.bank_balance_amount IS
    'Saldo que reporta el banco en la consulta registrada (snapshot). NO es contable: el saldo interno del POS vive en remaining_balance y nunca se reescribe desde esta columna. La UI muestra ambos lado a lado y el delta queda documentado, no se concilia automáticamente. Nullable y ligado a bank_balance_as_of por el CHECK ck_loans_bank_snapshot_coherent.';
COMMENT ON COLUMN loans.bank_balance_as_of IS
    'Momento en que se consultó el saldo del banco. Sin este dato, bank_balance_amount es un número huérfano y la UI no puede advertir que está desactualizado. Nullable, pero ligado a bank_balance_amount: o ambos existen o ambos son NULL.';
COMMENT ON COLUMN loans.bank_paid_amount IS
    'Monto pagado al banco según el extracto en el snapshot. Nullable; sólo tiene sentido si existe bank_balance_amount (CHECK ck_loans_bank_paid_requires_snapshot).';
COMMENT ON COLUMN loans.official_next_installment_amount IS
    'Valor de la próxima cuota tal como lo reporta el banco. Dato autoritativo del extracto: la UI del detalle lo muestra encima del cronograma estimado por el POS. Un delta frente a la cuota calculada (base + seguro + FGA mensual) NO se corrige manipulando la tasa; se documenta. Nullable y ligado a official_next_installment_date.';
COMMENT ON COLUMN loans.official_next_installment_date IS
    'Fecha de la próxima cuota reportada por el banco. Puede diferir del due_date de la primera cuota PENDIENTE del cronograma estimado por calendario del banco. Nullable y ligada a official_next_installment_amount.';
