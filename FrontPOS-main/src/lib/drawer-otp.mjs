// src/lib/drawer-otp.mjs
//
// Helpers puros del flujo de "apertura manual del cajón con tecla Home" en
// /sales/new. Vive aquí como `.mjs` sin dependencias para poder:
//
//   - Probarlo bajo `node --test` sin bundler (sólo helpers, nada de React).
//   - Importarlo desde el componente `use client` (`HomeDrawerModal.tsx`)
//     sin arrastrar runtime innecesario.
//
// Reglas que este módulo centraliza (fuente única de verdad para la UI):
//
//   1. Formatos: el OTP tecleado debe ser `^\d{6}$` y el `challengeId`
//      opaco emitido por el servidor debe ser hex ASCII 32..64. Replica
//      exactamente los validadores del modelo Go (ver
//      `cash_drawer_otp_challenge.go`).
//
//   2. Códigos de error estables del backend: cada código mapea a una
//      acción concreta en el modal (reintento, pedir uno nuevo, cerrar).
//      Si alguien renombra uno, el modal pierde su rama de recuperación.
//
//   3. Payloads:
//      - Admin → `/cash-drawer/open`: `{override:true, source:'home-manual', note}`
//        (exigido por la especificación operativa).
//      - Empleado → `/cash-drawer/otp/request`: `{note}` (actor viene de
//        la sesión; el DNI NUNCA viaja en el body).
//      - Empleado → `/cash-drawer/otp/confirm`: `{challengeId, otp, note}`.
//
//   4. Payload para `window.posBridge.kickDrawer`: coincide con el que
//      usa `UniversalPaymentModal.dispatchDrawerKickOnSale` (comando
//      ESC/POS literal, evento, connection, drawer); añade un hint
//      `source:'home-manual'` para que el bridge pueda auditar.
//
//   5. Countdown: `computeRemainingSeconds(expiresAt, now)` devuelve
//      `floor((expiresAt - now)/1000)` con piso en 0. Lo usa el ticker
//      del modal (sin dependencias, 1 Hz).
//
//   6. Guardias de la tecla Home: `canCaptureHomeKey(flags)` encapsula
//      todas las condiciones (sin modal abierto, sin input activo, sin
//      buffer de escáner, sin pantalla de éxito). El objetivo es que la
//      lógica sea testeable sin montar React.
//
// Importante: este archivo NO lee ni muta `localStorage`, NO hace fetch,
// NO toca el DOM. Son funciones puras.

/** Longitud exacta del OTP tecleable. Replica `CashDrawerOTPLength` en Go. */
export const DRAWER_OTP_LENGTH = 6;

/** Longitud mínima del `challengeId` hex opaco emitido por el backend. */
export const DRAWER_CHALLENGE_ID_MIN = 32;

/** Longitud máxima del `challengeId` hex opaco emitido por el backend. */
export const DRAWER_CHALLENGE_ID_MAX = 64;

/**
 * Códigos de error estables que el backend devuelve en el body
 * (`code`) de las respuestas 4xx/5xx del flujo OTP. Replica tal cual la
 * tabla en `cash_drawer_otp_challenge.go`.
 */
export const DRAWER_OTP_ERROR_CODES = Object.freeze({
  NOT_FOUND: "DRAWER_OTP_NOT_FOUND",
  WRONG_ACTOR: "DRAWER_OTP_WRONG_ACTOR",
  EXPIRED: "DRAWER_OTP_EXPIRED",
  ATTEMPTS_EXHAUSTED: "DRAWER_OTP_ATTEMPTS_EXHAUSTED",
  INVALID: "DRAWER_OTP_INVALID",
  ALREADY_USED: "DRAWER_OTP_ALREADY_USED",
  CANCELLED: "DRAWER_OTP_CANCELLED",
  TELEGRAM_UNAVAILABLE: "DRAWER_OTP_TELEGRAM_UNAVAILABLE",
  COOLDOWN: "DRAWER_OTP_COOLDOWN",
  REQUEST_FAILED: "DRAWER_OTP_REQUEST_FAILED",
  FORMAT_INVALID: "DRAWER_OTP_FORMAT_INVALID",
});

/** Regex del OTP tecleado (6 dígitos exactos, ASCII). */
const OTP_SHAPE = /^\d{6}$/;

/** Regex del challenge_id opaco (hex ASCII 32..64, cualquier casing). */
const CHALLENGE_ID_SHAPE = /^[0-9a-fA-F]{32,64}$/;

/**
 * Verifica el shape del OTP tecleado. No valida corrección; sólo que el
 * usuario escribió 6 dígitos. Si el valor es `null`/`undefined`/no-string,
 * devuelve `false` sin lanzar.
 * @param {unknown} otp
 * @returns {boolean}
 */
export function isValidOtpFormat(otp) {
  if (typeof otp !== "string") return false;
  return OTP_SHAPE.test(otp);
}

/**
 * Verifica el shape del `challengeId` opaco. Lo usa el modal como última
 * defensa antes de enviar un confirm — si el servidor nos dio basura (que
 * nunca debería), fallamos localmente con un error claro.
 * @param {unknown} challengeId
 * @returns {boolean}
 */
export function isValidChallengeId(challengeId) {
  if (typeof challengeId !== "string") return false;
  return CHALLENGE_ID_SHAPE.test(challengeId);
}

/**
 * Elimina de un buffer tecleado todo lo que no sea dígito ASCII y lo
 * recorta a `DRAWER_OTP_LENGTH`. Pensado para `onChange` del input de
 * 6 dígitos: pegar "123-456" queda "123456"; teclas con shift o
 * acentos quedan descartadas.
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeOtpInput(raw) {
  if (raw === null || raw === undefined) return "";
  const text = String(raw);
  const digits = text.replace(/\D+/g, "");
  return digits.slice(0, DRAWER_OTP_LENGTH);
}

/**
 * Convierte un `expiresAt` (string ISO 8601 que entrega el backend, o un
 * número epoch-ms, o un Date) en milisegundos restantes respecto a `now`.
 * Devuelve `0` cuando el valor es inválido o ya pasó; nunca negativos.
 * @param {string | number | Date | null | undefined} expiresAt
 * @param {number} [now] — timestamp en ms; default `Date.now()`.
 * @returns {number}
 */
export function computeRemainingMs(expiresAt, now) {
  const current = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  let target;
  if (expiresAt === null || expiresAt === undefined) return 0;
  if (expiresAt instanceof Date) {
    target = expiresAt.getTime();
  } else if (typeof expiresAt === "number") {
    target = expiresAt;
  } else if (typeof expiresAt === "string") {
    const parsed = Date.parse(expiresAt);
    if (!Number.isFinite(parsed)) return 0;
    target = parsed;
  } else {
    return 0;
  }
  if (!Number.isFinite(target)) return 0;
  const diff = target - current;
  return diff > 0 ? diff : 0;
}

/**
 * Versión en segundos (piso) de `computeRemainingMs`. Útil para
 * renderizar el contador descendente del modal con precisión 1 Hz.
 * @param {string | number | Date | null | undefined} expiresAt
 * @param {number} [now]
 * @returns {number}
 */
export function computeRemainingSeconds(expiresAt, now) {
  return Math.floor(computeRemainingMs(expiresAt, now) / 1000);
}

/**
 * Devuelve `true` si todavía quedan intentos disponibles. `max=0` o
 * valores inválidos se tratan como "sin intentos" (false conservador).
 * `null`/`undefined`/strings no-numéricos devuelven `false` sin lanzar.
 * @param {unknown} used
 * @param {unknown} max
 * @returns {boolean}
 */
export function hasRemainingAttempts(used, max) {
  // Rechazamos explícitamente null/undefined antes de pasarlos por Number()
  // porque `Number(null) === 0`, lo cual aceptaría `(null, 3)` como "0 intentos
  // usados" cuando el contrato dice "entrada inválida ⇒ no hay intentos".
  if (used === null || used === undefined) return false;
  if (max === null || max === undefined) return false;
  if (typeof used === "boolean" || typeof max === "boolean") return false;
  const u = typeof used === "number" ? used : Number(used);
  const m = typeof max === "number" ? max : Number(max);
  if (!Number.isFinite(u) || !Number.isFinite(m)) return false;
  if (m <= 0) return false;
  return u < m;
}

/**
 * Guardias de la tecla Home. El motor de /sales/new sólo captura `Home`
 * cuando TODAS las condiciones del contrato están limpias: ningún
 * input/textarea con foco, ninguna modal abierta, ningún buffer de
 * escáner activo, ninguna pantalla de éxito visible. La función es pura
 * y aislada para poder testearla sin montar React.
 *
 * @param {{
 *   isInputFocused?: boolean,
 *   isModalOpen?: boolean,
 *   hasScannerBuffer?: boolean,
 *   showSuccessScreen?: boolean,
 *   isSubmitting?: boolean,
 *   isHomeRepeat?: boolean,
 * }} flags
 * @returns {boolean}
 */
export function canCaptureHomeKey(flags) {
  if (!flags || typeof flags !== "object") return false;
  if (flags.isInputFocused) return false;
  if (flags.isModalOpen) return false;
  if (flags.hasScannerBuffer) return false;
  if (flags.showSuccessScreen) return false;
  if (flags.isSubmitting) return false;
  if (flags.isHomeRepeat) return false;
  return true;
}

/**
 * Payload del admin para `/cash-drawer/open`. El contrato exige
 * `override:true` y `source:'home-manual'` para distinguir esta ruta de la
 * autoapertura post-venta (que usa `source:'universal-payment-modal'`).
 *
 * Nunca mandamos saleId/returnId: la apertura es manual, no asociada a
 * ninguna venta. El backend lo acepta porque el actor es admin.
 *
 * @param {{ note?: string | null }} [options]
 * @returns {{ override: true, source: "home-manual", note: string }}
 */
export function buildAdminOpenPayload(options) {
  const note = options && typeof options.note === "string"
    ? options.note.trim().slice(0, 240)
    : "";
  return {
    override: true,
    source: "home-manual",
    note: note || "Apertura manual desde tecla Home",
  };
}

/**
 * Payload para `/cash-drawer/otp/request` del empleado. El actor NO
 * viaja en el body: el backend lo toma del middleware (`userDni` en el
 * context). Sólo propagamos la nota opcional para que quede en el
 * registro cuando el challenge se consuma.
 *
 * @param {{ note?: string | null }} [options]
 * @returns {{ note: string }}
 */
export function buildOtpRequestPayload(options) {
  const note = options && typeof options.note === "string"
    ? options.note.trim().slice(0, 240)
    : "";
  return { note };
}

/**
 * Payload para `/cash-drawer/otp/confirm` del empleado. El OTP debe
 * pasar `isValidOtpFormat` ANTES de llegar aquí: si no, lanzamos un
 * error estándar para que el modal muestre el aviso sin tocar la red.
 *
 * @param {{ challengeId: string, otp: string, note?: string | null }} input
 * @returns {{ challengeId: string, otp: string, note: string }}
 */
export function buildOtpConfirmPayload(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("buildOtpConfirmPayload: input requerido");
  }
  const challengeId = typeof input.challengeId === "string" ? input.challengeId.trim() : "";
  const otp = typeof input.otp === "string" ? input.otp.trim() : "";
  if (!isValidChallengeId(challengeId)) {
    throw new Error("challengeId inválido");
  }
  if (!isValidOtpFormat(otp)) {
    throw new Error("otp inválido");
  }
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 240) : "";
  return { challengeId, otp, note };
}

/**
 * Payload del pulso físico que viaja al bridge local. El bridge decide
 * si realmente envía el comando ESC/POS/TSPL según el protocolo que
 * negocie con la impresora. El pulso es INDEPENDIENTE de la impresión
 * del recibo — el bridge NO puede exigir que el canal de impresión esté
 * conectado para abrir el cajón.
 *
 * @param {{
 *   command?: string | null,
 *   event?: string | null,
 *   connection?: unknown,
 *   drawer?: unknown,
 * }} cfg
 * @returns {{
 *   command: string,
 *   event: string,
 *   connection: unknown,
 *   drawer: unknown,
 *   source: "home-manual",
 *   openDrawerOnSale: false,
 * }}
 */
export function buildDrawerKickPayload(cfg) {
  const command = cfg && typeof cfg.command === "string" ? cfg.command : "";
  const event = cfg && typeof cfg.event === "string" ? cfg.event : "MANUAL";
  const connection = cfg && cfg.connection !== undefined ? cfg.connection : null;
  const drawer = cfg && cfg.drawer !== undefined ? cfg.drawer : null;
  return {
    command,
    event,
    connection,
    drawer,
    source: "home-manual",
    openDrawerOnSale: false,
  };
}

/**
 * Traduce un `code` del backend (ver `DRAWER_OTP_ERROR_CODES`) + el
 * status HTTP a un mensaje para el usuario y una recomendación de UX:
 *
 *   - action: "retry"      → el usuario puede volver a intentar el OTP.
 *   - action: "new-otp"    → debe pedir un OTP nuevo (ya no hay vuelta).
 *   - action: "close"      → el modal debe cerrarse (sesión caída, etc).
 *   - action: "ask-admin"  → sugerir al cajero pedir al admin que abra.
 *
 * Si no reconocemos el código, caemos a un mensaje genérico y acción
 * "retry" para no bloquear al cajero cuando el backend añade códigos
 * nuevos sin anunciar.
 *
 * @param {{ code?: unknown, status?: unknown, message?: unknown }} payload
 * @returns {{ action: "retry" | "new-otp" | "close" | "ask-admin", message: string, code: string | null }}
 */
export function describeOtpError(payload) {
  const code = payload && typeof payload.code === "string" ? payload.code : null;
  const status = payload && typeof payload.status === "number" ? payload.status : 0;
  const serverMessage = payload && typeof payload.message === "string"
    ? payload.message.trim()
    : "";
  switch (code) {
    case DRAWER_OTP_ERROR_CODES.FORMAT_INVALID:
      return {
        action: "retry",
        message: "El OTP debe tener 6 dígitos.",
        code,
      };
    case DRAWER_OTP_ERROR_CODES.INVALID:
      return {
        action: "retry",
        message: "OTP incorrecto. Intente de nuevo.",
        code,
      };
    case DRAWER_OTP_ERROR_CODES.EXPIRED:
      return {
        action: "new-otp",
        message: "El OTP venció. Solicite uno nuevo.",
        code,
      };
    case DRAWER_OTP_ERROR_CODES.ATTEMPTS_EXHAUSTED:
      return {
        action: "new-otp",
        message: "Agotó los intentos. Solicite un OTP nuevo.",
        code,
      };
    case DRAWER_OTP_ERROR_CODES.ALREADY_USED:
    case DRAWER_OTP_ERROR_CODES.CANCELLED:
      return {
        action: "new-otp",
        message: "El código ya no es válido. Solicite uno nuevo.",
        code,
      };
    case DRAWER_OTP_ERROR_CODES.NOT_FOUND:
      return {
        action: "new-otp",
        message: "El código ya no existe. Solicite uno nuevo.",
        code,
      };
    case DRAWER_OTP_ERROR_CODES.WRONG_ACTOR:
      return {
        action: "close",
        message: "La sesión no coincide con el usuario que solicitó el OTP.",
        code,
      };
    case DRAWER_OTP_ERROR_CODES.TELEGRAM_UNAVAILABLE:
      return {
        action: "ask-admin",
        message: "Telegram no está disponible. Pida apertura directa al administrador.",
        code,
      };
    case DRAWER_OTP_ERROR_CODES.COOLDOWN:
      return {
        action: "retry",
        message: serverMessage || "Espere unos segundos antes de solicitar otro OTP.",
        code,
      };
    case DRAWER_OTP_ERROR_CODES.REQUEST_FAILED:
      return {
        action: "retry",
        message: "No se pudo procesar la solicitud. Intente de nuevo.",
        code,
      };
    default:
      break;
  }
  // Sin código estable: usamos el status HTTP para ser conservadores.
  if (status === 401) {
    return { action: "close", message: "Sesión expirada. Vuelva a iniciar sesión.", code };
  }
  if (status === 503) {
    return {
      action: "ask-admin",
      message: "Servicio no disponible. Pida apertura directa al administrador.",
      code,
    };
  }
  if (status >= 500) {
    return { action: "retry", message: "Error del servidor. Intente de nuevo.", code };
  }
  return {
    action: "retry",
    message: serverMessage || "No se pudo validar el OTP.",
    code,
  };
}
