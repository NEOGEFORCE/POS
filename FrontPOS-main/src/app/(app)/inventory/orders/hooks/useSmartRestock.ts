"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";

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
  unitCost: number;
  calculatedAt: string;
  inTransit: boolean;
  cheaperSupplier?: CheaperSupplierAlert;
  lastReceptionAt?: string | null;
  daysSinceReception?: number | null;
  soldSinceReception?: number;
  recommendation?: string;
  recommendationLevel?: "urgent" | "order" | "wait" | "skip";
}

function suggestedQuantities(items: RestockSuggestion[]): Record<string, number> {
  return Object.fromEntries(
    items.map((item) => [
      item.productId,
      item.abcCategory === "C" ? 0 : Math.max(0, item.suggestedOrderQty),
    ])
  );
}

export function useSmartRestock(supplierId: string | number) {
  const supplierKey = String(supplierId || "global");
  const endpoint = supplierKey !== "global" && supplierKey !== "0"
    ? `/restock/suggestions-v2?supplier_id=${encodeURIComponent(supplierKey)}`
    : "/restock/suggestions-v2";

  const { data, error, isLoading, isValidating, mutate } = useApi<RestockSuggestion[]>(
    endpoint,
    { keepPreviousData: false }
  );
  const suggestions = useMemo(() => data ?? [], [data]);
  const [orderQuantities, setOrderQuantities] = useState<Record<string, number>>({});
  const editedProducts = useRef(new Set<string>());
  const activeSupplierKey = useRef(supplierKey);

  useEffect(() => {
    if (activeSupplierKey.current === supplierKey) return;
    activeSupplierKey.current = supplierKey;
    editedProducts.current.clear();
    setOrderQuantities({});
  }, [supplierKey]);

  useEffect(() => {
    if (!data || activeSupplierKey.current !== supplierKey) return;
    // Las cantidades arrancan vacías: la sugerencia se muestra al lado y se
    // aplica con el botón "Aplicar sugerencias" o tocando el número sugerido.
    setOrderQuantities((current) => {
      const next: Record<string, number> = {};
      for (const item of data) {
        next[item.productId] = editedProducts.current.has(item.productId)
          ? Math.max(0, current[item.productId] ?? 0)
          : 0;
      }
      return next;
    });
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

  const orderTotal = useMemo(
    () => suggestions.reduce(
      (total, item) => total + (orderQuantities[item.productId] ?? 0) * item.unitCost,
      0
    ),
    [orderQuantities, suggestions]
  );

  const orderItemCount = useMemo(
    () => suggestions.filter((item) => (orderQuantities[item.productId] ?? 0) > 0).length,
    [orderQuantities, suggestions]
  );

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
  };
}
