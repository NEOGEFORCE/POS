import React, { memo, useState, useEffect } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, Input, Autocomplete, AutocompleteItem, Card, CardBody, Switch, cn
} from "@heroui/react";
import {
  TrendingDown, Wallet, Zap, Building2, HandCoins, Sparkles,
  FileText, CreditCard, Layers, UserPlus, Search, Landmark, Briefcase, Plus
} from 'lucide-react';
import { Expense, Supplier } from '@/lib/definitions';
import { useApi } from '@/hooks/use-api';
import { formatCurrency, parseCurrency } from '@/lib/utils';
import { validateExpense, FieldError } from '@/lib/formValidation';
import ValidationErrors from '@/components/ValidationErrors';
import Cookies from 'js-cookie';
import { useToast } from '@/hooks/use-toast';
import { apiFetch } from '@/lib/api-error';
import SupplierFormModal from '@/app/(app)/suppliers/components/SupplierFormModal';

interface ExpenseFormModalProps {
  isOpen: boolean;
  onOpenChange?: (open: boolean) => void;
  onClose?: () => void;
  isEdit?: boolean;
  initialExpense?: Partial<Expense> | null;
  onSave: (data: any) => Promise<void>;
}

interface LocalExpenseState {
  id?: string | number;
  date?: string;
  description: string;
  amount: string | number;
  paymentSource: string;
  category: string;
  supplierId: number | string | null;
  lenderName: string;
  status: 'PAID' | 'PENDING';
  isManualDescription: boolean;
  linkedOrderId?: number;
  creator?: any;
  taxAmount: number;
}

interface PurchaseOrder {
  id: number;
  supplierId: number;
  status: string;
  items: Array<{
    productBarcode: string;
    productName: string;
    quantity: number;
    purchasePrice: number;
  }>;
  createdAt: string;
}

const CATEGORIES = [
  { id: 'Proveedores', label: 'Proveedores', icon: Building2, color: 'sky' },
  { id: 'Servicios Públicos', label: 'Servicios Públicos', icon: Zap, color: 'amber' },
  { id: 'Nómina', label: 'Nómina', icon: Briefcase, color: 'emerald' },
  { id: 'Daños / Arreglos', label: 'Daños / Arreglos', icon: Layers, color: 'rose' },
  { id: 'Otros Gastos', label: 'Otros Gastos', icon: HandCoins, color: 'gray' }
];

const ExpenseFormModal = memo(({
  isOpen,
  onOpenChange,
  onClose: customOnClose,
  isEdit = false,
  initialExpense = null,
  onSave
}: ExpenseFormModalProps) => {
  const { data: suppliers, mutate: mutateSuppliers } = useApi<Supplier[]>('/suppliers/all-suppliers');
  const [isSupplierModalOpen, setIsSupplierModalOpen] = useState(false);
  const [validationErrors, setValidationErrors] = useState<FieldError[]>([]);
  const [pendingOrders, setPendingOrders] = useState<PurchaseOrder[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [isLoadingOrders, setIsLoadingOrders] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();

  const [localExpense, setLocalExpense] = useState<LocalExpenseState>({
    description: '',
    amount: '',
    paymentSource: 'EFECTIVO',
    category: 'Otros Gastos',
    supplierId: null,
    lenderName: '',
    status: 'PAID',
    isManualDescription: false,
    taxAmount: 0
  });

  const [supplierInputValue, setSupplierInputValue] = useState('');

  // --- PERSISTENCIA DE BORRADORES (Tarea 4) ---
  useEffect(() => {
    if (isEdit) return;
    const saved = localStorage.getItem('expense-form-draft');
    if (saved && isOpen) {
      try {
        const draft = JSON.parse(saved);
        setLocalExpense(prev => ({ ...prev, ...draft }));
      } catch (e) {
        console.error("Error loading expense draft", e);
      }
    }
  }, [isOpen, isEdit]);

  useEffect(() => {
    if (isOpen && !isEdit) {
      localStorage.setItem('expense-form-draft', JSON.stringify(localExpense));
    }
  }, [localExpense, isOpen, isEdit]);

  useEffect(() => {
    if (isOpen && initialExpense) {
      setLocalExpense({
        ...initialExpense,
        description: initialExpense.description || '',
        amount: initialExpense.amount || '',
        paymentSource: initialExpense.paymentSource || 'EFECTIVO',
        category: initialExpense.category || 'Otros Gastos',
        supplierId: initialExpense.supplierId || null,
        lenderName: initialExpense.lenderName || '',
        status: initialExpense.status || 'PAID',
        isManualDescription: true,
        taxAmount: initialExpense.taxAmount || 0
      });
      // Sincronizar el input con el nombre del proveedor si existe
      const sName = suppliers?.find((s: any) => s.id === initialExpense.supplierId)?.name || '';
      setSupplierInputValue(sName);
    } else if (isOpen) {
      setLocalExpense({
        description: '',
        amount: '',
        paymentSource: 'EFECTIVO',
        category: 'Otros Gastos',
        supplierId: null,
        lenderName: '',
        status: 'PAID',
        isManualDescription: false,
        taxAmount: 0
      });
      setSupplierInputValue('');
    }
    // Resetear estado de envío al abrir/cerrar
    setIsSubmitting(false);
  }, [isOpen, initialExpense, suppliers]);

  // FILTRO MANUAL BLINDADO
  const filteredSuppliers = React.useMemo(() => {
    if (!suppliers) return [];
    // FILTRAR "SIN PROVEEDOR" POR SEGURIDAD
    const cleanSuppliers = suppliers.filter(s => s.name && !s.name.toUpperCase().includes('SIN PROVEEDOR'));
    
    const search = (supplierInputValue || '').toLowerCase().trim();
    if (!search) return cleanSuppliers;
    
    // Prioridad 1: Empieza con el nombre (STRICT)
    const startsWithName = cleanSuppliers.filter(s => s.name.toLowerCase().startsWith(search));
    
    // Prioridad 2: Contiene el nombre pero no empieza con él
    const containsName = cleanSuppliers.filter(s => 
        s.name.toLowerCase().includes(search) && !s.name.toLowerCase().startsWith(search)
    );

    // Prioridad 3: Coincide con el ID/NIT
    const matchesId = cleanSuppliers.filter(s => 
        String(s.id).includes(search) && 
        !startsWithName.some(i => i.id === s.id) && 
        !containsName.some(i => i.id === s.id)
    );
    
    return [...startsWithName, ...containsName, ...matchesId];
  }, [suppliers, supplierInputValue]);

  // Lógica de Autocompletado y Bloqueo
  useEffect(() => {
    if (isEdit) return;

    if (localExpense.category === 'Proveedores') {
      // Intentamos buscar por ID, y si no (como en creaciones nuevas), usamos el valor que ya tenemos en el input
      const supplierName = suppliers?.find((s: any) => s.id === localExpense.supplierId)?.name || supplierInputValue || '';
      
      if (supplierName && !localExpense.isManualDescription) {
        setLocalExpense((prev: LocalExpenseState) => ({
          ...prev,
          description: `${supplierName} - PAGO DE PROVEEDOR`.toUpperCase(),
        }));
      }
    } else if (localExpense.category === 'Nómina') {
      if (!localExpense.isManualDescription) {
        setLocalExpense((prev: LocalExpenseState) => ({
          ...prev,
          description: 'PAGO DE NÓMINA',
        }));
      }
    } else {
      // Si no es proveedores o nómina y no ha sido editado manualmente, vaciar para que el usuario escriba
      if (!localExpense.isManualDescription) {
        setLocalExpense((prev: LocalExpenseState) => ({ ...prev, description: '' }));
      }
    }
  }, [localExpense.category, localExpense.supplierId, suppliers, isEdit]);

  useEffect(() => {
    if (localExpense.supplierId && suppliers) {
      const supplier = suppliers.find(s => String(s.id) === String(localExpense.supplierId));
      if (supplier) setSupplierInputValue(supplier.name);
    }
  }, [localExpense.supplierId, suppliers]);

  const updateField = (field: string, value: any) => {
    setLocalExpense((prev: LocalExpenseState) => {
      const newState = { ...prev, [field]: value };
      if (field === 'description') {
        newState.isManualDescription = true;
      }
      // SMART AUTOFILL: Si es préstamo de proveedor, sugerir el nombre del proveedor como acreedor
      if (field === 'paymentSource' && value === 'PRESTAMO' && prev.category === 'Proveedores') {
        const supplierName = suppliers?.find((s: any) => s.id === prev.supplierId)?.name || '';
        if (supplierName) {
          newState.lenderName = supplierName.toUpperCase();
        }
      }
      if (field === 'supplierId' && prev.paymentSource === 'PRESTAMO' && prev.category === 'Proveedores') {
        const supplierName = suppliers?.find((s: any) => s.id === value)?.name || '';
        if (supplierName) {
          newState.lenderName = supplierName.toUpperCase();
        }
      }
      return newState;
    });
  };

  // CÁLCULO AUTOMÁTICO 4x1000 PARA NEQUI
  useEffect(() => {
    const amountNum = Number(localExpense.amount) || 0;
    if (localExpense.paymentSource === 'NEQUI') {
      const tax = Math.ceil(amountNum * 0.004); // 4x1000
      setLocalExpense(prev => ({ ...prev, taxAmount: tax }));
    } else {
      setLocalExpense(prev => ({ ...prev, taxAmount: 0 }));
    }
  }, [localExpense.paymentSource, localExpense.amount]);

  const handleSaveSupplier = async (supplierData: Partial<Supplier>) => {
    const token = Cookies.get('org-pos-token');
    try {
      const newSupplier = await apiFetch('/suppliers/create-suppliers', {
        method: 'POST',
        body: JSON.stringify(supplierData),
        fallbackError: 'ERROR AL CREAR PROVEEDOR'
      }, token);

      await mutateSuppliers();

      // El backend de Go usa 'id' (minúscula) por el tag json, pero verificamos ambos
      const supplierId = newSupplier?.id || newSupplier?.ID;
      const supplierName = newSupplier?.name || supplierData.name || '';

      if (supplierId) {
        // Actualizamos ID y Concepto de una vez para que no quede vacío
        setLocalExpense((prev: any) => ({
          ...prev,
          supplierId: supplierId,
          description: localExpense.category === 'Proveedores' 
            ? `${supplierName} - PAGO DE PROVEEDOR`.toUpperCase() 
            : prev.description,
          isManualDescription: localExpense.category === 'Proveedores' ? false : prev.isManualDescription
        }));
        
        setSupplierInputValue(supplierName);
        setIsSupplierModalOpen(false);
        toast({ title: 'ÉXITO', description: 'PROVEEDOR CREADO Y SELECCIONADO' });
      } else {
        console.error('El backend no devolvió ID:', newSupplier);
        throw new Error('EL SERVIDOR NO DEVOLVIÓ EL ID DEL PROVEEDOR');
      }
    } catch (error: any) {
      console.error('Error in handleSaveSupplier:', error);
      throw error; // Propagar para que el modal de proveedor lo capture
    }
  };

  useEffect(() => {
    const fetchPendingOrders = async () => {
      if (localExpense.category === 'Proveedores' && localExpense.supplierId) {
        setIsLoadingOrders(true);
        try {
          const token = Cookies.get('org-pos-token');
          const response = await fetch(
            `${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/orders?supplier_id=${localExpense.supplierId}`,
            { headers: { 'Authorization': `Bearer ${token}` } }
          );
          if (response.ok) {
            const orders = await response.json();
            setPendingOrders(orders || []);
            if (orders?.length > 0) setSelectedOrderId(orders[0].id);
          }
        } catch (error) {
          console.error('Error fetching orders:', error);
        } finally {
          setIsLoadingOrders(false);
        }
      } else {
        setPendingOrders([]);
        setSelectedOrderId(null);
      }
    };
    fetchPendingOrders();
  }, [localExpense.category, localExpense.supplierId]);

  const paymentMethods = [
    { id: 'EFECTIVO', label: 'Caja', icon: Wallet },
    { id: 'FONDO', label: 'Fondo', icon: Landmark },
    { id: 'NEQUI', label: 'Nequi', icon: Zap },
    { id: 'DAVIPLATA', label: 'Davi', icon: Zap },
    { id: 'PRESTAMO', label: 'Prest.', icon: HandCoins }
  ];

  return (
    <>
      <Modal
        isOpen={isOpen}
        onOpenChange={onOpenChange || customOnClose}
        backdrop="blur"
        size="4xl"
        classNames={{
          base: "bg-white dark:bg-zinc-950 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)]",
          closeButton: "absolute right-5 top-5 text-gray-400 hover:text-rose-500 transition-colors z-[100] rounded-2xl",
          backdrop: "bg-[#18181b] "
        }}
      >
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="px-8 py-5 border-b border-gray-100 dark:border-white/5">
                <div className="flex items-center gap-4">
                  <div className="h-12 w-12 bg-rose-500 text-white flex items-center justify-center rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                    <TrendingDown size={24} />
                  </div>
                  <div>
                    <h2 className="text-2xl font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight leading-none">
                      {isEdit ? "Modificar" : "Autorizar"} <span className="text-rose-500">Egreso</span>
                    </h2>
                    <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest mt-1">Control de Salida Maestro</p>
                  </div>
                </div>
              </ModalHeader>

              <ModalBody className="px-8 py-8">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

                  {/* COL 1: CLASIFICACIÓN */}
                  <div className="space-y-6">
                    <div className="space-y-3">
                      <label className="text-[10px] font-medium text-gray-400 uppercase tracking-widest">1. Clasificación</label>
                      <div className="grid grid-cols-2 gap-2">
                        {CATEGORIES.map(cat => (
                          <button
                            key={cat.id}
                            type="button"
                            tabIndex={0}
                            onClick={() => updateField('category', cat.id)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); updateField('category', cat.id); } }}
                            className={`h-12 px-3 rounded-2xl flex items-center gap-2 border-2 outline-none focus-visible:ring-2 focus-visible:ring-rose-500/50 transition-all ${localExpense.category === cat.id
                                ? `bg-rose-500/10 border-rose-500 text-rose-500 shadow-[0_8px_30px_rgb(0,0,0,0.12)]`
                                : 'bg-gray-50 dark:bg-[#18181b]/30 border-transparent text-gray-400 hover:border-rose-500/20'
                              }`}
                          >
                            <cat.icon size={16} />
                            <span className="text-[9px] font-medium uppercase leading-tight">{cat.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {localExpense.category === 'Proveedores' && (
                      <div className="space-y-3 animate-in fade-in slide-in-from-top-2">
                        <div className="flex justify-between items-center">
                          <label className="text-[10px] font-medium text-gray-400 uppercase tracking-widest">2. Proveedor</label>
                          <Button
                            size="sm"
                            variant="light"
                            className="h-6 text-[9px] font-medium text-sky-500 px-0 min-w-0"
                            onClick={() => setIsSupplierModalOpen(true)}
                          >
                            + NUEVO
                          </Button>
                        </div>
                        <Autocomplete
                          placeholder="BUSCAR..."
                          aria-label="Seleccionar proveedor"
                          items={filteredSuppliers}
                          inputValue={supplierInputValue}
                          onInputChange={(value) => setSupplierInputValue(value)}
                          selectedKey={localExpense.supplierId ? String(localExpense.supplierId) : null}
                          menuTrigger="focus" // Apertura inmediata para móvil
                          onSelectionChange={(key) => {
                            if (!key) {
                              updateField('supplierId', null);
                              return;
                            }
                            const newId = Number(key);
                            updateField('supplierId', newId);
                            const name = suppliers?.find((s: any) => s.id === newId)?.name || '';
                            if (name) setSupplierInputValue(name);
                          }}
                          onKeyDown={(e: any) => {
                            if (e.key === 'Enter') {
                              const search = supplierInputValue.toLowerCase().trim();
                              const match = filteredSuppliers.find(s => s.name.toLowerCase().trim() === search) || filteredSuppliers[0];
                              if (match) {
                                updateField('supplierId', match.id);
                                setSupplierInputValue(match.name);
                              }
                            }
                          }}
                          allowsCustomValue
                          classNames={{ 
                            listbox: "bg-white dark:bg-zinc-950", 
                            popoverContent: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] p-1 rounded-2xl min-w-[280px]" 
                          }}
                          inputProps={{ classNames: { inputWrapper: "h-12 bg-gray-50 dark:bg-[#18181b] border border-gray-200 dark:border-white/5 rounded-2xl shadow-inner", input: "font-bold text-xs uppercase" } }}
                        >
                          {(item) => (
                            <AutocompleteItem key={String(item.id)} textValue={item.name} className="dark:text-white rounded-2xl h-10">
                              <div className="flex items-center gap-2">
                                <Building2 size={14} className="text-sky-500" />
                                <span className="text-[10px] font-medium uppercase">{item.name}</span>
                              </div>
                            </AutocompleteItem>
                          )}
                        </Autocomplete>
                        {pendingOrders.length > 0 && (
                          <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-2xl flex items-center gap-3">
                            <Search size={14} className="text-amber-500" />
                            <p className="text-[9px] font-medium text-amber-600 uppercase">Orden #{selectedOrderId} activa</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* COL 2: FINANCIERO */}
                  <div className="space-y-6">
                    <div className="space-y-3">
                      <label className="text-[10px] font-medium text-gray-400 uppercase tracking-widest">3. Monto</label>
                      <Input
                        placeholder="0"
                        inputMode="decimal"
                        value={localExpense.amount ? formatCurrency(localExpense.amount) : ''}
                        onFocus={(e) => e.target.select()}
                        onValueChange={(v) => updateField('amount', parseCurrency(v))}
                        startContent={<span className="text-xl font-medium text-rose-500">$</span>}
                        classNames={{ inputWrapper: "h-16 bg-rose-50/50 dark:bg-rose-500/5 border border-rose-200 dark:border-rose-500/20 rounded-2xl px-6", input: "font-medium text-2xl text-zinc-900 dark:text-zinc-50 tabular-nums" }}
                      />
                    </div>
                    <div className="space-y-3">
                      <label className="text-[10px] font-medium text-gray-400 uppercase tracking-widest">4. Pago por</label>
                      <div className="grid grid-cols-3 gap-2">
                        {paymentMethods.map(method => (
                          <button
                            key={method.id}
                            onClick={() => updateField('paymentSource', method.id)}
                            className={`relative h-14 rounded-2xl flex flex-col items-center justify-center gap-1 border-2 transition-all ${localExpense.paymentSource === method.id
                                ? (method.id === 'FONDO' 
                                    ? 'bg-cyan-600 border-cyan-600 text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-cyan-600/20' 
                                    : 'bg-[#18181b] dark:bg-white border-zinc-900 dark:border-white text-white dark:text-black shadow-[0_8px_30px_rgb(0,0,0,0.12)]')
                                : 'card-base border-none/30 border-gray-100 dark:border-white/5 text-gray-400 hover:border-gray-200'
                              }`}
                          >
                            <method.icon size={16} />
                            <span className="text-[8px] font-medium uppercase">{method.label}</span>
                            {method.id === 'FONDO' && (
                              <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[5px] font-medium bg-cyan-500 text-white px-1 rounded-2xl whitespace-nowrap">BOVEDA</span>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Campo de Acreedor - DISEÑO DE ALTO IMPACTO (ROJO) */}
                    {localExpense.paymentSource === 'PRESTAMO' && (
                      <div className="mt-4 p-4 bg-rose-500/10 border border-rose-500/30 rounded-2xl animate-in fade-in slide-in-from-top-2 duration-400">
                        <label className="block text-[10px] font-medium text-rose-500 mb-1.5 uppercase tracking-widest px-1">
                          ACREEDOR / QUIÉN PRESTA EL DINERO *
                        </label>
                        <Input
                          placeholder="NOMBRE DEL ACREEDOR..."
                          value={localExpense.lenderName || ''}
                          onFocus={(e) => e.target.select()}
                          onValueChange={(v) => updateField('lenderName', v.toUpperCase())}
                          size="md"
                          isRequired
                          variant="bordered"
                          classNames={{
                            input: "font-medium text-[14px] uppercase placeholder:text-gray-400",
                            inputWrapper: "h-12 bg-white/50 dark:bg-[#18181b] border-rose-500/30 hover:border-rose-500 focus-within:!border-rose-500 transition-all rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)]"
                          }}
                          startContent={<HandCoins size={18} className="text-rose-500 mr-2" />}
                        />
                        <p className="text-[8px] font-medium text-rose-600 dark:text-rose-400 uppercase mt-2 px-1 tracking-tighter flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-2xl bg-rose-500 animate-pulse" />
                          ESTE GASTO SE REGISTRARÁ COMO DEUDA PENDIENTE
                        </p>
                      </div>
                    )}
                  </div>

                  {/* COL 3: CONCEPTO Y RESUMEN */}
                  <div className="space-y-6">
                    <div className="space-y-3">
                      <label className="text-[10px] font-medium text-gray-400 uppercase tracking-widest">5. Concepto</label>
                      <Input
                        placeholder="DETALLES DEL EGRESO..."
                        value={localExpense.description}
                        onFocus={(e) => e.target.select()}
                        onValueChange={(v) => updateField('description', v.toUpperCase())}
                        readOnly={localExpense.category === 'Proveedores'}
                        classNames={{
                          inputWrapper: `h-12 bg-gray-50 dark:bg-[#18181b] border border-gray-200 dark:border-white/5 rounded-2xl px-4 ${localExpense.category === 'Proveedores' ? 'opacity-70 cursor-not-allowed bg-gray-100' : ''}`,
                          input: "font-bold text-[11px] uppercase text-zinc-900 dark:text-zinc-50"
                        }}
                      />
                    </div>
                    <Card className="bg-gray-50 dark:bg-[#18181b] border border-gray-200 dark:border-white/5 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] mt-auto">
                      <CardBody className="p-5 space-y-4">
                        <div className="flex justify-between">
                          <span className="text-[8px] font-medium text-rose-500 uppercase tracking-widest">Resumen Final</span>
                          <span className="text-[8px] font-medium text-gray-400 uppercase">{localExpense.paymentSource}</span>
                        </div>
                        <div className="space-y-1">
                          <p className="text-[8px] font-bold text-gray-400 uppercase">Concepto:</p>
                          <p className="text-[10px] font-medium text-zinc-900 dark:text-zinc-50 uppercase leading-tight line-clamp-2">
                            {localExpense.description || 'REQUERIDO...'}
                          </p>
                        </div>
                        <div className="pt-3 border-t border-gray-200 dark:border-white/5 space-y-2">
                          {localExpense.taxAmount > 0 && (
                            <div className="flex justify-between items-center bg-rose-500/5 p-2 rounded-2xl">
                               <div className="flex flex-col">
                                  <span className="text-[7px] font-medium text-rose-500 uppercase tracking-widest">GMF (4x1000 Nequi)</span>
                                  <span className="text-[10px] font-medium text-rose-500 tracking-tight">+${formatCurrency(localExpense.taxAmount)}</span>
                               </div>
                               <Zap size={12} className="text-rose-500" />
                            </div>
                          )}
                          <p className="text-[8px] font-bold text-gray-400 uppercase">Valor Total a Descontar:</p>
                          <p className="text-2xl font-medium text-rose-500 tabular-nums">${formatCurrency(Number(localExpense.amount || 0) + localExpense.taxAmount)}</p>
                        </div>
                      </CardBody>
                    </Card>
                  </div>
                </div>
              </ModalBody>

              <ModalFooter className="px-8 py-6 border-t border-gray-100 dark:border-white/5 bg-gray-50/30 dark:bg-[#18181b]/50">
                <div className="flex w-full gap-4">
                  <Button variant="flat" className="flex-1 h-12 rounded-2xl font-medium uppercase text-[10px] tracking-widest border border-gray-200 dark:border-white/5" onPress={onClose}>
                    DESCARTAR
                  </Button>
                  <Button
                    className="flex-[2] h-12 bg-rose-500 text-white font-medium uppercase text-xs tracking-[0.2em] rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:scale-[1.02] active:scale-95 transition-all"
                    isLoading={isSubmitting}
                    isDisabled={isSubmitting}
                    onPress={async () => {
                      if (isSubmitting) return;

                      const result = validateExpense({
                        description: localExpense.description,
                        amount: localExpense.amount,
                        category: localExpense.category,
                        paymentSource: localExpense.paymentSource,
                        lenderName: localExpense.lenderName,
                      });
                      if (!result.isValid) {
                        setValidationErrors(result.errors);
                        toast({ title: "Validación Fallida", description: "Campos incompletos", variant: "destructive" });
                        return;
                      }
                      setValidationErrors([]);

                      // Validar Prestamista si es Préstamo
                      if (localExpense.paymentSource === 'PRESTAMO' && !localExpense.lenderName?.trim()) {
                        toast({ variant: 'destructive', title: 'DATOS FALTANTES', description: 'EL NOMBRE DEL PRESTAMISTA ES OBLIGATORIO' });
                        return;
                      }

                      setIsSubmitting(true);
                      try {
                        const payload = {
                          ...localExpense,
                          linkedOrderId: selectedOrderId,
                          status: localExpense.paymentSource === 'PRESTAMO' ? 'PENDING' : 'PAID'
                        };
                        await onSave(payload);
                      } catch (error) {
                        console.error("Error al guardar egreso:", error);
                        setIsSubmitting(false);
                      }
                    }}
                  >
                    <Sparkles size={18} className="mr-2" />
                    {isSubmitting ? "PROCESANDO..." : (isEdit ? "GUARDAR CAMBIOS" : "AUTORIZAR PAGO")}
                  </Button>
                </div>
                {validationErrors.length > 0 && <div className="w-full mt-4"><ValidationErrors errors={validationErrors} /></div>}
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      <SupplierFormModal
        isOpen={isSupplierModalOpen}
        onOpenChange={setIsSupplierModalOpen}
        onSave={handleSaveSupplier}
        isEdit={false}
      />
    </>
  );
});

ExpenseFormModal.displayName = 'ExpenseFormModal';
export default ExpenseFormModal;



