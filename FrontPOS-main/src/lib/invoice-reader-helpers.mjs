// Helpers puros del lector de facturas (OCR). Viven en .mjs para poder
// probarse con `node --test` sin DOM ni Next.js.
//
// Contrato con el backend Go:
//   - `normalizeExtractedItem` del backend ya resuelve la precedencia
//     porcentaje/monto del descuento y deja `discount_percentage` como única
//     fuente de verdad en [0, 100]. `discount_value` queda en 0 por invariante.
//   - `splitBonusItems` del backend ya separa las promociones "pague X lleve Y"
//     en una línea REGULAR + una BONUS con precio 0.
//   - Los porcentajes IVA/IBUA/ICUI vienen con la jerarquía: lo que extrajo
//     Claude de la factura prevalece sobre el producto base cuando > 0.
//
// Este módulo se limita a aplicar un clamp defensivo y añadir una identidad
// local estable para que el carrito y el reviewer puedan deduplicar y navegar
// sin colisionar en facturas con nombres repetidos.

const PCT_MIN = 0;
const PCT_MAX = 100;

/**
 * Clamp a [0, 100] con tolerancia a NaN, undefined y strings. Devuelve 0
 * cuando el valor no es un número finito positivo o cuando < 0.
 */
export function clampPercentage(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= PCT_MIN) return 0;
  if (n > PCT_MAX) return PCT_MAX;
  return n;
}

/**
 * Normaliza un `line_type` arbitrario a UPPERCASE si es string. Mantiene el
 * valor original (null/undefined) cuando no es string para no inventar
 * metadata que el backend no produjo.
 */
export function normalizeLineType(lineType) {
  if (typeof lineType !== 'string') return lineType;
  const upper = lineType.toUpperCase().trim();
  if (upper === 'REGULAR' || upper === 'BONUS' || upper === 'RETURN') return upper;
  return upper;
}

/**
 * `bonus_quantity` sólo tiene sentido como entero positivo. Cualquier otro
 * valor (negativo, NaN, string vacío) colapsa a 0 para que las ramas de
 * BONUS no se activen por accidente.
 */
export function sanitizeBonusQuantity(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * Genera un identificador local estable para cada item devuelto por el OCR.
 *
 * Importante porque:
 *   - El reviewer utiliza este id para "Volver" sin colisionar cuando dos
 *     items distintos comparten el mismo invoiceName (típico en facturas con
 *     saltos de página o líneas BONUS que se repiten).
 *   - El carrito de recepción puede deduplicar updates sucesivos de la misma
 *     línea sin tener que depender del `barcode` (que falta en los items no
 *     emparejados).
 *
 * La identidad es ÚNICA por sesión de OCR: no se persiste.
 */
export function makeOcrLocalId(prefix = 'ocr') {
  const rnd = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `${prefix}-${ts}-${rnd}`;
}

/**
 * Normaliza un item OCR del backend al shape que consume el frontend.
 * Aplica:
 *   - clamp defensivo de todos los porcentajes (IVA, IBUA, ICUI, descuento)
 *   - UPPERCASE del `line_type`
 *   - entero positivo o 0 en `bonus_quantity`
 *   - identidad local estable (__ocrLocalId) si no venía.
 *
 * NUNCA inventa valores monetarios ni defaults de impuestos: la jerarquía
 * fiscal ya la aplicó el backend. Lo que entra con 0 explícito, sale con 0.
 */
export function fillInvoiceItemDefaults(item) {
  if (!item || typeof item !== 'object') {
    return { __ocrLocalId: makeOcrLocalId() };
  }
  const normalized = { ...item };
  normalized.iva_percentage = clampPercentage(item.iva_percentage);
  normalized.ibua_percentage = clampPercentage(item.ibua_percentage);
  normalized.icui_percentage = clampPercentage(item.icui_percentage);
  normalized.discount_percentage = clampPercentage(item.discount_percentage);
  normalized.line_type = normalizeLineType(item.line_type);
  normalized.bonus_quantity = sanitizeBonusQuantity(item.bonus_quantity);
  if (!normalized.__ocrLocalId || typeof normalized.__ocrLocalId !== 'string') {
    normalized.__ocrLocalId = makeOcrLocalId();
  }
  return normalized;
}

/**
 * Tamaño máximo en bytes que aceptamos subir al endpoint OCR. 10 MB es el
 * techo pragmático: por encima el canvas comprime demasiado y el payload JSON
 * puede bloquear la pestaña del navegador. El backend también rechaza > 15 MB.
 */
export const INVOICE_FILE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Decide si un archivo seleccionado puede subirse al OCR. Retorna un objeto
 * con `ok: boolean` y, cuando no, un `reason` humano para mostrar en toast.
 *
 * Lo exportamos para que los tests contractuales validen límites sin tener que
 * cargar el componente React.
 */
export function validateInvoiceFile(file, { maxBytes = INVOICE_FILE_MAX_BYTES } = {}) {
  if (!file || typeof file !== 'object') {
    return { ok: false, reason: 'empty', message: 'No se recibio ningun archivo.' };
  }
  const type = typeof file.type === 'string' ? file.type : '';
  if (!type.startsWith('image/')) {
    return { ok: false, reason: 'bad-type', message: 'Por favor, selecciona una imagen (JPG o PNG).' };
  }
  const size = Number(file.size) || 0;
  if (size > maxBytes) {
    const mb = (size / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      reason: 'too-large',
      message: `La foto pesa ${mb} MB. El limite es ${Math.round(maxBytes / (1024 * 1024))} MB.`,
    };
  }
  return { ok: true };
}

/**
 * Resuelve el `entryType` del carrito a partir del `line_type` del OCR.
 * Expuesto como helper puro para que page.tsx y los tests coincidan en la
 * misma tabla de verdad:
 *   BONUS  → gift
 *   RETURN → return
 *   resto  → purchase
 */
export function entryTypeFromLineType(lineType) {
  const normalized = typeof lineType === 'string' ? lineType.toUpperCase() : '';
  if (normalized === 'BONUS') return 'gift';
  if (normalized === 'RETURN') return 'return';
  return 'purchase';
}

/**
 * Dadas las flags del cajero (BONUS/RETURN) y el porcentaje de descuento que
 * extrajo el OCR, devuelve el descuento que debe viajar al carrito.
 *
 *   - BONUS siempre fuerza 0 (un regalo con "descuento" no tiene semántica).
 *   - RETURN preserva el DTO: la devolución refleja los términos de la factura
 *     original; auditoría debe ver "la devolución tenía 12% pactado".
 *   - El resto propaga el porcentaje tal cual (ya normalizado por el backend).
 *
 * Nunca interpreta un campo monetario (`discount` suelto en el OCR) para
 * evitar doble aplicación: el contrato con el backend es que la única fuente
 * de verdad es `discount_percentage`.
 */
export function resolveCartDiscountFromOcr({ lineType, discount_percentage }) {
  const entryType = entryTypeFromLineType(lineType);
  if (entryType === 'gift') return 0;
  return clampPercentage(discount_percentage);
}

// ─────────────────────────────────────────────────────────────────────────
// IMPUESTOS ESPERADOS: Neutralización defensiva por item
// ─────────────────────────────────────────────────────────────────────────
//
// El modal de OCR deja al usuario marcar explícitamente qué impuestos espera
// (IVA, IBUA, ICUI) antes de llamar a Claude. El backend respeta esas
// pistas pero, por paranoia, el frontend neutraliza los campos que el
// usuario NO marcó antes de pasar los items al padre:
//
//   - unmatched: `iva_percentage`, `ibua_percentage`, `icui_percentage`
//   - matched:   `iva`, `ibua`, `icui`
//
// La política es simple y binaria: si el checkbox está apagado, el OCR no
// debió detectar ese impuesto para esta factura. Cualquier valor residual se
// aplana a 0 para que ningún recálculo aguas abajo lo multiplique por un
// porcentaje "fantasma".

/**
 * Devuelve un item nuevo con los campos de impuesto neutralizados en función
 * de `expectedTaxes`. Nunca mutila el objeto original ni descarta otros
 * campos. Si `expectedTaxes` es undefined/null, deja los valores tal cual.
 *
 * Soporta la coexistencia de los dos shapes del backend:
 *   - unmatched: `*_percentage`
 *   - matched:   nombre pelado (`iva`, `ibua`, `icui`)
 *
 * Ambos se neutralizan en paralelo porque los items pueden propagarse en
 * cualquiera de los dos formatos entre el modal y el reviewer.
 */
export function neutralizeTaxFields(item, expectedTaxes) {
  if (!item || typeof item !== 'object') return item;
  if (!expectedTaxes || typeof expectedTaxes !== 'object') return { ...item };
  const next = { ...item };
  if (!expectedTaxes.iva) {
    next.iva_percentage = 0;
    next.iva = 0;
  }
  if (!expectedTaxes.ibua) {
    next.ibua_percentage = 0;
    next.ibua = 0;
  }
  if (!expectedTaxes.icui) {
    next.icui_percentage = 0;
    next.icui = 0;
  }
  return next;
}

// ─────────────────────────────────────────────────────────────────────────
// EMPAQUES: Confirmación obligatoria del multiplicador y conversión a
//           unidades individuales
// ─────────────────────────────────────────────────────────────────────────
//
// Contrato con el backend:
//   - Cuando el OCR detecta en el nombre del producto una pista de empaque
//     (p.ej. "COCA COLA PAQUETE X 24" o "GASEOSA 1.5L x12") devuelve dos
//     campos adicionales por item: `packHintUnits` (entero >= 2) y
//     `requiresPackConfirmation` (bool). NUNCA muta `quantity` ni `costUnit`
//     ni `unitPrice`; es responsabilidad del frontend confirmar con el
//     operario cuántas unidades trae el empaque antes de cargar al carrito.
//   - La política del negocio es que las recepciones viajen SIEMPRE en
//     unidades individuales (no en paquetes), para que el stock y el costo
//     unitario queden coherentes con la venta en caja. No se ofrece opción
//     de "conservar paquete".

/**
 * Mínimo de unidades por paquete que acepta el modal. Si el OCR sugiere 1
 * o cualquier valor < 2 lo consideramos "sin pista" y el item fluye como
 * un producto normal sin requerir confirmación.
 */
export const PACK_MIN_UNITS = 2;

/**
 * Máximo defensivo para evitar tecleos accidentales (p.ej. 24000). El
 * negocio nunca ha visto empaques por encima de 999 unidades.
 */
export const PACK_MAX_UNITS = 999;

/**
 * Extrae el hint entero del backend (`packHintUnits`, admite también la
 * variante snake_case por si el backend evolucionó). Retorna 0 si no es un
 * entero finito >= 2.
 */
export function getPackHintUnits(item) {
  if (!item || typeof item !== 'object') return 0;
  const raw = item.packHintUnits !== undefined
    ? item.packHintUnits
    : item.pack_hint_units;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < PACK_MIN_UNITS) return 0;
  return Math.floor(n);
}

/**
 * `true` cuando el backend marcó el item con `requiresPackConfirmation=true`
 * Y el hint es un entero >= 2. Si falta cualquiera de las dos piezas, el
 * item fluye como individual sin requerir confirmación.
 *
 * Nunca mira el nombre del producto desde el frontend: la detección vive en
 * el backend, aquí sólo honramos el contrato.
 */
export function itemRequiresPackConfirmation(item) {
  if (!item || typeof item !== 'object') return false;
  const flag = item.requiresPackConfirmation !== undefined
    ? item.requiresPackConfirmation
    : item.requires_pack_confirmation;
  if (!flag) return false;
  return getPackHintUnits(item) >= PACK_MIN_UNITS;
}

/**
 * `true` si al menos un item de la lista necesita confirmación de empaque.
 * Es la bandera que el modal usa para decidir si abre la etapa interna de
 * revisión antes de llamar a `onExtractedItems`.
 */
export function anyItemRequiresPackConfirmation(items) {
  if (!Array.isArray(items)) return false;
  for (const it of items) {
    if (itemRequiresPackConfirmation(it)) return true;
  }
  return false;
}

/**
 * Valida que el valor tecleado por el usuario sea un entero dentro del rango
 * [PACK_MIN_UNITS, PACK_MAX_UNITS]. Tolera strings numéricos ("24") pero NO
 * decimales ("24.5"): un paquete no puede traer 24.5 unidades.
 */
export function isValidUnitsPerPack(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= PACK_MIN_UNITS && value <= PACK_MAX_UNITS;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || !/^\d+$/.test(trimmed)) return false;
    const n = Number(trimmed);
    return Number.isInteger(n) && n >= PACK_MIN_UNITS && n <= PACK_MAX_UNITS;
  }
  return false;
}

/**
 * Divide un precio por el multiplicador de empaque preservando la lógica de
 * "nunca conservar precio de paquete como precio unitario".
 *
 * Para precios tipo COSTO (costUnit, unitPrice, costoReal, totalPrice): se
 * divide sin redondear a enteros para no perder decimales relevantes en el
 * cuadre fiscal; el renglón del carrito guarda el BASE pre-impuestos.
 * Para PVP sugerido (pvpSugerido): se divide y se redondea a entero porque
 * los precios de venta en Colombia siempre se expresan en pesos sin
 * decimales. El redondeo "coherente" (HALF_AWAY_FROM_ZERO) evita el bias
 * sistemático de Math.round en valores negativos — aquí nunca pasa, pero
 * dejamos la implementación simétrica por si algún día aparecen devoluciones.
 */
function dividePrice(value, unitsPerPack) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (!Number.isFinite(unitsPerPack) || unitsPerPack <= 0) return n;
  return n / unitsPerPack;
}

function roundHalfAway(n) {
  if (!Number.isFinite(n)) return 0;
  return n >= 0 ? Math.floor(n + 0.5) : -Math.floor(-n + 0.5);
}

// ─────────────────────────────────────────────────────────────────────────
// Modo de carga por item: PRESENTACION vs EMPAQUE
// ─────────────────────────────────────────────────────────────────────────
//
// El detector del backend emite un `packHintUnits` cuando ve un número
// después de un marcador (`x`/`*`/`×`) en el nombre del producto. Ese número
// es ambiguo:
//
//   - EMPAQUE  → el número es un multiplicador (p.ej. "COCA x 24" = 24
//                unidades sueltas dentro de un paquete). Se multiplica
//                cantidad y se divide el precio.
//   - PRESENTACION / GRAMAJE → el número es parte de la presentación del
//                producto (p.ej. "CREMA DENTAL x 58 ML" = una crema de 58 ml,
//                no 58 cremas). Se recibe como UNA unidad por renglón, sin
//                multiplicar ni dividir precio.
//
// El modo final siempre lo decide el operario en el modal, pero clasificamos
// un default pragmático a partir del nombre para evitar errores legacy.
//
// Prioridad del default (ver `classifyPackMode`):
//   1. Marcadores de empaque explícitos (`UND`, `UNID`, `UNIDADES`, `UN`,
//      `PAQUETE`, `CAJAS`, `BOTELLAS`, `LATAS`) → EMPAQUE.
//   2. Magnitudes físicas (`ML`, `L`, `LT`, `CC`, `OZ`, `G`, `GR`, `GRS`,
//      `KG`, `MG`) → PRESENTACION.
//   3. Nada reconocible → EMPAQUE (comportamiento histórico — honramos el
//      hint del backend tal cual).

export const PACK_MODE_EMPAQUE = 'EMPAQUE';
export const PACK_MODE_PRESENTACION = 'PRESENTACION';

// Palabras explícitas que señalan que el número ES un multiplicador real:
// p.ej. "CAP X 24 UND" o "GASEOSA PAQUETE X 6". Si una de éstas aparece en
// el nombre, el default es EMPAQUE sin importar que haya una magnitud.
const PACK_WORDS_REGEX = /\b(UND|UNIDS?|UNIDADES?|PAQUETES?|CAJAS?|BOTELLAS?|LATAS?|BOLSAS?|TARROS?|FRASCOS?|SOBRES?|SIX\s?PACK)\b/;

// Magnitudes físicas que señalan que el número es parte de la presentación.
// Incluimos la gran mayoría de abreviaturas colombianas vistas en facturas
// de abarrotes. OZ y CC son más raras pero inofensivas.
const MAGNITUDE_WORDS_REGEX = /\b(ML|L|LT|LTS|CC|OZ|G|GR|GRS|GRAMOS?|KG|KILOS?|MG)\b/;

/**
 * Clasifica el modo de carga por default para un item con hint de empaque.
 * Resultado determinístico y puro:
 *   - 'EMPAQUE' si el nombre menciona un marcador de empaque explícito
 *     (UND/UNIDADES/PAQUETE/CAJAS/BOTELLAS/LATAS/...).
 *   - 'PRESENTACION' si el nombre contiene una magnitud física
 *     (ML/G/GR/GRS/KG/MG/...).
 *   - 'EMPAQUE' en cualquier otro caso (default conservador: honramos el
 *     hint del backend).
 *
 * Esta clasificación NO cambia el objeto; sólo sugiere un default que la UI
 * puede sobrescribir. Al elegir manualmente otro modo, se descarta.
 */
export function classifyPackMode(item) {
  if (!item || typeof item !== 'object') return PACK_MODE_EMPAQUE;
  const name = typeof item.invoiceName === 'string' && item.invoiceName.trim()
    ? item.invoiceName
    : typeof item.productName === 'string' && item.productName.trim()
      ? item.productName
      : typeof item.name === 'string'
        ? item.name
        : '';
  if (!name) return PACK_MODE_EMPAQUE;
  const upper = name.toUpperCase();
  // Marcadores explícitos ganan primero: un "CAP X 24 UND" quiere EMPAQUE
  // aunque también contuviera "ML" por accidente ("CAP X 24 UND DE 58ML").
  if (PACK_WORDS_REGEX.test(upper)) return PACK_MODE_EMPAQUE;
  if (MAGNITUDE_WORDS_REGEX.test(upper)) return PACK_MODE_PRESENTACION;
  return PACK_MODE_EMPAQUE;
}

/**
 * Convierte un item OCR en modo PRESENTACION / GRAMAJE: cada renglón de la
 * factura entra al stock como UNA unidad (no se multiplica cantidad ni se
 * divide precio). Pensado para casos donde el "x 58 ML" del nombre es parte
 * de la presentación, no un multiplicador real.
 *
 * Reglas:
 *   - Deja `quantity`, `unitPrice`, `costUnit`, `costoReal`, `pvpSugerido`,
 *     `pvpActual`, `totalPrice`, `bonus_quantity`, `currentStock`,
 *     `currentWac`, `marginUsed` intactos: el precio del paquete YA es el
 *     precio de la unidad final.
 *   - LIMPIA la bandera `requiresPackConfirmation` y el hint
 *     `packHintUnits`/`pack_hint_units` para que ningún paso aguas abajo
 *     reabra el flujo de confirmación.
 *   - Marca trazabilidad simétrica a EMPAQUE:
 *       `packMode = 'PRESENTACION'`
 *       `confirmedUnitsPerPack = 1` (consumidores que lean "unidades por
 *       paquete" interpretan 1 como "sin conversión").
 *       `packConversionApplied = true` (evita que downstream intente volver
 *       a procesar el item).
 *
 * NUNCA muta el objeto original: siempre retorna una copia.
 */
export function convertItemAsPresentation(item) {
  if (!item || typeof item !== 'object') return item;
  const next = { ...item };
  next.confirmedUnitsPerPack = 1;
  next.packConversionApplied = true;
  next.packMode = PACK_MODE_PRESENTACION;
  // Al elegir presentación limpiamos las banderas del detector para que
  // ningún consumidor aguas abajo vuelva a abrir la revisión de empaque.
  next.requiresPackConfirmation = false;
  next.requires_pack_confirmation = false;
  next.packHintUnits = 0;
  next.pack_hint_units = 0;
  return next;
}

/**
 * Convierte un item OCR cuyo precio y cantidad vienen expresados en PAQUETES
 * a su representación en UNIDADES INDIVIDUALES, preservando el valor total
 * de la línea (quantity × costo).
 *
 * Reglas por campo (sólo se tocan si existen; nada se inventa):
 *
 *   Cantidades
 *     quantity   = quantity * unitsPerPack
 *     bonus_quantity = bonus_quantity * unitsPerPack  (si > 0)
 *
 *   Costos (BASE pre-impuestos — se divide sin redondear)
 *     unitPrice  /= unitsPerPack      (shape unmatched)
 *     costUnit   /= unitsPerPack      (shape matched)
 *     costoReal  /= unitsPerPack      (shape matched extendido, defensivo)
 *     totalPrice NO se divide porque es "paquete × precio" y YA representa
 *                la línea completa; se preserva intacto.
 *
 *   Precio de venta sugerido (PVP, pesos enteros)
 *     pvpSugerido /= unitsPerPack, redondeado al entero más cercano
 *
 *   Preservados sin modificar (vienen por producto, no por paquete)
 *     pvpActual, currentStock, currentWac, marginUsed
 *
 *   Trazabilidad (añadidos siempre que la conversión aplicó)
 *     invoicePackageQuantity = quantity ANTES de multiplicar (lo que trae
 *                              la factura en paquetes)
 *     confirmedUnitsPerPack  = unitsPerPack confirmado por el usuario
 *
 * La función NUNCA toca el objeto original: siempre retorna una copia.
 * Si `unitsPerPack` no es entero >= 2, retorna una copia superficial sin
 * modificar — así el llamador puede delegar la validación en este helper
 * sin riesgo de corromper datos cuando el input es basura.
 */
export function convertItemToIndividualUnits(item, unitsPerPack) {
  if (!item || typeof item !== 'object') return item;
  if (!isValidUnitsPerPack(unitsPerPack)) return { ...item };
  const n = typeof unitsPerPack === 'string' ? Number(unitsPerPack) : unitsPerPack;
  const next = { ...item };

  const originalQuantity = Number(next.quantity);
  if (Number.isFinite(originalQuantity)) {
    next.quantity = originalQuantity * n;
    next.invoicePackageQuantity = originalQuantity;
  }
  next.confirmedUnitsPerPack = n;

  if (next.unitPrice !== undefined && next.unitPrice !== null) {
    next.unitPrice = dividePrice(next.unitPrice, n);
  }
  if (next.costUnit !== undefined && next.costUnit !== null) {
    next.costUnit = dividePrice(next.costUnit, n);
  }
  if (next.costoReal !== undefined && next.costoReal !== null) {
    next.costoReal = dividePrice(next.costoReal, n);
  }
  if (next.pvpSugerido !== undefined && next.pvpSugerido !== null) {
    const divided = dividePrice(next.pvpSugerido, n);
    next.pvpSugerido = roundHalfAway(divided);
  }
  // bonus_quantity: si viene positiva, escala por paquete. Un BONUS de "1
  // paquete gratis" sobre una factura de 2 paquetes × 24 unidades se
  // convierte en 24 unidades regaladas por paquete; después se multiplicó
  // ya `quantity` por N y aquí hacemos lo propio con el bonus.
  const bonus = Number(next.bonus_quantity);
  if (Number.isFinite(bonus) && bonus > 0) {
    next.bonus_quantity = bonus * n;
  }
  // Marcamos que el item ya ha sido convertido para que ningún punto
  // aguas abajo multiplique de nuevo accidentalmente.
  next.packConversionApplied = true;
  next.packMode = PACK_MODE_EMPAQUE;

  return next;
}
