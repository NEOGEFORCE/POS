import React, { memo, useState, useEffect } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, Input, Autocomplete, AutocompleteItem, Card, CardBody, Switch, cn
} from "@heroui/react";
import {
  TrendingDown, Wallet, Zap, Building2, HandCoins, Sparkles,
  FileText, CreditCard, Layers, UserPlus, Search, Landmark, Briefcase, Plus, X, ArrowRight
} from 'lucide-react';
import { Expense, Supplier } from '@/lib/definitions';
import { useApi } from '@/hooks/use-api';
import { ExpensePaymentModal } from './ExpensePaymentModal';
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
  cashAmount: number;
  nequiAmount: number;
  daviplataAmount: number;
  fondoAmount: number;
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
  { id: 'Servicios Publicos', label: 'Servicios Publicos', icon: Zap, color: 'amber' },
  { id: 'Nomina', label: 'Nomina', icon: Briefcase, color: 'emerald' },
  { id: 'Danos / Arreglos', label: 'Danos / Arreglos', icon: Layers, color: 'rose' },
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

  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);

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
    const defaultMixed = {
      cashAmount: 0,
      nequiAmount: 0,
      daviplataAmount: 0,
      fondoAmount: 0
    };

    if (isOpen && initialExpense) {
      setLocalExpense({
        ...initialExpense,
        ...defaultMixed,
        description: initialExpense.description || '',
        amount: initialExpense.amount || '',
        paymentSource: initialExpense.paymentSource || 'EFECTIVO',
        category: initialExpense.category || 'Otros Gastos',
        supplierId: initialExpense.supplierId || null,
        lenderName: initialExpense.lenderName || '',
        status: initialExpense.status || 'PAID',
        isManualDescription: true,
        taxAmount: initialExpense.taxAmount || 0,
        cashAmount: (initialExpense as any).cashAmount || 0,
        nequiAmount: (initialExpense as any).nequiAmount || 0,
        daviplataAmount: (initialExpense as any).daviplataAmount || 0,
        fondoAmount: (initialExpense as any).fondoAmount || 0
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
      });
      setSupplierInputValue('');
    }
    // Resetear estado de envio al abrir/cerrar
    setIsSubmitting(false);
    setIsPaymentModalOpen(false);
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
    
    // Prioridad 2: Contiene el nombre pero no empieza con el
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

  // Logica de Autocompletado y Bloqueo
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
    } else if (localExpense.category === 'Nomina') {
      if (!localExpense.isManualDescription) {
        setLocalExpense((prev: LocalExpenseState) => ({
          ...prev,
          description: 'PAGO DE NOMINA',
        }));
      }
    } else {
      // Si no es proveedores o nomina y no ha sido editado manualmente, vaciar para que el usuario escriba
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
      // SMART AUTOFILL: Si es prestamo de proveedor, sugerir el nombre del proveedor como acreedor
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

  // CALCULO AUTOMATICO 4x1000 PARA NEQUI (Se maneja despues en el backend o en modal de pagos para Mixtos, aqui desactivado temporal)
  useEffect(() => {
    /* let nequiBase = 0;
    if (addedPayments.length > 0) { ... } */
  }, []);

  const handleSaveSupplier = async (supplierData: Partial<Supplier>) => {
    const token = Cookies.get('org-pos-token');
    try {
      const newSupplier = await apiFetch('/suppliers/create-suppliers', {
        method: 'POST',
        body: JSON.stringify(supplierData),
        fallbackError: 'ERROR AL CREAR PROVEEDOR'
      }, token);

      await mutateSuppliers();

      // El backend de Go usa 'id' (minuscula) por el tag json, pero verificamos ambos
      const supplierId = newSupplier?.id || newSupplier?.ID;
      const supplierName = newSupplier?.name || supplierData.name || '';

      if (supplierId) {
        // Actualizamos ID y Concepto de una vez para que no quede vacio
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
        toast({ title: 'EXITO', description: 'PROVEEDOR CREADO Y SELECCIONADO' });
      } else {
        console.error('El backend no devolvio ID:', newSupplier);
        throw new Error('EL SERVIDOR NO DEVOLVIO EL ID DEL PROVEEDOR');
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
    { id: 'EFECTIVO', label: 'Pago Inmediato', icon: Wallet },
    { id: 'PRESTAMO', label: 'Deuda', icon: HandCoins }
  ];

  // Helper para procesar prestamo directo
  async function handleProcessDebt() {
      setIsSubmitting(true);
      try {
        const payload = {
            ...localExpense,
            paymentSource: 'PRESTAMO',
            amount: Number(localExpense.amount) || 0,
            taxAmount: 0,
            linkedOrderId: selectedOrderId,
            status: 'PENDING',
            cashAmount: 0,
            nequiAmount: 0,
            daviplataAmount: 0,
            fondoAmount: 0
        };
        await onSave(payload);
      } catch (error) {
        console.error("Error:", error);
        setIsSubmitting(false);
      }
  }

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

                  {/* COL 1: CLASIFICACION */}
                  <div className="space-y-6">
                    <div className="space-y-3">
                      <label className="text-[10px] font-medium text-gray-400 uppercase tracking-widest">1. Clasificacion</label>
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
                          menuTrigger="focus" // Apertura inmediata para movil
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
                      />
                    </div>
                    <div className="space-y-3">
                      <div className="flex justify-between items-center">
                        <label className="text-[10px] font-medium text-gray-400 uppercase tracking-widest">4. Tipo de Egreso</label>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        {paymentMethods.map(method => (
                          <button
                            key={method.id}
                            onClick={() => {
                               updateField('paymentSource', method.id);
                            }}
                            className={`relative h-14 rounded-2xl flex items-center justify-center gap-2 border-2 transition-all ${localExpense.paymentSource === method.id
                                ? 'bg-[#18181b] dark:bg-white border-zinc-900 dark:border-white text-white dark:text-black shadow-[0_8px_30px_rgb(0,0,0,0.12)]'
                                : 'card-base border-none/30 border-gray-100 dark:border-white/5 text-gray-400 hover:border-gray-200'
                              }`}
                          >
                            <method.icon size={18} />
                            <span className="text-[10px] font-medium uppercase tracking-widest">{method.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Campo de Acreedor - DISEÑO DE ALTO IMPACTO (ROJO) */}
                    {localExpense.paymentSource === 'PRESTAMO' && (
                      <div className="mt-4 p-4 bg-rose-500/10 border border-rose-500/30 rounded-2xl animate-in fade-in slide-in-from-top-2 duration-400">
                        <label className="block text-[10px] font-medium text-rose-500 mb-1.5 uppercase tracking-widest px-1">
                          ACREEDOR / QUIEN PRESTA EL DINERO *
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
                          ESTE GASTO SE REGISTRARA COMO DEUDA PENDIENTE
                        </p>
                      </div>
                    )}
                    
                    <div className="mt-8 flex gap-3">
                      <Button
                        className={`flex-1 h-14 ${isSubmitting ? 'bg-rose-400' : 'bg-rose-500 hover:bg-rose-600'} text-white font-medium uppercase tracking-[0.2em] rounded-2xl transition-all shadow-[0_8px_30px_rgb(244,63,94,0.3)] hover:shadow-[0_8px_30px_rgb(244,63,94,0.5)]`}
                        onPress={() => {
                          if (!localExpense.description?.trim()) {
                            toast({ variant: 'destructive', title: 'DATOS FALTANTES', description: 'LA DESCRIPCION ES OBLIGATORIA' });
                            return;
                          }
                          const baseAmount = Number(localExpense.amount) || 0;
                          if (baseAmount <= 0) {
                            toast({ variant: 'destructive', title: 'MONTO INVALIDO', description: 'EL MONTO DEBE SER MAYOR A CERO' });
                            return;
                          }

                          if (localExpense.paymentSource === 'PRESTAMO' && !localExpense.lenderName?.trim()) {
                            toast({ variant: 'destructive', title: 'DATOS FALTANTES', description: 'EL NOMBRE DEL PRESTAMISTA ES OBLIGATORIO' });
                            return;
                          }

                          if (localExpense.paymentSource === 'PRESTAMO') {
                              // Submit directamente como deuda
                              handleProcessDebt();
                          } else {
                              // Abrir Modal Multi-Pago
                              setIsPaymentModalOpen(true);
                          }
                        }}
                        isLoading={isSubmitting}
                      >
                        {localExpense.paymentSource === 'PRESTAMO' ? 'CREAR DEUDA' : 'PROCEDER AL PAGO'}
                        {!isSubmitting && <ArrowRight size={18} className="ml-2" />}
                      </Button>
                    </div>
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
                          <p className="text-[8px] font-bold text-gray-400 uppercase">Valor Total a Descontar:</p>
                          <p className="text-2xl font-medium text-rose-500 tabular-nums">${formatCurrency(Number(localExpense.amount || 0))}</p>
                        </div>
                      </CardBody>
                    </Card>
                  </div>
                </div>
              </ModalBody>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* Modal Multi-Pago de Egresos */}
      <ExpensePaymentModal 
        isOpen={isPaymentModalOpen}
        onOpenChange={setIsPaymentModalOpen}
        totalToPay={Number(localExpense.amount) || 0}
        onPay={async (data) => {
            // Este onPay se llama desde el Modal Multi-Pago cuando autorizan el dinero
            const baseAmount = Number(localExpense.amount) || 0;
            const payload = {
                ...localExpense,
                paymentSource: data.paymentSourceString,
                cashAmount: data.cash,
                nequiAmount: data.nequi,
                daviplataAmount: data.daviplata,
                fondoAmount: data.fondo,
                amount: baseAmount,
                taxAmount: data.taxAmount || 0,
                linkedOrderId: selectedOrderId,
                status: 'PAID'
            };
            await onSave(payload);
        }}
      />

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



