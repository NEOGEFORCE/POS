"use client";

import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, Input, Select, SelectItem, Switch, Autocomplete, AutocompleteItem
} from "@heroui/react";
import { Package, Barcode, Camera, Box, Info, Truck, Check } from 'lucide-react';
import { Product, Category } from '@/lib/definitions';
import { applyRounding, formatCurrency, parseCurrency } from '@/lib/utils';
import { validateProduct, FieldError } from '@/lib/formValidation';
import ValidationErrors from '@/components/ValidationErrors';
import { useState, useCallback, useMemo, memo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { PlusCircle } from 'lucide-react';
import SupplierFormModal from '../../suppliers/components/SupplierFormModal';
import { apiFetch } from '@/lib/api-error';
import Cookies from 'js-cookie';
import { useToast } from '@/hooks/use-toast';
import { ProductSupplierPrice } from '@/lib/definitions';

// Formateador de moneda local
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
  allProducts: Product[];
  mutateSuppliers?: () => void;
  apiFieldErrors?: Record<string, string>;
}

const ProductFormModal = memo(function ProductFormModal({
  isOpen, onOpenChange, addDialogOpen,
  newProduct, setNewProduct,
  editingProduct, setEditingProduct,
  newMargin, setNewMargin,
  editMargin, setEditMargin,
  categories, suppliers, onConfirm, onScan, allProducts, mutateSuppliers,
  apiFieldErrors = {}
}: ProductFormModalProps) {
  const { toast } = useToast();
  // Estado de errores de validación
  const [validationErrors, setValidationErrors] = useState<FieldError[]>([]);
  const [quickSupplierOpen, setQuickSupplierOpen] = useState(false);
  const [supplierPrices, setSupplierPrices] = useState<ProductSupplierPrice[]>([]);
  const [isLoadingPrices, setIsLoadingPrices] = useState(false);
  
  // Estado para búsqueda de producto base en modo pack
  const [searchTerm, setSearchTerm] = useState("");

  // Combinar errores de validación local y errores de API
  const getFieldError = useCallback((fieldName: string): string | undefined => {
    // Buscar en errores de API primero (más prioritarios)
    if (apiFieldErrors[fieldName]) {
      return apiFieldErrors[fieldName];
    }
    // Buscar en errores de validación local
    const localError = validationErrors.find(e => 
      e.field?.toLowerCase().includes(fieldName.toLowerCase()) ||
      e.message?.toLowerCase().includes(fieldName.toLowerCase())
    );
    return localError?.message;
  }, [apiFieldErrors, validationErrors]);

  // Verificar si un campo tiene error
  const hasFieldError = useCallback((fieldName: string): boolean => {
    return !!getFieldError(fieldName);
  }, [getFieldError]);

  // Memoizar valores derivados para evitar recálculos
  const isPack = useMemo(() => 
    addDialogOpen ? (newProduct as any).isPack : (editingProduct as any)?.isPack, 
    [addDialogOpen, newProduct, editingProduct]
  );

  // Productos base excluyendo packs
  const baseProducts = useMemo(() => 
    (allProducts || []).filter(p => !p.isPack), 
    [allProducts]
  );
  
  // Filtro real para el buscador de producto base
  const filteredBaseProducts = useMemo(() => {
    if (!searchTerm) return baseProducts;
    const term = searchTerm.toLowerCase();
    return baseProducts.filter(p => 
      p.productName.toLowerCase().includes(term) || 
      p.barcode.toLowerCase().includes(term)
    );
  }, [baseProducts, searchTerm]);

  // Fix aria-hidden: forzar blur del elemento activo cuando se cierra el popover
  const handlePopoverClose = useCallback(() => {
    const active = document.activeElement as HTMLElement;
    if (active && active.blur) active.blur();
  }, []);

  // Callbacks estables para Select de Proveedor (Múltiple)
  const handleSupplierChange = useCallback((keys: any) => {
    const selectedIds = Array.from(keys) as string[];
    const suppliersPayload = selectedIds.map(id => ({ id: parseInt(id) }));
    const primaryId = selectedIds.length > 0 ? parseInt(selectedIds[0]) : 0;

    if (addDialogOpen) {
      setNewProduct((p: any) => ({ 
        ...p, 
        supplierId: primaryId,
        suppliers: suppliersPayload 
      }));
    } else {
      setEditingProduct((p: any) => p ? { 
        ...p, 
        supplierId: primaryId,
        suppliers: suppliersPayload 
      } : null);
    }
  }, [addDialogOpen, setNewProduct, setEditingProduct]);

  // Callbacks estables para Select de Categoría
  const handleCategoryChange = useCallback((keys: any) => {
    const v = Array.from(keys)[0] as string;
    const numVal = v ? parseInt(v) || 0 : 0;
    if (addDialogOpen) setNewProduct((p: any) => ({ ...p, categoryId: numVal }));
    else setEditingProduct((p: any) => p ? { ...p, categoryId: numVal } : null);
  }, [addDialogOpen, setNewProduct, setEditingProduct]);

  // Callback estable para Autocomplete de Producto Base
  const handleBaseProductChange = useCallback((key: any) => {
    const barcode = key as string;
    // Buscar el producto base para calcular el costo automáticamente
    const baseProduct = allProducts.find((p: Product) => p.barcode === barcode);
    
    if (addDialogOpen) {
      setNewProduct((p: any) => {
        const multiplier = p.packMultiplier || 1;
        const calculatedCost = baseProduct ? Math.round(baseProduct.purchasePrice * multiplier) : p.purchasePrice;
        return { 
          ...p, 
          baseProductBarcode: barcode,
          // Autocalcular costo si tenemos producto base y multiplicador
          purchasePrice: baseProduct ? calculatedCost : p.purchasePrice
        };
      });
    } else {
      setEditingProduct((p: any) => {
        if (!p) return null;
        const multiplier = p.packMultiplier || 1;
        const calculatedCost = baseProduct ? Math.round(baseProduct.purchasePrice * multiplier) : p.purchasePrice;
        return { 
          ...p, 
          baseProductBarcode: barcode,
          // Autocalcular costo si tenemos producto base y multiplicador
          purchasePrice: baseProduct ? calculatedCost : p.purchasePrice
        };
      });
    }
  }, [addDialogOpen, setNewProduct, setEditingProduct, allProducts]);

  const handlePackMultiplierChange = useCallback((v: string) => {
    const val = v === '' ? undefined : Math.max(1, parseInt(v) || 1);
    
    if (addDialogOpen) {
      setNewProduct((p: any) => {
        // Buscar el producto base para recalcular el costo
        const baseProduct = p.baseProductBarcode ? allProducts.find((prod: Product) => prod.barcode === p.baseProductBarcode) : null;
        const calculatedCost = baseProduct ? Math.round(baseProduct.purchasePrice * (val || 1)) : p.purchasePrice;
        
        return { 
          ...p, 
          packMultiplier: val,
          // Recalcular costo si tenemos producto base
          purchasePrice: baseProduct ? calculatedCost : p.purchasePrice
        };
      });
    } else {
      setEditingProduct((p: any) => {
        if (!p) return null;
        // Buscar el producto base para recalcular el costo
        const baseProduct = p.baseProductBarcode ? allProducts.find((prod: Product) => prod.barcode === p.baseProductBarcode) : null;
        const calculatedCost = baseProduct ? Math.round(baseProduct.purchasePrice * (val || 1)) : p.purchasePrice;
        
        return { 
          ...p, 
          packMultiplier: val,
          // Recalcular costo si tenemos producto base
          purchasePrice: baseProduct ? calculatedCost : p.purchasePrice
        };
      });
    }
  }, [addDialogOpen, setNewProduct, setEditingProduct, allProducts]);

  // Fetch price comparison data
  const fetchSupplierPrices = useCallback(async (barcode: string) => {
    if (!barcode) return;
    setIsLoadingPrices(true);
    try {
      // Usar el token del cookie para la auth
      const token = Cookies.get('org-pos-token');
      const data = await apiFetch<ProductSupplierPrice[]>(`/products/compare-prices/${barcode}`, {
        fallbackError: 'Error al obtener histórica de precios'
      }, token!);
      setSupplierPrices(data);
    } catch (error) {
      console.error(error);
    } finally {
      setIsLoadingPrices(false);
    }
  }, []);

  useEffect(() => {
    if (editingProduct?.barcode) {
      fetchSupplierPrices(editingProduct.barcode);
    } else {
      setSupplierPrices([]);
    }
  }, [editingProduct, fetchSupplierPrices]);

  // Handler para guardar un proveedor rápido sin salir del flujo de productos
  const handleQuickSupplierSave = async (supplier: any) => {
    const token = Cookies.get('org-pos-token');
    try {
      const created = await apiFetch<any>('/suppliers/create-suppliers', {
        method: 'POST',
        body: JSON.stringify(supplier),
      }, token!);
      
      toast({ variant: 'success', title: 'ÉXITO', description: 'PROVEEDOR CREADO' });
      
      // Actualizar la lista de proveedores del padre
      if (mutateSuppliers) mutateSuppliers();
      
      // Auto-seleccionar el nuevo proveedor
      const newSupObj = { id: created.id };
      if (addDialogOpen) {
        setNewProduct((p: any) => ({
          ...p,
          supplierId: created.id,
          suppliers: [...(p.suppliers || []), newSupObj]
        }));
      } else {
        setEditingProduct((p: any) => p ? {
          ...p,
          supplierId: created.id,
          suppliers: [...(p.suppliers || []), newSupObj]
        } : null);
      }
      setQuickSupplierOpen(false);
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'ERROR', description: err.message });
    }
  };


  // CLASES COMPARTIDAS PARA INPUTS (Optimizado para móvil)
  const itemInputClass = {
    label: "text-xs font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic text-center w-full mb-0.5",
    inputWrapper: "h-9 bg-gray-50 dark:bg-black/20 border border-gray-100 dark:border-white/5 rounded-lg group-data-[focus=true]:border-emerald-500 transition-all shadow-sm py-1.5",
    input: "font-black text-sm uppercase italic text-gray-900 dark:text-white text-left py-0"
  };

  // ESTILO DE SWITCH MINIMALISTA
  const minimalistSwitchClass = {
    base: "inline-flex flex-row-reverse w-full max-w-fit items-center justify-between cursor-pointer rounded-full gap-2",
    wrapper: "p-0 h-6 w-10 overflow-visible bg-gray-200 dark:bg-zinc-800 group-data-[selected=true]:bg-emerald-500 transition-colors duration-500 shadow-inner",
    thumb: "w-4 h-4 shadow-lg border-2 border-transparent transition-all duration-300 group-data-[selected=true]:ml-4 bg-white",
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      placement="center"
      scrollBehavior="inside"
      backdrop="blur"
      size="lg"
      classNames={{
        base: "bg-white dark:bg-zinc-950 rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-2xl overflow-visible mx-2 md:mx-0 translate-y-2 md:translate-y-4",
        wrapper: "items-center justify-center p-8 md:p-12",
        closeButton: "absolute right-5 top-5 text-gray-400 dark:text-zinc-500 hover:text-rose-500 transition-colors z-[100] rounded-full",
        backdrop: "bg-black/60 backdrop-blur-md"
      }}
    >
      <ModalContent>
        {() => (
          <>
            <ModalHeader className="px-6 md:px-10 py-3 md:py-4 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 backdrop-blur-md rounded-t-[2.5rem]">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 bg-emerald-500/10 text-emerald-500 flex items-center justify-center rounded-xl border border-emerald-500/20 rotate-3">
                  <Package size={18} />
                </div>
                <div className="flex flex-col">
                  <h2 className="text-base md:text-lg font-black text-gray-900 dark:text-white italic tracking-tighter uppercase leading-none">
                    {addDialogOpen ? "Protocolo " : "Modificar "} <span className="text-emerald-500">Producto</span>
                  </h2>
                  <p className="text-[7px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.2em] mt-0.5 italic opacity-80">Edición Compacta v5.2</p>
                </div>
              </div>
            </ModalHeader>

            <ModalBody className="px-6 md:px-10 py-3 md:py-4 gap-3 custom-scrollbar overflow-x-hidden">
              {/* 1. SECCIÓN IDENTIDAD (Compacta) */}
              <div className="flex flex-col sm:flex-row items-center sm:items-stretch gap-4">
                <div className="relative group/photo shrink-0">
                  <div className="h-20 w-20 rounded-2xl bg-gray-50 dark:bg-black/40 border-2 border-dashed border-gray-200 dark:border-white/10 flex items-center justify-center overflow-hidden transition-all group-hover/photo:border-emerald-500 shadow-inner group-hover/photo:scale-[1.02] duration-300">
                    {(addDialogOpen ? newProduct.imageUrl : editingProduct?.imageUrl) ? (
                      <img
                        src={(addDialogOpen ? newProduct.imageUrl : editingProduct?.imageUrl) || ''}
                        className="h-full w-full object-cover"
                        alt="Preview"
                      />
                    ) : (
                      <div className="flex flex-col items-center gap-1 opacity-20">
                        <Package size={20} />
                      </div>
                    )}
                  </div>
                  <div className="absolute -bottom-1 -right-1 bg-emerald-500 text-white p-1.5 rounded-lg shadow-xl border-2 border-white dark:border-zinc-950 cursor-pointer active:scale-90 transition-all hover:bg-emerald-600">
                    <Camera size={10} />
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
                </div>

                <div className="flex-1 w-full grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="flex flex-col justify-center gap-0.5">
                    <label className={`${itemInputClass.label} flex items-center gap-1`}><Barcode size={10} className="text-emerald-500" /> CÓDIGO</label>
                    <div className="relative">
                      <Input
                        value={addDialogOpen ? newProduct.barcode : (editingProduct?.barcode || '')}
                        onValueChange={(v) => {
                          if (addDialogOpen) setNewProduct((p: any) => ({ ...p, barcode: v.toUpperCase() }));
                          else setEditingProduct((p: any) => p ? { ...p, barcode: v.toUpperCase() } : null);
                        }}
                        classNames={{ ...itemInputClass, inputWrapper: `${itemInputClass.inputWrapper} pr-14` }}
                      />
                      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1 transform scale-90">
                        <Button isIconOnly size="sm" onPress={onScan} className="h-7 w-7 bg-emerald-500/10 text-emerald-500 rounded-lg">
                          <Camera size={12} />
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col justify-center gap-0.5">
                    <label className={itemInputClass.label}>NOMBRE PRODUCTO</label>
                    <Input
                      value={addDialogOpen ? newProduct.productName : (editingProduct?.productName || '')}
                      onValueChange={(v) => {
                        if (addDialogOpen) setNewProduct((p: any) => ({ ...p, productName: v.toUpperCase() }));
                        else setEditingProduct((p: any) => p ? { ...p, productName: v.toUpperCase() } : null);
                      }}
                      classNames={itemInputClass}
                    />
                  </div>
                </div>
              </div>

              {/* 2. VALORIZACIÓN (Inline compacto) */}
              <div className="grid grid-cols-3 gap-2 bg-gray-50/50 dark:bg-black/20 p-2 rounded-xl border border-gray-100/50 dark:border-white/5">
                <div className="flex flex-col gap-0.5">
                  <label className={`${itemInputClass.label} ${hasFieldError('purchasePrice') ? 'text-rose-500' : ''}`}>COSTO</label>
                  <Input
                    variant="flat"
                    startContent={<span className={`font-black text-[10px] ${hasFieldError('purchasePrice') ? 'text-rose-500' : 'text-emerald-500'}`}>$</span>}
                    value={(() => {
                      const price = addDialogOpen ? newProduct.purchasePrice : editingProduct?.purchasePrice;
                      return price ? formatCurrency(price) : '';
                    })()}
                    onValueChange={(v) => {
                      const val = parseCurrency(v);
                      if (addDialogOpen) {
                        setNewProduct((p: any) => ({ ...p, purchasePrice: val, salePrice: applyRounding(val * (1 + newMargin / 100)) }));
                      } else {
                        setEditingProduct((p: any) => p ? { ...p, purchasePrice: val, salePrice: applyRounding(val * (1 + editMargin / 100)) } : null);
                      }
                    }}
                    classNames={{ 
                      ...itemInputClass, 
                      inputWrapper: `${itemInputClass.inputWrapper} ${hasFieldError('purchasePrice') ? 'border-rose-500 bg-rose-500/5' : ''}`,
                      input: `${itemInputClass.input} tabular-nums ${hasFieldError('purchasePrice') ? 'text-rose-500' : ''}` 
                    }}
                  />
                  {getFieldError('purchasePrice') && (
                    <span className="text-[9px] font-black text-rose-500 italic">{getFieldError('purchasePrice')}</span>
                  )}
                </div>
                <div className="flex flex-col gap-0.5">
                  <label className="text-xs font-black text-sky-500 uppercase tracking-widest italic text-center w-full mb-0.5">MARGEN %</label>
                  <Input
                    type="number"
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
                      inputWrapper: "h-9 bg-sky-500/5 border border-sky-500/10 rounded-lg py-1.5",
                      input: "font-black text-sm tabular-nums text-sky-500 italic text-left py-0"
                    }}
                  />
                </div>
                <div className="flex flex-col gap-0.5 relative">
                  <label className={`text-xs font-black uppercase tracking-widest italic text-center w-full mb-0.5 ${hasFieldError('salePrice') ? 'text-rose-500' : 'text-emerald-500'}`}>PVP FINAL</label>
                  <Input
                    startContent={<span className={`font-black text-xs ${hasFieldError('salePrice') ? 'text-rose-500' : 'text-emerald-500'}`}>$</span>}
                    value={String(addDialogOpen ? (newProduct.salePrice || '') : (editingProduct?.salePrice || ''))}
                    onValueChange={(v) => {
                      const newPVP = parseFloat(v) || 0;
                      const currentMargin = addDialogOpen ? newMargin : editMargin;
                      
                      // 1. Actualiza el estado del PVP para que el usuario pueda teclear
                      if (addDialogOpen) {
                        setNewProduct((p: any) => ({ ...p, salePrice: newPVP }));
                      } else {
                        setEditingProduct((p: any) => p ? { ...p, salePrice: newPVP } : null);
                      }
                      
                      // 2. Cálculo Inverso Automático hacia el Costo
                      if (currentMargin > 0) {
                        const newCost = Math.round(newPVP / (1 + (currentMargin / 100)));
                        if (addDialogOpen) {
                          setNewProduct((p: any) => ({ ...p, purchasePrice: newCost }));
                        } else {
                          setEditingProduct((p: any) => p ? { ...p, purchasePrice: newCost } : null);
                        }
                      }
                    }}
                    classNames={{
                      inputWrapper: `h-9 border rounded-lg shadow-sm py-1.5 ${hasFieldError('salePrice') ? 'bg-rose-500/5 border-rose-500' : 'bg-emerald-500/10 border-emerald-500/20'}`,
                      input: `font-black text-sm tabular-nums italic text-left py-0 ${hasFieldError('salePrice') ? 'text-rose-500' : 'text-emerald-500'}`
                    }}
                  />
                  {!hasFieldError('salePrice') && (
                    <div className="absolute -right-1 -top-1 bg-emerald-500 text-white text-[6px] font-black px-1.5 py-0.5 rounded-full shadow-lg z-10">
                      +{formatCOP((addDialogOpen ? (newProduct.salePrice || 0) - (newProduct.purchasePrice || 0) : (editingProduct?.salePrice || 0) - (editingProduct?.purchasePrice || 0)))}
                    </div>
                  )}
                  {getFieldError('salePrice') && (
                    <span className="text-[9px] font-black text-rose-500 italic">{getFieldError('salePrice')}</span>
                  )}
                </div>
              </div>

              {/* 3. LOGÍSTICA & STOCK (Refinado a 2x2 corto) */}
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <div className="h-[1px] flex-1 bg-gradient-to-r from-transparent via-gray-200 dark:via-white/10 to-transparent"></div>
                  <span className="text-[7px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.4em] italic whitespace-nowrap">Logística e Inventario</span>
                  <div className="h-[1px] flex-1 bg-gradient-to-r from-transparent via-gray-200 dark:via-white/10 to-transparent"></div>
                </div>

                <div className="grid grid-cols-2 gap-3 bg-gray-50/20 dark:bg-black/10 p-3 rounded-2xl border border-gray-100/50 dark:border-white/5">
                  <div className="flex flex-col gap-0.5">
                    <label className={itemInputClass.label}>PROVEEDOR</label>
                    <div className="flex gap-1.5 items-end">
                      <div className="flex-1">
                        <Select
                          aria-label="Seleccionar proveedores"
                          selectionMode="multiple"
                          selectedKeys={(() => {
                            const product = addDialogOpen ? newProduct : editingProduct;
                            const suppliersList = product?.suppliers || [];
                            if (suppliersList.length > 0) {
                              return suppliersList.map((s: any) => String(s.id));
                            }
                            return product?.supplierId ? [String(product.supplierId)] : [];
                          })()}
                          onSelectionChange={handleSupplierChange}
                          placeholder="SELECCIONAR..."
                          startContent={<Truck size={14} className="text-emerald-500 mr-1" />}
                          selectorIcon={<span />}
                          classNames={{
                            trigger: "h-11 bg-gray-50/80 dark:bg-black/40 border border-gray-200/50 dark:border-white/10 rounded-xl",
                            value: "font-black text-[10px] uppercase italic text-left",
                          }}
                          renderValue={(items) => {
                            const visible = items.slice(0, 2);
                            const remaining = items.length - 2;
                            return (
                              <div className="flex items-center gap-1 overflow-hidden">
                                {visible.map((item) => (
                                  <span key={item.key} className="bg-emerald-500/10 text-emerald-500 text-[8px] font-black px-1.5 py-0.5 rounded-md border border-emerald-500/20 uppercase italic truncate max-w-[80px]">
                                    {item.textValue}
                                  </span>
                                ))}
                                {remaining > 0 && (
                                  <span className="text-emerald-500 text-[8px] font-black">+{remaining}</span>
                                )}
                              </div>
                            );
                          }}
                          popoverProps={{
                            className: "z-[9999] bg-white dark:bg-zinc-950 border border-gray-100 dark:border-white/10 shadow-2xl rounded-xl",
                            onClose: handlePopoverClose
                          }}
                        >
                          {(suppliers || []).map(s => (
                            <SelectItem key={String(s.id)} textValue={s.name}>
                              <span className="text-[10px] font-black uppercase italic">{s.name}</span>
                            </SelectItem>
                          ))}
                        </Select>
                      </div>
                      <Button
                        isIconOnly
                        variant="flat"
                        className="h-8 w-8 min-w-0 bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 rounded-lg active:scale-95"
                        onPress={() => setQuickSupplierOpen(true)}
                      >
                        <PlusCircle size={14} />
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <label className={itemInputClass.label}>CATEGORÍA</label>
                    <div className="flex gap-1.5 items-end">
                      <div className="flex-1">
                        <Select
                          aria-label="Seleccionar categoría"
                          selectedKeys={addDialogOpen
                            ? (newProduct.categoryId ? [String(newProduct.categoryId)] : [])
                            : (editingProduct?.categoryId ? [String(editingProduct.categoryId)] : [])
                          }
                          onSelectionChange={handleCategoryChange}
                          placeholder="SELECCIONAR..."
                          startContent={<Package size={14} className="text-emerald-500 mr-1" />}
                          selectorIcon={<span />}
                          classNames={{
                            trigger: "h-11 bg-gray-50/80 dark:bg-black/40 border border-gray-200/50 dark:border-white/10 rounded-xl",
                            value: "font-black text-[10px] uppercase italic text-left",
                          }}
                          popoverProps={{
                            className: "z-[9999] bg-white dark:bg-zinc-950 border border-gray-100 dark:border-white/10 shadow-2xl rounded-xl",
                            onClose: handlePopoverClose
                          }}
                        >
                          {(categories || []).map(c => (
                            <SelectItem key={String(c.id)} textValue={c.name}>
                              <span className="text-[10px] font-black uppercase italic">{c.name}</span>
                            </SelectItem>
                          ))}
                        </Select>
                      </div>
                      <Button
                        isIconOnly
                        variant="flat"
                        className="h-8 w-8 min-w-0 bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 rounded-lg active:scale-95"
                        onPress={() => {}}
                      >
                        <PlusCircle size={14} />
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <label className={itemInputClass.label}>STOCK ACTUAL</label>
                    <Input
                      type={(addDialogOpen ? newProduct.isWeighted : editingProduct?.isWeighted) ? "text" : "number"}
                      isDisabled={addDialogOpen ? newProduct.isWeighted : (editingProduct?.isWeighted || false)}
                      value={(addDialogOpen ? newProduct.isWeighted : editingProduct?.isWeighted) ? "∞" : String(addDialogOpen ? (newProduct.quantity ?? '') : (editingProduct?.quantity ?? ''))}
                      onValueChange={(v) => {
                        const val = v === '' ? undefined : parseFloat(v);
                        if (addDialogOpen) setNewProduct((p: any) => ({ ...p, quantity: val }));
                        else setEditingProduct((p: any) => p ? { ...p, quantity: val } : null);
                      }}
                      classNames={{
                        ...itemInputClass,
                        inputWrapper: `${itemInputClass.inputWrapper}`,
                        input: `${itemInputClass.input} text-left ${(addDialogOpen ? newProduct.isWeighted : editingProduct?.isWeighted) ? 'text-emerald-500 text-lg' : ''}`
                      }}
                    />
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <label className={`text-xs font-black uppercase tracking-widest italic text-center w-full mb-0.5 ${hasFieldError('minStock') ? 'text-rose-600' : 'text-rose-500'}`}>STOCK MÍNIMO</label>
                    <Input
                      type="number"
                      value={String(addDialogOpen 
                        ? (newProduct.minStock ?? '') 
                        : (editingProduct?.minStock ?? '')
                      )}
                      onValueChange={(v) => {
                        const val = v === '' ? undefined : parseFloat(v);
                        if (addDialogOpen) setNewProduct((p: any) => ({ ...p, minStock: val }));
                        else setEditingProduct((p: any) => p ? { ...p, minStock: val } : null);
                      }}
                      classNames={{
                        ...itemInputClass,
                        inputWrapper: `rounded-lg ${hasFieldError('minStock') ? 'bg-rose-500/10 border-rose-500 border-2' : 'bg-rose-500/5 border border-rose-500/10'}`,
                        input: `font-black text-sm tabular-nums text-left ${hasFieldError('minStock') ? 'text-rose-600' : 'text-rose-500'}`
                      }}
                    />
                    {getFieldError('minStock') && (
                      <span className="text-xs font-black text-rose-500 italic">{getFieldError('minStock')}</span>
                    )}
                  </div>
                </div>

                {/* COMPARATIVA DE PRECIOS DETALLADA */}
                {supplierPrices.length > 0 && !addDialogOpen && (
                  <motion.div 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="flex flex-col gap-3 p-4 bg-emerald-500/5 dark:bg-emerald-500/[0.02] rounded-3xl border border-emerald-500/10 shadow-inner overflow-hidden mb-1"
                  >
                    <div className="flex items-center justify-between px-1">
                      <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                        <h4 className="text-[10px] font-black uppercase tracking-[0.2em] italic text-emerald-500/80">Comparativa de Costos</h4>
                      </div>
                      <span className="text-[8px] font-black text-gray-400 uppercase italic">Mejor precio resaltado</span>
                    </div>
                    
                    <div className="grid grid-cols-1 gap-2 max-h-[160px] overflow-y-auto pr-1 custom-scrollbar">
                      {supplierPrices
                        .sort((a, b) => a.purchasePrice - b.purchasePrice)
                        .map((price, idx) => {
                          const isCheapest = idx === 0;
                          return (
                            <motion.div 
                              initial={{ opacity: 0, x: -10 }}
                              animate={{ opacity: 1, x: 0 }}
                              transition={{ delay: idx * 0.05 }}
                              key={`${price.supplierId}-${idx}`}
                              className={`flex items-center justify-between p-3 rounded-2xl border transition-all duration-300 ${
                                isCheapest 
                                  ? "bg-white dark:bg-zinc-900 border-emerald-500/40 shadow-[0_4px_12px_rgba(16,185,129,0.08)]" 
                                  : "bg-white/50 dark:bg-black/20 border-gray-100 dark:border-white/5 opacity-80"
                              }`}
                            >
                              <div className="flex flex-col gap-0.5">
                                <span className={`text-[9px] font-black uppercase italic ${isCheapest ? "text-emerald-500" : "text-gray-500"}`}>
                                  {price.Supplier?.name || `Proveedor #${price.supplierId}`}
                                </span>
                                <div className="flex items-center gap-1.5">
                                  <Truck size={8} className="text-gray-400" />
                                  <span className="text-[7px] text-gray-400 font-bold uppercase tracking-widest">
                                    {new Date(price.updatedAt).toLocaleDateString()}
                                  </span>
                                </div>
                              </div>
                              <div className="flex flex-col items-end gap-1">
                                <div className="flex items-center gap-2">
                                  {isCheapest && idx < supplierPrices.length - 1 && (
                                    <span className="text-[8px] font-black text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-lg uppercase italic">
                                      -{formatCOP(supplierPrices[idx+1].purchasePrice - price.purchasePrice)} ahorro
                                    </span>
                                  )}
                                  <span className={`text-[12px] font-black italic tracking-tighter ${isCheapest ? "text-emerald-500 scale-110 origin-right transition-transform" : "text-gray-400"}`}>
                                    {formatCOP(price.purchasePrice)}
                                  </span>
                                </div>
                                {isCheapest && (
                                  <div className="flex items-center gap-1">
                                    <Check size={8} className="text-emerald-500" strokeWidth={4} />
                                    <span className="text-[7px] font-black text-emerald-500 uppercase italic leading-none">
                                      OPCIÓN RECOMENDADA
                                    </span>
                                  </div>
                                )}
                              </div>
                            </motion.div>
                          );
                        })}
                    </div>
                  </motion.div>
                )}

              </div>

              {/* 4. CONFIGURACIÓN ESPECIAL (Compacta) */}
              <div className="flex gap-2">
                <div className="flex-1 flex items-center justify-between px-3 h-10 bg-gray-50/50 dark:bg-black/20 rounded-xl border border-gray-100 dark:border-white/5">
                  <div className="flex items-center gap-2">
                    <div className={`h-6 w-6 rounded-lg flex items-center justify-center transition-all duration-500 ${(addDialogOpen ? newProduct.isWeighted : editingProduct?.isWeighted) ? 'bg-emerald-500 text-white shadow-lg' : 'bg-gray-100 dark:bg-zinc-800 text-gray-400'}`}>
                      <Info size={12} />
                    </div>
                    <span className="text-[8px] font-black text-gray-500 uppercase tracking-widest italic">Pesable</span>
                  </div>
                  <Switch
                    size="sm"
                    isSelected={addDialogOpen ? newProduct.isWeighted : (editingProduct?.isWeighted || false)}
                    onValueChange={(v) => {
                      const qty = v ? 999999 : 0;
                      if (addDialogOpen) setNewProduct((p: any) => ({ ...p, isWeighted: v, quantity: qty }));
                      else setEditingProduct((p: any) => p ? { ...p, isWeighted: v, quantity: qty } : null);
                    }}
                    classNames={minimalistSwitchClass}
                  />
                </div>

                <div className="flex-1 flex items-center justify-between px-3 h-10 bg-gray-50/50 dark:bg-black/20 rounded-xl border border-gray-100 dark:border-white/5">
                  <div className="flex items-center gap-2">
                    <div className={`h-6 w-6 rounded-lg flex items-center justify-center transition-all duration-500 ${isPack ? 'bg-emerald-500 text-white shadow-lg' : 'bg-gray-100 dark:bg-zinc-800 text-gray-400'}`}>
                      <Box size={12} />
                    </div>
                    <span className="text-[8px] font-black text-gray-500 uppercase tracking-widest italic">Modo Pack</span>
                  </div>
                  <Switch
                    size="sm"
                    isSelected={isPack}
                    onValueChange={(v) => {
                      if (addDialogOpen) setNewProduct((p: any) => ({ ...p, isPack: v, quantity: v ? 0 : p.quantity }));
                      else setEditingProduct((p: any) => p ? { ...p, isPack: v, quantity: v ? 0 : p.quantity } : null);
                    }}
                    classNames={minimalistSwitchClass}
                  />
                </div>
              </div>

              {/* 5. PACK DETAILS (Solo si activo, proporciones 75/25) */}
              <AnimatePresence>
                {isPack && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                  >
                    <div className="flex flex-row gap-2 p-2 bg-emerald-500/5 rounded-2xl border border-emerald-500/10">
                      {/* Producto Base: 75% del ancho */}
                      <div className="flex-1 flex flex-col gap-0.5 min-w-0">
                        <label className="text-xs font-black uppercase tracking-widest italic text-center w-full">PRODUCTO BASE</label>
                        <Autocomplete
                          aria-label="Seleccionar producto base para pack"
                          items={filteredBaseProducts}
                          selectedKey={(addDialogOpen ? newProduct.baseProductBarcode : editingProduct?.baseProductBarcode) || null}
                          placeholder="BUSCAR..."
                          startContent={<Package size={14} className="text-emerald-500 mr-1 flex-shrink-0" />}
                          onSelectionChange={handleBaseProductChange}
                          onInputChange={(value) => setSearchTerm(value)}
                          allowsCustomValue={false}
                          classNames={{
                            base: "w-full",
                          }}
                          popoverProps={{
                            className: "z-[9999] bg-white dark:bg-zinc-950 border border-gray-100 dark:border-white/10 shadow-2xl rounded-xl w-[300px]",
                            onClose: handlePopoverClose
                          }}
                          inputProps={{
                            classNames: {
                              inputWrapper: "h-9 bg-white dark:bg-zinc-900 border border-emerald-500/20 rounded-xl py-0",
                              input: "font-black text-sm uppercase italic text-left py-0"
                            }
                          }}
                        >
                          {(item) => (
                            <AutocompleteItem key={item.barcode} textValue={item.productName} className="py-1">
                              <div className="flex flex-col min-w-0">
                                <span className="text-sm font-black uppercase italic truncate block w-full">{item.productName}</span>
                                <span className="text-xs text-gray-400 font-bold uppercase">{item.barcode}</span>
                              </div>
                            </AutocompleteItem>
                          )}
                        </Autocomplete>
                      </div>

                      {/* Unidades: 25% del ancho - w-24 fijo */}
                      <div className="flex flex-col gap-0.5 w-24 flex-shrink-0">
                        <label className="text-xs font-black uppercase tracking-widest italic text-center w-full">UND/PAQ</label>
                        <Input
                          type="number"
                          size="sm"
                          value={String(addDialogOpen ? (newProduct.packMultiplier ?? '') : (editingProduct?.packMultiplier ?? ''))}
                          onValueChange={handlePackMultiplierChange}
                          classNames={{
                            inputWrapper: "h-9 bg-white dark:bg-zinc-900 border border-emerald-500/20 rounded-xl py-0",
                            input: "font-black text-sm tabular-nums text-emerald-500 italic text-left py-0"
                          }}
                        />
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </ModalBody>

            <ModalFooter className="px-6 md:px-10 py-3 md:py-4 border-t border-gray-100 dark:border-white/5 bg-gray-100/50 dark:bg-zinc-950/50 rounded-b-[2.5rem]">
              <div className="flex w-full gap-3">
                <Button
                  variant="flat"
                  className="flex-1 h-10 rounded-xl font-black uppercase text-[9px] bg-white dark:bg-zinc-900 text-gray-400 italic tracking-widest border border-gray-100 dark:border-white/5"
                  onPress={onOpenChange as any}
                >
                  descartar
                </Button>
                <Button
                  className="flex-[2] h-10 bg-emerald-500 text-white font-black uppercase tracking-widest rounded-xl shadow-lg shadow-emerald-500/20 hover:bg-emerald-600 transition-all active:scale-[0.98] italic text-[10px]"
                  onPress={() => {
                    const current = addDialogOpen ? newProduct : editingProduct;
                    const result = validateProduct({
                      barcode: current?.barcode,
                      productName: current?.productName,
                      purchasePrice: current?.purchasePrice,
                      salePrice: current?.salePrice,
                      quantity: current?.quantity,
                      minStock: current?.minStock,
                      marginPercentage: addDialogOpen ? newMargin : editMargin,
                      isWeighted: current?.isWeighted,
                      isPack: (current as any)?.isPack,
                      packMultiplier: (current as any)?.packMultiplier,
                      baseProductBarcode: (current as any)?.baseProductBarcode,
                      categoryId: current?.categoryId,
                    });
                    if (!result.isValid) {
                      setValidationErrors(result.errors);
                      return;
                    }
                    setValidationErrors([]);
                    onConfirm();
                  }}
                >
                  <Check size={14} className="mr-2" />
                  {addDialogOpen ? "GUARDAR" : "ACTUALIZAR"}
                </Button>
                <AnimatePresence>
                  {validationErrors.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="col-span-2"
                    >
                      <ValidationErrors errors={validationErrors} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </ModalFooter>
            {/* SUB-MODAL: CREACIÓN RÁPIDA DE PROVEEDOR */}
            <SupplierFormModal
              isOpen={quickSupplierOpen}
              onOpenChange={setQuickSupplierOpen}
              onSave={handleQuickSupplierSave}
              isEdit={false}
              supplier={null}
            />
          </>
        )}
      </ModalContent>
    </Modal>
  );
});

export default ProductFormModal;