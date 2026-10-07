// ============================================================================
// REGLAS DE AUTORIZACIÓN: CORRECCIÓN DE MEDIO DE PAGO
// ============================================================================
//
// Hay DOS endpoints para corregir el canal de pago de una venta:
//
//   1. PUT /sales/update-payment/:id — SOLO administradores. Permite
//      cualquier redistribución, incluido mover a/desde fiado. El flujo
//      largo de "corregir una venta vieja" vive aquí.
//
//   2. POST /sales/correct-payment-channel/:id — EMPLEADO del mismo turno.
//      Es un servicio ACOTADO:
//        - Sólo la venta la hizo ese empleado y su turno aún está abierto.
//        - No cambia el total, cliente, productos ni mueve a FIADO.
//        - Sólo redistribuye el mismo total entre efectivo y canales de
//          transferencia (NEQUI / DAVIPLATA / otras).
//        - Bloquea ventas con devoluciones o abonos/fiado.
//
// Este archivo vive en .mjs puro para poder probarlo con `node --test`. La
// UI usa `resolvePaymentCorrectionEndpoint(sale, user)` para decidir qué
// endpoint llamar y qué errores de 403/409 son esperables.

// Fuente única de roles: ver src/lib/auth-helpers.mjs. Antes este archivo
// mantenía un set paralelo que no reconocía "super_admin" / "root" y creaba
// discrepancias con /dashboard/closure y /labels. Al delegar al helper central
// cualquier futura variación del backend (p. ej. "administrador") se propaga a
// todas las pantallas con un solo cambio.
import { isAdminUser, isEmployeeRole, roleOfUser } from "./auth-helpers.mjs";

function dniOf(subject) {
  if (!subject || typeof subject !== "object") return "";
  const raw = subject.dni || subject.employeeDni || subject.DNI || "";
  return typeof raw === "string" ? raw.trim() : String(raw);
}

/** Rol admin del usuario. Delegado al helper central. */
export function isAdmin(user) {
  return isAdminUser(user);
}

export function isEmployee(user) {
  return isEmployeeRole(roleOfUser(user));
}

/**
 * El empleado que hizo la venta tiene permiso cuando TODAS estas se cumplen:
 *   - El rol del usuario actual es "empleado".
 *   - El DNI del empleado de la venta coincide con el DNI del usuario actual.
 *   - La venta NO tiene devoluciones registradas (returnedQty > 0 en algún
 *     detalle, o hasReturns === true).
 *   - La venta NO fue fiada ni tiene abonos (creditAmount > 0, debtPending
 *     > 0, o cualquier hint equivalente).
 *   - El turno del empleado sigue abierto (shiftOpen=true pasado explícito,
 *     o se omite y confiamos en el backend; la UI preguntará por el estado
 *     del turno antes de habilitar el botón).
 */
export function employeeCanCorrectPayment(sale, user, { shiftOpen } = {}) {
  if (!isEmployee(user)) return false;
  if (!sale || typeof sale !== "object") return false;

  const employeeDni = dniOf(sale.employee) || dniOf({ dni: sale.employeeDni });
  const userDni = dniOf(user);
  if (!employeeDni || !userDni) return false;
  if (employeeDni !== userDni) return false;

  if (hasReturns(sale)) return false;
  if (hasCreditOrPayables(sale)) return false;
  if (shiftOpen === false) return false;

  return true;
}

/**
 * El admin SIEMPRE puede corregir, con cualquier modificación. La UI usa
 * este helper para decidir si pintar el botón "Corregir pago" cuando el
 * usuario es administrador.
 */
export function adminCanCorrectPayment(sale, user) {
  if (!isAdmin(user)) return false;
  if (!sale || typeof sale !== "object") return false;
  return true;
}

/**
 * Decide qué endpoint y método debe usar la UI al corregir el canal de pago.
 *
 *   - admin   → PUT /sales/update-payment/:id  (sin cambios)
 *   - empleado→ POST /sales/correct-payment-channel/:id (nuevo)
 *   - resto   → null (no debe aparecer el botón)
 *
 * SEGURIDAD: el endpoint POST para empleado NO existe para eludir la
 * autorización por verbo HTTP. El backend valida el actor, el turno, la
 * ausencia de devoluciones/fiado y rechaza con 403/409. El cambio de método
 * HTTP responde a un servicio semánticamente distinto (correct-payment-
 * channel vs update-payment) y por eso NO se expone el endpoint admin a
 * roles no admin. Documentado en tests/* y en el handler del backend.
 */
export function resolvePaymentCorrectionEndpoint(sale, user, options = {}) {
  if (adminCanCorrectPayment(sale, user)) {
    return {
      method: "PUT",
      path: `/sales/update-payment/${sale?.id ?? ""}`,
      actor: "admin",
    };
  }
  if (employeeCanCorrectPayment(sale, user, options)) {
    return {
      method: "POST",
      path: `/sales/correct-payment-channel/${sale?.id ?? ""}`,
      actor: "employee",
    };
  }
  return null;
}

/**
 * Monto inicial precargado en el modal, derivado de la venta tal como vino
 * del historial. Precarga EXACTAMENTE lo que figura hoy en la venta para que
 * el empleado solo deba mover montos entre canales, sin tener que recordar
 * nombres ni tipear totales.
 *
 * Shape devuelto (contrato con `UniversalPaymentModal`):
 *
 *   {
 *     cash:                number,  // sale.cashAmount
 *     nequi:               number,  // sale.transferNequi
 *     daviplata:           number,  // sale.transferDaviplata
 *     otherTransfer:       number,  // sale.transferAmount - nequi - daviplata (>=0)
 *     otherTransferSource: string,  // sale.transferSource si no es NEQUI/DAVIPLATA/MIXTO
 *     credit:              number,  // sale.creditAmount
 *     // --- Alias retrocompatibles con la version anterior del shape: ---
 *     transfer:            number,  // total transferAmount (suma)
 *     transferSource:      string,  // fuente "principal" para el modal
 *   }
 *
 * Antes esta funcion colapsaba Nequi + Daviplata en un solo
 * `{transfer, transferSource}` singular, lo que impedia precargar las dos
 * fuentes cuando una venta corregida tenia breakdown mixto. El modal
 * recibia 0 en los dos canales y el cajero tenia que redigitar los montos.
 */
export function initialPaidAmountsFromSale(sale) {
  if (!sale || typeof sale !== "object") {
    return {
      cash: 0,
      nequi: 0,
      daviplata: 0,
      otherTransfer: 0,
      otherTransferSource: "",
      credit: 0,
      transfer: 0,
      transferSource: "",
    };
  }
  const cash = Number(sale.cashAmount) || 0;
  const transfer = Number(sale.transferAmount) || 0;
  const credit = Number(sale.creditAmount) || 0;
  const nequi = Number(sale.transferNequi) || 0;
  const daviplata = Number(sale.transferDaviplata) || 0;
  const otherTransfer = Math.max(0, transfer - nequi - daviplata);
  const rawSource = typeof sale.transferSource === "string"
    ? sale.transferSource.toUpperCase().trim()
    : "";
  // El "source principal" sirve de hint al modal para elegir el tab
  // inicial. Si hay un solo canal digital con monto, usamos ese; si no,
  // elegimos el mayor; si todo esta vacio, respetamos el source legacy
  // cuando sea util.
  let transferSource = "";
  if (nequi > 0 && daviplata === 0) transferSource = "NEQUI";
  else if (daviplata > 0 && nequi === 0) transferSource = "DAVIPLATA";
  else if (nequi > 0 && daviplata > 0) transferSource = nequi >= daviplata ? "NEQUI" : "DAVIPLATA";
  else if (otherTransfer > 0 && rawSource && rawSource !== "MIXTO") transferSource = rawSource;
  else if (rawSource && rawSource !== "MIXTO") transferSource = rawSource;
  // El "other transfer source" es solo informativo (TRANSFERENCIA / banco)
  // y NO se usa como fuente principal cuando hay desglose Nequi/Daviplata.
  const otherTransferSource = (otherTransfer > 0 && rawSource && rawSource !== "NEQUI" && rawSource !== "DAVIPLATA" && rawSource !== "MIXTO")
    ? rawSource
    : "";
  return {
    cash,
    nequi,
    daviplata,
    otherTransfer,
    otherTransferSource,
    credit,
    transfer,
    transferSource,
  };
}

/**
 * Valida el payload que la UI va a enviar al endpoint POR EMPLEADO. No
 * sustituye las validaciones del backend (que son la autoridad), pero
 * evita viajes de red innecesarios.
 *
 *   - sumPayments === sale.total       (no puede cambiar el total)
 *   - creditAmount === 0               (no puede mover a/desde FIADO)
 *   - cashAmount, transferAmount >= 0
 *   - transferNequi + transferDaviplata <= transferAmount + tolerancia
 *     (replica la regla equivalente del backend
 *     ValidateCorrectPaymentChannelRequest para que el payload sea
 *     coherente antes de salir a la red).
 */
export function validateEmployeeCorrectionPayload(payload, sale) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "payload-invalid" };
  }
  const expected = Number(sale?.total) || 0;
  const cash = Number(payload.cashAmount) || 0;
  const transfer = Number(payload.transferAmount) || 0;
  const credit = Number(payload.creditAmount) || 0;
  const nequi = Number(payload.transferNequi) || 0;
  const daviplata = Number(payload.transferDaviplata) || 0;
  if (cash < 0 || transfer < 0 || credit < 0 || nequi < 0 || daviplata < 0) {
    return { ok: false, error: "negative-amount" };
  }
  if (credit !== 0) {
    return { ok: false, error: "credit-not-allowed" };
  }
  // Backend tolerancia: 5 pesos (ver paymentCorrectionTolerance). Mantenerlo
  // en sync aqui evita un 400 por redondeos.
  const breakdown = nequi + daviplata;
  if (breakdown > transfer + 5) {
    return { ok: false, error: "transfer-breakdown-exceeds-total", transfer, breakdown };
  }
  const sum = cash + transfer + credit;
  // Tolerancia de 1 peso para redondeos al centavo del backend.
  if (Math.abs(sum - expected) > 1) {
    return { ok: false, error: "total-mismatch", expected, sum };
  }
  return { ok: true };
}

// ---------- Helpers internos ----------

function hasReturns(sale) {
  if (!sale) return false;
  if (sale.hasReturns === true) return true;
  if (Array.isArray(sale.details)) {
    for (const detail of sale.details) {
      if (!detail) continue;
      const returned = Number(detail.returnedQty || detail.returned_qty || 0);
      if (Number.isFinite(returned) && returned > 0) return true;
    }
  }
  return false;
}

function hasCreditOrPayables(sale) {
  if (!sale) return false;
  const credit = Number(sale.creditAmount) || 0;
  if (credit > 0) return true;
  const pending = Number(sale.debtPending) || 0;
  if (pending > 0) return true;
  if (typeof sale.paymentMethod === "string" && sale.paymentMethod.toUpperCase().includes("FIADO")) {
    return true;
  }
  return false;
}
