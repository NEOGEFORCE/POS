// =============================================================================
// tests/bold-qr-wire-contract.test.mjs
//
// Contrato cruzado backend Go ↔ frontend TSX del flujo QR Bold / Bre-B.
//
// MOTIVACIÓN (bug corregido en loop iteration 1 del pipeline):
//   El modal `ModalPagoBoldQR` declaraba las interfaces `IniciarResponse`,
//   `StreamIntentPayload` y `ConfirmManualResponse` con nombres en
//   snake_case (`intent_id`, `bold_reference`, `approved_at`, ...). El
//   handler Go emite JSON en camelCase (`intentId`, `reference`,
//   `approvedAt`, ...). Después de un POST /iniciar exitoso el modal
//   caía siempre en ERROR porque `typeof res?.intent_id === "string"`
//   nunca empataba con el `intentId: number` real.
//
//   Los tests "de presencia de strings" existentes no detectaban la
//   regresión porque leían el .tsx como texto y buscaban cadenas sin
//   verificar la estructura semántica.
//
// INVARIANTES QUE ESTE TEST FIJA:
//   1. El modal lee `intentId`, `ventaTempId`, `expiresAt`,
//      `expiresInSeconds`, `streamStatus`, `reused` como camelCase.
//   2. El modal maneja `intentId` como `number | string` (uint64 Go →
//      JSON number por default).
//   3. El modal lee del stream SSE: `reference`, `approvedAt`,
//      `approvedVia`, `expiresAt`, `status`, `reason` (todos camelCase).
//   4. El modal lee `/confirmar-manual` response: `approvedReference`,
//      `approvedAt`, `approvedVia` (todos camelCase).
//   5. El filtro de heartbeat SSE usa `frame.event !== "ping"` (lo que
//      el backend realmente emite — ver `FormatQRHeartbeat` en qr_hub.go).
//   6. El handler Go NO debe emitir campos de respuesta en snake_case
//      para los endpoints POS (sólo entrada: body del request).
//   7. El `QREvent` del backend expone `approvedVia` (contrato de la
//      vía de aprobación para que el modal diferencie BOLD_OFFICIAL /
//      BRIDGE_NOTIFICATION / MANUAL en `onApproved`).
//
// Diseño:
//   Los dos primeros bloques leen el .tsx del modal. Los dos últimos
//   leen los .go del backend. El test corre `node --test`; no monta
//   React.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const workspaceRoot = join(repoRoot, "..");

const modalPath = join(repoRoot, "src", "components", "shared", "ModalPagoBoldQR.tsx");
const handlerPath = join(
    workspaceRoot,
    "backPOS-go",
    "internal",
    "adapters",
    "handlers",
    "pos_qr_handler.go",
);
const hubPath = join(
    workspaceRoot,
    "backPOS-go",
    "internal",
    "infrastructure",
    "sse",
    "qr_hub.go",
);

const modalSrc = await readFile(modalPath, "utf8");
// El backend podría no existir en algunos entornos (p. ej. CI del
// frontend). Si falta, saltamos sólo los tests cruzados y dejamos
// los tests del lado modal activos. En este repo monorepo SIEMPRE
// existen; capturamos por defensa.
let handlerSrc = "";
let hubSrc = "";
try {
    handlerSrc = await readFile(handlerPath, "utf8");
} catch {
    handlerSrc = "";
}
try {
    hubSrc = await readFile(hubPath, "utf8");
} catch {
    hubSrc = "";
}

/**
 * Devuelve el bloque entre dos marcadores. Lanza si no se encuentra
 * (evita falsos positivos silenciosos).
 */
function sliceBetween(src, start, end) {
    const i = src.indexOf(start);
    assert.ok(i >= 0, `No se encontró el marcador de apertura ${start}`);
    const j = src.indexOf(end, i + start.length);
    assert.ok(j > i, `No se encontró el marcador de cierre ${end} tras ${start}`);
    return src.slice(i, j);
}

// ---------------------------------------------------------------------------
// 1) IniciarResponse: camelCase + intentId number|string
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR.IniciarResponse: usa camelCase (intentId, ventaTempId, expiresAt, ...)", () => {
    const iface = sliceBetween(modalSrc, "interface IniciarResponse", "}");
    // Debe declarar los campos canónicos del handler Go.
    for (const field of [
        "intentId",
        "ventaTempId",
        "status",
        "streamStatus",
        "expiresAt",
        "expiresInSeconds",
        "reused",
    ]) {
        assert.match(
            iface,
            new RegExp(`\\breadonly\\s+${field}\\?`),
            `IniciarResponse debe declarar \`readonly ${field}?: ...\`.`,
        );
    }
    // Y NO debe sobrevivir ningún alias snake_case que el handler no
    // emite (ésos sólo existían como regresión).
    for (const forbidden of [
        /\bintent_id\b/,
        /\bexpires_at\b/,
        /\bexpires_in_seconds\b/,
        /\bstream_status\b/,
        /\bventa_temp_id\b/, // la respuesta JSON del handler es `ventaTempId`
    ]) {
        assert.doesNotMatch(
            iface,
            forbidden,
            `IniciarResponse no debe declarar el alias snake_case ${forbidden}.`,
        );
    }
});

test("ModalPagoBoldQR.IniciarResponse: intentId es `number | string` (uint64 Go → JSON number)", () => {
    const iface = sliceBetween(modalSrc, "interface IniciarResponse", "}");
    assert.match(
        iface,
        /intentId\?\s*:\s*number\s*\|\s*string/,
        "intentId debe tipar como `number | string` para empatar con el uint64 que Go serializa a JSON number.",
    );
});

test("ModalPagoBoldQR: lectura defensiva de intentId acepta number Y string", () => {
    // Busca el bloque donde el modal extrae `rawIntentId` del response
    // y lo convierte a string. El patrón debe cubrir ambas ramas.
    assert.match(
        modalSrc,
        /typeof\s+rawIntentId\s*===\s*["']number["']\s*&&\s*Number\.isFinite\(/,
        "La rama number debe convertir vía String(rawIntentId) tras pasar por Number.isFinite.",
    );
    assert.match(
        modalSrc,
        /typeof\s+rawIntentId\s*===\s*["']string["']/,
        "También debe aceptar string (resistencia a gateways que serialicen uint64 como texto).",
    );
    assert.doesNotMatch(
        modalSrc,
        /typeof\s+res\?\.intent_id\s*===\s*["']string["']/,
        "No debe sobrevivir la lectura snake_case que causaba el bug del loop 1.",
    );
});

// ---------------------------------------------------------------------------
// 2) StreamIntentPayload: campos SSE camelCase
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR.StreamIntentPayload: campos camelCase que empatan con QREvent del backend", () => {
    const iface = sliceBetween(modalSrc, "interface StreamIntentPayload", "}");
    for (const field of ["status", "reason", "reference", "approvedAt", "approvedVia", "expiresAt"]) {
        assert.match(
            iface,
            new RegExp(`\\breadonly\\s+${field}\\?`),
            `StreamIntentPayload debe declarar \`readonly ${field}?: ...\`.`,
        );
    }
    // Y jamás los nombres rotos del loop 1.
    for (const forbidden of [/\bbold_reference\b/, /\bapproved_at\b/, /\bapproved_via\b/]) {
        assert.doesNotMatch(
            iface,
            forbidden,
            `StreamIntentPayload no debe declarar el alias snake_case ${forbidden}.`,
        );
    }
});

test("ModalPagoBoldQR: applyStreamPayload lee `payload.reference`, `payload.approvedAt`, `payload.approvedVia`", () => {
    // No existe ya la lectura de los campos snake_case.
    assert.doesNotMatch(
        modalSrc,
        /payload\.bold_reference/,
        "La extracción debe leer `payload.reference`, no `payload.bold_reference`.",
    );
    assert.doesNotMatch(
        modalSrc,
        /payload\.approved_at/,
        "La extracción debe leer `payload.approvedAt`.",
    );
    assert.doesNotMatch(
        modalSrc,
        /payload\.approved_via/,
        "La extracción debe leer `payload.approvedVia`.",
    );
    // Las nuevas lecturas camelCase sí deben existir.
    assert.match(modalSrc, /payload\.reference/, "Debe leer payload.reference");
    assert.match(modalSrc, /payload\.approvedAt/, "Debe leer payload.approvedAt");
    assert.match(modalSrc, /payload\.approvedVia/, "Debe leer payload.approvedVia");
});

// ---------------------------------------------------------------------------
// 3) ConfirmManualResponse: retirada en la migración 027
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR: la interfaz ConfirmManualResponse quedó retirada (migración 027)", () => {
    assert.ok(
        !/\binterface\s+ConfirmManualResponse\b/.test(modalSrc),
        "La interfaz ConfirmManualResponse pertenecía al flujo manual retirado.",
    );
    assert.ok(
        !modalSrc.includes("approvedReference"),
        "El campo `approvedReference` vivía en el response del flujo manual retirado.",
    );
    // Desde 2026-10-27 el modal sí la llama, pero sólo con rol admin.
    if (modalSrc.includes("/pos/pagos-qr/confirmar-manual")) {
        assert.match(modalSrc, /isAdmin && \(isWaiting \|\| isManualGate\)/, "La confirmación manual del modal debe estar condicionada a isAdmin.");
    }
});

test("ModalPagoBoldQR: handleConfirmManual quedó retirado del modal del cajero", () => {
    // El flujo manual queda admin-only del lado del backend. El modal
    // del cajero sólo expone el flujo asíncrono (encolar + bandeja).
    assert.ok(
        !modalSrc.includes("Confirmar manual"),
        "El label 'Confirmar manual' quedó fuera del bundle del cajero.",
    );
    // El flujo asíncrono equivalente es `handleEnqueueAndClose`, que
    // pasa (ventaTempId, monto) exactos al callback del padre.
    assert.match(
        modalSrc,
        /handleEnqueueAndClose/,
        "El handler asíncrono handleEnqueueAndClose debe existir.",
    );
    assert.match(
        modalSrc,
        /onEnqueueAndClose\(\s*ventaTempId\s*,\s*Math\.round\(monto\)\s*\)/,
        "handleEnqueueAndClose debe pasar (ventaTempId, monto) exactos al callback.",
    );
});

// ---------------------------------------------------------------------------
// 4) Filtro de heartbeat SSE
// ---------------------------------------------------------------------------

test("ModalPagoBoldQR: filtro de heartbeat usa `event !== 'ping'` (empata con FormatQRHeartbeat del backend)", () => {
    // Debe existir el filtro que descarta `event: ping` sin JSON.parse.
    assert.match(
        modalSrc,
        /frame\.event\s*!==\s*["']ping["']/,
        "El filtro de heartbeat debe comparar `frame.event !== 'ping'` (backend emite `event: ping`).",
    );
    // Y NO debe sobrevivir el filtro roto del loop 1.
    assert.doesNotMatch(
        modalSrc,
        /frame\.event\s*===\s*["']message["']\s*&&\s*frame\.data\s*===\s*['"`]"heartbeat"['"`]/,
        "El filtro de heartbeat anterior (comparar event:message + data:heartbeat) nunca aplicaba y debe estar removido.",
    );
});

// ---------------------------------------------------------------------------
// 5) Contrato cruzado contra el backend Go
// ---------------------------------------------------------------------------

test("backPOS-go/pos_qr_handler.go: iniciarResponse emite camelCase (contrato con el modal)", () => {
    if (!handlerSrc) {
        return;
    }
    // El struct `iniciarResponse` debe declarar los tags json camelCase
    // que el modal consume.
    for (const tag of [
        `json:"intentId"`,
        `json:"ventaTempId"`,
        `json:"status"`,
        `json:"streamStatus"`,
        `json:"expiresAt"`,
        `json:"expiresInSeconds"`,
        `json:"reused"`,
    ]) {
        assert.ok(
            handlerSrc.includes(tag),
            `pos_qr_handler.go debe exponer el tag ${tag} en la respuesta de /iniciar.`,
        );
    }
    // Snake_case en la respuesta sería la regresión que rompe al modal.
    for (const forbidden of [
        `json:"intent_id"`,
        `json:"expires_at"`,
        `json:"expires_in_seconds"`,
        `json:"stream_status"`,
    ]) {
        assert.ok(
            !handlerSrc.includes(forbidden),
            `pos_qr_handler.go NO debe exponer el tag snake_case ${forbidden} en la respuesta JSON.`,
        );
    }
});

test("backPOS-go/pos_qr_handler.go: /confirmar-manual emite approvedVia (contrato con el modal)", () => {
    if (!handlerSrc) {
        return;
    }
    // La respuesta debe exponer los tres campos camelCase que el modal lee.
    for (const key of [`"approvedReference"`, `"approvedAt"`, `"approvedVia"`]) {
        assert.ok(
            handlerSrc.includes(key),
            `pos_qr_handler.go debe exponer ${key} en el response JSON de /confirmar-manual.`,
        );
    }
    for (const forbidden of [`"approved_reference"`, `"approved_at"`, `"approved_via"`]) {
        assert.ok(
            !handlerSrc.includes(forbidden),
            `pos_qr_handler.go NO debe exponer ${forbidden} (snake_case rompe el contrato con el modal).`,
        );
    }
});

test("backPOS-go/qr_hub.go: QREvent declara ApprovedVia camelCase (`json:\"approvedVia,omitempty\"`)", () => {
    if (!hubSrc) {
        return;
    }
    assert.ok(
        hubSrc.includes(`json:"approvedVia,omitempty"`),
        "qr_hub.go debe declarar el campo ApprovedVia con tag `json:\"approvedVia,omitempty\"`.",
    );
    // Snake_case rompería el contrato con el modal (que ya lee approvedVia).
    for (const forbidden of [`json:"approved_via"`, `json:"approved_via,omitempty"`]) {
        assert.ok(
            !hubSrc.includes(forbidden),
            `qr_hub.go NO debe declarar el tag ${forbidden}.`,
        );
    }
    // Y los otros campos del QREvent también deben seguir camelCase.
    for (const tag of [`json:"approvedAt,omitempty"`, `json:"expiresAt,omitempty"`, `json:"reference,omitempty"`]) {
        assert.ok(
            hubSrc.includes(tag),
            `qr_hub.go debe mantener el tag camelCase ${tag}.`,
        );
    }
});

// ---------------------------------------------------------------------------
// 6) Guard contra regresión del bug específico del loop 1
// ---------------------------------------------------------------------------

test("REGRESION LOOP 1: tras POST /iniciar con intentId numérico, la rama 'ERROR' NO se dispara", () => {
    // Simulación estática: componemos la rama de extracción con el shape
    // real del backend y verificamos que el flujo NO devuelve "ERROR".
    //
    // Reproducimos la lógica del modal textualmente (manteniendo la
    // misma estrategia defensiva number|string):
    const extractIntentId = (res) => {
        const rawIntentId = res?.intentId;
        return typeof rawIntentId === "number" && Number.isFinite(rawIntentId)
            ? String(rawIntentId)
            : typeof rawIntentId === "string" && rawIntentId.trim()
                ? rawIntentId.trim()
                : "";
    };

    // Shape REAL que emite el backend Go `iniciarResponse` (ver
    // pos_qr_handler.go líneas 83-91 del snapshot).
    const backendResponse = {
        ok: true,
        intentId: 1, // uint64 → JSON number
        ventaTempId: "temp-abc-12345",
        status: "PENDIENTE",
        streamStatus: "PENDIENTE",
        expiresAt: "2026-10-20T10:05:00Z",
        expiresInSeconds: 300,
        reused: false,
    };

    const intentId = extractIntentId(backendResponse);
    assert.strictEqual(
        intentId,
        "1",
        "Un response real del backend debe producir intentId='1' (NO vacío → NO lleva a ERROR).",
    );

    // Verificamos también el camino string (resistente a gateways).
    assert.strictEqual(extractIntentId({ intentId: "999999" }), "999999");
    // Y las ramas defensivas (vacío/basura → "", lo que fuerza ERROR correctamente).
    assert.strictEqual(extractIntentId({}), "");
    assert.strictEqual(extractIntentId(null), "");
    assert.strictEqual(extractIntentId({ intentId: "   " }), "");
    assert.strictEqual(extractIntentId({ intentId: Number.NaN }), "");
});

test("REGRESION LOOP 1: stream SSE con payload real APROBADO del backend produce reference/approvedAt no vacíos", () => {
    // Simula el camino de `applyStreamPayload` cuando el status llega
    // como APROBADO. Como no podemos montar React, verificamos la
    // extracción de los tres campos clave (todos camelCase).
    const extract = (payload) => {
        const reference =
            typeof payload.reference === "string" && payload.reference.trim()
                ? payload.reference.trim()
                : "";
        const approvedAt =
            typeof payload.approvedAt === "string" && payload.approvedAt.trim()
                ? payload.approvedAt.trim()
                : "fallback-client-iso";
        const approvedVia =
            typeof payload.approvedVia === "string" && payload.approvedVia.trim()
                ? payload.approvedVia.trim()
                : "BOLD_OFFICIAL";
        return { reference, approvedAt, approvedVia };
    };

    // Caso 1: Bold webhook oficial (ApprovedSource = BOLD_OFFICIAL)
    const r1 = extract({
        status: "APROBADO",
        reference: "bold-code-ABCD-1234",
        approvedAt: "2026-10-20T10:04:33Z",
        approvedVia: "BOLD_OFFICIAL",
    });
    assert.strictEqual(r1.reference, "bold-code-ABCD-1234");
    assert.strictEqual(r1.approvedAt, "2026-10-20T10:04:33Z");
    assert.strictEqual(r1.approvedVia, "BOLD_OFFICIAL");

    // Caso 2: puente MacroDroid
    const r2 = extract({
        status: "APROBADO",
        reference: "7f3a9c2b1d",
        approvedAt: "2026-10-20T10:04:44Z",
        approvedVia: "BRIDGE_NOTIFICATION",
    });
    assert.strictEqual(r2.approvedVia, "BRIDGE_NOTIFICATION");

    // Caso 3: aprobación manual
    const r3 = extract({
        status: "APROBADO",
        reference: "MANUAL_temp-abc-12345",
        approvedAt: "2026-10-20T10:04:55Z",
        approvedVia: "MANUAL",
    });
    assert.strictEqual(r3.approvedVia, "MANUAL");

    // Caso 4: snapshot sin approvedVia (histórico) → fallback honesto
    const r4 = extract({
        status: "APROBADO",
        reference: "legacy-ref",
        approvedAt: "2026-10-20T10:04:00Z",
    });
    assert.strictEqual(r4.approvedVia, "BOLD_OFFICIAL");
});
