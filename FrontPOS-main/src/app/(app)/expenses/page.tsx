"use client";

import { useEffect, useState, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { Button, Input, Spinner } from "@heroui/react";
import { 
  TrendingDown, Search, PlusCircle, Clock, Sparkles 
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Expense } from '@/lib/definitions';
import Cookies from 'js-cookie';
import { apiFetch } from '@/lib/api-error';

// Dinámicos para optimización de carga y HMR
const ExpenseStats = dynamic(() => import('./components/ExpenseStats'), { ssr: false });
const ExpenseTable = dynamic(() => import('./components/ExpenseTable'), { ssr: false });
const ExpenseFormModal = dynamic(() => import('./components/ExpenseFormModal'), { ssr: false });
const DeleteExpenseModal = dynamic(() => import('./components/DeleteExpenseModal'), { ssr: false });

async function fetchExpenses(token: string): Promise<Expense[]> {
  const data = await apiFetch('/expenses/list', {
    method: 'GET',
    fallbackError: 'FALLO AL CARGAR EGRESOS'
  }, token);
  return Array.isArray(data) ? data : [];
}

export default function ExpensesPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [filter, setFilter] = useState('');

  // Modales
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Estados de Datos
  const [newExpense, setNewExpense] = useState<Partial<Expense>>({ description: '', amount: 0, paymentSource: 'EFECTIVO' });
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
    const currentMonth = expenses.filter(e => new Date(e.date).getMonth() === now.getMonth());
    const totalMonth = currentMonth.reduce((acc, e) => acc + Number(e.amount), 0);
    const bySource = expenses.reduce((acc: any, e) => {
      const source = e.paymentSource || 'EFECTIVO';
      acc[source] = (acc[source] || 0) + Number(e.amount);
      return acc;
    }, {});
    const topSource = Object.entries(bySource).sort((a: any, b: any) => b[1] - a[1])[0]?.[0] || 'EFECTIVO';
    return { totalMonth, topSource, count: expenses.length };
  }, [expenses]);

  const filteredExpenses = useMemo(() => {
    const query = filter.toLowerCase();
    return expenses.filter(e => e.description.toLowerCase().includes(query));
  }, [expenses, filter]);

  // Handlers
  const handleSaveExpense = async () => {
    const token = Cookies.get('org-pos-token');
    const data = addDialogOpen ? newExpense : editingExpense;
    if (!token || !data?.description || !data?.amount || !data?.category) {
      toast({ variant: "destructive", title: "CAMPOS INCOMPLETOS", description: "La categoría, concepto y monto son obligatorios." });
      return;
    }

    try {
      const currentDate = new Date().toISOString();
      const path = addDialogOpen
        ? '/expenses/create'
        : `/expenses/update/${editingExpense?.id}`;

      const method = addDialogOpen ? 'POST' : 'PUT';

      await apiFetch(path, {
        method,
        body: JSON.stringify({
          description: data.description.toUpperCase(),
          amount: parseFloat(String(data.amount)),
          date: currentDate,
          paymentSource: data.paymentSource,
          category: data.category,
          supplierId: data.category === 'Proveedores' ? data.supplierId : null
        }),
        fallbackError: 'FALLO AL REGISTRAR MOVIMIENTO'
      }, token!);

      toast({ 
        title: "ÉXITO", 
        description: "MOVIMIENTO REGISTRADO CORRECTAMENTE",
        className: "bg-emerald-500 text-white border-none" 
      });
      setAddDialogOpen(false);
      setEditDialogOpen(false);
      setNewExpense({ description: '', amount: 0, paymentSource: 'EFECTIVO' });
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
        title: "ÉXITO", 
        description: "REGISTRO ELIMINADO", 
        className: "bg-emerald-500 text-white border-none"
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

  if (loading) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner color="danger" size="lg" /></div>;

  return (
    <div className="flex flex-col min-h-[100dvh] gap-2 p-2 bg-gray-100 dark:bg-zinc-950 transition-all duration-700 pb-20 items-center">
      <div className="w-full max-w-[1600px] flex flex-col gap-3">
      {/* Header Premium Zero Friction */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-3 p-4 bg-white/90 dark:bg-zinc-900/50 backdrop-blur-2xl border-b border-gray-200 dark:border-white/5 rounded-[2rem] shrink-0 shadow-xl relative overflow-hidden group">
        <div className="absolute top-0 right-0 p-4 opacity-5 text-rose-500 scale-150 rotate-12 transition-transform duration-1000 group-hover:rotate-[24deg]"><TrendingDown size={120} /></div>
        
        <div className="flex items-center gap-3 relative z-10">
          <div className="bg-rose-500 p-2.5 rounded-xl text-white shadow-lg shadow-rose-500/20 -rotate-3">
            <TrendingDown size={20} />
          </div>
          <div className="flex flex-col">
            <h1 className="text-lg font-black dark:text-white uppercase leading-none italic tracking-tighter">
              Control de <span className="text-rose-500">Egresos</span>
            </h1>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[8px] font-black text-rose-500 uppercase tracking-[0.3em]">Caja & Auditoría</span>
              <div className="h-1 w-1 bg-gray-300 rounded-full" />
              <div className="flex items-center gap-1 text-[8px] font-bold text-gray-400 uppercase tracking-widest italic">
                <Clock size={9} /> {new Date().toLocaleDateString()}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 relative z-10">
          <div className="relative group/search">
            <Input 
              size="sm" 
              placeholder="RASTREAR MOVIMIENTO..." 
              value={filter} 
              onValueChange={(v) => setFilter(v.toUpperCase())} 
              startContent={<Search size={16} className="text-gray-400 group-focus-within/search:text-rose-500 transition-colors" />} 
              classNames={{ 
                inputWrapper: "h-11 w-full md:w-80 bg-gray-50/50 dark:bg-black/20 backdrop-blur-md border border-gray-200 dark:border-white/10 shadow-inner rounded-2xl group-focus-within/search:border-rose-500/50 transition-all", 
                input: "text-[11px] font-black bg-transparent tracking-widest italic uppercase" 
              }} 
            />
          </div>
          <Button 
            size="sm" 
            onPress={() => setAddDialogOpen(true)} 
            className="h-11 px-6 bg-rose-500 text-white font-black text-[11px] rounded-xl shadow-lg shadow-rose-500/20 hover:scale-105 active:scale-95 transition-all italic tracking-widest uppercase"
          >
            <PlusCircle size={16} className="mr-1" /> NUEVA SALIDA
          </Button>
        </div>
      </header>

      {/* KPI Section */}
      <ExpenseStats 
        totalMonth={stats.totalMonth}
        topSource={stats.topSource}
        count={stats.count}
      />

      {/* Main Content Table */}
      <ExpenseTable 
        expenses={filteredExpenses}
        onEdit={(e) => { setEditingExpense({ ...e }); setEditDialogOpen(true); }}
        onDelete={(id) => { setDeletingId(id); setDeleteDialogOpen(true); }}
      />

      {/* Modals Orchestration */}
      <ExpenseFormModal 
        isOpen={addDialogOpen || editDialogOpen}
        onOpenChange={(o) => { if (!o) { setAddDialogOpen(false); setEditDialogOpen(false); setEditingExpense(null); setNewExpense({ description: '', amount: 0, paymentSource: 'EFECTIVO' }); } }}
        isEdit={editDialogOpen}
        expense={(addDialogOpen ? newExpense : editingExpense) || {}}
        setExpense={(e) => {
          if (addDialogOpen) setNewExpense(e as any);
          else setEditingExpense(e as any);
        }}
        onSave={handleSaveExpense}
      />

      <DeleteExpenseModal 
        isOpen={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteExpense}
      />
      </div>
    </div>
  );
}