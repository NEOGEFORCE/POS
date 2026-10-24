// =============================================================================
// tests/internal-barcode-ui-contract.test.mjs
//
// Guardianes ESTÁTICOS para la UI de "Generar código interno" POSINT-*.
//
// Alcance:
//
//   1. ProductFormModal:
//      - Importa shadcn Button (aliasado) y shadcn Alert, no inventa primitiva.
//      - Importa helpers canónicos desde '@/lib/internal-barcode.mjs'.
//      - Renderiza el botón sólo en modo creación (`addDialogOpen`).
//      - El botón expone `aria-label`, `aria-busy` y `disabled` cuando corresponde.
//      - El `onClick` hace POST a '/labels/internal-codes/reserve', NO genera
//        códigos POSINT- en el cliente.
//      - En error, se abre un `<Alert variant="destructive">` con botones
//        "Regenerar" y "Cerrar aviso". Nunca entra en bucle: cada clic es
//        un POST explícito disparado por el usuario.
//      - Expone `onInternalBarcodeReserved` como prop para publicar la
//        reserva al padre (gating post-create).
//      - NO llama a '/labels/codes' ni '/labels/print-jobs' (eso es exclusivo
//        del LabelPrintSheet, que corre DESPUÉS del create OK).
//
//   2. products/page.tsx:
//      - Importa LabelPrintSheet desde la carpeta de recepción (reutilización).
//      - Importa isInternalBarcode de '@/lib/internal-barcode.mjs'.
//      - Abre el LabelPrintSheet DESPUÉS del POST /products/create-products
//        y SÓLO cuando `wasInternal` es true.
//      - Pasa `internalBarcodeSource="product_form"` y
//        `onInternalBarcodeReserved={setPendingInternalReservation}` al modal.
//
//   3. inventory/receive/page.tsx:
//      - Idem para `internalBarcodeSource="reception"` y reutilización del
//        LabelPrintSheet existente del propio módulo tras el create OK.
//
//   4. src/lib/internal-barcode.mjs tiene su declaración `.d.mts` acompañando
//      al módulo para que los consumidores TSX accedan a los tipos.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const modal = join(
    here,
    "..",
    "src",
    "app",
    "(app)",
    "products",
    "components",
    "ProductFormModal.tsx",
);
const productsPage = join(
    here,
    "..",
    "src",
    "app",
    "(app)",
    "products",
    "page.tsx",
);
const receivePage = join(
    here,
    "..",
    "src",
    "app",
    "(app)",
    "inventory",
    "receive",
    "page.tsx",
);
const helper = join(here, "..", "src", "lib", "internal-barcode.mjs");
const helperDts = join(here, "..", "src", "lib", "internal-barcode.d.mts");

async function leer(path) {
    return readFile(path, "utf8");
}

// Elimina comentarios (// y /* */) para asserts contra JSX ejecutable.
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
}

// ---------------------------------------------------------------------------
// 0. Archivos existen.
// ---------------------------------------------------------------------------

test("helper .mjs y su .d.mts existen (contrato público del módulo)", async () => {
    await access(helper); // throws si no existe
    await access(helperDts);
});

// ---------------------------------------------------------------------------
// 1. ProductFormModal — primitivas shadcn y helper canónico.
// ---------------------------------------------------------------------------

test("ProductFormModal importa shadcn Button aliasado (ShadButton)", async () => {
    const src = await leer(modal);
    assert.ok(
        /import\s*\{[^}]*Button\s+as\s+ShadButton[^}]*\}\s*from\s*["']@\/components\/ui\/button["']/.test(src),
        "Debe importar `Button as ShadButton` desde @/components/ui/button (contrato del pipeline).",
    );
});

test("ProductFormModal importa shadcn Alert (@/components/ui/alert)", async () => {
    const src = await leer(modal);
    assert.ok(
        /import\s*\{[^}]*Alert[^}]*AlertDescription[^}]*AlertTitle[^}]*\}\s*from\s*["']@\/components\/ui\/alert["']/.test(src)
        || (/Alert\s*,/.test(src) && /AlertTitle\s*,/.test(src) && /@\/components\/ui\/alert/.test(src)),
        "ProductFormModal debe importar Alert/AlertTitle/AlertDescription shadcn.",
    );
});

test("ProductFormModal importa helpers canónicos de internal-barcode.mjs", async () => {
    const src = await leer(modal);
    assert.ok(
        /from\s*["']@\/lib\/internal-barcode\.mjs["']/.test(src),
        "ProductFormModal debe depender del helper canónico — no inlinear 'POSINT-'.",
    );
    assert.ok(
        /isInternalBarcode/.test(src) && /buildReservePayload/.test(src)
            && /extractInternalErrorCode/.test(src) && /translateInternalErrorCode/.test(src),
        "Debe usar isInternalBarcode + buildReservePayload + extractInternalErrorCode + translateInternalErrorCode.",
    );
});

test("ProductFormModal NO inlinea el literal 'POSINT-'", async () => {
    const src = stripComments(await leer(modal));
    // El prefijo debe venir siempre a través del helper. Si aparece
    // "POSINT-" en el código ejecutable del componente, significa que
    // alguien lo hardcodeó.
    assert.ok(
        !/["']POSINT-/.test(src),
        "ProductFormModal no debe inlinear el literal 'POSINT-' (usar helpers de internal-barcode.mjs).",
    );
});

test("ProductFormModal NO genera códigos POSINT- en el cliente", async () => {
    const src = stripComments(await leer(modal));
    // Guardián clave: nada de crypto.randomUUID, Math.random, Date.now
    // combinados con el prefijo POSINT-. El código vive sólo en el
    // backend; el frontend sólo lo pide y lo pega.
    assert.ok(
        !/crypto\.randomUUID[\s\S]{0,120}POSINT/i.test(src),
        "Prohibido generar POSINT- en el cliente con crypto.randomUUID.",
    );
    assert.ok(
        !/Math\.random[\s\S]{0,120}POSINT/i.test(src),
        "Prohibido generar POSINT- en el cliente con Math.random.",
    );
});

// ---------------------------------------------------------------------------
// 2. ProductFormModal — endpoint y gating por modo creación.
// ---------------------------------------------------------------------------

test("ProductFormModal POSTea a /labels/internal-codes/reserve", async () => {
    const src = await leer(modal);
    assert.ok(
        /["']\/labels\/internal-codes\/reserve["']/.test(src),
        "El modal debe POSTear a /labels/internal-codes/reserve.",
    );
    assert.ok(
        /method:\s*['"]POST['"]/.test(src),
        "El fetch de la reserva debe usar method: 'POST'.",
    );
});

test("ProductFormModal NO llama a /labels/codes ni /labels/print-jobs (gating post-create)", async () => {
    const src = stripComments(await leer(modal));
    assert.ok(
        !/\/labels\/codes\b/.test(src),
        "/labels/codes es responsabilidad del LabelPrintSheet post-create, no del modal.",
    );
    assert.ok(
        !/\/labels\/print-jobs\b/.test(src),
        "/labels/print-jobs es responsabilidad del LabelPrintSheet post-create, no del modal.",
    );
});

test("ProductFormModal: el botón se renderiza SOLO en modo creación (addDialogOpen)", async () => {
    const src = await leer(modal);
    // El bloque del ShadButton de "Generar código interno" está
    // envuelto en `addDialogOpen && (...)`. Verificamos ese patrón.
    assert.ok(
        /\{\s*addDialogOpen\s*&&\s*\(\s*[\s\S]*?<ShadButton[\s\S]*?data-testid=["']btn-generate-internal-code["']/.test(src),
        "El botón 'Generar código interno' debe envolverse en {addDialogOpen && ...} (sólo creación).",
    );
});

// ---------------------------------------------------------------------------
// 3. ProductFormModal — accesibilidad del botón.
// ---------------------------------------------------------------------------

test("ProductFormModal: el botón expone aria-label dinámico (nunca icon-only sin label)", async () => {
    const src = await leer(modal);
    // El tag del botón puede tener aria-label antes o después de
    // data-testid; verificamos que ambos convivan en el MISMO tag.
    const tagMatch = /<ShadButton[^>]*data-testid=["']btn-generate-internal-code["'][^>]*>/.exec(src);
    assert.ok(tagMatch, "No se localizó el ShadButton con data-testid.");
    assert.ok(
        /aria-label=\{/.test(tagMatch[0]),
        "El botón debe tener aria-label dinámico que distinga 'Generar' vs 'Regenerar'.",
    );
});

test("ProductFormModal: el botón expone aria-busy mientras se solicita la reserva", async () => {
    const src = await leer(modal);
    const tagMatch = /<ShadButton[^>]*data-testid=["']btn-generate-internal-code["'][^>]*>/.exec(src);
    assert.ok(tagMatch, "No se localizó el ShadButton con data-testid.");
    assert.ok(
        /aria-busy=\{isReservingInternal\}/.test(tagMatch[0]),
        "El botón debe reflejar `isReservingInternal` en aria-busy para accesibilidad.",
    );
});

test("ProductFormModal: el botón se deshabilita durante la reserva en vuelo", async () => {
    const src = await leer(modal);
    const tagMatch = /<ShadButton[^>]*data-testid=["']btn-generate-internal-code["'][^>]*>/.exec(src);
    assert.ok(tagMatch, "No se localizó el ShadButton con data-testid.");
    assert.ok(
        /disabled=\{isReservingInternal\}/.test(tagMatch[0]),
        "El botón debe deshabilitarse mientras la reserva está en vuelo (previene doble submit).",
    );
});

test("ProductFormModal: el botón usa size='icon' + variant='outline' (contrato shadcn del pipeline)", async () => {
    const src = await leer(modal);
    const tagMatch = /<ShadButton[^>]*data-testid=["']btn-generate-internal-code["'][^>]*>/.exec(src);
    assert.ok(tagMatch, "No se localizó el ShadButton del código interno.");
    const openTag = tagMatch[0];
    assert.ok(/size=["']icon["']/.test(openTag), "El botón debe usar size='icon'.");
    assert.ok(/variant=["']outline["']/.test(openTag), "El botón debe usar variant='outline'.");
});

// ---------------------------------------------------------------------------
// 4. ProductFormModal — Alert destructivo con regenerar y cerrar aviso.
// ---------------------------------------------------------------------------

test("ProductFormModal: usa <Alert variant='destructive'> para errores de reserva", async () => {
    const src = await leer(modal);
    assert.ok(
        /<Alert[\s\S]*?variant=["']destructive["'][\s\S]*?data-testid=["']internal-code-error["']/.test(src),
        "El panel de error debe ser <Alert variant='destructive' data-testid='internal-code-error'>.",
    );
});

test("ProductFormModal: el Alert expone role='alert' + aria-live='assertive'", async () => {
    const src = await leer(modal);
    const alertMatch = /<Alert[\s\S]*?data-testid=["']internal-code-error["'][\s\S]*?>/.exec(src);
    assert.ok(alertMatch, "No se encontró el Alert de error de reserva.");
    const openTag = alertMatch[0];
    assert.ok(/role=["']alert["']/.test(openTag), "El Alert debe exponer role='alert'.");
    assert.ok(/aria-live=["']assertive["']/.test(openTag),
        "El Alert debe anunciarse con aria-live='assertive'.");
});

test("ProductFormModal: el Alert incluye botón 'Regenerar' y botón 'Cerrar aviso'", async () => {
    const src = await leer(modal);
    assert.ok(/aria-label=["']Regenerar código interno["']/.test(src),
        "El Alert debe tener botón 'Regenerar código interno'.");
    assert.ok(/aria-label=["']Cerrar aviso de error["']/.test(src),
        "El Alert debe tener botón 'Cerrar aviso de error'.");
});

test("ProductFormModal: Regenerar reusa el mismo callback (no bucle automático)", async () => {
    const src = await leer(modal);
    // El onClick del botón "Regenerar" dentro del Alert llama al mismo
    // handler que el botón principal. No hay auto-retry en catch.
    const handlerName = "handleGenerateInternalBarcode";
    const regenerateMatch = /aria-label=["']Regenerar código interno["'][\s\S]*?onClick=\{[\s\S]*?handleGenerateInternalBarcode\}/.exec(src);
    assert.ok(regenerateMatch, "El botón Regenerar debe llamar a handleGenerateInternalBarcode.");
    // Y nada de setTimeout/retry automático en el catch.
    assert.ok(
        !new RegExp(`catch[\\s\\S]*?setTimeout[\\s\\S]{0,120}${handlerName}`).test(src),
        "El catch del handler NO debe reintentar automáticamente (sin bucles).",
    );
});

// ---------------------------------------------------------------------------
// 5. ProductFormModal — contrato de props (source + onInternalBarcodeReserved).
// ---------------------------------------------------------------------------

test("ProductFormModal expone la prop internalBarcodeSource en su interfaz", async () => {
    const src = await leer(modal);
    assert.ok(
        /internalBarcodeSource\??:\s*['"]product_form['"][\s\S]{0,80}['"]reception['"]/.test(src),
        "Debe tener prop opcional internalBarcodeSource con union 'product_form' | 'reception' | ...",
    );
});

test("ProductFormModal expone la prop onInternalBarcodeReserved", async () => {
    const src = await leer(modal);
    assert.ok(
        /onInternalBarcodeReserved\??:\s*\(reservation:\s*InternalBarcodeReservation\)\s*=>\s*void/.test(src),
        "Debe tener prop opcional onInternalBarcodeReserved: (reservation: InternalBarcodeReservation) => void.",
    );
});

// ---------------------------------------------------------------------------
// 6. products/page.tsx — reutilización del LabelPrintSheet post-create.
// ---------------------------------------------------------------------------

test("products/page: importa LabelPrintSheet desde inventory/receive/components (reutilización)", async () => {
    const src = await leer(productsPage);
    assert.ok(
        /import\(['"]\.\.\/inventory\/receive\/components\/LabelPrintSheet['"]\)/.test(src),
        "products/page debe reutilizar el LabelPrintSheet existente de recepción.",
    );
});

test("products/page: importa isInternalBarcode del helper canónico", async () => {
    const src = await leer(productsPage);
    assert.ok(
        /from\s*['"]@\/lib\/internal-barcode\.mjs['"]/.test(src),
        "products/page debe depender del helper canónico.",
    );
});

test("products/page: abre el LabelPrintSheet SOLO después del POST exitoso (wasInternal)", async () => {
    const src = await leer(productsPage);
    // El patrón crítico: `apiFetch(...create-products...)` DEBE aparecer
    // antes de que `setInternalLabelSheet({ open: true, ...)` se invoque.
    const idxCreate = src.indexOf("/products/create-products");
    const idxOpenSheet = src.search(/setInternalLabelSheet\(\s*\{\s*(?:\n|\s)*open:\s*true/);
    assert.ok(idxCreate > 0, "Falta el POST a /products/create-products.");
    assert.ok(
        idxOpenSheet > 0,
        "Falta la apertura del LabelPrintSheet (setInternalLabelSheet con open:true).",
    );
    assert.ok(
        idxCreate < idxOpenSheet,
        "El LabelPrintSheet debe abrirse DESPUÉS del POST exitoso (contrato de gating).",
    );
    // Y el open:true debe estar guardado tras un `if (wasInternal)`.
    assert.ok(
        /if\s*\(wasInternal\)\s*\{[\s\S]*?setInternalLabelSheet\(\s*\{[\s\S]*?open:\s*true/.test(src),
        "La apertura del sheet debe estar dentro de `if (wasInternal) { ... }`.",
    );
});

test("products/page: pasa internalBarcodeSource='product_form' al ProductFormModal", async () => {
    const src = await leer(productsPage);
    assert.ok(
        /<ProductFormModal[\s\S]*?internalBarcodeSource=["']product_form["']/.test(src),
        "products/page debe declarar explícitamente el source product_form.",
    );
});

test("products/page: inyecta onInternalBarcodeReserved={setPendingInternalReservation}", async () => {
    const src = await leer(productsPage);
    assert.ok(
        /<ProductFormModal[\s\S]*?onInternalBarcodeReserved=\{setPendingInternalReservation\}/.test(src),
        "products/page debe guardar la reserva emitida por el modal.",
    );
});

// ---------------------------------------------------------------------------
// 7. inventory/receive/page.tsx — mismo contrato, source distinto.
// ---------------------------------------------------------------------------

test("receive/page: importa isInternalBarcode del helper canónico", async () => {
    const src = await leer(receivePage);
    assert.ok(
        /from\s*['"]@\/lib\/internal-barcode\.mjs['"]/.test(src),
        "receive/page debe depender del helper canónico.",
    );
});

test("receive/page: abre el labelSheetState SOLO después del POST exitoso (wasInternal)", async () => {
    const src = await leer(receivePage);
    const idxCreate = src.indexOf("/products/create-products");
    const idxOpenSheet = src.search(/if\s*\(wasInternal\)[\s\S]*?setLabelSheetState\(/);
    assert.ok(idxCreate > 0, "Falta el POST a /products/create-products en receive/page.");
    assert.ok(idxOpenSheet > 0, "Falta la apertura condicional del LabelSheetState.");
    assert.ok(
        idxCreate < idxOpenSheet,
        "El labelSheetState debe abrirse DESPUÉS del POST exitoso.",
    );
});

test("receive/page: pasa internalBarcodeSource='reception' al ProductFormModal", async () => {
    const src = await leer(receivePage);
    assert.ok(
        /<ProductFormModal[\s\S]*?internalBarcodeSource=["']reception["']/.test(src),
        "receive/page debe declarar explícitamente el source reception.",
    );
});

test("receive/page: inyecta onInternalBarcodeReserved={setPendingInternalReservation}", async () => {
    const src = await leer(receivePage);
    assert.ok(
        /<ProductFormModal[\s\S]*?onInternalBarcodeReserved=\{setPendingInternalReservation\}/.test(src),
        "receive/page debe guardar la reserva emitida por el modal.",
    );
});

// ---------------------------------------------------------------------------
// 8. GATING: ninguna de las dos páginas llama a /labels/codes o
//    /labels/print-jobs en handleAddProduct / handleCreateProduct.
//    (Esos endpoints los llama exclusivamente el LabelPrintSheet, DESPUÉS
//    del create OK.)
// ---------------------------------------------------------------------------

test("products/page: no toca /labels/codes ni /labels/print-jobs fuera del LabelPrintSheet", async () => {
    const src = await leer(productsPage);
    // El archivo NO debe hacer POST directo a esos endpoints. Puede
    // referenciarlos como string si estuvieran en comentarios, pero no
    // debe ser el método del fetch.
    assert.ok(
        !/apiFetch[\s\S]{0,120}\/labels\/codes/.test(src),
        "products/page no debe apiFetch directamente /labels/codes.",
    );
    assert.ok(
        !/apiFetch[\s\S]{0,120}\/labels\/print-jobs/.test(src),
        "products/page no debe apiFetch directamente /labels/print-jobs.",
    );
});

// ---------------------------------------------------------------------------
// 9. Helper: la constante del prefijo no se duplica en los archivos consumidores.
// ---------------------------------------------------------------------------

test("Ningún archivo consumidor inlinea 'POSINT-' (fuente única: helper)", async () => {
    const files = [modal, productsPage, receivePage];
    for (const file of files) {
        const src = stripComments(await leer(file));
        assert.ok(
            !/["']POSINT-/.test(src),
            `${file} inlinea el literal 'POSINT-'. Debe usar helpers de internal-barcode.mjs.`,
        );
    }
});
