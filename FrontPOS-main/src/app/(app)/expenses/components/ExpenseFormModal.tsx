import React, { memo, useState, useEffect } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, Input, Select, SelectItem, Autocomplete, AutocompleteItem
} from "@heroui/react";
import { 
  TrendingDown, Wallet, Zap, Building2, HandCoins, Sparkles, X, 
  FileText, CreditCard, Layers, UserPlus, Search 
} from 'lucide-react';
import { Expense, Supplier } from '@/lib/definitions';
import { useApi } from '@/hooks/use-api';

interface ExpenseFormModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  isEdit?: boolean;
  expense: Partial<Expense> | null;
  setExpense: (expense: any) => void;
  onSave: () => Promise<void>;
}

const CATEGORIES = [
  { id: 'Proveedores', label: 'Proveedores', icon: Building2, color: 'sky' },
  { id: 'Servicios Públicos', label: 'Servicios Públicos', icon: Zap, color: 'amber' },
  { id: 'Daños y Arreglos', label: 'Daños / Arreglos', icon: Layers, color: 'rose' },
  { id: 'Otros', label: 'Otros Gastos', icon: HandCoins, color: 'gray' }
];

const ExpenseFormModal = memo(({
  isOpen,
  onOpenChange,
  isEdit = false,
  expense,
  setExpense,
  onSave
}: ExpenseFormModalProps) => {
  const { data: suppliers } = useApi<Supplier[]>('/suppliers');
  const [isCreatingSupplier, setIsCreatingSupplier] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState('');

  if (!expense && !isOpen) return null;

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
      size="lg" 
      classNames={{ 
        base: "bg-white dark:bg-zinc-950 rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-2xl overflow-visible", 
        closeButton: "text-gray-400 dark:text-zinc-500 hover:text-rose-500 transition-colors z-50 rounded-full" 
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex flex-col gap-1 p-10 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-t-[2.5rem]">
              <div className="flex items-center gap-6">
                <div className="h-16 w-16 bg-rose-50 dark:bg-rose-500/10 text-rose-500 flex items-center justify-center rounded-2xl shadow-inner -rotate-3 border border-rose-500/20">
                  <TrendingDown size={32} />
                </div>
                <div className="flex flex-col min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" />
                    <h2 className="text-3xl font-black text-gray-900 dark:text-white italic tracking-tighter uppercase leading-none">
                      {isEdit ? "Modificar" : "Registrar"} <span className="text-rose-500">Egreso</span>
                    </h2>
                  </div>
                  <span className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest mt-2 not-italic">Infraestructura de Registros Maestro</span>
                </div>
              </div>
            </ModalHeader>

            <ModalBody className="p-10 gap-10">
              {/* Categoría del Gasto */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 ml-1">
                  <Layers size={14} className="text-rose-500" />
                  <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic mb-1">Tipo de Gasto / Clasificación</label>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {CATEGORIES.map(cat => (
                    <button
                      key={cat.id}
                      onClick={() => setExpense((p: any) => ({ ...p, category: cat.id }))}
                      className={`relative py-6 px-3 rounded-2xl flex flex-col items-center justify-center gap-3 border-2 transition-all duration-300 ${
                        expense?.category === cat.id 
                          ? `bg-rose-500/5 border-rose-500 text-rose-500 shadow-[0_0_20px_rgba(244,63,94,0.15)] scale-[1.05] z-10` 
                          : 'bg-gray-50/50 dark:bg-zinc-900/50 border-transparent text-gray-400 hover:bg-gray-100 dark:hover:bg-zinc-800'
                      }`}
                    >
                      <cat.icon size={24} className={expense?.category === cat.id ? 'animate-bounce' : ''} />
                      <span className="text-[10px] font-black uppercase tracking-wider text-center leading-tight italic">{cat.label}</span>
                      {expense?.category === cat.id && (
                        <div className="absolute top-2 right-2 h-2 w-2 bg-rose-500 rounded-full shadow-lg" />
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Si es Proveedor, mostrar selector */}
              {expense?.category === 'Proveedores' && (
                <div className="space-y-4 animate-in fade-in slide-in-from-top-4 duration-500">
                  <div className="flex items-center justify-between ml-1">
                    <div className="flex items-center gap-2">
                      <Search size={14} className="text-sky-500" />
                      <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic mb-1">Vincular Proveedor de Servicios</label>
                    </div>
                    <Button 
                      size="sm" 
                      variant="flat" 
                      className="h-10 text-[10px] font-black uppercase italic text-sky-500 bg-sky-500/10 rounded-xl px-5 border border-sky-500/20"
                      onClick={() => setIsCreatingSupplier(!isCreatingSupplier)}
                    >
                      {isCreatingSupplier ? "VOLVER AL LISTADO" : "+ NUEVO PROVEEDOR"}
                    </Button>
                  </div>
                  
                  {isCreatingSupplier ? (
                    <Input
                      placeholder="NOMBRE DEL PROVEEDOR"
                      value={newSupplierName}
                      onValueChange={(v) => {
                        const val = v.toUpperCase();
                        setNewSupplierName(val);
                        setExpense((p: any) => ({ 
                          ...p, 
                          newSupplierName: val,
                          description: `PAGO PROVEEDOR: ${val}` 
                        }));
                      }}
                      classNames={{ 
                        inputWrapper: "h-20 bg-sky-50 dark:bg-sky-500/5 border border-sky-200 dark:border-sky-500/20 rounded-3xl focus-within:!border-sky-500 shadow-inner transition-all", 
                        input: "font-black text-lg uppercase italic text-gray-900 dark:text-white" 
                      }}
                      startContent={<UserPlus size={24} className="text-sky-500 mr-3" />}
                    />
                  ) : (
                    <Autocomplete
                      placeholder="BUSCAR EN BASE DE DATOS..."
                      aria-label="Buscar proveedor"
                      defaultItems={suppliers || []}
                      selectedKey={expense?.supplierId?.toString()}
                      onSelectionChange={(key) => {
                        const sup = suppliers?.find(s => s.id.toString() === key?.toString());
                        setExpense((p: any) => ({ 
                          ...p, 
                          supplierId: key,
                          description: sup ? `PAGO PROVEEDOR: ${sup.name}` : p.description
                        }));
                      }}
                      classNames={{ 
                        base: "max-w-full",
                        listbox: "bg-white dark:bg-zinc-950 rounded-[2rem] p-4",
                        popoverContent: "bg-white dark:bg-zinc-950 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-2xl"
                      }}
                      inputProps={{
                        classNames: {
                          inputWrapper: "h-20 bg-gray-50 dark:bg-zinc-900/50 border border-gray-200 dark:border-white/10 rounded-3xl focus-within:!border-sky-500 transition-all shadow-inner",
                          input: "font-black text-lg uppercase italic text-gray-900 dark:text-white"
                        }
                      }}
                    >
                      {(item) => (
                        <AutocompleteItem 
                          key={item.id} 
                          textValue={item.name}
                          className="rounded-2xl h-16"
                        >
                          <div className="flex flex-col gap-1 p-1">
                            <span className="text-sm font-black uppercase italic text-gray-900 dark:text-white">{item.name}</span>
                            <div className="flex items-center gap-2">
                              <span className="h-2 w-2 rounded-full bg-emerald-500" />
                              <span className="text-[10px] font-bold text-gray-400 tracking-widest uppercase italic">{item.phone || 'Sin contacto registrado'}</span>
                            </div>
                          </div>
                        </AutocompleteItem>
                      )}
                    </Autocomplete>
                  )}
                </div>
              )}

              {/* Concepto y Cuantía */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                <div className="space-y-4">
                  <div className="flex items-center gap-2 ml-1">
                    <FileText size={14} className="text-rose-500" />
                    <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic mb-1">Descripción del Egreso</label>
                  </div>
                  <Input
                    placeholder="E.G. PAGO DE ARRIENDO LOCAL..."
                    value={expense?.description || ''}
                    onValueChange={(v) => setExpense((p: any) => ({ ...p, description: v.toUpperCase() }))}
                    classNames={{ 
                      inputWrapper: "h-16 bg-gray-50 dark:bg-zinc-900/50 border border-gray-200 dark:border-white/10 rounded-2xl focus-within:!border-rose-500 shadow-inner transition-all", 
                      input: "font-black text-base uppercase italic text-gray-900 dark:text-white bg-transparent" 
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
                    value={String(expense?.amount || '')}
                    onValueChange={(v) => {
                      const raw = v.replace(/\D/g, '');
                      setExpense((p: any) => ({ ...p, amount: raw }));
                    }}
                    startContent={<span className="text-2xl font-black italic text-rose-500 select-none mr-3">$</span>}
                    classNames={{ 
                      inputWrapper: "h-16 bg-rose-50/30 dark:bg-rose-500/5 border border-rose-200 dark:border-rose-500/20 rounded-2xl focus-within:!border-rose-500 shadow-inner transition-all px-8", 
                      input: "font-black text-3xl uppercase italic text-gray-900 dark:text-white bg-transparent tabular-nums placeholder:text-gray-200 dark:placeholder:text-zinc-800" 
                    }}
                  />
                </div>
              </div>

              {/* Canal de Salida */}
              <div className="space-y-6 pt-2">
                <div className="flex flex-col items-center gap-2">
                  <div className="flex items-center gap-2">
                    <CreditCard size={14} className="text-rose-500" />
                    <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.3em] not-italic">Canal de Salida de Capital</label>
                  </div>
                  <div className="h-px w-20 bg-gradient-to-r from-transparent via-rose-500 to-transparent opacity-20" />
                </div>
                <div className="grid grid-cols-3 md:grid-cols-5 gap-4">
                  {paymentMethods.map(method => (
                    <button
                      key={method.id}
                      onClick={() => setExpense((p: any) => ({ ...p, paymentSource: method.id }))}
                      className={`h-20 rounded-2xl flex flex-col items-center justify-center gap-2 border-2 transition-all group relative overflow-hidden ${
                        expense?.paymentSource === method.id 
                          ? `bg-rose-500 border-rose-500 text-white shadow-xl shadow-rose-500/20 scale-105 z-10` 
                          : 'bg-white dark:bg-zinc-900/50 border-gray-100 dark:border-white/5 text-gray-400 hover:bg-gray-50 dark:hover:bg-zinc-800 hover:border-gray-200 dark:hover:border-white/10'
                      }`}
                    >
                      <method.icon size={22} className={`${expense?.paymentSource === method.id ? 'scale-110' : ''} transition-transform duration-500`} />
                      <span className="text-[9px] font-black uppercase tracking-widest italic">{method.label}</span>
                      {expense?.paymentSource === method.id && (
                        <div className="absolute top-1 right-1 h-1.5 w-1.5 bg-white rounded-full" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </ModalBody>

            <ModalFooter className="p-10 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-b-[2.5rem]">
              <div className="flex w-full gap-6">
                <Button
                  variant="flat"
                  className="flex-1 h-20 rounded-3xl font-black uppercase text-[10px] bg-white dark:bg-zinc-900 text-gray-400 dark:text-zinc-500 border border-gray-200 dark:border-white/10 italic tracking-[0.2em] hover:bg-rose-500/10 hover:text-rose-500 hover:border-rose-500/20 transition-all opacity-70 hover:opacity-100 shadow-sm"
                  onPress={onClose}
                >
                  CANCELAR
                </Button>
                <Button
                  className="flex-[2] h-20 bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase text-sm tracking-[0.3em] rounded-3xl transition-all shadow-2xl hover:scale-[1.02] active:scale-95 italic group ring-4 ring-black/5 dark:ring-white/5"
                  onPress={onSave}
                >
                  <Sparkles size={24} className="mr-3 group-hover:rotate-12 transition-transform" />
                  {isEdit ? "SINCRONIZAR CAMBIOS" : "AUTORIZAR PAGO MAESTRO"}
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

