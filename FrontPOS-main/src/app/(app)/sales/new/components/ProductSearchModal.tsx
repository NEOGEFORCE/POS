"use client";

import React, { useState, useEffect, useRef } from "react";
import { Modal, ModalContent, ModalBody, Input, ModalHeader } from "@heroui/react";
import { Search, Package } from "lucide-react";
import { Product } from "@/lib/definitions";
import { formatCurrency } from "@/lib/utils";

interface ProductSearchModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  products: Product[];
  onSelect: (product: Product) => void;
}

export default function ProductSearchModal({
  isOpen,
  onOpenChange,
  products,
  onSelect,
}: ProductSearchModalProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredProducts = React.useMemo(() => {
    if (!query.trim() || !Array.isArray(products)) return [];
    const lowerQuery = query.toLowerCase();
    return products
      .filter(
        (p) =>
          (p.productName || '').toLowerCase().includes(lowerQuery) ||
          (p.barcode || '').toLowerCase().includes(lowerQuery) ||
          (p.alternateCodes || '').toLowerCase().includes(lowerQuery)
      )
      .slice(0, 10); // Limitamos a 10 resultados para no saturar la vista
  }, [products, query]);

  // Reset al abrir
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Seleccionar primer resultado si la busqueda cambia
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        prev < filteredProducts.length - 1 ? prev + 1 : prev
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
    } else if (e.key === "Insert" || e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (filteredProducts.length > 0 && filteredProducts[selectedIndex]) {
        onSelect(filteredProducts[selectedIndex]);
        onOpenChange(false);
      }
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="2xl"
      hideCloseButton
      placement="top"
      classNames={{
        base: "bg-zinc-900 border border-white/10",
      }}
    >
      <ModalContent>
        {() => (
          <>
            <ModalBody className="p-0">
              <div className="flex items-center px-4 py-3 border-b border-white/10">
                <Search className="w-5 h-5 text-zinc-500 mr-3" />
                <input
                  ref={inputRef}
                  type="text"
                  placeholder="Buscar producto por nombre o código..."
                  className="flex-1 bg-transparent border-none text-white outline-none text-lg placeholder:text-zinc-600"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
                />
              </div>

              {query.trim().length > 0 && (
                <div className="max-h-[60vh] overflow-y-auto p-2">
                  {filteredProducts.length === 0 ? (
                    <div className="py-8 text-center text-zinc-500 text-sm">
                      No se encontraron resultados
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {filteredProducts.map((p, idx) => {
                        const isSelected = idx === selectedIndex;
                        return (
                          <div
                            key={p.barcode}
                            className={`flex items-center justify-between p-3 rounded-xl cursor-pointer transition-colors ${
                              isSelected
                                ? "bg-emerald-500/20 border border-emerald-500/30"
                                : "hover:bg-white/5 border border-transparent"
                            }`}
                            onClick={() => {
                              onSelect(p);
                              onOpenChange(false);
                            }}
                          >
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-lg bg-black/20 flex items-center justify-center text-zinc-500">
                                <Package className="w-4 h-4" />
                              </div>
                              <div className="flex flex-col">
                                <div className="flex items-center gap-2">
                                  <span className={`text-sm font-semibold ${isSelected ? "text-emerald-400" : "text-zinc-200"}`}>
                                    {p.productName}
                                  </span>
                                  {p.isPack && (
                                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400 border border-purple-500/30 uppercase">
                                      PACK x{p.packMultiplier || 1}
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 text-[10px] text-zinc-500 font-mono">
                                  <span>{p.barcode} • Stock: {p.quantity}</span>
                                  {p.alternateCodes && p.alternateCodes.toLowerCase().includes(query.toLowerCase()) && (
                                    <span className="text-[9px] text-sky-400 bg-sky-500/10 px-1 py-0.2 rounded font-sans">
                                      Alt: {p.alternateCodes}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                            <span className="text-base font-bold text-white tabular-nums">
                              ${formatCurrency(p.salePrice)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </ModalBody>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
