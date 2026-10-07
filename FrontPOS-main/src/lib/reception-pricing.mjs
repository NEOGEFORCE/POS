// Reglas de precio para /inventory/receive — mantenlas aditivas y sin WAC.
//
// Contrato fiscal del sistema:
//   • SUBT. de cada línea es la BASE pre-impuestos (unitario * cantidad efectiva).
//   • El payload `newPurchasePrice` que envía /products/bulk-receive también es
//     la base pre-impuestos unitaria.
//   • La columna `products.purchasePrice` persiste el costo unitario BRUTO
//     (gross) con IVA + ICUI + IBUA ya aplicados: Gross = Base * (1 + ivaPct
//     + icuiPct + ibuaPct) / 100. El descuento NO reduce el costo contable.
//   • Los impuestos son aditivos (no compuestos): rate = iva + icui + ibua.
//   • El descuento se aplica sobre el bruto para calcular el "neto final" que
//     se muestra como costo real; nunca entra al cálculo de WAC ni al Expense.
//
// Contratos de entrada de /inventory/receive:
//   • metadata.newPurchasePrice de una recepción histórica es BASE cuando la
//     propiedad existe, incluso si vale 0; si falta, product.purchasePrice es
//     el fallback BRUTO persistido y se convierte una sola vez.
//   • OCR costUnit/unitPrice es BASE cuando existe, incluso si vale 0; sólo el
//     fallback product.purchasePrice es BRUTO.
//   • unit_cost/unitCost de una orden es BASE cuando existe; el fallback del
//     producto maestro vuelve a ser BRUTO.
//   • Los porcentajes extraídos por OCR/metadata prevalecen sobre los del
//     producto si están presentes. Un 0 explícito también prevalece.
//   • **DESCUENTO desde OCR**: el campo `discount` que llega al carrito desde
//     el lector de facturas SIEMPRE viene como porcentaje [0, 100] y nunca
//     como monto monetario. El backend `normalizeExtractedItem` ya resolvió
//     la precedencia %/$ (gana porcentaje) y colapsó `discount_value` a 0.
//     Por eso aquí tratamos `discount` como % puro sin reinterpretar: dos
//     capas que lo lean como monto provocarían doble aplicación.
//
// Las funciones de aquí deben ser SIMETRICAS:
//   calculateGrossCost(grossToBasePrice(g, i, c, b), i, c, b)  ≈ g
// para cualquier gross > 0.

import { normalizeSalePrice } from './pricing-helpers.mjs';

const PCT = 100;

function toFinitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toFiniteNonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Suma de las tres tasas (aditiva, en %). Ignora valores inválidos o
 * negativos para no "regalar" descuento vía impuesto negativo.
 */
export function sumTaxRate(ivaPct, icuiPct, ibuaPct) {
  return (
    toFiniteNonNegative(ivaPct) +
    toFiniteNonNegative(icuiPct) +
    toFiniteNonNegative(ibuaPct)
  );
}

/**
 * Convierte el `products.purchasePrice` persistido (gross con IVA+ICUI+IBUA)
 * a la BASE pre-impuestos. Debe aplicarse EXACTAMENTE UNA VEZ al cargar el
 * producto en la UI de recepción, para que después los helpers de cálculo
 * puedan reaplicar los impuestos sin duplicarlos.
 *
 *   base = gross / (1 + (iva + icui + ibua) / 100)
 *
 * Validación defensiva:
 *   • NaN / strings → 0
 *   • negativos / cero → 0
 *   • factor <= 0 (en teoría imposible aquí) → se devuelve el gross tal cual
 *     para no amplificar un valor atípico.
 */
export function grossToBasePrice(gross, ivaPct, icuiPct, ibuaPct) {
  const g = toFinitePositive(gross);
  if (g === 0) return 0;
  const factor = 1 + sumTaxRate(ivaPct, icuiPct, ibuaPct) / PCT;
  if (!Number.isFinite(factor) || factor <= 0) return g;
  return g / factor;
}

/**
 * Costo bruto unitario (lo que se persiste en products.purchasePrice).
 *   gross = base * (1 + (iva + icui + ibua) / 100)
 */
export function calculateGrossCost(basePrice, ivaPct, icuiPct, ibuaPct) {
  const b = toFiniteNonNegative(basePrice);
  if (b === 0) return 0;
  return b * (1 + sumTaxRate(ivaPct, icuiPct, ibuaPct) / PCT);
}

/**
 * Costo neto final visible al usuario (operación): aplica descuento sobre
 * el bruto. NO se usa para WAC ni para el Expense del backend.
 */
export function calculateNetCost(basePrice, ivaPct, icuiPct, ibuaPct, discountPct) {
  const gross = calculateGrossCost(basePrice, ivaPct, icuiPct, ibuaPct);
  const d = Number(discountPct);
  const discountDec =
    Number.isFinite(d) && d > 0 ? Math.min(d, PCT) / PCT : 0;
  return gross * (1 - discountDec);
}

/**
 * PVP sugerido ANTES de la regla automática de redondeo. El PVP sube con el
 * descuento (base = gross / (1 - dto)) para preservar el margen real.
 */
export function calculateRawPVP(basePrice, ivaPct, icuiPct, ibuaPct, marginPct, discountPct = 0) {
  const grossCost = calculateGrossCost(basePrice, ivaPct, icuiPct, ibuaPct);
  if (grossCost === 0) return 0;
  const d = Number(discountPct);
  const discountDec =
    Number.isFinite(d) && d > 0 ? Math.min(d, PCT) / PCT : 0;
  const baseForPvp =
    discountDec >= 1 ? grossCost : grossCost / (1 - discountDec);
  const m = Number(marginPct);
  const marginDec = Number.isFinite(m) ? m : 0;
  return baseForPvp * (1 + marginDec / PCT);
}

/** PVP ya normalizado por la regla de la tienda (terminación 50 o >=20 a la centena). */
export function calculatePVP(basePrice, ivaPct, icuiPct, ibuaPct, marginPct, discountPct = 0) {
  return normalizeSalePrice(
    calculateRawPVP(basePrice, ivaPct, icuiPct, ibuaPct, marginPct, discountPct)
  );
}

/**
 * Selecciona un porcentaje efectivo sin tratar 0 como ausencia.
 * Se usa para la precedencia metadata/OCR → producto.
 */
export function resolveEffectivePercentage(preferredValue, productValue) {
  const selected = preferredValue !== undefined && preferredValue !== null
    ? preferredValue
    : productValue;
  return toFiniteNonNegative(selected);
}

/**
 * Resuelve un campo BASE cuyo fallback proviene de products.purchasePrice.
 * El candidato base se respeta cuando está presente, incluido 0; únicamente
 * cuando falta se descompone el fallback BRUTO con los porcentajes efectivos.
 */
export function resolveBasePrice(baseValue, grossFallback, ivaPct, icuiPct, ibuaPct) {
  if (baseValue !== undefined && baseValue !== null) {
    return toFiniteNonNegative(baseValue);
  }
  return grossToBasePrice(grossFallback, ivaPct, icuiPct, ibuaPct);
}

/**
 * Margen histórico calculado contra products.purchasePrice, que ya es BRUTO.
 * No se vuelven a aplicar impuestos al denominador.
 */
export function calculateMarginFromGross(grossPrice, salePrice, fallbackMargin = 0) {
  const gross = toFinitePositive(grossPrice);
  const sale = toFinitePositive(salePrice);
  if (gross === 0 || sale === 0) return toFiniteNonNegative(fallbackMargin);
  return ((sale / gross) - 1) * PCT;
}

/**
 * Proyección visual del WAC en unidad BRUTA. No modifica el WAC contable:
 * convierte la nueva BASE a gross y pondera gross con gross usando la cantidad
 * efectiva (el caller debe incluir el multiplicador de LB).
 */
export function calculateProjectedWacGross(
  oldGrossPrice,
  oldStock,
  newBasePrice,
  effectiveQty,
  ivaPct,
  icuiPct,
  ibuaPct,
) {
  const newGrossPrice = calculateGrossCost(newBasePrice, ivaPct, icuiPct, ibuaPct);
  if (newGrossPrice === 0) return 0;

  const stock = toFinitePositive(oldStock);
  const quantity = toFinitePositive(effectiveQty);
  if (stock === 0 || quantity === 0) return newGrossPrice;

  const oldGross = toFiniteNonNegative(oldGrossPrice);
  return ((stock * oldGross) + (quantity * newGrossPrice)) / (stock + quantity);
}

/**
 * PVP proyectado desde el WAC BRUTO usando la fórmula fiscal canónica. El WAC
 * se convierte a BASE y calculatePVP reaplica impuestos, DTO y GAN exactamente
 * una vez, incluida la normalización frontend de precio de venta.
 */
export function calculateProjectedPVP(
  oldGrossPrice,
  oldStock,
  newBasePrice,
  effectiveQty,
  ivaPct,
  icuiPct,
  ibuaPct,
  marginPct,
  discountPct = 0,
) {
  const projectedGross = calculateProjectedWacGross(
    oldGrossPrice,
    oldStock,
    newBasePrice,
    effectiveQty,
    ivaPct,
    icuiPct,
    ibuaPct,
  );
  const projectedBase = grossToBasePrice(projectedGross, ivaPct, icuiPct, ibuaPct);
  return calculatePVP(
    projectedBase,
    ivaPct,
    icuiPct,
    ibuaPct,
    marginPct,
    discountPct,
  );
}

/**
 * Parsea el texto crudo que escribe el usuario en el campo SUBT. y devuelve
 * el `basePrice` unitario correspondiente.
 *
 *   subtotalVisible = basePrice * effectiveQty
 *     ⇒ basePrice = subtotalVisible / effectiveQty
 *
 * Acepta formatos "1.370", "1370", "1 370". Rechaza vacíos, letras,
 * negativos y cero. Se usa en onChange para empujar el valor al padre antes
 * del blur, de forma que pulsar "Sincronizar" con el input enfocado envíe
 * exactamente lo visible.
 */
export function parseSubtotalEdit(text, effectiveQty) {
  if (text === null || text === undefined) {
    return { isValid: false, basePrice: 0, subtotal: 0 };
  }
  const raw = String(text).trim();
  if (raw === '' || raw === '-' || raw === '.' || raw === ',') {
    return { isValid: false, basePrice: 0, subtotal: 0 };
  }
  // Rechazamos explícitamente valores negativos: el subtotal de una línea
  // de recepción nunca es negativo (las devoluciones viajan por entryType).
  const isNegative = /-/.test(raw);
  // Se aceptan solo dígitos (los separadores de miles/decimales se descartan
  // porque en el flujo real llega vía formatInputCOP, que ya normaliza).
  const digitsOnly = raw.replace(/[^0-9]/g, '');
  if (digitsOnly === '') {
    return { isValid: false, basePrice: 0, subtotal: 0 };
  }
  const subtotal = Number.parseInt(digitsOnly, 10);
  if (!Number.isFinite(subtotal) || subtotal <= 0) {
    return { isValid: false, basePrice: 0, subtotal: 0 };
  }
  if (isNegative) {
    return { isValid: false, basePrice: 0, subtotal };
  }
  const q = Number(effectiveQty);
  if (!Number.isFinite(q) || q <= 0) {
    return { isValid: false, basePrice: 0, subtotal };
  }
  return { isValid: true, basePrice: subtotal / q, subtotal };
}

/**
 * Multiplicador de unidad para traducir cantidad a cantidad efectiva.
 * LB se cuenta como 0.5 KG; el resto es 1 a 1. Útil tanto en el componente
 * como en los tests.
 */
export function unitMultiplier(unit) {
  return unit === 'LB' ? 0.5 : 1;
}
