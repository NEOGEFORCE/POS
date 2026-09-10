"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { suggestedQuantities as suggestedQuantitiesPure } from "@/lib/order-submission.mjs";
import { buildRestockSuggestionsEndpoint } from "@/lib/restock-endpoint.mjs";
import { orderSuggestions } from "@/lib/restock-ordering.mjs";

export type ABCCategory = "A" | "B" | "C";

export interface CheaperSupplierAlert {
  supplierId: number;
  supplierName: string;
  unitPrice: number;
  savings: number;
  totalSavings: number;
}

export interface RestockSuggestion {
  id: number;
  productId: string;
  productName: string;
  totalSold30d: number;
  daysWithStock: number;
  daysZeroStock: number;
  avgDailySales: number;
  abcCategory: ABCCategory;
  currentStock: number;
  inTransitQty: number;
  idealStock: number;
  suggestedOrderQty: number;
  primarySupplierId: number | null;
  supplierName: string;
  supplierLeadDays: number;
  /** Dias de venta que cubre el ideal: ciclo de visitas + lead time. */
  coverageDays?: number;
  unitCost: number;
  calculatedAt: string;
  inTransit: boolean;
  cheaperSupplier?: CheaperSupplierAlert;
  lastReceptionAt?: string | null;
  daysSinceReception?: number | null;
  soldSinceReception?: number;
  recommendation?: string;
  recommendationLevel?: "urgent" | "order" | "wait" | "skip";
  /** Mínimo configurado en el producto, leído en vivo. */
  minStock?: number;
  /** Existencia actual del producto, leída en vivo (las métricas son del último recálculo). */
  liveStock?: number;

  /**
   * Nuevos campos v2 de Pedidos Inteligentes Fase 1. El frontend degrada
   * limpio cuando no llegan: solo se pintan si el backend los envia. Ver el
   * contrato en la rama backend.
   */
  totalSold90d?: number;
  avgDailySales30d?: number;
  avgDailySales90d?: number;
  /**
   * Ventana CORTA de 14 dias: es la señal PRINCIPAL de la demanda desde
   * 2026-09-05. Los proveedores vuelven en ~8 dias, asi que el promedio del
   * trimestre reacciona tarde. Las de 30 y 90 quedan como respaldo.
   */
  totalSold14d?: number;
  avgDailySales14d?: number;
  daysZeroStock14d?: number;
  /** Etiqueta de banda que devuelve el backend (RED/YELLOW/GREEN/UNSET, o sus alias). */
  stockBand?: string;
  /** Razon por la que se pide: alcanzar target de 75% del minimo o cubrir demanda 30/90. */
  orderReason?: "target" | "demand" | "none";
  /** Direccion sugerida del cambio de minimo. La decision final es del duenio (boton manual). */
  suggestedMinStockReason?: "increase" | "decrease" | string;

  /**
   * Mínimo sugerido por el backend cuando detecta que el mínimo actual está
   * muy por encima (o por debajo) de lo que el producto vende. La tarjeta
   * solo aplica el cambio con el boton manual; nunca automaticamente.
   */
  suggestedMinStock?: number;

  /**
   * Proxima fecha de visita segun los dias configurados en el proveedor
   * (YYYY-MM-DD, zona America/Bogota). Solo viene poblada cuando
   * leadTimeSource === "configured_days" o "learned_days".
   */
  nextVisitDate?: string | null;
  /**
   * Proxima fecha de entrega segun los dias configurados en el proveedor
   * (YYYY-MM-DD, zona America/Bogota). Es la que reemplaza al viejo
   * "hoy + N dias" como fecha propuesta en la UI.
   */
  nextDeliveryDate?: string | null;
  /** Dias que faltan para la proxima visita (0 si hoy es dia de visita). */
  daysUntilNextVisit?: number | null;
  /**
   * De donde salio el lead time efectivo. La UI lo usa para mostrar si la
   * fecha propuesta viene de la agenda del proveedor o de una estimacion.
   */
  leadTimeSource?:
    | "configured_days"
    | "learned_days"
    | "explicit_lead_time"
    | "visit_frequency_learned"
    | "default";

  // ---- BLOQUE 1: AGENDA MANUAL (lo que el dueno escribio) ----
  visitDays?: string[];
  deliveryDays?: string[];
  scheduleHasConfigured?: boolean;

  // ---- BLOQUE 2: AGENDA APRENDIDA (lo que el sistema observo) ----
  learnedVisitDays?: string[];
  learnedDeliveryDays?: string[];
  learnedLeadTimeDays?: number | null;
  learnedSampleCount?: number;
  learnedAt?: string | null;

  agendaSource?: "manual" | "learned" | "none";
}

interface UseSmartRestockOptions {
  /** Texto de busqueda ya deshoyado (el debounce vive fuera). Vacio = sin filtro. */
  search?: string;
  /** true = "ver todo el catalogo" (default off = solo prioridades). */
  includeAll?: boolean;
  /** true = productos sin proveedor; fuerza include_all y omite supplier_id. */
  unassignedOnly?: boolean;
}

/**
 * Foto mínima de un producto para poder mostrarlo en el carrito aunque ya no
 * venga en la respuesta actual (porque se buscó otra cosa o cambió el filtro).
 *
 * primarySupplierId es imprescindible, no decorativo: al ENVIAR el pedido hay
 * que saber a qué proveedor pertenece cada producto elegido, y los que están
 * fuera de la vista sólo existen en esta foto.
 */
interface SelectedItemSnapshot {
  productId: string;
  productName: string;
  unitCost: number;
  supplierName: string;
  primarySupplierId: number | null;
}

/** Una línea del carrito: lo que el dueño realmente va a pedir. */
export interface SelectedItem extends SelectedItemSnapshot {
  quantity: number;
  subtotal: number;
  /** false = el producto no está en la vista actual (se buscó otra cosa). */
  enVista: boolean;
}

/**
 * Clave de localStorage donde se guarda el pedido a medio armar.
 *
 * POR QUÉ SE PERSISTE (pedido del dueño, 2026-09-05): "si me salgo por
 * equivocacion y vuelvo y entro me tiene que cargar lo que ya tenia
 * seleccionado". Armar un pedido de 40 productos y perderlo por un clic en el
 * menú es inaceptable.
 */
const CART_STORAGE_KEY = "pos_restock_cart_v1";

/** El borrador se descarta pasado este tiempo para no revivir pedidos viejos. */
const CART_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface PersistedCart {
  supplierKey: string;
  quantities: Record<string, number>;
  snapshots: SelectedItemSnapshot[];
  savedAt: number;
}

function loadPersistedCart(supplierKey: string): PersistedCart | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CART_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedCart;
    if (!parsed || parsed.supplierKey !== supplierKey) return null;
    if (!Number.isFinite(parsed.savedAt) || Date.now() - parsed.savedAt > CART_MAX_AGE_MS) return null;
    if (!parsed.quantities || typeof parsed.quantities !== "object") return null;
    return parsed;
  } catch {
    // Un borrador corrupto no puede tumbar la pantalla de pedidos.
    return null;
  }
}

// suggestedQuantities prellena las cantidades con lo que sugiere el backend.
//
// NO se filtra por categoría acá. El backend es la única autoridad sobre cuánto
// pedir: su sugerencia ya contempla el PISO POR STOCK MÍNIMO, que manda sobre
// la clase ABC. Antes esta función forzaba 0 en clase C, y eso anulaba el
// arreglo: un producto de baja rotación por debajo del mínimo llegaba con
// suggestedOrderQty correcto y "Aplicar sugerencias" lo volvía a poner en cero,
// que es exactamente lo que el dueño reportó como "no me sugiere pedir
// productos que sí se necesitan".
//
// La implementación vive en @/lib/order-submission.mjs para poder probarla con
// `node --test` (ver tests/order-submission.test.mjs).
function suggestedQuantities(items: RestockSuggestion[]): Record<string, number> {
  return suggestedQuantitiesPure(items);
}

export function useSmartRestock(
  supplierId: string | number,
  options: UseSmartRestockOptions = {},
) {
  const supplierKey = String(supplierId || "global");
  const { search = "", includeAll = false, unassignedOnly = false } = options;
  const effectiveUnassignedOnly = unassignedOnly || supplierKey === "unassigned";
  const effectiveIncludeAll = effectiveUnassignedOnly || includeAll;

  // La URL vive en un helper puro para poder testear la construccion con
  // `node --test` (tests/restock-endpoint.test.mjs). En modo huérfanos existe
  // una sola key estable: include_all siempre es true y supplier_id se omite.
  const endpoint = useMemo(
    () => buildRestockSuggestionsEndpoint({
      supplierId: supplierKey,
      search,
      includeAll: effectiveIncludeAll,
      unassignedOnly: effectiveUnassignedOnly,
    }),
    [supplierKey, search, effectiveIncludeAll, effectiveUnassignedOnly],
  );

  const { data, error, isLoading, isValidating, mutate } = useApi<RestockSuggestion[]>(
    endpoint,
    { keepPreviousData: false }
  );
  // La lista se ordena por gravedad SIEMPRE, incluso si el backend ya devolvio
  // un orden: la UI es la fuente de verdad del orden visual (CRITICO ->
  // ADVERTENCIA -> OPTIMO -> SIN_MINIMO), con los desempates documentados en
  // restock-ordering.mjs.
  const suggestions = useMemo<RestockSuggestion[]>(
    () => (data ? (orderSuggestions(data) as RestockSuggestion[]) : []),
    [data],
  );
  const editedProducts = useRef(new Set<string>());
  const activeSupplierKey = useRef(supplierKey);
  // Foto de los productos que pasaron por la vista: el carrito la necesita para
  // poder listar lo elegido cuando el producto ya no viene en la respuesta
  // (porque el dueño buscó otra cosa o cambió el filtro).
  const selectedSnapshots = useRef(new Map<string, SelectedItemSnapshot>());

  // RESTAURAR el pedido a medio armar al entrar a la pantalla.
  //
  // Se hace con inicializador perezoso del estado (no en un efecto) para que la
  // primera pintura ya traiga las cantidades: si se hiciera en un efecto, el
  // usuario vería un instante el pedido vacío y el efecto que reacciona a `data`
  // podría pisarlo antes de restaurarlo.
  const [orderQuantities, setOrderQuantities] = useState<Record<string, number>>(() => {
    const guardado = loadPersistedCart(supplierKey);
    if (!guardado) return {};
    for (const foto of guardado.snapshots ?? []) {
      if (foto?.productId) selectedSnapshots.current.set(foto.productId, foto);
    }
    return guardado.quantities;
  });

  // Lo restaurado cuenta como "editado por el usuario": si no, el efecto que
  // reacciona a `data` lo pondría en cero por considerarlo no tocado.
  const restoredOnce = useRef(false);
  if (!restoredOnce.current) {
    restoredOnce.current = true;
    for (const productId of Object.keys(orderQuantities)) {
      editedProducts.current.add(productId);
    }
  }

  useEffect(() => {
    if (activeSupplierKey.current === supplierKey) return;
    activeSupplierKey.current = supplierKey;
    editedProducts.current.clear();
    selectedSnapshots.current.clear();
    setOrderQuantities({});
    // El borrador es POR PROVEEDOR: al cambiar se descarta para no mezclar
    // pedidos de proveedores distintos.
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(CART_STORAGE_KEY);
      } catch {
        /* sin localStorage el carrito sigue funcionando en memoria */
      }
    }
  }, [supplierKey]);

  // GUARDAR el borrador en cada cambio, para que salir de la pantalla por
  // equivocación no borre el pedido a medio armar.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const conCantidad = Object.entries(orderQuantities).filter(([, q]) => q > 0);
    try {
      if (conCantidad.length === 0) {
        window.localStorage.removeItem(CART_STORAGE_KEY);
        return;
      }
      const payload: PersistedCart = {
        supplierKey,
        quantities: Object.fromEntries(conCantidad),
        // Sólo las fotos de lo elegido: guardar el catálogo entero llenaría
        // localStorage sin motivo.
        snapshots: conCantidad
          .map(([productId]) => selectedSnapshots.current.get(productId))
          .filter((foto): foto is SelectedItemSnapshot => Boolean(foto)),
        savedAt: Date.now(),
      };
      window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* cuota llena o modo privado: el carrito sigue vivo en memoria */
    }
  }, [orderQuantities, supplierKey]);

  useEffect(() => {
    if (!data || activeSupplierKey.current !== supplierKey) return;
    // Las cantidades arrancan vacías: la sugerencia se muestra al lado y se
    // Las cantidades arrancan vacías: la sugerencia se muestra al lado y se
    // aplica con el botón "Aplicar sugerencias" o tocando el número sugerido.
    //
    // LO QUE YA ELEGISTE NO SE PIERDE AL BUSCAR. Antes este efecto reconstruía
    // el mapa SOLO con los productos de `data`, así que al escribir en el
    // buscador los productos que salían de la vista perdían su cantidad. Con el
    // flujo del dueño —cargar varios, buscar el que falta, seguir— eso borraba
    // el pedido a medio armar. Ahora se conservan las cantidades de todo lo
    // editado, esté o no en la vista actual.
    setOrderQuantities((current) => {
      const next: Record<string, number> = {};
      // 1) Se preserva TODO lo que el usuario ya tocó, aunque no esté en `data`.
      for (const productId of editedProducts.current) {
        const previous = current[productId] ?? 0;
        if (previous > 0) next[productId] = previous;
      }
      // 2) Los productos de la vista actual que no se tocaron arrancan en 0.
      for (const item of data) {
        if (!editedProducts.current.has(item.productId)) {
          next[item.productId] = 0;
        }
      }
      return next;
    });

    // Se guarda una FOTO de cada producto de la vista (nombre y costo) para que
    // el carrito pueda mostrar lo elegido incluso después de buscar otra cosa y
    // que el producto ya no venga en la respuesta.
    for (const item of data) {
      selectedSnapshots.current.set(item.productId, {
        productId: item.productId,
        productName: item.productName,
        unitCost: item.unitCost,
        supplierName: item.supplierName ?? "",
        primarySupplierId: item.primarySupplierId ?? null,
      });
    }
  }, [data, supplierKey]);

  const setQuantity = useCallback((productId: string, quantity: number) => {
    editedProducts.current.add(productId);
    setOrderQuantities((current) => ({
      ...current,
      [productId]: Number.isFinite(quantity) ? Math.max(0, quantity) : 0,
    }));
  }, []);

  const resetToSuggestions = useCallback(() => {
    editedProducts.current.clear();
    setOrderQuantities(suggestedQuantities(suggestions));
  }, [suggestions]);

  const clearAll = useCallback(() => {
    editedProducts.current = new Set(suggestions.map((item) => item.productId));
    setOrderQuantities(
      Object.fromEntries(suggestions.map((item) => [item.productId, 0]))
    );
  }, [suggestions]);

  const clearProducts = useCallback((productIds: string[]) => {
    for (const productId of productIds) editedProducts.current.add(productId);
    setOrderQuantities((current) => {
      const next = { ...current };
      for (const productId of productIds) next[productId] = 0;
      return next;
    });
  }, []);

  // LO ELEGIDO, sin depender de lo que esté visible.
  //
  // Antes el total y el contador se calculaban sobre `suggestions`, así que al
  // buscar algo el total BAJABA porque los demás productos salían de la vista.
  // Ahora se arman desde orderQuantities + las fotos guardadas, así el pedido
  // se mantiene entero mientras el dueño va y viene por el buscador.
  const selectedItems = useMemo<SelectedItem[]>(() => {
    const enVista = new Map(suggestions.map((item) => [item.productId, item]));
    const items: SelectedItem[] = [];

    for (const [productId, quantity] of Object.entries(orderQuantities)) {
      if (!(quantity > 0)) continue;
      const vivo = enVista.get(productId);
      const foto = selectedSnapshots.current.get(productId);
      // Si el producto está en la vista se usan sus datos frescos; si no, la
      // foto que quedó guardada. Sin ninguna de las dos no se puede mostrar.
      const productName = vivo?.productName ?? foto?.productName;
      if (!productName) continue;
      items.push({
        productId,
        productName,
        unitCost: vivo?.unitCost ?? foto?.unitCost ?? 0,
        supplierName: vivo?.supplierName ?? foto?.supplierName ?? "",
        primarySupplierId: vivo?.primarySupplierId ?? foto?.primarySupplierId ?? null,
        quantity,
        subtotal: quantity * (vivo?.unitCost ?? foto?.unitCost ?? 0),
        enVista: Boolean(vivo),
      });
    }

    // Mayor subtotal primero: lo que más pesa en la factura, arriba.
    items.sort((a, b) => {
      if (b.subtotal !== a.subtotal) return b.subtotal - a.subtotal;
      return a.productName.localeCompare(b.productName, "es");
    });
    return items;
  }, [orderQuantities, suggestions]);

  const orderTotal = useMemo(
    () => selectedItems.reduce((total, item) => total + item.subtotal, 0),
    [selectedItems]
  );

  const orderItemCount = useMemo(() => selectedItems.length, [selectedItems]);

  const categorized = useMemo<Record<ABCCategory, RestockSuggestion[]>>(() => ({
    A: suggestions.filter((item) => item.abcCategory === "A"),
    B: suggestions.filter((item) => item.abcCategory === "B"),
    C: suggestions.filter((item) => item.abcCategory === "C"),
  }), [suggestions]);

  return {
    suggestions,
    error,
    isLoading,
    isValidating,
    mutate,
    categorized,
    orderQuantities,
    setQuantity,
    resetToSuggestions,
    clearAll,
    clearProducts,
    orderTotal,
    orderItemCount,
    selectedItems,
  };
}
