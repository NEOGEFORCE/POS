"use client";

import { SuggestionCard } from "./SuggestionCard";
import type { RestockSuggestion } from "../hooks/useSmartRestock";

interface IncrementalSuggestionListProps {
  items: RestockSuggestion[];
  orderQuantities: Record<string, number>;
  onQuantityChange: (productId: string, quantity: number) => void;
  onSaveMinStock: (productId: string, minStock: number) => Promise<boolean>;
  onUnlinkSupplier: (item: RestockSuggestion) => void;
  onLinkSupplier: (item: RestockSuggestion) => void;
  canUnlink: boolean;
  canLink: boolean;
}

/**
 * Render presentacional de los productos que page.tsx ya recortó mediante su
 * presupuesto global. No mantiene paginación, sentinel ni scroll propios.
 */
export function IncrementalSuggestionList({
  items,
  orderQuantities,
  onQuantityChange,
  onSaveMinStock,
  onUnlinkSupplier,
  onLinkSupplier,
  canUnlink,
  canLink,
}: IncrementalSuggestionListProps) {
  if (items.length === 0) {
    return (
      <div className="p-6 text-center text-xs font-bold uppercase tracking-widest text-zinc-500">
        No hay productos en esta banda
      </div>
    );
  }

  return (
    <div className="w-full" role="list" aria-label="Sugerencias de reposición">
      <div className="divide-y divide-zinc-100 dark:divide-white/5">
        {items.map((item) => (
          <div key={item.productId} role="listitem">
            <SuggestionCard
              item={item}
              quantity={orderQuantities[item.productId] ?? 0}
              onQuantityChange={onQuantityChange}
              onSaveMinStock={onSaveMinStock}
              onUnlinkSupplier={onUnlinkSupplier}
              onLinkSupplier={onLinkSupplier}
              canUnlink={canUnlink}
              canLink={canLink}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
