// =============================================================================
// label-generator.js
//
// Generador NATIVO y modular de etiquetas térmicas para el scale-bridge.
//
// Objetivos de diseño (bridge-printing-v2):
//
//   * Lógica 100% pura y testeable: no abre sockets, no spawnea procesos,
//     ninguna dependencia nueva. Todo lo que depende de hardware vive en
//     `print-transports.js`.
//
//   * Honrar el diccionario que ya envía el frontend
//     (`FrontPOS-main/src/lib/printing-config.mjs > labels`):
//       - dpi (default 203)
//       - widthMm, heightMm
//       - columns (1 ó 2)
//       - horizontalGapMm (sólo tiene efecto cuando columns=2)
//       - sensor.gapMm → GAP VERTICAL del rollo
//       - marginLeftMm (BC: default 0 cuando no viene en configs antiguas)
//       - layout.name / layout.price / layout.barcode con posición
//         (xMm, yMm), font (TSPL built-in "1".."8") y fontScale (0.5..4).
//         SHAPE CANÓNICO frontend: usamos esas keys como fuente de verdad.
//         Alias históricos aceptados por retrocompat: `layout.productName`
//         y `layout.salePrice` (shape viejo). Si vienen ambos, gana el
//         canónico.
//       - barcode.humanReadable → HRI (dígitos legibles)
//       - barcode.rotation      → 0 / 90 / 180 / 270 grados
//       - barcode.narrow        → ancho de módulo "narrow" en dots
//       - barcode.wide          → ancho de módulo "wide" en dots
//       - barcode.heightMm      → alto del símbolo
//       - barcode.symbology     → "CODE128" | "EAN13"
//
//   * Matemática de columnas en dots:
//       x_col(i) = marginLeftDots + i * (labelWidthDots + horizontalGapDots)
//     Validamos que el ancho total (margen + columnas + gaps) ≤
//     `printableWidthMm` o `PHYSICAL_MAX_MM` (82mm para la Jaltech
//     JAL-838L, techo físico más amplio que soportamos).
//
//   * TSPL emitido:
//       - SIZE = ancho TOTAL del medio (no sólo etiqueta individual en
//         2 columnas), GAP vertical = sensor.gapMm.
//       - CLS por fila → TEXT/BARCODE con offsets correctos para 1 ó 2
//         columnas → PRINT 1,1 (una fila por "página" física, cantidades
//         ya aplanadas por el llamador).
//       - BARCODE "128" y "EAN13" con el comando canónico:
//           BARCODE X,Y,"128"|"EAN13",heightDots,hri,rotation,narrow,wide,"data"
//         `hri` viene de `labels.barcode.humanReadable`, `rotation` de
//         `labels.barcode.rotation`, `narrow`/`wide` de los campos homónimos.
//
//   * Escapes: todo texto embebido se pasa por `escapeFn` (típicamente
//     `escapeForTspl` del `printer-bridge.js`) que ya filtra non-ASCII,
//     comillas y backslashes.
//
// Nada aquí es específico a la Jaltech JAL-838L: el preset vive sólo en
// `buildTestPageLabel` del bridge y como constante `PHYSICAL_MAX_MM` que
// topa el ancho medio.
// =============================================================================

"use strict";

// -----------------------------------------------------------------------------
// Constantes físicas
// -----------------------------------------------------------------------------

/** DPI estándar de impresoras térmicas de 203 dpi (`DOTS_PER_MM_203 ≈ 8`). */
const DPI_203 = 203;

/**
 * Factor crudo "203 / 25.4" (≈ 7.992). Lo exponemos tal cual para tests
 * que necesitan comprobar la fuente de verdad; el redondeo final a entero
 * lo hace `mmToDots`.
 */
const DOTS_PER_MM_203 = DPI_203 / 25.4;

/**
 * Techo físico del medio soportado por el bridge: 82mm (ancho real del
 * rollo de la Jaltech JAL-838L). Se usa como fallback cuando el llamador
 * no envía `printableWidthMm`; nunca como mínimo.
 */
const PHYSICAL_MAX_MM = 82;

// -----------------------------------------------------------------------------
// Códigos de error accionables para el handler.
//
// NO duplican los del `printer-bridge.js`: aquí sólo viven los errores
// específicos del generador de etiquetas. El bridge los propaga tal cual
// al frontend con `errorCode: err.code`.
// -----------------------------------------------------------------------------

const LABEL_ERR = Object.freeze({
    LAYOUT_OUT_OF_BOUNDS: "LAYOUT_OUT_OF_BOUNDS",
    INVALID_BARCODE_EAN13: "INVALID_BARCODE_EAN13",
    UNSUPPORTED_BARCODE_SYMBOLOGY: "UNSUPPORTED_BARCODE_SYMBOLOGY",
    INVALID_LABEL_CONFIG: "INVALID_LABEL_CONFIG",
    // bridge-printing-v3 (góndola térmica 80mm): errores accionables del
    // renderer `buildTsplShelfLabelsDocument`. Se propagan tal cual al
    // frontend vía `errorCode`.
    NO_LABELS: "NO_LABELS",
    TOO_MANY_LABELS: "TOO_MANY_LABELS",
    INVALID_SHELF_CONFIG: "INVALID_SHELF_CONFIG",
});

// -----------------------------------------------------------------------------
// Presets de etiqueta (espejan los del frontend `LABEL_SIZE_PRESETS`).
//
// Clave en minúscula para alinearse con el futuro contrato del frontend
// que amplía los presets (research-printing-v2 §Fase A paso 2). Los
// tres presets históricos (`50x30`, `40x30`, `30x20`) existen hoy en
// `LABEL_SIZE_DIMENSIONS`; los demás se añaden aquí porque el bridge
// debe poder renderizar la página de prueba aunque el frontend aún no
// los exponga en su UI.
//
// Cada preset trae valores razonables de columnas, gap horizontal, gap
// vertical (sensor) y margen izquierdo. Son defaults: el llamador manda
// si envía su propio `labels.*`.
// -----------------------------------------------------------------------------

const LABEL_PRESETS = Object.freeze({
    "50x30":      Object.freeze({ widthMm: 50, heightMm: 30, columns: 1, horizontalGapMm: 2, verticalGapMm: 3, marginLeftMm: 2 }),
    "40x30":      Object.freeze({ widthMm: 40, heightMm: 30, columns: 1, horizontalGapMm: 2, verticalGapMm: 3, marginLeftMm: 2 }),
    "30x20":      Object.freeze({ widthMm: 30, heightMm: 20, columns: 1, horizontalGapMm: 2, verticalGapMm: 2, marginLeftMm: 2 }),
    "30x20-2col": Object.freeze({ widthMm: 30, heightMm: 20, columns: 2, horizontalGapMm: 2, verticalGapMm: 2, marginLeftMm: 2 }),
    "58x40":      Object.freeze({ widthMm: 58, heightMm: 40, columns: 1, horizontalGapMm: 2, verticalGapMm: 3, marginLeftMm: 2 }),
    "76x50":      Object.freeze({ widthMm: 76, heightMm: 50, columns: 1, horizontalGapMm: 3, verticalGapMm: 3, marginLeftMm: 3 }),
});

// -----------------------------------------------------------------------------
// Utilidades
// -----------------------------------------------------------------------------

/**
 * Convierte milímetros a dots usando `dpi / 25.4`. Default 203 dpi.
 *
 * `mmToDots(10, 203)` → 80, `mmToDots(25.4, 203)` → 203, `mmToDots(1, 203)` → 8.
 *
 * Entradas no numéricas devuelven 0 (BC con configs que vengan con `null`
 * o strings; validarlos arriba en el flujo si se quiere error duro).
 */
function mmToDots(mm, dpi) {
    const d = typeof dpi === "number" && Number.isFinite(dpi) && dpi > 0 ? dpi : DPI_203;
    const value = typeof mm === "number" ? mm : Number(mm);
    if (!Number.isFinite(value)) return 0;
    return Math.round(value * d / 25.4);
}

function toNumber(v, fallback) {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function toInt(v, min, max, fallback) {
    const n = toNumber(v, fallback);
    const r = Math.round(n);
    if (r < min) return min;
    if (r > max) return max;
    return r;
}

function isPlainObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
}

// -----------------------------------------------------------------------------
// Fuentes TSPL built-in seguras
// -----------------------------------------------------------------------------

/** IDs de fuente TSPL built-in permitidos por el wire canónico. */
const TSPL_BUILTIN_FONTS = Object.freeze(["1", "2", "3", "4", "5", "6", "7", "8"]);

function toTsplBuiltinFont(value, fallback) {
    const candidate = typeof value === "string" || typeof value === "number"
        ? String(value)
        : "";
    return TSPL_BUILTIN_FONTS.includes(candidate) ? candidate : fallback;
}

// -----------------------------------------------------------------------------
// Cálculo de columnas
// -----------------------------------------------------------------------------

/**
 * Calcula los offsets `x` (en dots) de cada columna, junto con el ancho
 * total del medio en mm y en dots.
 *
 *   x_col(i) = marginLeftDots + i * (labelWidthDots + horizontalGapDots)
 *   totalMm  = marginLeftMm + columns * labelWidthMm + (columns-1) * horizontalGapMm
 *
 * `printableWidthMm` (opcional): si viene y > 0, se usa como tope.
 * Si no viene, el tope es `PHYSICAL_MAX_MM` (82mm).
 *
 * Devuelve `{ offsets, totalMm, totalDots, limitMm, fits, dots }` sin
 * lanzar — el llamador decide si rechaza con error accionable o aún
 * así imprime (algunos tests necesitan ambos caminos).
 *
 * @param {{marginLeftMm: number, labelWidthMm: number, horizontalGapMm?: number,
 *          columns?: 1|2, printableWidthMm?: number, dpi?: number}} input
 */
function computeColumnOffsets(input) {
    const marginLeftMm = Math.max(0, toNumber(input?.marginLeftMm, 0));
    const labelWidthMm = Math.max(0, toNumber(input?.labelWidthMm, 0));
    const cols = toInt(input?.columns, 1, 2, 1);
    const horizontalGapMm = cols === 2 ? Math.max(0, toNumber(input?.horizontalGapMm, 0)) : 0;
    const dpi = toNumber(input?.dpi, DPI_203);

    const marginDots = mmToDots(marginLeftMm, dpi);
    const widthDots = mmToDots(labelWidthMm, dpi);
    const gapDots = mmToDots(horizontalGapMm, dpi);

    const offsets = [];
    for (let i = 0; i < cols; i++) {
        offsets.push(marginDots + i * (widthDots + gapDots));
    }

    const totalMm = marginLeftMm + cols * labelWidthMm + (cols - 1) * horizontalGapMm;
    const totalDots = marginDots + cols * widthDots + (cols - 1) * gapDots;

    const printable = toNumber(input?.printableWidthMm, 0);
    const limitMm = printable > 0 ? printable : PHYSICAL_MAX_MM;
    // Techo físico estricto: el contrato soporta como máximo 82mm.
    // `totalMm` se calcula con valores en mm antes del redondeo a dots, por
    // lo que no hace falta tolerancia que pudiera aceptar 82.5mm.
    const fits = totalMm <= limitMm;

    return {
        offsets,
        totalMm,
        totalDots,
        limitMm,
        fits,
        dots: { marginDots, widthDots, gapDots },
        columns: cols,
    };
}

/**
 * Aplana `items[].quantity` para que el batch TSPL emita `PRINT 1,1`
 * por fila: la cantidad vive en el número de copias, no en TSPL. Esto
 * nos permite distribuir las copias en 2 columnas sin que el firmware
 * duplique por su cuenta.
 */
function flattenLabelItems(items) {
    if (!Array.isArray(items)) return [];
    const out = [];
    for (const it of items) {
        if (!isPlainObject(it)) continue;
        const qty = toInt(it.quantity, 1, 10000, 1);
        for (let i = 0; i < qty; i++) {
            // Clonado shallow + quantity:1 para dejar la fuente intacta.
            out.push({ ...it, quantity: 1 });
        }
    }
    return out;
}

/**
 * Agrupa el array aplanado en filas de `columns` items. La última fila
 * puede quedar incompleta (ej. 3 copias en 2 columnas = fila1[A,B] + fila2[C]).
 */
function buildRows(flatItems, columns) {
    const cols = toInt(columns, 1, 2, 1);
    const rows = [];
    for (let i = 0; i < flatItems.length; i += cols) {
        rows.push(flatItems.slice(i, i + cols));
    }
    return rows;
}

// -----------------------------------------------------------------------------
// Normalización del shape `labels` que viene del frontend
// -----------------------------------------------------------------------------

/**
 * Normaliza `labels` del payload a un diccionario interno con todos los
 * valores derivados ya resueltos:
 *
 *   {
 *     dpi,
 *     widthMm, heightMm,
 *     columns,
 *     horizontalGapMm, verticalGapMm,
 *     marginLeftMm,
 *     printableWidthMm,
 *     mediumWidthMm,     // = ancho TOTAL del medio en mm (SIZE del TSPL)
 *     layout: {
 *       productName: { xMm, yMm, font, scaleX, scaleY, maxLen },
 *       salePrice:   { xMm, yMm, font, scaleX, scaleY, maxLen },
 *       barcode:     { xMm, yMm, symbology, heightMm, moduleWidth, hri }
 *     }
 *   }
 *
 * NO devuelve `offsets` — eso lo pide `computeColumnOffsets` que
 * también se puede llamar desde tests independientes.
 */
function normalizeLabelsConfig(labels, preset) {
    const base = preset && LABEL_PRESETS[preset] ? LABEL_PRESETS[preset] : null;
    const src = isPlainObject(labels) ? labels : {};

    const dpi = toNumber(src.dpi, DPI_203) > 0 ? toNumber(src.dpi, DPI_203) : DPI_203;
    const widthMm = toNumber(src.widthMm, base ? base.widthMm : 50);
    const heightMm = toNumber(src.heightMm, base ? base.heightMm : 30);
    const columns = toInt(src.columns, 1, 2, base ? base.columns : 1);

    // horizontalGapMm sólo tiene efecto cuando columns=2. Lo preservamos
    // igual para que la UI del frontend pueda mostrar un valor consistente.
    const horizontalGapMm = Math.max(0, toNumber(src.horizontalGapMm, base ? base.horizontalGapMm : 0));

    // El GAP VERTICAL del rollo es `sensor.gapMm` según contrato con el
    // frontend. Fallback: `verticalGapMm` directo (para futuras versiones)
    // o default del preset.
    const sensor = isPlainObject(src.sensor) ? src.sensor : {};
    const verticalGapMm = Math.max(0, toNumber(
        sensor.gapMm,
        toNumber(src.verticalGapMm, base ? base.verticalGapMm : 3),
    ));

    const marginLeftMm = Math.max(0, toNumber(src.marginLeftMm, base ? base.marginLeftMm : 0));

    // printableWidthMm es opcional. Si viene lo respetamos; si no, el
    // ancho total calculado del medio es el tope natural y PHYSICAL_MAX_MM
    // es el techo de seguridad.
    const printableWidthMm = toNumber(src.printableWidthMm, 0);

    const mediumWidthMm = marginLeftMm + columns * widthMm + (columns - 1) * horizontalGapMm;

    // Layout: aceptamos tanto el shape "canónico frontend"
    // (labels.layout.name / layout.price / layout.barcode con xMm/yMm/font/
    // fontScale) como el shape histórico (labels.layout.productName /
    // layout.salePrice con scaleX/scaleY). El shape FRONTEND es canónico:
    // cuando ambos están presentes, gana `layout.name` sobre
    // `layout.productName`. El `scaleX/scaleY` histórico sólo entra si el
    // frontend NO envió `fontScale`.
    const layoutSrc = isPlainObject(src.layout) ? src.layout : {};

    // Fuente única `fontScale` → `scaleX/scaleY` enteros 1..10. El clamp
    // trata 0.5 como piso de legibilidad: TSPL ignora valores < 1.
    function scaleFromFont(fontScale, fallback) {
        if (!Number.isFinite(fontScale) || fontScale <= 0) {
            return Math.max(1, Math.round(fallback));
        }
        return Math.max(1, Math.min(10, Math.round(fontScale)));
    }

    // -- productName ----------------------------------------------------
    // Preferencia: `labels.layout.name` (frontend canonical) > `labels.layout.productName` (BC).
    const nameFromCanonical = isPlainObject(layoutSrc.name) ? layoutSrc.name : null;
    const nameFromLegacy = isPlainObject(layoutSrc.productName) ? layoutSrc.productName : null;
    const nameFromLayout = nameFromCanonical || nameFromLegacy || {};
    const nameFromCfg = isPlainObject(src.productName) ? src.productName : {};
    const nameScaleFromFontScale = typeof nameFromLayout.fontScale !== "undefined"
        ? scaleFromFont(toNumber(nameFromLayout.fontScale, NaN), 1)
        : null;
    const productName = {
        xMm: Math.max(0, toNumber(nameFromLayout.xMm, 1)),
        yMm: Math.max(0, toNumber(nameFromLayout.yMm, 1)),
        font: toTsplBuiltinFont(nameFromLayout.font, "3"),
        scaleX: nameScaleFromFontScale !== null
            ? nameScaleFromFontScale
            : toInt(nameFromLayout.scaleX, 1, 10, 1),
        scaleY: nameScaleFromFontScale !== null
            ? nameScaleFromFontScale
            : toInt(nameFromLayout.scaleY, 1, 10, 1),
        maxLen: toInt(nameFromCfg.maxChars, 1, 200,
            toInt(nameFromLayout.maxLen, 1, 200, 32)),
        visible: nameFromCfg.visible === false ? false : true,
    };

    // -- salePrice ------------------------------------------------------
    // Preferencia: `labels.layout.price` (frontend canonical) > `labels.layout.salePrice` (BC).
    const priceFromCanonical = isPlainObject(layoutSrc.price) ? layoutSrc.price : null;
    const priceFromLegacy = isPlainObject(layoutSrc.salePrice) ? layoutSrc.salePrice : null;
    const priceFromLayout = priceFromCanonical || priceFromLegacy || {};
    const priceFromCfg = isPlainObject(src.price) ? src.price : {};
    const priceScaleFromFontScale = typeof priceFromLayout.fontScale !== "undefined"
        ? scaleFromFont(toNumber(priceFromLayout.fontScale, NaN), priceFromCfg.emphasized ? 2 : 1)
        : null;
    const salePrice = {
        xMm: Math.max(0, toNumber(priceFromLayout.xMm, 1)),
        yMm: Math.max(0, toNumber(priceFromLayout.yMm, Math.max(6, heightMm / 2))),
        font: toTsplBuiltinFont(priceFromLayout.font, "4"),
        scaleX: priceScaleFromFontScale !== null
            ? priceScaleFromFontScale
            : toInt(priceFromLayout.scaleX, 1, 10, priceFromCfg.emphasized ? 2 : 1),
        scaleY: priceScaleFromFontScale !== null
            ? priceScaleFromFontScale
            : toInt(priceFromLayout.scaleY, 1, 10, priceFromCfg.emphasized ? 2 : 1),
        maxLen: toInt(priceFromLayout.maxLen, 1, 40, 20),
        visible: priceFromCfg.visible === false ? false : true,
    };

    // -- barcode --------------------------------------------------------
    // El bloque `labels.layout.barcode` del frontend sólo trae xMm/yMm/
    // fontScale (ignorado para barcode). El resto (symbology, heightMm,
    // humanReadable, rotation, narrow, wide) vive en `labels.barcode`
    // porque son propiedades de la simbología, no del posicionamiento.
    const bcFromLayout = isPlainObject(layoutSrc.barcode) ? layoutSrc.barcode : {};
    const bcFromCfg = isPlainObject(src.barcode) ? src.barcode : {};
    const symbology = String(bcFromCfg.symbology || bcFromLayout.symbology || "CODE128")
        .toUpperCase();
    // `moduleWidth` histórico se mantiene como fallback cuando el frontend
    // no envía narrow/wide. El wire TSPL emite narrow/wide por separado.
    const legacyModuleWidth = toInt(bcFromLayout.moduleWidth, 1, 8, 2);
    // humanReadable: default true (coherente con el shape canónico).
    // Preservamos la clave histórica `hri` (opposite boolean? → el campo
    // histórico ya era booleano con la misma semántica que humanReadable).
    const bcHumanReadable = bcFromCfg.humanReadable === false
        ? false
        : bcFromCfg.humanReadable === true
            ? true
            : bcFromLayout.hri === false
                ? false
                : true;
    // Rotación en grados: TSPL acepta 0, 90, 180, 270. Cualquier otra cae
    // a 0 (horizontal) sin romper el emit.
    const allowedRotations = [0, 90, 180, 270];
    const rawRotation = toNumber(bcFromCfg.rotation, toNumber(bcFromLayout.rotation, 0));
    const bcRotation = allowedRotations.includes(rawRotation) ? rawRotation : 0;
    // narrow / wide en dots. El frontend y el bridge comparten rango 1..8.
    const bcNarrow = toInt(bcFromCfg.narrow, 1, 8, legacyModuleWidth);
    const bcWide = toInt(bcFromCfg.wide, 1, 8, legacyModuleWidth);
    const barcode = {
        xMm: Math.max(0, toNumber(bcFromLayout.xMm, 1)),
        yMm: Math.max(0, toNumber(bcFromLayout.yMm, Math.max(10, heightMm * 0.55))),
        symbology,
        heightMm: Math.max(2, toNumber(bcFromCfg.heightMm,
            toNumber(bcFromLayout.heightMm, 10))),
        narrow: bcNarrow,
        wide: bcWide,
        hri: bcHumanReadable,
        rotation: bcRotation,
    };

    return {
        dpi,
        widthMm,
        heightMm,
        columns,
        horizontalGapMm,
        verticalGapMm,
        marginLeftMm,
        printableWidthMm,
        mediumWidthMm,
        layout: { productName, salePrice, barcode },
    };
}

// -----------------------------------------------------------------------------
// EAN13 — validación y check digit
//
// TSPL acepta 12 ó 13 dígitos para `BARCODE "EAN13"`. Si vienen 13, el
// 13º debe ser el dígito verificador correcto. Si vienen 12, el firmware
// lo calcula. Validamos acá los dos casos para no mandar basura al
// cabezal (el firmware algunos modelos no verifica y pinta cualquier cosa).
// -----------------------------------------------------------------------------

function computeEan13CheckDigit(digits12) {
    let sum = 0;
    for (let i = 0; i < 12; i++) {
        const d = digits12.charCodeAt(i) - 0x30;
        sum += (i % 2 === 0) ? d : d * 3;
    }
    const mod = sum % 10;
    return mod === 0 ? 0 : 10 - mod;
}

/**
 * Devuelve una cadena de 12 ó 13 dígitos EAN13 válida, o `null` si el
 * input no es compatible con la simbología.
 */
function sanitizeEan13(code) {
    const digits = String(code || "").replace(/\D/g, "");
    if (digits.length === 12) return digits;
    if (digits.length === 13) {
        const check = computeEan13CheckDigit(digits.slice(0, 12));
        if (String(check) !== digits[12]) return null;
        return digits;
    }
    return null;
}

// -----------------------------------------------------------------------------
// Builder TSPL — documento completo para un lote de items
// -----------------------------------------------------------------------------

/**
 * Construye un documento TSPL para los `items` dados, respetando el
 * shape del `labels` del frontend. `items` deben venir con `quantity`
 * ya resuelto por el llamador (`normalizeLabelItems` del `printer-bridge`).
 *
 * El llamador inyecta:
 *   - `escapeFn(text, maxLen)` → saneado específico de TSPL (sin `"`, `\`,
 *     ni non-ASCII). Reutilizamos `escapeForTspl` del `printer-bridge`.
 *   - `formatMoney(number)` → formato colombiano para la etiqueta.
 *   - `preset?` → clave de `LABEL_PRESETS` para completar defaults si
 *     el `labels` del payload es incompleto (test-page).
 *
 * Devuelve un `Buffer` ASCII.
 *
 * Lanza `Error` con `.code` ∈ `LABEL_ERR` cuando el layout no cabe en
 * el ancho imprimible, o cuando un código EAN13 es inválido. El bridge
 * se encarga de mapear a `errorCode` del WS.
 */
function buildTsplDocument(options) {
    const {
        labels,
        items,
        preset,
        escapeFn,
        formatMoney,
    } = options || {};
    if (!Array.isArray(items) || items.length === 0) {
        const err = new Error("sin items para generar TSPL");
        err.code = LABEL_ERR.INVALID_LABEL_CONFIG;
        throw err;
    }
    if (typeof escapeFn !== "function") {
        const err = new Error("escapeFn requerido");
        err.code = LABEL_ERR.INVALID_LABEL_CONFIG;
        throw err;
    }
    const money = typeof formatMoney === "function" ? formatMoney : (n) => String(Math.round(Number(n) || 0));

    const cfg = normalizeLabelsConfig(labels, preset);
    const offsets = computeColumnOffsets({
        marginLeftMm: cfg.marginLeftMm,
        labelWidthMm: cfg.widthMm,
        horizontalGapMm: cfg.horizontalGapMm,
        columns: cfg.columns,
        printableWidthMm: cfg.printableWidthMm,
        dpi: cfg.dpi,
    });
    if (!offsets.fits) {
        const err = new Error(
            `layout no cabe: ${offsets.totalMm.toFixed(2)}mm > ${offsets.limitMm}mm` +
            ` (margen ${cfg.marginLeftMm}, ${cfg.columns}col × ${cfg.widthMm}mm, gap ${cfg.horizontalGapMm})`,
        );
        err.code = LABEL_ERR.LAYOUT_OUT_OF_BOUNDS;
        throw err;
    }

    const flat = flattenLabelItems(items);
    if (flat.length === 0) {
        const err = new Error("items aplanados vacíos");
        err.code = LABEL_ERR.INVALID_LABEL_CONFIG;
        throw err;
    }
    const rows = buildRows(flat, cfg.columns);

    // Cabecera del batch (SIZE = ancho TOTAL del medio, no sólo etiqueta).
    const header = [
        `SIZE ${formatMm(cfg.mediumWidthMm)} mm, ${formatMm(cfg.heightMm)} mm`,
        `GAP ${formatMm(cfg.verticalGapMm)} mm, 0 mm`,
        `DIRECTION 1`,
        `REFERENCE 0,0`,
        `DENSITY 8`,
    ].join("\r\n") + "\r\n";

    const chunks = [header];
    for (const row of rows) {
        chunks.push(buildTsplRow(row, cfg, offsets.offsets, escapeFn, money));
    }

    return Buffer.from(chunks.join(""), "ascii");
}

/**
 * Formatea mm con máximo 2 decimales y sin ceros colgantes (ej. 62 → "62",
 * 61.9 → "61.9", 62.00 → "62"). Mantiene la salida TSPL compacta.
 */
function formatMm(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return "0";
    if (Math.round(num) === num) return String(num);
    return num.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Emite el bloque TSPL de una FILA (1 ó 2 items):
 *   CLS
 *   TEXT ... (col 0)
 *   BARCODE ... (col 0)
 *   TEXT ... (col 1)        [si existe]
 *   BARCODE ... (col 1)     [si existe]
 *   PRINT 1,1
 *
 * El `PRINT 1,1` por fila es intencional: aplanamos cantidades arriba
 * para distribuir las copias correctamente en 2 columnas.
 */
function buildTsplRow(row, cfg, columnOffsetsDots, escapeFn, formatMoney) {
    const lines = ["CLS"];
    for (let colIdx = 0; colIdx < row.length; colIdx++) {
        const item = row[colIdx];
        const xBase = columnOffsetsDots[colIdx];
        appendItemCommands(lines, item, cfg, xBase, escapeFn, formatMoney);
    }
    lines.push("PRINT 1,1");
    return lines.join("\r\n") + "\r\n";
}

function appendItemCommands(lines, item, cfg, xBaseDots, escapeFn, formatMoney) {
    const dpi = cfg.dpi;
    const name = cfg.layout.productName;
    const price = cfg.layout.salePrice;
    const bc = cfg.layout.barcode;

    // --- Nombre
    if (name.visible && item.productName) {
        const nameX = xBaseDots + mmToDots(name.xMm, dpi);
        const nameY = mmToDots(name.yMm, dpi);
        const nameSafe = escapeFn(item.productName, name.maxLen);
        if (nameSafe) {
            lines.push(
                `TEXT ${nameX},${nameY},"${name.font}",0,${name.scaleX},${name.scaleY},"${nameSafe}"`,
            );
        }
    }
    // --- Precio
    const salePriceValue = Number(item.salePrice);
    if (price.visible && Number.isFinite(salePriceValue) && salePriceValue > 0) {
        const priceX = xBaseDots + mmToDots(price.xMm, dpi);
        const priceY = mmToDots(price.yMm, dpi);
        const priceSafe = escapeFn(`$ ${formatMoney(salePriceValue)}`, price.maxLen);
        lines.push(
            `TEXT ${priceX},${priceY},"${price.font}",0,${price.scaleX},${price.scaleY},"${priceSafe}"`,
        );
    }
    // --- Barcode
    const bcX = xBaseDots + mmToDots(bc.xMm, dpi);
    const bcY = mmToDots(bc.yMm, dpi);
    const bcHeightDots = mmToDots(bc.heightMm, dpi);
    const hri = bc.hri ? 1 : 0;
    const rotation = bc.rotation | 0;
    const narrow = bc.narrow;
    const wide = bc.wide;
    if (bc.symbology === "EAN13") {
        const digits = sanitizeEan13(item.code);
        if (!digits) {
            const err = new Error(`EAN13 inválido para código "${item.code}"`);
            err.code = LABEL_ERR.INVALID_BARCODE_EAN13;
            throw err;
        }
        lines.push(
            `BARCODE ${bcX},${bcY},"EAN13",${bcHeightDots},${hri},${rotation},${narrow},${wide},"${digits}"`,
        );
    } else if (bc.symbology === "CODE128" || bc.symbology === "128") {
        const codeSafe = escapeFn(item.code, 48);
        if (!codeSafe) return;
        lines.push(
            `BARCODE ${bcX},${bcY},"128",${bcHeightDots},${hri},${rotation},${narrow},${wide},"${codeSafe}"`,
        );
    } else {
        const err = new Error(`simbología no soportada: ${bc.symbology}`);
        err.code = LABEL_ERR.UNSUPPORTED_BARCODE_SYMBOLOGY;
        throw err;
    }
}

// -----------------------------------------------------------------------------
// Página de prueba: etiqueta con el preset elegido y, cuando el preset es
// de 2 columnas, dos ejemplos lado a lado.
// -----------------------------------------------------------------------------

/**
 * Construye el batch TSPL de página de prueba. Usa `preset` si existe;
 * si no, usa el `labels` del payload tal cual.
 *
 * Para presets de 2 columnas emite DOS items distintos (TEST-L y TEST-R)
 * para que el admin verifique visualmente que las columnas están donde
 * deben estar.
 */
function buildTsplTestPage(options) {
    const { labels, preset, escapeFn, formatMoney } = options || {};
    const cfg = normalizeLabelsConfig(labels, preset);
    const useTwo = cfg.columns === 2;

    const items = useTwo
        ? [
            { code: "TEST-L", productName: "ETIQUETA IZQ", salePrice: 1000, quantity: 1 },
            { code: "TEST-R", productName: "ETIQUETA DER", salePrice: 2000, quantity: 1 },
        ]
        : [
            { code: "TESTBRIDGE", productName: "ETIQUETA DE PRUEBA", salePrice: 0, quantity: 1 },
        ];

    return buildTsplDocument({
        labels, // sin preset: el labels viene con lo que el admin tiene
        items,
        preset,  // completa defaults si falta algo
        escapeFn,
        formatMoney,
    });
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Renderer TSPL para RECIBOS (bridge-printing-v2)
//
// Separado del batch de etiquetas porque las reglas son distintas:
//   * El medio es papel CONTINUO (sin gap entre "etiquetas"): emitimos
//     `GAP 0 mm, 0 mm` siempre para que el firmware no busque el sensor
//     cada N mm y produzca huecos entre tickets.
//   * El alto se CALCULA desde el número de líneas: TSPL exige un `SIZE`
//     fijo por `PRINT`, así que estimamos un alto generoso basado en
//     `lineHeightMm * lineCount + margen` y lo topamos a `[10, 1000] mm`.
//   * El ancho sale de `receipt.widthMm` (saneado por el frontend, en
//     el rango 20..82). Fuera de ese rango lanzamos `LAYOUT_OUT_OF_BOUNDS`
//     o `INVALID_RECEIPT_CONFIG`.
//   * Todas las líneas pasan por `escapeFn` (típicamente `escapeForTspl`
//     del `printer-bridge.js`): sin `"`, sin `\`, sin control chars,
//     sin non-ASCII — necesario porque embebemos texto arbitrario del
//     recibo entre comillas en comandos `TEXT`.
//   * `receipt.cut === "AUTO"` emite `CUT` al final solo si el firmware
//     lo soporta. En firmwares sin cutter (JAL-838L por default), el
//     comando se ignora de forma segura.
//
// Esta función es PURA: no toca sockets, no spawnea procesos, es
// idempotente para la misma entrada.
// -----------------------------------------------------------------------------

/** Techos del renderer (centralizados para los tests). */
const RECEIPT_TSPL_LIMITS = Object.freeze({
    minWidthMm: 20,
    minPrintableWidthMm: 10,
    minColumns: 10,     // suficiente para "OK\n" de debug
    maxColumns: 80,     // mapea con PAPER_COLUMNS del frontend
    maxLineCount: 2000, // cota contra ticketText absurdo
    minHeightMm: 10,
    maxHeightMm: 1000,
    defaultDpi: DPI_203,
    // Márgenes default (mm). Son conservadores para que el cabezal no
    // se coma la primera línea en firmwares con offset mecánico.
    defaultTopMm: 1.5,
    defaultLeftMm: 1.5,
    defaultBottomMm: 3,
});

/**
 * Métricas (ancho x alto) de las fuentes TSPL built-in, en dots a 203 dpi.
 *
 * Fuente de verdad: datasheet TSC TSPL/TSPL2 (familia TDP/TTP, compatible
 * con la Jaltech JAL-838L). Antes de bridge-printing-v3 la tabla asumía
 * fuentes mucho más estrechas (p.ej. 2=10x20, 3=12x20) y el picker elegía
 * una fuente que NO cabía en el ancho imprimible real; el firmware pintaba
 * los glifos a su ancho verdadero y el ticket aparecía recortado por la
 * derecha. Con las métricas correctas abajo el picker puede evaluar el
 * presupuesto en dots y bajar al siguiente escalón del ladder si no cabe.
 *
 *   1 → 8x12       5 → 32x48 (OCR-A)
 *   2 → 12x20      6 → 14x19 (OCR-B)
 *   3 → 16x24      7 → 21x27
 *   4 → 24x32      8 → 14x25
 */
const TSPL_FONT_METRICS = Object.freeze({
    "1": Object.freeze({ widthDots: 8,  heightDots: 12 }),
    "2": Object.freeze({ widthDots: 12, heightDots: 20 }),
    "3": Object.freeze({ widthDots: 16, heightDots: 24 }),
    "4": Object.freeze({ widthDots: 24, heightDots: 32 }),
    "5": Object.freeze({ widthDots: 32, heightDots: 48 }),
    "6": Object.freeze({ widthDots: 14, heightDots: 19 }),
    "7": Object.freeze({ widthDots: 21, heightDots: 27 }),
    "8": Object.freeze({ widthDots: 14, heightDots: 25 }),
});

/**
 * Orden canónico "ladder" para la selección automática de fuente de recibo.
 * Decreciente por ancho de glifo (más legible → menos legible) dentro del
 * conjunto monoespacio apto para ticket. La fuente 8 (14×25) se inserta
 * entre la 3 (16×24) y la 2 (12×20) como "midpoint" oficial para 58 mm /
 * 48 mm imprimible a 26 columnas: su alto base ya equivale al de la 3 por
 * lo que basta scaleY=1 (evita el gigantismo vertical que producía font 2
 * scaleY 2 en el ticket de 58 mm). Las fuentes OCR puras (5, 6, 7) rompen
 * el ritmo monoespacio del ticket y quedan fuera del ladder — el admin
 * puede forzarlas con `receipt.tspl.font` si realmente las necesita.
 */
const TSPL_RECEIPT_FONT_LADDER = Object.freeze(["4", "3", "8", "2", "1"]);

/**
 * Alto por línea en mm según fuente TSPL built-in y escala vertical.
 *
 * Deriva del `TSPL_FONT_METRICS` oficial (heightDots) convertido a mm con
 * la densidad de 203 dpi, más un pequeño padding entre líneas (3 dots)
 * para evitar que los baselines se besen. Multiplica por `scaleY` (1..10)
 * porque TSPL expande el glifo verticalmente antes de pintarlo.
 */
function tsplLineHeightMm(font, scaleY) {
    const metrics = TSPL_FONT_METRICS[String(font)] || TSPL_FONT_METRICS["3"];
    const paddingDots = 3;
    const baseMm = (metrics.heightDots + paddingDots) / DOTS_PER_MM_203;
    const sy = Math.max(1, Math.min(10, Math.round(Number(scaleY) || 1)));
    return baseMm * sy;
}

/**
 * Elige la fuente built-in TSPL más legible que efectivamente quepa en el
 * ancho imprimible del recibo, descontando el margen izquierdo y aplicando
 * `scaleX`. Es la contrapartida correcta al picker viejo (que mapeaba
 * columns→font sin mirar el ancho real y producía recorte derecho).
 *
 * Firma canónica:
 *   pickTsplReceiptFont({ columns, printableWidthMm, leftMarginMm, scaleX, dpi })
 *
 * Firma BC (sólo `columns`): usa `PHYSICAL_MAX_MM` como presupuesto y
 * `leftMarginMm=0`. Útil para tests antiguos que no envían geometría.
 *
 *   availableDots = (printableWidthMm - leftMarginMm) * dpi / 25.4
 *   neededDots(font) = TSPL_FONT_METRICS[font].widthDots * scaleX * columns
 *   → se recorre `TSPL_RECEIPT_FONT_LADDER` y se devuelve la primera cuyos
 *     neededDots ≤ availableDots. Si ninguna cabe, cae a "1" para minimizar
 *     el recorte (la capa superior ya hará log del edge-case).
 *
 * Ejemplos canónicos (`dpi=203`, `leftMarginMm=1.5`, `scaleX=1`):
 *   - 58 físico / 48 imprimible / 26 cols → "8"  ← midpoint oficial 58 mm
 *   - 58 físico / 48 imprimible / 30 cols → "2"  (legacy)
 *   - 58 físico / 48 imprimible / 32 cols → "1"  (legacy)
 *   - 80 físico / 76 imprimible / 48 cols → "2"
 *   - 82 físico / 76 imprimible / 48 cols → "2"
 *
 * El admin puede forzar otra fuente vía `receipt.tspl.font`; el toTsplBuiltinFont
 * aplica el clamp al rango permitido (1..8) y respeta el override tal cual.
 */
function pickTsplReceiptFont(input) {
    const opts = typeof input === "number" ? { columns: input } : (input || {});
    const columns = Math.max(1, toInt(opts.columns, 1, 500, 32));
    const printableWidthMm = Math.max(1,
        toNumber(opts.printableWidthMm, PHYSICAL_MAX_MM));
    const leftMarginMm = Math.max(0, toNumber(opts.leftMarginMm, 0));
    const scaleX = Math.max(1, Math.min(10, toInt(opts.scaleX, 1, 10, 1)));
    const dpi = toNumber(opts.dpi, DPI_203) > 0
        ? toNumber(opts.dpi, DPI_203)
        : DPI_203;

    const availableMm = Math.max(0, printableWidthMm - leftMarginMm);
    const availableDots = availableMm * dpi / 25.4;

    for (const fontId of TSPL_RECEIPT_FONT_LADDER) {
        const metrics = TSPL_FONT_METRICS[fontId];
        if (!metrics) continue;
        const neededDots = metrics.widthDots * scaleX * columns;
        if (neededDots <= availableDots) return fontId;
    }
    // Ninguna fuente del ladder cabe: devolvemos la más pequeña (1) para
    // minimizar el recorte visual. Config imposible (p.ej. 80 cols en 20mm)
    // debería atraparse arriba en la validación del frontend.
    return "1";
}

/**
 * Construye el documento TSPL de un recibo térmico.
 *
 * @param {object} options
 * @param {string} options.ticketText   Texto monoespaciado completo del recibo,
 *                                      con `\n` entre líneas.
 * @param {object} options.receipt      Config saneada del recibo:
 *                                        { widthMm, printableWidthMm?, columns,
 *                                          cut?, dpi?, tspl?: {font?, scaleX?,
 *                                          scaleY?, topMarginMm?, leftMarginMm?,
 *                                          bottomMarginMm?, lineHeightMm?} }
 * @param {Function} options.escapeFn   `(text, maxLen) => safeAsciiOneLine`.
 * @param {number} [options.physicalMaxMm]  Techo físico (default `PHYSICAL_MAX_MM`).
 * @returns {Buffer} ASCII con el batch TSPL completo.
 *
 * Lanza `Error` con:
 *   - `.code === "LAYOUT_OUT_OF_BOUNDS"` si `widthMm > physicalMaxMm`.
 *   - `.code === "INVALID_RECEIPT_CONFIG"` si `widthMm < 20`, `columns < 10`,
 *     o `escapeFn` no es función.
 */
function buildTsplReceiptDocument(options) {
    const {
        ticketText,
        receipt,
        escapeFn,
        physicalMaxMm,
    } = options || {};

    if (typeof escapeFn !== "function") {
        const err = new Error("escapeFn requerido");
        err.code = "INVALID_RECEIPT_CONFIG";
        throw err;
    }

    const physMax = toNumber(physicalMaxMm, PHYSICAL_MAX_MM);
    const cfg = isPlainObject(receipt) ? receipt : {};

    // Dimensiones y columnas — con clamping defensivo.
    const dpi = toNumber(cfg.dpi, RECEIPT_TSPL_LIMITS.defaultDpi);
    const rawWidth = toNumber(cfg.widthMm, 80);
    if (!Number.isFinite(rawWidth)) {
        const err = new Error("receipt.widthMm no numérico");
        err.code = "INVALID_RECEIPT_CONFIG";
        throw err;
    }
    if (rawWidth > physMax) {
        const err = new Error(
            `receipt.widthMm=${rawWidth} excede el techo físico ${physMax}mm`,
        );
        err.code = "LAYOUT_OUT_OF_BOUNDS";
        throw err;
    }
    if (rawWidth < RECEIPT_TSPL_LIMITS.minWidthMm) {
        const err = new Error(
            `receipt.widthMm=${rawWidth} < ${RECEIPT_TSPL_LIMITS.minWidthMm}mm`,
        );
        err.code = "INVALID_RECEIPT_CONFIG";
        throw err;
    }
    const widthMm = rawWidth;

    // printableWidthMm es opcional; si viene, no puede exceder widthMm.
    const printableWidthMm = Math.max(
        RECEIPT_TSPL_LIMITS.minPrintableWidthMm,
        Math.min(widthMm, toNumber(cfg.printableWidthMm, widthMm)),
    );

    const columnsRaw = cfg.columns;
    const columns = toInt(
        columnsRaw,
        RECEIPT_TSPL_LIMITS.minColumns,
        RECEIPT_TSPL_LIMITS.maxColumns,
        pickTsplReceiptColumns(widthMm),
    );
    if (columnsRaw !== undefined && columnsRaw !== null
        && Number.isFinite(Number(columnsRaw))
        && Math.round(Number(columnsRaw)) < RECEIPT_TSPL_LIMITS.minColumns) {
        const err = new Error(
            `receipt.columns=${columnsRaw} < ${RECEIPT_TSPL_LIMITS.minColumns}`,
        );
        err.code = "INVALID_RECEIPT_CONFIG";
        throw err;
    }

    const tsplCfg = isPlainObject(cfg.tspl) ? cfg.tspl : {};
    const scaleX = toInt(tsplCfg.scaleX, 1, 10, 1);

    const topMm = Math.max(0, toNumber(tsplCfg.topMarginMm, RECEIPT_TSPL_LIMITS.defaultTopMm));
    // TSPL posiciona X respecto al borde del medio declarado por SIZE. Una
    // vez corregida la orientación (DIRECTION 0,0), no debemos volver a
    // sumar `(width-printableWidth)/2`: ese segundo desplazamiento corre
    // todo el recibo a la derecha. El margen interno sigue configurable y
    // funciona igual para 58/80/82/CUSTOM.
    const leftMm = Math.max(
        0,
        toNumber(tsplCfg.leftMarginMm, RECEIPT_TSPL_LIMITS.defaultLeftMm),
    );
    const bottomMm = Math.max(0, toNumber(tsplCfg.bottomMarginMm, RECEIPT_TSPL_LIMITS.defaultBottomMm));

    // Fuente: el admin puede forzarla con `receipt.tspl.font` (toTsplBuiltinFont
    // aplica el clamp 1..8 y rechaza valores inválidos cayendo al fallback).
    // Si no viene override, el picker elige la fuente MÁS LEGIBLE que
    // efectivamente quepa en `printableWidthMm - leftMarginMm`, aplicando
    // `scaleX`. Esto reemplaza el mapeo histórico columns→font que no
    // consideraba el ancho real y producía recorte a la derecha.
    const font = toTsplBuiltinFont(
        tsplCfg.font,
        pickTsplReceiptFont({
            columns,
            printableWidthMm,
            leftMarginMm: leftMm,
            scaleX,
            dpi,
        }),
    );

    // Default de `scaleY` dependiente de la fuente elegida y del ancho:
    //   - En papel angosto (≤50 mm imprimible) las fuentes delgadas (1, 2)
    //     quedan muy chicas a scaleY=1; subimos a 2 para que el ticket se
    //     lea en caja. Es el comportamiento histórico que preservamos para
    //     clientes antiguos que sigan mandando columns=30 o 32.
    //   - Para font 8 (14×25, midpoint oficial 58mm/26cols del
    //     bridge-printing-v3.2) el alto base ya equivale al de font 3,
    //     por lo que scaleY=1 alcanza. Duplicarlo producía gigantismo
    //     vertical y recibos de más de 2× el largo necesario — el bug
    //     que este cambio cierra.
    //   - Para el resto (font 3/4 en cualquier ancho, cualquier fuente en
    //     80/82 mm) scaleY=1 default siempre.
    // El admin puede forzar un `tspl.scaleY` explícito y manda sobre todo
    // lo anterior.
    const narrow = printableWidthMm <= 50;
    const narrowThinFont = narrow && (font === "1" || font === "2");
    const defaultScaleY = narrowThinFont ? 2 : 1;
    const scaleY = toInt(tsplCfg.scaleY, 1, 10, defaultScaleY);

    // El admin puede forzar `lineHeightMm` para tickets muy densos; si no,
    // lo derivamos de la fuente/escala.
    const lineHeightMm = Math.max(
        1.0,
        toNumber(tsplCfg.lineHeightMm, tsplLineHeightMm(font, scaleY)),
    );

    // -- Procesamiento del texto -------------------------------------
    // Normalizamos EOL y partimos en líneas. Si `ticketText` viene con
    // CRLF (p.ej. desde un wrapper viejo), lo convertimos antes del split.
    const normalized = String(ticketText == null ? "" : ticketText).replace(/\r\n?/g, "\n");
    const rawLines = normalized.split("\n");
    // Tope duro de líneas — un ticket razonable no pasa de 200; aquí
    // damos holgura por si llega un diagnóstico muy largo.
    const limitedRawLines = rawLines.length > RECEIPT_TSPL_LIMITS.maxLineCount
        ? rawLines.slice(0, RECEIPT_TSPL_LIMITS.maxLineCount)
        : rawLines;

    // Escape por línea. `escapeFn` es responsable de:
    //   - transliterar/filtrar no-ASCII (ñ → n, á → a, etc.),
    //   - eliminar `"` y `\` para que TSPL no se rompa,
    //   - truncar a `columns` chars como protección de ancho visual.
    const escapedLines = limitedRawLines.map((line) => escapeFn(line, columns));

    // Alto dinámico derivado del texto. Clamp a [minHeightMm, maxHeightMm].
    const estimatedMm = topMm + Math.max(1, escapedLines.length) * lineHeightMm + bottomMm;
    const heightMm = Math.max(
        RECEIPT_TSPL_LIMITS.minHeightMm,
        Math.min(RECEIPT_TSPL_LIMITS.maxHeightMm, estimatedMm),
    );
    if (heightMm >= RECEIPT_TSPL_LIMITS.maxHeightMm) {
        // Si clampamos arriba, dejamos el batch continuar: cortar un
        // ticket demasiado alto es preferible a abortar. El llamador
        // puede inspeccionar el log si quiere diagnosticar.
    }

    // Dots derivados.
    const leftDots = mmToDots(leftMm, dpi);
    const topDots = mmToDots(topMm, dpi);
    const lineHeightDots = Math.max(1, mmToDots(lineHeightMm, dpi));

    const direction = toInt(tsplCfg.direction, 0, 1, 0);
    const mirror = toInt(tsplCfg.mirror, 0, 1, 0);

    // -- Emit TSPL ----------------------------------------------------
    const header = [
        `SIZE ${formatMm(widthMm)} mm, ${formatMm(heightMm)} mm`,
        `GAP 0 mm, 0 mm`,
        `DIRECTION ${direction},${mirror}`,
        `REFERENCE 0,0`,
        `DENSITY 8`,
        `CLS`,
    ].join("\r\n") + "\r\n";

    const bodyLines = [];
    for (let i = 0; i < escapedLines.length; i++) {
        const line = escapedLines[i];
        // Línea vacía: avanzamos y, pero no emitimos TEXT (TSPL rechaza
        // text="" en algunos firmwares). Preserva el espaciado visual.
        if (line.length === 0) continue;
        const y = topDots + i * lineHeightDots;
        bodyLines.push(
            `TEXT ${leftDots},${y},"${font}",0,${scaleX},${scaleY},"${line}"`,
        );
    }

    const trailerParts = ["PRINT 1,1"];
    const cutMode = String(cfg.cut || "").toUpperCase();
    if (cutMode === "AUTO") {
        // CUT es ignorado por firmwares sin cutter — seguro de emitir.
        trailerParts.push("CUT");
    }
    const trailer = trailerParts.join("\r\n") + "\r\n";

    const body = bodyLines.length > 0 ? bodyLines.join("\r\n") + "\r\n" : "";
    return Buffer.from(header + body + trailer, "ascii");
}

/**
 * Columnas defaults según ancho de rollo en mm. Mapea con `PAPER_COLUMNS`
 * del frontend (bridge-printing-v3.2): 58→26 (midpoint oficial para
 * font 8 scaleY 1 — reemplaza el 32→font 1 scaleY 2 que quedaba muy alto),
 * 80→48, 82→48. Se usa solo cuando `receipt.columns` no viene en el
 * payload (fallback defensivo). Un cliente antiguo que mande columns=30
 * o 32 explícitamente sigue funcionando: el ladder [4,3,8,2,1] los
 * degrada ordenadamente a font 2 y font 1 respectivamente.
 */
function pickTsplReceiptColumns(widthMm) {
    const w = Number(widthMm) || 80;
    if (w <= 50) return 24;
    if (w <= 62) return 26;   // 58mm — midpoint oficial font 8
    if (w <= 90) return 48;   // 80/82mm
    return 56;
}

// =============================================================================
// Renderer TSPL para HOJA TÉRMICA DE GÓNDOLA (bridge-printing-v3)
//
// Dedicado a `GONDOLA_FORMATS.THERMAL_80` del frontend: una etiqueta por
// producto/cantidad en rollo CONTINUO (default 80 mm × 40 mm). No se
// comparte con labels (etiquetas de producto genéricas) porque la hoja de
// estante tiene reglas propias:
//
//   * Objetivo visual: precio GRANDE y centrado por métricas (el admin
//     imprime precios de estante para que se vean desde lejos).
//   * Nombre en una o dos líneas con word-wrap, el resto se descarta.
//   * Pie: código + fecha, cada uno opcional. El código es texto plano
//     (no barcode) para evitar que la góndola luzca como etiqueta de
//     producto.
//   * Papel continuo: `GAP ${gapMm} mm, 0 mm` — default 0 (sin gap entre
//     etiquetas). `SIZE` es siempre por etiqueta porque TSPL exige un
//     `SIZE` por `PRINT`.
//   * Jamás se emiten bytes de cajón. Esta ruta NUNCA honra
//     `drawer`/`openDrawerOnSale` del payload. Es garantía dura verificada
//     por diff de bytes en los tests.
//   * Todas las cadenas pasan por `escapeFn` (típicamente `escapeForTspl`),
//     que filtra `"`, `\`, control chars y non-ASCII.
//
// Esta función es PURA: no abre sockets, no spawnea procesos, es
// idempotente para la misma entrada (salvo la fecha de pie, que depende
// del `now` que inyecta el llamador — tests usan un ISO fijo).
// =============================================================================

/**
 * Defaults canónicos para la rama `gondola.thermal` del frontend. Espejean
 * `createDefaultPrintingConfig().gondola.thermal` del SSOT; cualquier
 * campo ausente en el payload se infla desde aquí para no crashear si
 * una instalación muy vieja envía la rama incompleta.
 *
 * Diseño visual canónico (bridge-printing-v3.1 — rediseño "estante grande"):
 *
 *   ┌─────────────────────────────────────────┐
 *   │ NOMBRE PRODUCTO (hasta 2 líneas)        │
 *   │ ---------------  (BAR separador fino) --│
 *   │                                         │
 *   │             $ 3.500       (precio GRANDE│
 *   │                             centrado)   │
 *   │             PRECIO UND    (unidad corta)│
 *   │                                         │
 *   │  ‖‖‖‖‖‖‖‖‖‖  CODE128      LBL-0001     │
 *   │   (barcode izq)  (texto)   (PLU der)   │
 *   │                            2026-10-19 14:16 (fecha op.)
 *   └─────────────────────────────────────────┘
 *
 * Reglas duras del renderer:
 *   - `showBarcode` activa el BARCODE 128 abajo-izq. HRI off siempre
 *     (el PLU ya se imprime como texto, no duplicamos).
 *   - El código del barcode debe ser ASCII seguro de CODE128
 *     (0x20..0x7E, sin `"` ni `\`). Si cualquier char cae fuera, el
 *     barcode se omite PERO el PLU se preserva (el PLU usa escapeFn
 *     que translitera, así siempre hay algo legible).
 *   - El ancho del símbolo se estima por métricas de CODE128 y jamás
 *     excede `printableWidthMm` (menos espacio reservado para el stack
 *     derecho PLU+fecha). Si al narrow configurado no cabe, baja a
 *     narrow=1; si aún no cabe, el barcode se omite.
 *   - Precio centrado por métricas (X/Y calculados), formato COP.
 *   - DIRECTION 0,0 default (REFERENCE 0,0 siempre). Jamás se emiten
 *     bytes de cajón (`drawer` del payload se ignora en esta rama).
 */
const SHELF_THERMAL_DEFAULTS = Object.freeze({
    // Rollo continuo 80 × 40 (default). Rango 20..82 × 20..200.
    widthMm: 80,
    printableWidthMm: 76,
    heightMm: 40,
    // Márgenes.
    marginLeftMm: 2,
    marginTopMm: 2,
    marginBottomMm: 2,
    // Impresión.
    gapMm: 0,            // continuo
    direction: 0,
    mirror: 0,
    density: 8,          // 0..15 (TSPL DENSITY)
    dpi: 203,
    // Tipografía — nombre arriba.
    nameFont: "3",
    nameScaleX: 1,
    nameScaleY: 1,
    nameMaxChars: 24,
    // Tipografía — precio dominante centrado.
    priceFont: "4",
    priceScaleX: 2,
    priceScaleY: 2,
    // Unidad / literal corto bajo el precio (ej. "PRECIO UND").
    showUnitLabel: true,
    unitLabel: "PRECIO UND",
    unitLabelFont: "2",
    unitLabelScaleX: 1,
    unitLabelScaleY: 1,
    unitLabelMaxChars: 20,
    // Separador fino entre nombre y precio (BAR TSPL).
    showSeparator: true,
    separatorThicknessDots: 2,
    separatorGapDots: 3,
    // Pie: código visible como texto a la derecha (PLU) + fecha opcional.
    showCode: true,
    showDate: true,
    footerFont: "1",
    footerScaleX: 1,
    footerScaleY: 1,
    // Barcode CODE128 abajo-izq.
    showBarcode: true,
    barcodeHeightMm: 10,
    barcodeNarrow: 2,
    barcodeWide: 2,
    barcodeMaxChars: 24,
});

/**
 * Infla defaults faltantes y clampa fuentes/escalas a sus rangos duros.
 *
 * Importante: el bridge NO re-sanea las dimensiones (widthMm, heightMm,
 * printableWidthMm, márgenes, gap, dpi): el frontend es la frontera de
 * saneado. Si una dimensión fuera de rango se cuela, la validación
 * posterior (`LAYOUT_OUT_OF_BOUNDS` / `INVALID_SHELF_CONFIG`) la rechaza
 * sin intentar "arreglar" el payload.
 *
 * Las fuentes TSPL (`nameFont`/`priceFont`/`footerFont`) sí se clampan
 * al rango 1..8 vía `toTsplBuiltinFont`, porque un string arbitrario
 * en un `TEXT ...,"<font>",...` rompería el batch TSPL completo.
 */
function normalizeShelfThermalConfig(thermal) {
    const src = isPlainObject(thermal) ? thermal : {};
    const d = SHELF_THERMAL_DEFAULTS;
    // `barcodeHeightMm` se topa a 40mm (margen amplio para rollos pequeños)
    // y a 60mm (techo compartido con BOUNDS.barcodeHeightMm del frontend).
    // El validador duro de `buildTsplShelfLabelsDocument` igual rechaza
    // alturas incoherentes con `heightMm` (barcode no puede exceder el área
    // disponible una vez descontados márgenes + nombre + separador + precio).
    return {
        widthMm: toNumber(src.widthMm, d.widthMm),
        printableWidthMm: toNumber(src.printableWidthMm, d.printableWidthMm),
        heightMm: toNumber(src.heightMm, d.heightMm),
        marginLeftMm: Math.max(0, toNumber(src.marginLeftMm, d.marginLeftMm)),
        marginTopMm: Math.max(0, toNumber(src.marginTopMm, d.marginTopMm)),
        marginBottomMm: Math.max(0, toNumber(src.marginBottomMm, d.marginBottomMm)),
        gapMm: Math.max(0, toNumber(src.gapMm, d.gapMm)),
        direction: src.direction === 1 ? 1 : 0,
        mirror: src.mirror === 1 ? 1 : 0,
        density: toInt(src.density, 0, 15, d.density),
        dpi: toNumber(src.dpi, d.dpi) > 0 ? toNumber(src.dpi, d.dpi) : d.dpi,
        nameFont: toTsplBuiltinFont(src.nameFont, d.nameFont),
        nameScaleX: toInt(src.nameScaleX, 1, 10, d.nameScaleX),
        nameScaleY: toInt(src.nameScaleY, 1, 10, d.nameScaleY),
        nameMaxChars: toInt(src.nameMaxChars, 1, 60, d.nameMaxChars),
        priceFont: toTsplBuiltinFont(src.priceFont, d.priceFont),
        priceScaleX: toInt(src.priceScaleX, 1, 10, d.priceScaleX),
        priceScaleY: toInt(src.priceScaleY, 1, 10, d.priceScaleY),
        showUnitLabel: src.showUnitLabel === false
            ? false
            : (src.showUnitLabel === true ? true : d.showUnitLabel),
        unitLabel: typeof src.unitLabel === "string" && src.unitLabel.length > 0
            ? src.unitLabel.slice(0, 32)
            : d.unitLabel,
        unitLabelFont: toTsplBuiltinFont(src.unitLabelFont, d.unitLabelFont),
        unitLabelScaleX: toInt(src.unitLabelScaleX, 1, 10, d.unitLabelScaleX),
        unitLabelScaleY: toInt(src.unitLabelScaleY, 1, 10, d.unitLabelScaleY),
        unitLabelMaxChars: toInt(src.unitLabelMaxChars, 1, 60, d.unitLabelMaxChars),
        showSeparator: src.showSeparator === false
            ? false
            : (src.showSeparator === true ? true : d.showSeparator),
        separatorThicknessDots: toInt(
            src.separatorThicknessDots, 1, 20, d.separatorThicknessDots,
        ),
        separatorGapDots: toInt(
            src.separatorGapDots, 0, 20, d.separatorGapDots,
        ),
        showCode: src.showCode === false ? false : (src.showCode === true ? true : d.showCode),
        showDate: src.showDate === false ? false : (src.showDate === true ? true : d.showDate),
        footerFont: toTsplBuiltinFont(src.footerFont, d.footerFont),
        footerScaleX: toInt(src.footerScaleX, 1, 10, d.footerScaleX),
        footerScaleY: toInt(src.footerScaleY, 1, 10, d.footerScaleY),
        showBarcode: src.showBarcode === false
            ? false
            : (src.showBarcode === true ? true : d.showBarcode),
        // 2..60mm: 2mm es el piso útil (código ilegible por debajo), 60mm
        // es el techo compartido con BOUNDS.barcodeHeightMm del frontend.
        barcodeHeightMm: Math.max(2, Math.min(60,
            toNumber(src.barcodeHeightMm, d.barcodeHeightMm))),
        barcodeNarrow: toInt(src.barcodeNarrow, 1, 8, d.barcodeNarrow),
        barcodeWide: toInt(src.barcodeWide, 1, 8, d.barcodeWide),
        barcodeMaxChars: toInt(src.barcodeMaxChars, 4, 48, d.barcodeMaxChars),
    };
}

/**
 * Envuelve `text` en 1 ó 2 líneas de ≤ `maxChars` cada una, por palabra.
 * El resto se descarta — una etiqueta de estante no es un ticket de
 * tirada media. Si la primera palabra ya excede `maxChars`, hace un corte
 * duro de ≤ `maxChars` caracteres.
 *
 * No hace escape: el llamador escapa después (necesitamos conocer la
 * longitud visual del nombre ANTES de posicionarlo).
 */
function wrapNameTwoLines(text, maxChars) {
    const str = typeof text === "string" ? text : (text == null ? "" : String(text));
    const trimmed = str.replace(/\s+/g, " ").trim();
    if (!trimmed) return [];
    const limit = Math.max(1, Math.round(Number(maxChars) || 1));
    if (trimmed.length <= limit) return [trimmed];
    const words = trimmed.split(" ");
    const line1Words = [];
    let line1Len = 0;
    let i = 0;
    while (i < words.length) {
        const w = words[i];
        const extra = line1Len > 0 ? 1 + w.length : w.length;
        if (line1Len + extra > limit) break;
        line1Words.push(w);
        line1Len += extra;
        i++;
    }
    if (line1Words.length === 0) {
        // Primera palabra más larga que el límite: cortes duros.
        const line1 = trimmed.slice(0, limit);
        const line2 = trimmed.slice(limit, 2 * limit);
        return line2.length > 0 ? [line1, line2] : [line1];
    }
    const line1 = line1Words.join(" ");
    const line2Raw = words.slice(i).join(" ");
    if (!line2Raw) return [line1];
    const line2 = line2Raw.length > limit ? line2Raw.slice(0, limit) : line2Raw;
    return [line1, line2];
}

/**
 * Formato de fecha para el pie de la etiqueta de estante. Acepta `Date`,
 * ISO 8601, timestamp numérico, o `undefined` (usa `new Date()`).
 *
 * Formato: `YYYY-MM-DD HH:MM` en zona local del bridge — es la hora de
 * la máquina que imprime, no la del cliente, y evita suposiciones de TZ.
 * ASCII puro, nunca requiere escape adicional.
 */
function formatShelfDate(now) {
    let d;
    if (now instanceof Date) d = now;
    else if (typeof now === "string" && now.length > 0) d = new Date(now);
    else if (typeof now === "number" && Number.isFinite(now)) d = new Date(now);
    else d = new Date();
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// -----------------------------------------------------------------------------
// CODE128 — validación y métrica de ancho para shelf-labels.
//
// TSPL `BARCODE X,Y,"128",height,hri,rotation,narrow,wide,"data"` acepta
// cualquier ASCII imprimible como `data`, pero:
//   * `"` y `\` romperían el string literal del comando TSPL.
//   * Chars de control (< 0x20) o 0x7F+ no son representables por CODE128B
//     y el firmware los pintaría como ruido.
//   * Un código vacío no genera símbolo válido.
//
// Las medidas de ancho son conservadoras: usamos la fórmula CODE128
// estándar (11 modules por carácter + 11 start + 11 check + 13 stop +
// 2 × 10 quiet zone = 11n + 55 modules). El ancho real del símbolo
// es `(11n + 55) × narrow` dots. El `wide` no cambia el ancho total
// porque CODE128 modula el ancho de bar/space entre 1..4 módulos
// usando combinaciones; `narrow` es el tamaño del módulo mínimo.
// -----------------------------------------------------------------------------

/**
 * Verifica que `code` sea representable por CODE128 Set B sin romper
 * el string literal TSPL. Devuelve `true` si todos los chars están en
 * ASCII imprimible 0x20..0x7E y no incluyen `"` ni `\`.
 */
function isCode128SafeAscii(code, maxLen) {
    if (typeof code !== "string" || code.length === 0) return false;
    const limit = Number.isFinite(maxLen) && maxLen > 0 ? maxLen : 48;
    if (code.length > limit) return false;
    for (let i = 0; i < code.length; i++) {
        const c = code.charCodeAt(i);
        if (c < 0x20 || c > 0x7E) return false;
        if (c === 0x22 /* " */ || c === 0x5C /* \ */) return false;
    }
    return true;
}

/**
 * Estima el ancho total en dots de un símbolo CODE128 con `nChars` chars
 * de datos y `narrow` dots por módulo.
 *
 *   modules = 11 start + 11 × nChars + 11 check + 13 stop + 20 quiet zones
 *           = 11 × nChars + 55
 *   widthDots = modules × narrow
 *
 * Nota: TSPL maneja internamente la decisión Set B / Set C (digit pairs),
 * así que esto es el peor caso (Set B). Si el firmware opta por Set C,
 * el símbolo real sale más corto — nunca más largo que esta estimación.
 */
function code128SymbolWidthDots(nChars, narrow) {
    const n = Math.max(1, Math.round(Number(nChars) || 0));
    const nw = Math.max(1, Math.round(Number(narrow) || 1));
    return (11 * n + 55) * nw;
}

// -----------------------------------------------------------------------------

/**
 * Construye el documento TSPL para hoja térmica de góndola.
 *
 * @param {object} options
 * @param {Array<{code,productName,salePrice,quantity}>} options.items
 * @param {object} options.thermal           `GondolaThermalConfig` saneado
 *                                           por el frontend. Si falta,
 *                                           infla defaults (BC).
 * @param {Function} options.escapeFn        `(text, maxLen) => safeAscii`.
 * @param {Function} [options.formatMoney]   Formateador de precio.
 * @param {Date|string|number} [options.now] Fecha para el pie.
 * @param {number} [options.physicalMaxMm]   Techo físico (default 82mm).
 * @returns {Buffer} ASCII con el batch TSPL completo.
 *
 * Lanza `Error` con `.code`:
 *   - `LAYOUT_OUT_OF_BOUNDS` si `widthMm > physicalMaxMm` o si
 *     `marginLeftMm + printableWidthMm > widthMm`.
 *   - `INVALID_SHELF_CONFIG` si `escapeFn` no es función, `widthMm < 20`,
 *     `heightMm` fuera de 20..200, o `printableWidthMm <= 0`.
 *   - `NO_LABELS` si `items` vacío.
 *   - `TOO_MANY_LABELS` si el aplanado por `quantity` excede los límites
 *     de defensa en profundidad (`LIMITS.maxLabelItems * maxLabelQuantity`
 *     del bridge: 50 000). El bridge ya valida esto en
 *     `normalizeLabelItems`; aquí es cinturón y tirantes.
 */
function buildTsplShelfLabelsDocument(options) {
    const {
        items,
        thermal,
        escapeFn,
        formatMoney: formatMoneyFn,
        now,
        physicalMaxMm,
    } = options || {};

    if (typeof escapeFn !== "function") {
        const err = new Error("escapeFn requerido para shelf-labels");
        err.code = LABEL_ERR.INVALID_SHELF_CONFIG;
        throw err;
    }

    const money = typeof formatMoneyFn === "function"
        ? formatMoneyFn
        : (n) => String(Math.round(Number(n) || 0));

    const cfg = normalizeShelfThermalConfig(thermal);
    const physMax = toNumber(physicalMaxMm, PHYSICAL_MAX_MM);

    // --- Validaciones duras -------------------------------------------
    if (!Number.isFinite(cfg.widthMm) || cfg.widthMm > physMax) {
        const err = new Error(
            `shelf widthMm=${cfg.widthMm} excede el techo físico ${physMax}mm`,
        );
        err.code = LABEL_ERR.LAYOUT_OUT_OF_BOUNDS;
        throw err;
    }
    if (cfg.widthMm < 20) {
        const err = new Error(`shelf widthMm=${cfg.widthMm} < 20mm`);
        err.code = LABEL_ERR.INVALID_SHELF_CONFIG;
        throw err;
    }
    if (!Number.isFinite(cfg.heightMm) || cfg.heightMm < 20 || cfg.heightMm > 200) {
        const err = new Error(`shelf heightMm=${cfg.heightMm} fuera de 20..200`);
        err.code = LABEL_ERR.INVALID_SHELF_CONFIG;
        throw err;
    }
    if (!Number.isFinite(cfg.printableWidthMm) || cfg.printableWidthMm <= 0) {
        const err = new Error(`shelf printableWidthMm inválido: ${cfg.printableWidthMm}`);
        err.code = LABEL_ERR.INVALID_SHELF_CONFIG;
        throw err;
    }
    if (cfg.marginLeftMm + cfg.printableWidthMm > cfg.widthMm) {
        const err = new Error(
            `marginLeft(${cfg.marginLeftMm}) + printable(${cfg.printableWidthMm}) > width(${cfg.widthMm})`,
        );
        err.code = LABEL_ERR.LAYOUT_OUT_OF_BOUNDS;
        throw err;
    }

    if (!Array.isArray(items) || items.length === 0) {
        const err = new Error("sin items para shelf-labels");
        err.code = LABEL_ERR.NO_LABELS;
        throw err;
    }

    const flat = flattenLabelItems(items);
    if (flat.length === 0) {
        const err = new Error("items aplanados vacíos");
        err.code = LABEL_ERR.NO_LABELS;
        throw err;
    }
    // Defensa en profundidad: `normalizeLabelItems` del bridge ya corta
    // en 500 items × 100 copias = 50 000. Si un llamador externo salta
    // esa validación, nos protegemos acá antes de serializar algo que
    // podría saturar la cola de impresión.
    if (flat.length > 50000) {
        const err = new Error(`demasiadas etiquetas aplanadas: ${flat.length}`);
        err.code = LABEL_ERR.TOO_MANY_LABELS;
        throw err;
    }

    // --- Métricas en dots --------------------------------------------
    const dpi = cfg.dpi;
    const printableDots = mmToDots(cfg.printableWidthMm, dpi);
    const marginLeftDots = mmToDots(cfg.marginLeftMm, dpi);
    const marginTopDots = mmToDots(cfg.marginTopMm, dpi);
    const marginBottomDots = mmToDots(cfg.marginBottomMm, dpi);
    const heightDots = mmToDots(cfg.heightMm, dpi);

    const nameMetrics = TSPL_FONT_METRICS[cfg.nameFont] || TSPL_FONT_METRICS["3"];
    const priceMetrics = TSPL_FONT_METRICS[cfg.priceFont] || TSPL_FONT_METRICS["4"];
    const footerMetrics = TSPL_FONT_METRICS[cfg.footerFont] || TSPL_FONT_METRICS["1"];
    const unitMetrics = TSPL_FONT_METRICS[cfg.unitLabelFont] || TSPL_FONT_METRICS["2"];

    const nameLineHeight = (nameMetrics.heightDots + 4) * cfg.nameScaleY;
    const nameGlyphWidth = nameMetrics.widthDots * cfg.nameScaleX;
    const priceGlyphWidth = priceMetrics.widthDots * cfg.priceScaleX;
    const priceGlyphHeight = priceMetrics.heightDots * cfg.priceScaleY;
    const unitGlyphWidth = unitMetrics.widthDots * cfg.unitLabelScaleX;
    const unitGlyphHeight = unitMetrics.heightDots * cfg.unitLabelScaleY;
    const footerGlyphWidth = footerMetrics.widthDots * cfg.footerScaleX;
    const footerGlyphHeight = footerMetrics.heightDots * cfg.footerScaleY;

    const barcodeHeightDots = mmToDots(cfg.barcodeHeightMm, dpi);

    // Cuántos caracteres caben físicamente en una línea de printable:
    // sirve de tope visual encima de `nameMaxChars` (si el admin pone un
    // nameMaxChars muy generoso pero la etiqueta es estrecha, cortamos
    // por geometría real).
    const maxCharsOnLine = Math.max(
        1,
        Math.floor(printableDots / Math.max(1, nameGlyphWidth)),
    );
    const effectiveNameMax = Math.min(cfg.nameMaxChars, maxCharsOnLine);

    // Fecha para el footer: se calcula una vez por documento.
    const dateStr = cfg.showDate ? formatShelfDate(now) : "";

    // --- Cabecera del documento (una vez, antes del primer CLS) ------
    const header = [
        `SIZE ${formatMm(cfg.widthMm)} mm, ${formatMm(cfg.heightMm)} mm`,
        `GAP ${formatMm(cfg.gapMm)} mm, 0 mm`,
        `DIRECTION ${cfg.direction},${cfg.mirror}`,
        `REFERENCE 0,0`,
        `DENSITY ${cfg.density}`,
    ].join("\r\n") + "\r\n";

    const chunks = [header];
    for (const item of flat) {
        chunks.push(buildShelfLabelBlock({
            item,
            cfg,
            dpi,
            printableDots,
            marginLeftDots,
            marginTopDots,
            marginBottomDots,
            heightDots,
            nameLineHeight,
            priceGlyphWidth,
            priceGlyphHeight,
            unitGlyphWidth,
            unitGlyphHeight,
            footerGlyphWidth,
            footerGlyphHeight,
            barcodeHeightDots,
            effectiveNameMax,
            dateStr,
            escapeFn,
            money,
        }));
    }

    return Buffer.from(chunks.join(""), "ascii");
}

/**
 * Emite el bloque TSPL de UNA etiqueta de estante con el layout canónico
 * `bridge-printing-v3.1`:
 *
 *   CLS
 *   TEXT nombre línea 1
 *   TEXT nombre línea 2         (si hay wrap a 2 líneas)
 *   BAR  separador fino          (si showSeparator)
 *   TEXT precio GRANDE centrado  (si salePrice > 0 tras escapar)
 *   TEXT unidad "PRECIO UND"    (si showUnitLabel)
 *   BARCODE 128 abajo-izq       (si showBarcode y código CODE128-safe)
 *   TEXT PLU abajo-derecha      (si showCode y code presente)
 *   TEXT fecha arriba del PLU   (si showDate y dateStr presente)
 *   PRINT 1,1
 *
 * Reglas de layout:
 *   * Nombre fijo arriba, máximo 2 líneas con `wrapNameTwoLines`.
 *   * Separador BAR a `separatorThicknessDots` de alto, ancho =
 *     `printableWidthDots`. Opcional.
 *   * Pie: 2 bandas horizontales desde `heightDots - marginBottom`:
 *       - Barcode a la izq. Alto = `barcodeHeightDots`.
 *       - Stack derecha: PLU abajo + fecha arriba del PLU (ambos opt).
 *   * Precio: centrado horizontal por métricas; vertical en el espacio
 *     intermedio entre fin de nombre/separador y techo de la banda pie.
 *   * Unidad: centrada horizontal, justo debajo del precio.
 *
 * Las coordenadas X salen directamente de la geometría (sin confiar en
 * centrado del firmware) para que el output sea determinista entre
 * modelos de impresora. Nunca se emite BARCODE con HRI (el PLU está
 * duplicado como texto a la derecha).
 */
function buildShelfLabelBlock(ctx) {
    const {
        item, cfg, dpi,
        printableDots, marginLeftDots, marginTopDots, marginBottomDots, heightDots,
        nameLineHeight,
        priceGlyphWidth, priceGlyphHeight,
        unitGlyphWidth, unitGlyphHeight,
        footerGlyphWidth, footerGlyphHeight,
        barcodeHeightDots,
        effectiveNameMax, dateStr, escapeFn, money,
    } = ctx;

    const lines = ["CLS"];

    // --- Nombre: 1 ó 2 líneas, escapado por línea.
    const nameRaw = typeof item.productName === "string" ? item.productName : "";
    const nameWrapped = wrapNameTwoLines(nameRaw, effectiveNameMax);
    const nameEscapedLines = nameWrapped
        .map((ln) => escapeFn(ln, effectiveNameMax))
        .filter((ln) => ln.length > 0);
    for (let li = 0; li < nameEscapedLines.length; li++) {
        const ne = nameEscapedLines[li];
        const nameY = marginTopDots + li * nameLineHeight;
        lines.push(
            `TEXT ${marginLeftDots},${nameY},"${cfg.nameFont}",0,${cfg.nameScaleX},${cfg.nameScaleY},"${ne}"`,
        );
    }
    const nameBlockEndY = marginTopDots + nameEscapedLines.length * nameLineHeight;

    // --- Separador fino (BAR): sólo si showSeparator y hubo nombre.
    let afterSeparatorY = nameBlockEndY;
    if (cfg.showSeparator && nameEscapedLines.length > 0) {
        const sepTopY = nameBlockEndY + cfg.separatorGapDots;
        const sepThickness = Math.max(1, cfg.separatorThicknessDots);
        // BAR X,Y,width,height → rectángulo lleno. Ancho = printableDots
        // para que ocupe TODO el ancho útil. Nunca excede el margen.
        lines.push(
            `BAR ${marginLeftDots},${sepTopY},${printableDots},${sepThickness}`,
        );
        afterSeparatorY = sepTopY + sepThickness + cfg.separatorGapDots;
    }

    // --- Banda pie: altura reservada para el barcode (si aplica) y
    //     el stack derecho (PLU + opcional fecha).
    const rightStackHeight = (cfg.showCode ? footerGlyphHeight : 0)
        + ((cfg.showDate && dateStr.length > 0)
            ? footerGlyphHeight + Math.max(2, Math.floor(footerGlyphHeight / 4))
            : 0);
    const codeRaw = typeof item.code === "string" ? item.code : "";
    const canEmitBarcode = cfg.showBarcode
        && isCode128SafeAscii(codeRaw, cfg.barcodeMaxChars);
    const barcodeBandHeight = canEmitBarcode ? barcodeHeightDots : 0;
    const footerBandHeight = Math.max(barcodeBandHeight, rightStackHeight);
    const footerTopY = heightDots - marginBottomDots - footerBandHeight;
    const barcodeTopY = heightDots - marginBottomDots - barcodeBandHeight;

    // --- Precio: centrado horizontal por métricas y vertical en el área
    //     entre `afterSeparatorY` y `footerTopY - 2` dots de aire.
    const salePriceValue = Number(item.salePrice);
    let priceEndY = afterSeparatorY;
    if (Number.isFinite(salePriceValue) && salePriceValue > 0) {
        const priceSrc = `$ ${money(salePriceValue)}`;
        const priceEscaped = escapeFn(priceSrc, 32);
        if (priceEscaped.length > 0) {
            const priceWidthDots = priceEscaped.length * priceGlyphWidth;
            let priceX = marginLeftDots + Math.max(
                0,
                Math.floor((printableDots - priceWidthDots) / 2),
            );
            if (priceWidthDots > printableDots) priceX = marginLeftDots;
            // Reserva de aire antes del footer (2mm o lo que quepa).
            const breathingDots = Math.min(
                mmToDots(2, dpi),
                Math.max(0, footerTopY - afterSeparatorY),
            );
            const middleStart = afterSeparatorY;
            const unitReserveY = (cfg.showUnitLabel && cfg.unitLabel)
                ? unitGlyphHeight + 2
                : 0;
            const middleEnd = Math.max(middleStart,
                footerTopY - breathingDots - unitReserveY);
            let priceY;
            if (middleEnd > middleStart + priceGlyphHeight) {
                priceY = middleStart + Math.floor(
                    (middleEnd - middleStart - priceGlyphHeight) / 2,
                );
            } else {
                priceY = middleStart;
            }
            lines.push(
                `TEXT ${priceX},${priceY},"${cfg.priceFont}",0,${cfg.priceScaleX},${cfg.priceScaleY},"${priceEscaped}"`,
            );
            priceEndY = priceY + priceGlyphHeight;
        }
    }

    // --- Unidad "PRECIO UND" (o literal corto del admin): centrada,
    //     justo debajo del precio. Omitida si showUnitLabel=false o si
    //     después del escape queda vacía.
    if (cfg.showUnitLabel && cfg.unitLabel) {
        const unitEscaped = escapeFn(cfg.unitLabel, cfg.unitLabelMaxChars);
        if (unitEscaped.length > 0) {
            const unitWidthDots = unitEscaped.length * unitGlyphWidth;
            let unitX = marginLeftDots + Math.max(
                0,
                Math.floor((printableDots - unitWidthDots) / 2),
            );
            if (unitWidthDots > printableDots) unitX = marginLeftDots;
            // Y: 2 dots debajo del precio (si lo hubo), clampado para no
            // invadir la banda del pie.
            let unitY = priceEndY + 2;
            const maxUnitY = footerTopY - unitGlyphHeight - 1;
            if (unitY > maxUnitY) unitY = Math.max(afterSeparatorY, maxUnitY);
            if (unitY + unitGlyphHeight <= heightDots - marginBottomDots) {
                lines.push(
                    `TEXT ${unitX},${unitY},"${cfg.unitLabelFont}",0,${cfg.unitLabelScaleX},${cfg.unitLabelScaleY},"${unitEscaped}"`,
                );
            }
        }
    }

    // --- Barcode CODE128 abajo-izquierda. HRI off (0) porque el PLU
    //     ya se imprime como texto a la derecha. Ancho estimado por
    //     métricas CODE128; si no cabe con el narrow configurado, baja
    //     a narrow=1; si aún excede, se omite (y el PLU se preserva).
    if (canEmitBarcode) {
        // Reserva horizontal para el stack derecho (PLU + fecha).
        const pluWidthDots = cfg.showCode
            ? Math.min(codeRaw.length, 16) * footerGlyphWidth
            : 0;
        const dateWidthDots = (cfg.showDate && dateStr.length > 0)
            ? dateStr.length * footerGlyphWidth
            : 0;
        const rightReserve = Math.max(pluWidthDots, dateWidthDots);
        const gapToRight = rightReserve > 0 ? mmToDots(2, dpi) : 0;
        const maxBarcodeWidth = Math.max(0, printableDots - rightReserve - gapToRight);

        let narrow = cfg.barcodeNarrow;
        let wide = cfg.barcodeWide;
        let estWidth = code128SymbolWidthDots(codeRaw.length, narrow);
        if (estWidth > maxBarcodeWidth && narrow > 1) {
            narrow = 1;
            wide = 1;
            estWidth = code128SymbolWidthDots(codeRaw.length, narrow);
        }
        if (estWidth <= maxBarcodeWidth && barcodeHeightDots > 0) {
            // El código ya fue validado por `isCode128SafeAscii` (sin
            // `"` ni `\` ni control chars), así que es seguro embeberlo
            // directamente entre comillas sin re-escapar.
            lines.push(
                `BARCODE ${marginLeftDots},${barcodeTopY},"128",${barcodeHeightDots},0,0,${narrow},${wide},"${codeRaw}"`,
            );
        }
    }

    // --- Stack derecho: PLU abajo + fecha opcional arriba del PLU.
    const rightEdge = marginLeftDots + printableDots;
    const pluBaselineY = heightDots - marginBottomDots - footerGlyphHeight;
    if (cfg.showCode) {
        const codeEscaped = escapeFn(codeRaw, 48);
        if (codeEscaped.length > 0) {
            const pluWidthDots = codeEscaped.length * footerGlyphWidth;
            const pluX = Math.max(marginLeftDots, rightEdge - pluWidthDots);
            lines.push(
                `TEXT ${pluX},${pluBaselineY},"${cfg.footerFont}",0,${cfg.footerScaleX},${cfg.footerScaleY},"${codeEscaped}"`,
            );
        }
    }
    if (cfg.showDate && dateStr.length > 0) {
        const dateEscaped = escapeFn(dateStr, 32);
        if (dateEscaped.length > 0) {
            const dateWidthDots = dateEscaped.length * footerGlyphWidth;
            const dateX = Math.max(marginLeftDots, rightEdge - dateWidthDots);
            // Fecha va arriba del PLU, con pequeño gap. Si no hay PLU,
            // la fecha sola queda alineada abajo-derecha.
            const dateY = cfg.showCode
                ? Math.max(0, pluBaselineY - footerGlyphHeight - Math.max(2, Math.floor(footerGlyphHeight / 4)))
                : pluBaselineY;
            lines.push(
                `TEXT ${dateX},${dateY},"${cfg.footerFont}",0,${cfg.footerScaleX},${cfg.footerScaleY},"${dateEscaped}"`,
            );
        }
    }

    lines.push("PRINT 1,1");
    return lines.join("\r\n") + "\r\n";
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    DPI_203,
    DOTS_PER_MM_203,
    PHYSICAL_MAX_MM,
    TSPL_BUILTIN_FONTS,
    TSPL_FONT_METRICS,
    TSPL_RECEIPT_FONT_LADDER,
    LABEL_ERR,
    LABEL_PRESETS,
    RECEIPT_TSPL_LIMITS,
    SHELF_THERMAL_DEFAULTS,
    mmToDots,
    computeColumnOffsets,
    flattenLabelItems,
    buildRows,
    normalizeLabelsConfig,
    normalizeShelfThermalConfig,
    sanitizeEan13,
    computeEan13CheckDigit,
    buildTsplDocument,
    buildTsplTestPage,
    buildTsplReceiptDocument,
    buildTsplShelfLabelsDocument,
    tsplLineHeightMm,
    pickTsplReceiptFont,
    pickTsplReceiptColumns,
    formatShelfDate,
    wrapNameTwoLines,
    isCode128SafeAscii,
    code128SymbolWidthDots,
    // Expuestos sólo para tests internos. No forman parte del contrato público.
    _internals: { formatMm, buildTsplRow, appendItemCommands, buildShelfLabelBlock },
};
