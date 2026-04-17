"use client";

import { useEffect, useState, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { Button, Input, Spinner } from "@heroui/react";
import { 
  Truck, Search, PlusCircle, Clock, Sparkles 
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
  const handleAddSupplier = async () => {
    const name = newSupplier.name?.trim().toUpperCase();
    if (!name) return toast({ variant: 'destructive', title: 'ERROR', description: 'NOMBRE REQUERIDO' });
    
    const token = Cookies.get('org-pos-token');
    try {
      await apiFetch('/suppliers/create-suppliers', {
        method: 'POST',
        body: JSON.stringify({ ...newSupplier, name }),
        fallbackError: 'FALLO AL CREAR PROVEEDOR'
      }, token!);
      toast({ variant: 'success', title: 'ÉXITO', description: 'VÍNCULO CREADO CORRECTAMENTE' });
      setAddDialogOpen(false);
      setNewSupplier({ name: '', phone: '', address: '' });
      loadSuppliers();
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'ERROR', description: err.message || 'FALLO AL CREAR PROVEEDOR' });
    }
  };

  const handleEditSupplier = async () => {
    if (!editingSupplier) return;
    const name = editingSupplier.name?.trim().toUpperCase();
    const token = Cookies.get('org-pos-token');
    try {
      await apiFetch(`/suppliers/update-suppliers/${editingSupplier.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...editingSupplier, name }),
        fallbackError: 'FALLO AL ACTUALIZAR PROVEEDOR'
      }, token!);
      toast({ variant: 'success', title: 'ÉXITO', description: 'REGISTRO ACTUALIZADO' });
      setEditDialogOpen(false);
      loadSuppliers();
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

  if (loading) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner color="success" size="lg" /></div>;

  return (
    <div className="flex flex-col gap-6 md:gap-8 max-w-[1600px] mx-auto px-4 md:px-6 pb-20 w-full min-h-[100dvh]">
      
      {/* HEADER TACTICO */}
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 pt-6">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <div className="bg-emerald-500 w-14 h-14 rounded-[1.5rem] text-white shadow-2xl shadow-emerald-500/20 flex items-center justify-center transform -rotate-6 group hover:rotate-0 transition-all">
              <Truck size={32} />
            </div>
            <div className="flex flex-col">
              <h1 className="text-3xl md:text-5xl font-black text-gray-900 dark:text-white tracking-tighter uppercase italic leading-none">
                Directorio <span className="text-emerald-500">Logístico</span>
              </h1>
              <p className="text-[10px] md:text-xs font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.4em] italic ml-1 mt-2 flex items-center gap-2">
                <Sparkles size={12} className="text-emerald-500" /> Red de Abastecimiento Corporativo
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 bg-white/50 dark:bg-zinc-900/50 backdrop-blur-md p-1.5 rounded-[1.5rem] border border-gray-200 dark:border-white/5 shadow-inner">
          <div className="relative group/search shrink-0">
            <Input 
              placeholder="RASTREAR FIRMA..." 
              value={filter} 
              onValueChange={(v) => { setFilter(v.toUpperCase()); setCurrentPage(1); }} 
              startContent={<Search size={16} className="text-gray-400 group-focus-within/search:text-emerald-500 transition-colors" />} 
              classNames={{ 
                inputWrapper: "h-12 w-full md:w-64 bg-gray-50/80 dark:bg-zinc-950/50 border border-transparent group-focus-within/search:!border-emerald-500/50 transition-all shadow-inner rounded-2xl", 
                input: "text-[10px] font-black bg-transparent tracking-[0.2em] italic uppercase" 
              }} 
            />
          </div>
          <Button 
            onPress={() => setAddDialogOpen(true)} 
            className="h-12 px-8 bg-emerald-500 text-white font-black text-[10px] uppercase tracking-widest italic rounded-2xl shadow-xl shadow-emerald-500/20 hover:scale-105 transition-transform"
          >
            <PlusCircle size={16} className="mr-2" /> NUEVA FIRMA
          </Button>
        </div>
      </header>

      {/* KPIs */}
      <SupplierStats total={stats.total} withPhone={stats.withPhone} />

      {/* Main Table Content */}
      <SupplierTable 
        suppliers={paginatedSuppliers}
        currentPage={currentPage}
        totalPages={totalPages}
        pageSize={pageSize}
        totalFiltered={filteredSuppliers.length}
        onEdit={(s) => { setEditingSupplier({...s}); setEditDialogOpen(true); }}
        onDelete={(id) => { setDeletingId(id); setDeleteDialogOpen(true); }}
        onPageChange={setCurrentPage}
        onPageSizeChange={(s) => { setPageSize(s); setCurrentPage(1); }}
      />

      {/* Modals */}
      <SupplierFormModal 
        isOpen={addDialogOpen || editDialogOpen}
        onOpenChange={(o) => { if (!o) { setAddDialogOpen(false); setEditDialogOpen(false); setEditingSupplier(null); setNewSupplier({ name: '', phone: '', address: '' }); } }}
        isEdit={editDialogOpen}
        supplier={addDialogOpen ? newSupplier : editingSupplier}
        setSupplier={addDialogOpen ? setNewSupplier : setEditingSupplier}
        onSave={async () => {
          if (addDialogOpen) await handleAddSupplier();
          else await handleEditSupplier();
        }}
      />

      <DeleteSupplierModal 
        isOpen={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteSupplier}
      />
    </div>
  );
}