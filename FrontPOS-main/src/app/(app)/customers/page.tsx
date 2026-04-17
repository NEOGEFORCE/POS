"use client";

import { useEffect, useState, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import {
  Button, Input, Spinner
} from "@heroui/react";

import {
  Users, Search, PlusCircle, LayoutGrid, Clock
} from 'lucide-react';

import { useToast } from '@/hooks/use-toast';
import { Customer } from '@/lib/definitions';
import Cookies from 'js-cookie';
import { extractApiError } from '@/lib/api-error';

// Dinámicos para aligerar HMR y carga inicial
const PayCreditModal = dynamic(() => import('./components/PayCreditModal'), { ssr: false });
const CustomerFormModal = dynamic(() => import('./components/CustomerFormModal'), { ssr: false });
const DeleteCustomerModal = dynamic(() => import('./components/DeleteCustomerModal'), { ssr: false });
const CustomerStats = dynamic(() => import('./components/CustomerStats'), { ssr: false });
const CustomerTable = dynamic(() => import('./components/CustomerTable'), { ssr: false });

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
  const [newClient, setNewClient] = useState<Partial<Customer>>({ dni: '', name: '', phone: '', address: '', creditLimit: 0 });
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

  const loadCustomers = useCallback(async () => {
    const token = Cookies.get('org-pos-token');
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

  const filteredCustomers = useMemo(() => {
    return customers.filter(c =>
      c.name.toLowerCase().includes(filter.toLowerCase()) ||
      c.dni.includes(filter)
    );
  }, [customers, filter]);

  const statsValues = useMemo(() => {
    const totalDebt = customers.reduce((acc, c) => acc + (Number(c.currentCredit) || 0), 0);
    const withDebt = customers.filter(c => (Number(c.currentCredit) || 0) > 0).length;
    return { totalDebt, withDebt, totalClients: customers.length };
  }, [customers]);

  const handlePayCredit = async () => {
    if (!payingClient) return;
    setSubmittingPayment(true);
    const token = Cookies.get('org-pos-token');
    try {
      const totalDebtVal = Number(payingClient.currentCredit || 0);
      const currentDialogVal = Number(dialogAmount) || 0;
      const amountToPayRaw = currentDialogVal > 0 ? currentDialogVal : (Number(cashTendered) > 0 ? Number(cashTendered) : totalDebtVal);
      const actualPaymentValue = Math.min(amountToPayRaw, totalDebtVal);
      const displayChange = activePaymentTab === 'cash' ? Math.max(0, amountToPayRaw - totalDebtVal) : 0;

      const numCash = activePaymentTab === 'cash' ? actualPaymentValue : 0;
      const numTransfer = activePaymentTab !== 'cash' ? actualPaymentValue : 0;
      const tSource = activePaymentTab !== 'cash' ? activePaymentTab : '';

      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/clients/pay-credit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          clientDni: payingClient.dni,
          amountCash: numCash,
          amountTransfer: numTransfer,
          transferSource: tSource,
          totalPaid: actualPaymentValue
        })
      });
      if (!res.ok) {
        const errorMsg = await extractApiError(res, "Error al procesar pago");
        throw new Error(errorMsg);
      }

      setLastChange(displayChange);
      setShowSuccessScreen(true);
      loadCustomers();
    } catch (err: any) { 
        toast({ variant: "destructive", title: "Error al procesar", description: err.message || "ERROR INESPERADO" }); 
    }
    finally { setSubmittingPayment(false); }
  };

  // Acciones CRUD (memoizadas)
  const handleAddCustomer = async () => {
    const token = Cookies.get('org-pos-token');
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/clients/create-client`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ ...newClient, creditLimit: Number(newClient.creditLimit) })
      });
      if (!res.ok) {
        const errorMsg = await extractApiError(res, "FALLO AL CREAR CLIENTE");
        throw new Error(errorMsg);
      }
      toast({ title: "Cliente Creado" }); setAddDialogOpen(false);
      setNewClient({ dni: '', name: '', phone: '', address: '', creditLimit: 0 }); loadCustomers();
    } catch (err: any) { toast({ variant: "destructive", title: "Error", description: err.message || "FALLO AL CREAR" }); }
  };

  const handleEditCustomer = async () => {
    if (!editingClient) return;
    const token = Cookies.get('org-pos-token');
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/clients/update-client/${editingClient.dni}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ ...editingClient, creditLimit: Number(editingClient.creditLimit) })
      });
      if (!res.ok) {
        const errorMsg = await extractApiError(res, "FALLO AL ACTUALIZAR CLIENTE");
        throw new Error(errorMsg);
      }
      toast({ title: "Actualizado" }); setEditDialogOpen(false); loadCustomers();
    } catch (err: any) { toast({ variant: "destructive", title: "Error", description: err.message || "FALLO AL ACTUALIZAR" }); }
  };

  const handleDeleteCustomer = async () => {
    if (!deletingDni) return;
    const token = Cookies.get('org-pos-token');
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/clients/delete-client/${deletingDni}`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) {
        const errorMsg = await extractApiError(res, "FALLO AL ELIMINAR CLIENTE");
        throw new Error(errorMsg);
      }
      toast({ title: "Eliminado" }); setDeleteDialogOpen(false); setDeletingDni(null); loadCustomers();
    } catch (err: any) { toast({ variant: "destructive", title: "Error al borrar", description: err.message || "FALLO AL ELIMINAR" }); }
  };

  // Teclado (mejorado)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!payCreditDialogOpen) return;
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (e.key === 'Enter' && showSuccessScreen) { e.preventDefault(); setShowSuccessScreen(false); setPayCreditDialogOpen(false); return; }
      if (!showSuccessScreen && !isInput) {
        if (/^[0-9]$/.test(e.key)) { e.preventDefault(); setDialogAmount(p => p + e.key); }
        if (e.key === 'Backspace') { e.preventDefault(); setDialogAmount(p => p.slice(0, -1)); }
        if (e.key === 'Enter') { e.preventDefault(); handlePayCredit(); }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [payCreditDialogOpen, showSuccessScreen, dialogAmount, activePaymentTab, payingClient]);

  if (loading) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner color="success" size="lg" /></div>;

  return (
    <div className="flex flex-col min-h-[100dvh] gap-3 p-3 bg-gray-100 dark:bg-zinc-950 transition-all duration-700 pb-20 items-center">
      <div className="w-full max-w-[1600px] flex flex-col gap-3">
      {/* Header Premium Zero Friction */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 bg-white/90 dark:bg-zinc-900/50 backdrop-blur-2xl border-b border-gray-200 dark:border-white/5 rounded-[2rem] shrink-0 shadow-xl relative overflow-hidden group">
        <div className="absolute top-0 right-0 p-4 opacity-5 text-emerald-500 scale-150 rotate-3 transition-transform duration-1000 group-hover:rotate-12"><Users size={120} /></div>
        
        <div className="flex items-center gap-4 relative z-10">
          <div className="bg-emerald-500 p-3 rounded-2xl text-white shadow-lg shadow-emerald-500/20 rotate-3">
            <Users size={24} />
          </div>
          <div className="flex flex-col">
            <h1 className="text-xl font-black dark:text-white uppercase leading-none italic tracking-tighter">
              Gestión de <span className="text-emerald-500">Clientes</span>
            </h1>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[9px] font-black text-emerald-500 uppercase tracking-[0.3em]">Directorio Maestro</span>
              <div className="h-1 w-1 bg-gray-300 rounded-full" />
              <div className="flex items-center gap-1 text-[9px] font-bold text-gray-400 uppercase tracking-widest">
                <Clock size={10} /> {new Date().toLocaleDateString()}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 relative z-10">
          <div className="relative group/search">
            <Input 
              size="sm" 
              placeholder="RASTREAR POR NOMBRE / NIT..." 
              value={filter} 
              onValueChange={(v) => setFilter(v.toUpperCase())} 
              startContent={<Search size={16} className="text-gray-400 group-focus-within/search:text-emerald-500 transition-colors" />} 
              classNames={{ 
                inputWrapper: "h-11 w-full md:w-80 bg-gray-50/50 dark:bg-black/20 backdrop-blur-md border border-gray-200 dark:border-white/10 shadow-inner rounded-2xl group-focus-within/search:border-emerald-500/50 transition-all", 
                input: "text-[11px] font-black bg-transparent tracking-widest italic" 
              }} 
            />
          </div>
          <Button 
            size="sm" 
            onPress={() => setAddDialogOpen(true)} 
            className="h-11 px-6 bg-emerald-500 text-white font-black text-[11px] rounded-xl shadow-lg shadow-emerald-500/20 hover:scale-105 active:scale-95 transition-all italic tracking-widest"
          >
            <PlusCircle size={16} className="mr-1" /> NUEVO
          </Button>
        </div>
      </header>

      {/* Stats Section */}
      <CustomerStats 
        totalDebt={statsValues.totalDebt}
        totalClients={statsValues.totalClients}
        withDebt={statsValues.withDebt}
      />

      {/* Main Table Section */}
      <CustomerTable 
        customers={filteredCustomers}
        onPay={(c) => { setPayingClient(c); setShowSuccessScreen(false); setDialogAmount(''); setPayCreditDialogOpen(true); }}
        onEdit={(c) => { setEditingClient({ ...c }); setEditDialogOpen(true); }}
        onDelete={(dni) => { setDeletingDni(dni); setDeleteDialogOpen(true); }}
      />

      {/* Modals con carga dinámica */}
      <PayCreditModal 
        isOpen={payCreditDialogOpen}
        onOpenChange={setPayCreditDialogOpen}
        client={payingClient}
        activePaymentTab={activePaymentTab}
        setActivePaymentTab={setActivePaymentTab}
        dialogAmount={dialogAmount}
        setDialogAmount={setDialogAmount}
        cashTendered={cashTendered}
        setCashTendered={setCashTendered}
        showSuccessScreen={showSuccessScreen}
        setShowSuccessScreen={setShowSuccessScreen}
        submittingPayment={submittingPayment}
        lastChange={lastChange}
        onPay={handlePayCredit}
      />

      <CustomerFormModal 
        isOpen={addDialogOpen || editDialogOpen}
        onOpenChange={(o) => { if (!o) { setAddDialogOpen(false); setEditDialogOpen(false); } }}
        isEdit={editDialogOpen}
        customer={addDialogOpen ? newClient : editingClient}
        setCustomer={addDialogOpen ? setNewClient : setEditingClient}
        onSave={addDialogOpen ? handleAddCustomer : handleEditCustomer}
      />

      <DeleteCustomerModal 
        isOpen={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteCustomer}
      />
      </div>
    </div>
  );
}