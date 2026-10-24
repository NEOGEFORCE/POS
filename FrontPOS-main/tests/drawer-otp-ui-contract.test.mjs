// =============================================================================
// tests/drawer-otp-ui-contract.test.mjs
//
// Guardia contractual de la integración UI del flujo "tecla Home → apertura
// manual del cajón" en /sales/new. Son tests ESTÁTICOS (lectura de fuentes):
// no ejercen React en runtime.
//
// Reglas blindadas:
//
//   R1. En /sales/new (`page.tsx`) la tecla `Home`:
//       - Se captura con `e.key === 'Home'`.
//       - Pasa por el helper puro `canCaptureHomeKey` para decidir si se
//         abre el modal (una sola fuente de verdad).
//       - Hace `e.preventDefault()` SIEMPRE que decide abrir el modal.
//       - El modal `HomeDrawerModal` queda registrado en el agregador
//         `isModalOpenRef` para que el motor global no procese teclas
//         mientras está abierto.
//
//   R2. El `HomeDrawerModal`:
//       - Usa componentes de shadcn (`Dialog`, `Input`, `Button`,
//         `Alert`, `Label`). Nunca importa de `@heroui/react`.
//       - En rama admin, el ÚNICO endpoint que invoca es
//         `/cash-drawer/open` con el payload de `buildAdminOpenPayload`
//         (que lleva `override:true` + `source:"home-manual"`).
//       - En rama empleado, los ÚNICOS endpoints son
//         `/cash-drawer/otp/request` y `/cash-drawer/otp/confirm`.
//       - El pulso físico (`kickDrawer`) se dispara SIEMPRE después de
//         la respuesta exitosa del backend — nunca antes. En el fuente
//         eso se verifica localizando `apiFetch(...)` ANTES de
//         `dispatchKickDrawer()` en ambos handlers (admin y confirm).
//       - El código ingresado por el cajero NUNCA se logea con
//         `console.log` ni se incluye en el body de ningún toast.
//       - El código NUNCA se asume presente en el response de
//         `/cash-drawer/otp/request` — el frontend sólo lee
//         `challengeId`, `expiresAt`, `attemptsMax`.
//       - El modal NUNCA llama a `print`, `window.print`,
//         `printThermalTicket`, etc.: la apertura del cajón es un canal
//         totalmente independiente de impresión (igual que el contrato
//         de `drawer-kick-decoupled-contract.test.mjs`).
//       - El pulso usa `window.posBridge.kickDrawer` directamente, no
//         pasa por `hasPosBridgePrint` (ese helper mide impresión, no
//         el pulso lateral).
//
//   R3. El componente NUNCA se exporta sin wrapper dinámico de Next.js:
//       la importación en `page.tsx` debe ser `dynamic(...)` con
//       `ssr:false` para evitar SSR del Dialog (choca con el portal).
//
// Son tests por LECTURA DE FUENTE y no requieren Jest/React-testing-library.
// Si alguien renombra el archivo o cambia la rama, el test falla con un
// mensaje explícito que apunta a la invariante violada.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const salesNewPagePath = join(repoRoot, "src", "app", "(app)", "sales", "new", "page.tsx");
const homeDrawerModalPath = join(
  repoRoot,
  "src",
  "app",
  "(app)",
  "sales",
  "new",
  "components",
  "HomeDrawerModal.tsx",
);
const helperPath = join(repoRoot, "src", "lib", "drawer-otp.mjs");

async function readSrc(path) {
  return readFile(path, "utf8");
}

// ---------------------------------------------------------------------------
// R1 — /sales/new: captura de tecla Home y gates
// ---------------------------------------------------------------------------

test("page: importa `canCaptureHomeKey` del helper puro", async () => {
  const src = await readSrc(salesNewPagePath);
  assert.match(
    src,
    /from\s+['"]@\/lib\/drawer-otp\.mjs['"]/,
    "page.tsx debe importar del helper central.",
  );
  assert.match(src, /canCaptureHomeKey/, "page.tsx debe usar canCaptureHomeKey.");
});

test("page: captura la tecla Home con `e.key === 'Home'` y hace preventDefault", async () => {
  const src = await readSrc(salesNewPagePath);
  // Localizamos la rama Home del handler global de teclado y verificamos
  // sus invariantes: comparación por e.key, preventDefault, uso del
  // helper puro, apertura del modal.
  const idx = src.indexOf("e.key === 'Home'");
  assert.ok(idx > 0, "No se encontró el handler de la tecla Home.");
  const scope = src.slice(idx, idx + 2000);
  assert.match(scope, /canCaptureHomeKey\(\{/,
    "La rama Home debe invocar canCaptureHomeKey con el objeto de flags.");
  assert.match(scope, /e\.preventDefault\(\)/,
    "La rama Home debe llamar e.preventDefault para evitar scroll al top.");
  assert.match(scope, /setIsHomeDrawerModalOpen\(true\)/,
    "La rama Home debe abrir el modal `isHomeDrawerModalOpen`.");
  assert.match(scope, /isHomeRepeat:\s*e\.repeat/,
    "La rama Home debe pasar `e.repeat` como `isHomeRepeat` al helper (anti-autorepeat).");
});

test("page: la rama Home envía todas las guardas al helper puro", async () => {
  const src = await readSrc(salesNewPagePath);
  const idx = src.indexOf("e.key === 'Home'");
  assert.ok(idx > 0);
  const scope = src.slice(idx, idx + 2000);
  // Nota: `isModalOpen,` es shorthand property válido — toleramos ambas formas.
  for (const flag of [
    /isInputFocused:/,
    /\bisModalOpen\b/,
    /hasScannerBuffer:/,
    /\bshowSuccessScreen\b/,
    /isSubmitting:\s*submitting/,
    /isHomeRepeat:\s*e\.repeat/,
  ]) {
    assert.match(scope, flag, `falta flag en la llamada a canCaptureHomeKey: ${flag}`);
  }
});

test("page: `isHomeDrawerModalOpen` queda registrado en `isModalOpenRef`", async () => {
  const src = await readSrc(salesNewPagePath);
  const refIdx = src.indexOf("isModalOpenRef.current");
  assert.ok(refIdx > 0, "No se encontró el ref agregador isModalOpenRef.");
  // El assignment es `isModalOpenRef.current = ... || ... || isHomeDrawerModalOpen;`
  const assignmentWindow = src.slice(refIdx, refIdx + 500);
  assert.match(
    assignmentWindow,
    /isHomeDrawerModalOpen/,
    "`isHomeDrawerModalOpen` debe estar en la OR agregada en `isModalOpenRef.current`.",
  );
  // Y la variable debe estar también en el array de deps del useEffect.
  const effectEnd = src.indexOf("]", refIdx);
  const effectWindow = src.slice(refIdx, effectEnd + 10);
  assert.match(effectWindow, /isHomeDrawerModalOpen/,
    "El array de deps del useEffect de isModalOpenRef debe incluir isHomeDrawerModalOpen.");
});

test("page: Escape cierra el modal `HomeDrawerModal`", async () => {
  const src = await readSrc(salesNewPagePath);
  // Buscamos específicamente el bloque `if (e.key === 'Escape')` del
  // handler global. El file tiene otras menciones de 'Escape' en
  // comparaciones negadas (!== 'Escape'); por eso NO podemos usar la
  // primera ocurrencia a secas.
  const escapeIdx = src.indexOf("e.key === 'Escape'");
  assert.ok(escapeIdx > 0, "No se encontró el handler `if (e.key === 'Escape')`.");
  const scope = src.slice(escapeIdx, escapeIdx + 2000);
  assert.match(
    scope,
    /setIsHomeDrawerModalOpen\(false\)/,
    "Escape debe cerrar explícitamente el modal de apertura manual.",
  );
});

test("page: importa `HomeDrawerModal` via dynamic con ssr:false y lo renderiza", async () => {
  const src = await readSrc(salesNewPagePath);
  assert.match(
    src,
    /const\s+HomeDrawerModal\s*=\s*dynamic\(/,
    "HomeDrawerModal debe cargarse con next/dynamic (Dialog shadcn usa portal — no SSR).",
  );
  assert.match(src, /ssr:\s*false/,
    "El dynamic import debe forzar ssr:false para evitar hydration mismatch.");
  // Debe renderizarse con las props mínimas del contrato.
  assert.match(
    src,
    /<HomeDrawerModal[\s\S]*?isOpen=\{isHomeDrawerModalOpen\}[\s\S]*?onOpenChange=\{setIsHomeDrawerModalOpen\}[\s\S]*?user=\{user\s*\??\?\?\s*null\}/,
    "El modal debe recibir isOpen/onOpenChange/user.",
  );
});

// ---------------------------------------------------------------------------
// R2 — HomeDrawerModal: contrato con el backend y el bridge
// ---------------------------------------------------------------------------

test("modal: usa shadcn (no HeroUI) para Dialog/Input/Button/Alert", async () => {
  const src = await readSrc(homeDrawerModalPath);
  // Imports válidos de shadcn:
  assert.match(src, /from\s+['"]@\/components\/ui\/dialog['"]/);
  assert.match(src, /from\s+['"]@\/components\/ui\/input['"]/);
  assert.match(src, /from\s+['"]@\/components\/ui\/button['"]/);
  assert.match(src, /from\s+['"]@\/components\/ui\/alert['"]/);
  // Prohibido HeroUI en este archivo (el usuario pidió shadcn exclusivo).
  assert.doesNotMatch(
    src,
    /from\s+['"]@heroui\/react['"]/,
    "HomeDrawerModal NO puede importar de @heroui/react.",
  );
});

test("modal: importa helpers puros + auth-helpers + api-error", async () => {
  const src = await readSrc(homeDrawerModalPath);
  assert.match(src, /from\s+['"]@\/lib\/drawer-otp\.mjs['"]/);
  assert.match(src, /from\s+['"]@\/lib\/auth-helpers\.mjs['"]/);
  assert.match(src, /from\s+['"]@\/lib\/api-error['"]/);
});

test("modal: rama admin invoca EXACTAMENTE `/cash-drawer/open` con el payload audit-first", async () => {
  const src = await readSrc(homeDrawerModalPath);
  const idx = src.indexOf("const handleAdminOpen");
  assert.ok(idx > 0, "No se encontró la declaración `const handleAdminOpen`.");
  // Limitamos el alcance al cuerpo del callback — hasta el `}, []);` del
  // useCallback. Si lo extendemos más allá, picamos handlers de la rama
  // empleado y rompemos la verificación "admin NO toca OTP".
  const endMarker = "}, []);";
  const endIdx = src.indexOf(endMarker, idx);
  assert.ok(endIdx > idx, "No se encontró el final del callback de handleAdminOpen.");
  const scope = src.slice(idx, endIdx + endMarker.length);
  assert.match(
    scope,
    /apiFetch<[^>]+>\(\s*["']\/cash-drawer\/open["']/,
    "Admin debe pegarle a /cash-drawer/open con apiFetch tipado.",
  );
  assert.match(
    scope,
    /buildAdminOpenPayload\(/,
    "El body del admin debe construirse con buildAdminOpenPayload (fuente única).",
  );
  // Admin NO debe llamar nunca a los endpoints OTP dentro de SU callback.
  assert.doesNotMatch(
    scope,
    /cash-drawer\/otp\/(request|confirm)/,
    "La rama admin NUNCA debe tocar los endpoints OTP.",
  );
});

test("modal: rama empleado invoca `/cash-drawer/otp/request` y `/cash-drawer/otp/confirm`", async () => {
  const src = await readSrc(homeDrawerModalPath);
  const requestIdx = src.indexOf("const handleRequestOtp");
  const confirmIdx = src.indexOf("const handleConfirmOtp");
  assert.ok(requestIdx > 0, "No se encontró el handler handleRequestOtp.");
  assert.ok(confirmIdx > 0, "No se encontró el handler handleConfirmOtp.");
  // Mismo truco de alcance que handleAdminOpen: hasta el cierre del
  // useCallback para no mezclar handlers.
  const requestEnd = src.indexOf("}, []);", requestIdx);
  const confirmEnd = src.indexOf("}, [otpInput, phase]);", confirmIdx);
  assert.ok(requestEnd > requestIdx, "No se encontró el final del callback handleRequestOtp.");
  assert.ok(confirmEnd > confirmIdx, "No se encontró el final del callback handleConfirmOtp.");
  const requestScope = src.slice(requestIdx, requestEnd + 7);
  const confirmScope = src.slice(confirmIdx, confirmEnd + 24);
  assert.match(
    requestScope,
    /apiFetch<[^>]+>\(\s*["']\/cash-drawer\/otp\/request["']/,
    "Empleado paso 1 debe pegarle a /cash-drawer/otp/request.",
  );
  assert.match(
    confirmScope,
    /apiFetch<[^>]+>\(\s*["']\/cash-drawer\/otp\/confirm["']/,
    "Empleado paso 2 debe pegarle a /cash-drawer/otp/confirm.",
  );
  // Y los payloads deben construirse con los helpers puros.
  assert.match(requestScope, /buildOtpRequestPayload\(/);
  assert.match(confirmScope, /buildOtpConfirmPayload\(/);
});

test("modal: SIEMPRE audita antes de kickear (admin)", async () => {
  const src = await readSrc(homeDrawerModalPath);
  const idx = src.indexOf("handleAdminOpen");
  const scope = src.slice(idx, idx + 2500);
  const auditIdx = scope.indexOf('"/cash-drawer/open"');
  const kickIdx = scope.indexOf("dispatchKickDrawer(");
  assert.ok(auditIdx >= 0, "Falta la auditoría a /cash-drawer/open en handleAdminOpen.");
  assert.ok(kickIdx > auditIdx,
    "El kick físico DEBE ocurrir después de la auditoría en el handler admin.");
});

test("modal: SIEMPRE audita antes de kickear (empleado)", async () => {
  const src = await readSrc(homeDrawerModalPath);
  const idx = src.indexOf("handleConfirmOtp");
  const scope = src.slice(idx, idx + 3000);
  const auditIdx = scope.indexOf('"/cash-drawer/otp/confirm"');
  const kickIdx = scope.indexOf("dispatchKickDrawer(");
  assert.ok(auditIdx >= 0, "Falta la auditoría a /cash-drawer/otp/confirm en handleConfirmOtp.");
  assert.ok(kickIdx > auditIdx,
    "El kick físico DEBE ocurrir después del 200 OK del backend en el flujo empleado.");
});

test("modal: NUNCA imprime (nunca llama a print / printThermalTicket / window.print)", async () => {
  const src = await readSrc(homeDrawerModalPath);
  assert.doesNotMatch(src, /\bprintThermalTicket\s*\(/,
    "El modal no puede imprimir: la apertura manual es un canal independiente de impresión.");
  assert.doesNotMatch(src, /\bwindow\.print\s*\(/);
  // No debe invocar `.print(` sobre el bridge: el pulso usa kickDrawer.
  assert.doesNotMatch(src, /posBridge\.print\s*\(/);
  assert.doesNotMatch(src, /posBridge\?\.print\s*\(/);
});

test("modal: dispara `window.posBridge.kickDrawer` directamente (no vía hasPosBridgePrint)", async () => {
  const src = await readSrc(homeDrawerModalPath);
  assert.match(src, /w\.posBridge\.kickDrawer\(/,
    "El pulso debe invocar directamente window.posBridge.kickDrawer.");
  assert.doesNotMatch(src, /hasPosBridgePrint\s*\(/,
    "No puede usar hasPosBridgePrint: ese helper mide la ruta de IMPRESIÓN.");
});

test("modal: construye el payload de kickDrawer con el helper puro", async () => {
  const src = await readSrc(homeDrawerModalPath);
  assert.match(src, /buildDrawerKickPayload\(/,
    "El payload del bridge debe venir de buildDrawerKickPayload (contrato único).");
});

test("modal: nunca lee el OTP del response de /otp/request", async () => {
  const src = await readSrc(homeDrawerModalPath);
  // El shape OtpRequestResponse debe omitir `otp` explícitamente —
  // defender contra que alguien añada el campo por error.
  const idx = src.indexOf("interface OtpRequestResponse");
  assert.ok(idx > 0, "No se encontró la interfaz OtpRequestResponse.");
  const scope = src.slice(idx, idx + 500);
  assert.doesNotMatch(scope, /\botp\b/i,
    "OtpRequestResponse NO puede declarar un campo `otp`: el backend NUNCA lo devuelve.");
  // Las referencias a `resp.` deben limitarse a challengeId/expiresAt/attemptsMax.
  const respReads = [...src.matchAll(/resp\.(\w+)/g)].map((m) => m[1]);
  const allowed = new Set(["challengeId", "expiresAt", "attemptsMax", "ttlSeconds", "ok", "message"]);
  for (const key of respReads) {
    assert.ok(
      allowed.has(key),
      `El modal lee resp.${key} del /otp/request, que no está permitido por contrato.`,
    );
  }
});

test("modal: nunca logea el OTP tecleado por consola", async () => {
  const src = await readSrc(homeDrawerModalPath);
  // Prohibimos cualquier console.log/warn/info/debug que mencione `otp`.
  const forbidden = [
    /console\.log\([^)]*otp/i,
    /console\.warn\([^)]*otp/i,
    /console\.info\([^)]*otp/i,
    /console\.debug\([^)]*otp/i,
    /console\.error\([^)]*otp/i,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(src, pattern, `El modal NO puede loguear el OTP (patrón: ${pattern}).`);
  }
});

test("modal: el input de OTP tiene inputMode numeric, maxLength 6, aria-label accesible", async () => {
  const src = await readSrc(homeDrawerModalPath);
  // No forzamos un orden en los atributos, pero sí su presencia.
  const idx = src.indexOf('id="home-drawer-otp-input"');
  assert.ok(idx > 0, "El input OTP debe tener id='home-drawer-otp-input' para asociarse al Label.");
  // Alcance del elemento Input:
  const nextClose = src.indexOf("/>", idx);
  const inputScope = src.slice(idx, nextClose + 2);
  assert.match(inputScope, /inputMode="numeric"/);
  assert.match(inputScope, /autoComplete="one-time-code"/);
  assert.match(inputScope, /maxLength=\{DRAWER_OTP_LENGTH\}/);
  assert.match(inputScope, /aria-label=/, "El input debe tener aria-label para lectores de pantalla.");
});

test("modal: hay un Label asociado al input OTP para accesibilidad", async () => {
  const src = await readSrc(homeDrawerModalPath);
  const idx = src.indexOf('htmlFor="home-drawer-otp-input"');
  assert.ok(idx > 0, "Debe existir un <Label htmlFor='home-drawer-otp-input'> para accesibilidad.");
});

test("modal: anti doble-submit — hay un inFlightRef que gate ambos handlers", async () => {
  const src = await readSrc(homeDrawerModalPath);
  assert.match(src, /inFlightRef\s*=\s*React\.useRef/,
    "El modal debe tener un ref inFlightRef para prevenir doble-submit.");
  // handleAdminOpen y handleConfirmOtp deben consultar y actualizar inFlightRef.
  const adminIdx = src.indexOf("handleAdminOpen");
  assert.match(
    src.slice(adminIdx, adminIdx + 1500),
    /if\s*\(\s*inFlightRef\.current\s*\)\s*return;?[\s\S]{0,100}inFlightRef\.current\s*=\s*true/,
    "handleAdminOpen debe cortar temprano cuando inFlightRef está en true y marcarlo true al entrar.",
  );
  const confirmIdx = src.indexOf("handleConfirmOtp");
  assert.match(
    src.slice(confirmIdx, confirmIdx + 2500),
    /if\s*\(\s*inFlightRef\.current\s*\)\s*return;?/,
    "handleConfirmOtp debe cortar temprano cuando inFlightRef está en true.",
  );
});

test("modal: reset total al cerrar (resetAll borra challenge, otp, intentos)", async () => {
  const src = await readSrc(homeDrawerModalPath);
  const resetIdx = src.indexOf("const resetAll");
  assert.ok(resetIdx > 0, "No se encontró el helper resetAll.");
  const scope = src.slice(resetIdx, resetIdx + 500);
  for (const call of [
    /setPhase\(\{\s*kind:\s*["']idle["']/,
    /setOtpInput\(""\)/,
    /setAttemptsLeft\(0\)/,
    /setErrorInfo\(null\)/,
    /setRemainingSec\(0\)/,
    /inFlightRef\.current\s*=\s*false/,
  ]) {
    assert.match(scope, call, `resetAll debe limpiar: ${call}`);
  }
});

test("modal: Dialog honra `onCloseComplete` para devolver foco al escáner", async () => {
  const src = await readSrc(homeDrawerModalPath);
  assert.match(
    src,
    /onCloseComplete\?\.\s*\(\)/,
    "El modal debe invocar `onCloseComplete?.()` al cerrarse para devolver foco al escáner oculto.",
  );
});

// ---------------------------------------------------------------------------
// R3 — Separación admin / empleado: el componente usa `isAdminUser` del helper central
// ---------------------------------------------------------------------------

test("modal: discrimina rol vía `isAdminUser` del helper central (sin hardcode)", async () => {
  const src = await readSrc(homeDrawerModalPath);
  assert.match(src, /isAdminUser\(user\)/,
    "El modal debe usar `isAdminUser(user)` del helper central.");
  // Guard anti-regresión: no debe traer tablas locales de roles.
  assert.doesNotMatch(
    src,
    /\[\s*['"]admin['"]\s*,\s*['"]administrador['"]/,
    "El modal NO puede duplicar la tabla de roles admin.",
  );
});

// ---------------------------------------------------------------------------
// Helper: contrato implícito que NO cambia sin coordinación con el backend
// ---------------------------------------------------------------------------

test("helper: expone constantes alineadas al modelo Go (DRAWER_OTP_LENGTH=6, etc.)", async () => {
  const src = await readSrc(helperPath);
  assert.match(src, /DRAWER_OTP_LENGTH\s*=\s*6\b/);
  assert.match(src, /DRAWER_CHALLENGE_ID_MIN\s*=\s*32\b/);
  assert.match(src, /DRAWER_CHALLENGE_ID_MAX\s*=\s*64\b/);
});

test("helper: el buildAdminOpenPayload tiene literal `source: 'home-manual'` y `override: true`", async () => {
  const src = await readSrc(helperPath);
  assert.match(
    src,
    /source:\s*["']home-manual["']/,
    "La fuente auditable debe ser literal `'home-manual'` para distinguir esta ruta.",
  );
  assert.match(src, /override:\s*true/);
});

test("helper: el buildOtpRequestPayload nunca lleva DNI/ActorId en su firma visible", async () => {
  const src = await readSrc(helperPath);
  const idx = src.indexOf("export function buildOtpRequestPayload");
  assert.ok(idx > 0);
  const scope = src.slice(idx, idx + 500);
  for (const banned of [
    /requestedByDni/,
    /actorDni/,
    /userDni/,
    /dni:/,
  ]) {
    assert.doesNotMatch(scope, banned,
      `buildOtpRequestPayload NO puede referenciar DNI en el body (viola audit model backend).`);
  }
});

test("helper: el buildDrawerKickPayload fija `openDrawerOnSale:false` por diseño", async () => {
  const src = await readSrc(helperPath);
  const idx = src.indexOf("export function buildDrawerKickPayload");
  assert.ok(idx > 0);
  const scope = src.slice(idx, idx + 800);
  assert.match(scope, /openDrawerOnSale:\s*false/,
    "El payload manual NUNCA puede llevar `openDrawerOnSale:true` (eso es ruta post-venta).");
});
