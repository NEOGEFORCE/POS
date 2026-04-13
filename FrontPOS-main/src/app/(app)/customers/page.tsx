"use client";

import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, Input, Card, CardBody, Chip, Spinner, Avatar
} from "@heroui/react";

import {
  Users, Search, PlusCircle, Wallet, Zap, Edit, Trash2,
  Check, Banknote, Receipt
} from 'lucide-react';

import { useToast } from '@/hooks/use-toast';
import { Customer } from '@/lib/definitions';
import { formatCurrency } from "@/lib/utils";

async function fetchCustomers(token: string): Promise<Customer[]> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/clients/all-clients`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('Failed to fetch customers');
  const data = await res.json();
  return data.map((c: any) => ({
    ...c,
    phone: c.phone || '',
    address: c.address || '',
    email: c.email || '',
    totalSpent: Number(c.totalSpent) || 0,
    lastPurchaseDate: c.lastPurchaseDate || null
  }));
}

export default function CustomersPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [filter, setFilter] = useState('');

  // Estados de Modales
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [payCreditDialogOpen, setPayCreditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Estados de Datos
  const [newClient, setNewClient] = useState({ dni: '', name: '', phone: '', address: '', creditLimit: '0' });
  const [editingClient, setEditingClient] = useState<Customer | null>(null);
  const [payingClient, setPayingClient] = useState<Customer | null>(null);
  const [deletingDni, setDeletingDni] = useState<string | null>(null);

  // Estados de Pago
  const [activePaymentTab, setActivePaymentTab] = useState<'cash' | 'NEQUI' | 'DAVIPLATA'>('cash');
  const [dialogAmount, setDialogAmount] = useState('');
  const [cashTendered, setCashTendered] = useState<string>('');
  const [lastChange, setLastChange] = useState(0);
  const [showSuccessScreen, setShowSuccessScreen] = useState(false);
  const [submittingPayment, setSubmittingPayment] = useState(false);
  const [lastPaymentReceipt, setLastPaymentReceipt] = useState<any>(null);

  const loadCustomers = useCallback(async () => {
    const token = localStorage.getItem('org-pos-token');
    if (!token) { setLoading(false); return; }
    try {
      const data = await fetchCustomers(token);
      setCustomers(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadCustomers(); }, [loadCustomers]);

  // Cálculos de Cartera
  const filteredCustomers = useMemo(() => {
    return customers.filter(c =>
      c.name.toLowerCase().includes(filter.toLowerCase()) ||
      c.dni.includes(filter)
    );
  }, [customers, filter]);

  const stats = useMemo(() => {
    const totalDebt = customers.reduce((acc, c) => acc + (Number(c.currentCredit) || 0), 0);
    const withDebt = customers.filter(c => (Number(c.currentCredit) || 0) > 0).length;
    return { totalDebt, withDebt, totalClients: customers.length };
  }, [customers]);

  // Lógica de Abonos
  const totalDebt = Number(payingClient?.currentCredit || 0);
  const currentDialogVal = Number(dialogAmount) || 0;
  const amountToPay = currentDialogVal > 0 ? currentDialogVal : (Number(cashTendered) > 0 ? Number(cashTendered) : totalDebt);
  const actualPayment = Math.min(amountToPay, totalDebt);
  const displayChange = activePaymentTab === 'cash' ? Math.max(0, amountToPay - totalDebt) : 0;

  const handlePayCredit = async () => {
    if (!payingClient) return;
    setSubmittingPayment(true);
    const token = localStorage.getItem('org-pos-token');
    try {
      const numCash = activePaymentTab === 'cash' ? actualPayment : 0;
      const numTransfer = activePaymentTab !== 'cash' ? actualPayment : 0;
      const tSource = activePaymentTab !== 'cash' ? activePaymentTab : '';

      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/clients/pay-credit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          clientDni: payingClient.dni,
          amountCash: numCash,
          amountTransfer: numTransfer,
          transferSource: tSource,
          totalPaid: actualPayment
        })
      });
      if (!res.ok) throw new Error();

      setLastChange(displayChange);
      setShowSuccessScreen(true);
      setLastPaymentReceipt({
        clientName: payingClient.name, clientDni: payingClient.dni, amountPaid: actualPayment,
        previousBalance: totalDebt, newBalance: Math.max(0, totalDebt - actualPayment),
        date: new Date().toLocaleString(), paymentMethod: numTransfer > 0 ? `TRANSF (${tSource})` : 'EFECTIVO'
      });
      loadCustomers();
    } catch { toast({ variant: "destructive", title: "Error al procesar" }); }
    finally { setSubmittingPayment(false); }
  };

  const handleNumpadAction = () => handlePayCredit();

  // Acciones CRUD
  const handleAddCustomer = async () => {
    const token = localStorage.getItem('org-pos-token');
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/clients/create-client`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ ...newClient, creditLimit: Number(newClient.creditLimit) })
      });
      if (!res.ok) throw new Error();
      toast({ title: "Cliente Creado" }); setAddDialogOpen(false);
      setNewClient({ dni: '', name: '', phone: '', address: '', creditLimit: '0' }); loadCustomers();
    } catch { toast({ variant: "destructive", title: "Error" }); }
  };

  const handleEditCustomer = async () => {
    if (!editingClient) return;
    const token = localStorage.getItem('org-pos-token');
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/clients/update-client/${editingClient.dni}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ ...editingClient, creditLimit: Number(editingClient.creditLimit) })
      });
      if (!res.ok) throw new Error();
      toast({ title: "Actualizado" }); setEditDialogOpen(false); loadCustomers();
    } catch { toast({ variant: "destructive", title: "Error" }); }
  };

  const handleDeleteCustomer = async () => {
    if (!deletingDni) return;
    const token = localStorage.getItem('org-pos-token');
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/clients/delete-client/${deletingDni}`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error();
      toast({ title: "Eliminado" }); setDeleteDialogOpen(false); setDeletingDni(null); loadCustomers();
    } catch { toast({ variant: "destructive", title: "Error al borrar" }); }
  };

  // Teclado
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!payCreditDialogOpen) return;
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
      if (e.key === 'Enter' && showSuccessScreen) { e.preventDefault(); setShowSuccessScreen(false); setPayCreditDialogOpen(false); return; }
      if (!showSuccessScreen && !isInput) {
        if (/^[0-9]$/.test(e.key)) { e.preventDefault(); setDialogAmount(p => p + e.key); }
        if (e.key === 'Backspace') { e.preventDefault(); setDialogAmount(p => p.slice(0, -1)); }
        if (e.key === 'Enter') { e.preventDefault(); handleNumpadAction(); }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [payCreditDialogOpen, showSuccessScreen, dialogAmount, activePaymentTab]);

  if (loading) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner color="success" size="lg" /></div>;

  return (
    <div className="flex flex-col h-screen gap-1 p-1 bg-gray-100 dark:bg-zinc-950 overflow-hidden transition-colors duration-500">
      <header className="flex items-center justify-between gap-2 p-2 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-lg shrink-0 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="bg-emerald-500 p-2 rounded-md text-white"><Users size={16} /></div>
          <div className="flex flex-col"><span className="text-sm font-black dark:text-white uppercase leading-none">CLIENTES</span><span className="text-[9px] font-bold text-emerald-500 uppercase tracking-widest">CARTERA</span></div>
        </div>
        <div className="flex items-center gap-2">
          <Input size="sm" placeholder="BUSCAR..." value={filter} onValueChange={(v) => setFilter(v.toUpperCase())} startContent={<Search size={14} className="text-gray-400" />} classNames={{ inputWrapper: "h-8 bg-transparent border border-gray-200 dark:border-white/10 shadow-none", input: "text-[10px] font-bold bg-transparent" }} />
          <Button size="sm" onPress={() => setAddDialogOpen(true)} className="h-8 bg-emerald-500 text-white font-black text-[10px] rounded-md">NUEVO</Button>
        </div>
      </header>

      <div className="grid grid-cols-3 gap-1 shrink-0">
        <div className="bg-white dark:bg-zinc-900 p-2 border border-gray-200 dark:border-white/5 rounded-lg flex flex-col items-center"><span className="text-[8px] font-black text-gray-400 uppercase">DEUDA TOTAL</span><span className="text-sm font-black text-rose-500 italic tabular-nums">${stats.totalDebt.toLocaleString()}</span></div>
        <div className="bg-white dark:bg-zinc-900 p-2 border border-gray-200 dark:border-white/5 rounded-lg flex flex-col items-center"><span className="text-[8px] font-black text-gray-400 uppercase">REGISTROS</span><span className="text-sm font-black dark:text-white tabular-nums">{stats.totalClients}</span></div>
        <div className="bg-white dark:bg-zinc-900 p-2 border border-gray-200 dark:border-white/5 rounded-lg flex flex-col items-center"><span className="text-[8px] font-black text-gray-400 uppercase">CON DEUDA</span><span className="text-sm font-black text-amber-500 tabular-nums">{stats.withDebt}</span></div>
      </div>

      <div className="flex-1 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-lg overflow-hidden flex flex-col min-h-0">
        <div className="flex-1 overflow-auto custom-scrollbar">
          <Table isCompact removeWrapper classNames={{ th: "bg-gray-50 dark:bg-zinc-800 text-gray-500 font-bold uppercase text-[9px] tracking-widest h-8 py-1 border-b border-gray-200 sticky top-0 z-10", td: "py-1 border-b border-gray-100 dark:border-white/5", tr: "hover:bg-gray-50 transition-colors" }}>
            <TableHeader>
              <TableColumn className="pl-4">CLIENTE</TableColumn>
              <TableColumn align="center">CONTACTO</TableColumn>
              <TableColumn align="center">SALDO</TableColumn>
              <TableColumn align="end" className="pr-4">ACCIONES</TableColumn>
            </TableHeader>
            <TableBody emptyContent={<div className="py-10 text-[10px] font-bold text-gray-400 uppercase text-center">Sin datos</div>}>
              {filteredCustomers.map((c) => (
                <TableRow key={c.dni}>
                  <TableCell className="pl-4">
                    <div className="flex items-center gap-2">
                      <Avatar size="sm" name={c.name[0]} className="h-6 w-6 text-[9px] bg-emerald-100 text-emerald-700" />
                      <div className="flex flex-col"><span className="text-[11px] font-bold dark:text-white uppercase leading-tight italic">{c.name}</span><span className="text-[9px] text-gray-400 font-mono italic">{c.dni}</span></div>
                    </div>
                  </TableCell>
                  <TableCell className="text-center text-[10px] text-gray-500">{c.phone || 'S.T.'}</TableCell>
                  <TableCell className="text-center">
                    <Chip size="sm" variant="flat" className={`font-black text-[10px] h-5 ${Number(c.currentCredit) > 0 ? 'bg-rose-100 text-rose-600' : 'bg-emerald-100 text-emerald-600'}`}>${Number(c.currentCredit).toLocaleString()}</Chip>
                  </TableCell>
                  <TableCell className="pr-4">
                    <div className="flex justify-end gap-1">
                      {Number(c.currentCredit) > 0 && <Button size="sm" onPress={() => { setPayingClient(c); setShowSuccessScreen(false); setDialogAmount(''); setPayCreditDialogOpen(true); }} className="h-6 px-3 bg-emerald-500 text-white font-black text-[9px] rounded">PAGAR DEUDA</Button>}
                      <Button isIconOnly size="sm" variant="light" className="h-6 w-6 text-gray-400 hover:text-sky-500" onPress={() => { setEditingClient({ ...c }); setEditDialogOpen(true); }}><Edit size={12} /></Button>
                      <Button isIconOnly size="sm" variant="light" className="h-6 w-6 text-gray-400 hover:text-rose-500" onPress={() => { setDeletingDni(c.dni); setDeleteDialogOpen(true); }}><Trash2 size={12} /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* MODAL DE PAGO */}
      <Modal isOpen={payCreditDialogOpen} onOpenChange={setPayCreditDialogOpen} backdrop="blur" size="full" classNames={{ base: "bg-gray-100 dark:bg-zinc-950 max-w-[1000px] h-auto md:max-h-[85vh]", closeButton: "hidden" }}>
        <ModalContent>
          {(onClose) => (
            <div className="flex flex-row h-full min-h-[400px] overflow-hidden rounded-2xl">
              {showSuccessScreen && (
                <div className="absolute inset-0 z-50 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md flex flex-col items-center justify-center p-8">
                  <div className="h-20 w-20 rounded-full bg-emerald-500 text-white flex items-center justify-center mb-4 shadow-lg"><Check size={40} strokeWidth={4} /></div>
                  <h2 className="text-xl font-black dark:text-white uppercase mb-6 italic tracking-widest">Abono Registrado</h2>
                  <div className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 p-8 rounded-2xl text-center shadow-xl">
                    <p className="text-[10px] font-bold text-gray-500 uppercase mb-2 tracking-widest">Cambio a entregar</p>
                    <p className="text-6xl font-black text-emerald-600 tabular-nums">${formatCurrency(lastChange)}</p>
                  </div>
                  <Button className="mt-8 bg-gray-900 text-white font-black px-10 h-12 rounded-xl italic" onPress={() => setPayCreditDialogOpen(false)}>CONTINUAR (ENTER)</Button>
                </div>
              )}
              <div className="w-[180px] bg-white dark:bg-zinc-900 border-r border-gray-200 dark:border-white/5 p-4 flex flex-col gap-2">
                <h3 className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1 italic">MÉTODO</h3>
                {(['cash', 'NEQUI', 'DAVIPLATA'] as const).map(tab => (
                  <button key={tab} onClick={() => { setActivePaymentTab(tab); setDialogAmount(''); setCashTendered(''); }} className={`h-11 px-4 rounded-lg flex items-center gap-3 border transition-all ${activePaymentTab === tab ? 'bg-emerald-500 text-white border-emerald-500 shadow-md' : 'bg-gray-50 dark:bg-zinc-800 border-transparent text-gray-500'}`}>
                    {tab === 'cash' ? <Banknote size={16} /> : <Zap size={16} />}
                    <span className="text-[10px] font-black uppercase italic">{tab === 'cash' ? 'Efectivo' : tab}</span>
                  </button>
                ))}
                <Button variant="flat" color="danger" className="mt-auto h-10 font-bold text-[10px]" onPress={onClose}>CANCELAR</Button>
              </div>
              <div className="flex-1 bg-gray-50 dark:bg-zinc-950 p-6 flex flex-col relative">
                <div className="flex gap-2 mb-6 shrink-0">
                  <div className="bg-white dark:bg-zinc-900 p-4 rounded-xl border border-gray-200 dark:border-white/5 flex-1"><p className="text-[8px] font-bold text-gray-500 uppercase mb-1">SALDO ACTUAL</p><p className="text-xl font-black text-rose-500">${formatCurrency(totalDebt)}</p></div>
                  <div className="bg-white dark:bg-zinc-900 p-4 rounded-xl border border-gray-200 dark:border-white/5 flex-1"><p className="text-[8px] font-bold text-gray-500 uppercase mb-1">NUEVO SALDO</p><p className="text-xl font-black text-emerald-500">${formatCurrency(Math.max(0, totalDebt - actualPayment))}</p></div>
                </div>
                {activePaymentTab === 'cash' ? (
                  <div className="flex flex-col flex-1 gap-2">
                    <div className="bg-white dark:bg-zinc-900 p-6 rounded-xl border border-gray-200 dark:border-white/5 flex flex-col justify-center shadow-sm"><p className="text-[9px] font-bold text-gray-400 uppercase mb-2">EFECTIVO RECIBIDO</p><p className="text-4xl font-black dark:text-white tabular-nums">${formatCurrency(amountToPay)}</p></div>
                    <div className="grid grid-cols-3 gap-2 mt-4">
                      {[100000, 50000, 20000, 10000, 5000, 2000].map(v => (
                        <Button key={v} className="h-12 bg-white dark:bg-zinc-900 hover:bg-emerald-500 hover:text-white dark:text-white text-sm font-black border border-gray-200 dark:border-white/5 shadow-sm" onPress={() => { setCashTendered(String(v)); setDialogAmount(''); }}>${v.toLocaleString()}</Button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center gap-4"><div className="h-24 w-24 rounded-full bg-emerald-100 dark:bg-emerald-500/10 flex items-center justify-center text-emerald-500 animate-pulse"><Zap size={40} /></div><p className="text-lg font-black dark:text-white italic uppercase">{activePaymentTab}</p></div>
                )}
              </div>
              <div className="w-[240px] bg-white dark:bg-zinc-900 border-l border-gray-200 dark:border-white/5 p-6 flex flex-col gap-4">
                <div className="bg-gray-50 dark:bg-zinc-950 p-4 rounded-xl border border-gray-200 dark:border-white/5 text-right"><p className="text-[8px] font-bold text-emerald-500 uppercase mb-1">DIGITANDO</p><p className="text-2xl font-black dark:text-white h-8">${formatCurrency(dialogAmount)}</p></div>
                <div className="grid grid-cols-3 gap-2 flex-1">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0, '00', 'CE'].map(n => (
                    <Button key={n} className={`h-full text-lg font-black rounded-lg ${n === 'CE' ? 'text-rose-500 bg-rose-50' : 'bg-gray-50 dark:bg-zinc-800'}`} onPress={() => n === 'CE' ? setDialogAmount('') : setDialogAmount(p => p + String(n))}>{n}</Button>
                  ))}
                </div>
                <Button className="h-16 bg-emerald-500 text-white font-black uppercase rounded-xl italic tracking-widest shadow-lg shadow-emerald-500/20" onPress={handlePayCredit} isLoading={submittingPayment}>ABONAR CAPITAL</Button>
              </div>
            </div>
          )}
        </ModalContent>
      </Modal>

      {/* MODALES CRUD */}
      <Modal isOpen={addDialogOpen || editDialogOpen} onOpenChange={(o) => { if (!o) { setAddDialogOpen(false); setEditDialogOpen(false); } }} backdrop="blur" classNames={{ base: "bg-white dark:bg-zinc-900" }}>
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="font-black uppercase text-sm border-b dark:text-white p-4 italic">{addDialogOpen ? 'Nuevo Registro' : 'Editar Datos'}</ModalHeader>
              <ModalBody className="p-4 gap-3">
                <div className="grid grid-cols-2 gap-2">
                  <Input 
                    size="sm" 
                    label="DNI" 
                    labelPlacement="outside"
                    value={addDialogOpen ? newClient.dni : editingClient?.dni} 
                    onValueChange={(v) => addDialogOpen ? setNewClient(p => ({ ...p, dni: v })) : setEditingClient(p => p ? { ...p, dni: v } : null)} 
                    isDisabled={!!editDialogOpen} 
                    classNames={{ inputWrapper: "bg-transparent border border-gray-200 dark:border-white/10 shadow-none focus-within:!border-emerald-500", input: "bg-transparent font-bold capitalize" }}
                  />
                  <Input 
                    size="sm" 
                    label="NOMBRE" 
                    labelPlacement="outside"
                    value={addDialogOpen ? newClient.name : editingClient?.name} 
                    onValueChange={(v) => addDialogOpen ? setNewClient(p => ({ ...p, name: v })) : setEditingClient(p => p ? { ...p, name: v } : null)} 
                    classNames={{ inputWrapper: "bg-transparent border border-gray-200 dark:border-white/10 shadow-none focus-within:!border-emerald-500", input: "bg-transparent font-bold capitalize" }}
                  />
                </div>
                <Input 
                  size="sm" 
                  label="TELÉFONO" 
                  labelPlacement="outside"
                  value={addDialogOpen ? newClient.phone : editingClient?.phone} 
                  onValueChange={(v) => addDialogOpen ? setNewClient(p => ({ ...p, phone: v })) : setEditingClient(p => p ? { ...p, phone: v } : null)} 
                  classNames={{ inputWrapper: "bg-transparent border border-gray-200 dark:border-white/10 shadow-none focus-within:!border-emerald-500", input: "bg-transparent font-bold" }}
                />
                <Input 
                  size="sm" 
                  label="DIRECCIÓN" 
                  labelPlacement="outside"
                  value={addDialogOpen ? newClient.address : editingClient?.address} 
                  onValueChange={(v) => addDialogOpen ? setNewClient(p => ({ ...p, address: v })) : setEditingClient(p => p ? { ...p, address: v } : null)} 
                  classNames={{ inputWrapper: "bg-transparent border border-gray-200 dark:border-white/10 shadow-none focus-within:!border-emerald-500", input: "bg-transparent font-bold capitalize" }}
                />
                <Input 
                  size="sm" 
                  label="CRÉDITO" 
                  labelPlacement="outside"
                  type="number" 
                  value={String(addDialogOpen ? newClient.creditLimit : (editingClient?.creditLimit || '0'))} 
                  onValueChange={(v) => addDialogOpen ? setNewClient(p => ({ ...p, creditLimit: v })) : setEditingClient(p => p ? { ...p, creditLimit: Number(v) } : null)} 
                  classNames={{ inputWrapper: "bg-transparent border border-gray-200 dark:border-white/10 shadow-none focus-within:!border-emerald-500", input: "bg-transparent font-bold" }}
                />
              </ModalBody>
              <ModalFooter className="p-4 border-t"><Button className="w-full bg-emerald-500 text-white font-black italic" onPress={addDialogOpen ? handleAddCustomer : handleEditCustomer}>GUARDAR REGISTRO</Button></ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      <Modal isOpen={deleteDialogOpen} onOpenChange={setDeleteDialogOpen} backdrop="blur" classNames={{ base: "bg-white dark:bg-zinc-900 rounded-xl" }}>
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="text-rose-500 font-black uppercase text-sm p-4 border-b border-gray-100 dark:border-white/5 italic">Confirmar Eliminación</ModalHeader>
              <ModalBody className="p-6 text-center text-xs font-bold text-gray-400 uppercase tracking-widest">¿Desea purgar este cliente del sistema maestro?</ModalBody>
              <ModalFooter className="p-4 flex gap-2"><Button variant="flat" size="sm" className="flex-1 font-black uppercase text-[10px] bg-transparent border border-gray-200 dark:border-white/10" onPress={() => setDeleteDialogOpen(false)}>CANCELAR</Button><Button color="danger" size="sm" className="flex-1 font-black uppercase text-[10px]" onPress={handleDeleteCustomer}>SÍ, ELIMINAR</Button></ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}