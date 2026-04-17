"use client";

import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, Input, Select, SelectItem, Checkbox
} from "@heroui/react";
import { Package, Barcode, Camera, Sparkles, TrendingUp } from 'lucide-react';
import { Product, Category } from '@/lib/definitions';
import { applyRounding } from '@/lib/utils';
import { fetchProductFromOpenFoodFacts } from '@/lib/external-apis';
import { useState } from 'react';

// Formateador de moneda local para evitar errores de importación
const formatCOP = (value: number) => {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(value);
};

interface ProductFormModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  addDialogOpen: boolean;
  newProduct: Omit<Product, 'id'>;
  setNewProduct: (p: any) => void;
  editingProduct: Product | null;
  setEditingProduct: (p: any) => void;
  newMargin: number;
  setNewMargin: (m: number) => void;
  editMargin: number;
  setEditMargin: (m: number) => void;
  categories: Category[];
  suppliers: any[];
  onConfirm: () => void;
  onScan: () => void;
}

export default function ProductFormModal({
  isOpen, onOpenChange, addDialogOpen,
  newProduct, setNewProduct,
  editingProduct, setEditingProduct,
  newMargin, setNewMargin,
  editMargin, setEditMargin,
  categories, suppliers, onConfirm, onScan
}: ProductFormModalProps) {
  const [isFetchingInfo, setIsFetchingInfo] = useState(false);

  const handleAIFill = async () => {
    const barcode = addDialogOpen ? newProduct.barcode : (editingProduct?.barcode || '');
    if (!barcode) return;

    setIsFetchingInfo(true);
    try {
      const data = await fetchProductFromOpenFoodFacts(barcode);
      if (data?.image_url) {
        if (addDialogOpen) {
          setNewProduct((p: any) => ({ ...p, imageUrl: data.image_url, productName: p.productName || data.product_name?.toUpperCase() }));
        } else {
          setEditingProduct((p: any) => p ? { ...p, imageUrl: data.image_url, productName: p.productName || data.product_name?.toUpperCase() } : null);
        }
      }
    } finally {
      setIsFetchingInfo(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      placement="top-center"
      scrollBehavior="inside"
      onOpenChange={onOpenChange}
      backdrop="blur"
      size="xl"
      classNames={{
        base: "bg-white/90 dark:bg-zinc-950/90 backdrop-blur-3xl rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-2xl overflow-visible m-4",
        closeButton: "text-gray-400 dark:text-zinc-500 hover:text-rose-500 transition-colors"
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex flex-col gap-1 p-10 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-t-[2.5rem]">
              <h2 className="text-2xl font-black text-gray-900 dark:text-white italic tracking-tighter uppercase leading-none flex items-center gap-4">
                <div className="h-16 w-16 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-500 flex items-center justify-center rounded-2xl shadow-inner rotate-3"><Package size={32} /></div>
                <div className="flex flex-col">
                  <span>{addDialogOpen ? "Protocolo de " : "Modificar "} <span className="text-emerald-500">Ingreso</span></span>
                  <span className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest mt-1 not-italic">Audit Ledger Maestro — Control de Stock</span>
                </div>
              </h2>
            </ModalHeader>

            <ModalBody className="p-10 gap-10">
              {/* PHOTO SELECTOR SECTION */}
              <div className="flex flex-col items-center gap-4 py-2 border-b border-gray-100 dark:border-white/5 pb-10">
                <div className="relative group/photo cursor-pointer shrink-0">
                  <div className="h-32 w-32 rounded-[2rem] bg-gray-50 dark:bg-zinc-900 border-2 border-dashed border-gray-200 dark:border-white/10 flex items-center justify-center overflow-hidden transition-all group-hover/photo:border-emerald-500/50 shadow-inner">
                    {(addDialogOpen ? newProduct.imageUrl : editingProduct?.imageUrl) ? (
                      <img
                        src={addDialogOpen ? newProduct.imageUrl : editingProduct?.imageUrl}
                        className="h-full w-full object-cover"
                        alt="Preview"
                      />
                    ) : (
                      <Package size={40} className="text-gray-300 dark:text-zinc-700 group-hover/photo:text-emerald-500/50 transition-colors" />
                    )}
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/photo:opacity-100 transition-opacity flex items-center justify-center text-white text-[10px] font-black uppercase tracking-widest italic">
                      Cambiar Identidad
                    </div>
                  </div>
                  <div className="absolute -bottom-1 -right-1 bg-emerald-500 text-white p-2.5 rounded-xl shadow-lg border-4 border-white dark:border-zinc-950">
                    <Camera size={18} />
                  </div>
                  <input
                    type="file"
                    accept="image/*"
                    className="absolute inset-0 opacity-0 cursor-pointer"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const reader = new FileReader();
                        reader.onloadend = () => {
                          const base64String = reader.result as string;
                          if (addDialogOpen) setNewProduct((p: any) => ({ ...p, imageUrl: base64String }));
                          else setEditingProduct((p: any) => p ? { ...p, imageUrl: base64String } : null);
                        };
                        reader.readAsDataURL(file);
                      }
                    }}
                  />
                </div>
                <div className="text-center">
                  <p className="text-[11px] font-black text-gray-900 dark:text-white uppercase tracking-tighter italic">Fotografía del Artículo</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                <div className="space-y-3">
                  <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic ml-1 flex items-center gap-1"><Barcode size={12} className="text-emerald-500" /> Identificador de Barras</label>
                  <div className="relative">
                    <Input
                      aria-label="Identificador de barras"
                      autoFocus
                      value={addDialogOpen ? newProduct.barcode : (editingProduct?.barcode || '')}
                      onValueChange={(v) => {
                        if (addDialogOpen) setNewProduct((p: any) => ({ ...p, barcode: v.toUpperCase() }));
                        else setEditingProduct((p: any) => p ? { ...p, barcode: v.toUpperCase() } : null);
                      }}
                      classNames={{
                        inputWrapper: "h-16 bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-2xl focus-within:!border-emerald-500 shadow-inner transition-all pr-28",
                        input: "font-black text-base uppercase italic text-gray-900 dark:text-white"
                      }}
                    />
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1.5 items-center">
                      <Button
                        isIconOnly
                        variant="light"
                        onPress={handleAIFill}
                        isLoading={isFetchingInfo}
                        className="h-12 w-12 text-emerald-500 rounded-xl hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-all font-black"
                      >
                        <Sparkles size={18} />
                      </Button>
                      <Button
                        isIconOnly
                        onPress={onScan}
                        className="h-12 w-12 bg-emerald-500 text-white rounded-xl shadow-lg ring-4 ring-emerald-500/10"
                      >
                        <Camera size={18} />
                      </Button>
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic ml-1">Denominación del Artículo</label>
                  <Input
                    aria-label="Nombre del Artículo"
                    value={addDialogOpen ? newProduct.productName : (editingProduct?.productName || '')}
                    onValueChange={(v) => {
                      if (addDialogOpen) setNewProduct((p: any) => ({ ...p, productName: v.toUpperCase() }));
                      else setEditingProduct((p: any) => p ? { ...p, productName: v.toUpperCase() } : null);
                    }}
                    classNames={{
                      inputWrapper: "h-16 bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-2xl focus-within:!border-emerald-500 shadow-inner transition-all",
                      input: "font-black text-base uppercase italic text-gray-900 dark:text-white"
                    }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-10">
                <div className="space-y-3">
                  <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic ml-1">COSTO NETO</label>
                  <Input
                    aria-label="Costo Neto"
                    type="number"
                    variant="flat"
                    startContent={<span className="text-gray-400 font-black text-sm mr-1">$</span>}
                    value={String(addDialogOpen ? newProduct.purchasePrice : (editingProduct?.purchasePrice || 0))}
                    onValueChange={(v) => {
                      const val = parseFloat(v) || 0;
                      if (addDialogOpen) {
                        setNewProduct((p: any) => ({ ...p, purchasePrice: val, salePrice: applyRounding(val * (1 + newMargin / 100)) }));
                      } else {
                        setEditingProduct((p: any) => p ? { ...p, purchasePrice: val, salePrice: applyRounding(val * (1 + editMargin / 100)) } : null);
                      }
                    }}
                    classNames={{
                      inputWrapper: "h-16 bg-gray-50 dark:bg-white/5 border-b-2 border-gray-200 dark:border-white/10 rounded-none shadow-none focus-within:border-emerald-500",
                      input: "font-black text-xl tabular-nums italic text-gray-900 dark:text-white"
                    }}
                  />
                </div>

                <div className="space-y-3">
                  <label className="text-[10px] font-black text-sky-500 uppercase tracking-widest italic ml-1">MARGEN %</label>
                  <Input
                    aria-label="Margen de ganancia"
                    type="number"
                    variant="flat"
                    endContent={<span className="text-sky-500 font-black text-sm ml-1">%</span>}
                    value={String(addDialogOpen ? newMargin : editMargin)}
                    onValueChange={(v) => {
                      const val = parseFloat(v) || 0;
                      if (addDialogOpen) {
                        setNewMargin(val);
                        setNewProduct((p: any) => ({ ...p, marginPercentage: val, salePrice: applyRounding(p.purchasePrice * (1 + val / 100)) }));
                      } else {
                        setEditMargin(val);
                        setEditingProduct((p: any) => p ? { ...p, marginPercentage: val, salePrice: applyRounding(p.purchasePrice * (1 + val / 100)) } : null);
                      }
                    }}
                    classNames={{
                      inputWrapper: "h-16 bg-sky-50 dark:bg-sky-500/5 border-b-2 border-sky-500/50 rounded-none shadow-none",
                      input: "font-black text-xl tabular-nums text-sky-600 dark:text-sky-400 italic text-center"
                    }}
                  />
                </div>

                <div className="space-y-3 col-span-2 md:col-span-1">
                  <label className="text-[10px] font-black text-emerald-500 uppercase tracking-widest italic ml-1">PVP FINAL</label>
                  <Input
                    aria-label="Precio de Venta al Público"
                    type="number"
                    variant="flat"
                    startContent={<span className="text-emerald-500 font-black text-base mr-1">$</span>}
                    value={String(addDialogOpen ? newProduct.salePrice : (editingProduct?.salePrice || 0))}
                    onValueChange={(v) => {
                      const val = applyRounding(parseFloat(v) || 0);
                      if (addDialogOpen) {
                        const cost = newProduct.purchasePrice || 0;
                        const margin = cost > 0 ? ((val - cost) / cost) * 100 : 0;
                        setNewMargin(parseFloat(margin.toFixed(2)));
                        setNewProduct((p: any) => ({ ...p, salePrice: val, marginPercentage: margin }));
                      } else {
                        const cost = editingProduct?.purchasePrice || 0;
                        const margin = cost > 0 ? ((val - cost) / cost) * 100 : 0;
                        setEditMargin(parseFloat(margin.toFixed(2)));
                        setEditingProduct((p: any) => p ? { ...p, salePrice: val, marginPercentage: margin } : null);
                      }
                    }}
                    classNames={{
                      inputWrapper: "h-16 bg-emerald-500/5 border-b-2 border-emerald-500/50 rounded-2xl shadow-none",
                      input: "font-black text-3xl tabular-nums text-emerald-600 dark:text-emerald-400 italic"
                    }}
                  />
                </div>
              </div>

              {/* LIVE UTILITY CALCULATOR */}
              <div className="bg-emerald-500/10 border border-emerald-500/20 p-6 rounded-[2rem] flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-[10px] font-black text-emerald-500 uppercase tracking-widest italic">Ganancia Estimada</span>
                  <span className="text-2xl font-black text-emerald-600 dark:text-emerald-400 tabular-nums italic leading-none mt-1">
                    +${formatCOP((addDialogOpen ? newProduct.salePrice - newProduct.purchasePrice : (editingProduct?.salePrice || 0) - (editingProduct?.purchasePrice || 0)))}
                  </span>
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest italic">Retorno de Inversión</span>
                  <div className="flex items-center gap-2 mt-1">
                    <TrendingUp className="text-emerald-500" size={16} />
                    <span className="text-xl font-black text-gray-900 dark:text-white tabular-nums italic">
                      {(addDialogOpen ? newMargin : editMargin)}%
                    </span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                <div className="space-y-3">
                  <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic ml-1">Estructura Logística (Proveedor)</label>
                  <Select
                    aria-label="Seleccionar Proveedor"
                    placeholder="VINCULAR PROVEEDOR..."
                    selectedKeys={[(addDialogOpen ? String(newProduct.supplierId || '') : String(editingProduct?.supplierId || ''))]}
                    onSelectionChange={(keys) => {
                      const val = Array.from(keys)[0] as string;
                      if (addDialogOpen) setNewProduct((p: any) => ({ ...p, supplierId: val }));
                      else setEditingProduct((p: any) => p ? { ...p, supplierId: val } : null);
                    }}
                    classNames={{
                      trigger: "h-16 bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-2xl shadow-inner",
                      value: "font-black text-xs uppercase italic text-gray-900 dark:text-white"
                    }}
                  >
                    {suppliers.map((s) => (
                      <SelectItem key={s.id} className="text-[10px] font-black uppercase italic">{s.name}</SelectItem>
                    ))}
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                <div className="space-y-3">
                  <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic ml-1">CONTROL DE EXISTENCIAS (STOCK / MÍNIMO)</label>
                  <div className="flex gap-4">
                    <Input
                      aria-label="Existencia actual"
                      isDisabled={addDialogOpen ? newProduct.isWeighted : (editingProduct?.isWeighted || false)}
                      type={(addDialogOpen ? newProduct.isWeighted : editingProduct?.isWeighted) ? "text" : "number"}
                      variant="flat"
                      value={(addDialogOpen ? newProduct.isWeighted : editingProduct?.isWeighted) ? "∞" : String(addDialogOpen ? newProduct.quantity : (editingProduct?.quantity || 0))}
                      onValueChange={(v) => {
                        const val = parseFloat(v) || 0;
                        if (addDialogOpen) setNewProduct((p: any) => ({ ...p, quantity: val }));
                        else setEditingProduct((p: any) => p ? { ...p, quantity: val } : null);
                      }}
                      classNames={{
                        inputWrapper: "h-16 bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-2xl shadow-none focus-within:!border-emerald-500 transition-all",
                        input: "font-black text-base tabular-nums text-center text-gray-900 dark:text-white"
                      }}
                      placeholder="STOCK"
                    />
                    <Input
                      aria-label="Stock mínimo"
                      type="number"
                      variant="flat"
                      value={String(addDialogOpen ? (newProduct.minStock || 0) : (editingProduct?.minStock || 0))}
                      onValueChange={(v) => {
                        const val = parseFloat(v) || 0;
                        if (addDialogOpen) setNewProduct((p: any) => ({ ...p, minStock: val }));
                        else setEditingProduct((p: any) => p ? { ...p, minStock: val } : null);
                      }}
                      classNames={{
                        inputWrapper: "h-16 bg-rose-50 dark:bg-rose-500/5 border border-rose-500/30 rounded-2xl shadow-none focus-within:!border-rose-500 transition-all",
                        input: "font-black text-base tabular-nums text-center text-rose-600 dark:text-rose-400"
                      }}
                      placeholder="ALERTA"
                    />
                  </div>
                </div>

                <div className="space-y-3">
                  <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic ml-1">CATEGORÍA E IMAGEN</label>
                  <div className="grid grid-cols-2 gap-4">
                    <Select
                      aria-label="Categoría del producto"
                      selectedKeys={addDialogOpen ? (newProduct.categoryId ? [String(newProduct.categoryId)] : []) : (editingProduct?.categoryId ? [String(editingProduct.categoryId)] : [])}
                      onSelectionChange={(keys) => {
                        const v = Array.from(keys)[0] as string;
                        if (addDialogOpen) setNewProduct((p: any) => ({ ...p, categoryId: v }));
                        else setEditingProduct((p: any) => p ? { ...p, categoryId: v } : null);
                      }}
                      classNames={{
                        trigger: "h-16 bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-2xl shadow-none focus-within:!border-emerald-500",
                        value: "font-black text-xs uppercase italic text-gray-900 dark:text-white",
                        popoverContent: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-2xl rounded-2xl"
                      }}
                    >
                      {categories.map(c => <SelectItem key={String(c.id)} textValue={c.name.toUpperCase()}>{c.name.toUpperCase()}</SelectItem>)}
                    </Select>
                    <div className="flex items-center gap-3 bg-gray-50/50 dark:bg-emerald-500/5 px-4 rounded-2xl border border-gray-200 dark:border-white/10 shadow-none h-16">
                      <Checkbox
                        size="lg"
                        isSelected={addDialogOpen ? newProduct.isWeighted : (editingProduct?.isWeighted || false)}
                        onValueChange={(v) => {
                          const qty = v ? 999999 : 0;
                          if (addDialogOpen) setNewProduct((p: any) => ({ ...p, isWeighted: v, quantity: qty }));
                          else setEditingProduct((p: any) => p ? { ...p, isWeighted: v, quantity: qty } : null);
                        }}
                        color="success"
                      />
                      <div className="flex flex-col">
                        <span className="text-[10px] font-black text-gray-900 dark:text-white uppercase leading-none italic">PESAJE</span>
                        <span className="text-[7px] font-bold text-gray-400 dark:text-zinc-500 uppercase mt-1 tracking-widest">BALANZA</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </ModalBody>

            <ModalFooter className="p-10 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-b-[2.5rem]">
              <Button
                className="w-full h-20 bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase text-sm tracking-[0.2em] rounded-3xl transition-all shadow-xl hover:scale-[1.02] active:scale-95 italic ring-4 ring-black/5 dark:ring-white/5"
                onPress={onConfirm}
              >
                <Sparkles size={24} className="mr-3" />
                {addDialogOpen ? "SINCRONIZAR PRODUCTO" : "ACTUALIZAR REGISTRO MAESTRO"}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}