"use client";

import { useEffect, useState, useMemo, useCallback, memo } from 'react';
import dynamic from 'next/dynamic';
import { Button, Input, Spinner, Autocomplete, AutocompleteItem } from "@heroui/react";
import {
  TrendingDown, Search, PlusCircle, RefreshCw, Sparkles, Truck
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Expense, Supplier } from '@/lib/definitions';
import Cookies from 'js-cookie';
import { apiFetch } from '@/lib/api-error';
import { useAuth } from '@/lib/auth';
import { broadcastRevalidate, setupSyncListener } from '@/lib/revalidate';
import { ConfirmDialog } from '@/components/ConfirmDialog';

// Dinamicos para optimizacion de carga y HMR
const ExpenseStats = dynamic(() => import('./components/ExpenseStats'), { ssr: false });
const ExpenseTable = dynamic(() => import('./components/ExpenseTable'), { ssr: false });
const ExpenseFormModal = dynamic(() => import('./components/ExpenseFormModal'), { ssr: false });
const DeleteExpenseModal = dynamic(() => import('./components/DeleteExpenseModal'), { ssr: false });
const PendingDebtsModal = dynamic(() => import('./components/PendingDebtsModal'), { ssr: false });

// COMPONENTE HEADER MEMOIZADO PARA RENDIMIENTO (ESTILO USUARIOS)
const ExpenseHeader = memo(({ filter, supplierFilter, suppliers, onSearch, onSelectSupplier, onAdd, onReload, isLoading, onApplyFilters }: {
  filter: string,
  supplierFilter: string,
  suppliers: Supplier[],
  onSearch: (v: string) => void,
  onSelectSupplier: (name: string) => void,
  onAdd: () => void,
  onReload: () => void,
  isLoading: boolean,
  onApplyFilters: () => void
}) => (
  <header className="flex flex-col gap-2.5 transition-all">
    <div className="flex items-center justify-between px-1">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-2xl bg-rose-500 flex items-center justify-center text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/20 shrink-0 transition-transform active:scale-95 transform -rotate-3">
          <TrendingDown size={20} />
        </div>
        <div className="flex flex-col">
          <h1 className="text-[13px] font-medium uppercase tracking-tighter leading-none tracking-tight">
            CONTROL DE <span className="text-rose-500">EGRESOS</span>
          </h1>
          <p className="text-[8px] font-medium text-gray-400 dark:text-zinc-600 uppercase tracking-[0.4em] mt-1">Audit Ledger V4.5</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          isIconOnly
          size="sm"
          onPress={onReload}
          isLoading={isLoading}
          className="h-10 w-10 card-base border-none dark:bg-[#18181b]/80 text-rose-500 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-gray-200 dark:border-white/5 active:scale-95 transition-all"
        >
          <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
        </Button>
        <Button
          size="sm"
          onPress={onAdd}
          className="h-10 bg-rose-500 text-white font-medium uppercase text-[9px] px-4 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/20 tracking-tight transition-all active:scale-95 shrink-0"
        >
          <PlusCircle size={16} />
          <span className="ml-2 tracking-widest">NUEVA SALIDA</span>
        </Button>
      </div>
    </div>
    <div className="flex flex-col sm:flex-row gap-2">
      <Input
        size="sm"
        placeholder="FILTRAR POR CONCEPTO (ej. ALMUERZO, TRANSPORTE)..."
        value={filter}
        onValueChange={onSearch}
        classNames={{
          inputWrapper: "h-11 px-4 rounded-2xl bg-black/5 dark:bg-[#18181b] border border-gray-200 dark:border-white/5 focus-within:!border-rose-500/30 transition-all w-full shadow-inner",
          input: "font-medium text-[11px] uppercase text-zinc-900 dark:text-zinc-50 placeholder:text-gray-400 dark:placeholder:text-zinc-600 bg-transparent tracking-widest"
        }}
        startContent={<Search size={14} className="text-rose-500 mr-1" />}
      />
      <Autocomplete
        size="sm"
        placeholder="SELECCIONAR PROVEEDOR..."
        defaultItems={suppliers}
        selectedKey={supplierFilter || null}
        onSelectionChange={(key) => onSelectSupplier(key ? String(key) : '')}
        allowsCustomValue
        onInputChange={(v) => onSelectSupplier(v.toUpperCase())}
        classNames={{
          base: "w-full",
        }}
        inputProps={{
          classNames: {
            inputWrapper: "h-11 px-4 rounded-2xl bg-black/5 dark:bg-[#18181b] border border-gray-200 dark:border-white/5 focus-within:!border-rose-500/30 transition-all w-full shadow-inner",
            input: "font-medium text-[11px] uppercase text-zinc-900 dark:text-zinc-50 placeholder:text-gray-400 dark:placeholder:text-zinc-600 bg-transparent tracking-widest"
          }
        }}
        startContent={<Truck size={14} className="text-rose-500 mr-1 shrink-0" />}
      >
        {(s) => (
          <AutocompleteItem key={s.name} textValue={s.name} className="text-[11px] font-medium uppercase">
            {s.name}
          </AutocompleteItem>
        )}
      </Autocomplete>
      <Button
        onPress={onApplyFilters}
        className="h-11 bg-gray-50 dark:bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 font-medium uppercase text-[10px] rounded-2xl px-6"
      >
        Buscar (Servidor)
      </Button>
    </div>
  </header>
));
ExpenseHeader.displayName = 'ExpenseHeader';

async function fetchExpenses(token: string, concept: string = '', supplier: string = ''): Promise<Expense[]> {
  const query = new URLSearchParams();
  if (concept) query.append('concept', concept);
  if (supplier) query.append('supplier', supplier);
  const url = `/expenses/list${query.toString() ? '?' + query.toString() : ''}`;
  
  const data = await apiFetch(url, {
    method: 'GET',
    fallbackError: 'FALLO AL CARGAR EGRESOS'
  }, token);
  return Array.isArray(data) ? data : [];
}

export default function ExpensesPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const isAdmin = useMemo(() => {
    const role = user?.role?.toLowerCase() || user?.Role?.toLowerCase() || '';
    return role === 'admin' || role === 'administrador' || role === 'superadmin';
  }, [user]);

  const [loading, setLoading] = useState(true);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [filter, setFilter] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');

  // Modales
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingModalOpen, setPendingModalOpen] = useState(false);
  
  const [duplicateAlertOpen, setDuplicateAlertOpen] = useState(false);
  const [pendingExpenseData, setPendingExpenseData] = useState<any>(null);

  // Estados de Datos
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);

  const loadExpenses = useCallback(async () => {
    setLoading(true);
    const token = Cookies.get('org-pos-token');
    if (!token) { setLoading(false); return; }
    try {
      const data = await fetchExpenses(token, filter, supplierFilter);
      setExpenses(data);
    } catch {
      toast({ variant: "destructive", title: "Error Auditoria", description: "No se pudo sincronizar el historial de egresos." });
    } finally {
      setLoading(false);
    }
  }, [toast, filter, supplierFilter]);

  useEffect(() => { 
    loadExpenses(); 
    
    // Escuchar actualizaciones de egresos (Incluso si ocurren en otra pestaña o proceso)
    const cleanup = setupSyncListener((event) => {
      if (event === 'EXPENSE_UPDATE' || event === 'DASHBOARD_UPDATE') {
        loadExpenses();
      }
    });
    return cleanup;
  }, []);

  // Cargar lista de proveedores para alimentar el dropdown del filtro
  useEffect(() => {
    const loadSuppliers = async () => {
      const token = Cookies.get('org-pos-token');
      if (!token) return;
      try {
        const data = await apiFetch('/suppliers/all-suppliers', {
          method: 'GET',
          fallbackError: 'No se pudo cargar la lista de proveedores',
        }, token);
        if (Array.isArray(data)) {
          setSuppliers(data);
        }
      } catch {
        // No bloqueante: el filtro permite valor libre con allowsCustomValue
      }
    };
    loadSuppliers();
  }, []);

  const stats = useMemo(() => {
    const now = new Date();
    const currentMonth = expenses.filter(e => {
      const d = new Date(e.date);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
    const totalMonth = currentMonth
      .filter(e => (e.status === 'PAID' || !e.status) && e.paymentSource?.toUpperCase() !== 'PRESTAMO' && e.paymentSource?.toUpperCase() !== 'PREST.')
      .reduce((acc, e) => acc + Number(e.amount) + Number(e.taxAmount || 0), 0);
    const bySource = expenses
      .filter(e => (e.status === 'PAID' || !e.status) && e.paymentSource?.toUpperCase() !== 'PRESTAMO' && e.paymentSource?.toUpperCase() !== 'PREST.')
      .reduce((acc: any, e) => {
        const source = e.paymentSource || 'EFECTIVO';
        acc[source] = (acc[source] || 0) + Number(e.amount) + Number(e.taxAmount || 0);
        return acc;
      }, {});
    const topSource = Object.entries(bySource).sort((a: any, b: any) => b[1] - a[1])[0]?.[0] || 'EFECTIVO';

    const pendingExpenses = expenses.filter(e => e.status === 'PENDING' && (e.remainingAmount > 0 || Number(e.amount) > 0));
    const totalPending = pendingExpenses.reduce((acc, e) => acc + (e.remainingAmount > 0 ? e.remainingAmount : Number(e.amount)), 0);

    return { totalMonth, topSource, count: expenses.length, totalPending, pendingExpenses };
  }, [expenses]);

  const filteredExpenses = useMemo(() => {
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    return expenses.filter(e => {
      // Ocultar deudas pendientes y saldadas de la tabla principal para evitar duplicidad visual
      if (e.status === 'PENDING' || e.status === 'SETTLED') return false;

      const d = new Date(e.date);
      const isCurrentMonth = d.getMonth() === currentMonth && d.getFullYear() === currentYear;
      
      // Ya filtramos por DB con filter/supplierFilter.
      // Asi que aqui solo aplicamos la regla de "si no hay filtro, mostrar solo el mes actual"
      if (filter.trim() !== '' || supplierFilter.trim() !== '') {
        return true;
      }
      
      return isCurrentMonth;
    }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [expenses, filter, supplierFilter]);

  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);

  const paginatedExpenses = useMemo(() => {
    return filteredExpenses.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  }, [filteredExpenses, currentPage, pageSize]);

  const totalPages = Math.ceil(filteredExpenses.length / pageSize || 1);

  // Reset pagination when filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [filter]);

  // Handlers
  const handleSaveExpense = async (data: any) => {
    const token = Cookies.get('org-pos-token');
    if (!token || !data?.description || !data?.amount || !data?.category) {
      toast({ variant: "destructive", title: "CAMPOS INCOMPLETOS", description: "La categoria, concepto y monto son obligatorios." });
      return;
    }

    if (addDialogOpen && data.category === 'Proveedores' && data.supplierId) {
      const today = new Date().toISOString().split('T')[0];
      const isDuplicate = expenses.some(e => {
        if (!e.supplier?.id) return false;
        const eDate = new Date(e.date).toISOString().split('T')[0];
        return e.supplier.id === Number(data.supplierId) && eDate === today;
      });

      if (isDuplicate) {
        setPendingExpenseData(data);
        setDuplicateAlertOpen(true);
        return;
      }
    }

    await proceedWithSave(data, token);
  };

  const proceedWithSave = async (data: any, token: string) => {
    try {
      const currentDate = new Date().toISOString();

      // Si hay linkedOrderId y es creacion, usar endpoint especial vinculado
      const isLinkedOrder = addDialogOpen && data.linkedOrderId;

      const path = addDialogOpen
        ? (isLinkedOrder ? '/expenses/create-linked' : '/expenses/create')
        : `/expenses/update/${editingExpense?.id}`;

      const method = addDialogOpen ? 'POST' : 'PUT';

      // Preparar payload base
      const payload: any = {
        description: data.description.toUpperCase(),
        amount: Math.abs(parseFloat(String(data.amount)) || 0),
        taxAmount: data.taxAmount || 0,
        cashAmount: data.cashAmount || 0,
        nequiAmount: data.nequiAmount || 0,
        daviplataAmount: data.daviplataAmount || 0,
        fondoAmount: data.fondoAmount || 0,
        date: currentDate,
        paymentSource: data.paymentSource || 'EFECTIVO',
        category: data.category,
        lenderName: data.paymentSource === 'PRESTAMO' ? data.lenderName : null,
        status: data.status,
        supplierId: data.category === 'Proveedores' && data.supplierId ? Number(data.supplierId) : null,
        newSupplierName: data.category === 'Proveedores' && !data.supplierId ? data.newSupplierName : null
      };

      // Si es orden vinculada, incluir el ID
      if (isLinkedOrder) {
        payload.linkedOrderId = Number(data.linkedOrderId);
      }

      const result = await apiFetch(path, {
        method,
        body: JSON.stringify(payload),
        fallbackError: 'FALLO AL REGISTRAR MOVIMIENTO'
      }, token!);

      // Mensaje de exito especifico para orden vinculada
      if (isLinkedOrder && result?.message) {
        toast({
          variant: "success",
          title: "EXITO",
          description: `${result.message}. Stock actualizado automaticamente.`,
        });
      } else {
        toast({
          variant: "success",
          title: "EXITO",
          description: "MOVIMIENTO REGISTRADO CORRECTAMENTE",
        });
      }

      setAddDialogOpen(false);
      setEditDialogOpen(false);
      localStorage.removeItem('expense-form-draft'); // Limpieza estricta tras exito
      setEditingExpense(null);
      loadExpenses();
      broadcastRevalidate('EXPENSE_UPDATE');
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "ERROR AL GUARDAR",
        description: err.message || "Fallo al procesar el egreso."
      });
    }
  };

  const handleDeleteExpense = async () => {
    if (!deletingId) return;
    const token = Cookies.get('org-pos-token') || localStorage.getItem('org-pos-token');
    try {
      await apiFetch(`/expenses/delete/${deletingId}`, {
        method: 'DELETE',
        fallbackError: 'FALLO AL ELIMINAR EGRESO'
      }, token!);
      toast({
        variant: "success",
        title: "EXITO",
        description: "REGISTRO ELIMINADO",
      });
      setDeleteDialogOpen(false);
      loadExpenses();
      broadcastRevalidate('EXPENSE_UPDATE');
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "FALLO AL ANULAR",
        description: err.message || 'FALLO AL ELIMINAR EGRESO',
        className: "bg-rose-500 text-white border-none"
      });
    }
  };

  const handleSettleDebt = async (id: string, paymentSource: string, amount: number) => {
    const token = Cookies.get('org-pos-token');
    if (!token) return;

    try {
      await apiFetch(`/expenses/settle/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ paymentSource, amount }),
        fallbackError: 'FALLO AL SALDAR DEUDA'
      }, token);

      toast({
        variant: "success",
        title: "DEUDA SALDADA",
        description: `EL EGRESO SE HA MARCADO COMO PAGADO CON ${paymentSource}`,
      });
      loadExpenses();
      broadcastRevalidate('EXPENSE_UPDATE');
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "FALLO AL SALDAR",
        description: err.message || 'FALLO AL SALDAR DEUDA',
      });
    }
  };

  const handleForceCloseDebt = async (id: string) => {
    const token = Cookies.get('org-pos-token');
    if (!token) return;

    try {
      const expenseToUpdate = expenses.find(e => String(e.id) === id);
      if (!expenseToUpdate) return;
      
      const updateData = {
        ...expenseToUpdate,
        status: 'PAID',
        remainingAmount: 0,
      };

      await apiFetch(`/expenses/${id}`, {
        method: 'PUT',
        body: JSON.stringify(updateData),
        fallbackError: 'FALLO AL CONDONAR DEUDA'
      }, token);

      toast({
        variant: "success",
        title: "DEUDA CONDONADA",
        description: `EL EGRESO SE HA MARCADO COMO PAGADO FORZOSAMENTE`,
      });
      loadExpenses();
      broadcastRevalidate('EXPENSE_UPDATE');
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "FALLO AL CONDONAR",
        description: err.message || 'FALLO AL CONDONAR DEUDA',
      });
    }
  };

  if (loading) return <div className="flex-1 h-full w-full flex items-center justify-center bg-[#09090b]"><Spinner color="danger" size="lg" /></div>;

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full w-full max-w-[1600px] mx-auto overflow-hidden bg-transparent text-zinc-900 dark:text-zinc-50 transition-all duration-500 relative">

      {/* HEADER SECTION: FIXED (TOP) */}
      <div className="shrink-0 px-3 pt-1.5 pb-2 flex flex-col gap-3 md:gap-4 border-b border-gray-200/50 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-950/50">
        <ExpenseHeader
          filter={filter}
          supplierFilter={supplierFilter}
          suppliers={suppliers}
          onSearch={(v) => setFilter(v.toUpperCase())}
          onSelectSupplier={(v) => setSupplierFilter(v.toUpperCase())}
          onAdd={() => setAddDialogOpen(true)}
          onReload={() => { setFilter(''); setSupplierFilter(''); loadExpenses(); }}
          onApplyFilters={loadExpenses}
          isLoading={loading}
        />
        <ExpenseStats
          totalMonth={stats.totalMonth}
          topSource={stats.topSource}
          count={stats.count}
          totalPending={stats.totalPending}
          onOpenPending={() => setPendingModalOpen(true)}
        />
      </div>

      {/* CONTENT SECTION (INTERNAL SCROLLABLE) */}
      <div className="px-1 md:px-2 py-1 flex flex-col flex-1 min-h-0">
        <ExpenseTable
          expenses={paginatedExpenses}
          isAdmin={isAdmin}
          onEdit={(e) => { setEditingExpense({ ...e }); setEditDialogOpen(true); }}
          onDelete={(id) => { setDeletingId(id); setDeleteDialogOpen(true); }}
          onSettle={handleSettleDebt}
          currentPage={currentPage}
          totalPages={totalPages}
          pageSize={pageSize}
          totalRecords={filteredExpenses.length}
          onPageChange={setCurrentPage}
          onPageSizeChange={(size) => { setPageSize(size); setCurrentPage(1); }}
        />
      </div>


      {/* Modals Orchestration */}
      <ExpenseFormModal
        isOpen={addDialogOpen || editDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setAddDialogOpen(false);
            setEditDialogOpen(false);
            setEditingExpense(null);
          }
        }}
        initialExpense={editingExpense || undefined}
        onSave={handleSaveExpense}
      />

      <ConfirmDialog
        isOpen={duplicateAlertOpen}
        onOpenChange={setDuplicateAlertOpen}
        title="Ã¢Å¡Â Ã¯Â¸Â ALERTA: POSIBLE PAGO DUPLICADO"
        description="Ya se realizo un pago a este proveedor el dia de hoy. Ã‚Â¿Esta seguro de que desea registrar otro pago?"
        onConfirm={() => {
          setDuplicateAlertOpen(false);
          const token = Cookies.get('org-pos-token');
          if (token && pendingExpenseData) {
            proceedWithSave(pendingExpenseData, token);
          }
        }}
        confirmText="Confirmar Pago"
        type="danger"
      />

      <DeleteExpenseModal
        isOpen={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteExpense}
      />

      <PendingDebtsModal
        isOpen={pendingModalOpen}
        onOpenChange={setPendingModalOpen}
        debts={stats.pendingExpenses}
        onSettle={handleSettleDebt}
        isAdmin={isAdmin}
        onForceClose={handleForceCloseDebt}
      />

    </div>
  );


}
