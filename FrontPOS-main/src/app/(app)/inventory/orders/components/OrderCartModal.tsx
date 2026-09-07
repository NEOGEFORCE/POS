"use client";

import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, ScrollShadow } from "@heroui/react";
import { Minus, Plus, ShoppingCart, Trash2, X } from "lucide-react";

import type { SelectedItem } from "../hooks/useSmartRestock";

interface OrderCartModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  items: SelectedItem[];
  total: number;
  formatPrice: (value: number) => string;
  onSetQuantity: (productId: string, quantity: number) => void;
  /** Sigue al flujo normal de confirmación de la pantalla. */
  onConfirm: () => void;
  isConfirming?: boolean;
}

/**
 * Carrito del pedido: muestra SOLO los productos con cantidad puesta.
 *
 * PARA QUÉ SIRVE (pedido del dueño, 2026-09-05): revisar el pedido antes de
 * confirmarlo sin tener que recorrer cientos de tarjetas buscando cuáles tienen
 * número. Si falta algo, se cierra, se busca en el buscador y se agrega; lo que
 * ya estaba NO se pierde.
 *
 * Las cantidades se pueden ajustar acá mismo: es el último lugar donde se mira
 * el pedido antes de mandarlo, y obligar a volver a la lista para cambiar un
 * número sería dar vueltas al vicio.
 */
export function OrderCartModal({
  isOpen,
  onOpenChange,
  items,
  total,
  formatPrice,
  onSetQuantity,
  onConfirm,
  isConfirming = false,
}: OrderCartModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="2xl"
      scrollBehavior="inside"
      placement="center"
      hideCloseButton
      classNames={{
        base: "bg-white dark:bg-zinc-950 rounded-3xl border border-zinc-200 dark:border-white/10",
        header: "border-b border-zinc-200 dark:border-white/10 px-5 py-4",
        footer: "border-t border-zinc-200 dark:border-white/10 px-5 py-4 bg-zinc-50 dark:bg-zinc-900",
        body: "px-5 py-4",
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-2xl bg-emerald-600 text-white">
                  <ShoppingCart size={20} />
                </div>
                <div className="flex flex-col">
                  <h2 className="text-lg font-bold uppercase leading-tight tracking-tight">Pedido a confirmar</h2>
                  <p className="text-[12px] font-medium text-zinc-500 dark:text-zinc-400">
                    {items.length === 0
                      ? "Todavía no hay productos con cantidad"
                      : `${items.length} ${items.length === 1 ? "producto" : "productos"} con cantidad puesta`}
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Cerrar el pedido"
                className="rounded-xl p-2 text-zinc-400 transition-colors hover:bg-rose-500/10 hover:text-rose-500"
              >
                <X size={20} />
              </button>
            </ModalHeader>

            <ModalBody>
              {items.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="mb-3 grid h-14 w-14 place-items-center rounded-2xl border-2 border-dashed border-zinc-300 text-zinc-400 dark:border-white/20">
                    <ShoppingCart size={24} />
                  </div>
                  <p className="text-[13px] font-medium text-zinc-500 dark:text-zinc-400">
                    Escribí una cantidad en los productos que querés pedir y van a aparecer acá.
                  </p>
                </div>
              ) : (
                <ScrollShadow className="max-h-[55vh] space-y-2 pr-1">
                  {items.map((item) => (
                    <div
                      key={item.productId}
                      className="flex items-center gap-3 rounded-2xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-white/10 dark:bg-zinc-900/50"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-semibold uppercase leading-tight" title={item.productName}>
                          {item.productName}
                        </p>
                        <p className="mt-0.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-500">
                          {formatPrice(item.unitCost)} c/u
                          {item.supplierName ? ` · ${item.supplierName}` : ""}
                        </p>
                      </div>

                      {/* Ajuste de cantidad sin salir del carrito. */}
                      <div className="flex shrink-0 items-center gap-1 rounded-xl border border-zinc-300 dark:border-white/15">
                        <Button
                          size="sm"
                          isIconOnly
                          aria-label={`Quitar una unidad de ${item.productName}`}
                          className="h-8 w-8 min-w-8 rounded-l-xl bg-transparent text-zinc-500"
                          onPress={() => onSetQuantity(item.productId, Math.max(0, item.quantity - 1))}
                        >
                          <Minus size={14} />
                        </Button>
                        <span className="w-10 text-center text-[14px] font-bold tabular-nums">{item.quantity}</span>
                        <Button
                          size="sm"
                          isIconOnly
                          aria-label={`Agregar una unidad de ${item.productName}`}
                          className="h-8 w-8 min-w-8 rounded-r-xl bg-transparent text-zinc-500"
                          onPress={() => onSetQuantity(item.productId, item.quantity + 1)}
                        >
                          <Plus size={14} />
                        </Button>
                      </div>

                      <p className="w-24 shrink-0 text-right text-[15px] font-bold tabular-nums">
                        {formatPrice(item.subtotal)}
                      </p>

                      <Button
                        size="sm"
                        isIconOnly
                        aria-label={`Sacar ${item.productName} del pedido`}
                        title="Sacar del pedido"
                        className="h-8 w-8 min-w-8 shrink-0 rounded-xl bg-transparent text-zinc-400 hover:bg-rose-500/10 hover:text-rose-500"
                        onPress={() => onSetQuantity(item.productId, 0)}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  ))}
                </ScrollShadow>
              )}
            </ModalBody>

            <ModalFooter className="flex items-center justify-between gap-3">
              <div className="flex flex-col">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Total del pedido</span>
                <span className="text-2xl font-bold tabular-nums leading-none text-emerald-600 dark:text-emerald-400">
                  {formatPrice(total)}
                </span>
              </div>
              <div className="flex gap-2">
                <Button variant="light" className="font-semibold uppercase" onPress={onClose}>
                  Seguir agregando
                </Button>
                <Button
                  isDisabled={items.length === 0}
                  isLoading={isConfirming}
                  className="rounded-xl bg-emerald-600 px-6 font-bold uppercase tracking-wide text-white"
                  onPress={onConfirm}
                >
                  Confirmar pedido
                </Button>
              </div>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
