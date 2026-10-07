function numeric(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseLocalizedAmount(value) {
  let normalized = String(value ?? '').trim().replace(/\$/g, '');
  if (!normalized) return 0;
  if (normalized.includes(',')) normalized = normalized.replace(/\./g, '').replace(',', '.');
  else if (normalized.includes('.') && !/\.\d{1,2}$/.test(normalized)) normalized = normalized.replace(/\./g, '');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseObject(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

export function getRealPhysicalCash(closure) {
  if (typeof closure?.physicalCashReal === 'number' && closure.physicalCashReal > 0) {
    return closure.physicalCashReal;
  }

  let bills = numeric(closure?.cashBills);
  let coins = numeric(closure?.coins1000) + numeric(closure?.coins500) + numeric(closure?.coins200) + numeric(closure?.coins100);
  const breakdown = parseObject(closure?.cashBreakdown);

  if (breakdown?.bills && typeof breakdown.bills === 'object') {
    const calculated = Object.entries(breakdown.bills).reduce(
      (total, [denomination, quantity]) => total + numeric(denomination) * numeric(quantity),
      0,
    );
    if (calculated > 0) bills = calculated;
  }
  if (breakdown?.coins && typeof breakdown.coins === 'object') {
    const calculated = ['500/1000', '200', '100', '50'].reduce(
      (total, key) => total + numeric(breakdown.coins[key]),
      0,
    );
    if (calculated > 0) coins = calculated;
  }

  return bills + coins > 0 ? bills + coins : numeric(closure?.physicalCash);
}

// ----------------------------------------------------------------------------
// Clasificación de un egreso en los canales reales que lleva el backend.
//
// Antes esta función devolvía SOLO { cash, nequi, daviplata, fondo } y
// cualquier gasto cuya fuente fuera "ALCANCIA" o "MONEDAS" caía al canal cash,
// contaminando el efectivo contado. El backend
// (`services/export_service_consolidated.go::parseExpenseChannels` y
// `services/closure_metrics.go`) sí separa `MONEDA`/`ALCANC` como canal
// independiente (`EgresosAlcancia`). Esta función ahora replica esa misma
// semántica para que las tarjetas del frontend coincidan con los totales del
// servidor.
//
// Canales retornados:
//   cash       → EFECTIVO/CAJA/CASH
//   nequi      → NEQUI
//   daviplata  → DAVIPLATA/DAVI
//   fondo      → FONDO/BOVEDA
//   coins      → ALCANCIA/ALCANCÍA/MONEDAS/MONEDA
// ----------------------------------------------------------------------------
function matchesChannel(source, channel) {
  switch (channel) {
    case 'coins':
      // Español: alcancia / alcancía / moneda / monedas. Prefijo ALCANC cubre
      // todas las variantes acentuadas sin complicar la lógica.
      return (
        source.includes('ALCANC') ||
        source.includes('MONEDA') ||
        source.includes('MONEDAS')
      );
    case 'nequi':
      return source.includes('NEQUI') || source.includes('NEQ');
    case 'daviplata':
      return source.includes('DAVIPLATA') || source.includes('DAVI');
    case 'fondo':
      return (
        source.includes('FONDO') ||
        source.includes('BOVEDA') ||
        source.includes('BÓVEDA') ||
        source.includes('FOND')
      );
    case 'cash':
      return (
        source.includes('CAJA') ||
        source.includes('EFECTIVO') ||
        source.includes('CASH') ||
        source.includes('EFEC')
      );
    default:
      return false;
  }
}

export function expenseChannels(expense) {
  const base = numeric(expense.amount);
  const total = base + numeric(expense.taxAmount ?? expense.tax_amount);
  const raw = {
    cash: numeric(expense.cashAmount ?? expense.cash_amount),
    nequi: numeric(expense.nequiAmount ?? expense.nequi_amount),
    daviplata: numeric(expense.daviplataAmount ?? expense.daviplata_amount),
    fondo: numeric(expense.fondoAmount ?? expense.fondo_amount),
    coins: numeric(expense.coinsAmount ?? expense.coins_amount ?? expense.alcanciaAmount ?? expense.alcancia_amount),
  };
  if (raw.cash + raw.nequi + raw.daviplata + raw.fondo + raw.coins > 0) return raw;

  const result = { cash: 0, nequi: 0, daviplata: 0, fondo: 0, coins: 0 };
  const source = String(expense.paymentSource ?? expense.payment_source ?? '').toUpperCase();
  if (source.includes('/')) {
    for (const part of source.split('/')) {
      const match = part.match(/\$?([0-9.,]+)/);
      const amount = match ? parseLocalizedAmount(match[1]) : 0;
      // El orden importa: ALCANCIA debe revisarse ANTES que CAJA/EFECTIVO
      // porque la alcancía es un cajón físico separado de la caja chica.
      if (matchesChannel(part, 'coins')) result.coins += amount;
      else if (matchesChannel(part, 'nequi')) result.nequi += amount;
      else if (matchesChannel(part, 'daviplata')) result.daviplata += amount;
      else if (matchesChannel(part, 'fondo')) result.fondo += amount;
      else if (matchesChannel(part, 'cash')) result.cash += amount;
    }
    if (result.cash + result.nequi + result.daviplata + result.fondo + result.coins === 0) {
      result.cash = total || base;
    }
    return result;
  }

  // Fuentes simples (sin "/" indicando mixto).
  if (matchesChannel(source, 'coins')) result.coins = total || base;
  else if (matchesChannel(source, 'nequi')) result.nequi = total || base;
  else if (matchesChannel(source, 'daviplata')) result.daviplata = total || base;
  else if (matchesChannel(source, 'fondo')) result.fondo = total || base;
  else if (!source.includes('PREST') && !source.includes('DEUDA')) result.cash = total || base;
  return result;
}

export function getClosureExpensesSummary(closure) {
  if (typeof closure?.egresosTotales === 'number') {
    return {
      cashExpenses: numeric(closure.egresosCaja),
      totalExpenses: numeric(closure.egresosTotales),
      fondoExpenses: numeric(closure.egresosFondo),
      digitalExpenses: numeric(closure.egresosDigital),
      coinsExpenses: numeric(closure.egresosAlcancia ?? closure.egresosCoins),
    };
  }

  const summary = {
    cashExpenses: 0,
    totalExpenses: 0,
    fondoExpenses: 0,
    digitalExpenses: 0,
    coinsExpenses: 0,
  };
  const parsed = parseObject(closure?.expensesDetail);
  const expenses = Array.isArray(parsed) ? parsed : [];
  for (const expense of expenses) {
    if (!expense || String(expense.status ?? '').toUpperCase() === 'PENDING') continue;
    if (String(expense.category ?? '').toUpperCase() === 'DEVOLUCIONES') continue;
    const channels = expenseChannels(expense);
    summary.cashExpenses += channels.cash;
    summary.fondoExpenses += channels.fondo;
    summary.digitalExpenses += channels.nequi + channels.daviplata;
    summary.coinsExpenses += channels.coins;
    summary.totalExpenses += channels.cash + channels.fondo + channels.nequi + channels.daviplata + channels.coins;
  }
  return summary;
}

export function getVentasCajero(closure) {
  if (typeof closure?.ventasCajero === 'number' && closure.ventasCajero > 0) return closure.ventasCajero;
  const digitalIncome = numeric(closure?.totalNequi) + numeric(closure?.totalDaviplata) + numeric(closure?.totalCard) + numeric(closure?.totalBancolombia) + numeric(closure?.totalOtherTransfer);
  return getRealPhysicalCash(closure) + digitalIncome + getClosureExpensesSummary(closure).cashExpenses + numeric(closure?.totalReturns);
}

// ============================================================================
// ¿SE PUEDE CERRAR LA CAJA?
//
// REPORTE DEL DUEÑO (2026-09-10): "En el cierre cuando no registro billetes no
// me está dejando cerrar caja".
//
// El botón CERRAR CAJA estaba con isDisabled cuando el campo de efectivo
// contado quedaba vacío: se veía apagado y sin ninguna explicación, así que la
// única salida era adivinar que había que llenar la grilla de billetes.
//
// El bloqueo tenía una razón legítima que NO se puede tirar a la basura: cerrar
// con el campo vacío guardaría $0 de efectivo físico y un faltante falso igual a
// todo lo esperado, que después aparece como descuadre en los reportes y en el
// cuadre real.
//
// La respuesta correcta no es bloquear en silencio ni dejar pasar en silencio,
// sino PREGUNTAR una vez. Esta función decide qué hace falta; la pantalla se
// encarga de preguntarlo.
// ============================================================================

/**
 * Decide si el cierre puede enviarse y, si no, qué le falta.
 *
 * @param {object} input
 * @param {string}  input.actualCashInput  texto del campo de efectivo contado
 * @param {number}  input.expectedCash     efectivo que el sistema espera
 * @param {boolean} [input.isEditMode]     true al corregir un cierre histórico
 * @param {boolean} [input.confirmedNoCash] true si ya confirmó que no hay efectivo
 * @returns {{ canSubmit: boolean, needsCashDeclaration: boolean, reason: string }}
 */
export function evaluateClosureSubmission({
  actualCashInput,
  expectedCash,
  isEditMode = false,
  confirmedNoCash = false,
}) {
  const declarado = String(actualCashInput ?? '').trim();
  const esperado = numeric(expectedCash);

  // Corregir un cierre histórico no exige volver a contar: el admin ya está
  // editando cifras existentes desde reportes.
  if (isEditMode) {
    return { canSubmit: true, needsCashDeclaration: false, reason: 'edit_mode' };
  }

  // Con un monto escrito —incluido "0"— hay declaración y se puede cerrar.
  // Ojo: "0" es una declaración válida y distinta de dejar el campo vacío.
  if (declarado !== '') {
    return { canSubmit: true, needsCashDeclaration: false, reason: 'declarado' };
  }

  // Campo vacío pero el sistema no esperaba efectivo: no hay nada que declarar
  // ni faltante que inventar. Es el día que se vendió todo por transferencia.
  if (esperado <= 0) {
    return { canSubmit: true, needsCashDeclaration: false, reason: 'sin_efectivo_esperado' };
  }

  // Campo vacío con efectivo esperado: hay que preguntar.
  if (confirmedNoCash) {
    return { canSubmit: true, needsCashDeclaration: false, reason: 'confirmado_sin_efectivo' };
  }
  return { canSubmit: false, needsCashDeclaration: true, reason: 'falta_declarar_efectivo' };
}

// ============================================================================
// SANITIZACIÓN DE cashBreakdown
//
// Antes el frontend enviaba literalmente `{ bills: {"50000": ""}, coins: ... }`
// y el backend (`services.applyCashBreakdown`) usaba `strconv.ParseFloat("")`
// que devuelve error "cantidad inválida para denominación". El cierre abortaba
// aunque el cajero sí hubiera contado por el campo "Total Manual".
//
// Esta función convierte cualquier `""`, `null`, `undefined`, espacios o
// strings con prefijos "$", separadores de miles, etc. a números seguros. Los
// valores NO numéricos (p. ej. "abc") caen a 0 porque son texto no útil.
// ============================================================================

function sanitizeDenominationQuantity(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const raw = String(value).trim();
  if (raw === '') return 0;
  const parsed = parseLocalizedAmount(raw);
  // Las cantidades de billetes/monedas se guardan como enteros no negativos.
  // Si el input viene como "3.000" (típico en coins), parseLocalizedAmount
  // ya devolvió 3000; floor por seguridad.
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

/**
 * Convierte el objeto `{ bills: {...}, coins: {...} }` del frontend en una
 * forma segura para el backend: todas las denominaciones son enteros no
 * negativos, los `""` se vuelven 0, los NaN caen a 0, los `null` también.
 *
 * El contrato con el backend sigue siendo el mismo (`bills` y `coins` como
 * mapas string→number), sólo cambia que ahora NUNCA viajan strings vacíos.
 *
 * @param {{bills?: Record<string, unknown>, coins?: Record<string, unknown>} | null | undefined} raw
 * @returns {{ bills: Record<string, number>, coins: Record<string, number> }}
 */
export function sanitizeCashBreakdown(raw) {
  const safeInput = raw && typeof raw === 'object' ? raw : {};
  const bills = {};
  const coins = {};
  const srcBills = safeInput.bills && typeof safeInput.bills === 'object' ? safeInput.bills : {};
  const srcCoins = safeInput.coins && typeof safeInput.coins === 'object' ? safeInput.coins : {};
  for (const [denom, qty] of Object.entries(srcBills)) {
    bills[String(denom)] = sanitizeDenominationQuantity(qty);
  }
  for (const [denom, qty] of Object.entries(srcCoins)) {
    coins[String(denom)] = sanitizeDenominationQuantity(qty);
  }
  return { bills, coins };
}

/**
 * Serializa el breakdown a JSON listo para el payload. Si todas las
 * denominaciones son 0, igual se envía el objeto vacío (`{}`) para que el
 * backend pueda detectar "el cajero no usó la grilla" sin crashear.
 *
 * @param {{bills?: Record<string, unknown>, coins?: Record<string, unknown>} | null | undefined} raw
 */
export function serializeCashBreakdown(raw) {
  return JSON.stringify(sanitizeCashBreakdown(raw));
}

// ============================================================================
// IDEMPOTENCIA ANTI-DOBLE-CIERRE
//
// Sin un ID estable por intento, un POST con red lenta que termina en timeout
// no se puede reintentar con seguridad: dos envíos crean dos cierres aunque la
// pantalla muestre un solo botón.
//
// El contrato con el backend es:
//   - frontend genera UUID por intento
//   - lo guarda en localStorage ("pos_closure_tx_id")
//   - lo manda en el payload como `clientTxId`
//   - lo limpia tras éxito
//   - lo reutiliza en reintentos
//
// El backend verifica `WHERE client_tx_id = ?` dentro de la transacción. Si
// la migración 018 todavía no está aplicada, el backend ignora el campo y
// vuelve al comportamiento sin idempotencia (ver propuesta de auditoría_cierre).
//
// Esta función respeta `globalThis.crypto.randomUUID` cuando existe, y cae a
// un generador basado en timestamp+random para entornos de test puros donde
// `crypto` no está disponible.
// ============================================================================

export const CLOSURE_TX_STORAGE_KEY = 'pos_closure_tx_id';

/**
 * Genera un UUID v4-ish. Prefiere `crypto.randomUUID` del entorno; si no
 * existe (SSR estricto o Node viejo), devuelve una cadena única no criptográfica
 * suficiente para idempotencia a nivel de UI.
 * @returns {string}
 */
export function generateClientClosureId() {
  const g = typeof globalThis !== 'undefined' ? globalThis : undefined;
  const c = g && g.crypto;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      // ignore, caer al fallback
    }
  }
  // Fallback: timestamp (ms) + 4 segmentos random. No es criptográfico, pero
  // la probabilidad de colisión entre dos intentos del mismo cajero en la
  // misma noche es ~0 y, aunque chocaran, el backend validaría integridad
  // con el idempotency check igual.
  const rand = (n) => Math.random().toString(16).slice(2, 2 + n).padEnd(n, '0');
  return `cx-${Date.now().toString(16)}-${rand(4)}-${rand(4)}-${rand(8)}`;
}

/**
 * Obtiene (o crea) el `clientTxId` persistente del intento actual.
 * - Si ya hay uno en `localStorage`, lo retorna sin tocarlo.
 * - Si no hay, genera uno nuevo y lo guarda.
 * - En SSR (sin `localStorage`), genera uno nuevo sin persistir.
 *
 * @param {Storage | null} [storage] permite inyectar un localStorage de test.
 */
export function getOrCreateClientClosureId(storage) {
  const store = storage ?? (typeof globalThis !== 'undefined' && globalThis.localStorage) ?? null;
  if (!store) {
    return generateClientClosureId();
  }
  try {
    const existing = store.getItem(CLOSURE_TX_STORAGE_KEY);
    if (existing && typeof existing === 'string' && existing.length >= 8) {
      return existing;
    }
    const fresh = generateClientClosureId();
    store.setItem(CLOSURE_TX_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    // localStorage puede estar deshabilitado (modo privado, cuota llena...).
    // Devolvemos un id efímero: pierde idempotencia entre pestañas pero no
    // bloquea el cierre.
    return generateClientClosureId();
  }
}

/**
 * Limpia el `clientTxId` persistente. Llamar sólo tras éxito confirmado del
 * backend. Nunca llamar tras un error 5xx/red: el usuario podría reintentar y
 * necesitaríamos el mismo ID.
 *
 * @param {Storage | null} [storage]
 */
export function clearClientClosureId(storage) {
  const store = storage ?? (typeof globalThis !== 'undefined' && globalThis.localStorage) ?? null;
  if (!store) return;
  try {
    store.removeItem(CLOSURE_TX_STORAGE_KEY);
  } catch {
    // ignorar
  }
}

// ============================================================================
// LIMPIEZA DE sessionStorage/localStorage del cierre
//
// Las claves `pos_closure_bills`, `pos_closure_coins`, `pos_closure_actual`,
// `pos_closure_salary`, `pos_closure_operational`, `pos_closure_note` y
// `pos_closure_tx_id` persisten el conteo entre recargas y permiten reanudar
// un cierre si la pestaña se cerró.
//
// Pero DEBEN limpiarse:
//   - al cerrar sesión (logout)
//   - al cambiar de usuario
//   - tras un cierre exitoso
//
// Si no, el siguiente cajero vería datos del anterior.
// ============================================================================

const CLOSURE_STORAGE_KEYS = [
  'pos_closure_bills',
  'pos_closure_coins',
  'pos_closure_actual',
  'pos_closure_salary',
  'pos_closure_operational',
  'pos_closure_note',
  CLOSURE_TX_STORAGE_KEY,
];

/**
 * Devuelve la lista exacta de claves de localStorage que el flujo de cierre
 * usa. Útil para tests que verifican que todo se limpia.
 */
export function listClosureStorageKeys() {
  return [...CLOSURE_STORAGE_KEYS];
}

/**
 * Borra todas las claves locales del cierre.
 * @param {Storage | null} [storage]
 */
export function clearClosureStorage(storage) {
  const store = storage ?? (typeof globalThis !== 'undefined' && globalThis.localStorage) ?? null;
  if (!store) return;
  for (const key of CLOSURE_STORAGE_KEYS) {
    try {
      store.removeItem(key);
    } catch {
      // ignorar
    }
  }
}
