"use client";

import { useEffect, useState, useMemo, useCallback, memo } from 'react';
import dynamic from 'next/dynamic';
import { Button, Input, Spinner } from "@heroui/react";
import {
  TrendingDown, Search, PlusCircle, RefreshCw, Sparkles
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Expense } from '@/lib/definitions';
import Cookies from 'js-cookie';
import { apiFetch } from '@/lib/api-error';
import { useAuth } from '@/lib/auth';

// Dinámicos para optimización de carga y HMR
const ExpenseStats = dynamic(() => import('./components/ExpenseStats'), { ssr: false });
const ExpenseTable = dynamic(() => import('./components/ExpenseTable'), { ssr: false });
const ExpenseFormModal = dynamic(() => import('./components/ExpenseFormModal'), { ssr: false });
const DeleteExpenseModal = dynamic(() => import('./components/DeleteExpenseModal'), { ssr: false });
const PendingDebtsModal = dynamic(() => import('./components/PendingDebtsModal'), { ssr: false });

// COMPONENTE HEADER MEMOIZADO PARA RENDIMIENTO (ESTILO USUARIOS)
const ExpenseHeader = memo(({ filter, onSearch, onAdd, onReload, isLoading }: {
  filter: string,
  onSearch: (v: string) => void,
  onAdd: () => void,
  onReload: () => void,
  isLoading: boolean
}) => (
  <header className="flex flex-col gap-2.5 transition-all">
    <div className="flex items-center justify-between px-1">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-rose-500 flex items-center justify-center text-white shadow-xl shadow-rose-500/20 shrink-0 transition-transform active:scale-95 transform -rotate-3">
          <TrendingDown size={20} />
        </div>
        <div className="flex flex-col">
          <h1 className="text-[13px] font-black uppercase tracking-tighter leading-none italic">
            CONTROL DE <span className="text-rose-500">EGRESOS</span>
          </h1>
          <p className="text-[8px] font-black text-gray-400 dark:text-zinc-600 uppercase tracking-[0.4em] mt-1">Audit Ledger V4.5</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          isIconOnly
          size="sm"
          onPress={onReload}
          isLoading={isLoading}
          className="h-10 w-10 bg-white/80 dark:bg-zinc-900/80 text-rose-500 rounded-xl shadow-sm border border-gray-200 dark:border-white/5 active:scale-95 transition-all"
        >
          <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
        </Button>
        <Button
          size="sm"
          onPress={onAdd}
          className="h-10 bg-rose-500 text-white font-black uppercase text-[9px] px-4 rounded-xl shadow-lg shadow-rose-500/20 italic transition-all active:scale-95 shrink-0"
        >
          <PlusCircle size={16} />
          <span className="ml-2 tracking-widest">NUEVA SALIDA</span>
        </Button>
      </div>
    </div>
    <Input
      size="sm"
      placeholder="FILTRAR POR CONCEPTO O CATEGORÍA..."
      value={filter}
      onValueChange={onSearch}
      classNames={{
        inputWrapper: "h-11 px-4 rounded-xl bg-white/50 dark:bg-black/20 border border-gray-200 dark:border-white/5 focus-within:!border-rose-500/30 transition-all w-full shadow-inner",
        input: "font-black text-[11px] uppercase text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 bg-transparent tracking-widest"
      }}
      startContent={<Search size={14} className="text-rose-500 mr-1" />}
    />
  </header>
));
ExpenseHeader.displayName = 'ExpenseHeader';

async function fetchExpenses(token: string): Promise<Expense[]> {
  const data = await apiFetch('/expenses/list', {
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
  const [filter, setFilter] = useState('');

  // Modales
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingModalOpen, setPendingModalOpen] = useState(false);

  // Estados de Datos
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);

  const loadExpenses = useCallback(async () => {
    const token = Cookies.get('org-pos-token');
    if (!token) { setLoading(false); return; }
    try {
      const data = await fetchExpenses(token);
      setExpenses(data);
    } catch {
      toast({ variant: "destructive", title: "Error Auditoría", description: "No se pudo sincronizar el historial de egresos." });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadExpenses(); }, [loadExpenses]);

  const stats = useMemo(() => {
    const now = new Date();
    const currentMonth = expenses.filter(e => {
      const d = new Date(e.date);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
    const totalMonth = currentMonth.reduce((acc, e) => acc + Number(e.amount), 0);
    const bySource = expenses.reduce((acc: any, e) => {
      const source = e.paymentSource || 'EFECTIVO';
      acc[source] = (acc[source] || 0) + Number(e.amount);
      return acc;
    }, {});
    const topSource = Object.entries(bySource).sort((a: any, b: any) => b[1] - a[1])[0]?.[0] || 'EFECTIVO';

    const pendingExpenses = expenses.filter(e => e.status === 'PENDING' || e.paymentSource === 'PRESTAMO' || e.paymentSource === 'PREST.');
    const totalPending = pendingExpenses.reduce((acc, e) => acc + Number(e.amount), 0);

    return { totalMonth, topSource, count: expenses.length, totalPending, pendingExpenses };
  }, [expenses]);

  const filteredExpenses = useMemo(() => {
    const query = filter.toLowerCase();
    return expenses.filter(e => e.description.toLowerCase().includes(query));
  }, [expenses, filter]);

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
      toast({ variant: "destructive", title: "CAMPOS INCOMPLETOS", description: "La categoría, concepto y monto son obligatorios." });
      return;
    }

    try {
      const currentDate = new Date().toISOString();

      // Si hay linkedOrderId y es creación, usar endpoint especial vinculado
      const isLinkedOrder = addDialogOpen && data.linkedOrderId;

      const path = addDialogOpen
        ? (isLinkedOrder ? '/expenses/create-linked' : '/expenses/create')
        : `/expenses/update/${editingExpense?.id}`;

      const method = addDialogOpen ? 'POST' : 'PUT';

      // Preparar payload base
      const payload: any = {
        description: data.description.toUpperCase(),
        amount: Math.abs(parseFloat(String(data.amount)) || 0),
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

      // Mensaje de éxito específico para orden vinculada
      if (isLinkedOrder && result?.message) {
        toast({
          variant: "success",
          title: "ÉXITO",
          description: `${result.message}. Stock actualizado automáticamente.`,
        });
      } else {
        toast({
          variant: "success",
          title: "ÉXITO",
          description: "MOVIMIENTO REGISTRADO CORRECTAMENTE",
        });
      }

      setAddDialogOpen(false);
      setEditDialogOpen(false);
      setEditingExpense(null);
      loadExpenses();
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "FALLO OPERATIVO",
        description: err.message || 'FALLO AL REGISTRAR MOVIMIENTO',
        className: "bg-rose-500 text-white border-none"
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
        title: "ÉXITO",
        description: "REGISTRO ELIMINADO",
      });
      setDeleteDialogOpen(false);
      loadExpenses();
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "FALLO AL ANULAR",
        description: err.message || 'FALLO AL ELIMINAR EGRESO',
        className: "bg-rose-500 text-white border-none"
      });
    }
  };

  const handleSettleDebt = async (id: string, paymentSource: string) => {
    const token = Cookies.get('org-pos-token');
    if (!token) return;

    try {
      await apiFetch(`/expenses/settle/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ paymentSource }),
        fallbackError: 'FALLO AL SALDAR DEUDA'
      }, token);

      toast({
        variant: "success",
        title: "DEUDA SALDADA",
        description: `EL EGRESO SE HA MARCADO COMO PAGADO CON ${paymentSource}`,
      });
      loadExpenses();
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "FALLO AL SALDAR",
        description: err.message || 'FALLO AL SALDAR DEUDA',
      });
    }
  };

  if (loading) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner color="danger" size="lg" /></div>;

  return (
    <div className="flex flex-col w-full max-w-[1600px] mx-auto h-full min-h-0 bg-transparent text-gray-900 dark:text-white transition-all duration-500 overflow-hidden relative">

      {/* HEADER SECTION: FIXED (TOP) */}
      <div className="shrink-0 px-3 pt-1.5 pb-2 flex flex-col gap-3 md:gap-4 border-b border-gray-200/50 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-950/50 backdrop-blur-md">
        <ExpenseHeader
          filter={filter}
          onSearch={(v) => setFilter(v.toUpperCase())}
          onAdd={() => setAddDialogOpen(true)}
          onReload={loadExpenses}
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
      <div className="flex-1 min-h-0 overflow-hidden px-1 md:px-2 py-1 flex flex-col">
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
        onOpenChange={(o) => { if (!o) { setAddDialogOpen(false); setEditDialogOpen(false); setEditingExpense(null); } }}
        isEdit={editDialogOpen}
        initialExpense={addDialogOpen ? null : editingExpense}
        onSave={handleSaveExpense}
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
      />

    </div>
  );
}