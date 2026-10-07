-- Sprint 14: préstamos bancarios con Sistema Francés (interest_mode =
-- 'FRENCH'), seguro MENSUAL fijo y FGA (Fondo de Garantías) TOTAL
-- diferido entre todas las cuotas.
--
-- POR QUÉ existe esta migración
-- ============================================================================
-- La migración 019 creó el módulo con dos modos: NONE (sin interés) y
-- SIMPLE (interés total flat prorrateado en cuotas uniformes). Ese modelo
-- cubre préstamos informales con un acreedor directo, pero NO sirve para
-- los créditos bancarios reales que empezaron a entrar en el POS:
-- Davivienda, Bancolombia y las cooperativas trabajan con Sistema
-- Francés sobre tasa Efectiva Anual (EA), más un seguro de desempleo /
-- vida deudor MENSUAL fijo, más un FGA cobrado una sola vez al
-- desembolso que esta implementación DIFIERE entre las cuotas para que
-- la cuota mensual total refleje el costo real del crédito.
--
-- El dueño pidió que esto conviva con lo existente, no que lo reemplace:
--
--   - Los préstamos NONE/SIMPLE ya creados siguen funcionando exactamente
--     igual. Esta migración NO los toca, no reinterpreta su interés, no
--     recalcula sus cuotas, no cambia sus saldos.
--   - Un nuevo valor de `interest_mode` = 'FRENCH' habilita la aritmética
--     francesa. El CHECK de BD lo admite; el servicio Go dejará de
--     devolver ErrInvalidInterestMode para ese valor en una etapa
--     posterior del sprint.
--   - Las nuevas columnas tienen DEFAULT 0 para que los INSERT heredados
--     de la ruta NONE/SIMPLE sigan pasando sin cambios en el handler ni
--     en el repositorio.
--
-- SEMÁNTICA DECIDIDA (crítica, leer antes de tocar nada)
-- ============================================================================
-- La diferencia conceptual entre seguro y FGA es la razón de que sean dos
-- columnas distintas en vez de "cargos extra":
--
--   `annual_effective_rate_pct` — tasa Efectiva Anual porcentual.
--       21.3% se guarda como 21.300000. La conversión a tasa mensual
--       que usa el cronograma es
--
--           i_m = (1 + annual_effective_rate_pct/100)^(1/12) - 1
--
--       y la calcula el servicio Go. NO se persiste la mensual
--       derivada: es determinística sobre esta columna.
--
--   `monthly_insurance_amount` — seguro MENSUAL fijo. El valor
--       ingresado por el usuario es lo que la entidad cobra cada mes.
--       NO se difiere: se replica igual en todas las cuotas. En
--       NONE/SIMPLE queda en 0.
--
--   `fga_total_amount` — FGA TOTAL que la entidad cobra una sola vez al
--       firmar. El POS lo DIFIERE entre todas las cuotas (dividido
--       entre term_count) para que la cuota mensual total refleje el
--       costo real del crédito. NO es un valor mensual. En NONE/SIMPLE
--       queda en 0.
--
--   `monthly_fga_amount` — FGA diferido por cuota ≈ fga_total_amount /
--       term_count, redondeado a 2 decimales por el servicio Go al
--       crear el préstamo. Se persiste para no recalcular en cada
--       vista; el residuo de redondeo lo absorbe la última cuota del
--       cronograma en loan_installments.fga_due. En NONE/SIMPLE queda
--       en 0.
--
--   `base_installment_amount` — cuota base calculada por el Sistema
--       Francés:
--
--           cuota = P * [ i(1+i)^n ] / [ (1+i)^n - 1 ]
--
--       donde P = principal_amount, i = tasa mensual derivada de
--       annual_effective_rate_pct, n = term_count. Se persiste para
--       auditoría y para que la UI pueda mostrar la descomposición
--       "base + seguro + FGA mensual = total mensual" sin recalcular.
--       Para el caso de referencia P=25_000_000, n=60, EA=21.3%
--       (MV≈1.62%) debe salir ≈ 655_300. En NONE/SIMPLE queda en 0.
--
-- Para el frontend, la cuota mensual que ve el cliente es
--
--     base_installment_amount + monthly_insurance_amount + monthly_fga_amount
--
-- y por cuota eso vive en principal_due + interest_due + insurance_due +
-- fga_due (ver abajo).
--
-- COMPONENTES EXPLÍCITOS EN loan_installments
-- ============================================================================
-- El frontend hoy suma "cuota base + seguro mensual + FGA diferido
-- mensual" para pintar la cuota total. Si eso lo calculara el frontend
-- sobre columnas derivadas, un reporte offline, un recálculo nocturno o
-- un pago masivo divergirían silenciosamente de lo que ve el usuario y
-- sería muy difícil cuadrar al centavo. Para evitarlo persistimos los
-- componentes POR CUOTA:
--
--   - `insurance_due` — seguro mensual que corresponde a la cuota. En
--                       NONE/SIMPLE: 0. En FRENCH: igual a
--                       loans.monthly_insurance_amount en todas las
--                       cuotas (no se difiere).
--   - `fga_due`       — FGA diferido de la cuota. En NONE/SIMPLE: 0. En
--                       FRENCH: ≈ loans.monthly_fga_amount salvo la
--                       última cuota, que absorbe el residuo de
--                       redondeo para que SUM(fga_due) =
--                       loans.fga_total_amount al centavo.
--
-- Así `principal_due + interest_due + insurance_due + fga_due` es lo que
-- efectivamente paga el cliente cada mes y lo que compara el CHECK de
-- paid_amount (ver abajo).
--
-- POR QUÉ SE AMPLÍA EL CHECK DE paid_amount
-- ============================================================================
-- La 019 declaró:
--
--     ck_loan_installment_paid_within_total:
--         paid_amount <= principal_due + interest_due + 0.01
--
-- Para una cuota FRENCH que incluye seguro + FGA, un pago COMPLETO
-- (base + seguro + FGA) supera ese límite. Hay que reemplazar el CHECK
-- por:
--
--     paid_amount <= principal_due + interest_due + insurance_due + fga_due + 0.01
--
-- Para filas existentes NONE/SIMPLE (con insurance_due = 0 y fga_due =
-- 0 por DEFAULT) el nuevo CHECK es EXACTAMENTE equivalente al anterior,
-- así que no invalida ningún dato previo.
--
-- POR QUÉ SE AMPLÍA ck_loans_interest_requires_rate
-- ============================================================================
-- La 019 pedía: (interest_mode = 'NONE' OR interest_rate_pct > 0). Para
-- FRENCH la tasa que importa es `annual_effective_rate_pct` (EA), no
-- `interest_rate_pct` (que sigue siendo FLAT TOTAL). Se reemplaza por:
--
--     interest_mode = 'NONE'
--  OR (interest_mode = 'SIMPLE' AND interest_rate_pct > 0)
--  OR (interest_mode = 'FRENCH' AND annual_effective_rate_pct > 0)
--
-- Esto además es MÁS estricto que la 019 porque amarra cada modo a la
-- columna de tasa que efectivamente usa. Para los préstamos NONE/SIMPLE
-- existentes el predicado se mantiene equivalente: la columna EA quedó
-- en DEFAULT 0 pero `interest_rate_pct` ya era > 0 cuando aplicaba.
--
-- NO MODIFICA DATOS DE NEGOCIO
-- ============================================================================
-- Puramente DDL: ALTER TABLE ADD COLUMN IF NOT EXISTS con defaults
-- constantes y recreación de CHECKs. Ni un UPDATE, ni un DELETE, ni un
-- INSERT. Los préstamos NONE/SIMPLE existentes NO se recalculan: siguen
-- con sus cuotas tal cual y los componentes nuevos quedan en 0 por el
-- DEFAULT. No hay backfill de EA a partir de interest_rate_pct porque
-- flat total != EA y convertirlo requiere una decisión de negocio que
-- esta migración, por política, no toma.
--
-- TRANSACCIONAL: SÍ
-- ============================================================================
-- No usa CREATE INDEX CONCURRENTLY. Las operaciones son ALTER TABLE con
-- defaults constantes (fast-path desde PostgreSQL 11, no reescribe la
-- tabla) y recreación de CHECK constraints. Corre dentro de la
-- transacción por defecto del runner; un fallo deja la BD intacta. Por
-- eso catalog.go NO añade la 021 a la lista de excepciones no
-- transaccionales (hoy 8, 9, 11, 13, 14, 15 y 18).
--
-- IDEMPOTENTE
-- ============================================================================
-- ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS y bloques DO que
-- verifican existencia en pg_constraint antes de ADD. Un reintento
-- después de un fallo parcial (muy improbable estando en transacción,
-- pero posible si alguien corre el SQL por fuera del runner) no la
-- rompe. El drop del CHECK anterior de `interest_mode` busca por la
-- definición (`interest_mode IN`) y NO por nombre, porque PostgreSQL
-- autogenera el nombre a partir del nombre de columna y en bases
-- heredadas podría haber colisionado con otra convención.

-- ----------------------------------------------------------------------------
-- 1) loans: cinco columnas nuevas para el modo FRENCH.
--
-- Dinero en NUMERIC(14,2) por consistencia con la 019 (principal_amount,
-- total_payable, remaining_balance). La tasa EA en NUMERIC(9,6): 6
-- decimales permiten expresar hasta la micro-fracción porcentual (útil
-- si la entidad reporta 21.300125% EA literal); 9 dígitos cubren hasta
-- 999.999999 que supera cualquier EA realista por tres órdenes de
-- magnitud.
-- ----------------------------------------------------------------------------

ALTER TABLE loans
    ADD COLUMN IF NOT EXISTS annual_effective_rate_pct NUMERIC(9,6)  NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS monthly_insurance_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS fga_total_amount          NUMERIC(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS monthly_fga_amount        NUMERIC(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS base_installment_amount   NUMERIC(14,2) NOT NULL DEFAULT 0;

-- Admitir 'FRENCH' en el CHECK de interest_mode.
--
-- CORRECCIÓN 2026-10-07 (falló en producción con SQLSTATE 42710 y se
-- revirtió por la transacción): PostgreSQL NO guarda el texto original
-- `interest_mode IN ('NONE','SIMPLE')`; pg_get_constraintdef lo devuelve
-- normalizado como `((interest_mode)::text = ANY ((ARRAY[...])::text[]))`,
-- así que el filtro `ILIKE '%interest_mode IN%'` no encontraba nada y el
-- ADD CONSTRAINT chocaba con el CHECK existente.
--
-- Ahora: (1) se borra por nombre el autogenerado `loans_interest_mode_check`
-- y (2) por si en una base heredada tiene otro nombre, se borra cualquier
-- CHECK de `loans` que mencione `interest_mode` y NO mencione ninguna
-- columna de tasa (eso excluye ck_loans_interest_requires_rate, que se
-- reemplaza aparte más abajo).
ALTER TABLE loans DROP CONSTRAINT IF EXISTS loans_interest_mode_check;

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = 'loans'
          AND con.contype = 'c'
          AND pg_get_constraintdef(con.oid) ILIKE '%interest_mode%'
          AND pg_get_constraintdef(con.oid) NOT ILIKE '%interest_rate_pct%'
          AND pg_get_constraintdef(con.oid) NOT ILIKE '%annual_effective_rate_pct%'
    LOOP
        EXECUTE format('ALTER TABLE loans DROP CONSTRAINT %I', r.conname);
    END LOOP;
END $$;

ALTER TABLE loans
    ADD CONSTRAINT loans_interest_mode_check
    CHECK (interest_mode IN ('NONE', 'SIMPLE', 'FRENCH'));

-- Amarrar cada modo a la columna de tasa que corresponde. Reemplaza el
-- ck_loans_interest_requires_rate que puso la 019.
ALTER TABLE loans DROP CONSTRAINT IF EXISTS ck_loans_interest_requires_rate;

ALTER TABLE loans
    ADD CONSTRAINT ck_loans_interest_requires_rate
    CHECK (
        interest_mode = 'NONE'
        OR (interest_mode = 'SIMPLE' AND interest_rate_pct > 0)
        OR (interest_mode = 'FRENCH' AND annual_effective_rate_pct > 0)
    );

-- Rangos no negativos y techos de cordura para las columnas nuevas. Se
-- declaran como CHECK con nombre y se añaden sólo si no existen, para
-- que un reintento no rompa.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loans'::regclass
          AND conname = 'ck_loans_annual_effective_rate_range'
    ) THEN
        -- Techo defensivo 1000% EA: a partir de ahí es más probable un
        -- typo del operador que una tasa real. El servicio Go impone el
        -- mismo techo en ValidateLoanScheduleRequest.
        ALTER TABLE loans
            ADD CONSTRAINT ck_loans_annual_effective_rate_range
            CHECK (annual_effective_rate_pct >= 0 AND annual_effective_rate_pct <= 1000);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loans'::regclass
          AND conname = 'ck_loans_monthly_insurance_non_negative'
    ) THEN
        ALTER TABLE loans
            ADD CONSTRAINT ck_loans_monthly_insurance_non_negative
            CHECK (monthly_insurance_amount >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loans'::regclass
          AND conname = 'ck_loans_fga_total_non_negative'
    ) THEN
        ALTER TABLE loans
            ADD CONSTRAINT ck_loans_fga_total_non_negative
            CHECK (fga_total_amount >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loans'::regclass
          AND conname = 'ck_loans_monthly_fga_non_negative'
    ) THEN
        ALTER TABLE loans
            ADD CONSTRAINT ck_loans_monthly_fga_non_negative
            CHECK (monthly_fga_amount >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loans'::regclass
          AND conname = 'ck_loans_base_installment_non_negative'
    ) THEN
        ALTER TABLE loans
            ADD CONSTRAINT ck_loans_base_installment_non_negative
            CHECK (base_installment_amount >= 0);
    END IF;
END $$;

COMMENT ON COLUMN loans.annual_effective_rate_pct IS
    'Tasa Efectiva Anual porcentual (ej. 21.300000 = 21.3% EA). Se usa SÓLO cuando interest_mode = FRENCH; en NONE/SIMPLE queda en 0. La tasa mensual que usa el cronograma es i_m = (1 + annual_effective_rate_pct/100)^(1/12) - 1 y la calcula el servicio Go; NO se persiste porque es determinística sobre esta columna.';
COMMENT ON COLUMN loans.monthly_insurance_amount IS
    'Seguro MENSUAL fijo cobrado por la entidad (desempleo, vida deudor). El valor ingresado por el usuario es lo que se cobra cada mes y se replica en loan_installments.insurance_due de todas las cuotas; NO se difiere. En NONE/SIMPLE queda en 0.';
COMMENT ON COLUMN loans.fga_total_amount IS
    'FGA (Fondo de Garantías) TOTAL cobrado una sola vez al desembolso por la entidad financiera. El POS lo DIFIERE en cuotas iguales entre todos los meses para que la cuota mensual total refleje el costo real; NO es un valor mensual. El valor mensual persistido vive en monthly_fga_amount. En NONE/SIMPLE queda en 0.';
COMMENT ON COLUMN loans.monthly_fga_amount IS
    'FGA diferido por cuota ≈ fga_total_amount / term_count, redondeado a 2 decimales por el servicio Go al crear el préstamo. Se persiste para que las vistas lean la columna sin recalcular; el residuo de redondeo lo absorbe la última cuota en loan_installments.fga_due. En NONE/SIMPLE queda en 0.';
COMMENT ON COLUMN loans.base_installment_amount IS
    'Cuota base del Sistema Francés: P * [ i(1+i)^n ] / [ (1+i)^n - 1 ], donde P = principal_amount, i = tasa mensual derivada de annual_effective_rate_pct y n = term_count. Se persiste para auditoría y para que la UI muestre la descomposición "base + seguro + FGA mensual = total mensual" sin recalcular. En NONE/SIMPLE queda en 0.';

-- ----------------------------------------------------------------------------
-- 2) loan_installments: componentes explícitos de seguro y FGA por cuota.
-- ----------------------------------------------------------------------------

ALTER TABLE loan_installments
    ADD COLUMN IF NOT EXISTS insurance_due NUMERIC(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS fga_due       NUMERIC(14,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loan_installments'::regclass
          AND conname = 'ck_loan_installment_insurance_non_negative'
    ) THEN
        ALTER TABLE loan_installments
            ADD CONSTRAINT ck_loan_installment_insurance_non_negative
            CHECK (insurance_due >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'loan_installments'::regclass
          AND conname = 'ck_loan_installment_fga_non_negative'
    ) THEN
        ALTER TABLE loan_installments
            ADD CONSTRAINT ck_loan_installment_fga_non_negative
            CHECK (fga_due >= 0);
    END IF;
END $$;

-- Reemplaza ck_loan_installment_paid_within_total para incluir seguro
-- y FGA en el techo del pago. Para filas existentes NONE/SIMPLE con
-- insurance_due = fga_due = 0 (por DEFAULT) el predicado es idéntico
-- al anterior, así que ninguna fila previa queda inválida.
ALTER TABLE loan_installments
    DROP CONSTRAINT IF EXISTS ck_loan_installment_paid_within_total;

ALTER TABLE loan_installments
    ADD CONSTRAINT ck_loan_installment_paid_within_total
    CHECK (paid_amount <= principal_due + interest_due + insurance_due + fga_due + 0.01);

COMMENT ON COLUMN loan_installments.insurance_due IS
    'Seguro mensual (desempleo / vida deudor) que corresponde a esta cuota. En NONE/SIMPLE queda en 0; en FRENCH es igual a loans.monthly_insurance_amount en todas las cuotas (no se difiere).';
COMMENT ON COLUMN loan_installments.fga_due IS
    'FGA diferido que corresponde a esta cuota. En NONE/SIMPLE queda en 0; en FRENCH es ≈ loans.monthly_fga_amount salvo la última cuota, que absorbe el residuo de redondeo para que SUM(fga_due) = loans.fga_total_amount al centavo.';
