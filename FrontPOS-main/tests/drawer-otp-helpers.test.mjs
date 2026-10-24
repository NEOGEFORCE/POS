// =============================================================================
// tests/drawer-otp-helpers.test.mjs
//
// Pruebas unitarias del módulo puro `src/lib/drawer-otp.mjs`. Son tests
// de biblioteca (sin React, sin DOM): validan formatos, payloads, el
// countdown, las guardas de la tecla Home y el mapeo de errores del
// backend a acciones UX.
//
// Si alguno falla, el modal `HomeDrawerModal` pierde su contrato con el
// backend. Son el único punto donde se garantizan reglas como:
//
//   - El OTP tecleable debe ser ^\d{6}$ y los paste con guiones o espacios
//     se normalizan a 6 dígitos.
//   - El `challengeId` opaco debe tener shape hex ASCII 32..64 — igual que
//     el modelo Go.
//   - El payload del admin SIEMPRE lleva `override:true` y
//     `source:"home-manual"`. No se puede omitir ninguno de los dos.
//   - El payload del empleado NUNCA incluye el DNI en el body: el actor
//     viene del middleware auth del backend.
//   - El payload del `kickDrawer` lleva `openDrawerOnSale:false` (es
//     ruta manual, no post-venta) y `source:'home-manual'` para auditar.
//   - El contador descendente nunca es negativo; cae a 0 cuando el OTP
//     expiró o cuando `expiresAt` es inválido.
//   - Las guardas de la tecla Home rechazan autorepeat del SO, cualquier
//     modal abierto, cualquier input con foco, cualquier buffer de
//     escáner activo, y la pantalla de éxito.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";

import {
  DRAWER_OTP_LENGTH,
  DRAWER_CHALLENGE_ID_MIN,
  DRAWER_CHALLENGE_ID_MAX,
  DRAWER_OTP_ERROR_CODES,
  isValidOtpFormat,
  isValidChallengeId,
  sanitizeOtpInput,
  computeRemainingMs,
  computeRemainingSeconds,
  hasRemainingAttempts,
  canCaptureHomeKey,
  buildAdminOpenPayload,
  buildOtpRequestPayload,
  buildOtpConfirmPayload,
  buildDrawerKickPayload,
  describeOtpError,
} from "../src/lib/drawer-otp.mjs";

// ---------------------------------------------------------------------------
// Constantes del protocolo
// ---------------------------------------------------------------------------

test("constantes: coinciden con el modelo Go", () => {
  assert.strictEqual(DRAWER_OTP_LENGTH, 6);
  assert.strictEqual(DRAWER_CHALLENGE_ID_MIN, 32);
  assert.strictEqual(DRAWER_CHALLENGE_ID_MAX, 64);
});

test("DRAWER_OTP_ERROR_CODES: los 11 códigos estables están presentes", () => {
  const expected = [
    "DRAWER_OTP_NOT_FOUND",
    "DRAWER_OTP_WRONG_ACTOR",
    "DRAWER_OTP_EXPIRED",
    "DRAWER_OTP_ATTEMPTS_EXHAUSTED",
    "DRAWER_OTP_INVALID",
    "DRAWER_OTP_ALREADY_USED",
    "DRAWER_OTP_CANCELLED",
    "DRAWER_OTP_TELEGRAM_UNAVAILABLE",
    "DRAWER_OTP_COOLDOWN",
    "DRAWER_OTP_REQUEST_FAILED",
    "DRAWER_OTP_FORMAT_INVALID",
  ];
  for (const value of Object.values(DRAWER_OTP_ERROR_CODES)) {
    assert.ok(expected.includes(value), `código estable desconocido: ${value}`);
  }
  assert.strictEqual(Object.values(DRAWER_OTP_ERROR_CODES).length, expected.length);
});

// ---------------------------------------------------------------------------
// Formato del OTP
// ---------------------------------------------------------------------------

test("isValidOtpFormat: acepta exactamente 6 dígitos ASCII", () => {
  assert.strictEqual(isValidOtpFormat("123456"), true);
  assert.strictEqual(isValidOtpFormat("000000"), true);
  assert.strictEqual(isValidOtpFormat("999999"), true);
});

test("isValidOtpFormat: rechaza shapes malformados", () => {
  const bad = [
    "",
    "12345",      // corto
    "1234567",    // largo
    "12345a",     // alfa
    "12345 ",     // espacio
    " 123456",    // espacio inicial
    "123-45",     // separador
    "12.345",     // decimal
    "①②③④⑤⑥",   // unicode dígitos
  ];
  for (const value of bad) {
    assert.strictEqual(isValidOtpFormat(value), false, `rechazar: ${JSON.stringify(value)}`);
  }
});

test("isValidOtpFormat: null/undefined/no-string nunca lanzan", () => {
  for (const v of [null, undefined, 123456, {}, [], true]) {
    assert.strictEqual(isValidOtpFormat(v), false);
  }
});

test("sanitizeOtpInput: deja sólo dígitos y recorta a 6", () => {
  assert.strictEqual(sanitizeOtpInput("12 34-56"), "123456");
  assert.strictEqual(sanitizeOtpInput("abc123456xyz"), "123456");
  assert.strictEqual(sanitizeOtpInput("1234567"), "123456"); // recorta
  assert.strictEqual(sanitizeOtpInput("1-2-3-4-5-6-7"), "123456");
  assert.strictEqual(sanitizeOtpInput(""), "");
  assert.strictEqual(sanitizeOtpInput(null), "");
  assert.strictEqual(sanitizeOtpInput(undefined), "");
  assert.strictEqual(sanitizeOtpInput(123456), "123456"); // string implícita
});

// ---------------------------------------------------------------------------
// challengeId
// ---------------------------------------------------------------------------

test("isValidChallengeId: acepta hex ASCII entre 32 y 64 chars", () => {
  const h32 = "0".repeat(32);
  const h64 = "f".repeat(64);
  const mixed = "0123456789abcdefABCDEF0123456789abcdef";
  assert.strictEqual(isValidChallengeId(h32), true);
  assert.strictEqual(isValidChallengeId(h64), true);
  assert.strictEqual(isValidChallengeId(mixed), true);
});

test("isValidChallengeId: rechaza bytes no-hex o longitudes extremas", () => {
  assert.strictEqual(isValidChallengeId("0".repeat(31)), false, "31 chars es muy corto");
  assert.strictEqual(isValidChallengeId("0".repeat(65)), false, "65 chars es muy largo");
  assert.strictEqual(isValidChallengeId("g".repeat(32)), false, "g no es hex");
  assert.strictEqual(isValidChallengeId("0 ".repeat(16).trim()), false, "espacios");
  assert.strictEqual(isValidChallengeId(""), false);
  assert.strictEqual(isValidChallengeId(null), false);
  assert.strictEqual(isValidChallengeId(123), false);
});

// ---------------------------------------------------------------------------
// Countdown
// ---------------------------------------------------------------------------

test("computeRemainingMs: devuelve ms positivos cuando `expiresAt` está en el futuro", () => {
  const now = 1_700_000_000_000;
  const expiresAt = now + 60_000;
  assert.strictEqual(computeRemainingMs(expiresAt, now), 60_000);
  assert.strictEqual(computeRemainingMs(new Date(expiresAt), now), 60_000);
  assert.strictEqual(computeRemainingMs(new Date(expiresAt).toISOString(), now), 60_000);
});

test("computeRemainingMs: 0 cuando ya expiró o cuando input inválido", () => {
  const now = 1_700_000_000_000;
  assert.strictEqual(computeRemainingMs(now - 1, now), 0);
  assert.strictEqual(computeRemainingMs(now, now), 0, "igual = ya expiró");
  assert.strictEqual(computeRemainingMs("invalid-date", now), 0);
  assert.strictEqual(computeRemainingMs(null, now), 0);
  assert.strictEqual(computeRemainingMs(undefined, now), 0);
  assert.strictEqual(computeRemainingMs({}, now), 0);
});

test("computeRemainingSeconds: aplica Math.floor y nunca es negativo", () => {
  const now = 1_700_000_000_000;
  assert.strictEqual(computeRemainingSeconds(now + 1_500, now), 1);
  assert.strictEqual(computeRemainingSeconds(now + 999, now), 0);
  assert.strictEqual(computeRemainingSeconds(now - 10_000, now), 0);
  assert.strictEqual(computeRemainingSeconds(now + 90_000, now), 90);
});

// ---------------------------------------------------------------------------
// Intentos
// ---------------------------------------------------------------------------

test("hasRemainingAttempts: estricto `used < max`", () => {
  assert.strictEqual(hasRemainingAttempts(0, 3), true);
  assert.strictEqual(hasRemainingAttempts(2, 3), true);
  assert.strictEqual(hasRemainingAttempts(3, 3), false);
  assert.strictEqual(hasRemainingAttempts(5, 3), false);
  assert.strictEqual(hasRemainingAttempts(0, 0), false, "max=0 nunca hay intentos");
  assert.strictEqual(hasRemainingAttempts("abc", 3), false);
  assert.strictEqual(hasRemainingAttempts(null, 3), false);
});

// ---------------------------------------------------------------------------
// Guardas de la tecla Home
// ---------------------------------------------------------------------------

test("canCaptureHomeKey: libre pasa", () => {
  assert.strictEqual(
    canCaptureHomeKey({
      isInputFocused: false,
      isModalOpen: false,
      hasScannerBuffer: false,
      showSuccessScreen: false,
      isSubmitting: false,
      isHomeRepeat: false,
    }),
    true,
  );
});

test("canCaptureHomeKey: cualquier guard veto en true cae a false", () => {
  const base = {
    isInputFocused: false,
    isModalOpen: false,
    hasScannerBuffer: false,
    showSuccessScreen: false,
    isSubmitting: false,
    isHomeRepeat: false,
  };
  for (const key of [
    "isInputFocused",
    "isModalOpen",
    "hasScannerBuffer",
    "showSuccessScreen",
    "isSubmitting",
    "isHomeRepeat",
  ]) {
    assert.strictEqual(
      canCaptureHomeKey({ ...base, [key]: true }),
      false,
      `${key} true debe bloquear la tecla Home`,
    );
  }
});

test("canCaptureHomeKey: input inválido retorna false sin lanzar", () => {
  assert.strictEqual(canCaptureHomeKey(null), false);
  assert.strictEqual(canCaptureHomeKey(undefined), false);
  assert.strictEqual(canCaptureHomeKey("foo"), false);
  assert.strictEqual(canCaptureHomeKey(42), false);
});

// ---------------------------------------------------------------------------
// Payloads: admin
// ---------------------------------------------------------------------------

test("buildAdminOpenPayload: SIEMPRE lleva override:true + source:'home-manual'", () => {
  const payload = buildAdminOpenPayload();
  assert.strictEqual(payload.override, true);
  assert.strictEqual(payload.source, "home-manual");
  assert.strictEqual(typeof payload.note, "string");
  assert.ok(payload.note.length > 0, "default note no debe ser vacío");
});

test("buildAdminOpenPayload: respeta nota del cajero y la recorta a 240 chars", () => {
  const payload = buildAdminOpenPayload({ note: " custom reason  " });
  assert.strictEqual(payload.note, "custom reason");
  const huge = "a".repeat(500);
  const payload2 = buildAdminOpenPayload({ note: huge });
  assert.strictEqual(payload2.note.length, 240);
});

test("buildAdminOpenPayload: nunca lleva saleId/returnId (apertura manual, no asociada)", () => {
  const payload = buildAdminOpenPayload({ note: "foo" });
  assert.strictEqual("saleId" in payload, false);
  assert.strictEqual("returnId" in payload, false);
});

// ---------------------------------------------------------------------------
// Payloads: OTP request/confirm
// ---------------------------------------------------------------------------

test("buildOtpRequestPayload: NO lleva requestedByDni ni ningún identificador del actor", () => {
  const payload = buildOtpRequestPayload({ note: "test" });
  // Shape mínimo con sólo `note`. Si alguien añade un campo nuevo, el test
  // debe actualizarse explícitamente — no se puede permitir que el
  // frontend empiece a enviar el DNI "por conveniencia".
  const keys = Object.keys(payload).sort();
  assert.deepStrictEqual(keys, ["note"]);
  assert.strictEqual("requestedByDni" in payload, false);
  assert.strictEqual("dni" in payload, false);
  assert.strictEqual("userDni" in payload, false);
});

test("buildOtpRequestPayload: default sin opciones", () => {
  assert.deepStrictEqual(buildOtpRequestPayload(), { note: "" });
  assert.deepStrictEqual(buildOtpRequestPayload({}), { note: "" });
});

test("buildOtpConfirmPayload: shape {challengeId, otp, note} y recorta espacios", () => {
  const payload = buildOtpConfirmPayload({
    challengeId: "0".repeat(64),
    otp: "123456",
    note: " manual home ",
  });
  assert.strictEqual(payload.challengeId.length, 64);
  assert.strictEqual(payload.otp, "123456");
  assert.strictEqual(payload.note, "manual home");
});

test("buildOtpConfirmPayload: rechaza OTP malformado antes de tocar la red", () => {
  assert.throws(
    () =>
      buildOtpConfirmPayload({
        challengeId: "0".repeat(64),
        otp: "12345",
        note: "",
      }),
    /otp/,
  );
  assert.throws(
    () =>
      buildOtpConfirmPayload({
        challengeId: "0".repeat(64),
        otp: "abcdef",
        note: "",
      }),
    /otp/,
  );
});

test("buildOtpConfirmPayload: rechaza challengeId malformado", () => {
  assert.throws(
    () =>
      buildOtpConfirmPayload({
        challengeId: "short",
        otp: "123456",
        note: "",
      }),
    /challengeId/,
  );
});

test("buildOtpConfirmPayload: input requerido", () => {
  assert.throws(() => buildOtpConfirmPayload(), /input/);
  assert.throws(() => buildOtpConfirmPayload(null), /input/);
});

// ---------------------------------------------------------------------------
// Payload del bridge: kickDrawer
// ---------------------------------------------------------------------------

test("buildDrawerKickPayload: `openDrawerOnSale:false` y `source:'home-manual'`", () => {
  const payload = buildDrawerKickPayload({
    command: "\x1Bp\x00\x19\xFA",
    event: "MANUAL",
    connection: { host: "127.0.0.1" },
    drawer: { enabled: true },
  });
  // El flag post-venta debe estar en false — es apertura manual.
  assert.strictEqual(payload.openDrawerOnSale, false);
  // La fuente auditable es `home-manual` para distinguirla de la ruta
  // post-venta (`universal-payment-modal`).
  assert.strictEqual(payload.source, "home-manual");
  // Y el command/connection/drawer no se re-interpretan: pasan opacos.
  assert.strictEqual(payload.command, "\x1Bp\x00\x19\xFA");
  assert.strictEqual(payload.event, "MANUAL");
  assert.deepStrictEqual(payload.connection, { host: "127.0.0.1" });
  assert.deepStrictEqual(payload.drawer, { enabled: true });
});

test("buildDrawerKickPayload: defaults seguros cuando falta cfg", () => {
  const payload = buildDrawerKickPayload({});
  assert.strictEqual(payload.command, "");
  assert.strictEqual(payload.event, "MANUAL");
  assert.strictEqual(payload.connection, null);
  assert.strictEqual(payload.drawer, null);
  assert.strictEqual(payload.source, "home-manual");
  assert.strictEqual(payload.openDrawerOnSale, false);
});

// ---------------------------------------------------------------------------
// describeOtpError: mapeo código → acción UX
// ---------------------------------------------------------------------------

test("describeOtpError: INVALID → retry (hay intentos)", () => {
  const d = describeOtpError({ code: "DRAWER_OTP_INVALID", status: 422 });
  assert.strictEqual(d.action, "retry");
  assert.match(d.message, /otp/i);
});

test("describeOtpError: EXPIRED/EXHAUSTED → new-otp", () => {
  for (const code of [
    "DRAWER_OTP_EXPIRED",
    "DRAWER_OTP_ATTEMPTS_EXHAUSTED",
    "DRAWER_OTP_ALREADY_USED",
    "DRAWER_OTP_CANCELLED",
    "DRAWER_OTP_NOT_FOUND",
  ]) {
    const d = describeOtpError({ code, status: 410 });
    assert.strictEqual(d.action, "new-otp", `${code} debe sugerir new-otp`);
  }
});

test("describeOtpError: WRONG_ACTOR / 401 → close", () => {
  assert.strictEqual(
    describeOtpError({ code: "DRAWER_OTP_WRONG_ACTOR", status: 403 }).action,
    "close",
  );
  assert.strictEqual(describeOtpError({ status: 401 }).action, "close");
});

test("describeOtpError: TELEGRAM_UNAVAILABLE / 503 → ask-admin", () => {
  assert.strictEqual(
    describeOtpError({ code: "DRAWER_OTP_TELEGRAM_UNAVAILABLE", status: 503 }).action,
    "ask-admin",
  );
  assert.strictEqual(describeOtpError({ status: 503 }).action, "ask-admin");
});

test("describeOtpError: FORMAT_INVALID / REQUEST_FAILED / otros → retry", () => {
  assert.strictEqual(
    describeOtpError({ code: "DRAWER_OTP_FORMAT_INVALID", status: 400 }).action,
    "retry",
  );
  assert.strictEqual(
    describeOtpError({ code: "DRAWER_OTP_REQUEST_FAILED", status: 500 }).action,
    "retry",
  );
  assert.strictEqual(
    describeOtpError({ code: null, status: 500 }).action,
    "retry",
  );
});

test("describeOtpError: payloads vacíos no lanzan y vuelven con 'retry'", () => {
  const d = describeOtpError({});
  assert.strictEqual(d.action, "retry");
  assert.strictEqual(typeof d.message, "string");
  assert.ok(d.message.length > 0);
});

test("describeOtpError: respeta mensaje del servidor como fallback", () => {
  const d = describeOtpError({ code: null, status: 400, message: "foo bar" });
  assert.match(d.message, /foo/);
});



test("describeOtpError: COOLDOWN → retry con mensaje del servidor", () => {
  const described = describeOtpError({
    code: DRAWER_OTP_ERROR_CODES.COOLDOWN,
    status: 429,
    message: "Debes esperar antes de solicitar otro OTP.",
  });
  assert.strictEqual(described.action, "retry");
  assert.strictEqual(described.code, "DRAWER_OTP_COOLDOWN");
  assert.match(described.message, /esperar/i);
});
