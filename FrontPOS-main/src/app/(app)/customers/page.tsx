"use client";

import { useEffect, useState, useMemo, useCallback, memo } from 'react';
import dynamic from 'next/dynamic';
import {
  Button, Input, Spinner
} from "@heroui/react";

import {
  Users, Search, PlusCircle, Clock, RefreshCw, LayoutGrid
} from 'lucide-react';

import { useToast } from '@/hooks/use-toast';
import { Customer } from '@/lib/definitions';
import Cookies from 'js-cookie';
import { extractApiError } from '@/lib/api-error';

// Dinámicos para aligerar HMR y carga inicial
const UniversalPaymentModal = dynamic(() => import('@/components/shared/UniversalPaymentModal'), { ssr: false });
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

// COMPONENTE HEADER MEMOIZADO PARA RENDIMIENTO (PARIDAD CON USERS/SUPPLIERS)
const CustomerHeader = memo(({ filter, onSearch, onAdd, onReload, isLoading }: {
  filter: string,
  onSearch: (v: string) => void,
  onAdd: () => void,
  onReload: () => void,
  isLoading: boolean
}) => (
  <header className="flex flex-col gap-2.5 transition-all">
    <div className="flex items-center justify-between px-1">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-emerald-500 flex items-center justify-center text-white shadow-xl shadow-emerald-500/20 shrink-0 transition-transform active:scale-95">
          <Users size={20} />
        </div>
        <div className="flex flex-col">
          <h1 className="text-[13px] font-black uppercase tracking-tighter leading-none italic">GESTIÓN DE <span className="text-emerald-500">CLIENTES</span></h1>
          <p className="text-[8px] font-black text-gray-400 dark:text-zinc-600 uppercase tracking-[0.4em] mt-1 italic leading-none">Directorio Maestro V4.2</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          isIconOnly
          size="sm"
          onPress={onReload}
          isLoading={isLoading}
          className="h-10 w-10 bg-white/80 dark:bg-zinc-900/80 text-emerald-500 rounded-xl shadow-sm border border-gray-200 dark:border-white/5 active:scale-95 transition-all"
        >
          <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
        </Button>
        <Button
          size="sm"
          onPress={onAdd}
          className="h-10 bg-emerald-500 text-white font-black uppercase text-[9px] px-4 rounded-xl shadow-lg shadow-emerald-500/20 italic transition-all active:scale-95 shrink-0"
        >
          <PlusCircle size={16} />
          <span className="ml-2 tracking-widest">NUEVO</span>
        </Button>
      </div>
    </div>
    <Input
      size="sm"
      placeholder="RASTREAR POR NOMBRE / IDENTIFICACIÓN..."
      value={filter}
      onValueChange={onSearch}
      classNames={{
        inputWrapper: "h-11 px-4 rounded-xl bg-white/50 dark:bg-black/20 border border-gray-200 dark:border-white/5 focus-within:!border-emerald-500/30 transition-all w-full shadow-inner",
        input: "font-black text-[11px] uppercase text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 bg-transparent tracking-widest italic"
      }}
      startContent={<Search size={14} className="text-emerald-500 mr-1" />}
    />
  </header>
));
CustomerHeader.displayName = 'CustomerHeader';

export default function CustomersPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [filter, setFilter] = useState('');

  // Paginación (Sincronizada con Users/Suppliers)
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

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

  // Lógica de Filtrado y Paginación
  const filteredCustomers = useMemo(() => {
    return customers.filter(c =>
      c.name.toLowerCase().includes(filter.toLowerCase()) ||
      c.dni.includes(filter)
    );
  }, [customers, filter]);

  const totalPages = Math.ceil(filteredCustomers.length / pageSize) || 1;

  const currentCustomers = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredCustomers.slice(start, start + pageSize);
  }, [filteredCustomers, page, pageSize]);

  const statsValues = useMemo(() => {
    const totalDebt = customers.reduce((acc, c) => acc + (Number(c.currentCredit) || 0), 0);
    const withDebt = customers.filter(c => (Number(c.currentCredit) || 0) > 0).length;
    return { totalDebt, withDebt, totalClients: customers.length };
  }, [customers]);

  // La lógica de suma ahora la maneja el UniversalPaymentModal

  const handlePayCredit = async (paymentData: {
    cash: number;
    transfer: number;
    transferSource: string;
    totalPaid: number;
    change: number;
  }) => {
    if (!payingClient) return;
    setSubmittingPayment(true);
    const token = Cookies.get('org-pos-token');
    try {
      const { cash, transfer, transferSource, totalPaid, change } = paymentData;

      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/clients/pay-credit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          clientDni: payingClient.dni,
          amountCash: cash,
          amountTransfer: transfer,
          transferSource: transferSource,
          totalPaid: totalPaid // actualPaymentValue
        })
      });
      if (!res.ok) {
        const errorMsg = await extractApiError(res, "Error al procesar pago");
        throw new Error(errorMsg);
      }

      setLastChange(change);
      setShowSuccessScreen(true);
      loadCustomers();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Error al procesar", description: err.message || "ERROR INESPERADO" });
    }
    finally { setSubmittingPayment(false); }
  };

  // Lógica de búsqueda rápida (Lookup) por DNI para evitar duplicados y facilitar edición
  const handleLookupCustomer = useCallback(async (dni: string) => {
    const token = Cookies.get('org-pos-token');
    const existing = customers.find(c => c.dni === dni);
    if (existing) {
      toast({ variant: "success", title: "CLIENTE IDENTIFICADO", description: "ACCEDIENDO A FICHA EXISTENTE..." });
      setNewClient({ dni: '', name: '', phone: '', address: '', creditLimit: 0 });
      setAddDialogOpen(false);
      setEditingClient({ ...existing });
      setEditDialogOpen(true);
      return;
    }
    // Si no está local, podríamos buscar en API, pero por ahora local es suficiente
    toast({ variant: "success", title: "DNI DISPONIBLE", description: "PUEDE PROCEDER CON EL REGISTRO" });
  }, [customers, toast]);

  // Acciones CRUD
  const handleAddCustomer = async () => {
    const token = Cookies.get('org-pos-token');
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/clients/create-client`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ ...newClient, name: newClient.name?.toUpperCase(), creditLimit: Number(newClient.creditLimit) })
      });
      if (!res.ok) {
        const errorMsg = await extractApiError(res, "FALLO AL CREAR CLIENTE");
        throw new Error(errorMsg);
      }
      toast({ variant: "success", title: "ÉXITO", description: "CLIENTE REGISTRADO EN MAESTRO" }); setAddDialogOpen(false);
      setNewClient({ dni: '', name: '', phone: '', address: '', creditLimit: 0 }); loadCustomers();
    } catch (err: any) { toast({ variant: "destructive", title: "Error", description: err.message || "FALLO AL CREAR" }); }
  };

  const handleEditCustomer = async () => {
    if (!editingClient) return;
    const token = Cookies.get('org-pos-token');
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/clients/update-client/${editingClient.dni}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ ...editingClient, name: editingClient.name.toUpperCase(), creditLimit: Number(editingClient.creditLimit) })
      });
      if (!res.ok) {
        const errorMsg = await extractApiError(res, "FALLO AL ACTUALIZAR CLIENTE");
        throw new Error(errorMsg);
      }
      toast({ variant: "success", title: "SINCRONIZADO", description: "PERFIL ACTUALIZADO CORRECTAMENTE" }); setEditDialogOpen(false); loadCustomers();
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
      toast({ variant: "success", title: "ELIMINADO", description: "REGISTRO RETIRADO DEL MAESTRO" }); setDeleteDialogOpen(false); setDeletingDni(null); loadCustomers();
    } catch (err: any) { toast({ variant: "destructive", title: "Error al borrar", description: err.message || "FALLO AL ELIMINAR" }); }
  };

  // Teclado ahora se maneja en el UniversalPaymentModal

  if (loading) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950 flex-col gap-4">
    <Spinner color="success" size="lg" />
    <p className="text-[10px] font-black text-emerald-500 uppercase tracking-[0.4em] animate-pulse italic">Sincronizando Directorio...</p>
  </div>;

  return (
    <div className="flex flex-col w-full max-w-[1600px] mx-auto h-full min-h-0 bg-transparent text-gray-900 dark:text-white transition-all duration-500 overflow-hidden relative">

      {/* HEADER SECTION: FIXED (TOP) - PARIDAD TOTAL CON USERS/SUPPLIERS */}
      <div className="shrink-0 px-3 pt-1.5 pb-2 flex flex-col gap-3 md:gap-4 border-b border-gray-200/50 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-950/50 backdrop-blur-md">
        <CustomerHeader
          filter={filter}
          onSearch={(v) => { setFilter(v.toUpperCase()); setPage(1); }}
          onAdd={() => setAddDialogOpen(true)}
          onReload={loadCustomers}
          isLoading={loading}
        />
        <CustomerStats
          totalDebt={statsValues.totalDebt}
          totalClients={statsValues.totalClients}
          withDebt={statsValues.withDebt}
        />
      </div>

      {/* CONTENT SECTION (SCROLLABLE) */}
      <div className="flex-1 min-h-0 overflow-hidden px-1 md:px-2 py-1 flex flex-col">
        <CustomerTable
          customers={currentCustomers}
          onPay={(c) => { setPayingClient(c); setShowSuccessScreen(false); setDialogAmount(''); setPayCreditDialogOpen(true); }}
          onEdit={(c) => { setEditingClient({ ...c }); setEditDialogOpen(true); }}
          onDelete={(dni) => { setDeletingDni(dni); setDeleteDialogOpen(true); }}
          currentPage={page}
          totalPages={totalPages}
          pageSize={pageSize}
          totalRecords={filteredCustomers.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          onAdd={() => setAddDialogOpen(true)}
        />
      </div>



      {/* Modals con carga dinámica */}
      <UniversalPaymentModal
        isOpen={payCreditDialogOpen}
        onOpenChange={(open) => {
          setPayCreditDialogOpen(open);
          if (!open) setShowSuccessScreen(false);
        }}
        title="Gestión de Abonos"
        client={payingClient}
        totalToPay={Number(payingClient?.currentCredit || 0)}
        showSuccessScreen={showSuccessScreen}
        submittingPayment={submittingPayment}
        lastChange={lastChange}
        onPay={handlePayCredit}
        showCreditTab={false}
      />

      <CustomerFormModal
        isOpen={addDialogOpen || editDialogOpen}
        onOpenChange={(o) => { if (!o) { setAddDialogOpen(false); setEditDialogOpen(false); setEditingClient(null); } }}
        isEdit={editDialogOpen}
        customer={addDialogOpen ? newClient : editingClient}
        setCustomer={addDialogOpen ? setNewClient : setEditingClient}
        onSave={addDialogOpen ? handleAddCustomer : handleEditCustomer}
        onLookupDni={handleLookupCustomer}
      />

      <DeleteCustomerModal
        isOpen={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteCustomer}
      />

    </div>
  );
}