// =============================================================================
// tests/bold-qr-pagos-sin-asignar-ui.test.mjs
//
// Guardianes ESTÁTICOS (lectura de fuente) para el flujo de pagos sin
// asignar + anuncio por voz + alert sameAmountPending (migración 027b).
//
// Cubre:
//
//   U1. `useBoldQrTray` pega a GET /pos/pagos-qr/pagos-sin-asignar?minutos=
//       autenticado por Bearer, parsea con `classifyUnassignedPayment`,
//       expone `unassignedPayments` + `assignPaymentToIntent`.
//   U2. `assignPaymentToIntent` hace POST /pos/pagos-qr/asignar y
//       refresca ambas listas tras el 200.
//   U3. El polling cada 20 s se activa SÓLO si hay pendings o pagos
//       sin asignar (no spamea cuando la bandeja está vacía).
//   U4. `BoldQrTrayPopover` renderiza una sección "Pagos por asignar"
//       con el botón "Asignar a este cobro" para cada pending del
//       mismo monto, y el AlertDialog shadcn de confirmación.
//   U5. El contador del trigger suma pendientes + pagos por asignar; el
//       badge ámbar aparece sólo cuando hay pagos por asignar.
//   U6. `ModalPagoBoldQR` muestra Alert compacto cuando el `/iniciar`
//       devuelve `sameAmountPending > 0`, sin bloquear el flujo.
//   U7. `sales/new/page.tsx` dispara `speechSynthesis.speak` dentro de
//       `notifyBoldQrApprovedOnce`, honrando `isSoundMuted()`; el
//       AlertDialog usa el título "TRANSFERENCIA RECIBIDA".
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const useBoldQrTrayPath = join(repoRoot, "src", "app", "(app)", "sales", "new", "hooks", "useBoldQrTray.ts");
const trayPopoverPath = join(repoRoot, "src", "app", "(app)", "sales", "new", "components", "BoldQrTrayPopover.tsx");
const salesNewPagePath = join(repoRoot, "src", "app", "(app)", "sales", "new", "page.tsx");
const modalPath = join(repoRoot, "src", "components", "shared", "ModalPagoBoldQR.tsx");

async function readSrc(path) {
    return readFile(path, "utf8");
}

async function readWithoutComments(path) {
    const raw = await readFile(path, "utf8");
    return raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// U1 — useBoldQrTray hits /pagos-sin-asignar
// ---------------------------------------------------------------------------

test("U1 useBoldQrTray: GET /pos/pagos-qr/pagos-sin-asignar?minutos=... autenticado", async () => {
    const src = await readSrc(useBoldQrTrayPath);
    assert.match(
        src,
        /\/pos\/pagos-qr\/pagos-sin-asignar\?minutos=/,
        "Debe pegar al endpoint con el parámetro minutos.",
    );
    assert.match(
        src,
        /classifyUnassignedPayment/,
        "Debe parsear la respuesta via classifyUnassignedPayment (fuente única).",
    );
    assert.match(
        src,
        /unassignedPayments/,
        "El hook debe exponer unassignedPayments en su API pública.",
    );
    // Nunca token en query string
    const runtime = await readWithoutComments(useBoldQrTrayPath);
    assert.doesNotMatch(
        runtime,
        /pagos-sin-asignar[^"'`\n]*token=/,
        "El token no debe viajar por query en /pagos-sin-asignar.",
    );
});

// ---------------------------------------------------------------------------
// U2 — assignPaymentToIntent POST /asignar y refresca listas
// ---------------------------------------------------------------------------

test("U2 useBoldQrTray.assignPaymentToIntent: POST /pos/pagos-qr/asignar y refresca ambas listas", async () => {
    const src = await readSrc(useBoldQrTrayPath);
    assert.match(
        src,
        /apiFetch\(\s*["']\/pos\/pagos-qr\/asignar["']/,
        "Debe POST al endpoint canónico /pos/pagos-qr/asignar.",
    );
    assert.match(
        src,
        /buildAsignarPayload/,
        "Debe construir el body via buildAsignarPayload (snake_case).",
    );
    // Tras el 200 debe refrescar ambas listas (bandeja + sin asignar).
    const idx = src.indexOf("const assignPaymentToIntent");
    assert.ok(idx > 0, "assignPaymentToIntent debe existir.");
    // El useCallback cierra con `[token, reload, reloadUnassigned]`.
    const end = src.indexOf("[token, reload, reloadUnassigned]", idx);
    assert.ok(end > idx, "El array de deps del useCallback debe estar presente.");
    const body = src.slice(idx, end);
    assert.match(
        body,
        /\breload\s*\(\s*\)/,
        "Tras el 200 debe refrescar la lista de pendings.",
    );
    assert.match(
        body,
        /\breloadUnassigned\s*\(\s*\)/,
        "Tras el 200 debe refrescar la lista de pagos sin asignar.",
    );
});

// ---------------------------------------------------------------------------
// U3 — polling cada 20s solo si hay actividad
// ---------------------------------------------------------------------------

test("U3 useBoldQrTray: polling cada 20s SÓLO si hay pendings o pagos sin asignar", async () => {
    const src = await readSrc(useBoldQrTrayPath);
    assert.match(
        src,
        /DEFAULT_POLL_INTERVAL_MS\s*=\s*20_?000/,
        "El intervalo por defecto debe ser 20 s.",
    );
    assert.match(
        src,
        /hasActivity\s*=\s*pendings\.length\s*>\s*0\s*\|\|\s*unassignedPayments\.length\s*>\s*0/,
        "La guarda hasActivity debe ser el OR de ambas listas.",
    );
    assert.match(
        src,
        /if\s*\(!hasActivity\)\s*return;/,
        "El efecto no debe polear cuando la bandeja está vacía.",
    );
});

// ---------------------------------------------------------------------------
// U4 — BoldQrTrayPopover muestra la sección y el botón "Asignar a este cobro"
// ---------------------------------------------------------------------------

test("U4 BoldQrTrayPopover: sección 'Pagos por asignar' con AlertDialog shadcn + botón 'Asignar a este cobro'", async () => {
    const src = await readSrc(trayPopoverPath);
    assert.match(
        src,
        /from\s+["']@\/components\/ui\/alert-dialog["']/,
        "Debe importar AlertDialog de shadcn.",
    );
    assert.match(src, /Pagos por asignar/i,
        "Debe contener el título visible 'Pagos por asignar'.");
    assert.match(
        src,
        /canAssignToPending/,
        "Debe decidir si pintar el botón vía canAssignToPending (nunca inventa).",
    );
    assert.match(src, /Asignar a este cobro/i,
        "Debe exponer el copy exacto 'Asignar a este cobro'.");
    assert.match(src, /data-testid="bold-qr-assign-button"/,
        "El botón debe exponer un testid semántico.");
    assert.match(src, /data-testid="bold-qr-assign-confirm-dialog"/,
        "El AlertDialog de confirmación debe exponer un testid.");
    assert.match(
        src,
        /describeAssignErrorCode/,
        "Debe traducir el code del error al toast.",
    );
    assert.match(
        src,
        /extractAssignErrorCode/,
        "Debe extraer el code del error antes de describirlo.",
    );
});

test("U4b BoldQrTrayPopover: respeta FRONTEND_LAYOUT_RULES en la lista interna", async () => {
    const src = await readSrc(trayPopoverPath);
    assert.match(
        src,
        /flex-1\s+min-h-0\s+overflow-auto\s+overscroll-contain/,
        "El scroller del popover debe cumplir la regla de resorte.",
    );
});

// ---------------------------------------------------------------------------
// U5 — Contador del trigger refleja pendings + pagos por asignar; badge ámbar
// ---------------------------------------------------------------------------

test("U5 BoldQrTrayPopover: badge ámbar sólo cuando hay pagos por asignar", async () => {
    const src = await readSrc(trayPopoverPath);
    assert.match(
        src,
        /const\s+total\s*=\s*totalPending\s*\+\s*totalUnassigned/,
        "El contador del trigger debe sumar pendientes + sin asignar.",
    );
    assert.match(
        src,
        /data-testid="bold-qr-tray-unassigned-badge"/,
        "El badge de pagos por asignar debe exponer testid.",
    );
    assert.match(
        src,
        /bg-amber-500/,
        "El badge de pagos por asignar debe ser ámbar.",
    );
});

// ---------------------------------------------------------------------------
// U6 — ModalPagoBoldQR muestra Alert compacto cuando sameAmountPending > 0
// ---------------------------------------------------------------------------

test("U6 ModalPagoBoldQR: Alert compacto cuando /iniciar devuelve sameAmountPending > 0", async () => {
    const src = await readSrc(modalPath);
    assert.match(
        src,
        /sameAmountPending/,
        "La interfaz IniciarResponse y el estado deben nombrar sameAmountPending.",
    );
    assert.match(
        src,
        /data-testid="bold-qr-same-amount-pending-alert"/,
        "El Alert debe exponer un testid dedicado.",
    );
    // Copy canónico del sprint
    assert.match(
        src,
        /Hay otro cobro QR de \$\{formatCurrency\(monto\)\} en espera\./,
        "El copy exacto del Alert debe estar presente.",
    );
    assert.match(
        src,
        /asigna el pago en la bandeja QR en espera/,
        "El copy del Alert debe cerrar con la instrucción al cajero.",
    );
    // Debe respetar max-h-full del envelope del modal (sin romper scroll).
    assert.match(
        src,
        /max-h-full/,
        "El modal debe conservar `max-h-full` en su envelope (regla de layout).",
    );
});

test("U6b ModalPagoBoldQR: el Alert no bloquea el botón primario", async () => {
    const src = await readSrc(modalPath);
    // El `disabled` del botón primario NO debe tener en cuenta
    // sameAmountPending — es un aviso, no un bloqueo.
    const idx = src.indexOf("onClick={handleEnqueueAndClose}");
    assert.ok(idx > 0, "El botón primario debe existir.");
    const scope = src.slice(idx, idx + 500);
    assert.ok(
        !/disabled=\{[^}]*sameAmountPending[^}]*\}/.test(scope),
        "El botón primario NO debe deshabilitarse por sameAmountPending (es aviso, no bloqueo).",
    );
});

// ---------------------------------------------------------------------------
// U7 — Voice announcement en sales/new/page.tsx + título canónico
// ---------------------------------------------------------------------------

test("U7 sales/new/page.tsx: AlertDialog usa título 'TRANSFERENCIA RECIBIDA'", async () => {
    const src = await readSrc(salesNewPagePath);
    assert.match(
        src,
        /TRANSFERENCIA RECIBIDA/,
        "El AlertDialog shadcn debe tener como título 'TRANSFERENCIA RECIBIDA'.",
    );
    // No debe sobrevivir el copy anterior.
    const runtime = await readWithoutComments(salesNewPagePath);
    assert.ok(
        !runtime.includes("¡Pago QR aprobado!"),
        "El copy anterior '¡Pago QR aprobado!' debe estar fuera del runtime.",
    );
});

test("U7b sales/new/page.tsx: notifyBoldQrApprovedOnce usa speechSynthesis + isSoundMuted", async () => {
    const src = await readSrc(salesNewPagePath);
    // Imports obligatorios
    assert.match(
        src,
        /from\s+['"]@\/lib\/bold-qr-voice\.mjs['"]/,
        "Debe importar helpers desde src/lib/bold-qr-voice.mjs.",
    );
    assert.match(
        src,
        /\bbuildVoiceAnnouncement\b/,
        "Debe usar el helper puro buildVoiceAnnouncement.",
    );
    assert.match(
        src,
        /isSpeechSynthesisSupported/,
        "Debe comprobar soporte Web Speech API con el helper puro.",
    );
    assert.match(
        src,
        /pickSpanishVoice/,
        "Debe seleccionar voz hispana con pickSpanishVoice.",
    );
    assert.match(
        src,
        /\bisSoundMuted\b/,
        "Debe importar isSoundMuted de audio-utils.",
    );
    assert.match(
        src,
        /window\.speechSynthesis/,
        "Debe invocar window.speechSynthesis.",
    );
    assert.match(
        src,
        /new\s+window\.SpeechSynthesisUtterance\(/,
        "Debe instanciar SpeechSynthesisUtterance con la frase.",
    );
    // El mute global tiene prioridad: ni chime ni voz cuando está muteado.
    const idx = src.indexOf("const notifyBoldQrApprovedOnce");
    assert.ok(idx > 0, "notifyBoldQrApprovedOnce debe existir.");
    const end = src.indexOf("}, [", idx);
    const body = src.slice(idx, end > idx ? end : idx + 5000);
    assert.match(
        body,
        /if\s*\(!muted\)/,
        "El mute global debe gate chime + voz.",
    );
    assert.match(
        body,
        /BOLD_QR_VOICE_PREFERRED_LANG/,
        "El utterance debe fijar lang = es-CO (via constante).",
    );
});

test("U7c sales/new/page.tsx: fallback a solo chime si speechSynthesis no existe", async () => {
    const src = await readSrc(salesNewPagePath);
    const idx = src.indexOf("const notifyBoldQrApprovedOnce");
    const end = src.indexOf("}, [", idx);
    const body = src.slice(idx, end > idx ? end : idx + 5000);
    // El `isSpeechSynthesisSupported` gatekeepa la rama de voz: si
    // falla, el chime igual se dispara antes (fuera del `if`).
    const chimeIdx = body.indexOf("playNotificationSound('success')");
    const supportIdx = body.indexOf("isSpeechSynthesisSupported(");
    assert.ok(chimeIdx > 0, "El chime debe estar presente.");
    assert.ok(supportIdx > 0, "El guard de speechSynthesis debe estar presente.");
    assert.ok(
        chimeIdx < supportIdx,
        "El chime debe dispararse ANTES del guard de speechSynthesis (fallback honesto).",
    );
});

// ---------------------------------------------------------------------------
// U8 — El popover wiring en sales/new/page.tsx recibe las nuevas props
// ---------------------------------------------------------------------------

test("U8 sales/new/page.tsx: BoldQrTrayPopover recibe unassignedPayments + onAssign + onReloadUnassigned", async () => {
    const src = await readSrc(salesNewPagePath);
    const idx = src.indexOf("<BoldQrTrayPopover");
    assert.ok(idx > 0, "BoldQrTrayPopover debe renderizarse en el toolbar.");
    const close = src.indexOf("/>", idx);
    const block = src.slice(idx, close);
    for (const prop of [
        "pendings={",
        "unassignedPayments={",
        "latestError={",
        "latestUnassignedError={",
        "onReopen={",
        "onDismiss={",
        "onReconnect={",
        "onReloadUnassigned={",
        "onAssign={",
    ]) {
        assert.ok(
            block.includes(prop),
            `BoldQrTrayPopover debe recibir la prop ${prop}`,
        );
    }
});
