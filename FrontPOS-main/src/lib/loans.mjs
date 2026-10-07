// Fuente ÚNICA de verdad para la matemática y los envelopes de préstamos.
//
// POR QUÉ EXISTE ESTE ARCHIVO
//
// El POS ya tenía "deuda" como un parche: `expenses.paymentSource === 'PRESTAMO'`
// (ver `src/lib/payables.mjs`). Eso cuenta las cuentas por pagar a proveedores,
// pero NO modela un préstamo real: no hay cronograma, no hay interés, no hay
// cuotas, y el saldo pendiente se calcula a ojo. Este archivo introduce el
// cálculo del cronograma y las agregaciones del módulo nuevo de préstamos
// (/loans) y es independiente de payables.mjs: payables sigue siendo la
// fuente única para la pantalla de Egresos y el dashboard, y loans es la
// fuente única para la pantalla nueva de Préstamos.
//
// Convive con el backend: debe producir los mismos números que
// `loan_service.BuildSchedule` del backend Go. Los tests contrato
// (`tests/loans-schedule.test.mjs`) atan ambos.
//
// REGLAS DE INTERÉS (contrato definitivo con el backend Go — migración 021)
// ============================================================================
//   - Modos aceptados: `NONE`, `SIMPLE`, `FRENCH`. El CHECK de BD de la 021
//     admite los tres. `SIMPLE` NO se reinterpreta como FRENCH: ambos coexisten
//     y guardan la tasa en columnas distintas (`interest_rate_pct` vs
//     `annual_effective_rate_pct`).
//
//   - NONE: no hay interés. `principalDue` es constante (última cuota absorbe
//     centavos). `interestRatePct` DEBE ser 0.
//
//   - SIMPLE: interés TOTAL FLAT sobre el principal (préstamos tradicionales
//     NO bancarios, p.ej. un particular a 20% total):
//         totalPayable = principal * (1 + interestRatePct / 100)
//         totalInterest = totalPayable - principal
//     Independiente del número de cuotas y de la frecuencia. Es la cifra
//     cerrada que el prestamista pacta ANTES del desembolso. Cualquier
//     préstamo registrado antes de la 021 era SIMPLE y queda intacto.
//
//   - FRENCH: Sistema francés (banca). Entrada obligatoria:
//         * principal (`P`)
//         * annualEffectiveRatePct (`EA%`) — tasa efectiva anual
//         * termCount (`n`) — en MESES. FRENCH fuerza frecuencia MONTHLY.
//         * monthlyInsurance — pago fijo MENSUAL de seguro (COP)
//         * fgaTotal — costo TOTAL del FGA, se difiere entre todos los meses
//     Fórmula:
//         i_m = (1 + EA/100)^(1/12) − 1          (tasa mensual vencida)
//         cuotaBase = P · i_m · (1+i_m)^n / ((1+i_m)^n − 1)
//     Cronograma por saldos (centavos):
//         interest_k = round(saldo_{k-1} · i_m)
//         principal_k = cuotaBase − interest_k   (para k = 1..n-1)
//         principal_n = saldo_{n-1}              (última absorbe residuo)
//         saldo_k = saldo_{k-1} − principal_k
//     Extras por cuota:
//         insurance_k = monthlyInsurance (constante)
//         fga_k = round(fgaTotal / n) salvo la última, que absorbe el residuo
//     Cuota total pagada en el mes k:
//         totalDue_k = principal_k + interest_k + insurance_k + fga_k
//     Invariantes garantizados por el motor:
//         Σ principal_k == P
//         Σ insurance_k == n · monthlyInsurance
//         Σ fga_k == fgaTotal
//         saldo_n == 0
//     Caso de referencia (contrato de pruebas): P=25.000.000, n=60,
//     EA=21.300% → i_m ≈ 1.6221% M.V., cuotaBase ≈ $654.939 (±tolerancia por
//     redondeo). Si se mueve, el backend/front se desincroniza.
//
//   - El cronograma de NONE/SIMPLE reparte totalPayable en N cuotas iguales
//     (truncadas a centavos) y la ÚLTIMA cuota absorbe el residuo. Así:
//         sum(principalDue_i) == principal              (al centavo)
//         sum(interestDue_i)  == totalInterest          (al centavo)
//         sum(totalDue_i)     == totalPayable           (al centavo)
//
// Reglas monetarias:
//   - COP, redondeo a entero donde el PVP/subtotal se muestra.
//   - Internamente trabajamos en centavos (int64) para no acumular drift,
//     igual que el backend Go.
//   - La última cuota absorbe los centavos de redondeo para que
//     Σ principal = principal_amount exacto en NONE/SIMPLE/FRENCH.
//
// La lógica vive en .mjs (no .ts) porque la convención del proyecto es que lo
// puro y testeable se pueda correr con `node --test`.

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

export const INTEREST_MODES = Object.freeze({
  NONE: "NONE",
  SIMPLE: "SIMPLE",
  FRENCH: "FRENCH",
});

export const PAYMENT_FREQUENCIES = Object.freeze({
  WEEKLY: "WEEKLY",
  BIWEEKLY: "BIWEEKLY",
  MONTHLY: "MONTHLY",
});

export const LOAN_STATUSES = Object.freeze({
  ACTIVE: "ACTIVE",
  PAID: "PAID",
  DEFAULTED: "DEFAULTED",
  CANCELLED: "CANCELLED",
});

export const INSTALLMENT_STATUSES = Object.freeze({
  PENDING: "PENDING",
  PARTIAL: "PARTIAL",
  PAID: "PAID",
  LATE: "LATE",
});

/**
 * Códigos de error estables emitidos por el backend. Centralizarlos aquí
 * evita que cada pantalla reinvente strings mágicos.
 */
export const LOAN_ERROR_CODES = Object.freeze({
  LOAN_NOT_FOUND: "LOAN_NOT_FOUND",
  LOAN_INSTALLMENT_NOT_FOUND: "LOAN_INSTALLMENT_NOT_FOUND",
  LOAN_INSTALLMENT_ALREADY_PAID: "LOAN_INSTALLMENT_ALREADY_PAID",
  LOAN_PRINCIPAL_EXCEEDED: "LOAN_PRINCIPAL_EXCEEDED",
  LOAN_INVALID_SCHEDULE: "LOAN_INVALID_SCHEDULE",
  LOAN_INVALID_INPUT: "LOAN_INVALID_INPUT",
  LOAN_HAS_PAYMENTS: "LOAN_HAS_PAYMENTS",
  // Errores específicos del endpoint PUT /loans/:id (edición segura —
  // backend 023 en diseño). Documentarlos aquí evita que la UI invente
  // strings mágicos cuando el backend los emita.
  LOAN_HAS_PAID_INSTALLMENTS: "LOAN_HAS_PAID_INSTALLMENTS",
  LOAN_PRINCIPAL_BELOW_USAGE: "LOAN_PRINCIPAL_BELOW_USAGE",
});

/**
 * Catálogo de tipos de préstamo. El backend 023 valida con CHECK; "OTRO"
 * es el default seguro para préstamos legacy que no cargan loan_type.
 */
export const LOAN_TYPES = Object.freeze({
  CONSUMO: "CONSUMO",
  HIPOTECARIO: "HIPOTECARIO",
  LIBRANZA: "LIBRANZA",
  COMERCIAL: "COMERCIAL",
  VEHICULO: "VEHICULO",
  OTRO: "OTRO",
});

/** FIJO vs VARIABLE. */
export const RATE_TYPES = Object.freeze({
  FIJO: "FIJO",
  VARIABLE: "VARIABLE",
});

/** Monedas aceptadas (COP por default; USD no se convierte, sólo se registra). */
export const LOAN_CURRENCIES = Object.freeze({
  COP: "COP",
  USD: "USD",
});

const FREQUENCY_SET = new Set(Object.values(PAYMENT_FREQUENCIES));

// ---------------------------------------------------------------------------
// Helpers primitivos
// ---------------------------------------------------------------------------

function numeric(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function upper(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function round2(value) {
  // 2 decimales = coincide con NUMERIC(14,2) en PG.
  return Math.round(numeric(value) * 100) / 100;
}

// Centavos: coincide con la aritmética del backend Go (loan_schedule.go).
function toCents(value) {
  const n = numeric(value);
  if (!Number.isFinite(n)) return 0;
  return n >= 0 ? Math.round(n * 100) : -Math.round(-n * 100);
}

function fromCents(cents) {
  return cents / 100;
}

/**
 * True si el string es formato YYYY-MM-DD válido.
 */
function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Convierte un valor a YYYY-MM-DD en zona horaria local, sin pasar por UTC.
 *
 * El backend trabaja en `America/Bogota` y columnas `DATE`. El problema
 * clásico: `new Date("2026-02-01")` se interpreta como UTC medianoche, que
 * en Bogotá (-5h) es "2026-01-31 19:00", y al leer el día local queda
 * desplazada un día atrás. Toda fecha que entra como string ISO corta se
 * trata como "fecha local" literal (como lo hace la BD en modo DATE).
 */
export function toISODate(input) {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    const y = input.getFullYear();
    const m = String(input.getMonth() + 1).padStart(2, "0");
    const d = String(input.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (isIsoDate(input)) return input;
  if (typeof input === "string" && input.length > 0) {
    return toISODate(parseLocalDate(input));
  }
  return null;
}

/**
 * Convierte "YYYY-MM-DD" (y otros formatos de fecha habituales) a un Date
 * local — nunca UTC. Si el input ya trae hora/zona, usa el parser nativo.
 */
function parseLocalDate(value) {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return new Date(NaN);
  const iso = value.trim();
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return new Date(iso);
}

/**
 * Suma n períodos a una fecha, según la frecuencia de pago. Si el input es
 * un string YYYY-MM-DD se interpreta como fecha local (no UTC).
 *
 * MONTHLY avanza mes a mes preservando el día de pago. Si el mes destino no
 * tiene ese día (ej. 31 → febrero), cae al último día válido. Mismo
 * comportamiento que `AdvanceDueDate` del backend.
 */
export function addPeriod(date, frequency, n) {
  const base = date instanceof Date ? new Date(date.getTime()) : parseLocalDate(date);
  if (Number.isNaN(base.getTime())) return new Date(NaN);
  const code = upper(frequency);
  const steps = Math.floor(numeric(n));
  if (code === "WEEKLY") {
    base.setDate(base.getDate() + 7 * steps);
    return base;
  }
  if (code === "BIWEEKLY") {
    base.setDate(base.getDate() + 14 * steps);
    return base;
  }
  // MONTHLY (default) — preservar el día; capar al último del mes destino.
  const originalDay = base.getDate();
  const target = new Date(base.getFullYear(), base.getMonth() + steps, 1);
  const lastDayOfTarget = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(originalDay, lastDayOfTarget));
  return target;
}

// ---------------------------------------------------------------------------
// Parsing de montos en COP (Colombia)
// ---------------------------------------------------------------------------

/**
 * parseLoanAmount — convierte un string digitado por el operador a un número
 * en pesos. Es tolerante a los formatos que la gente escribe en Colombia:
 *
 *   "1.000.000"  → 1000000      (miles con punto, formato es-CO estándar)
 *   "1,000,000"  → 1000000      (miles con coma, formato en-US pegado)
 *   "1000000"    → 1000000      (sin separadores)
 *   "1.000.000,50" → 1000000.5  (miles . + decimal ,)
 *   "1,000,000.50" → 1000000.5  (miles , + decimal . — anglo)
 *   "$ 1.000.000" → 1000000     (símbolo moneda y espacios)
 *   "1.000"      → 1000         (NUNCA 1.0 — los puntos sueltos son miles)
 *   "1.5"        → NOTA: en montos de préstamo nunca aparece 1.5 pesos;
 *                  se interpreta como 15 (punto es miles, dos dígitos tras
 *                  el único punto los asumimos como decimales sólo cuando el
 *                  número total tiene más de 3 dígitos antes del punto).
 *
 * Es consciente del problema clásico: `Number("1.000.000")` es `NaN`, y
 * `Number("1.000")` es `1`, lo cual es catastrófico cuando el usuario pensó
 * "mil pesos". Por eso NUNCA hacemos `Number(string)` directo sobre entradas
 * de formulario.
 */
export function parseLoanAmount(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  if (trimmed === "") return 0;

  // Dejamos sólo dígitos, puntos y comas; descartamos símbolo, letras, espacios.
  const clean = trimmed.replace(/[^0-9.,-]/g, "");
  if (clean === "" || clean === "-") return 0;

  const negative = clean.startsWith("-");
  const abs = negative ? clean.slice(1) : clean;

  const hasDot = abs.includes(".");
  const hasComma = abs.includes(",");

  let decimal = "";
  let integer = abs;

  if (hasDot && hasComma) {
    // Formato mixto: el ÚLTIMO símbolo marca el decimal.
    const lastDot = abs.lastIndexOf(".");
    const lastComma = abs.lastIndexOf(",");
    if (lastComma > lastDot) {
      // es-CO: punto miles, coma decimal.
      integer = abs.slice(0, lastComma).replace(/[.,]/g, "");
      decimal = abs.slice(lastComma + 1).replace(/\D/g, "");
    } else {
      // anglo: coma miles, punto decimal.
      integer = abs.slice(0, lastDot).replace(/[.,]/g, "");
      decimal = abs.slice(lastDot + 1).replace(/\D/g, "");
    }
  } else if (hasComma) {
    const parts = abs.split(",");
    if (parts.length === 2 && parts[1].length !== 3) {
      // "1000,50" → 1000.50 (coma decimal clásica).
      integer = parts[0].replace(/\D/g, "");
      decimal = parts[1].replace(/\D/g, "");
    } else {
      // "1,000" o "1,000,000" → separadores de miles.
      integer = parts.join("").replace(/\D/g, "");
    }
  } else if (hasDot) {
    const parts = abs.split(".");
    // En es-CO el punto es separador de miles. Un único punto con exactamente
    // dos dígitos a la derecha PODRÍA ser decimal estilo anglo (ej. "15.50"),
    // pero en montos de préstamo COP eso es raro y conflictúa con "1.50"
    // escrito como "mil quinientos". Preferimos la lectura es-CO: puntos son
    // miles si cualquier grupo entre puntos tiene exactamente 3 dígitos o si
    // hay más de un punto; cualquier otro caso lo tomamos como decimal.
    const multipleDots = parts.length > 2;
    const allGroupsThreeAfterFirst = parts
      .slice(1)
      .every((group) => group.length === 3 && /^\d{3}$/.test(group));
    if (multipleDots || allGroupsThreeAfterFirst) {
      integer = parts.join("").replace(/\D/g, "");
    } else if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
      // Un solo punto, grupos no-tres: lo tomamos como decimal anglo.
      integer = parts[0];
      decimal = parts[1];
    } else {
      integer = abs.replace(/\D/g, "");
    }
  } else {
    integer = abs.replace(/\D/g, "");
  }

  if (integer === "") integer = "0";
  const normalized = decimal === "" ? integer : `${integer}.${decimal}`;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return 0;
  return negative ? -parsed : parsed;
}

// ---------------------------------------------------------------------------
// Build schedule — motor del cronograma
// ---------------------------------------------------------------------------

/**
 * Construye el cronograma de amortización.
 *
 * input = {
 *   principal:        número positivo,
 *   interestRatePct:  % TOTAL FLAT (0 para sin interés). Aplica a NONE/SIMPLE.
 *                     Alias `annualRatePct` sigue aceptándose por
 *                     compatibilidad con callsites antiguos.
 *   annualEffectiveRatePct: % tasa EFECTIVA ANUAL. Aplica solo a FRENCH. Si
 *                     el callsite envió `interestRatePct` en modo FRENCH se
 *                     acepta como fallback — mantiene la UX de "un único
 *                     input numérico de tasa" en el formulario.
 *   monthlyInsurance: valor MENSUAL FIJO del seguro (COP). Default 0.
 *                     Solo aplica a FRENCH.
 *   fgaTotal:         costo TOTAL del FGA (COP), se difiere en los `n` meses.
 *                     Solo aplica a FRENCH. Default 0.
 *   mode:             'NONE' | 'SIMPLE' | 'FRENCH',
 *   termCount:        entero >= 1 (en MESES para FRENCH),
 *   frequency:        'WEEKLY' | 'BIWEEKLY' | 'MONTHLY'. FRENCH fuerza MONTHLY.
 *   firstPaymentDate: Date | ISO string (opcional; si no viene no se calculan
 *                     due dates),
 * }
 *
 * salida (NONE/SIMPLE) = {
 *   installments: [{ number, dueDate, principalDue, interestDue, totalDue,
 *                    insuranceDue: 0, fgaDue: 0 }],
 *   totals: { principal, interest, totalPayable },
 *   error?: 'LOAN_INVALID_SCHEDULE',
 * }
 *
 * salida (FRENCH) = {
 *   installments: [{ number, dueDate, principalDue, interestDue,
 *                    insuranceDue, fgaDue, totalDue }],
 *   totals: {
 *     principal, interest, totalPayable,
 *     // extras exclusivos de FRENCH para que la UI muestre el desglose:
 *     monthlyRate,          // i_m (ej. 0.016222 para EA 21.3%)
 *     monthlyRatePct,       // 100 * i_m (ej. 1.6222)
 *     baseInstallment,      // cuota base fija (capital+interés) sin extras
 *     monthlyInsurance,     // valor por cuota del seguro
 *     monthlyFga,           // valor por cuota del FGA (base, sin residuo)
 *     totalInsurance,       // n * monthlyInsurance
 *     totalFga,             // fgaTotal (invariante)
 *     monthlyTotal,         // cuota base + seguro + fga mensual
 *   },
 * }
 *
 * Modos:
 *   - NONE:   cuotas iguales de capital, sin interés. Rate debe ser 0.
 *   - SIMPLE: interés TOTAL FLAT sobre el principal.
 *   - FRENCH: cuota francesa i_m = (1+EA/100)^(1/12)-1, saldo decreciente,
 *             seguro mensual fijo, FGA total diferido. Ver docstring del
 *             header de este archivo para la fórmula completa.
 */
export function buildSchedule(input) {
  const empty = (error) => ({
    installments: [],
    totals: { principal: 0, interest: 0, totalPayable: 0 },
    ...(error ? { error } : {}),
  });

  // Backward compat: aceptamos `annualRatePct` como alias del nuevo
  // `interestRatePct`. En el contrato con el backend ambos cargan el mismo
  // significado para NONE/SIMPLE (porcentaje total flat). En FRENCH el
  // campo canónico es `annualEffectiveRatePct` pero aceptamos
  // `interestRatePct` como fallback por simplicidad del formulario.
  const mode = upper(input?.mode) || INTEREST_MODES.SIMPLE;

  let rawRate;
  if (mode === INTEREST_MODES.FRENCH) {
    rawRate =
      input?.annualEffectiveRatePct !== undefined && input?.annualEffectiveRatePct !== null
        ? input.annualEffectiveRatePct
        : input?.interestRatePct !== undefined && input?.interestRatePct !== null
        ? input.interestRatePct
        : input?.annualRatePct;
  } else {
    rawRate =
      input?.interestRatePct !== undefined && input?.interestRatePct !== null
        ? input.interestRatePct
        : input?.annualRatePct;
  }

  const principal = round2(numeric(input?.principal));
  const ratePct = numeric(rawRate);
  const term = Math.floor(numeric(input?.termCount));
  // FRENCH fuerza MONTHLY: si el callsite envió otra cosa, la ignoramos y
  // normalizamos a MONTHLY. No es un error del usuario, es el contrato banca.
  const frequency =
    mode === INTEREST_MODES.FRENCH
      ? PAYMENT_FREQUENCIES.MONTHLY
      : upper(input?.frequency) || PAYMENT_FREQUENCIES.MONTHLY;
  const firstDateRaw = input?.firstPaymentDate ? parseLocalDate(input.firstPaymentDate) : null;
  const firstDate = firstDateRaw && !Number.isNaN(firstDateRaw.getTime()) ? firstDateRaw : null;

  const monthlyInsurance = round2(numeric(input?.monthlyInsurance));
  const fgaTotal = round2(numeric(input?.fgaTotal));

  if (principal <= 0) return empty("LOAN_INVALID_SCHEDULE");
  if (!Number.isFinite(principal)) return empty("LOAN_INVALID_SCHEDULE");
  if (term < 1 || term > 600) return empty("LOAN_INVALID_SCHEDULE");
  if (!Number.isFinite(ratePct) || ratePct < 0 || ratePct > 1000) return empty("LOAN_INVALID_SCHEDULE");
  if (!FREQUENCY_SET.has(frequency)) return empty("LOAN_INVALID_SCHEDULE");
  if (
    mode !== INTEREST_MODES.NONE &&
    mode !== INTEREST_MODES.SIMPLE &&
    mode !== INTEREST_MODES.FRENCH
  ) {
    return empty("LOAN_INVALID_SCHEDULE");
  }
  if (mode === INTEREST_MODES.NONE && ratePct !== 0) return empty("LOAN_INVALID_SCHEDULE");
  if (mode === INTEREST_MODES.SIMPLE && ratePct <= 0) return empty("LOAN_INVALID_SCHEDULE");
  if (mode === INTEREST_MODES.FRENCH && ratePct <= 0) return empty("LOAN_INVALID_SCHEDULE");
  if (mode === INTEREST_MODES.FRENCH && (!Number.isFinite(monthlyInsurance) || monthlyInsurance < 0))
    return empty("LOAN_INVALID_SCHEDULE");
  if (mode === INTEREST_MODES.FRENCH && (!Number.isFinite(fgaTotal) || fgaTotal < 0))
    return empty("LOAN_INVALID_SCHEDULE");

  const principalCents = toCents(principal);

  // -------------------------------------------------------------------------
  // Rama FRENCH — Sistema francés banca.
  // -------------------------------------------------------------------------
  if (mode === INTEREST_MODES.FRENCH) {
    const ea = ratePct / 100;
    const iM = Math.pow(1 + ea, 1 / 12) - 1;
    const n = term;
    const P = principalCents;
    // Si iM es casi cero por EA ínfima, caemos a cuota lineal (edge-case
    // defensivo; en banca real nunca pasa pero evita division-by-zero).
    const pow = Math.pow(1 + iM, n);
    const denom = pow - 1;
    const baseInstallmentCents =
      denom > 1e-12
        ? Math.round((P * iM * pow) / denom)
        : Math.round(P / n);

    const monthlyInsuranceCents = toCents(monthlyInsurance);
    const fgaTotalCents = toCents(fgaTotal);
    const baseFgaCents = Math.floor(fgaTotalCents / n);
    const fgaResidueCents = fgaTotalCents - baseFgaCents * n;

    let saldoCents = P;
    let totalInterestCents = 0;
    const rowsFr = [];
    for (let i = 0; i < n; i++) {
      const interestCents = Math.round(saldoCents * iM);
      let principalCentsThis;
      if (i < n - 1) {
        principalCentsThis = baseInstallmentCents - interestCents;
      } else {
        // La última cuota: el capital es lo que queda del saldo, para que
        // Σ principal == P exacto al centavo.
        principalCentsThis = saldoCents;
      }
      saldoCents -= principalCentsThis;
      totalInterestCents += interestCents;
      const fgaCentsThis = i === n - 1 ? baseFgaCents + fgaResidueCents : baseFgaCents;
      rowsFr.push({
        number: i + 1,
        principalCents: principalCentsThis,
        interestCents,
        insuranceCents: monthlyInsuranceCents,
        fgaCents: fgaCentsThis,
        balanceCents: saldoCents,
      });
    }

    const totalInsuranceCents = monthlyInsuranceCents * n;
    const totalPayableCents =
      P + totalInterestCents + totalInsuranceCents + fgaTotalCents;

    const installments = rowsFr.map((row, idx) => {
      const due = firstDate ? addPeriod(firstDate, frequency, idx) : null;
      return {
        number: row.number,
        dueDate: toISODate(due),
        principalDue: fromCents(row.principalCents),
        interestDue: fromCents(row.interestCents),
        insuranceDue: fromCents(row.insuranceCents),
        fgaDue: fromCents(row.fgaCents),
        // Saldo de capital DESPUÉS de esta cuota (0 en la última).
        balance: fromCents(row.balanceCents),
        totalDue: fromCents(
          row.principalCents + row.interestCents + row.insuranceCents + row.fgaCents,
        ),
      };
    });

    return {
      installments,
      totals: {
        principal: fromCents(P),
        interest: fromCents(totalInterestCents),
        totalPayable: fromCents(totalPayableCents),
        monthlyRate: iM,
        monthlyRatePct: iM * 100,
        baseInstallment: fromCents(baseInstallmentCents),
        monthlyInsurance: fromCents(monthlyInsuranceCents),
        monthlyFga: fromCents(baseFgaCents),
        totalInsurance: fromCents(totalInsuranceCents),
        totalFga: fromCents(fgaTotalCents),
        monthlyTotal: fromCents(
          baseInstallmentCents + monthlyInsuranceCents + baseFgaCents,
        ),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Rama NONE/SIMPLE — cronograma flat (compatibilidad legacy).
  // Cálculo en centavos — espejo exacto del backend (loan_schedule.go).
  // -------------------------------------------------------------------------
  let totalInterestCents = 0;
  if (mode === INTEREST_MODES.SIMPLE) {
    // interés total = principal * rate / 100, redondeo banker-less (half-up).
    totalInterestCents = Math.round((principalCents * ratePct) / 100);
  }
  const totalPayableCents = principalCents + totalInterestCents;

  const basePrincipalCents = Math.floor(principalCents / term);
  const principalResidueCents = principalCents - basePrincipalCents * term;
  const baseInterestCents = Math.floor(totalInterestCents / term);
  const interestResidueCents = totalInterestCents - baseInterestCents * term;

  const rows = [];
  for (let i = 0; i < term; i++) {
    let principalThis = basePrincipalCents;
    let interestThis = baseInterestCents;
    if (i === term - 1) {
      principalThis += principalResidueCents;
      interestThis += interestResidueCents;
    }
    rows.push({ number: i + 1, principalCents: principalThis, interestCents: interestThis });
  }

  const installments = rows.map((row, idx) => {
    const due = firstDate ? addPeriod(firstDate, frequency, idx) : null;
    const principalDue = fromCents(row.principalCents);
    const interestDue = fromCents(row.interestCents);
    return {
      number: row.number,
      dueDate: toISODate(due),
      principalDue,
      interestDue,
      // Mantener forma uniforme para que la UI pueda leer `insuranceDue`/
      // `fgaDue` sin cheks defensivos adicionales — en NONE/SIMPLE son 0.
      insuranceDue: 0,
      fgaDue: 0,
      totalDue: fromCents(row.principalCents + row.interestCents),
    };
  });

  return {
    installments,
    totals: {
      principal: fromCents(principalCents),
      interest: fromCents(totalInterestCents),
      totalPayable: fromCents(totalPayableCents),
    },
  };
}

// ---------------------------------------------------------------------------
// Normalización de envelopes del backend
// ============================================================================
// El backend entrega los siguientes shapes (contrato definitivo):
//
//   POST /loans/preview      → { preview: ScheduleResult }
//   POST /loans              → { loan: LoanRecord }
//   GET  /loans/:id          → { loan: LoanRecord }
//   GET  /loans              → { loans: [LoanWithStatsRow], total: N }
//
// Las funciones de abajo son el ÚNICO lugar donde se desenvuelven esos
// envelopes para producir `LoanRecord` que la UI consume. Así dashboard
// y detail trabajan sobre la misma estructura.
//
// LoanWithStatsRow trae `loan` + varios agregados (`totalPayable`,
// `remainingBalance`, `outstandingDue`, `nextDueDate`, `installmentsPaid`,
// `installmentsTotal`, `principalUsed`). El normalizador los eleva a
// propiedades del `LoanRecord` resultante y conserva una copia bajo
// `stats` por si una pantalla las necesita crudas.
// ---------------------------------------------------------------------------

/**
 * Totales que MUESTRA la UI en Sistema Francés.
 *
 *   cuotaMensualFinal = cuotaBase + cargos mensuales (seguros, FGA diferido…)
 *   totalAPagar       = cuotaMensualFinal × número de cuotas
 *
 * `totals` es el de `buildSchedule` / `normalizeLoanPreviewResponse`.
 * Devuelve null si falta la cuota base (no es FRENCH o no hay preview).
 *
 * @param {{ baseInstallment?: number, monthlyInsurance?: number, monthlyFga?: number } | null | undefined} totals
 * @param {number} termCount
 * @returns {{ baseInstallment: number, monthlyCharges: number, finalMonthly: number, totalToPay: number } | null}
 */
export function frenchDisplayTotals(totals, termCount) {
  if (!totals || totals.baseInstallment === undefined || totals.baseInstallment === null) return null;
  const n = Math.floor(numeric(termCount));
  if (!(n >= 1)) return null;
  const baseInstallment = round2(numeric(totals.baseInstallment));
  const monthlyCharges = round2(numeric(totals.monthlyInsurance) + numeric(totals.monthlyFga));
  const finalMonthly = round2(baseInstallment + monthlyCharges);
  return {
    baseInstallment,
    monthlyCharges,
    finalMonthly,
    totalToPay: round2(finalMonthly * n),
  };
}

/**
 * Normaliza la respuesta de GET /loans. Acepta tanto el envelope definitivo
 * `{ loans:[...] , total }` como una lista cruda (fallback defensivo si el
 * backend aún no está actualizado o un mock devuelve array).
 *
 * @returns {{ loans: LoanRecord[], total: number }}
 */
export function normalizeLoanListResponse(response) {
  const empty = { loans: [], total: 0 };
  if (!response) return empty;
  if (Array.isArray(response)) {
    const loans = response.map(normalizeLoanRow).filter(Boolean);
    return { loans, total: loans.length };
  }
  if (typeof response !== "object") return empty;
  const rawList = Array.isArray(response.loans) ? response.loans : [];
  const loans = rawList.map(normalizeLoanRow).filter(Boolean);
  const total = Number.isFinite(numeric(response.total)) ? numeric(response.total) : loans.length;
  return { loans, total };
}

/**
 * Normaliza la respuesta de GET /loans/:id y POST /loans.
 * Acepta `{ loan: {...} }` o un `LoanRecord` crudo. Devuelve null si no se
 * puede reconocer.
 */
export function normalizeLoanDetailResponse(response) {
  if (!response || typeof response !== "object") return null;
  if (response.loan && typeof response.loan === "object") {
    return normalizeLoanRow(response.loan);
  }
  // Fallback: el objeto raíz es ya el LoanRecord.
  if (response.id !== undefined || response.principalAmount !== undefined || response.lenderName !== undefined) {
    return normalizeLoanRow(response);
  }
  return null;
}

/**
 * Normaliza la respuesta de `POST /loans/:id/pay-expense`.
 *
 * Backend responde 201 con:
 *   { expense: <ExpenseRecord>, loanExpense: <LoanExpenseRecord>,
 *     totalUsed: number, available: number }
 *
 * El helper es tolerante: acepta tanto el envelope completo como shapes
 * parciales (por si en el futuro el backend decide no mandar `available`).
 * Nunca lanza; devuelve `null` si la respuesta no se puede reconocer como
 * tal. El consumidor usa `totalUsed/available` para refrescar la UI sin
 * tener que llamar `GET /loans` otra vez.
 */
export function normalizeLoanPayExpenseResponse(response) {
  if (!response || typeof response !== "object") return null;
  const expense =
    response.expense && typeof response.expense === "object" ? response.expense : null;
  const loanExpense =
    response.loanExpense && typeof response.loanExpense === "object"
      ? response.loanExpense
      : null;
  if (!expense && !loanExpense) return null;
  return {
    expense,
    loanExpense,
    totalUsed: round2(numeric(response.totalUsed)),
    available: round2(numeric(response.available)),
  };
}

/**
 * Normaliza la respuesta de POST /loans/preview a un `ScheduleResult`.
 * Acepta `{ preview: {...} }` o el objeto crudo. En modo FRENCH el backend
 * puede devolver además `monthlyRate`, `baseInstallment`, `monthlyInsurance`,
 * `monthlyFga`, `totalInsurance`, `totalFga` y por cuota `insuranceDue`,
 * `fgaDue`. Los campos ausentes caen a 0 para que la UI pueda consumir
 * NONE/SIMPLE con el mismo shape (`insuranceDue=0`, `fgaDue=0`).
 */
export function normalizeLoanPreviewResponse(response) {
  if (!response || typeof response !== "object") return null;
  const raw = response.preview && typeof response.preview === "object" ? response.preview : response;
  if (!raw || typeof raw !== "object") return null;

  const rawInstallments = Array.isArray(raw.installments) ? raw.installments : [];
  const installments = rawInstallments.map((it, idx) => {
    const principalDue = round2(numeric(it?.principalDue));
    const interestDue = round2(numeric(it?.interestDue));
    const insuranceDue = round2(numeric(it?.insuranceDue));
    const fgaDue = round2(numeric(it?.fgaDue));
    const totalDueRaw = numeric(it?.totalDue);
    const totalDue = round2(
      totalDueRaw > 0
        ? totalDueRaw
        : principalDue + interestDue + insuranceDue + fgaDue,
    );
    return {
      number: Number(it?.number ?? idx + 1),
      dueDate: it?.dueDate ? toISODate(it.dueDate) : null,
      principalDue,
      interestDue,
      insuranceDue,
      fgaDue,
      totalDue,
      ...(it?.balance !== undefined && it?.balance !== null
        ? { balance: round2(numeric(it.balance)) }
        : {}),
    };
  });

  const totalInterest = round2(numeric(raw.totals?.interest ?? raw.totalInterest));
  const totalPayable = round2(numeric(raw.totals?.totalPayable ?? raw.totalPayable));
  const principal = round2(
    numeric(
      raw.totals?.principal ??
        raw.principal ??
        totalPayable - totalInterest,
    ),
  );

  // Extras FRENCH (todos opcionales; si no vienen → undefined para no mentirle
  // a la UI con ceros falsos. SIMPLE/NONE no los produce).
  const totals = {
    principal,
    interest: totalInterest,
    totalPayable,
  };
  if (raw.totals?.monthlyRate !== undefined || raw.monthlyRate !== undefined) {
    totals.monthlyRate = numeric(raw.totals?.monthlyRate ?? raw.monthlyRate);
    totals.monthlyRatePct = round2((totals.monthlyRate ?? 0) * 100);
  }
  if (raw.totals?.baseInstallment !== undefined || raw.baseInstallment !== undefined) {
    totals.baseInstallment = round2(numeric(raw.totals?.baseInstallment ?? raw.baseInstallment));
  }
  if (
    raw.totals?.monthlyInsurance !== undefined ||
    raw.monthlyInsurance !== undefined
  ) {
    totals.monthlyInsurance = round2(
      numeric(raw.totals?.monthlyInsurance ?? raw.monthlyInsurance),
    );
  }
  if (raw.totals?.monthlyFga !== undefined || raw.monthlyFga !== undefined) {
    totals.monthlyFga = round2(numeric(raw.totals?.monthlyFga ?? raw.monthlyFga));
  }
  if (raw.totals?.totalInsurance !== undefined || raw.totalInsurance !== undefined) {
    totals.totalInsurance = round2(
      numeric(raw.totals?.totalInsurance ?? raw.totalInsurance),
    );
  }
  if (raw.totals?.totalFga !== undefined || raw.totalFga !== undefined) {
    totals.totalFga = round2(numeric(raw.totals?.totalFga ?? raw.totalFga));
  }
  if (raw.totals?.monthlyTotal !== undefined || raw.monthlyTotal !== undefined) {
    totals.monthlyTotal = round2(numeric(raw.totals?.monthlyTotal ?? raw.monthlyTotal));
  }
  // Compat: el backend Go siempre envía `installmentBase`; en FRENCH
  // (señalado por monthlyRate) lo usamos si falta `baseInstallment`, y
  // derivamos el total mensual = base + seguro + FGA mensual.
  if (totals.monthlyRate !== undefined) {
    if (totals.baseInstallment === undefined && raw.installmentBase !== undefined) {
      totals.baseInstallment = round2(numeric(raw.installmentBase));
    }
    if (totals.monthlyTotal === undefined && totals.baseInstallment !== undefined) {
      totals.monthlyTotal = round2(
        totals.baseInstallment + (totals.monthlyInsurance ?? 0) + (totals.monthlyFga ?? 0),
      );
    }
  }

  return {
    installments,
    totals,
  };
}

/**
 * Convierte una fila cruda del backend en `LoanRecord`. Acepta tanto el
 * `LoanWithStatsRow` (que trae `loan` dentro) como un `Loan` crudo.
 * Nunca lanza; devuelve null si no hay suficiente información.
 */
function normalizeLoanRow(row) {
  if (!row || typeof row !== "object") return null;

  // Caso LoanWithStatsRow: trae `loan` anidado + estadísticos sueltos.
  const nested = row.loan && typeof row.loan === "object" ? row.loan : null;
  const base = nested ?? row;

  const stats = nested
    ? {
        totalPayable: numeric(row.totalPayable),
        remainingBalance: numeric(row.remainingBalance),
        totalDue: numeric(row.totalDue),
        totalPaid: numeric(row.totalPaid),
        outstandingDue: numeric(row.outstandingDue),
        nextDueDate: typeof row.nextDueDate === "string" ? row.nextDueDate : null,
        nextDueAmount: numeric(row.nextDueAmount),
        installmentsPaid: Number.isFinite(Number(row.installmentsPaid))
          ? Number(row.installmentsPaid)
          : 0,
        installmentsTotal: Number.isFinite(Number(row.installmentsTotal))
          ? Number(row.installmentsTotal)
          : 0,
        principalUsed: numeric(row.principalUsed),
      }
    : null;

  // El backend emite `totalPayable` y `remainingBalance` en el propio Loan
  // (columnas numéricas de la tabla). Si no están y vienen por `stats`, los
  // elevamos; si no, los dejamos como undefined para que los selectores
  // caigan al cálculo local sobre installments.
  const loan = {
    ...base,
    totalPayable:
      numeric(base.totalPayable) ||
      numeric(stats?.totalPayable) ||
      numeric(base.totalPayable),
    remainingBalance:
      numeric(base.remainingBalance) ||
      numeric(stats?.remainingBalance) ||
      numeric(base.remainingBalance),
  };

  // Metadata bancaria y snapshot del banco (migración 023 en diseño).
  // Son opcionales — para préstamos legacy (NONE/SIMPLE) o creados antes
  // de la migración, estos campos vienen ausentes y la UI los omite.
  // Usamos `in` para distinguir "no vino" (undefined) de "vino null"
  // (explícito) y aceptamos ambas convenciones del backend (camelCase y
  // snake_case) por si en algún momento ser serializa diferente.
  const readStr = (camel, snake) => {
    const raw =
      base[camel] !== undefined ? base[camel] : base[snake];
    if (raw === undefined) return undefined;
    if (raw === null) return null;
    const value = typeof raw === "string" ? raw.trim() : String(raw);
    return value === "" ? null : value;
  };
  const readMoney = (camel, snake) => {
    const raw =
      base[camel] !== undefined ? base[camel] : base[snake];
    if (raw === undefined || raw === null || raw === "") return undefined;
    const n = numeric(raw);
    return Number.isFinite(n) ? round2(n) : undefined;
  };
  const readBool = (camel, snake) => {
    const raw =
      base[camel] !== undefined ? base[camel] : base[snake];
    if (raw === undefined) return undefined;
    if (raw === null) return null;
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "string") return /^(true|1|t|yes|y)$/i.test(raw.trim());
    return Boolean(raw);
  };

  const metadataFields = [
    ["creditNumber", "credit_number"],
    ["loanType", "loan_type"],
    ["holderName", "holder_name"],
    ["holderDni", "holder_dni"],
    ["currency", "currency"],
    ["rateType", "rate_type"],
  ];
  for (const [camel, snake] of metadataFields) {
    const value = readStr(camel, snake);
    if (value !== undefined) loan[camel] = value;
  }
  const autoDebit = readBool("autoDebit", "auto_debit");
  if (autoDebit !== undefined) loan.autoDebit = autoDebit;
  const maturity = readStr("maturityDate", "maturity_date");
  if (maturity !== undefined) {
    loan.maturityDate = maturity ? toISODate(maturity) : null;
  }
  const lateRate = readMoney("lateAnnualEffectiveRatePct", "late_annual_effective_rate_pct");
  if (lateRate !== undefined) loan.lateAnnualEffectiveRatePct = lateRate;
  const netDisbursement = readMoney("netDisbursementAmount", "net_disbursement_amount");
  if (netDisbursement !== undefined) loan.netDisbursementAmount = netDisbursement;
  const fgaIva = readMoney("fgaIvaAmount", "fga_iva_amount");
  if (fgaIva !== undefined) loan.fgaIvaAmount = fgaIva;
  const fgaGmf = readMoney("fgaGmfAmount", "fga_gmf_amount");
  if (fgaGmf !== undefined) loan.fgaGmfAmount = fgaGmf;

  const bankBalance = readMoney("bankBalanceAmount", "bank_balance_amount");
  if (bankBalance !== undefined) loan.bankBalanceAmount = bankBalance;
  const bankBalanceAsOfRaw =
    base.bankBalanceAsOf !== undefined ? base.bankBalanceAsOf : base.bank_balance_as_of;
  if (bankBalanceAsOfRaw !== undefined) {
    loan.bankBalanceAsOf =
      bankBalanceAsOfRaw === null ? null : String(bankBalanceAsOfRaw);
  }
  const bankPaid = readMoney("bankPaidAmount", "bank_paid_amount");
  if (bankPaid !== undefined) loan.bankPaidAmount = bankPaid;
  const officialAmount = readMoney(
    "officialNextInstallmentAmount",
    "official_next_installment_amount",
  );
  if (officialAmount !== undefined) loan.officialNextInstallmentAmount = officialAmount;
  const officialDate = readStr(
    "officialNextInstallmentDate",
    "official_next_installment_date",
  );
  if (officialDate !== undefined) {
    loan.officialNextInstallmentDate = officialDate ? toISODate(officialDate) : null;
  }
  // startDate / firstPaymentDate pueden venir en snake_case en algunos
  // envelopes antiguos del backend; los normalizamos a ISO corto.
  if (loan.startDate) loan.startDate = toISODate(loan.startDate);
  if (loan.firstPaymentDate) loan.firstPaymentDate = toISODate(loan.firstPaymentDate);

  // Cuotas: garantizar `totalDue` = principal + interés + seguro + FGA.
  // El detalle (saldo por cuota y monto exacto a pagar) depende de este
  // campo; si el backend no lo manda, la UI mostraría $0.
  if (Array.isArray(base.installments)) {
    loan.installments = base.installments.map((it) => {
      if (!it || typeof it !== "object") return it;
      const insuranceDue = round2(numeric(it.insuranceDue));
      const fgaDue = round2(numeric(it.fgaDue));
      return {
        ...it,
        insuranceDue,
        fgaDue,
        totalDue: round2(installmentTotal(it)),
      };
    });
  }

  if (stats) {
    loan.stats = stats;
    if (!loan.installmentsPaid && stats.installmentsPaid)
      loan.installmentsPaid = stats.installmentsPaid;
    if (!loan.installmentsTotal && stats.installmentsTotal)
      loan.installmentsTotal = stats.installmentsTotal;
    if (!loan.nextDueDate && stats.nextDueDate) loan.nextDueDate = stats.nextDueDate;
    if (!loan.nextDueAmount && stats.nextDueAmount) loan.nextDueAmount = stats.nextDueAmount;
    if (!loan.principalUsed && stats.principalUsed) loan.principalUsed = stats.principalUsed;
    if (!loan.totalPaid && stats.totalPaid) loan.totalPaid = stats.totalPaid;
  }

  return loan;
}

// ---------------------------------------------------------------------------
// Selectores agregados sobre un préstamo (y listas de préstamos)
// ---------------------------------------------------------------------------

/**
 * Capital declarado en una cuota (preferimos los campos explícitos; si no
 * hay, el totalDue menos lo pagado se asume principal).
 *
 * Para préstamos FRENCH que traigan seguro + FGA, el `totalDue` ya suma los
 * cuatro componentes; para préstamos NONE/SIMPLE legacy el `totalDue` sólo
 * tiene principal + interés (y los campos `insuranceDue`/`fgaDue` son 0 o
 * ausentes). En ambos casos este helper devuelve la cuota total a pagar.
 */
function installmentTotal(it) {
  if (!it || typeof it !== "object") return 0;
  const totalDue = numeric(it.totalDue);
  if (totalDue > 0) return totalDue;
  return round2(
    numeric(it.principalDue) +
      numeric(it.interestDue) +
      numeric(it.insuranceDue) +
      numeric(it.fgaDue),
  );
}

function installmentPaid(it) {
  if (!it || typeof it !== "object") return 0;
  return numeric(it.paidAmount);
}

/**
 * Monto por pagar vivo del préstamo.
 *
 * Prioridad de fuentes (de más autoritativa a menos):
 *   1. `loan.remainingBalance` — columna NUMERIC del backend. Es la "deuda
 *      viva" que el backend mantiene actualizada en la misma transacción
 *      que cada pago. Si llega > 0 es la verdad canónica.
 *   2. Sum de remanentes por cuota (si hay installments).
 *   3. `totalPayable - totalPaid` (fallback último recurso).
 *
 * Préstamos PAID o CANCELLED siempre devuelven 0.
 */
export function liveLoanOutstanding(loan) {
  if (!loan || typeof loan !== "object") return 0;
  const status = upper(loan.status);
  if (status === LOAN_STATUSES.PAID || status === LOAN_STATUSES.CANCELLED) return 0;

  // 1) Preferir el valor canónico del backend.
  const canonical = numeric(loan.remainingBalance);
  if (canonical > 0) return round2(canonical);

  // 2) Reconstruir desde las cuotas si vienen.
  const installments = Array.isArray(loan.installments) ? loan.installments : [];
  if (installments.length > 0) {
    const total = installments.reduce((acc, it) => {
      const totalDue = installmentTotal(it);
      const paid = installmentPaid(it);
      return acc + Math.max(0, round2(totalDue - paid));
    }, 0);
    return round2(total);
  }

  // 3) Último recurso: totalPayable - totalPaid.
  const totalPayable = numeric(loan.totalPayable) || numeric(loan.principalAmount);
  const paid = numeric(loan.totalPaid);
  return round2(Math.max(0, totalPayable - paid));
}

/**
 * Total pagado del préstamo. Preferimos stats canónicos del backend; si no,
 * sumamos desde installments.
 */
export function totalPaidOfLoan(loan) {
  if (!loan || typeof loan !== "object") return 0;
  // Si el backend trajo totalPayable y remainingBalance, podemos derivar lo
  // pagado con precisión aritmética idéntica a su cálculo.
  const totalPayable = numeric(loan.totalPayable);
  const remaining = numeric(loan.remainingBalance);
  if (totalPayable > 0 && remaining >= 0 && remaining <= totalPayable) {
    return round2(Math.max(0, totalPayable - remaining));
  }
  // Fallback: sumar desde las cuotas.
  const installments = Array.isArray(loan.installments) ? loan.installments : [];
  if (installments.length > 0) {
    return round2(installments.reduce((acc, it) => acc + installmentPaid(it), 0));
  }
  return round2(numeric(loan.totalPaid));
}

/**
 * Progreso de pago del préstamo (0..1). Usa `totalPayable` como denominador;
 * el numerador se calcula coherentemente para no exceder 1 por drift.
 */
export function loanProgress(loan) {
  if (!loan || typeof loan !== "object") return 0;
  const total = numeric(loan.totalPayable) || numeric(loan.principalAmount);
  if (total <= 0) return 0;
  const paid = totalPaidOfLoan(loan);
  return Math.max(0, Math.min(1, paid / total));
}

/**
 * Capital disponible del préstamo = principal - Σ(amountUsed en loan_expenses).
 *
 * Prioriza el stat canónico `principalUsed` del backend si vino en la lista.
 * En el detalle (con `expenses` cargado) suma directamente los
 * `amountUsed`.
 */
export function liveLoanAvailable(loan) {
  if (!loan || typeof loan !== "object") return 0;
  const principal = numeric(loan.principalAmount);
  if (principal <= 0) return 0;

  // Fuente canónica si vino con stats.
  const canonicalUsed = numeric(loan.principalUsed ?? loan.stats?.principalUsed);
  if (canonicalUsed > 0) return round2(Math.max(0, principal - canonicalUsed));

  const items = Array.isArray(loan.expenses) ? loan.expenses : [];
  const used = items.reduce(
    (acc, e) => acc + numeric(e?.amountUsed ?? e?.amount_used),
    0,
  );
  return round2(Math.max(0, principal - used));
}

/**
 * Suma del saldo pendiente de una lista de préstamos. Útil en dashboard.
 */
export function sumLoans(loans) {
  if (!Array.isArray(loans)) return 0;
  return round2(loans.reduce((acc, l) => acc + liveLoanOutstanding(l), 0));
}

/**
 * Suma del principal activo (ACTIVE/DEFAULTED). Préstamos cancelados o
 * pagados no cuentan.
 */
export function sumActivePrincipal(loans) {
  if (!Array.isArray(loans)) return 0;
  return round2(
    loans.reduce((acc, l) => {
      const status = upper(l?.status);
      if (status === LOAN_STATUSES.CANCELLED || status === LOAN_STATUSES.PAID) return acc;
      return acc + numeric(l?.principalAmount);
    }, 0),
  );
}

/**
 * Agrupa las cuotas de un préstamo en 3 cubetas: paid / overdue / pending.
 * Overdue = no PAID y due_date < hoy (America/Bogota aproximado por fecha local).
 */
export function groupInstallmentsByStatus(loan, todayIso = toISODate(new Date())) {
  const buckets = { paid: [], overdue: [], pending: [] };
  const items = Array.isArray(loan?.installments) ? loan.installments : [];
  for (const it of items) {
    const totalDue = installmentTotal(it);
    const paid = installmentPaid(it);
    const status = upper(it?.status);
    if (status === INSTALLMENT_STATUSES.PAID || (totalDue > 0 && paid >= totalDue)) {
      buckets.paid.push(it);
      continue;
    }
    const due = it?.dueDate;
    if (isIsoDate(due) && isIsoDate(todayIso) && due < todayIso) {
      buckets.overdue.push(it);
      continue;
    }
    buckets.pending.push(it);
  }
  return buckets;
}

/**
 * Cuotas que vencen dentro de los próximos N días (incluye hoy, excluye las
 * ya pagadas).
 */
export function upcomingInstallments(loans, days = 30, today = new Date()) {
  if (!Array.isArray(loans)) return [];
  const startIso = toISODate(today);
  const end = new Date(today.getTime());
  end.setDate(end.getDate() + Math.max(0, Math.floor(numeric(days))));
  const endIso = toISODate(end);
  const out = [];
  for (const loan of loans) {
    const list = Array.isArray(loan?.installments) ? loan.installments : [];
    for (const it of list) {
      const totalDue = installmentTotal(it);
      const paid = installmentPaid(it);
      if (upper(it?.status) === INSTALLMENT_STATUSES.PAID) continue;
      if (totalDue > 0 && paid >= totalDue) continue;
      const due = it?.dueDate;
      if (!isIsoDate(due)) continue;
      if (due >= startIso && due <= endIso) {
        out.push({ ...it, loanId: loan.id, lenderName: loan.lenderName });
      }
    }
  }
  return out.sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));
}

/**
 * Resumen agregado para el dashboard de préstamos.
 */
export function summarizeLoans(loans, today = new Date()) {
  const safeLoans = Array.isArray(loans) ? loans : [];
  const todayIso = toISODate(today);

  let activeCount = 0;
  let overdueCount = 0;
  let overdueAmount = 0;
  let totalPaid = 0;

  for (const loan of safeLoans) {
    const status = upper(loan?.status);
    if (status === LOAN_STATUSES.ACTIVE || status === LOAN_STATUSES.DEFAULTED) activeCount++;
    const buckets = groupInstallmentsByStatus(loan, todayIso);
    overdueCount += buckets.overdue.length;
    overdueAmount += buckets.overdue.reduce(
      (acc, it) => acc + Math.max(0, installmentTotal(it) - installmentPaid(it)),
      0,
    );
    totalPaid += totalPaidOfLoan(loan);
  }

  return {
    activeCount,
    overdueCount,
    overdueAmount: round2(overdueAmount),
    totalPrincipal: sumActivePrincipal(safeLoans),
    totalOutstanding: sumLoans(safeLoans),
    totalPaid: round2(totalPaid),
    upcoming30d: upcomingInstallments(safeLoans, 30, today),
  };
}

/**
 * Clasificación de una cuota — útil para la tabla de amortización.
 */
export function classifyInstallment(it, todayIso = toISODate(new Date())) {
  const totalDue = installmentTotal(it);
  const paid = installmentPaid(it);
  const status = upper(it?.status);
  if (status === INSTALLMENT_STATUSES.PAID || (totalDue > 0 && paid >= totalDue)) return "paid";
  if (paid > 0 && paid < totalDue) return "partial";
  const due = it?.dueDate;
  if (isIsoDate(due) && isIsoDate(todayIso) && due < todayIso) return "overdue";
  return "pending";
}

/**
 * Progreso de una cuota (0..1).
 */
export function installmentProgress(it) {
  const total = installmentTotal(it);
  const paid = installmentPaid(it);
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, paid / total));
}

/**
 * Dinero legible en formato COP.
 */
export function formatLoanMoney(value) {
  const n = Math.round(numeric(value));
  return `$${n.toLocaleString("es-CO")}`;
}

/**
 * Delta entre el próximo pago oficial del banco y la próxima cuota estimada
 * del cronograma del POS. La UI muestra ambos valores lado a lado y expone
 * el delta — nunca se oculta. El `remainingBalance` interno del POS NO se
 * reconcilia con `bankBalanceAmount`.
 *
 *   officialAmount / officialDate   → `loan.officialNextInstallment*`
 *   estimatedAmount / estimatedDate → primera cuota con saldo pendiente
 *   amountDelta = official − estimated  (positivo si el banco pide más)
 *   dateDelta   = días oficial − estimada (positivo si el banco corta después)
 *   hasOfficial                  → false cuando no hay datos del banco
 */
export function nextInstallmentDelta(loan) {
  if (!loan || typeof loan !== "object") return null;

  const officialAmountRaw =
    loan.officialNextInstallmentAmount ??
    loan.official_next_installment_amount ??
    null;
  const officialDateRaw =
    loan.officialNextInstallmentDate ??
    loan.official_next_installment_date ??
    null;

  const officialAmount =
    officialAmountRaw === null || officialAmountRaw === undefined || officialAmountRaw === ""
      ? null
      : round2(numeric(officialAmountRaw));
  const officialDate = officialDateRaw ? toISODate(officialDateRaw) : null;

  // Siguiente cuota estimada: primera no pagada.
  const installments = Array.isArray(loan.installments) ? loan.installments : [];
  let estimatedAmount = null;
  let estimatedDate = null;
  for (const it of installments) {
    const totalDue = installmentTotal(it);
    const paid = installmentPaid(it);
    const remaining = round2(Math.max(0, totalDue - paid));
    const status = upper(it?.status);
    if (status === INSTALLMENT_STATUSES.PAID || (totalDue > 0 && paid >= totalDue)) continue;
    estimatedAmount = remaining;
    estimatedDate = it?.dueDate ? toISODate(it.dueDate) : null;
    break;
  }
  // Fallback de nextDueAmount/nextDueDate cuando el detalle no incluye
  // installments pero el listado sí trajo stats.
  if (estimatedAmount === null && numeric(loan.nextDueAmount) > 0) {
    estimatedAmount = round2(numeric(loan.nextDueAmount));
  }
  if (estimatedDate === null && typeof loan.nextDueDate === "string") {
    estimatedDate = toISODate(loan.nextDueDate);
  }

  const hasOfficial = officialAmount !== null || !!officialDate;

  let amountDelta = null;
  if (officialAmount !== null && estimatedAmount !== null) {
    amountDelta = round2(officialAmount - estimatedAmount);
  }

  let dateDelta = null;
  if (officialDate && estimatedDate) {
    const a = parseLocalDate(officialDate);
    const b = parseLocalDate(estimatedDate);
    if (!Number.isNaN(a.getTime()) && !Number.isNaN(b.getTime())) {
      const ms = a.getTime() - b.getTime();
      dateDelta = Math.round(ms / (1000 * 60 * 60 * 24));
    }
  }

  return {
    hasOfficial,
    officialAmount,
    officialDate,
    estimatedAmount,
    estimatedDate,
    amountDelta,
    dateDelta,
  };
}
