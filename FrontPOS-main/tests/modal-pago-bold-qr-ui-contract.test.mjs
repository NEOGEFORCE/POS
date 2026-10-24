// =============================================================================
// tests/modal-pago-bold-qr-ui-contract.test.mjs
//
// Guardianes de contrato visual + lógico para `ModalPagoBoldQR` y su
// integración en `UniversalPaymentModal` (migración 027, flujo
// asíncrono 100% basado en bandeja global). No montan React (los tests
// `node --test` prueban helpers puros) sino que confirman que el código
// fuente del componente cumple las reglas duras del sprint:
//
//   - Modal centrado shadcn (vista directa + Alert/Button).
//   - Encabezado "SUPERMERCADO SURTIFAMILIAR" grande.
//   - Badge "Escanea desde Nequi, DaviPlata, Bancolombia o cualquier
//     banco (Bre-B)".
//   - Monto gigante + instrucción "Digita este valor exacto en tu app".
//   - Ruta QR `/qr-bold-breb-code.png` con mínimo 260x260 y fallback honesto
//     si el archivo falta en `public/`.
//   - Subtítulo "Titular verificado: Sebastian Sarmiento | Comercio
//     Bre-B: 0093097755" y pie "Titular: Sebastian Sarmiento | Código
//     de comercio: 0093097755" vivos como strings en el JSX.
//   - Chime Web Audio en aprobación: usa `playNotificationSound('success')`.
//   - Auto-cierre tras 1500 ms y disparo único de `onApproved`.
//   - Stream autenticado por fetch + `Authorization: Bearer`, SIN token
//     en query string.
//   - UNMATCHED/AMBIGUOUS NUNCA aprueban automáticamente.
//   - Nunca referencia `BOLD_BRIDGE_TOKEN` ni `BOLD_SECRET_KEY` en el
//     bundle del front.
//   - Botón primario "DEJAR EN ESPERA Y SEGUIR ATENDIENDO" + botón
//     "Cancelar y cambiar" (migración 027). El flujo manual retirado
//     NO debe aparecer en el bundle del cajero.
//   - UPM muestra el método "QR Bold / Bre-B" en el rail de métodos.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const MODAL_PATH = join(here, "..", "src", "components", "shared", "ModalPagoBoldQR.tsx");
const UPM_PATH = join(here, "..", "src", "components", "shared", "UniversalPaymentModal.tsx");
const HELPERS_PATH = join(here, "..", "src", "lib", "bold-qr-helpers.mjs");

const modalSrc = readFileSync(MODAL_PATH, "utf8");
const upmSrc = readFileSync(UPM_PATH, "utf8");
const helpersSrc = readFileSync(HELPERS_PATH, "utf8");

/**
 * Elimina comentarios de bloque `/* ... *\/` y de línea `// ...` del
 * código fuente antes de buscar patrones ejecutables. Los guardianes
 * anti-regresión (p.ej. "ya no compone transferSource='BOLD_QR'")
 * necesitan examinar únicamente lo que se ejecuta: dejar un contrato
 * documentado como ejemplo en un docstring debe seguir siendo válido.
 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const upmRuntime = stripComments(upmSrc);

// ---------------------------------------------------------------------------
// Vista directa accesible, sin segundo sistema modal
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR: usa vista directa y componentes shadcn sin Portal", () => {
    assert.doesNotMatch(
        modalSrc,
        /from "@\/components\/ui\/dialog"|<Dialog|DialogContent|DialogPortal/,
        "No debe existir un segundo Dialog/Portal dentro de HeroUI",
    );
    assert.match(modalSrc, /from "@\/components\/ui\/button"/);
    assert.match(modalSrc, /from "@\/components\/ui\/alert"/);
    assert.match(modalSrc, /data-testid="bold-qr-payment-view"/);
    assert.match(modalSrc, /<section/);
    assert.doesNotMatch(modalSrc, /aria-modal|absolute\s+inset-0|onMouseDown=/);
    assert.ok(
        !/from "@heroui\/react"/.test(modalSrc),
        "ModalPagoBoldQR vive dentro del padre y no importa HeroUI",
    );
});

// ---------------------------------------------------------------------------
// Encabezado, badge, monto, pie
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR: muestra el nombre del negocio (coincide con lo que ve el cliente al escanear)", () => {
    assert.ok(
        modalSrc.includes("{BOLD_MERCHANT.businessName}"),
        "El encabezado visible debe mostrar SUPERMERCADO SURTIFAMILIAR",
    );
    assert.doesNotMatch(modalSrc, /id="bold-qr-modal-title" className="sr-only"/,
        "El título del diálogo debe ser visible, no sólo para lectores de pantalla");
});

test("ModalPagoBoldQR: badge con el texto exacto del sprint", () => {
    const badge = "Escanea desde Nequi, DaviPlata, Bancolombia o cualquier banco (Bre-B)";
    assert.ok(
        helpersSrc.includes(badge),
        "El helper expone el badge con texto exacto",
    );
    assert.ok(
        modalSrc.includes("BOLD_QR_METHOD_BADGE"),
        "El modal renderiza el badge desde el helper",
    );
});

test("ModalPagoBoldQR: muestra el monto gigante + instrucción 'Digita este valor exacto en tu app'", () => {
    assert.ok(
        modalSrc.includes("Digita este valor exacto en tu app"),
        "instrucción explícita al cliente (texto exigido por el sprint)",
    );
    // El monto se pinta vía formatCurrency(monto) en el DialogContent,
    // no con la etiqueta "Monto a pagar" porque el tipográfico gigante
    // (text-5xl md:text-6xl) ya transmite el rol semántico.
    assert.match(modalSrc, /formatCurrency\(monto\)/);
    assert.match(modalSrc, /text-(5|6)xl/,
        "el monto se renderiza con tipografía de 5xl o 6xl ('gigante')");
});

test("ModalPagoBoldQR: subtítulo y pie con 'Sebastian Sarmiento' y '0093097755'", () => {
    assert.ok(
        helpersSrc.includes("Titular verificado: Sebastian Sarmiento | Comercio Bre-B: 0093097755"),
        "subtítulo exacto en helper",
    );
    assert.ok(
        helpersSrc.includes("Titular: Sebastian Sarmiento | Código de comercio: 0093097755"),
        "pie exacto en helper",
    );
    assert.ok(
        modalSrc.includes("BOLD_MERCHANT.subheader") && modalSrc.includes("BOLD_MERCHANT.footer"),
        "el modal usa ambas constantes como fuente única",
    );
});

// ---------------------------------------------------------------------------
// QR estático: ruta y fallback honesto
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR: imagen /qr-bold-breb-code.png (ruta estática, min 260x260)", () => {
    assert.ok(
        modalSrc.includes("BOLD_QR_IMAGE_PATH"),
        "usa la constante del helper, no un literal hardcoded",
    );
    assert.ok(
        helpersSrc.includes('"/qr-bold-breb-code.png"'),
        "la constante del helper es el literal exigido",
    );
    assert.ok(
        helpersSrc.includes("260"),
        "mínimo 260 px documentado como constante",
    );
});

test("ModalPagoBoldQR: fallback cuando la imagen no carga NO es un placeholder financiero", () => {
    // onError conmuta a un panel de 'imagen pendiente' explícito.
    assert.match(modalSrc, /onError=\{\(\)\s*=>\s*setQrImageMissing\(true\)\}/);
    // El panel honesto incluye `QR_IMAGE_MISSING` + indicación clara al
    // administrador de cargar el archivo. NUNCA se dibuja un QR falso.
    assert.ok(
        modalSrc.includes("QR_IMAGE_MISSING"),
        "label textual que marca el bloqueo operativo",
    );
    assert.ok(
        modalSrc.includes("/qr-bold-breb-code.png"),
        "ruta exacta documentada en el panel vacío",
    );
    // Fuera de los comentarios de cabecera, nadie debe inyectar un QR
    // dummy / placeholder financiero. Chequeamos el JSX runtime (líneas
    // que no empiezan con `//`).
    const runtime = modalSrc
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//"))
        .join("\n");
    assert.ok(
        !/placeholder-qr|fake-qr|dummy-qr/i.test(runtime),
        "ningún placeholder QR falso en el JSX runtime",
    );
});

// ---------------------------------------------------------------------------
// Flujo de aprobación: chime, auto-close 1.5s, single-fire
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR: Web Audio chime en aprobación (playNotificationSound 'success')", () => {
    assert.match(modalSrc, /playNotificationSound\(['"]success['"]\)/);
});

test("ModalPagoBoldQR: auto-cierre y disparo único de onApproved tras 1500 ms", () => {
    // El setTimeout de 1500 ms invoca `onApproved(...)` dentro del
    // callback. La llamada es multilínea; validamos que (a) exista el
    // timeout, (b) exista una invocación a onApproved cerca y (c) la
    // guarda single-fire esté presente.
    assert.match(modalSrc, /setTimeout\(/, "al menos un setTimeout en el modal");
    assert.ok(
        modalSrc.includes("1500"),
        "la duración exigida del sprint es 1500 ms",
    );
    assert.match(
        modalSrc,
        /onApproved\(\s*\{/,
        "onApproved se invoca con un objeto (shape documentado)",
    );
    assert.match(
        modalSrc,
        /approvedFiredRef\.current/,
        "guarda single-fire para no disparar onApproved más de una vez",
    );
    assert.match(
        modalSrc,
        /approvedFiredRef\.current\s*=\s*true/,
        "la guarda se marca `true` antes del setTimeout",
    );
});

test("ModalPagoBoldQR: mensaje 'Pago recibido' visible al aprobar", () => {
    assert.ok(modalSrc.includes("Pago recibido"), "texto de éxito explícito");
});

// ---------------------------------------------------------------------------
// Stream SSE autenticado: Bearer header, NUNCA token en query
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR: stream con fetch + Authorization Bearer; token NUNCA en query", () => {
    // Debe pedir el stream con fetch.
    assert.match(modalSrc, /fetch\(url,\s*\{/);
    // Debe adjuntar Authorization: Bearer <token>.
    assert.match(modalSrc, /Authorization:\s*`Bearer \$\{token\}`/);
    // Debe pedir Accept: text/event-stream (contrato SSE del backend).
    assert.match(modalSrc, /Accept:\s*["']text\/event-stream["']/);
    // La URL del stream NUNCA debe incluir `token=` como query param.
    // La única búsqueda del endpoint es `/pos/pagos-qr/stream` y
    // comprobamos que su línea de construcción no mezcle "token=".
    const streamUrlLines = modalSrc
        .split("\n")
        .filter((l) => l.includes("/pos/pagos-qr/stream"));
    assert.ok(streamUrlLines.length > 0, "al menos una línea construye la URL del stream");
    for (const line of streamUrlLines) {
        assert.ok(
            !/\btoken\s*=/.test(line),
            `La línea no debe adjuntar el token por query: ${line.trim()}`,
        );
    }
    // EventSource no debe usarse (no soporta headers de forma nativa).
    assert.ok(
        !/new EventSource\(/.test(modalSrc),
        "No usar EventSource: Authorization vía header exige fetch streaming",
    );
});

// ---------------------------------------------------------------------------
// Protección obligatoria: UNMATCHED/AMBIGUOUS nunca aprueban auto
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR: UNMATCHED/AMBIGUOUS no disparan onApproved (require-manual)", () => {
    // La clasificación se hace en el helper puro — tests dedicados aseguran
    // que `classifyStreamEvent({status:"UNMATCHED"}).action === "require-manual"`.
    // Aquí, en la UI, nos aseguramos de que el único camino al setTimeout
    // de 1500 ms + onApproved sea el case 'approve'.
    assert.match(
        modalSrc,
        /case\s+["']approve["']/,
        "el switch distingue el case 'approve' del resto",
    );
    assert.match(
        modalSrc,
        /case\s+["']require-manual["']/,
        "existe un case explícito 'require-manual' para UNMATCHED/AMBIGUOUS",
    );
    // Captura la rama require-manual completa (hasta el `break`/`return`) y
    // verifica que NO llame a `onApproved(` dentro.
    const requireManualBlock = modalSrc.match(
        /case\s+["']require-manual["']\s*:\s*\{([\s\S]*?)\breturn;\s*\}/,
    );
    assert.ok(requireManualBlock, "la rama require-manual tiene cuerpo acotado");
    assert.ok(
        !/onApproved\s*\(/.test(requireManualBlock[1]),
        "la rama require-manual NUNCA llama a onApproved — exigido por la protección contra doble aprobación",
    );
});

// ---------------------------------------------------------------------------
// Secretos: nunca aparecen en el bundle
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR y helpers: no exponen BOLD_BRIDGE_TOKEN ni BOLD_SECRET_KEY como valores runtime", () => {
    // Las menciones en comentarios documentales están permitidas (como
    // recordatorio del contrato con el backend). Lo que se prohíbe es
    // usarlos como identificadores JS (lectura, imports, env). Para eso
    // filtramos las líneas que arrancan con `//`.
    const runtime = (src) => src
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//"))
        .join("\n");
    const modalRt = runtime(modalSrc);
    const helpersRt = runtime(helpersSrc);
    for (const secret of ["BOLD_BRIDGE_TOKEN", "BOLD_SECRET_KEY"]) {
        assert.ok(
            !new RegExp(`\\b${secret}\\b`).test(modalRt),
            `${secret} jamás como identificador runtime en ModalPagoBoldQR`,
        );
        assert.ok(
            !new RegExp(`\\b${secret}\\b`).test(helpersRt),
            `${secret} jamás como identificador runtime en bold-qr-helpers`,
        );
    }
    // Ancla extra: `process.env.*BOLD*` no debe filtrarse al front.
    const combined = modalRt + "\n" + helpersRt;
    assert.ok(
        !/process\.env\.[A-Z_]*BOLD[A-Z_]*/.test(combined),
        "secretos del backend no deben leerse desde process.env en el front",
    );
});

// ---------------------------------------------------------------------------
// Botones de acción
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR: botones 'DEJAR EN ESPERA Y SEGUIR ATENDIENDO' y 'Cancelar y cambiar' presentes", () => {
    // El cajero NO ve el flujo manual retirado por la migración 027.
    assert.ok(!modalSrc.includes("Confirmar manual"), "El texto 'Confirmar manual' debe estar fuera del bundle.");
    assert.ok(!modalSrc.includes("handleConfirmManual"), "El handler quedó retirado.");
    // El botón primario del flujo asíncrono tiene copy EXACTO en mayúsculas.
    assert.ok(
        modalSrc.includes("DEJAR EN ESPERA Y SEGUIR ATENDIENDO"),
        "copy exacto en mayúsculas del botón primario (migración 027)",
    );
    // El copy del botón de cancelar/cambiar admite minúscula en 'cambiar'
    // porque el componente lo pinta así (lectura real del repo). El
    // contrato duro es que ambas palabras aparezcan juntas separadas por
    // '/' o seguidas por "y".
    assert.match(
        modalSrc,
        /Cancelar\s*(?:\/|y)\s*[Cc]ambiar/,
        "copy del botón cancelar + cambiar (acepta '/', 'y', mayúscula o minúscula)",
    );
    // Iniciar llama POST /pos/pagos-qr/iniciar.
    assert.match(modalSrc, /["']\/pos\/pagos-qr\/iniciar["']/);
    // Cancelar llama POST /pos/pagos-qr/cancelar.
    assert.match(modalSrc, /["']\/pos\/pagos-qr\/cancelar["']/);
    // La ruta /confirmar-manual quedó retirada del bundle del cajero.
    assert.ok(
        !modalSrc.includes("/pos/pagos-qr/confirmar-manual"),
        "La ruta /pos/pagos-qr/confirmar-manual quedó admin-only en backend y NO debe estar aquí.",
    );
});

test("ModalPagoBoldQR: onEnqueueAndClose recibe (ventaTempId, monto) exactos de las props", () => {
    // Contrato de migración 027: el modal pasa su `ventaTempId` + `monto`
    // de props al callback onEnqueueAndClose. El padre NUNCA debe
    // regenerar el id; reutiliza los valores exactos.
    assert.match(
        modalSrc,
        /onEnqueueAndClose\?\s*:\s*\(ventaTempId:\s*string,\s*monto:\s*number\)/,
        "La prop onEnqueueAndClose debe tipar explícitamente (ventaTempId, monto).",
    );
    assert.match(
        modalSrc,
        /onEnqueueAndClose\(\s*ventaTempId\s*,\s*Math\.round\(monto\)\s*\)/,
        "El handler debe invocar onEnqueueAndClose(ventaTempId, Math.round(monto)) usando SIEMPRE los props.",
    );
});

// ---------------------------------------------------------------------------
// UPM: integración del método QR Bold / Bre-B en cobro real
// ---------------------------------------------------------------------------

test("UniversalPaymentModal: expone el método 'QR Bold / Bre-B' en el rail", () => {
    assert.ok(upmSrc.includes("QR Bold / Bre-B"), "etiqueta visible del método");
    assert.ok(upmSrc.includes("handleOpenBoldQr"), "handler expuesto en el rail");
    assert.ok(upmSrc.includes("BOLD_QR_METHOD_LABEL"), "aria-label del método usa la constante");
});

test("UniversalPaymentModal: alterna ModalPagoBoldQR directamente dentro de ModalContent", () => {
    const contentStart = upmSrc.indexOf("<ModalContent>");
    const qrIndex = upmSrc.indexOf("<ModalPagoBoldQR", contentStart);
    const contentEnd = upmSrc.indexOf("</ModalContent>", contentStart);
    assert.ok(contentStart >= 0 && qrIndex > contentStart && contentEnd > qrIndex,
        "la vista QR debe vivir dentro del árbol interactivo de HeroUI");
    assert.match(upmSrc, /\{\(\) => isBoldQrOpen \? \(/,
        "ModalContent debe cambiar directamente entre QR y pago");
    assert.equal((upmSrc.match(/<ModalPagoBoldQR/g) || []).length, 1,
        "no debe existir una segunda instancia superpuesta");
    // La prop `onApproved` puede recibir el info del backend o ignorarlo.
    assert.match(
        upmSrc,
        /onApproved=\{\s*(?:\(\s*\)|\(\s*info\s*\))\s*=>\s*\{\s*void\s+handleBoldQrApproved\(/,
        "wiring de aprobación delega a handleBoldQrApproved con firma única",
    );
});

test("UniversalPaymentModal: ya NO compone `transferSource='BOLD_QR'` (ruta heredada eliminada)", () => {
    // Tras el fix anti-doble-venta (DispatchAutoSale post-commit), la
    // aprobación BOLD_QR delega a `onBoldQrFinalized` del padre en vez
    // de componer un payload `onPay({ transferSource: 'BOLD_QR', ... })`.
    // Por tanto el literal `'BOLD_QR'` NO debe sobrevivir como string
    // runtime dentro del UPM: la etiqueta se maneja contablemente del
    // lado del backend (SaleService la aplica tras `MarkFinalizationSucceeded`).
    //
    // `BOLD_QR_METHOD_LABEL` (identifier importado del helper) sigue
    // vivo porque etiqueta el BOTÓN del método en la grilla — eso es
    // UI de activación, no composición de payment payload.
    //
    // Usamos la versión sin comentarios para evitar falsos positivos
    // de docstrings que ejemplifican el patrón heredado.
    assert.ok(
        !/\btransferSource:\s*[\s\S]{0,80}?["']BOLD_QR["']/.test(upmRuntime),
        "El UPM NO debe seguir componiendo `transferSource: 'BOLD_QR'` en el payload de onPay (ruta heredada que duplicaba la venta).",
    );
    // `MIXTO` sí sobrevive: lo usa `processPayment` cuando el pago
    // combina Nequi + Daviplata.
    assert.ok(upmRuntime.includes('"MIXTO"'), "etiqueta MIXTO sigue vigente para pagos combinados Nequi+Daviplata");
});



test("ModalPagoBoldQR se limita a la altura del padre y usa scroll interno", () => {
    assert.match(
        modalSrc,
        /max-h-full[^"\n]*overflow-y-auto[^"\n]*overscroll-contain/,
        "La tarjeta QR debe usar max-h-full + overflow-y-auto + overscroll-contain para no ser recortada por el padre.",
    );
    assert.doesNotMatch(
        modalSrc,
        /max-h-\[calc\(100dvh-1rem\)\]/,
        "La tarjeta QR no debe dimensionarse contra el viewport cuando vive dentro de un modal padre más pequeño.",
    );
});
