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

module.exports = {
    DPI_203,
    DOTS_PER_MM_203,
    PHYSICAL_MAX_MM,
    TSPL_BUILTIN_FONTS,
    LABEL_ERR,
    LABEL_PRESETS,
    mmToDots,
    computeColumnOffsets,
    flattenLabelItems,
    buildRows,
    normalizeLabelsConfig,
    sanitizeEan13,
    computeEan13CheckDigit,
    buildTsplDocument,
    buildTsplTestPage,
    // Expuestos sólo para tests internos. No forman parte del contrato público.
    _internals: { formatMm, buildTsplRow, appendItemCommands },
};
