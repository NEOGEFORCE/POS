import { Sale } from "./definitions";

/**
 * Retorna una descripción amigable del método de pago de una venta.
 * Útil para mostrar en el historial y reportes.
 */
export const getPaymentDescription = (sale: Sale): string => {
  if (!sale) return "EFECTIVO";

  const method = sale.paymentMethod?.toUpperCase() || "EFECTIVO";
  const source = sale.transferSource?.toUpperCase() || "NEQUI";

  // Si el método ya contiene el detalle (gracias a la nueva lógica de useNewSale), lo devolvemos
  if (method.includes("+") || method === "NEQUI" || method === "DAVIPLATA" || method === "FIADO") {
      return method;
  }

  // Fallback para datos antiguos o legacy
  if (method === "FIADO" || method === "CREDITO") {
      return "FIADO";
  }
  
  if (method === "TRANSFERENCIA") {
    return source;
  }

  if (method === "MIXTO" || method === "MIXED") {
    const parts: string[] = [];
    if (sale.cashAmount > 0) parts.push("EFECTIVO");
    if (sale.transferAmount > 0) parts.push(source);
    if (sale.creditAmount > 0) parts.push("FIADO");
    return parts.length === 0 ? "EFECTIVO" : parts.join(" + ");
  }

  return method;
};

/**
 * Retorna el color sugerido para el chip del método de pago.
 * Ahora es más específico según el origen de la transferencia.
 */
export const getPaymentColor = (sale: Sale): "success" | "warning" | "primary" | "secondary" | "danger" | "default" => {
    if (!sale) return "success";
    
    const method = sale.paymentMethod?.toUpperCase() || "";
    const source = sale.transferSource?.toUpperCase() || "";

    // 1. NEQUI (Morado)
    if (source.includes("NEQUI") || method.includes("NEQUI")) return "secondary";
    
    // 2. DAVIPLATA (Rojo)
    if (source.includes("DAVIPLATA") || method.includes("DAVIPLATA")) return "danger";

    // 3. FIADO (Rojo/Naranja)
    if (sale.creditAmount > 0 || method.includes("FIADO") || method.includes("CREDITO")) return "warning";

    // 4. EFECTIVO (Verde)
    if (sale.cashAmount > 0 || method.includes("EFECTIVO")) return "success";

    return "default";
};
