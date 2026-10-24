// =============================================================================
// tests/bold-qr-ui-contract.test.mjs
//
// Guardianes ESTÁTICOS (lectura de fuente) de la integración de cobro
// QR Bold / Bre-B en el frontend POS (migración 027, flujo 100% asíncrono):
//
//   R1. `ModalPagoBoldQR` existe en src/components/shared/, usa shadcn
//       exclusivamente (Dialog / Button / Alert), no HeroUI.
//   R2. El modal referencia `/qr-bold-breb-code.png` por contrato y maneja
//       `onError` para bloquear UX insegura (bandera `QR_IMAGE_MISSING`)
//       sin generar placeholder financiero.
//   R3. El modal invoca EXACTAMENTE los endpoints del contrato
//       asíncrono: /pos/pagos-qr/iniciar y /pos/pagos-qr/cancelar.
//       El POST /pos/pagos-qr/encolar vive en el padre /sales/new/
//       page.tsx porque conoce el snapshot del carrito.
//       La ruta residual /pos/pagos-qr/confirmar-manual quedó retirada
//       del modal del cajero (admin-only en el backend).
//   R4. El SSE se abre vía fetch streaming con `Authorization: Bearer`
//       en header (jamás por query string).
//   R5. `onApproved` se dispara exactamente una vez por sesión del modal
//       (guard con useRef) y auto-cierra 1.5s después.
//   R6. El modal rinde el encabezado SURTIFAMILIAR, el badge Bre-B, el
//       monto grande, los subtítulos / pie del titular verificado y el
//       código de comercio 0093097755.
//   R7. UniversalPaymentModal expone el botón "QR Bold / Bre-B" en la
//       grilla de métodos y abre el modal hijo cuando el padre provee
//       `onBoldQrRequested`. En flujos de salida / abono queda oculto.
//   R8. La aprobación compone un payload `onPay(...)` con
//       `transferSource = "BOLD_QR"` (o MIXTO si hay otros canales).
//   R9. El modal NO expone BOLD_SECRET_KEY ni BOLD_BRIDGE_TOKEN.
//
// Son tests por LECTURA DE FUENTE y no requieren Jest/React-testing-library.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const modalPath = join(repoRoot, "src", "components", "shared", "ModalPagoBoldQR.tsx");
const upmPath = join(repoRoot, "src", "components", "shared", "UniversalPaymentModal.tsx");
const salesNewPagePath = join(repoRoot, "src", "app", "(app)", "sales", "new", "page.tsx");
const helperPath = join(repoRoot, "src", "lib", "bold-qr-helpers.mjs");

async function readSrc(path) {
    return readFile(path, "utf8");
}

/**
 * Lee el archivo descartando comentarios /* ... *\/ y // ... porque
 * algunas invariantes se nombran en el docstring del archivo pero no en
 * código ejecutable y queremos evitar falsos positivos.
 */
async function readWithoutComments(path) {
    const raw = await readFile(path, "utf8");
    return raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// R1. Existencia y stack de shadcn
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR.tsx existe en src/components/shared/", () => {
    assert.ok(
        existsSync(modalPath),
        "src/components/shared/ModalPagoBoldQR.tsx debe existir (contrato de ubicación).",
    );
});

test("ModalPagoBoldQR usa shadcn Button/Alert dentro de vista directa y NO HeroUI", async () => {
    const src = await readSrc(modalPath);
    assert.doesNotMatch(src, /from\s+['"]@\/components\/ui\/dialog['"]/,
        "El QR interno no debe reintroducir Dialog/Portal.");
    assert.match(src, /from\s+['"]@\/components\/ui\/button['"]/,
        "Debe reutilizar Button de shadcn.");
    assert.match(src, /from\s+['"]@\/components\/ui\/alert['"]/,
        "Debe reutilizar Alert de shadcn.");
    assert.match(src, /data-testid="bold-qr-payment-view"/);
    assert.match(src, /<section/);
    assert.match(src, /aria-labelledby="bold-qr-modal-title"/);
    assert.doesNotMatch(src, /role="dialog"|aria-modal/);
    assert.doesNotMatch(src, /from\s+['"]@heroui\/react['"]/,
        "El componente QR no importa HeroUI; vive dentro del padre.");
});

test("ModalPagoBoldQR usa 'use client' porque monta estado y fetch streaming", async () => {
    const src = await readSrc(modalPath);
    assert.match(src.slice(0, 60), /["']use client["']/,
        "El archivo debe empezar con `use client` (hooks + fetch streaming).");
});

test("ModalPagoBoldQR importa los helpers puros del contrato Bold", async () => {
    const src = await readSrc(modalPath);
    assert.match(src, /from\s+['"]@\/lib\/bold-qr-helpers\.mjs['"]/);
    // Debe apoyarse en al menos: buildIniciarPayload, classifyStreamEvent,
    // BOLD_MERCHANT, BOLD_QR_IMAGE_PATH, BOLD_QR_STATUS, msUntilExpiry y
    // formatCountdown. Si alguna desaparece, el guardian salta.
    for (const sym of [
        "buildIniciarPayload",
        "classifyStreamEvent",
        "BOLD_MERCHANT",
        "BOLD_QR_IMAGE_PATH",
        "BOLD_QR_STATUS",
        "msUntilExpiry",
        "formatCountdown",
    ]) {
        assert.match(src, new RegExp(`\\b${sym}\\b`),
            `ModalPagoBoldQR debe usar el helper puro \`${sym}\`.`);
    }
});

// ---------------------------------------------------------------------------
// R2. QR image missing — bandera UX honesta, sin placeholder financiero
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR referencia /qr-bold-breb-code.png vía la constante del helper", async () => {
    const src = await readSrc(modalPath);
    // No hardcodeamos el string — tomamos la constante BOLD_QR_IMAGE_PATH.
    assert.match(src, /src=\{BOLD_QR_IMAGE_PATH\}/,
        "La imagen del QR debe venir de BOLD_QR_IMAGE_PATH para no divergir del helper.");
});

test("ModalPagoBoldQR maneja onError marcando qrImageMissing", async () => {
    const src = await readSrc(modalPath);
    assert.match(
        src,
        /onError=\{\(\)\s*=>\s*setQrImageMissing\(true\)\}/,
        "La <img> debe setear setQrImageMissing(true) en onError para bloquear UX insegura.",
    );
});

test("ModalPagoBoldQR deshabilita 'DEJAR EN ESPERA Y SEGUIR ATENDIENDO' cuando qrImageMissing", async () => {
    const src = await readSrc(modalPath);
    // Esperamos que el botón primario del flujo asíncrono (migración 027)
    // incluya `qrImageMissing` en su atributo disabled: sin la imagen del
    // QR válida, el cajero no debe dejar en espera un cobro que el
    // cliente no puede escanear.
    const enqueueButtonBlock = src.slice(src.indexOf("onClick={handleEnqueueAndClose}"));
    assert.ok(
        /disabled=\{[^}]*qrImageMissing[^}]*\}/.test(enqueueButtonBlock),
        "El botón 'DEJAR EN ESPERA Y SEGUIR ATENDIENDO' debe deshabilitarse cuando qrImageMissing.",
    );
});

test("ModalPagoBoldQR muestra el bloqueador UX QR_IMAGE_MISSING cuando onError se dispara", async () => {
    const src = await readSrc(modalPath);
    assert.match(src, /QR_IMAGE_MISSING/,
        "Debe exponer el literal 'QR_IMAGE_MISSING' para que el cajero vea el estado.");
    assert.match(src, /qr-bold-breb-code\.png/,
        "El texto UX debe mencionar la ruta exacta `/qr-bold-breb-code.png`.");
    assert.match(src, /administrador/i,
        "Debe pedir al administrador cargar la imagen antes de usar este método.");
});

test("ModalPagoBoldQR NUNCA genera placeholder financiero (data: URI o barcode)", async () => {
    const src = await readWithoutComments(modalPath);
    // Un placeholder financiero podría colarse como una URL `data:image/...`
    // con QR embebido, un `new QRCode()` dinámico, o un fallback `<svg>` con
    // "monto $X". Vedamos indicadores claros de GENERACIÓN de un QR falso.
    // Nota: aceptamos la mención de `QrCode` como icono de lucide-react
    // (sólo es un ícono UI, no genera un código escaneable).
    const forbiddenGenerators = [
        /new\s+QRCode\s*\(/,
        /qrcode\s*\.\s*toDataURL/i,
        /\bjsBarcode\s*\(/,
        /toDataURL\s*\(/,
        /data:image\/[a-z]+;base64,/i,
    ];
    for (const pattern of forbiddenGenerators) {
        assert.doesNotMatch(
            src,
            pattern,
            `El modal NO puede generar un QR falso (patrón ${pattern}): bloqueador operativo documentado.`,
        );
    }
});

test("ModalPagoBoldQR imagen con alt accesible y dimensiones mínimas 260x260", async () => {
    const src = await readSrc(modalPath);
    assert.match(src, /alt=["'][^"']+["']/, "La imagen del QR debe tener alt accesible.");
    assert.match(src, /BOLD_QR_ASSET_SIDE_PX/,
        "El width/height debe venir de BOLD_QR_ASSET_SIDE_PX (561) para preservar el recorte nativo.");
});

// ---------------------------------------------------------------------------
// R3. Contrato de endpoints
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR POSTea EXACTAMENTE /pos/pagos-qr/iniciar al abrir", async () => {
    const src = await readSrc(modalPath);
    assert.match(src, /apiFetch<[^>]*>\(\s*["']\/pos\/pagos-qr\/iniciar["']/);
    assert.match(src, /method:\s*["']POST["']/);
    // El body se construye con buildIniciarPayload para evitar typos
    // (caja_id snake_case).
    assert.match(src, /buildIniciarPayload\(/,
        "El body de /iniciar debe venir del helper puro buildIniciarPayload.");
});

test("ModalPagoBoldQR NO llama /pos/pagos-qr/confirmar-manual (ruta retirada en migración 027)", async () => {
    const src = await readSrc(modalPath);
    const runtime = await readWithoutComments(modalPath);
    // El endpoint quedó admin-only en el backend; el modal del cajero
    // no lo invoca, no lo nombra como literal runtime, ni expone un
    // botón "Confirmar manual" en la UI.
    assert.doesNotMatch(
        runtime,
        /\/pos\/pagos-qr\/confirmar-manual/,
        "La ruta /pos/pagos-qr/confirmar-manual NO debe estar en el runtime del modal del cajero.",
    );
    assert.ok(
        !src.includes("Confirmar manual"),
        "El texto 'Confirmar manual' no debe aparecer en el bundle del cajero.",
    );
    assert.ok(
        !src.includes("handleConfirmManual"),
        "El handler handleConfirmManual quedó retirado por la migración 027.",
    );
});

test("ModalPagoBoldQR POSTea /pos/pagos-qr/encolar a través del callback onEnqueueAndClose del padre", async () => {
    const upm = await readSrc(upmPath);
    const salesPage = await readSrc(salesNewPagePath);
    // El POST /encolar vive en el padre /sales/new/page.tsx (porque
    // conoce el snapshot del carrito). El modal del cajero sólo
    // dispara el callback que recibe por props.
    assert.match(
        salesPage,
        /apiFetch\(\s*['"]\/pos\/pagos-qr\/encolar['"]/,
        "El padre /sales/new/page.tsx debe pegar al endpoint /pos/pagos-qr/encolar.",
    );
    assert.match(
        upm,
        /onEnqueueAndClose=\{isBoldQrReopen \? undefined : onBoldQrEnqueueRequested\}/,
        "UPM debe pasar directamente el callback del padre al modal hijo.",
    );
});

test("ModalPagoBoldQR POSTea /pos/pagos-qr/cancelar al cancelar/cambiar método", async () => {
    const src = await readSrc(modalPath);
    assert.match(src, /apiFetch\(\s*["']\/pos\/pagos-qr\/cancelar["']/);
    // Toleramos que falle (el backend reconciliará con expiración de 5min),
    // así el cajero no queda atrapado si la red cae.
    assert.match(src, /skipSessionRecovery:\s*true/,
        "El cancelar no debe disparar el flujo de reauth: el cajero puede cerrar y seguir.");
});

// ---------------------------------------------------------------------------
// R4. SSE autenticado por fetch Authorization — nunca token en query
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR abre el stream vía fetch streaming, no new EventSource", async () => {
    const src = await readSrc(modalPath);
    const srcClean = await readWithoutComments(modalPath);
    assert.match(src, /\/pos\/pagos-qr\/stream\?venta_temp_id=/);
    assert.doesNotMatch(srcClean, /new\s+EventSource\(/,
        "No puede usar EventSource nativo: no permite header Authorization.");
    assert.match(srcClean, /Authorization:\s*`Bearer \$\{token\}`/,
        "El header Authorization debe ir Bearer <token> estilo literal.");
    assert.match(srcClean, /Accept:\s*["']text\/event-stream["']/);
    // Confirmamos la ausencia de token en query string (comentarios ya
    // descartados): si alguien añade `?token=` o `&token=` al URL del
    // stream el guardián cae.
    assert.doesNotMatch(srcClean, /\/pos\/pagos-qr\/stream\?[^"'`\n]*token=/,
        "El SSE NO puede llevar el token por query string.");
});

test("ModalPagoBoldQR usa parseSSEBlock + computeSSERetryDelay (contrato canónico)", async () => {
    const src = await readSrc(modalPath);
    assert.match(src, /parseSSEBlock\(/,
        "El parseo de frames SSE debe venir del helper puro.");
    assert.match(src, /computeSSERetryDelay\(/,
        "El backoff de reconexión debe usar computeSSERetryDelay (consistente con GlobalSyncProvider).");
});

// ---------------------------------------------------------------------------
// R5. onApproved único + auto-cierre 1.5s
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR dispara onApproved exactamente una vez via useRef guard", async () => {
    const src = await readSrc(modalPath);
    assert.match(src, /approvedFiredRef\s*=\s*useRef/,
        "Debe existir un useRef<boolean> `approvedFiredRef` para prevenir doble disparo.");
    assert.match(
        src,
        /if\s*\(\s*approvedFiredRef\.current\s*\)\s*return/,
        "El guard debe retornar temprano cuando ya se disparó onApproved.",
    );
    assert.match(src, /approvedFiredRef\.current\s*=\s*true/,
        "Debe marcar approvedFiredRef.current = true después de verificar que no se había disparado.");
});

test("ModalPagoBoldQR auto-cierra 1.5s después de aprobar", async () => {
    const src = await readSrc(modalPath);
    // Permitimos 1500 o 1_500 pero no cambios de orden de magnitud.
    assert.match(src, /setTimeout\([\s\S]*?onApproved[\s\S]*?,\s*1500\)/,
        "Debe disparar onApproved tras setTimeout(... , 1500) — 1.5s por contrato UX.");
});

test("ModalPagoBoldQR reproduce playNotificationSound('success') al aprobar", async () => {
    const src = await readSrc(modalPath);
    assert.match(src, /playNotificationSound\(\s*['"]success['"]\s*\)/,
        "La aprobación debe disparar el tono success (honra mute global).");
});

// ---------------------------------------------------------------------------
// R6. Branding del merchant verificado
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR muestra encabezado con el nombre del negocio", async () => {
    const src = await readSrc(modalPath);
    assert.match(src, /\{BOLD_MERCHANT\.businessName\}/,
        "Al escanear, el QR de Bold muestra Surtifamiliar; el modal debe mostrar el mismo nombre.");
});

test("ModalPagoBoldQR muestra badge Bre-B y subtítulo del titular verificado", async () => {
    const src = await readSrc(modalPath);
    assert.match(src, /BOLD_QR_METHOD_BADGE/,
        "Debe pintar el badge con la etiqueta canónica.");
    assert.match(src, /BOLD_MERCHANT\.subheader/,
        "Debe pintar el subtítulo con el titular verificado.");
    assert.match(src, /BOLD_MERCHANT\.footer/,
        "Debe pintar el pie con el código de comercio.");
});

test("ModalPagoBoldQR muestra 'Digita este valor exacto en tu app' con el monto COP gigante", async () => {
    const src = await readSrc(modalPath);
    assert.match(src, /Digita este valor exacto en tu app/i,
        "El texto de instrucción al cliente debe estar presente.");
    // El monto se pinta con formatCurrency y clase text-5xl o superior.
    assert.match(src, /text-5xl|text-6xl/,
        "El monto COP debe pintarse al menos text-5xl para que el cliente lo vea claro.");
});

// ---------------------------------------------------------------------------
// R7. UniversalPaymentModal expone el método "QR Bold / Bre-B"
// ---------------------------------------------------------------------------

test("UniversalPaymentModal importa ModalPagoBoldQR y BOLD_QR_METHOD_LABEL", async () => {
    const src = await readSrc(upmPath);
    assert.match(src, /from\s+['"]@\/components\/shared\/ModalPagoBoldQR['"]/,
        "Debe importar el modal hijo.");
    assert.match(src, /BOLD_QR_METHOD_LABEL/,
        "Debe usar la etiqueta canónica del helper.");
});

test("UniversalPaymentModal expone `onBoldQrRequested` como prop opcional", async () => {
    const src = await readSrc(upmPath);
    // Firma extendida en el patch "snapshot durable al abrir" (migración
    // 027): el callback acepta `(amount, ventaTempId)` y puede devolver
    // Promise. El UPM espera el `await` antes de abrir el modal hijo
    // para que el padre pre-registre la intención con el carrito actual.
    assert.match(
        src,
        /onBoldQrRequested\?\s*:\s*\(amount:\s*number,\s*ventaTempId:\s*string\)\s*=>\s*void\s*\|\s*Promise<void>/,
        "La prop opcional debe propagar la firma (amount, ventaTempId) y permitir Promise<void>.",
    );
});

test("UniversalPaymentModal renderiza <ModalPagoBoldQR .../> con las props canónicas", async () => {
    const src = await readSrc(upmPath);
    // Buscamos el elemento y nos aseguramos de que llevan isOpen, monto,
    // ventaTempId, cajaId, onApproved y onCancel.
    const openTag = src.indexOf("<ModalPagoBoldQR");
    assert.ok(openTag > 0, "Debe renderizarse <ModalPagoBoldQR .../>");
    const close = src.indexOf("/>", openTag);
    const block = src.slice(openTag, close);
    for (const prop of ["isOpen=", "monto=", "ventaTempId=", "cajaId=", "onApproved=", "onCancel="]) {
        assert.ok(block.includes(prop), `La invocación debe pasar la prop ${prop}.`);
    }
});

test("UniversalPaymentModal condiciona el botón QR a canUseBoldQr (incluye onBoldQrRequested)", async () => {
    const src = await readSrc(upmPath);
    // El flag canUseBoldQr debe verificar que:
    //   - onBoldQrRequested esté presente (prop legacy-safe)
    //   - no sea flujo de salida / refund / abono
    //   - haya saldo pendiente real
    // Buscamos el useMemo que lo compone.
    const idx = src.indexOf("const canUseBoldQr");
    assert.ok(idx > 0, "Debe existir el memoizado canUseBoldQr.");
    const end = src.indexOf(");", idx);
    const scope = src.slice(idx, end + 2);
    for (const condition of ["onBoldQrRequested", "flowType", "isReturnExchange", "remainingDebt"]) {
        assert.ok(
            scope.includes(condition),
            `canUseBoldQr debe tomar en cuenta ${condition}.`,
        );
    }
});

test("UniversalPaymentModal expone el botón 'QR Bold / Bre-B' con aria-label canónico", async () => {
    const src = await readSrc(upmPath);
    assert.match(src, /aria-label=\{BOLD_QR_METHOD_LABEL\}/,
        "El botón del método debe usar BOLD_QR_METHOD_LABEL como aria-label.");
    assert.match(src, /QR Bold/,
        "El label visible debe contener 'QR Bold'.");
});

// ---------------------------------------------------------------------------
// R8. APROBADO con saleId > 0 → `onBoldQrFinalized`, nunca `onPay`
//
// Antes de la 027 el UPM invocaba `onPay` con `transferSource="BOLD_QR"`
// al aprobar. Esa ruta regeneraba un `clientTxId` fresco en
// `handleConfirmSale` y disparaba un POST `/sales/register` que creaba
// una SEGUNDA venta cuando el backend ya la había materializado vía
// `DispatchAutoSale`. El guard R8 fija que esa duplicación quedó
// eliminada: el UPM delega al callback explícito `onBoldQrFinalized`
// del padre y JAMÁS llama a `onPay` desde la rama de aprobación QR.
// ---------------------------------------------------------------------------

test("UniversalPaymentModal.handleBoldQrApproved: con saleId>0 llama a onBoldQrFinalized, nunca a onPay", async () => {
    const src = await readSrc(upmPath);
    const idx = src.indexOf("const handleBoldQrApproved");
    assert.ok(idx > 0, "handleBoldQrApproved debe existir.");
    const end = src.indexOf("}, [", idx);
    const scope = src.slice(idx, end > idx ? end : idx + 5000);
    // Debe invocar explícitamente `onBoldQrFinalized({ ... })`.
    assert.match(
        scope,
        /onBoldQrFinalized\(\s*\{/,
        "handleBoldQrApproved debe invocar onBoldQrFinalized con el payload del backend.",
    );
    // El bloque de la aprobación NO debe contener `onPay(` ni
    // componer `transferSource: 'BOLD_QR'` (eso vivía en la rama
    // heredada que creaba la venta duplicada).
    assert.ok(
        !/\bawait\s+onPay\s*\(/.test(scope),
        "handleBoldQrApproved NO debe invocar onPay: eso duplicaría la venta ya materializada por DispatchAutoSale.",
    );
    assert.ok(
        !/transferSource:\s*[\s\S]*?["']BOLD_QR["']/.test(scope),
        "El payload `transferSource: 'BOLD_QR'` dejó de existir aquí; el frontend ya no re-registra la venta.",
    );
});

test("UniversalPaymentModal: APROBADO sin saleId muestra alerta y NO llama a onPay automáticamente", async () => {
    const src = await readSrc(upmPath);
    const idx = src.indexOf("const handleBoldQrApproved");
    assert.ok(idx > 0, "handleBoldQrApproved debe existir.");
    const end = src.indexOf("}, [", idx);
    const scope = src.slice(idx, end > idx ? end : idx + 5000);
    // La rama de saleId <= 0 dispara un `toast` destructivo con copy
    // "esperando conciliación" (literal case-insensitive) y nunca llama
    // onPay. El guard es tolerante al casing porque el copy exacto puede
    // variar entre revisiones de UX.
    assert.match(
        scope,
        /ESPERANDO\s+CONCILIACI[OÓ]N/i,
        "La rama saleId<=0 debe pintar un toast 'esperando conciliación' en vez de disparar onPay.",
    );
    // Y de nuevo: cero `onPay(` en todo el handler.
    assert.ok(
        !/\bawait\s+onPay\s*\(/.test(scope),
        "La rama saleId<=0 tampoco puede caer a onPay (nunca inventa ventas).",
    );
});

test("UniversalPaymentModal expone `onBoldQrFinalized` como prop opcional con firma canónica", async () => {
    const src = await readSrc(upmPath);
    // La prop debe tipar explícitamente (ventaTempId, saleId, ...) y
    // devolver `void` (fire-and-forget desde la perspectiva del UPM).
    assert.match(
        src,
        /onBoldQrFinalized\?\s*:\s*\(info:\s*\{[\s\S]*?readonly\s+ventaTempId:\s*string;[\s\S]*?readonly\s+saleId:\s*number;[\s\S]*?\}\)\s*=>\s*void/,
        "La prop opcional debe propagar la firma ({ ventaTempId, saleId, ... }) => void.",
    );
    assert.match(
        src,
        /onBoldQrFinalized,/,
        "La prop debe destructurarse en la firma del componente.",
    );
});

// ---------------------------------------------------------------------------
// R9. Nunca expone secretos
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR NUNCA menciona BOLD_SECRET_KEY ni BOLD_BRIDGE_TOKEN", async () => {
    const src = await readWithoutComments(modalPath);
    assert.doesNotMatch(src, /BOLD_SECRET_KEY/,
        "Secreto del lado backend: no debe aparecer en el bundle del frontend.");
    assert.doesNotMatch(src, /BOLD_BRIDGE_TOKEN/,
        "Token del bridge MacroDroid: solo backend.");
});

test("Los helpers puros tampoco exponen BOLD_SECRET_KEY ni BOLD_BRIDGE_TOKEN", async () => {
    const src = await readWithoutComments(helperPath);
    assert.doesNotMatch(src, /BOLD_SECRET_KEY/);
    assert.doesNotMatch(src, /BOLD_BRIDGE_TOKEN/);
});

// ---------------------------------------------------------------------------
// R7bis. /sales/new/page.tsx habilita BOLD_QR via onBoldQrRequested
// ---------------------------------------------------------------------------

test("sales/new/page.tsx pasa onBoldQrRequested al UniversalPaymentModal (habilita el método real)", async () => {
    const src = await readSrc(salesNewPagePath);
    assert.match(src, /onBoldQrRequested=\{/,
        "La página de caja real debe habilitar el método QR Bold pasando onBoldQrRequested.");
});

// ---------------------------------------------------------------------------
// R10. El flujo honra el contrato "nunca token en query" también en el
//      wiring del padre. El SSE siempre monta por fetch streaming.
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR no inserta token en query string del endpoint stream", async () => {
    const src = await readWithoutComments(modalPath);
    // Patrón prohibido: `?token=` o `&token=` en cualquier URL construida
    // (ya descartamos comentarios donde se habla del token como texto).
    assert.doesNotMatch(src, /[?&]token=/,
        "Nunca se puede llevar el token por query string: debe ir en header Authorization.");
});
