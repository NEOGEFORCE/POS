// ============================================================================
// REGLAS DE ENVÍO DE UN PEDIDO A PROVEEDOR
// ============================================================================
//
// Lógica pura, sin React ni fetch, para poder probarla con `node --test`.
// El espejo de estas reglas en el backend vive en
// backPOS-go/internal/adapters/handlers/restock_handler.go
// (validateConfirmOrder y declaredOrderValue). Si cambia una, cambia la otra.
//
// REGLA DEL DUEÑO (agosto 2026): un pedido se puede enviar de dos formas.
//
//   (a) CON PRODUCTOS DESGLOSADOS. El total sale de cantidades por costo. Si
//       además se escribe un valor a mano, ese valor manda: el preventista
//       pudo haber cerrado en otro número.
//
//   (b) SIN PRODUCTOS, SOLO CON EL VALOR. El preventista pasa, acuerdan un
//       monto y el dueño no quiere sentarse a listar producto por producto.
//       Lo que necesita quedar registrado es el compromiso con el proveedor y
//       la fecha en que llega, para que la plata esté prevista.
//
// El proveedor es obligatorio en los dos casos: sin proveedor el pedido no se
// le puede atribuir a nadie. Y un pedido sin productos y sin valor no registra
// nada, así que se rechaza.

/**
 * Normaliza lo escrito o pegado en el campo de valor y conserva únicamente
 * los pesos enteros. Tolera separadores colombianos y descarta una fracción
 * decimal final de uno o dos dígitos.
 *
 * @param {unknown} raw texto tal como viene del input
 * @returns {string} dígitos sin formato, o cadena vacía
 */
export function normalizeOrderValueInput(raw) {
  if (typeof raw !== "string") return "";

  // Conserva temporalmente punto/coma para reconocer una parte decimal
  // pegada ("$ 1.250.000,00" o "1250000.00") y no multiplicar el monto
  // por cien al quedarse también con esos dos ceros.
  let compact = raw.replace(/[^\d.,]/g, "");
  if (!/\d/.test(compact)) return "";

  const dotCount = (compact.match(/\./g) ?? []).length;
  const commaCount = (compact.match(/,/g) ?? []).length;
  const lastDot = compact.lastIndexOf(".");
  const lastComma = compact.lastIndexOf(",");
  let decimalIndex = -1;

  if (dotCount > 0 && commaCount > 0) {
    const candidate = Math.max(lastDot, lastComma);
    const fraction = compact.slice(candidate + 1).replace(/\D/g, "");
    if (fraction.length >= 1 && fraction.length <= 2) decimalIndex = candidate;
  } else if (dotCount + commaCount === 1) {
    const candidate = Math.max(lastDot, lastComma);
    const fraction = compact.slice(candidate + 1).replace(/\D/g, "");
    if (fraction.length >= 1 && fraction.length <= 2) decimalIndex = candidate;
  }

  if (decimalIndex >= 0) compact = compact.slice(0, decimalIndex);
  const digitsOnly = compact.replace(/\D/g, "");
  if (digitsOnly === "") return "";
  return digitsOnly.replace(/^0+(?=\d)/, "");
}

/**
 * Formatea pesos colombianos mientras el usuario escribe, sin agregar la
 * parte decimal dentro del input. La UI pinta `,00` como sufijo separado para
 * que el cursor nunca termine detrás de los decimales fijos.
 *
 * @param {unknown} raw valor crudo o ya formateado
 * @returns {string} por ejemplo: "312000" -> "312.000"
 */
export function formatOrderValueInput(raw) {
  const digitsOnly = normalizeOrderValueInput(raw);
  if (digitsOnly === "") return "";
  const parsed = Number(digitsOnly);
  if (!Number.isFinite(parsed)) return "";
  return parsed.toLocaleString("es-CO", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

export function parseOrderValue(raw) {
  const digitsOnly = normalizeOrderValueInput(raw);
  if (digitsOnly === "") return 0;
  const parsed = Number(digitsOnly);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Decide si el pedido se puede enviar.
 *
 * @param {object} input
 * @param {boolean} input.hasSupplier      si el grupo tiene proveedor asignado
 * @param {number}  input.selectedCount    productos con cantidad mayor que cero
 * @param {number}  input.declaredValue    valor escrito a mano, ya parseado
 * @returns {boolean}
 */
export function canConfirmOrder({ hasSupplier, selectedCount, declaredValue }) {
  if (!hasSupplier) return false;
  return selectedCount > 0 || declaredValue > 0;
}

/**
 * Total que se envía al backend. El valor escrito a mano manda sobre el total
 * calculado de los productos; si no hay valor escrito, se usa el calculado.
 *
 * @param {number} itemsTotal     suma de cantidad por costo unitario
 * @param {number} declaredValue  valor escrito a mano, ya parseado
 * @returns {number}
 */
export function resolveOrderTotal(itemsTotal, declaredValue) {
  return declaredValue > 0 ? declaredValue : Math.max(0, itemsTotal);
}

/**
 * Prellena las cantidades con lo que sugiere el backend.
 *
 * NO se filtra por categoría ABC. El backend es la única autoridad sobre cuánto
 * pedir: su sugerencia ya contempla el PISO POR STOCK MÍNIMO, que manda sobre
 * la clase ABC. Antes el frontend forzaba 0 en clase C y eso anulaba el
 * arreglo: un producto de baja rotación por debajo del mínimo llegaba con la
 * cantidad correcta y "Aplicar sugerencias" lo volvía a poner en cero — que es
 * exactamente lo que el dueño reportó como "no me sugiere pedir productos que
 * sí se necesitan".
 *
 * @param {Array<{productId: string, suggestedOrderQty: number}>} items
 * @returns {Record<string, number>}
 */
export function suggestedQuantities(items) {
  return Object.fromEntries(
    (items ?? []).map((item) => [item.productId, Math.max(0, item.suggestedOrderQty ?? 0)])
  );
}

/**
 * Arma las líneas que se envían al backend a partir de TODO lo seleccionado.
 *
 * EL BUG QUE ARREGLA (reportado por el dueño, 2026-09-10): "cuando estoy
 * buscando un producto en pedidos, cuando lo voy a mandar y todavia estoy
 * buscando solo se me manda el que estoy buscando y los demas que tenia
 * selecionados se pierden".
 *
 * La búsqueda de esta pantalla es del lado del SERVIDOR: al escribir, el
 * backend devuelve sólo las coincidencias, y los grupos por proveedor se
 * construyen desde esa respuesta recortada. El envío iteraba `group.items`, o
 * sea únicamente lo visible, y el resto del pedido se perdía en silencio: el
 * carrito mostraba 12 productos y salía 1.
 *
 * El carrito ya sobrevivía al filtro gracias a las fotos de useSmartRestock
 * (selectedItems). El envío no las usaba. Esta función cierra ese hueco
 * tomando la selección completa como única fuente.
 *
 * ATRIBUCIÓN POR PROVEEDOR. Con filtro de proveedor activo hay un solo grupo y
 * todo lo elegido le pertenece; ese es el flujo normal, y además el hook borra
 * la selección al cambiar de proveedor, así que no puede colarse nada ajeno.
 * Sin filtro se reparte por primarySupplierId, que es la misma clave con la que
 * agrupa groupSuggestionsBySupplier.
 *
 * @param {object} input
 * @param {Array<{productId: string, quantity: number, unitCost: number, primarySupplierId: number|null}>} input.selectedItems
 *        selección completa, incluida la que no está en la vista
 * @param {number|null} input.groupSupplierId proveedor del grupo que se confirma
 * @param {boolean} input.supplierFilterActive true = hay un proveedor elegido en el filtro
 * @returns {Array<{product_id: string, barcode: string, quantity: number, unit_cost: number}>}
 */
export function buildConfirmItems({ selectedItems, groupSupplierId, supplierFilterActive }) {
  const lista = Array.isArray(selectedItems) ? selectedItems : [];
  return lista
    .filter((item) => {
      if (!item || !item.productId) return false;
      if (!(Number(item.quantity) > 0)) return false;
      if (supplierFilterActive) return true;
      return (item.primarySupplierId ?? null) === (groupSupplierId ?? null);
    })
    .map((item) => ({
      product_id: item.productId,
      barcode: item.productId,
      quantity: Number(item.quantity),
      unit_cost: Number(item.unitCost) || 0,
    }));
}
