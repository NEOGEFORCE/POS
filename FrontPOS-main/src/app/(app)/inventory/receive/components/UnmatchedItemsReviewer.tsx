"use client";

import React, { useEffect, useState } from "react";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Chip,
  Progress,
  Autocomplete,
  AutocompleteItem,
} from "@heroui/react";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  PlusCircle,
  SkipForward,
  Sparkles,
  X,
  Search,
  Camera,
} from "lucide-react";
import dynamic from "next/dynamic";

import { useToast } from "@/hooks/use-toast";

const ScannerOverlay = dynamic(() => import('@/components/ScannerOverlay').then(m => m.ScannerOverlay), { ssr: false });

// ============================================================
// Tipos
// ============================================================

export interface UnmatchedItem {
  invoiceName: string;
  quantity: number;
  unitPrice: number;
  /** Porcentajes que el OCR extrajo de la factura (0 si no se pudo) */
  iva_percentage?: number;
  ibua_percentage?: number;
  icui_percentage?: number;
  suggestions?: Array<{
    barcode: string;
    productName: string;
    confidence: number;
  }>;
}

export interface ResolvedReceiveLine {
  barcode: string;
  productName: string;
  addedQuantity: number;
  newPurchasePrice: number;
  newSalePrice: number;
  marginPercentage: number;
  iva: number;
  icui: number;
  ibua: number;
  /** True = producto recien creado en este flujo; False = se asigno a uno existente */
  isNew: boolean;
  invoiceName: string;
  supplierId: number;
}

/** Datos pre-llenados que se mandan al ProductFormModal del padre */
export interface CreateProductPrefill {
  productName: string;
  purchasePrice: number;
  iva: number;
  ibua: number;
  icui: number;
  /** Cantidad que viene en la factura — para usarla luego en el carrito */
  invoiceQuantity: number;
  /** Nombre original de factura para guardarlo como alias del proveedor */
  invoiceName: string;
}

/** Cuando el padre completa la creacion, manda este objeto al reviewer
    para que avance al siguiente item automaticamente. */
export interface ExternalResolution {
  barcode: string;
  productName: string;
  salePrice: number;
  marginPercentage: number;
  iva: number;
  ibua: number;
  icui: number;
  /** ID interno para evitar reaplicar la misma resolucion dos veces */
  resolutionId: number;
}

interface UnmatchedItemsReviewerProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  items: UnmatchedItem[];
  supplierId: string | number;
  /** Callback cuando termina la revision — recibe TODOS los items resueltos */
  onResolved: (resolved: ResolvedReceiveLine[]) => void;
  /** Solicita al padre abrir el ProductFormModal con estos datos pre-llenados */
  onRequestCreateNewProduct: (prefill: CreateProductPrefill) => void;
  /** Resolucion externa: cuando el padre completa la creacion, setea esto y
      el reviewer avanza al siguiente item automaticamente. */
  externalResolution?: ExternalResolution | null;
  /** El reviewer marca cuando "consumio" la externalResolution para que el padre
      la limpie y no re-aplique. */
  onExternalResolutionConsumed?: () => void;
  products?: any[]; // Products passed from parent for manual search
}

// ============================================================
// Componente
// ============================================================

export default function UnmatchedItemsReviewer({
  isOpen,
  onOpenChange,
  items,
  supplierId,
  onResolved,
  onRequestCreateNewProduct,
  externalResolution,
  onExternalResolutionConsumed,
  products = [],
}: UnmatchedItemsReviewerProps) {
  const { toast } = useToast();

  const [currentIdx, setCurrentIdx] = useState(0);
  const [resolvedItems, setResolvedItems] = useState<ResolvedReceiveLine[]>([]);
  const [lastResolutionId, setLastResolutionId] = useState<number | null>(null);
  
  const [manualSearchKey, setManualSearchKey] = useState<string | number | null>(null);

  // Para el escaner
  const [isScannerOpen, setIsScannerOpen] = useState(false);

  // Reset al abrir
  useEffect(() => {
    if (isOpen) {
      setCurrentIdx(0);
      setResolvedItems([]);
      setLastResolutionId(null);
    }
  }, [isOpen]);

  const current = items[currentIdx];
  const progressPct = items.length > 0 ? ((currentIdx + 1) / items.length) * 100 : 0;

  // ============================================================
  // Avanzar al siguiente item (o cerrar si fue el ultimo)
  // ============================================================
  const advanceTo = (next: ResolvedReceiveLine | null) => {
    const updatedResolved = next ? [...resolvedItems, next] : resolvedItems;
    if (next) setResolvedItems(updatedResolved);

    const isLast = currentIdx >= items.length - 1;
    if (isLast) {
      onResolved(updatedResolved);
      onOpenChange(false);
      toast({
        variant: "success",
        title: "Revision completada",
        description: `${updatedResolved.length} de ${items.length} items resueltos. Ahora puedes guardar la factura.`,
      });
      return;
    }
    setCurrentIdx(idx => idx + 1);
  };

  // ============================================================
  // Aceptar resolucion externa (cuando el padre crea el producto)
  // ============================================================
  useEffect(() => {
    if (!externalResolution) return;
    if (externalResolution.resolutionId === lastResolutionId) return;
    if (!current) return;

    setLastResolutionId(externalResolution.resolutionId);

    const resolved: ResolvedReceiveLine = {
      barcode: externalResolution.barcode,
      productName: externalResolution.productName,
      addedQuantity: current.quantity,
      newPurchasePrice: current.unitPrice,
      newSalePrice: externalResolution.salePrice,
      marginPercentage: externalResolution.marginPercentage,
      iva: externalResolution.iva,
      ibua: externalResolution.ibua,
      icui: externalResolution.icui,
      isNew: true,
      invoiceName: current.invoiceName,
      supplierId: Number(supplierId),
    };

    advanceTo(resolved);
    onExternalResolutionConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalResolution]);

  // ============================================================
  // Acciones
  // ============================================================

  // Asignar el item actual a una sugerencia existente (sin crear producto nuevo)
  const handleAssignToSuggestion = (suggestion: NonNullable<UnmatchedItem["suggestions"]>[number]) => {
    if (!current) return;
    advanceTo({
      barcode: suggestion.barcode,
      productName: suggestion.productName,
      addedQuantity: current.quantity,
      newPurchasePrice: current.unitPrice,
      newSalePrice: 0,
      marginPercentage: 20,
      iva: Number(current.iva_percentage) || 0,
      icui: Number(current.icui_percentage) || 0,
      ibua: Number(current.ibua_percentage) || 0,
      isNew: false,
      invoiceName: current.invoiceName,
      supplierId: Number(supplierId),
    });
  };

  // Asignar el item actual a un producto buscado manualmente
  const handleAssignToManual = (key: any) => {
    if (!key || !current) return;
    const selectedProd = products.find(p => p.barcode === key);
    if (!selectedProd) return;

    advanceTo({
      barcode: selectedProd.barcode,
      productName: selectedProd.productName,
      addedQuantity: current.quantity,
      newPurchasePrice: current.unitPrice,
      newSalePrice: 0,
      marginPercentage: 20,
      iva: Number(current.iva_percentage) || 0,
      icui: Number(current.icui_percentage) || 0,
      ibua: Number(current.ibua_percentage) || 0,
      isNew: false, // Es falso porque estamos usando uno existente, esto fuerza a que lo trate como 'match' en page.tsx
      invoiceName: current.invoiceName,
      supplierId: Number(supplierId),
    });
    setManualSearchKey(null);
  };

  const handleScanResult = (code: string) => {
    setIsScannerOpen(false);
    if (!current) return;
    const selectedProd = products.find(p => p.barcode === code);
    if (!selectedProd) {
      toast({
        title: "No encontrado",
        description: `El codigo ${code} no existe en la base de datos.`,
        variant: "destructive"
      });
      return;
    }
    
    // Si lo encuentra, lo asignamos igual que el manual
    advanceTo({
      barcode: selectedProd.barcode,
      productName: selectedProd.productName,
      addedQuantity: current.quantity,
      newPurchasePrice: current.unitPrice,
      newSalePrice: 0,
      marginPercentage: 20,
      iva: Number(current.iva_percentage) || 0,
      icui: Number(current.icui_percentage) || 0,
      ibua: Number(current.ibua_percentage) || 0,
      isNew: false,
      invoiceName: current.invoiceName,
      supplierId: Number(supplierId),
    });
  };

  // Pedir al padre que abra el ProductFormModal con datos pre-llenados
  const handleOpenProtocol = () => {
    if (!current) return;
    onRequestCreateNewProduct({
      productName: current.invoiceName.toUpperCase().trim(),
      purchasePrice: current.unitPrice || 0,
      iva: Number(current.iva_percentage) || 0,
      ibua: Number(current.ibua_percentage) || 0,
      icui: Number(current.icui_percentage) || 0,
      invoiceQuantity: current.quantity,
      invoiceName: current.invoiceName,
    });
  };

  // Saltar este item
  const handleSkip = () => {
    advanceTo(null);
  };

  // ============================================================
  // Render
  // ============================================================

  if (!current) return null;

  // Indicador visual de impuestos detectados
  const hasOcrTaxes = (Number(current.iva_percentage) || 0) > 0
    || (Number(current.ibua_percentage) || 0) > 0
    || (Number(current.icui_percentage) || 0) > 0;

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="2xl"
      backdrop="blur"
      isDismissable={false}
      hideCloseButton
      classNames={{
        base: "bg-white dark:bg-zinc-950 border border-amber-500/20 rounded-[2rem]",
        header: "border-b border-amber-500/10 px-6 py-4",
        body: "p-6",
        footer: "border-t border-zinc-200 dark:border-white/5 px-6 py-4",
      }}
    >
      <ModalContent>
        <>
          <ModalHeader className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-2xl bg-amber-500/10 text-amber-500 flex items-center justify-center">
                  <AlertCircle size={20} />
                </div>
                <div className="flex flex-col">
                  <h2 className="text-base font-medium tracking-tight uppercase text-zinc-900 dark:text-zinc-50">
                    Productos sin emparejar
                  </h2>
                  <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-amber-600">
                    Revisa uno a uno · {currentIdx + 1} de {items.length}
                  </p>
                </div>
              </div>
              <Chip
                size="sm"
                variant="flat"
                className="bg-emerald-500/10 text-emerald-600 font-medium text-[9px] uppercase tracking-widest"
                startContent={<CheckCircle2 size={10} className="ml-1" />}
              >
                {resolvedItems.length} resueltos
              </Chip>
            </div>
            <Progress value={progressPct} size="sm" color="warning" className="mt-2" />
          </ModalHeader>

          <ModalBody>
            {/* Datos del item actual */}
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-4">
              <div className="flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-[9px] font-bold uppercase tracking-widest text-amber-600 mb-1">
                    Nombre en factura
                  </p>
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 uppercase break-words">
                    {current.invoiceName}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">Cant</p>
                  <p className="text-base font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{current.quantity}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">Precio</p>
                  <p className="text-base font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
                    ${Math.round(current.unitPrice).toLocaleString("es-CO")}
                  </p>
                </div>
              </div>

              {/* Pista de impuestos detectados */}
              {hasOcrTaxes && (
                <div className="mt-3 pt-3 border-t border-amber-500/10 flex items-center gap-3 flex-wrap">
                  <span className="text-[9px] font-bold uppercase tracking-widest text-emerald-600">
                    ✨ OCR detecto:
                  </span>
                  {(Number(current.iva_percentage) || 0) > 0 && (
                    <Chip size="sm" variant="flat" className="bg-emerald-500/10 text-emerald-600 font-medium text-[9px] uppercase tabular-nums">
                      IVA {current.iva_percentage}%
                    </Chip>
                  )}
                  {(Number(current.ibua_percentage) || 0) > 0 && (
                    <Chip size="sm" variant="flat" className="bg-emerald-500/10 text-emerald-600 font-medium text-[9px] uppercase tabular-nums">
                      IBUA {current.ibua_percentage}%
                    </Chip>
                  )}
                  {(Number(current.icui_percentage) || 0) > 0 && (
                    <Chip size="sm" variant="flat" className="bg-emerald-500/10 text-emerald-600 font-medium text-[9px] uppercase tabular-nums">
                      ICUI {current.icui_percentage}%
                    </Chip>
                  )}
                </div>
              )}
            </div>

            {/* Sugerencias del OCR */}
            {current.suggestions && current.suggestions.length > 0 && (
              <div className="space-y-2 mt-4">
                <div className="flex items-center gap-2">
                  <Sparkles size={12} className="text-emerald-500" />
                  <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-600 dark:text-zinc-400">
                    ¿Es alguno de estos productos?
                  </p>
                </div>
                <div className="space-y-2">
                  {current.suggestions.slice(0, 5).map((sug, i) => (
                    <button
                      key={`${sug.barcode}-${i}`}
                      onClick={() => handleAssignToSuggestion(sug)}
                      className="w-full p-3 rounded-xl border border-zinc-200 dark:border-white/5 bg-white dark:bg-zinc-900 hover:border-emerald-500/50 hover:bg-emerald-500/5 transition-all flex items-center gap-3 text-left group"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-zinc-900 dark:text-zinc-100 uppercase truncate">
                          {sug.productName}
                        </p>
                        <p className="text-[9px] font-medium text-zinc-500 tabular-nums tracking-wider">
                          {sug.barcode}
                        </p>
                      </div>
                      <Chip
                        size="sm"
                        variant="flat"
                        className={`font-medium text-[9px] uppercase tabular-nums ${
                          sug.confidence >= 0.6
                            ? "bg-emerald-500/10 text-emerald-600"
                            : sug.confidence >= 0.4
                              ? "bg-amber-500/10 text-amber-600"
                              : "bg-zinc-500/10 text-zinc-500"
                        }`}
                      >
                        {Math.round(sug.confidence * 100)}%
                      </Chip>
                      <ArrowRight size={14} className="text-zinc-400 group-hover:text-emerald-500 group-hover:translate-x-1 transition-all" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Buscador manual de productos existentes */}
            <div className="mt-6">
              <div className="flex items-center gap-2 mb-2">
                <Search size={12} className="text-blue-500" />
                <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-600 dark:text-zinc-400">
                  ¿El producto ya existe? Buscalo aqui:
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Autocomplete
                  key={currentIdx}
                  aria-label="Buscar producto existente"
                  placeholder="Escribe codigo o nombre del producto..."
                  defaultItems={products}
                  selectedKey={manualSearchKey}
                  onSelectionChange={handleAssignToManual}
                  size="lg"
                  classNames={{
                    base: "w-full",
                    listboxWrapper: "max-h-[250px]",
                    selectorButton: "text-zinc-500",
                  }}
                  inputProps={{
                    classNames: {
                      inputWrapper: "h-14 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/10 rounded-2xl shadow-inner",
                      input: "font-medium text-sm text-zinc-900 dark:text-zinc-100",
                    }
                  }}
                  popoverProps={{
                    classNames: {
                      content: "p-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/10 shadow-2xl",
                    }
                  }}
                >
                  {(item) => (
                    <AutocompleteItem key={item.barcode} textValue={`${item.productName} - ${item.barcode}`}>
                      <div className="flex flex-col py-1">
                        <span className="text-sm font-medium uppercase text-zinc-900 dark:text-zinc-100">{item.productName}</span>
                        <span className="text-[10px] font-mono text-zinc-500">#{item.barcode}</span>
                      </div>
                    </AutocompleteItem>
                  )}
                </Autocomplete>
                <Button 
                  isIconOnly 
                  onPress={() => setIsScannerOpen(true)}
                  className="h-14 w-14 shrink-0 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-white/10 rounded-2xl text-zinc-500 hover:text-emerald-500 hover:border-emerald-500/50 transition-all shadow-inner"
                >
                  <Camera size={22} />
                </Button>
              </div>
            </div>

            {/* CTA principal: abrir Protocolo de nuevo producto */}
            <div className="mt-6 pt-4 border-t border-dashed border-zinc-200 dark:border-white/10">
              <Button
                onPress={handleOpenProtocol}
                size="lg"
                className="w-full h-14 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white font-bold text-[11px] uppercase tracking-[0.2em] rounded-2xl shadow-[0_8px_30px_rgba(59,130,246,0.25)]"
                startContent={<PlusCircle size={18} strokeWidth={2.5} />}
              >
                + Abrir Protocolo de Nuevo Producto
              </Button>
              <p className="text-[9px] font-medium text-zinc-500 dark:text-zinc-500 uppercase tracking-widest text-center mt-2">
                Pre-cargado con nombre, costo e impuestos detectados
              </p>
            </div>
          </ModalBody>

          <ModalFooter className="flex justify-between items-center gap-2">
            <Button
              variant="light"
              onPress={handleSkip}
              startContent={<SkipForward size={14} />}
              className="text-[10px] font-medium uppercase tracking-widest text-zinc-500"
            >
              Saltar este item
            </Button>
            <Button
              variant="light"
              onPress={() => onOpenChange(false)}
              startContent={<X size={14} />}
              className="text-[10px] font-medium uppercase tracking-widest text-zinc-500"
            >
              Cancelar revision
            </Button>
          </ModalFooter>
        </>
      </ModalContent>
      {isScannerOpen && (
        <ScannerOverlay
          isOpen={isScannerOpen}
          onClose={() => setIsScannerOpen(false)}
          onResult={handleScanResult}
          title="ESCANEAR PARA ASIGNAR"
        />
      )}
    </Modal>
  );
}
