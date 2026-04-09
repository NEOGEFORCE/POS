"use client";

import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, Input, Card, CardBody, Chip, Spinner, Avatar
} from "@heroui/react";
import {
  PlusCircle, FileText, Edit, Trash2, TrendingDown,
  Wallet, Zap, Sparkles, Calendar, Search, AlertCircle, HandCoins, Building2
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Expense } from '@/lib/definitions';
import { formatCurrency } from "@/lib/utils";

async function fetchExpenses(token: string): Promise<Expense[]> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/expenses/list`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('Failed to fetch expenses');
  return res.json();
}

export default function ExpensesPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [filter, setFilter] = useState('');

  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [newExpense, setNewExpense] = useState({ description: '', amount: '', paymentSource: 'EFECTIVO' });
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);

  const loadExpenses = useCallback(async () => {
    const token = localStorage.getItem('org-pos-token');
    if (!token) { setLoading(false); return; }
    try {
      const data = await fetchExpenses(token);
      setExpenses(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadExpenses(); }, [loadExpenses]);

  const handleAddExpense = async () => {
    const token = localStorage.getItem('org-pos-token');
    const data = addDialogOpen ? newExpense : editingExpense;
    if (!token || !data?.description || !data?.amount) return;

    try {
      const currentDate = new Date().toISOString();
      const url = addDialogOpen
        ? `${process.env.NEXT_PUBLIC_API_URL}/expenses/create`
        : `${process.env.NEXT_PUBLIC_API_URL}/expenses/update/${editingExpense?.id}`;

      const method = addDialogOpen ? 'POST' : 'PUT';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          description: data.description.toUpperCase(),
          amount: parseFloat(String(data.amount)),
          date: currentDate,
          paymentSource: data.paymentSource
        })
      });

      if (!res.ok) throw new Error();

      toast({ title: addDialogOpen ? "Registrado" : "Actualizado" });
      setAddDialogOpen(false);
      setEditDialogOpen(false);
      setNewExpense({ description: '', amount: '', paymentSource: 'EFECTIVO' });
      loadExpenses();
    } catch (error) { toast({ variant: "destructive", title: "Error en la operación" }); }
  };

  // --- ESCUCHADOR DE TECLA ENTER ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((addDialogOpen || editDialogOpen) && e.key === 'Enter') {
        e.preventDefault();
        handleAddExpense();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [addDialogOpen, editDialogOpen, newExpense, editingExpense, handleAddExpense]);

  const handleDeleteExpense = async () => {
    if (!deletingId) return;
    const token = localStorage.getItem('org-pos-token');
    try {
      await fetch(`${process.env.NEXT_PUBLIC_API_URL}/expenses/delete/${deletingId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
      toast({ title: 'Eliminado' });
      setDeleteDialogOpen(false);
      loadExpenses();
    } catch { toast({ variant: 'destructive', title: 'Error' }); }
  };

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
    return expenses.filter(e => e.description.toLowerCase().includes(filter.toLowerCase()));
  }, [expenses, filter]);

  if (loading) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner color="danger" size="lg" /></div>;

  return (
    <div className="flex flex-col h-screen gap-1 p-1 bg-gray-100 dark:bg-zinc-950 overflow-hidden select-none transition-colors duration-500">

      <header className="flex items-center justify-between gap-2 p-2 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-lg shrink-0 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="bg-rose-500 p-2 rounded-md text-white"><TrendingDown size={16} /></div>
          <div className="flex flex-col">
            <span className="text-sm font-black dark:text-white uppercase leading-none italic">EGRESOS</span>
            <span className="text-[9px] font-bold text-rose-500 uppercase tracking-widest italic">AUDIT V4.0</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Input size="sm" placeholder="BUSCAR..." value={filter} onValueChange={setFilter} startContent={<Search size={14} className="text-gray-400" />} classNames={{ inputWrapper: "h-8 bg-gray-50 dark:bg-zinc-800 border-none", input: "text-[10px] font-bold" }} />
          <Button size="sm" onPress={() => setAddDialogOpen(true)} className="h-8 bg-rose-500 text-white font-black text-[10px] rounded-md shadow-lg italic">NUEVA SALIDA</Button>
        </div>
      </header>

      <div className="grid grid-cols-3 gap-1 shrink-0">
        <div className="bg-white dark:bg-zinc-900 p-2 border border-gray-200 dark:border-white/5 rounded-lg flex flex-col items-center"><span className="text-[8px] font-black text-gray-400 uppercase tracking-widest">TOTAL MES</span><span className="text-sm font-black text-rose-500 tabular-nums">${stats.totalMonth.toLocaleString()}</span></div>
        <div className="bg-white dark:bg-zinc-900 p-2 border border-gray-200 dark:border-white/5 rounded-lg flex flex-col items-center"><span className="text-[8px] font-black text-gray-400 uppercase tracking-widest">CANAL TOP</span><span className="text-sm font-black dark:text-white uppercase truncate px-1">{stats.topSource}</span></div>
        <div className="bg-white dark:bg-zinc-900 p-2 border border-gray-200 dark:border-white/5 rounded-lg flex flex-col items-center"><span className="text-[8px] font-black text-gray-400 uppercase tracking-widest">OPERACIONES</span><span className="text-sm font-black text-emerald-500 tabular-nums">{stats.count}</span></div>
      </div>

      <div className="flex-1 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-lg overflow-hidden flex flex-col min-h-0 shadow-sm">
        <div className="flex-1 overflow-auto custom-scrollbar">
          <Table isCompact removeWrapper classNames={{ th: "bg-gray-50 dark:bg-zinc-800 text-gray-500 font-bold uppercase text-[9px] tracking-widest h-8 py-1 border-b border-gray-200 sticky top-0 z-10", td: "py-1 font-medium border-b border-gray-100 dark:border-white/5", tr: "hover:bg-gray-50 transition-colors group" }}>
            <TableHeader>
              <TableColumn className="pl-6">CONCEPTO</TableColumn>
              <TableColumn align="center">FECHA</TableColumn>
              <TableColumn align="center">CANAL</TableColumn>
              <TableColumn align="end" className="pr-6">VALOR</TableColumn>
            </TableHeader>
            <TableBody emptyContent={<div className="py-10 text-[10px] font-bold text-gray-400 uppercase text-center">Sin egresos registrados</div>}>
              {filteredExpenses.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).map((expense) => (
                <TableRow key={expense.id} className="cursor-default group">
                  <TableCell className="pl-6">
                    <div className="flex items-center gap-3">
                      <div className="h-7 w-7 rounded bg-gray-100 dark:bg-zinc-800 flex items-center justify-center text-gray-400 group-hover:text-rose-500 transition-all"><FileText size={14} /></div>
                      <div className="flex flex-col">
                        <span className="text-[11px] font-bold dark:text-white uppercase leading-tight italic">{expense.description}</span>
                        <span className="text-[8px] text-gray-400 font-mono italic">ID: #{String(expense.id).slice(-6).toUpperCase()}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-center"><span className="text-[10px] font-bold tabular-nums text-gray-500">{new Date(expense.date).toLocaleDateString('es-CO')}</span></TableCell>
                  <TableCell className="text-center">
                    <Chip size="sm" variant="flat" className={`text-[8px] font-black h-5 uppercase italic ${expense.paymentSource === 'NEQUI' ? 'bg-pink-100 text-pink-600' :
                        expense.paymentSource === 'DAVIPLATA' ? 'bg-rose-100 text-rose-600' :
                          expense.paymentSource === 'PRESTADO' ? 'bg-amber-100 text-amber-600' :
                            expense.paymentSource === 'FONDO' ? 'bg-indigo-100 text-indigo-600' :
                              'bg-emerald-100 text-emerald-600'
                      }`}>{expense.paymentSource}</Chip>
                  </TableCell>
                  <TableCell className="pr-6">
                    <div className="flex justify-end items-center gap-3">
                      <span className="text-sm font-black dark:text-white italic tabular-nums leading-none"><span className="text-rose-500 mr-0.5">$</span>{Number(expense.amount).toLocaleString()}</span>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button isIconOnly size="sm" variant="light" className="h-6 w-6 text-sky-500" onPress={() => { setEditingExpense({ ...expense }); setEditDialogOpen(true); }}><Edit size={12} /></Button>
                        <Button isIconOnly size="sm" variant="light" className="h-6 w-6 text-rose-500" onPress={() => { setDeletingId(expense.id); setDeleteDialogOpen(true); }}><Trash2 size={12} /></Button>
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* MODAL REDISEÑADO: MÁS PEQUEÑO Y SOPORTE DE ENTER */}
      <Modal
        isOpen={addDialogOpen || editDialogOpen}
        onOpenChange={(o) => { if (!o) { setAddDialogOpen(false); setEditDialogOpen(false); setEditingExpense(null); } }}
        backdrop="blur"
        size="3xl"
        classNames={{ base: "bg-gray-50 dark:bg-zinc-950 rounded-[2rem] border border-gray-200 dark:border-white/5 shadow-2xl overflow-hidden", closeButton: "text-gray-400 hover:text-rose-500 transition-colors" }}
      >
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex items-center gap-3 p-6 bg-white dark:bg-zinc-900 border-b border-gray-200 dark:border-white/5">
                <Avatar className="h-12 w-12 rounded-2xl bg-rose-500/10 text-rose-600" icon={<TrendingDown size={24} />} />
                <div>
                  <h2 className="text-2xl font-black text-gray-900 dark:text-white uppercase tracking-tighter italic leading-none">
                    {addDialogOpen ? "Registrar " : "Actualizar "} <span className="text-rose-500">Egreso</span>
                  </h2>
                  <p className="text-[9px] font-black text-gray-400 dark:text-zinc-500 mt-1 uppercase tracking-widest italic">Audit Ledger Maestro</p>
                </div>
              </ModalHeader>
              <ModalBody className="p-6 gap-6">
                <div className="space-y-5">
                  <div className="space-y-1.5">
                    <label className="text-[9px] font-black text-gray-400 uppercase tracking-[0.2em] pl-2 italic">Descripción del Movimiento</label>
                    <Input
                      placeholder="Ej: COCACOLA, PAGO LUZ, PROVEEDOR..."
                      value={addDialogOpen ? newExpense.description : editingExpense?.description}
                      onValueChange={(v) => addDialogOpen ? setNewExpense(p => ({ ...p, description: v })) : setEditingExpense(p => p ? { ...p, description: v } : null)}
                      classNames={{ inputWrapper: "h-12 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-xl px-4 shadow-sm", input: "font-black text-sm uppercase italic dark:text-white" }}
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-[9px] font-black text-gray-500 uppercase tracking-[0.2em] pl-2 italic text-center block w-full">Canal de Salida</label>
                    <div className="grid grid-cols-5 gap-2">
                      {[
                        { id: 'EFECTIVO', label: 'Caja', icon: Wallet, color: 'emerald' },
                        { id: 'FONDO', label: 'Fondo', icon: Building2, color: 'indigo' },
                        { id: 'NEQUI', label: 'Nequi', icon: Zap, color: 'pink' },
                        { id: 'DAVIPLATA', label: 'Davi', icon: Zap, color: 'red' },
                        { id: 'PRESTADO', label: 'Prest.', icon: HandCoins, color: 'amber' }
                      ].map(method => (
                        <button
                          key={method.id}
                          onClick={() => addDialogOpen ? setNewExpense(p => ({ ...p, paymentSource: method.id })) : setEditingExpense(p => p ? { ...p, paymentSource: method.id as any } : null)}
                          className={`h-20 rounded-2xl flex flex-col items-center justify-center gap-1.5 border-2 transition-all group ${(addDialogOpen ? newExpense.paymentSource : editingExpense?.paymentSource) === method.id ? `bg-${method.color}-50 dark:bg-${method.color}-500/10 border-${method.color}-500 text-${method.color}-600 scale-105 shadow-lg` : 'bg-white dark:bg-zinc-900 border-gray-100 dark:border-white/5 text-gray-400'}`}
                        >
                          <method.icon size={20} className={(addDialogOpen ? newExpense.paymentSource : editingExpense?.paymentSource) === method.id ? `text-${method.color}-500` : 'text-gray-300'} />
                          <span className="text-[8px] font-black uppercase tracking-widest">
                            {method.label}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[9px] font-black text-gray-400 uppercase tracking-[0.2em] pl-2 italic">Cuantía de la Operación</label>
                    <Input
                      type="text"
                      placeholder="0"
                      value={addDialogOpen ? newExpense.amount : String(editingExpense?.amount || '')}
                      onValueChange={(v) => {
                        const raw = v.replace(/\D/g, '');
                        addDialogOpen ? setNewExpense(p => ({ ...p, amount: raw })) : setEditingExpense(p => p ? { ...p, amount: Number(raw) } : null);
                      }}
                      startContent={<span className="text-4xl font-black italic text-rose-500 select-none mr-1">$</span>}
                      classNames={{
                        inputWrapper: "h-20 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-2xl shadow-inner px-6",
                        input: "text-4xl font-black italic text-gray-900 dark:text-white tabular-nums"
                      }}
                    />
                  </div>
                </div>
              </ModalBody>
              <ModalFooter className="p-6 bg-white dark:bg-zinc-900 border-t border-gray-200 dark:border-white/5">
                <Button
                  className="w-full h-14 bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase text-xs tracking-widest shadow-xl hover:scale-105 italic rounded-xl transition-all"
                  onPress={handleAddExpense}
                  startContent={<Sparkles size={18} />}
                >
                  ESTABLECER EGRESO (ENTER)
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* Modal Purga */}
      <Modal isOpen={deleteDialogOpen} onOpenChange={setDeleteDialogOpen} backdrop="blur" classNames={{ base: "bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl", closeButton: "text-gray-400" }}>
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex items-center gap-3 p-6 pb-2 text-rose-500 font-black uppercase tracking-tight text-xl italic border-b border-gray-100 dark:border-white/5">
                <AlertCircle size={28} /> Confirmar Purga
              </ModalHeader>
              <ModalBody className="p-6 text-center">
                <p className="text-sm font-bold text-gray-600 dark:text-zinc-400 uppercase tracking-tight leading-relaxed">¿Desea eliminar permanentemente este registro?</p>
              </ModalBody>
              <ModalFooter className="p-6 pt-2 flex gap-2 border-t border-gray-100 dark:border-white/5">
                <Button variant="flat" className="flex-1 font-black uppercase text-[10px]" onPress={() => setDeleteDialogOpen(false)}>MANTENER</Button>
                <Button color="danger" className="flex-1 font-black uppercase text-[10px]" onPress={handleDeleteExpense}>ELIMINAR</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}