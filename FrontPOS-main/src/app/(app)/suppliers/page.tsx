"use client";

import { useEffect, useState, useMemo, useCallback, memo } from 'react';
import dynamic from 'next/dynamic';
import { Button, Input, Spinner } from "@heroui/react";
import {
  Truck, Search, PlusCircle, Clock, Sparkles, RefreshCw
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Supplier } from '@/lib/definitions';
import Cookies from 'js-cookie';
import { apiFetch } from '@/lib/api-error';

// Dinámicos para optimización de carga
const SupplierStats = dynamic(() => import('./components/SupplierStats'), { ssr: false });
const SupplierTable = dynamic(() => import('./components/SupplierTable'), { ssr: false });
const SupplierFormModal = dynamic(() => import('./components/SupplierFormModal'), { ssr: false });
const DeleteSupplierModal = dynamic(() => import('./components/DeleteSupplierModal'), { ssr: false });

async function fetchSuppliers(token: string): Promise<Supplier[]> {
  const data = await apiFetch('/suppliers/all-suppliers', {
    method: 'GET',
    fallbackError: 'FALLO AL CARGAR PROVEEDORES'
  }, token);
  return Array.isArray(data) ? data : [];
}

// COMPONENTE HEADER MEMOIZADO PARA RENDIMIENTO
const SupplierHeader = memo(({ filter, onSearch, onAdd, onReload, isLoading }: {
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
          <Truck size={20} />
        </div>
        <div className="flex flex-col">
          <h1 className="text-[13px] font-black uppercase tracking-tighter leading-none italic">DIRECTORIO <span className="text-emerald-500">LOGÍSTICO</span></h1>
          <p className="text-[8px] font-black text-gray-400 dark:text-zinc-600 uppercase tracking-[0.4em] mt-1">Abastecimiento Maestro V4.0</p>
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
      placeholder="RASTREAR POR NOMBRE / NIT..."
      value={filter}
      onValueChange={onSearch}
      classNames={{
        inputWrapper: "h-11 px-4 rounded-xl bg-white/50 dark:bg-black/20 border border-gray-200 dark:border-white/5 focus-within:!border-emerald-500/30 transition-all w-full shadow-inner",
        input: "font-black text-[11px] uppercase text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 bg-transparent tracking-widest"
      }}
      startContent={<Search size={14} className="text-emerald-500 mr-1" />}
    />
  </header>
));
SupplierHeader.displayName = 'SupplierHeader';

export default function SuppliersPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [filter, setFilter] = useState('');

  // Paginación
  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);

  // Modales
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Estados de Datos
  const [newSupplier, setNewSupplier] = useState<Partial<Supplier>>({ name: '', phone: '', address: '' });
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [deletingId, setDeletingId] = useState<string | number | null>(null);

  const loadSuppliers = useCallback(async () => {
    const token = Cookies.get('org-pos-token');
    if (!token) { setLoading(false); return; }
    try {
      const data = await fetchSuppliers(token);
      setSuppliers(data);
    } catch {
      toast({ variant: "destructive", title: "ERROR", description: "FALLO AL SINCRONIZAR PROVEEDORES." });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadSuppliers(); }, [loadSuppliers]);

  const filteredSuppliers = useMemo(() => {
    const query = filter.toLowerCase();
    return suppliers.filter((s: Supplier) =>
      s.name.toLowerCase().includes(query) ||
      (s.phone && s.phone.includes(query)) ||
      (s.address && s.address.toLowerCase().includes(query))
    );
  }, [suppliers, filter]);

  const paginatedSuppliers = useMemo(() =>
    filteredSuppliers.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [filteredSuppliers, currentPage, pageSize]
  );

  const totalPages = Math.ceil(filteredSuppliers.length / pageSize || 1);

  const stats = useMemo(() => ({
    total: suppliers.length,
    withPhone: suppliers.filter(s => !!s.phone).length
  }), [suppliers]);

  // Handlers
  const handleAddSupplier = async (data: any) => {
    const name = data.name?.trim().toUpperCase();
    if (!name) return toast({ variant: 'destructive', title: 'ERROR', description: 'NOMBRE REQUERIDO' });

    const token = Cookies.get('org-pos-token');
    try {
      await apiFetch('/suppliers/create-suppliers', {
        method: 'POST',
        body: JSON.stringify({ ...data, name }),
        fallbackError: 'FALLO AL CREAR PROVEEDOR'
      }, token!);
      // Recargar datos ANTES de cerrar modal para mostrar cambios inmediatamente
      await loadSuppliers();
      toast({
        variant: "success",
        title: "ÉXITO",
        description: "VÍNCULO CREADO CORRECTAMENTE",
      });
      setAddDialogOpen(false);
      setNewSupplier({ name: '', phone: '', address: '' } as any);
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'ERROR', description: err.message || 'FALLO AL CREAR PROVEEDOR' });
    }
  };

  const handleEditSupplier = async (data: any) => {
    if (!data) return;
    const name = data.name?.trim().toUpperCase();
    const token = Cookies.get('org-pos-token');
    try {
      await apiFetch(`/suppliers/update-suppliers/${data.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...data, name }),
        fallbackError: 'FALLO AL ACTUALIZAR PROVEEDOR'
      }, token!);
      // Recargar datos ANTES de cerrar modal para mostrar cambios inmediatamente
      await loadSuppliers();
      toast({
        title: "ÉXITO",
        description: "REGISTRO ACTUALIZADO",
        className: "bg-emerald-500 text-white border-none"
      });
      setEditDialogOpen(false);
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'ERROR', description: err.message || 'FALLO AL ACTUALIZAR PROVEEDOR' });
    }
  };

  const handleDeleteSupplier = async () => {
    if (!deletingId) return;
    const token = Cookies.get('org-pos-token') || localStorage.getItem('org-pos-token');
    try {
      await apiFetch(`/suppliers/delete-suppliers/${deletingId}`, {
        method: 'DELETE',
        fallbackError: 'FALLO AL ELIMINAR PROVEEDOR'
      }, token!);
      toast({ variant: 'success', title: 'ÉXITO', description: 'VÍNCULO ELIMINADO' });
      setDeleteDialogOpen(false);
      setDeletingId(null);
      loadSuppliers();
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'ERROR', description: err.message || 'FALLO AL ELIMINAR PROVEEDOR' });
    }
  };

  if (loading) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950 flex-col gap-4">
    <Spinner color="success" size="lg" />
    <p className="text-[10px] font-black text-emerald-500 uppercase tracking-[0.4em] animate-pulse">Sincronizando Logística...</p>
  </div>;

  return (
    <div className="flex flex-col w-full max-w-[1600px] mx-auto h-full min-h-0 bg-transparent text-gray-900 dark:text-white transition-all duration-500 overflow-hidden relative">

      {/* HEADER SECTION: FIXED (TOP) */}
      <div className="shrink-0 px-4 py-4 flex flex-col gap-3 md:gap-5 border-b border-gray-200/50 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-950/50 backdrop-blur-md">
        <SupplierHeader
          filter={filter}
          onSearch={(v) => { setFilter(v.toUpperCase()); setCurrentPage(1); }}
          onAdd={() => setAddDialogOpen(true)}
          onReload={loadSuppliers}
          isLoading={loading}
        />
        <SupplierStats total={stats.total} withPhone={stats.withPhone} />
      </div>

      {/* CONTENT SECTION (SCROLLABLE) */}
      <div className="flex-1 min-h-0 overflow-hidden px-1 md:px-2 py-1 flex flex-col min-w-0">
        <SupplierTable
          suppliers={paginatedSuppliers}
          currentPage={currentPage}
          totalPages={totalPages}
          pageSize={pageSize}
          totalFiltered={filteredSuppliers.length}
          onEdit={(s) => { setEditingSupplier({ ...s }); setEditDialogOpen(true); }}
          onDelete={(id) => { setDeletingId(id); setDeleteDialogOpen(true); }}
          onPageChange={setCurrentPage}
          onPageSizeChange={(s) => { setPageSize(s); setCurrentPage(1); }}
        />

        <SupplierFormModal
          isOpen={addDialogOpen || editDialogOpen}
          onOpenChange={(o) => { if (!o) { setAddDialogOpen(false); setEditDialogOpen(false); setEditingSupplier(null); } }}
          isEdit={editDialogOpen}
          supplier={addDialogOpen ? null : editingSupplier}
          onLookupName={(name) => {
            if (!addDialogOpen) return;
            const existing = suppliers.find(s => s.name.toUpperCase() === name.trim().toUpperCase());
            if (existing) {
              toast({
                variant: "success",
                title: "PROVEEDOR DETECTADO",
                description: "CARGANDO FICHA LOGÍSTICA EXISTENTE..."
              });
              setAddDialogOpen(false);
              setEditingSupplier(existing);
              setEditDialogOpen(true);
            }
          }}
          onSave={async (data) => {
            if (addDialogOpen) await handleAddSupplier(data);
            else await handleEditSupplier(data);
          }}
        />

        <DeleteSupplierModal
          isOpen={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          onConfirm={handleDeleteSupplier}
        />
      </div>
    </div>
  );
}