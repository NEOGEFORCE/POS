import { Sale } from "./definitions";

/**
 * Describe el metodo de pago REAL de una venta a partir del desglose
 * numerico (cashAmount, transferNequi, transferDaviplata, transferAmount,
 * creditAmount). La fuente de verdad son los montos; el string
 * `paymentMethod` solo se usa como fallback historico cuando ninguna
 * cantidad > 0 y la venta antigua trae un valor legacy.
 *
 * Garantias contractuales (cubiertas por tests en
 * `tests/payment-helpers.test.mjs`):
 *
 *   1. Orden ESTABLE: EFECTIVO -> NEQUI -> DAVIPLATA -> otras
 *      transferencias (TransferSource) -> FIADO. Independiente del orden
 *      en que lleguen los campos del backend.
 *   2. Nombres UNICOS: cada canal aparece una sola vez.
 *   3. Las ventas corregidas que persistian con `paymentMethod="MIXTO"`
 *      (bug del backend hasta 2026-10) se expanden al desglose real.
 *   4. "MIXTO" solo sobrevive como fallback cuando no hay ningun monto
 *      recuperable; en ese caso se respeta el string historico tal cual.
 */
export const getPaymentDescription = (sale: Sale | null | undefined): string => {
    if (!sale) return "EFECTIVO";

    const cash = Number(sale.cashAmount) || 0;
    const transferTotal = Number(sale.transferAmount) || 0;
    const nequi = Number(sale.transferNequi) || 0;
    const daviplata = Number(sale.transferDaviplata) || 0;
    const credit = Number(sale.creditAmount) || 0;

    const parts: string[] = [];
    if (cash > 0) parts.push("EFECTIVO");
    if (nequi > 0) parts.push("NEQUI");
    if (daviplata > 0) parts.push("DAVIPLATA");

    // "Otra transferencia" solo si queda un residuo que no explica el
    // desglose Nequi+Daviplata. Preserva TransferSource si viene con un
    // nombre util (p.ej. BANCOLOMBIA); si no, cae a TRANSFERENCIA neutra.
    const breakdown = nequi + daviplata;
    const otherTransfer = transferTotal - breakdown;
    if (otherTransfer > 0.5) {
        const rawSource = (sale.transferSource || "").toUpperCase().trim();
        const forbiddenSources = new Set(["", "MIXTO", "NEQUI", "DAVIPLATA"]);
        let label = forbiddenSources.has(rawSource) ? "TRANSFERENCIA" : rawSource;
        // Bold se retiró (2026-10-26): ventas viejas por Bold se muestran como "QR".
        if (label.includes("BOLD")) label = "QR";
        if (!parts.includes(label)) parts.push(label);
    }

    if (credit > 0) parts.push("FIADO");

    if (parts.length > 0) return parts.join(" + ");

    // Fallback historico: ninguna cantidad > 0 (puede ocurrir en ventas
    // antiguas corruptas o con solo totales). Respetamos lo que vino del
    // backend: si decia "MIXTO", mostramos "MIXTO" sin desglose, porque es
    // la unica informacion disponible.
    const legacy = (sale.paymentMethod || "").toUpperCase().trim().replace(/BOLD[_\s-]?QR|BOLD/g, "QR");
    return legacy || "EFECTIVO";
};

/**
 * Color del chip del metodo de pago. Decide por los montos primero (fuente
 * de verdad) y solo cae al string legacy si no hay desglose. Prioridad: si
 * hay varios canales (compuesto), vuelve "secondary" (violeta) para
 * destacar; si no, elige el color del canal unico.
 */
export const getPaymentColor = (sale: Sale | null | undefined): "success" | "warning" | "primary" | "secondary" | "danger" | "default" => {
    if (!sale) return "success";

    const cash = Number(sale.cashAmount) || 0;
    const transferTotal = Number(sale.transferAmount) || 0;
    const nequi = Number(sale.transferNequi) || 0;
    const daviplata = Number(sale.transferDaviplata) || 0;
    const credit = Number(sale.creditAmount) || 0;

    const channelsCount =
        (cash > 0 ? 1 : 0) +
        (nequi > 0 ? 1 : 0) +
        (daviplata > 0 ? 1 : 0) +
        (transferTotal - nequi - daviplata > 0.5 ? 1 : 0) +
        (credit > 0 ? 1 : 0);

    // Compuesto -> violeta (facil de distinguir en el chip del historial).
    if (channelsCount >= 2) return "secondary";

    if (nequi > 0) return "secondary";
    if (daviplata > 0) return "danger";
    if (credit > 0) return "warning";
    if (cash > 0) return "success";

    // Fallback: ningun monto recuperable, miramos el string legacy.
    const method = (sale.paymentMethod || "").toUpperCase();
    const source = (sale.transferSource || "").toUpperCase();
    if (source.includes("NEQUI") || method.includes("NEQUI")) return "secondary";
    if (source.includes("DAVIPLATA") || method.includes("DAVIPLATA")) return "danger";
    if (method.includes("FIADO") || method.includes("CREDITO")) return "warning";
    if (method.includes("EFECTIVO")) return "success";
    return "default";
};
