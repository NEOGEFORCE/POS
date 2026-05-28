"use client";

import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, Input, Select, SelectItem, Switch, Autocomplete, AutocompleteItem, Chip
} from "@heroui/react";
import { Package, Barcode, Camera, Box, Info, Truck, Check } from 'lucide-react';
import { Product, Category } from '@/lib/definitions';
import { formatCurrency, applySurtifamiliarRounding, parseCurrency, isProductWeighted, normalizeText, formatInputCOP, parseCOP } from '@/lib/utils';
import { validateProduct, FieldError } from '@/lib/formValidation';
import ValidationErrors from '@/components/ValidationErrors';
import { useState, useCallback, useMemo, memo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { PlusCircle } from 'lucide-react';
import SupplierFormModal from '../../suppliers/components/SupplierFormModal';
import CategoryFormModal from '../../categories/components/CategoryFormModal';
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
  categories: Category[];
  suppliers: any[];
  onConfirm: () => void;
  onScan: () => void;
  onScanAlternate: () => void;
  onScanBase?: () => void;
  allProducts: Product[];
  mutateSuppliers?: () => void;
  mutateCategories?: () => void;
  apiFieldErrors?: Record<string, string>;
}

const ProductFormModal = memo(function ProductFormModal({
  isOpen, onOpenChange, addDialogOpen,
  newProduct, setNewProduct,
  editingProduct, setEditingProduct,
  categories, suppliers, onConfirm, onScan, onScanAlternate, onScanBase, allProducts, mutateSuppliers, mutateCategories,
  apiFieldErrors = {}
}: ProductFormModalProps) {
  const { toast } = useToast();
  // Estado de errores de validación
  const [validationErrors, setValidationErrors] = useState<FieldError[]>([]);
  const [quickSupplierOpen, setQuickSupplierOpen] = useState(false);
  const [quickCategoryOpen, setQuickCategoryOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [supplierPrices, setSupplierPrices] = useState<ProductSupplierPrice[]>([]);
  const [isLoadingPrices, setIsLoadingPrices] = useState(false);
  const [duplicateFound, setDuplicateFound] = useState<Product | null>(null);
  
  // Estado para búsqueda de producto base en modo pack
  const [searchTerm, setSearchTerm] = useState("");
  const [supplierSearchValue, setSupplierSearchValue] = useState("");
  const [categorySearchValue, setCategorySearchValue] = useState("");

  // Limpiar estado de duplicados al abrir/cerrar y sincronizar búsquedas
  useEffect(() => {
    if (!isOpen) {
      setDuplicateFound(null);
      setSupplierSearchValue("");
      setCategorySearchValue("");
      setSearchTerm("");
    } else if (editingProduct && !addDialogOpen) {
      // Sincronizar nombre de categoría al editar
      const cat = categories.find(c => String(c.id) === String(editingProduct.categoryId));
      if (cat) setCategorySearchValue(cat.name);

      // Sincronizar nombre de producto base si es pack
      if (editingProduct.isPack && editingProduct.baseProductBarcode) {
        const base = allProducts.find(p => p.barcode === editingProduct.baseProductBarcode);
        if (base) setSearchTerm(base.productName);
      }
    }
  }, [isOpen, editingProduct, addDialogOpen, categories, allProducts]);
  
  // Sincronizar searchTerm con el código base si cambia externamente (ej: por scanner)
  useEffect(() => {
    const currentBarcode = addDialogOpen ? newProduct.baseProductBarcode : editingProduct?.baseProductBarcode;
    if (currentBarcode) {
      const base = allProducts.find(p => p.barcode === currentBarcode);
      if (base) setSearchTerm(base.productName);
    }
  }, [newProduct.baseProductBarcode, editingProduct?.baseProductBarcode, allProducts, addDialogOpen]);

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
  
  // Filtro real para el buscador de producto base (se mantiene por lógica de packs)
  const filteredBaseProducts = useMemo(() => {
    if (!searchTerm) return baseProducts.slice(0, 50);
    const term = searchTerm.toLowerCase();
    const filtered = baseProducts.filter(p => 
      p.productName.toLowerCase().includes(term) || 
      p.barcode.toLowerCase().includes(term)
    );
    return filtered.slice(0, 50); // Limitar para rendimiento
  }, [baseProducts, searchTerm]);
  
  // Filtrado explícito para proveedores (Mejora la respuesta del buscador)
  const filteredSuppliers = useMemo(() => {
    if (!supplierSearchValue) return suppliers;
    const term = supplierSearchValue.toLowerCase();
    return suppliers.filter(s => 
      s.name.toLowerCase().includes(term) || 
      String(s.id).includes(term)
    );
  }, [suppliers, supplierSearchValue]);

  // Filtrado explícito para categorías
  const filteredCategories = useMemo(() => {
    if (!categorySearchValue) return categories;
    const term = categorySearchValue.toLowerCase();
    return categories.filter(c => 
      c.name.toLowerCase().includes(term) ||
      String(c.id).includes(term)
    );
  }, [categories, categorySearchValue]);

  // Lógica reactiva para detección de duplicados
  useEffect(() => {
    if (!addDialogOpen || !isOpen) {
      setDuplicateFound(null);
      return;
    }

    const currentBarcode = newProduct.barcode.toUpperCase().trim();
    const currentName = newProduct.productName.toUpperCase().trim();

    if (currentBarcode.length >= 3) {
      const existing = (allProducts || []).find(p => {
        if (p.barcode.toUpperCase().trim() === currentBarcode) return true;
        if (p.alternateCodes) {
          const alts = p.alternateCodes.split(',').map(c => c.trim().toUpperCase());
          return alts.includes(currentBarcode);
        }
        return false;
      });

      if (existing) {
        setDuplicateFound(existing);
        return;
      }
    }

    if (currentName.length >= 4) {
      const existing = (allProducts || []).find(p => 
        p.productName.toUpperCase().trim() === currentName
      );
      if (existing) {
        setDuplicateFound(existing);
        return;
      }
    }

    setDuplicateFound(null);
  }, [newProduct.barcode, newProduct.productName, addDialogOpen, isOpen, allProducts]);

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
  const handleCategoryChange = useCallback((key: any) => {
    if (!key) return;
    const numVal = parseInt(String(key)) || 0;
    
    // Sincronizar el nombre en el buscador para feedback visual
    const selectedCat = categories.find(c => String(c.id) === String(numVal));
    if (selectedCat) {
      setCategorySearchValue(selectedCat.name);
    }

    if (addDialogOpen) setNewProduct((p: any) => ({ ...p, categoryId: numVal }));
    else setEditingProduct((p: any) => p ? { ...p, categoryId: numVal } : null);
  }, [addDialogOpen, setNewProduct, setEditingProduct, categories]);

  // Manejador para añadir proveedores vía Autocomplete (Búsqueda)
  const handleAddSupplier = useCallback((key: any) => {
    if (!key) return;
    const id = parseInt(String(key));
    
    const currentSuppliers = addDialogOpen ? (newProduct.suppliers || []) : (editingProduct?.suppliers || []);
    if (currentSuppliers.some((s: any) => s.id === id)) return;

    const newSuppliersPayload = [...currentSuppliers, { id }];
    
    if (addDialogOpen) {
      setNewProduct((p: any) => ({ ...p, suppliers: newSuppliersPayload, supplierId: id }));
    } else {
      setEditingProduct((p: any) => p ? { ...p, suppliers: newSuppliersPayload, supplierId: id } : null);
    }
    // Limpiar el buscador después de añadir
    setSupplierSearchValue("");
  }, [addDialogOpen, newProduct.suppliers, editingProduct?.suppliers, setNewProduct, setEditingProduct]);

  // Manejador para remover proveedores
  const handleRemoveSupplier = useCallback((idToRemove: number) => {
    const currentSuppliers = addDialogOpen ? (newProduct.suppliers || []) : (editingProduct?.suppliers || []);
    const newSuppliersPayload = currentSuppliers.filter((s: any) => s.id !== idToRemove);
    const newPrimaryId = newSuppliersPayload.length > 0 ? newSuppliersPayload[0].id : 0;

    if (addDialogOpen) {
      setNewProduct((p: any) => ({ ...p, suppliers: newSuppliersPayload, supplierId: newPrimaryId }));
    } else {
      setEditingProduct((p: any) => p ? { ...p, suppliers: newSuppliersPayload, supplierId: newPrimaryId } : null);
    }
  }, [addDialogOpen, newProduct.suppliers, editingProduct?.suppliers, setNewProduct, setEditingProduct]);

  // Callback estable para Autocomplete de Producto Base
  const handleBaseProductChange = useCallback((key: any) => {
    const barcode = key as string;
    if (!barcode) {
      if (addDialogOpen) {
        setNewProduct((p: any) => ({ ...p, baseProductBarcode: "" }));
      } else {
        setEditingProduct((p: any) => p ? { ...p, baseProductBarcode: "" } : null);
      }
      setSearchTerm("");
      return;
    }

    // Buscar el producto base para calcular el costo automáticamente
    const baseProduct = allProducts.find((p: Product) => p.barcode === barcode);
    
    if (addDialogOpen) {
      setNewProduct((p: any) => {
        const multiplier = p.packMultiplier || 1;
        const calculatedCost = baseProduct ? Math.round(baseProduct.purchasePrice * multiplier) : p.purchasePrice;
        return { 
          ...p, 
          baseProductBarcode: barcode,
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
    // Debounce para evitar ráfaga de peticiones mientras el usuario escribe en otros campos
    const handler = setTimeout(() => {
      if (editingProduct?.barcode && editingProduct.barcode.length >= 3) {
        fetchSupplierPrices(editingProduct.barcode);
      } else if (!editingProduct?.barcode) {
        setSupplierPrices([]);
      }
    }, 1000); // 1 segundo de calma
    
    return () => clearTimeout(handler);
  }, [editingProduct?.barcode, fetchSupplierPrices]);

  // Handler para guardar un proveedor rápido sin salir del flujo de productos
  const handleQuickSupplierSave = async (supplier: any) => {
    const token = Cookies.get('org-pos-token');
    try {
      const created = await apiFetch<any>('/suppliers/create-suppliers', {
        method: 'POST',
        body: JSON.stringify(supplier),
      }, token!);
      
      // Notificar a todo el sistema que hay un nuevo proveedor
      const { broadcastRevalidate } = await import('@/lib/revalidate');
      broadcastRevalidate('SUPPLIER_UPDATE');

      // Actualizar la lista de proveedores del padre y esperar
      if (mutateSuppliers) await mutateSuppliers();
      
      // Auto-seleccionar el nuevo proveedor
      if (addDialogOpen) {
        setNewProduct((p: any) => ({
          ...p,
          supplierId: created.id,
          suppliers: [...(p.suppliers || []), { id: created.id }]
        }));
      } else {
        setEditingProduct((p: any) => p ? {
          ...p,
          supplierId: created.id,
          suppliers: [...(p.suppliers || []), { id: created.id }]
        } : null);
      }
      
      setQuickSupplierOpen(false);
      setSupplierSearchValue(""); // Limpiar buscador tras creación exitosa
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'ERROR', description: err.message });
    }
  };

  const handleQuickCategorySave = async () => {
    const token = Cookies.get('org-pos-token');
    try {
      const created = await apiFetch<Category>('/categories/create', {
        method: 'POST',
        body: JSON.stringify({ name: normalizeText(newCategoryName) }),
      }, token!);
      
      toast({ variant: 'success', title: 'ÉXITO', description: 'CATEGORÍA CREADA' });
      
      const { broadcastRevalidate } = await import('@/lib/revalidate');
      broadcastRevalidate('CATEGORY_UPDATE');

      if (mutateCategories) await mutateCategories();
      
      if (addDialogOpen) {
        setNewProduct((p: any) => ({ ...p, categoryId: created.id }));
      } else {
        setEditingProduct((p: any) => p ? { ...p, categoryId: created.id } : null);
      }
      
      setQuickCategoryOpen(false);
      setNewCategoryName("");
      setCategorySearchValue(""); // Limpiar buscador
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'ERROR', description: err.message });
    }
  };


  // CLASES COMPARTIDAS PARA INPUTS (Optimizado para móvil)
  const itemInputClass = {
    label: "text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest tracking-tight text-center w-full mb-0.5",
    inputWrapper: "h-9 bg-gray-50 dark:bg-[#18181b] border border-gray-100 dark:border-white/5 rounded-2xl group-data-[focus=true]:border-emerald-500 transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)] py-1.5",
    input: "font-medium text-sm uppercase tracking-tight text-zinc-900 dark:text-zinc-50 text-left py-0"
  };

  // ESTILO DE SWITCH MINIMALISTA
  const minimalistSwitchClass = {
    base: "inline-flex flex-row-reverse w-full max-w-fit items-center justify-between cursor-pointer rounded-2xl gap-2",
    wrapper: "p-0 h-6 w-10 overflow-visible bg-gray-200 dark:bg-zinc-800 group-data-[selected=true]:bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 transition-colors duration-500 shadow-inner",
    thumb: "w-4 h-4 shadow-[0_8px_30px_rgb(0,0,0,0.12)] border-2 border-transparent transition-all duration-300 group-data-[selected=true]:ml-4 bg-white",
  };

  return (
    <>
      <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      placement="center"
      scrollBehavior="inside"
      backdrop="blur"
      hideCloseButton={true}
      size="5xl"
      classNames={{
        base: "bg-white dark:bg-zinc-950 rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-hidden max-h-[95vh] flex flex-col mx-2 md:mx-0",
        wrapper: "items-center justify-center p-8 md:p-12",
        closeButton: "absolute right-5 top-5 text-zinc-500 dark:text-zinc-400 hover:text-rose-500 transition-colors z-[100] rounded-2xl",
        backdrop: "bg-[#18181b] "
      }}
    >
      <ModalContent>
        <ModalHeader className="px-6 md:px-10 py-3 md:py-3 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-[#18181b]/50 rounded-t-[2.5rem]">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 bg-white/5 text-zinc-900 dark:text-zinc-100 flex items-center justify-center rounded-2xl border border-emerald-500/20 rotate-3">
                  <Package size={18} />
                </div>
                <div className="flex flex-col">
                  <h2 className="text-base md:text-lg font-medium text-zinc-900 dark:text-zinc-50 tracking-tight tracking-tighter uppercase leading-none">
                    {addDialogOpen ? "Protocolo " : "Modificar "} <span className="text-zinc-900 dark:text-zinc-100">Producto</span>
                  </h2>
                  <p className="text-[7px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em] mt-0.5 tracking-tight opacity-80">Edición Compacta v5.2</p>
                </div>
              </div>
            </ModalHeader>

            <ModalBody className="px-6 md:px-10 py-3 md:py-2 pb-32 md:pb-0 gap-0 custom-scrollbar overflow-x-hidden">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-8">
                {/* COLUMNA IZQUIERDA: IDENTIDAD Y VALORIZACIÓN */}
                <div className="flex flex-col gap-3">
                  {/* 1. SECCIÓN IDENTIDAD (Compacta) */}
              <div className="flex flex-col sm:flex-row items-center sm:items-stretch gap-4">
                <div className="relative group/photo shrink-0">
                  <div className="h-20 w-20 rounded-2xl bg-gray-50 dark:bg-[#18181b] border-2 border-dashed border-gray-200 dark:border-white/10 flex items-center justify-center overflow-hidden transition-all group-hover/photo:border-emerald-500 shadow-inner group-hover/photo:scale-[1.02] duration-300">
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
                  <div className="absolute -bottom-1 -right-1 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white p-1.5 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border-2 border-white dark:border-zinc-950 cursor-pointer active:scale-90 transition-all hover:bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5">
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
                    <label className={`${itemInputClass.label} flex items-center gap-1`}><Barcode size={10} className="text-zinc-900 dark:text-zinc-100" /> CÓDIGO</label>
                    <div className="relative">
                      <Input
                        value={addDialogOpen ? newProduct.barcode : (editingProduct?.barcode || '')}
                        inputMode="text"
                        onValueChange={(v) => {
                          const val = normalizeText(v);
                          if (addDialogOpen) setNewProduct((p: any) => ({ ...p, barcode: val }));
                          else setEditingProduct((p: any) => p ? { ...p, barcode: val } : null);
                        }}
                        classNames={{ ...itemInputClass, inputWrapper: `${itemInputClass.inputWrapper} pr-14 ${duplicateFound ? 'border-amber-500 bg-amber-500/5 shadow-[0_0_10px_rgba(245,158,11,0.2)]' : ''}` }}
                      />
                      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1 transform scale-90">
                        <Button isIconOnly size="sm" onPress={onScan} className="h-7 w-7 bg-white/5 text-zinc-900 dark:text-zinc-100 rounded-2xl">
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
                        const val = normalizeText(v);
                        if (addDialogOpen) setNewProduct((p: any) => ({ ...p, productName: val }));
                        else setEditingProduct((p: any) => p ? { ...p, productName: val } : null);
                      }}
                      classNames={{ ...itemInputClass, inputWrapper: `${itemInputClass.inputWrapper} ${duplicateFound && duplicateFound.productName.toUpperCase().trim() === (addDialogOpen ? newProduct.productName.toUpperCase().trim() : '') ? 'border-amber-500 bg-amber-500/5 shadow-[0_0_10px_rgba(245,158,11,0.2)]' : ''}` }}
                    />
                  </div>
                </div>
              </div>

                {/* BANNER DE PRODUCTO DUPLICADO */}
                <AnimatePresence>
                  {addDialogOpen && duplicateFound && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-500/10 border-2 border-amber-500/50 rounded-2xl flex flex-col sm:flex-row items-center gap-4 animate-in fade-in zoom-in duration-300">
                        <div className="h-10 w-10 rounded-2xl bg-amber-500 flex items-center justify-center text-white shrink-0 shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-amber-500/20">
                          <Info size={20} />
                        </div>
                        <div className="flex-1 text-center sm:text-left">
                          <p className="text-[10px] font-medium text-amber-600 dark:text-amber-400 uppercase tracking-widest tracking-tight">Producto ya registrado</p>
                          <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight leading-tight">{duplicateFound.productName}</h4>
                          <p className="text-[9px] font-medium text-gray-500 dark:text-zinc-400 mt-0.5">El código ingresado ya está asignado a este producto.</p>
                        </div>
                        <Button
                          size="sm"
                          onPress={() => {
                            setEditingProduct(duplicateFound);
                            setDuplicateFound(null);
                          }}
                          className="bg-amber-500 hover:bg-amber-600 text-white font-medium uppercase text-[10px] h-9 px-6 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-amber-500/20"
                        >
                          Cargar para Editar
                        </Button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>


              {/* 1.1 CÓDIGOS ALTERNOS */}
              <div className="bg-gray-50/50 dark:bg-[#18181b] p-2 rounded-2xl border border-gray-100/50 dark:border-white/5">
                <div className="flex flex-col gap-0.5">
                  <label className={`${itemInputClass.label} flex items-center justify-center gap-1`}>
                    <Barcode size={10} className="text-zinc-900 dark:text-zinc-100" /> CÓDIGOS ALTERNOS (Separados por coma)
                  </label>
                  <div className="relative">
                    <Input
                      placeholder="EJ: 7701234567890, 7700987654321"
                      value={addDialogOpen ? newProduct.alternateCodes : (editingProduct?.alternateCodes || '')}
                      onValueChange={(v) => {
                        const val = v.split(',').map(c => normalizeText(c)).join(', ');
                        if (addDialogOpen) setNewProduct((p: any) => ({ ...p, alternateCodes: val }));
                        else setEditingProduct((p: any) => p ? { ...p, alternateCodes: val } : null);
                      }}
                      classNames={{
                        ...itemInputClass,
                        inputWrapper: `${itemInputClass.inputWrapper} pr-10`,
                        input: "font-mono text-[10px] tracking-tight text-zinc-900 dark:text-zinc-100 dark:text-zinc-300"
                      }}
                    />
                    <div className="absolute right-1 top-1/2 -translate-y-1/2 transform scale-90">
                      <Button isIconOnly size="sm" onPress={onScanAlternate} className="h-7 w-7 bg-white/5 text-zinc-900 dark:text-zinc-100 rounded-2xl">
                        <Camera size={12} />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              {/* 2. VALORIZACIÓN (Inline compacto) */}
              <div className="grid grid-cols-3 gap-2 bg-gray-50/50 dark:bg-[#18181b] p-2 rounded-2xl border border-gray-100/50 dark:border-white/5">
                <div className="flex flex-col gap-0.5">
                  <label className={`${itemInputClass.label} ${hasFieldError('purchasePrice') ? 'text-rose-500' : ''}`}>COSTO</label>
                  <Input
                    variant="flat"
                    inputMode="decimal"
                    startContent={<span className={`font-medium text-[10px] ${hasFieldError('purchasePrice') ? 'text-rose-500' : 'text-zinc-900 dark:text-zinc-100'}`}>$</span>}
                    value={(() => {
                      const price = addDialogOpen ? newProduct.purchasePrice : editingProduct?.purchasePrice;
                      if (price === undefined || price === null || (price as any) === '') return '';
                      if (typeof price === 'number') return formatInputCOP(String(Math.round(price)));
                      return String(price);
                    })()}
                    onValueChange={(v) => {
                      const cleaned = formatInputCOP(v);
                      if (addDialogOpen) setNewProduct((p: any) => ({ ...p, purchasePrice: cleaned }));
                      else setEditingProduct((p: any) => p ? { ...p, purchasePrice: cleaned } : null);
                    }}
                    onBlur={(e) => {
                      const val = parseCOP(e.target.value);
                      const marginRaw = addDialogOpen ? newProduct.marginPercentage : editingProduct?.marginPercentage;
                      const hasMargin = marginRaw !== undefined && marginRaw !== null && marginRaw !== ("" as any);
                      const margin = Number(marginRaw) || 0;
                      let currentPvpRaw = addDialogOpen ? newProduct.salePrice : editingProduct?.salePrice;
                      let currentPvp = typeof currentPvpRaw === 'string' ? parseCOP(currentPvpRaw) : (parseFloat(String(currentPvpRaw)) || 0);

                      let newPvp = currentPvp;
                      let newMargin = marginRaw;

                      if (hasMargin) {
                          newPvp = applySurtifamiliarRounding(Math.round(val * (1 + margin / 100)));
                      } else {
                          if (currentPvp > 0 && val > 0) {
                              newMargin = Number((((currentPvp / val) - 1) * 100).toFixed(2));
                          }
                      }

                      if (addDialogOpen) {
                          setNewProduct((p: any) => ({ ...p, purchasePrice: val > 0 ? formatInputCOP(String(val)) : '', salePrice: newPvp > 0 ? formatInputCOP(String(newPvp)) : '', marginPercentage: newMargin }));
                      } else {
                          setEditingProduct((p: any) => p ? { ...p, purchasePrice: val > 0 ? formatInputCOP(String(val)) : '', salePrice: newPvp > 0 ? formatInputCOP(String(newPvp)) : '', marginPercentage: newMargin } : null);
                      }
                    }}
                    classNames={{ 
                      ...itemInputClass, 
                      inputWrapper: `${itemInputClass.inputWrapper} ${hasFieldError('purchasePrice') ? 'border-rose-500 bg-rose-500/5' : ''}`,
                      input: `${itemInputClass.input} tabular-nums ${hasFieldError('purchasePrice') ? 'text-rose-500' : ''}` 
                    }}
                  />
                  {getFieldError('purchasePrice') && (
                    <span className="text-[9px] font-medium text-rose-500 tracking-tight">{getFieldError('purchasePrice')}</span>
                  )}
                </div>
                <div className="flex flex-col gap-0.5">
                  <label className="text-xs font-medium text-sky-500 uppercase tracking-widest tracking-tight text-center w-full mb-0.5">MARGEN %</label>
                  <Input
                    type="text"
                    inputMode="decimal"
                    value={(() => {
                        const m = addDialogOpen ? (newProduct.marginPercentage) : (editingProduct?.marginPercentage);
                        if (m === undefined || m === null) return "";
                        return String(m);
                    })()}
                    onBlur={(e) => {
                       const valRaw = e.target.value.replace(",", ".");
                       if (valRaw === "") {
                           if (addDialogOpen) setNewProduct((p: any) => ({ ...p, marginPercentage: "" }));
                           else setEditingProduct((p: any) => p ? { ...p, marginPercentage: "" } : null);
                           return;
                       }
                       const val = parseFloat(valRaw) || 0;
                       
                       const costRaw = addDialogOpen ? newProduct.purchasePrice : editingProduct?.purchasePrice;
                       const cost = typeof costRaw === 'string' ? parseCOP(costRaw) : (parseFloat(String(costRaw)) || 0);
                       
                       const pvpRaw = addDialogOpen ? newProduct.salePrice : editingProduct?.salePrice;
                       const pvp = typeof pvpRaw === 'string' ? parseCOP(pvpRaw) : (parseFloat(String(pvpRaw)) || 0);

                       const newPvp = cost > 0 ? applySurtifamiliarRounding(Math.round(cost * (1 + val / 100))) : pvp;
                       const formattedMargin = Number(val.toFixed(2));

                       if (addDialogOpen) {
                         setNewProduct((p: any) => ({ ...p, marginPercentage: formattedMargin, salePrice: newPvp > 0 ? formatInputCOP(String(newPvp)) : '' }));
                       } else {
                         setEditingProduct((p: any) => p ? { ...p, marginPercentage: formattedMargin, salePrice: newPvp > 0 ? formatInputCOP(String(newPvp)) : '' } : null);
                       }
                    }}
                    onFocus={(e) => e.target.select()}
                    onValueChange={(v) => {
                      if (addDialogOpen) setNewProduct((p: any) => ({ ...p, marginPercentage: v }));
                      else setEditingProduct((p: any) => p ? { ...p, marginPercentage: v } : null);
                    }}
                    classNames={{
                      inputWrapper: "h-9 bg-sky-500/5 border border-sky-500/10 rounded-2xl py-1.5 focus-within:border-sky-500",
                      input: "font-medium text-sm tabular-nums text-sky-500 tracking-tight text-left py-0"
                    }}
                  />
                </div>
                <div className="flex flex-col gap-0.5 relative">
                  <label className={`text-xs font-medium uppercase tracking-widest tracking-tight text-center w-full mb-0.5 ${hasFieldError('salePrice') ? 'text-rose-500' : 'text-zinc-900 dark:text-zinc-100'}`}>PVP FINAL</label>
                  <Input
                    inputMode="decimal"
                    startContent={<span className={`font-medium text-xs ${hasFieldError('salePrice') ? 'text-rose-500' : 'text-zinc-900 dark:text-zinc-100'}`}>$</span>}
                    value={(() => {
                        const price = addDialogOpen ? (newProduct.salePrice) : (editingProduct?.salePrice);
                        if (price === undefined || price === null || (price as any) === '') return '';
                        if (typeof price === 'number') return formatInputCOP(String(Math.round(price)));
                        return String(price);
                    })()}
                    onBlur={(e) => {
                      const val = parseCOP(e.target.value);
                      const marginRaw = addDialogOpen ? newProduct.marginPercentage : editingProduct?.marginPercentage;
                      const hasMargin = marginRaw !== undefined && marginRaw !== null && marginRaw !== ("" as any);
                      const margin = Number(marginRaw) || 0;
                      
                      const costRaw = addDialogOpen ? newProduct.purchasePrice : editingProduct?.purchasePrice;
                      const currentCost = typeof costRaw === 'string' ? parseCOP(costRaw) : (parseFloat(String(costRaw)) || 0);

                      let newCost = currentCost;
                      let newMargin = marginRaw;

                      if (hasMargin) {
                          newCost = Math.round(val / (1 + margin / 100));
                      } else {
                          if (currentCost > 0 && val > 0) {
                              newMargin = Number((((val / currentCost) - 1) * 100).toFixed(2));
                          }
                      }

                      if (addDialogOpen) {
                          setNewProduct((p: any) => ({ ...p, salePrice: val > 0 ? formatInputCOP(String(val)) : '', purchasePrice: newCost > 0 ? formatInputCOP(String(newCost)) : '', marginPercentage: newMargin }));
                      } else {
                          setEditingProduct((p: any) => p ? { ...p, salePrice: val > 0 ? formatInputCOP(String(val)) : '', purchasePrice: newCost > 0 ? formatInputCOP(String(newCost)) : '', marginPercentage: newMargin } : null);
                      }
                    }}
                    onValueChange={(v) => {
                      const cleaned = formatInputCOP(v);
                      if (addDialogOpen) setNewProduct((p: any) => ({ ...p, salePrice: cleaned }));
                      else setEditingProduct((p: any) => p ? { ...p, salePrice: cleaned } : null);
                    }}
                    classNames={{
                      inputWrapper: `h-9 border rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] py-1.5 ${hasFieldError('salePrice') ? 'bg-rose-500/5 border-rose-500' : 'bg-white/5 border-emerald-500/20'}`,
                      input: `font-medium text-sm tabular-nums tracking-tight text-left py-0 ${hasFieldError('salePrice') ? 'text-rose-500' : 'text-zinc-900 dark:text-zinc-100'}`
                    }}
                  />
                  {!hasFieldError('salePrice') && (
                    <div className="absolute -right-1 -top-1 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white text-[6px] font-medium px-1.5 py-0.5 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] z-10">
                      +{formatCOP((addDialogOpen ? (newProduct.salePrice || 0) - (newProduct.purchasePrice || 0) : (editingProduct?.salePrice || 0) - (editingProduct?.purchasePrice || 0)))}
                    </div>
                  )}
                  {getFieldError('salePrice') && (
                    <span className="text-[9px] font-medium text-rose-500 tracking-tight">{getFieldError('salePrice')}</span>
                  )}
                </div>
              </div>

              {/* 2.1 IMPUESTOS (Persistencia Automática) */}
              <div className="grid grid-cols-3 gap-2 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 p-2 rounded-2xl border border-emerald-500/10 mt-2 mb-1">
                <div className="flex flex-col gap-0.5">
                  <label className="text-[8px] font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-300 uppercase tracking-[0.15em] tracking-tight text-center w-full mb-0.5">IVA %</label>
                  <Input
                    size="sm"
                    inputMode="decimal"
                    value={String(addDialogOpen ? (newProduct.iva ?? '') : (editingProduct?.iva ?? ''))}
                    placeholder="0"
                    onValueChange={(v) => {
                      const val = v === '' ? 0 : parseFloat(v.replace(",", "."));
                      if (addDialogOpen) setNewProduct((p: any) => ({ ...p, iva: val }));
                      else setEditingProduct((p: any) => p ? { ...p, iva: val } : null);
                    }}
                    classNames={{
                      ...itemInputClass,
                      inputWrapper: "h-8 card-base border-none border-emerald-500/20",
                      input: "text-center text-xs text-zinc-900 dark:text-zinc-100 font-medium"
                    }}
                  />
                </div>
                <div className="flex flex-col gap-0.5">
                  <label className="text-[8px] font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-300 uppercase tracking-[0.15em] tracking-tight text-center w-full mb-0.5">ICUI %</label>
                  <Input
                    size="sm"
                    inputMode="decimal"
                    value={String(addDialogOpen ? (newProduct.icui ?? '') : (editingProduct?.icui ?? ''))}
                    placeholder="0"
                    onValueChange={(v) => {
                      const val = v === '' ? 0 : parseFloat(v.replace(",", "."));
                      if (addDialogOpen) setNewProduct((p: any) => ({ ...p, icui: val }));
                      else setEditingProduct((p: any) => p ? { ...p, icui: val } : null);
                    }}
                    classNames={{
                      ...itemInputClass,
                      inputWrapper: "h-8 card-base border-none border-emerald-500/20",
                      input: "text-center text-xs text-zinc-900 dark:text-zinc-100 font-medium"
                    }}
                  />
                </div>
                <div className="flex flex-col gap-0.5 col-span-1">
                  <label className="text-[8px] font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-300 uppercase tracking-[0.15em] tracking-tight text-center w-full mb-0.5">IBUA %</label>
                  <Input
                    size="sm"
                    inputMode="decimal"
                    value={String(addDialogOpen ? (newProduct.ibua ?? '') : (editingProduct?.ibua ?? ''))}
                    placeholder="0"
                    onValueChange={(v) => {
                      const val = v === '' ? 0 : parseFloat(v.replace(",", "."));
                      if (addDialogOpen) setNewProduct((p: any) => ({ ...p, ibua: val }));
                      else setEditingProduct((p: any) => p ? { ...p, ibua: val } : null);
                    }}
                    classNames={{
                      ...itemInputClass,
                      inputWrapper: "h-8 card-base border-none border-emerald-500/20",
                      input: "text-center text-xs text-zinc-900 dark:text-zinc-100 font-medium"
                    }}
                  />
                </div>
                {/* COMPARATIVA DE PRECIOS DETALLADA */}
                {supplierPrices.length > 0 && !addDialogOpen && (
                  <motion.div 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="flex flex-col gap-3 p-4 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5/[0.02] rounded-2xl border border-emerald-500/10 shadow-inner overflow-hidden mb-1"
                  >
                    <div className="flex items-center justify-between px-1">
                      <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                        <h4 className="text-[10px] font-medium uppercase tracking-[0.2em] tracking-tight text-zinc-900 dark:text-zinc-100/80">Comparativa de Costos</h4>
                      </div>
                      <span className="text-[8px] font-medium text-gray-400 uppercase tracking-tight">Mejor precio resaltado</span>
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
                                  ? "card-base border-none border-emerald-500/40 shadow-[0_4px_12px_rgba(16,185,129,0.08)]" 
                                  : "bg-white/50 dark:bg-[#18181b] border-gray-100 dark:border-white/5 opacity-80"
                              }`}
                            >
                              <div className="flex flex-col gap-0.5">
                                <span className={`text-[9px] font-medium uppercase tracking-tight ${isCheapest ? "text-zinc-900 dark:text-zinc-100" : "text-gray-500"}`}>
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
                                    <span className="text-[8px] font-medium text-zinc-900 dark:text-zinc-100 bg-white/5 px-2 py-0.5 rounded-2xl uppercase tracking-tight">
                                      -{formatCOP(supplierPrices[idx+1].purchasePrice - price.purchasePrice)} ahorro
                                    </span>
                                  )}
                                  <span className={`text-[12px] font-medium tracking-tight tracking-tighter ${isCheapest ? "text-zinc-900 dark:text-zinc-100 scale-110 origin-right transition-transform" : "text-gray-400"}`}>
                                    {formatCOP(price.purchasePrice)}
                                  </span>
                                </div>
                                {isCheapest && (
                                  <div className="flex items-center gap-1">
                                    <Check size={8} className="text-zinc-900 dark:text-zinc-100" strokeWidth={4} />
                                    <span className="text-[7px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-tight leading-none">
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
              </div> {/* <-- Cierre de la Columna Izquierda */}

              {/* COLUMNA DERECHA: LOGÍSTICA Y STOCK */}
              <div className="flex flex-col gap-3">
                {/* 3. LOGÍSTICA & STOCK */}
                <div className="grid grid-cols-2 gap-3 bg-gray-50/20 dark:bg-black/10 p-3 rounded-2xl border border-gray-100/50 dark:border-white/5">
                  <div className="flex flex-col gap-1.5">
                    <label className={itemInputClass.label}>PROVEEDORES (BUSCAR Y AÑADIR)</label>
                    <div className="flex flex-col gap-2">
                      <div className="flex gap-1.5 items-center">
                        <Autocomplete
                          aria-label="Buscar proveedores"
                          placeholder="ESCRIBE PARA BUSCAR..."
                          onSelectionChange={handleAddSupplier}
                          inputValue={supplierSearchValue}
                          onInputChange={setSupplierSearchValue}
                          items={filteredSuppliers}
                          startContent={<Truck size={14} className="text-zinc-900 dark:text-zinc-100 mr-1" />}
                          classNames={{
                            base: "flex-1",
                          }}
                          popoverProps={{
                            className: "z-[9999] bg-white dark:bg-zinc-950 border border-gray-100 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-2xl"
                          }}
                          inputProps={{
                            classNames: {
                              inputWrapper: "h-11 bg-gray-50/80 dark:bg-[#18181b] border border-gray-200/50 dark:border-white/10 rounded-2xl px-3",
                              input: "font-bold text-xs uppercase text-zinc-900 dark:text-zinc-50 placeholder:text-gray-400",
                            }
                          }}
                        >
                          {(s: any) => (
                            <AutocompleteItem key={String(s.id)} textValue={s.name}>
                              <span className="text-[10px] font-medium uppercase tracking-tight">{s.name}</span>
                            </AutocompleteItem>
                          )}
                        </Autocomplete>
                        <Button
                          isIconOnly
                          variant="flat"
                          className="h-11 w-11 min-w-0 bg-white/5 text-zinc-900 dark:text-zinc-100 border border-emerald-500/20 rounded-2xl active:scale-95"
                          onPress={() => setQuickSupplierOpen(true)}
                        >
                          <PlusCircle size={18} />
                        </Button>
                      </div>
                      
                      {/* Visualización de proveedores seleccionados */}
                      <div className="flex flex-wrap gap-1.5 p-2 min-h-[40px] bg-gray-50/30 dark:bg-[#18181b] rounded-2xl border border-dashed border-gray-200 dark:border-white/5">
                        {((addDialogOpen ? newProduct.suppliers : editingProduct?.suppliers) || []).length === 0 ? (
                          <span className="text-[8px] font-bold text-gray-400 uppercase tracking-tight m-auto">Sin proveedores vinculados</span>
                        ) : (
                          ((addDialogOpen ? newProduct.suppliers : editingProduct?.suppliers) || []).map((s: any) => {
                            const fullInfo = suppliers.find(sup => sup.id === s.id);
                            return (
                              <Chip 
                                key={s.id} 
                                size="sm"
                                variant="flat"
                                color="success"
                                onClose={() => handleRemoveSupplier(s.id)}
                                className="bg-white/5 text-zinc-900 dark:text-zinc-100 border border-emerald-500/20 font-medium text-[8px] uppercase tracking-tight"
                              >
                                {fullInfo?.name || `ID: ${s.id}`}
                              </Chip>
                            );
                          })
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <label className={itemInputClass.label}>CATEGORÍA</label>
                    <div className="flex gap-1.5 items-center">
                      <Autocomplete
                        aria-label="Seleccionar categoría"
                        placeholder="BUSCAR..."
                        inputValue={categorySearchValue}
                        onInputChange={setCategorySearchValue}
                        selectedKey={addDialogOpen
                          ? (newProduct.categoryId ? String(newProduct.categoryId) : null)
                          : (editingProduct?.categoryId ? String(editingProduct.categoryId) : null)
                        }
                        onSelectionChange={handleCategoryChange}
                        items={filteredCategories}
                        startContent={<Package size={14} className="text-zinc-900 dark:text-zinc-100 mr-1" />}
                        classNames={{
                          base: "flex-1",
                        }}
                        popoverProps={{
                          className: "z-[9999] bg-white dark:bg-zinc-950 border border-gray-100 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-2xl"
                        }}
                        inputProps={{
                          classNames: {
                            inputWrapper: "h-11 bg-gray-50/80 dark:bg-[#18181b] border border-gray-200/50 dark:border-white/10 rounded-2xl px-3",
                            input: "font-bold text-xs uppercase text-zinc-900 dark:text-zinc-50 placeholder:text-gray-400",
                          }
                        }}
                      >
                        {(c: any) => (
                          <AutocompleteItem key={String(c.id)} textValue={c.name}>
                            <span className="text-[10px] font-medium uppercase tracking-tight">{c.name}</span>
                          </AutocompleteItem>
                        )}
                      </Autocomplete>
                      <Button
                        isIconOnly
                        variant="flat"
                        className="h-11 w-11 min-w-0 bg-white/5 text-zinc-900 dark:text-zinc-100 border border-emerald-500/20 rounded-2xl active:scale-95"
                        onPress={() => setQuickCategoryOpen(true)}
                      >
                        <PlusCircle size={18} />
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <label className={itemInputClass.label}>STOCK ACTUAL</label>
                    <Input
                      type="number"
                      step={(addDialogOpen ? newProduct.isWeighted : editingProduct?.isWeighted) ? "any" : "1"}
                      inputMode={(addDialogOpen ? newProduct.isWeighted : editingProduct?.isWeighted) ? "decimal" : "numeric"}
                      isDisabled={(addDialogOpen ? newProduct.quantity : editingProduct?.quantity) === -1}
                      value={(addDialogOpen ? newProduct.quantity : editingProduct?.quantity) === -1 ? "∞" : String(addDialogOpen ? (newProduct.quantity ?? '') : (editingProduct?.quantity ?? ''))}
                      onValueChange={(v) => {
                        // Allow typing decimals like '1.' or '1.5' by saving the string if it ends in a dot,
                        // otherwise parsing to float. HeroUI's type="number" gives us strings natively.
                        if (addDialogOpen) setNewProduct((p: any) => ({ ...p, quantity: v }));
                        else setEditingProduct((p: any) => p ? { ...p, quantity: v } : null);
                      }}
                      classNames={{
                        ...itemInputClass,
                        inputWrapper: `${itemInputClass.inputWrapper}`,
                        input: `${itemInputClass.input} text-left ${(addDialogOpen ? newProduct.quantity : editingProduct?.quantity) === -1 ? 'text-zinc-900 dark:text-zinc-100 text-lg' : ''}`
                      }}
                    />
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <label className={`text-xs font-medium uppercase tracking-widest tracking-tight text-center w-full mb-0.5 ${hasFieldError('minStock') ? 'text-rose-600' : 'text-rose-500'}`}>STOCK MÍNIMO</label>
                    <Input
                      type="number"
                      step={(addDialogOpen ? newProduct.isWeighted : editingProduct?.isWeighted) ? "any" : "1"}
                      inputMode={(addDialogOpen ? newProduct.isWeighted : editingProduct?.isWeighted) ? "decimal" : "numeric"}
                      value={String(addDialogOpen 
                        ? (newProduct.minStock ?? '') 
                        : (editingProduct?.minStock ?? '')
                      )}
                      onValueChange={(v) => {
                        if (addDialogOpen) setNewProduct((p: any) => ({ ...p, minStock: v }));
                        else setEditingProduct((p: any) => p ? { ...p, minStock: v } : null);
                      }}
                      classNames={{
                        ...itemInputClass,
                        inputWrapper: `rounded-2xl ${hasFieldError('minStock') ? 'bg-rose-500/10 border-rose-500 border-2' : 'bg-rose-500/5 border border-rose-500/10'}`,
                        input: `font-medium text-sm tabular-nums text-left ${hasFieldError('minStock') ? 'text-rose-600' : 'text-rose-500'}`
                      }}
                    />
                    {getFieldError('minStock') && (
                      <span className="text-xs font-medium text-rose-500 tracking-tight">{getFieldError('minStock')}</span>
                    )}
                  </div>
                </div>
              {/* 4. CONFIGURACIÓN ESPECIAL (Compacta) */}
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="flex-1 flex flex-col gap-2 p-3 bg-gray-50/50 dark:bg-[#18181b] rounded-2xl border border-gray-100 dark:border-white/5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className={`h-6 w-6 rounded-2xl flex items-center justify-center transition-all duration-500 ${isProductWeighted(addDialogOpen ? newProduct : editingProduct) ? 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)]' : 'bg-gray-100 dark:bg-zinc-800 text-gray-400'}`}>
                        <Info size={12} />
                      </div>
                      <span className="text-[8px] font-medium text-gray-500 uppercase tracking-widest tracking-tight">Pesable</span>
                    </div>
                    <Switch
                      size="sm"
                      isSelected={isProductWeighted(addDialogOpen ? newProduct : editingProduct)}
                      onValueChange={(v) => {
                        if (addDialogOpen) setNewProduct((p: any) => ({ ...p, isWeighted: v, quantity: v ? 0 : p.quantity }));
                        else setEditingProduct((p: any) => p ? { ...p, isWeighted: v, quantity: v ? 0 : p.quantity } : null);
                      }}
                      classNames={minimalistSwitchClass}
                    />
                  </div>

                  {isProductWeighted(addDialogOpen ? newProduct : editingProduct) && (
                    <div className="flex items-center justify-between pt-1 border-t border-gray-100 dark:border-white/5 mt-1">
                      <span className="text-[7px] font-medium text-gray-400 uppercase tracking-tight">Control de Stock</span>
                      <div className="flex bg-gray-200 dark:bg-zinc-800 p-0.5 rounded-2xl gap-1">
                        <button
                          onClick={() => {
                            if (addDialogOpen) setNewProduct((p: any) => ({ ...p, quantity: 0 }));
                            else setEditingProduct((p: any) => p ? { ...p, quantity: 0 } : null);
                          }}
                          className={`px-2 py-1 rounded-2xl text-[8px] font-medium transition-all ${
                            (addDialogOpen ? newProduct.quantity : editingProduct?.quantity) !== -1 
                            ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-[0_8px_30px_rgb(0,0,0,0.12)]' 
                            : 'text-gray-400'
                          }`}
                        >
                          REAL
                        </button>
                        <button
                          onClick={() => {
                            if (addDialogOpen) setNewProduct((p: any) => ({ ...p, quantity: -1 }));
                            else setEditingProduct((p: any) => p ? { ...p, quantity: -1 } : null);
                          }}
                          className={`px-2 py-1 rounded-2xl text-[8px] font-medium transition-all ${
                            (addDialogOpen ? newProduct.quantity : editingProduct?.quantity) === -1 
                            ? 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)]' 
                            : 'text-gray-400'
                          }`}
                        >
                          ∞ INFINITO
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex-1 flex items-center justify-between px-3 h-10 bg-gray-50/50 dark:bg-[#18181b] rounded-2xl border border-gray-100 dark:border-white/5">
                  <div className="flex items-center gap-2">
                    <div className={`h-6 w-6 rounded-2xl flex items-center justify-center transition-all duration-500 ${isPack ? 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)]' : 'bg-gray-100 dark:bg-zinc-800 text-gray-400'}`}>
                      <Box size={12} />
                    </div>
                    <span className="text-[8px] font-medium text-gray-500 uppercase tracking-widest tracking-tight">Modo Pack</span>
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
                    <div className="flex flex-row gap-2 p-2 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 rounded-2xl border border-emerald-500/10">
                      {/* Producto Base: 75% del ancho */}
                      <div className="flex-1 flex flex-col gap-0.5 min-w-0">
                        <label className="text-xs font-medium uppercase tracking-widest tracking-tight text-center w-full">PRODUCTO BASE</label>
                        <div className="flex gap-1 items-center">
                          <Autocomplete
                            aria-label="Seleccionar producto base para pack"
                            items={filteredBaseProducts}
                            selectedKey={(addDialogOpen ? newProduct.baseProductBarcode : editingProduct?.baseProductBarcode) || null}
                            inputValue={searchTerm}
                            onInputChange={setSearchTerm}
                            placeholder="ESCRIBE O ESCANEA..."
                            startContent={<Package size={14} className="text-zinc-900 dark:text-zinc-100 mr-1 flex-shrink-0" />}
                            onSelectionChange={handleBaseProductChange}
                            allowsCustomValue={false}
                            isClearable
                            classNames={{
                              base: "flex-1",
                            }}
                            popoverProps={{
                              className: "z-[9999] bg-white dark:bg-zinc-950 border border-gray-100 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-2xl w-[320px]",
                              onClose: handlePopoverClose
                            }}
                            inputProps={{
                              classNames: {
                                inputWrapper: "h-11 card-base border-none border-2 border-emerald-500/30 rounded-2xl py-0 group-data-[focus=true]:border-emerald-500",
                                input: "font-medium text-[11px] uppercase tracking-tight text-left py-0"
                              }
                            }}
                          >
                            {(item) => (
                              <AutocompleteItem key={item.barcode} textValue={item.productName} className="py-2 border-b border-gray-100 dark:border-white/5 last:border-0">
                                <div className="flex flex-col min-w-0">
                                  <span className="text-[11px] font-medium uppercase tracking-tight truncate block w-full text-zinc-900 dark:text-zinc-100 dark:text-zinc-300">{item.productName}</span>
                                  <div className="flex items-center gap-2 mt-0.5">
                                    <span className="text-[9px] text-gray-400 font-bold uppercase tracking-widest">{item.barcode}</span>
                                    <span className="text-[9px] font-medium text-gray-400 tracking-tight">${formatCOP(item.purchasePrice)}</span>
                                  </div>
                                </div>
                              </AutocompleteItem>
                            )}
                          </Autocomplete>
                          <Button 
                            isIconOnly 
                            variant="flat" 
                            className="h-11 w-11 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white rounded-2xl flex-shrink-0 shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-90"
                            onPress={onScanBase}
                            title="Escanear Producto Base"
                          >
                            <Camera size={20} />
                          </Button>
                        </div>
                      </div>

                      {/* Unidades: 25% del ancho - w-24 fijo */}
                      <div className="flex flex-col gap-0.5 w-24 flex-shrink-0">
                        <label className="text-xs font-medium uppercase tracking-widest tracking-tight text-center w-full">UND/PAQ</label>
                        <Input
                          type="number"
                          inputMode="numeric"
                          size="sm"
                          value={String(addDialogOpen ? (newProduct.packMultiplier ?? '') : (editingProduct?.packMultiplier ?? ''))}
                          onValueChange={handlePackMultiplierChange}
                          classNames={{
                            inputWrapper: "h-9 card-base border-none border border-emerald-500/20 rounded-2xl py-0",
                            input: "font-medium text-sm tabular-nums text-zinc-900 dark:text-zinc-100 tracking-tight text-left py-0"
                          }}
                        />
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              </div>

                </div>
            </ModalBody>

            <ModalFooter className="px-6 md:px-10 py-3 md:py-3 border-t border-gray-100 dark:border-white/5 bg-gray-100/50 dark:bg-zinc-950/50 rounded-b-[2.5rem]">
              <div className="flex flex-col w-full gap-3">
                <AnimatePresence>
                  {validationErrors.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="w-full"
                    >
                      <ValidationErrors errors={validationErrors} />
                    </motion.div>
                  )}
                </AnimatePresence>
                <div className="flex w-full gap-3">
                  <Button
                    variant="flat"
                    className="flex-1 h-10 rounded-2xl font-medium uppercase text-[9px] card-base border-none text-gray-400 tracking-tight tracking-widest border border-gray-100 dark:border-white/5"
                    onPress={() => onOpenChange(false)}
                  >
                    descartar
                  </Button>
                  <Button
                    className={`flex-[2] h-10 font-medium uppercase tracking-widest rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all active:scale-[0.98] tracking-tight text-[10px] ${
                      duplicateFound 
                        ? "bg-amber-500 text-white shadow-amber-500/20 hover:bg-amber-600" 
                        : "bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white  hover:bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5"
                    }`}
                    onPress={() => {
                      if (addDialogOpen && duplicateFound) {
                        setEditingProduct(duplicateFound);
                        setDuplicateFound(null);
                        return;
                      }

                      const current = addDialogOpen ? newProduct : editingProduct;
                      const result = validateProduct({
                        barcode: current?.barcode,
                        productName: current?.productName,
                        purchasePrice: current?.purchasePrice,
                        salePrice: current?.salePrice,
                        quantity: current?.quantity,
                        minStock: current?.minStock,
                        marginPercentage: current?.marginPercentage,
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
                    {duplicateFound ? (
                      <>
                        <Info size={14} className="mr-2" />
                        CARGAR PARA EDITAR
                      </>
                    ) : (
                      <>
                        <Check size={14} className="mr-2" />
                        {addDialogOpen ? "GUARDAR" : "ACTUALIZAR"}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </ModalFooter>
      </ModalContent>
    </Modal>

    {/* SUB-MODAL: CREACIÓN RÁPIDA DE PROVEEDOR (FUERA DEL MODAL PADRE PARA EVITAR CONFLICTOS DE OVERLAY) */}
    <SupplierFormModal
      isOpen={quickSupplierOpen}
      onOpenChange={setQuickSupplierOpen}
      onSave={handleQuickSupplierSave}
      isEdit={false}
      supplier={null}
    />

    {/* SUB-MODAL: CREACIÓN RÁPIDA DE CATEGORÍA (FUERA DEL MODAL PADRE PARA EVITAR CONFLICTOS DE OVERLAY) */}
    <CategoryFormModal
      isOpen={quickCategoryOpen}
      onOpenChange={setQuickCategoryOpen}
      isEdit={false}
      categoryName={newCategoryName}
      setCategoryName={setNewCategoryName}
      onSave={handleQuickCategorySave}
    />
  </>
  );
});

export default ProductFormModal;
