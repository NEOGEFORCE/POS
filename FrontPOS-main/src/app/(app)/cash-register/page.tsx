import { redirect } from "next/navigation";

/**
 * Ruta heredada conservada para marcadores y accesos directos antiguos.
 * El cierre de caja tiene una única implementación canónica para evitar que
 * regresen validaciones truthy/falsy que interpreten el valor 0 como ausente.
 */
export default function CashRegisterRedirectPage() {
  redirect("/dashboard/closure");
}
