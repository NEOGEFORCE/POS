// Helpers puros de la barra de facturas de /sales/new.

/** Máximo de facturas visibles como pestañas antes de agrupar en la lista. */
export const MAX_VISIBLE_CART_TABS = 3;

/**
 * Devuelve qué facturas se muestran como pestañas y cuáles van a la lista
 * desplegable. La factura activa siempre queda visible: si está fuera de las
 * primeras N, reemplaza a la última visible.
 */
export function splitCartTabs(keys, activeKey, max = MAX_VISIBLE_CART_TABS) {
    const list = Array.isArray(keys) ? keys.filter((k) => typeof k === "string") : [];
    const limit = Number.isInteger(max) && max > 0 ? max : MAX_VISIBLE_CART_TABS;
    if (list.length <= limit) return { visible: list, overflow: [] };
    const visible = list.slice(0, limit);
    if (activeKey && list.includes(activeKey) && !visible.includes(activeKey)) {
        visible[limit - 1] = activeKey;
    }
    const overflow = list.filter((k) => !visible.includes(k));
    return { visible, overflow };
}

/**
 * Cuenta los artículos de una venta. Los productos por peso cuentan como
 * 1 artículo por línea (0,532 kg de queso es un artículo, no 0,532).
 */
export function countCartUnits(items) {
    if (!Array.isArray(items)) return 0;
    let total = 0;
    for (const item of items) {
        if (!item || typeof item !== "object") continue;
        if (item.isWeighted) {
            total += 1;
            continue;
        }
        const qty = Number(item.cartQuantity);
        if (Number.isFinite(qty) && qty > 0) total += qty;
    }
    return Math.round(total * 1000) / 1000;
}
