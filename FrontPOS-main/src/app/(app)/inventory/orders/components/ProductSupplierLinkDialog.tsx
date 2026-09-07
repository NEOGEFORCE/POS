"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Autocomplete,
  AutocompleteItem,
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";
import { Link2, Package } from "lucide-react";

import type { Supplier } from "@/lib/definitions";
import type { RestockSuggestion } from "../hooks/useSmartRestock";

interface ProductSupplierLinkDialogProps {
  isOpen: boolean;
  product: RestockSuggestion | null;
  suppliers: Supplier[];
  isSaving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (supplierId: number) => Promise<void>;
}

function normalizeSearch(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

export function ProductSupplierLinkDialog({
  isOpen,
  product,
  suppliers,
  isSaving,
  onOpenChange,
  onSave,
}: ProductSupplierLinkDialogProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!isOpen) {
      setSelectedKey(null);
      setQuery("");
    }
  }, [isOpen, product?.productId]);

  const filteredSuppliers = useMemo(() => {
    const normalized = normalizeSearch(query);
    if (!normalized) return suppliers;
    return suppliers.filter((supplier) => normalizeSearch(supplier.name ?? "").includes(normalized));
  }, [query, suppliers]);

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      placement="center"
      scrollBehavior="inside"
      size="lg"
      classNames={{
        base: "mx-3 rounded-2xl border border-zinc-200 bg-white dark:border-white/10 dark:bg-zinc-900",
        backdrop: "bg-black/60",
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex items-start gap-3 border-b border-zinc-200 px-5 py-4 dark:border-white/10">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-300">
                <Link2 size={20} aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block text-base font-black uppercase text-zinc-900 dark:text-white">Vincular proveedor</span>
                <span className="block truncate text-xs font-medium text-zinc-500">{product?.productName ?? "Producto"}</span>
              </span>
            </ModalHeader>
            <ModalBody className="gap-4 px-5 py-5">
              <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-white/10 dark:bg-zinc-950">
                <Package size={16} className="shrink-0 text-zinc-500" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-zinc-900 dark:text-white">{product?.productName}</p>
                  <p className="truncate text-[10px] text-zinc-500">{product?.productId}</p>
                </div>
              </div>
              <Autocomplete
                label="Proveedor activo"
                placeholder="Buscar proveedor…"
                aria-label="Proveedor que surtirá el producto"
                items={filteredSuppliers}
                selectedKey={selectedKey}
                inputValue={query}
                onInputChange={setQuery}
                onSelectionChange={(key) => {
                  const value = key ? String(key) : null;
                  setSelectedKey(value);
                  const selected = suppliers.find((supplier) => String(supplier.id) === value);
                  if (selected) setQuery(selected.name);
                }}
                allowsCustomValue={false}
                menuTrigger="focus"
                classNames={{
                  listbox: "bg-white p-1 dark:bg-zinc-950",
                  popoverContent: "rounded-2xl border border-zinc-200 bg-white p-1 shadow-lg dark:border-white/10 dark:bg-zinc-950",
                }}
                inputProps={{
                  classNames: {
                    inputWrapper: "min-h-12 rounded-xl border border-zinc-200 bg-zinc-50 shadow-none dark:border-white/10 dark:bg-[#121214]",
                  },
                }}
              >
                {(supplier) => (
                  <AutocompleteItem key={String(supplier.id)} textValue={supplier.name} className="rounded-xl">
                    <span className="text-xs font-semibold uppercase">{supplier.name}</span>
                  </AutocompleteItem>
                )}
              </Autocomplete>
              {suppliers.length === 0 && (
                <p role="status" className="text-xs font-medium text-amber-700 dark:text-amber-300">
                  No hay proveedores activos disponibles.
                </p>
              )}
            </ModalBody>
            <ModalFooter className="border-t border-zinc-200 px-5 py-4 dark:border-white/10">
              <Button variant="flat" onPress={onClose} isDisabled={isSaving}>Cancelar</Button>
              <Button
                color="warning"
                onPress={() => selectedKey && void onSave(Number(selectedKey))}
                isDisabled={!selectedKey || isSaving}
                isLoading={isSaving}
                startContent={!isSaving && <Link2 size={15} aria-hidden="true" />}
              >
                Guardar vínculo
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
