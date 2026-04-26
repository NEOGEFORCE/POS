import React, { memo, useState, useEffect } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, Input, Select, SelectItem, Autocomplete, AutocompleteItem, Card, CardBody
} from "@heroui/react";
import { 
  TrendingDown, Wallet, Zap, Building2, HandCoins, Sparkles, X, 
  FileText, CreditCard, Layers, UserPlus, Search 
} from 'lucide-react';
import { Expense, Supplier } from '@/lib/definitions';
import { useApi } from '@/hooks/use-api';
import { formatCurrency, parseCurrency } from '@/lib/utils';
import { validateExpense, FieldError } from '@/lib/formValidation';
import ValidationErrors from '@/components/ValidationErrors';
import Cookies from 'js-cookie';
import { useToast } from '@/hooks/use-toast';

interface ExpenseFormModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  isEdit?: boolean;
  initialExpense: Partial<Expense> | null;
  onSave: (data: any) => Promise<void>;
}

// Interfaz local para órdenes de compra pendientes
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
  { id: 'Daños / Arreglos', label: 'Daños / Arreglos', icon: Layers, color: 'rose' },
  { id: 'Otros Gastos', label: 'Otros Gastos', icon: HandCoins, color: 'gray' }
];

const ExpenseFormModal = memo(({
  isOpen,
  onOpenChange,
  isEdit = false,
  initialExpense,
  onSave
}: ExpenseFormModalProps) => {
  const { data: suppliers } = useApi<Supplier[]>('/suppliers/all-suppliers');
  const [isCreatingSupplier, setIsCreatingSupplier] = useState(false);
  const [validationErrors, setValidationErrors] = useState<FieldError[]>([]);
  const [pendingOrders, setPendingOrders] = useState<PurchaseOrder[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [isLoadingOrders, setIsLoadingOrders] = useState(false);
  const { toast } = useToast();

  // ESTADO LOCAL PARA ZERO LAG
  const [localExpense, setLocalExpense] = useState<any>({
    description: '',
    amount: '',
    paymentSource: 'EFECTIVO',
    category: 'Otros Gastos',
    supplierId: null,
    newSupplierName: ''
  });

  useEffect(() => {
    if (isOpen && initialExpense) {
      setLocalExpense({
        ...initialExpense,
        description: initialExpense.description || '',
        amount: initialExpense.amount || '',
        paymentSource: initialExpense.paymentSource || 'EFECTIVO',
        category: initialExpense.category || 'Otros Gastos',
        supplierId: initialExpense.supplierId || null,
        newSupplierName: ''
      });
      setIsCreatingSupplier(false);
    } else if (isOpen) {
      setLocalExpense({
        description: '',
        amount: '',
        paymentSource: 'EFECTIVO',
        category: 'Otros Gastos',
        supplierId: null,
        newSupplierName: ''
      });
      setIsCreatingSupplier(false);
    }
  }, [isOpen, initialExpense]);

  const updateField = (field: string, value: any) => {
    setLocalExpense((prev: any) => ({ ...prev, [field]: value }));
  };

  // Detectar pedidos pendientes cuando se selecciona un proveedor
  useEffect(() => {
    const fetchPendingOrders = async () => {
      if (localExpense.category === 'Proveedores' && localExpense.supplierId) {
        setIsLoadingOrders(true);
        try {
          const token = Cookies.get('org-pos-token');
          const response = await fetch(
            `${process.env.NEXT_PUBLIC_API_URL}/orders?supplier_id=${localExpense.supplierId}`,
            {
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              }
            }
          );
          if (response.ok) {
            const orders = await response.json();
            setPendingOrders(orders || []);
            // Auto-seleccionar la primera orden si hay alguna
            if (orders && orders.length > 0) {
              setSelectedOrderId(orders[0].id);
            } else {
              setSelectedOrderId(null);
            }
          }
        } catch (error) {
          console.error('Error fetching pending orders:', error);
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

  if (!isOpen) return null;

  const paymentMethods = [
    { id: 'EFECTIVO', label: 'Caja', icon: Wallet, color: 'emerald' },
    { id: 'FONDO', label: 'Fondo', icon: Building2, color: 'sky' },
    { id: 'NEQUI', label: 'Nequi', icon: Zap, color: 'pink' },
    { id: 'DAVIPLATA', label: 'Davi', icon: Zap, color: 'rose' },
    { id: 'PRESTADO', label: 'Prest.', icon: HandCoins, color: 'amber' }
  ];

  return (
    <Modal 
      isOpen={isOpen} 
      onOpenChange={onOpenChange} 
      backdrop="blur" 
      size="2xl" 
      scrollBehavior="inside"
      classNames={{ 
        base: "bg-white dark:bg-zinc-950 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-2xl overflow-visible mx-2 md:mx-0", 
        wrapper: "items-start sm:items-center mt-12 sm:mt-0 justify-center",
        closeButton: "absolute right-5 top-5 text-gray-400 dark:text-zinc-500 hover:text-rose-500 transition-colors z-[100] rounded-full",
        backdrop: "bg-black/50 backdrop-blur-md"
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex flex-col gap-1 px-5 md:px-12 py-3 md:py-4 border-b border-gray-100 dark:border-white/5 bg-white/5 dark:bg-zinc-900/50 backdrop-blur-md rounded-t-2xl md:rounded-t-[2rem]">
              <div className="flex items-center gap-3 md:gap-6">
                <div className="h-8 w-8 md:h-16 md:w-16 bg-rose-50 dark:bg-rose-500/10 text-rose-500 flex items-center justify-center rounded-lg md:rounded-2xl shadow-inner -rotate-3 border border-rose-500/20">
                  <TrendingDown size={16} className="md:size-8" />
                </div>
                <div className="flex flex-col min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse hidden md:block" />
                    <h2 className="text-lg md:text-3xl font-black text-gray-900 dark:text-white italic tracking-tighter uppercase leading-none">
                      {isEdit ? "Modificar" : "Registrar"} <span className="text-rose-500">Egreso</span>
                    </h2>
                  </div>
                  <span className="text-[7px] md:text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest mt-1 md:mt-2 not-italic opacity-80">Infraestructura de Registros Maestro</span>
                </div>
              </div>
            </ModalHeader>

            <ModalBody className="px-5 md:px-12 py-3 md:py-6 gap-2 md:gap-4 pb-4 sm:pb-4">
              {/* Categoría del Gasto */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 ml-1">
                  <Layers size={14} className="text-rose-500" />
                  <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic mb-1">Tipo de Gasto / Clasificación</label>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
                  {CATEGORIES.map(cat => (
                    <button
                      key={cat.id}
                      onClick={() => updateField('category', cat.id)}
                      className={`relative py-4 md:py-6 px-3 rounded-xl md:rounded-2xl flex flex-col items-center justify-center gap-2 md:gap-3 border-2 transition-all duration-300 ${
                        localExpense.category === cat.id 
                          ? `bg-rose-500/5 border-rose-500 text-rose-500 shadow-[0_0_20px_rgba(244,63,94,0.15)] scale-[1.05] z-10` 
                          : 'bg-gray-50/50 dark:bg-zinc-900/50 border-transparent text-gray-400 hover:bg-gray-100 dark:hover:bg-zinc-800'
                      }`}
                    >
                      <cat.icon size={20} className={`md:size-6 ${localExpense.category === cat.id ? 'animate-bounce' : ''}`} />
                      <span className="text-[9px] md:text-[10px] font-black uppercase tracking-wider text-center leading-tight italic">{cat.label}</span>
                      {localExpense.category === cat.id && (
                        <div className="absolute top-2 right-2 h-1.5 w-1.5 md:h-2 md:w-2 bg-rose-500 rounded-full shadow-lg" />
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Si es Proveedor, mostrar selector */}
              {localExpense.category === 'Proveedores' && (
                <div className="space-y-4 animate-in fade-in slide-in-from-top-4 duration-500">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 ml-1">
                    <div className="flex items-center gap-2">
                      <Search size={14} className="text-sky-500" />
                      <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic mb-1">Vincular Proveedor de Servicios</label>
                    </div>
                    <Button 
                      size="sm" 
                      variant="flat" 
                      className="h-8 md:h-10 text-[9px] md:text-[10px] font-black uppercase italic text-sky-500 bg-sky-500/10 rounded-lg md:rounded-xl px-4 md:px-5 border border-sky-500/20 w-fit"
                      onClick={() => setIsCreatingSupplier(!isCreatingSupplier)}
                    >
                      {isCreatingSupplier ? "VOLVER AL LISTADO" : "+ NUEVO PROVEEDOR"}
                    </Button>
                  </div>
                  
                  {isCreatingSupplier ? (
                    <Input
                      placeholder="NOMBRE DEL PROVEEDOR"
                      value={localExpense.newSupplierName}
                      onValueChange={(v) => {
                        const val = v.toUpperCase();
                        setLocalExpense((prev: any) => ({
                          ...prev,
                          newSupplierName: val,
                          description: `PAGO PROVEEDOR: ${val}`
                        }));
                      }}
                      classNames={{ 
                        inputWrapper: "h-14 md:h-20 bg-sky-50 dark:bg-sky-500/5 border border-sky-200 dark:border-sky-500/20 rounded-2xl md:rounded-3xl focus-within:!border-sky-500 shadow-inner transition-all", 
                        input: "font-black text-base md:text-lg uppercase italic text-gray-900 dark:text-white" 
                      }}
                      startContent={<UserPlus size={20} className="text-sky-500 mr-2 md:mr-3" />}
                    />
                  ) : (
                    <Autocomplete
                      placeholder="BUSCAR EN BASE DE DATOS..."
                      aria-label="Buscar proveedor"
                      defaultItems={suppliers || []}
                      selectedKey={localExpense.supplierId?.toString()}
                      onSelectionChange={(key) => {
                        const sup = suppliers?.find((s: any) => s.id.toString() === key?.toString());
                        setLocalExpense((prev: any) => ({
                          ...prev,
                          supplierId: key ? Number(key) : null,
                          description: sup ? `PAGO PROVEEDOR: ${sup.name}` : prev.description,
                          newSupplierName: ''
                        }));
                      }}
                      classNames={{ 
                        base: "max-w-full",
                        listbox: "bg-white dark:bg-zinc-950 rounded-2xl md:rounded-[2rem] p-2 md:p-4",
                        popoverContent: "bg-white dark:bg-zinc-950 rounded-2xl md:rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-2xl"
                      }}
                      inputProps={{
                        classNames: {
                          inputWrapper: "h-14 md:h-20 bg-gray-50 dark:bg-zinc-900/50 border border-gray-200 dark:border-white/10 rounded-2xl md:rounded-3xl focus-within:!border-sky-500 transition-all shadow-inner",
                          input: "font-black text-base md:text-lg uppercase italic text-gray-900 dark:text-white"
                        }
                      }}
                    >
                      {(item) => (
                        <AutocompleteItem 
                          key={item.id} 
                          textValue={item.name}
                          className="rounded-xl md:rounded-2xl h-14 md:h-16"
                        >
                          <div className="flex flex-col gap-0.5 md:p-1">
                            <span className="text-xs md:text-sm font-black uppercase italic text-gray-900 dark:text-white">{item.name}</span>
                            <div className="flex items-center gap-1.5 md:gap-2">
                              <span className="h-1.5 w-1.5 md:h-2 md:w-2 rounded-full bg-emerald-500" />
                              <span className="text-[9px] md:text-[10px] font-bold text-gray-400 tracking-widest uppercase italic">{item.phone || 'Sin contacto registrado'}</span>
                            </div>
                          </div>
                        </AutocompleteItem>
                      )}
                    </Autocomplete>
                  )}

                  {/* Notificación de pedidos pendientes - Card integrado con borde ámbar */}
                  {isLoadingOrders ? (
                    <Card className="bg-sky-500/5 border border-sky-200/50 rounded-xl shadow-sm">
                      <CardBody className="py-3 px-4">
                        <div className="flex items-center gap-2 text-sky-600 dark:text-sky-400 text-[10px] font-black uppercase italic">
                          <div className="w-4 h-4 border-2 border-sky-400/30 border-t-sky-500 rounded-full animate-spin" />
                          Verificando pedidos pendientes...
                        </div>
                      </CardBody>
                    </Card>
                  ) : pendingOrders.length > 0 ? (
                    <Card className="bg-white dark:bg-zinc-900 border-2 border-amber-400/40 rounded-xl shadow-sm overflow-hidden">
                      <CardBody className="p-4 space-y-3">
                        <div className="flex items-start gap-3">
                          <div className="h-10 w-10 rounded-xl bg-amber-100 dark:bg-amber-500/10 text-amber-600 flex items-center justify-center border border-amber-200 dark:border-amber-500/20 shrink-0">
                            <Building2 size={20} />
                          </div>
                          <div className="flex-1">
                            <p className="text-[11px] font-black text-amber-700 dark:text-amber-500 uppercase italic leading-relaxed">
                              Pedido pendiente detectado
                            </p>
                            <p className="text-[9px] text-gray-500 mt-1">
                              ¿Deseas registrar la llegada de mercancía con este pago?
                            </p>
                          </div>
                        </div>
                        <div className="space-y-2">
                          {pendingOrders.map((order) => (
                            <label
                              key={order.id}
                              className={`flex items-center gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${
                                selectedOrderId === order.id
                                  ? 'bg-emerald-50/50 dark:bg-emerald-500/10 border-emerald-400 shadow-sm'
                                  : 'bg-gray-50/50 dark:bg-zinc-800/50 border-gray-200 dark:border-zinc-700 hover:border-amber-300'
                              }`}
                            >
                              <input
                                type="radio"
                                name="pendingOrder"
                                checked={selectedOrderId === order.id}
                                onChange={() => setSelectedOrderId(order.id)}
                                className="w-4 h-4 text-emerald-500 focus:ring-emerald-500"
                              />
                              <div className="flex-1">
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] font-black uppercase italic text-gray-900 dark:text-white">
                                    Pedido #{order.id}
                                  </span>
                                  <span className="text-[8px] font-black text-amber-600 bg-amber-100 dark:bg-amber-500/20 px-2 py-1 rounded-full">
                                    {order.items?.length || 0} PRODUCTOS
                                  </span>
                                </div>
                                <div className="text-[9px] text-gray-500 mt-1">
                                  {order.items?.map((item, idx) => (
                                    <span key={item.productBarcode}>
                                      {item.productName}
                                      {idx < (order.items?.length || 0) - 1 ? ', ' : ''}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            </label>
                          ))}
                        </div>
                        <div className="flex items-center gap-2 pt-2 border-t border-amber-200/50">
                          <input
                            type="checkbox"
                            id="linkOrder"
                            checked={selectedOrderId !== null}
                            onChange={(e) => !e.target.checked && setSelectedOrderId(null)}
                            className="w-4 h-4 rounded border-gray-300 text-emerald-500 focus:ring-emerald-500"
                          />
                          <label htmlFor="linkOrder" className="text-[10px] font-black text-gray-700 dark:text-gray-300 uppercase italic cursor-pointer">
                            Confirmar recepción de stock con este pago
                          </label>
                        </div>
                      </CardBody>
                    </Card>
                  ) : localExpense.supplierId ? (
                    <Card className="bg-emerald-50 dark:bg-emerald-500/5 border border-emerald-200/50 rounded-xl shadow-sm">
                      <CardBody className="py-3 px-4">
                        <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 text-[10px] font-black uppercase italic">
                          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                          No hay pedidos pendientes para este proveedor
                        </div>
                      </CardBody>
                    </Card>
                  ) : null}
                </div>
              )}

              {/* Concepto y Cuantía */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-10">
                <div className="space-y-4">
                  <div className="flex items-center gap-2 ml-1">
                    <FileText size={14} className="text-rose-500" />
                    <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic mb-1">Descripción del Egreso</label>
                  </div>
                  <Input
                    placeholder="E.G. PAGO DE ARRIENDO LOCAL..."
                    value={localExpense.description}
                    onValueChange={(v) => updateField('description', v.toUpperCase())}
                    onFocus={(e) => setTimeout(() => e.target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300)}
                    classNames={{ 
                      inputWrapper: "h-13 md:h-18 bg-gray-50 dark:bg-zinc-900/50 border border-gray-200 dark:border-white/10 rounded-xl md:rounded-2xl focus-within:!border-rose-500 shadow-inner transition-all", 
                      input: "font-black text-sm md:text-base uppercase italic text-gray-900 dark:text-white bg-transparent" 
                    }}
                  />
                </div>

                <div className="space-y-4">
                  <div className="flex items-center gap-2 ml-1">
                    <Sparkles size={14} className="text-rose-500" />
                    <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic mb-1">Monto de Operación</label>
                  </div>
                  <Input
                    placeholder="0"
                    value={localExpense.amount ? formatCurrency(localExpense.amount) : ''}
                    onValueChange={(v) => updateField('amount', parseCurrency(v))}
                    onFocus={(e) => setTimeout(() => e.target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300)}
                    startContent={<span className="text-xl md:text-2xl font-black italic text-rose-500 select-none mr-2 md:mr-3">$</span>}
                    classNames={{ 
                      inputWrapper: "h-13 md:h-18 bg-rose-50/30 dark:bg-rose-500/5 border border-rose-200 dark:border-rose-500/20 rounded-xl md:rounded-2xl focus-within:!border-rose-500 shadow-inner transition-all px-4 md:px-8", 
                      input: "font-black text-xl md:text-3xl uppercase italic text-gray-900 dark:text-white bg-transparent tabular-nums placeholder:text-gray-200 dark:placeholder:text-zinc-800" 
                    }}
                  />

                </div>
              </div>

              {/* Canal de Salida */}
              <div className="space-y-4 md:space-y-6 pt-2">
                <div className="flex flex-col items-center gap-2">
                  <div className="flex items-center gap-2">
                    <CreditCard size={14} className="text-rose-500" />
                    <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.3em] not-italic">Canal de Salida de Capital</label>
                  </div>
                  <div className="h-px w-20 bg-gradient-to-r from-transparent via-rose-500 to-transparent opacity-20" />
                  <div className="grid grid-cols-3 md:grid-cols-5 gap-3 md:gap-4 font-black">
                    {paymentMethods.map(method => (
                      <button
                        key={method.id}
                        onClick={() => updateField('paymentSource', method.id)}
                        className={`h-16 md:h-20 rounded-xl md:rounded-2xl flex flex-col items-center justify-center gap-1 md:gap-2 border-2 transition-all group relative overflow-hidden ${
                          localExpense.paymentSource === method.id 
                            ? `bg-rose-500 border-rose-400 text-white shadow-xl shadow-rose-500/20 scale-105 z-10 font-black` 
                            : 'bg-white dark:bg-zinc-900/50 border-gray-100 dark:border-white/5 text-gray-400 hover:bg-gray-50 dark:hover:bg-zinc-800 hover:border-gray-200 dark:hover:border-white/10 italic'
                        }`}
                      >
                        <method.icon size={18} className={`md:size-[22px] ${localExpense.paymentSource === method.id ? 'scale-110' : ''} transition-transform duration-500`} />
                        <span className="text-[8px] md:text-[9px] font-black uppercase tracking-widest italic">{method.label}</span>
                        {localExpense.paymentSource === method.id && (
                          <div className="absolute top-1 right-1 h-1 md:h-1.5 w-1 md:w-1.5 bg-white rounded-full" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Prestamista (Condicional) */}
                {localExpense.paymentSource === 'PRESTADO' && (
                  <div className="space-y-4 animate-in fade-in slide-in-from-top-4 duration-500 pt-2 pb-2">
                    <div className="flex items-center gap-2 ml-1">
                      <HandCoins size={14} className="text-amber-500" />
                      <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic mb-1">¿Quién realiza el préstamo?</label>
                    </div>
                    <Input
                      placeholder="ESCRIBIR NOMBRE DEL SOCIO / PRESTAMISTA"
                      value={localExpense.lenderName || ''}
                      onValueChange={(val) => {
                        updateField('lenderName', val.toUpperCase());
                      }}
                      classNames={{
                        inputWrapper: "h-14 md:h-18 bg-amber-50/50 dark:bg-amber-500/5 border border-amber-200 dark:border-amber-500/20 rounded-xl md:rounded-2xl focus-within:!border-amber-500 transition-all shadow-inner",
                        input: "font-black text-sm md:text-base uppercase italic text-gray-900 dark:text-white"
                      }}
                    />
                  </div>
                )}
              </div>

            </ModalBody>

            <ModalFooter className="px-5 md:px-12 py-3 md:py-4 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-b-2xl md:rounded-b-[2.5rem]">
              <div className="flex w-full gap-3 md:gap-6">
                <Button
                  variant="flat"
                  className="flex-1 h-11 md:h-14 rounded-xl md:rounded-3xl font-black uppercase text-[9px] md:text-[10px] bg-white dark:bg-zinc-900 text-gray-400 dark:text-zinc-500 border border-gray-200 dark:border-white/10 italic tracking-widest hover:bg-rose-500/10 hover:text-rose-500 transition-all opacity-70 hover:opacity-100"
                  onPress={onClose}
                >
                  CANCELAR
                </Button>
                {validationErrors.length > 0 && (
                  <div className="w-full md:col-span-2 mb-2">
                    <ValidationErrors errors={validationErrors} />
                  </div>
                )}
                <Button
                  className="flex-[2] h-11 md:h-14 bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase text-[10px] md:text-sm tracking-widest md:tracking-[0.3em] rounded-xl md:rounded-3xl transition-all shadow-xl hover:scale-[1.02] active:scale-95 italic group"
                  onPress={() => {
                    const result = validateExpense({
                      description: localExpense.description,
                      amount: localExpense.amount,
                      category: localExpense.category,
                      paymentSource: localExpense.paymentSource,
                      lenderName: localExpense.lenderName,
                    });
                    if (!result.isValid) {
                      setValidationErrors(result.errors);
                      return;
                    }
                    setValidationErrors([]);
                    // Incluir el orderId si hay un pedido seleccionado
                    const expenseData = {
                      ...localExpense,
                      linkedOrderId: selectedOrderId,
                    };
                    onSave(expenseData);
                  }}
                >
                  <Sparkles size={16} className="md:size-6 mr-2 md:mr-3 group-hover:rotate-12 transition-transform" />
                  {isEdit ? "GUARDAR" : "AUTORIZAR PAGO"}
                </Button>
              </div>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
});

ExpenseFormModal.displayName = 'ExpenseFormModal';
export default ExpenseFormModal;
