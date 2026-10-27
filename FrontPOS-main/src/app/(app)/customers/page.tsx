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
import { apiFetch, extractApiError } from '@/lib/api-error';
import { BOLD_QR_ALREADY_PAID_SENTINEL, buildIniciarPayload, generateQrClientTxId, isAlreadyPaidResponse } from '@/lib/bold-qr-helpers.mjs';
import { broadcastRevalidate, setupSyncListener } from '@/lib/revalidate';
import { normalizeText } from '@/lib/utils';
import { useAuth } from '@/lib/auth';

// Dinamicos para aligerar HMR y carga inicial
const UniversalPaymentModal = dynamic(() => import('@/components/shared/UniversalPaymentModal'), { ssr: false });
const CustomerFormModal = dynamic(() => import('./components/CustomerFormModal'), { ssr: false });
const DeleteCustomerModal = dynamic(() => import('./components/DeleteCustomerModal'), { ssr: false });
const CustomerStats = dynamic(() => import('./components/CustomerStats'), { ssr: false });
const CustomerTable = dynamic(() => import('./components/CustomerTable'), { ssr: false });
const ClientStatementModal = dynamic(() => import('./components/ClientStatementModal'), { ssr: false });

async function fetchCustomers(token: string): Promise<Customer[]> {
  const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/clients/all-clients`, {
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
        <div className="h-10 w-10 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 flex items-center justify-center text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] shrink-0 transition-transform active:scale-95">
          <Users size={20} />
        </div>
        <div className="flex flex-col">
          <h1 className="text-[13px] font-medium uppercase tracking-tighter leading-none tracking-tight">GESTION DE <span className="text-zinc-900 dark:text-zinc-100">CLIENTES</span></h1>
          <p className="text-[8px] font-medium text-gray-400 dark:text-zinc-600 uppercase tracking-[0.4em] mt-1 tracking-tight leading-none">Directorio Maestro V4.2</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          isIconOnly
          size="sm"
          onPress={onReload}
          isLoading={isLoading}
          className="h-10 w-10 card-base border-none dark:bg-[#18181b]/80 text-zinc-900 dark:text-zinc-100 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-gray-200 dark:border-white/5 active:scale-95 transition-all"
        >
          <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
        </Button>
        <Button
          size="sm"
          onPress={onAdd}
          className="h-10 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-zinc-900 dark:text-zinc-100 font-medium uppercase text-[9px] px-4 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] tracking-tight transition-all active:scale-95 shrink-0"
        >
          <PlusCircle size={16} />
          <span className="ml-2 tracking-widest">NUEVO</span>
        </Button>
      </div>
    </div>
    <Input
      size="sm"
      placeholder="RASTREAR POR NOMBRE / IDENTIFICACION..."
      value={filter}
      onValueChange={onSearch}
      classNames={{
        inputWrapper: "h-11 px-4 rounded-2xl bg-black/5 dark:bg-[#18181b] border border-gray-200 dark:border-white/5 focus-within:!border-emerald-500/30 transition-all w-full shadow-inner",
        input: "font-medium text-[11px] uppercase text-zinc-900 dark:text-zinc-50 placeholder:text-gray-400 dark:placeholder:text-zinc-600 bg-transparent tracking-widest tracking-tight"
      }}
      startContent={<Search size={14} className="text-zinc-900 dark:text-zinc-100 mr-1" />}
    />
  </header>
));
CustomerHeader.displayName = 'CustomerHeader';

export default function CustomersPage() {
  const { user } = useAuth();
  const isAdmin = user?.role?.toUpperCase() === 'ADMIN' || user?.role?.toUpperCase() === 'SUPERADMIN';
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [filter, setFilter] = useState('');

  // Paginacion (Sincronizada con Users/Suppliers)
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Estados de Modales
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [payCreditDialogOpen, setPayCreditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [statementDialogOpen, setStatementDialogOpen] = useState(false);

  // Estados de Datos
  const [newClient, setNewClient] = useState<Partial<Customer>>({ dni: '', name: '', phone: '', address: '', creditLimit: '' as any });
  const [editingClient, setEditingClient] = useState<Customer | null>(null);
  const [payingClient, setPayingClient] = useState<Customer | null>(null);
  const [deletingDni, setDeletingDni] = useState<string | null>(null);
  const [statementClient, setStatementClient] = useState<Customer | null>(null);

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

  useEffect(() => { 
    loadCustomers(); 
    
    // SINCRONIZACION ZERO-F5 (Clientes y Ventas afectan creditos)
    const cleanup = setupSyncListener((event) => {
        if (event === 'CUSTOMER_UPDATE' || event === 'SALE_MADE' || event === 'DASHBOARD_UPDATE') {
            loadCustomers();
        }
    });
    return cleanup;
  }, [loadCustomers]);

  // ZERO-F5 también dentro del modal de abonos: `payingClient` es una copia
  // tomada al abrir. Cuando la lista se recarga (SSE CUSTOMER_UPDATE tras un
  // abono por QR, otra caja, etc.) se sincroniza la deuda mostrada. Si la
  // deuda llegó a 0 fuera de este modal, se muestra la pantalla de éxito.
  useEffect(() => {
    if (!payingClient) return;
    const fresh = customers.find(c => c.dni === payingClient.dni);
    if (!fresh || Number(fresh.currentCredit) === Number(payingClient.currentCredit)) return;
    setPayingClient(fresh);
    if (payCreditDialogOpen && !submittingPayment && !showSuccessScreen && (Number(fresh.currentCredit) || 0) <= 0) {
      setLastChange(0);
      setShowSuccessScreen(true);
    }
  }, [customers, payingClient, payCreditDialogOpen, submittingPayment, showSuccessScreen]);

  // Logica de Filtrado y Paginacion
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

  // La logica de suma ahora la maneja el UniversalPaymentModal

  // Abono de fiado por QR / llave Daviplata: se abre un cobro QR marcado como
  // abono del cliente; cuando llega el SMS el servidor registra el abono
  // (pos_qr_abono.go). El abono por QR va completo por QR: si ya se agregó
  // efectivo u otro canal, se registra ese abono aparte.
  const prepareAbonoQrIntent = useCallback(async (
    amount: number,
    ventaTempId: string,
    breakdown: { cash: number; nequi: number; daviplata: number; credit: number; totalCart: number },
  ) => {
    if (!payingClient?.dni) throw new Error('Selecciona el cliente que abona');
    const monto = Math.round(Number(amount) || 0);
    if (monto <= 0) throw new Error('Monto inválido para el abono por QR');
    if ((breakdown?.cash || 0) > 0 || (breakdown?.nequi || 0) > 0 || (breakdown?.daviplata || 0) > 0) {
      throw new Error('El abono por QR debe ir completo por QR. Registra primero el efectivo como otro abono.');
    }
    const payload = buildIniciarPayload({
      caja_id: (typeof user?.dni === 'string' && user.dni.trim()) || 'CAJA',
      monto,
      venta_temp_id: ventaTempId,
      client_tx_id: generateQrClientTxId(),
      client_dni: payingClient.dni,
      cashier_name: user?.name || '',
      sale_payload: {
        details: [{ barcode: 'ABONO', quantity: 1, unitPrice: monto, subtotal: monto }],
        totalAmount: monto,
        amountPaid: monto,
        transferAmount: monto,
        transferSource: 'DAVIPLATA',
        paymentMethod: 'DAVIPLATA',
        employeeDni: user?.dni || '',
        clientDni: payingClient.dni,
        clientName: payingClient.name || '',
        abonoClientDni: payingClient.dni,
      },
    });
    if (!payload) throw new Error('Datos inválidos para el abono por QR');
    const res = await apiFetch('/pos/pagos-qr/iniciar', {
      method: 'POST',
      body: JSON.stringify(payload),
      fallbackError: 'No se pudo preparar el abono por QR',
      timeoutMs: 10000,
    });
    if (isAlreadyPaidResponse(res)) {
      toast({ title: 'YA PAGADO', description: 'Este abono por QR ya fue registrado.' });
      throw new Error(BOLD_QR_ALREADY_PAID_SENTINEL);
    }
  }, [payingClient, user, toast]);

  const handleAbonoQrFinalized = useCallback(() => {
    toast({ title: 'ABONO REGISTRADO', description: 'El abono por QR Daviplata quedó aplicado a la cuenta del cliente.' });
    setLastChange(0);
    setShowSuccessScreen(true);
    loadCustomers();
    broadcastRevalidate('CUSTOMER_UPDATE');
  }, [toast, loadCustomers]);

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
      
      const methodsCount = (cash > 0 ? 1 : 0) + (transfer > 0 ? 1 : 0);
      let paymentMethod = "EFECTIVO";
      if (methodsCount > 1) {
        paymentMethod = "MIXTO";
      } else if (transfer > 0) {
        paymentMethod = transferSource || "TRANSFERENCIA";
      }

      const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/clients/pay-credit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          clientDni: payingClient.dni,
          paymentMethod: paymentMethod,
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
      broadcastRevalidate('CUSTOMER_UPDATE');
    } catch (err: any) {
      toast({ variant: "destructive", title: "Error al procesar", description: err.message || "ERROR INESPERADO" });
    }
    finally { setSubmittingPayment(false); }
  };

  // Logica de busqueda rapida (Lookup) por DNI para evitar duplicados y facilitar edicion
  const handleLookupCustomer = useCallback(async (dni: string) => {
    const token = Cookies.get('org-pos-token');
    const existing = customers.find(c => c.dni === dni);
    if (existing) {
      toast({ variant: "success", title: "CLIENTE IDENTIFICADO", description: "ACCEDIENDO A FICHA EXISTENTE..." });
      setNewClient({ dni: '', name: '', phone: '', address: '', creditLimit: '' as any });
      setAddDialogOpen(false);
      setEditingClient({ ...existing });
      setEditDialogOpen(true);
      return;
    }
    // Si no esta local, podriamos buscar en API, pero por ahora local es suficiente
    toast({ variant: "success", title: "DNI DISPONIBLE", description: "PUEDE PROCEDER CON EL REGISTRO" });
  }, [customers, toast]);

  // Acciones CRUD
  const handleAddCustomer = async () => {
    const token = Cookies.get('org-pos-token');
    try {
      const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/clients/create-client`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ 
          ...newClient, 
          name: normalizeText(newClient.name), 
          address: normalizeText(newClient.address),
          creditLimit: Number(newClient.creditLimit) 
        })
      });
      if (!res.ok) {
        const errorMsg = await extractApiError(res, "FALLO AL CREAR CLIENTE");
        throw new Error(errorMsg);
      }
      toast({ variant: "success", title: "EXITO", description: "CLIENTE REGISTRADO EN MAESTRO" }); setAddDialogOpen(false);
      setNewClient({ dni: '', name: '', phone: '', address: '', creditLimit: '' as any }); loadCustomers();
      broadcastRevalidate('CUSTOMER_UPDATE');
    } catch (err: any) { toast({ variant: "destructive", title: "Error", description: err.message || "FALLO AL CREAR" }); }
  };

  const handleEditCustomer = async () => {
    if (!editingClient) return;
    const token = Cookies.get('org-pos-token');
    try {
      const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/clients/update-client/${editingClient.dni}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ 
          ...editingClient, 
          name: normalizeText(editingClient.name), 
          address: normalizeText(editingClient.address),
          creditLimit: Number(editingClient.creditLimit) 
        })
      });
      if (!res.ok) {
        const errorMsg = await extractApiError(res, "FALLO AL ACTUALIZAR CLIENTE");
        throw new Error(errorMsg);
      }
      toast({ variant: "success", title: "SINCRONIZADO", description: "PERFIL ACTUALIZADO CORRECTAMENTE" }); setEditDialogOpen(false); loadCustomers();
      broadcastRevalidate('CUSTOMER_UPDATE');
    } catch (err: any) { toast({ variant: "destructive", title: "Error", description: err.message || "FALLO AL ACTUALIZAR" }); }
  };

  const handleDeleteCustomer = async () => {
    if (!deletingDni) return;
    const token = Cookies.get('org-pos-token');
    try {
      const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/clients/delete-client/${deletingDni}`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) {
        const errorMsg = await extractApiError(res, "FALLO AL ELIMINAR CLIENTE");
        throw new Error(errorMsg);
      }
      toast({ variant: "success", title: "ELIMINADO", description: "REGISTRO RETIRADO DEL MAESTRO" }); setDeleteDialogOpen(false); setDeletingDni(null); loadCustomers();
      broadcastRevalidate('CUSTOMER_UPDATE');
    } catch (err: any) { toast({ variant: "destructive", title: "Error al borrar", description: err.message || "FALLO AL ELIMINAR" }); }
  };

  if (loading) return <div className="flex-1 h-full w-full flex items-center justify-center bg-zinc-50 dark:bg-[#09090b] flex-col gap-4">
    <Spinner color="success" size="lg" />
    <p className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-[0.4em] animate-pulse tracking-tight">Sincronizando Directorio...</p>
  </div>;

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full w-full max-w-[1600px] mx-auto overflow-hidden bg-transparent text-zinc-900 dark:text-zinc-50 transition-all duration-500 relative">

      {/* HEADER SECTION: FIXED (TOP) - PARIDAD TOTAL CON USERS/SUPPLIERS */}
      <div className="shrink-0 px-3 pt-1.5 pb-2 flex flex-col gap-3 md:gap-4 border-b border-gray-200/50 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-950/50">
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
      <div className="px-1 md:px-2 py-1 flex flex-col flex-1 min-h-0 overflow-hidden">
        <CustomerTable
          customers={currentCustomers}
          onPay={(c) => { setPayingClient(c); setShowSuccessScreen(false); setPayCreditDialogOpen(true); }}
          onEdit={(c) => { setEditingClient({ ...c }); setEditDialogOpen(true); }}
          onDelete={(dni) => { setDeletingDni(dni); setDeleteDialogOpen(true); }}
          onViewStatement={(c) => { setStatementClient(c); setStatementDialogOpen(true); }}
          currentPage={page}
          totalPages={totalPages}
          pageSize={pageSize}
          totalRecords={filteredCustomers.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          onAdd={() => setAddDialogOpen(true)}
          isAdmin={isAdmin}
        />
      </div>



      {/* Modals con carga dinamica */}
      <UniversalPaymentModal
        isOpen={payCreditDialogOpen}
        onOpenChange={(open) => {
          setPayCreditDialogOpen(open);
          if (!open) setShowSuccessScreen(false);
        }}
        title="Gestion de Abonos"
        client={payingClient}
        totalToPay={Number(payingClient?.currentCredit || 0)}
        showSuccessScreen={showSuccessScreen}
        submittingPayment={submittingPayment}
        lastChange={lastChange}
        onPay={handlePayCredit}
        onBoldQrRequested={prepareAbonoQrIntent}
        onBoldQrFinalized={handleAbonoQrFinalized}
        showCreditTab={false}
        isAbono={true}
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

      <ClientStatementModal
        isOpen={statementDialogOpen}
        onOpenChange={setStatementDialogOpen}
        customer={statementClient}
      />

    </div>
  );
}








