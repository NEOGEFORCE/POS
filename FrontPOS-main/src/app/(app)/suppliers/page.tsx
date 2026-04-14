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

// Dinámicos para optimización de carga
const SupplierStats = dynamic(() => import('./components/SupplierStats'), { ssr: false });
const SupplierTable = dynamic(() => import('./components/SupplierTable'), { ssr: false });
const SupplierFormModal = dynamic(() => import('./components/SupplierFormModal'), { ssr: false });
const DeleteSupplierModal = dynamic(() => import('./components/DeleteSupplierModal'), { ssr: false });

async function fetchSuppliers(token: string): Promise<Supplier[]> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/suppliers/all-suppliers`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('Error al cargar proveedores');
  const data = await res.json();
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
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/suppliers/create-suppliers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ ...newSupplier, name })
      });
      if (!res.ok) throw new Error();
      toast({ variant: 'success', title: 'ÉXITO', description: 'VÍNCULO CREADO CORRECTAMENTE' });
      setAddDialogOpen(false);
      setNewSupplier({ name: '', phone: '', address: '' });
      loadSuppliers();
    } catch { toast({ variant: 'destructive', title: 'ERROR', description: 'FALLO EN OPERACIÓN' }); }
  };

  const handleEditSupplier = async () => {
    if (!editingSupplier) return;
    const name = editingSupplier.name?.trim().toUpperCase();
    const token = Cookies.get('org-pos-token');
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/suppliers/update-suppliers/${editingSupplier.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ ...editingSupplier, name })
      });
      if (!res.ok) throw new Error();
      toast({ variant: 'success', title: 'ÉXITO', description: 'REGISTRO ACTUALIZADO' });
      setEditDialogOpen(false);
      loadSuppliers();
    } catch { toast({ variant: 'destructive', title: 'ERROR', description: 'FALLO AL GUARDAR' }); }
  };

  const handleDeleteSupplier = async () => {
    if (!deletingId) return;
    const token = Cookies.get('org-pos-token') || localStorage.getItem('org-pos-token');
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/suppliers/delete-suppliers/${deletingId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error();
      toast({ variant: 'success', title: 'ÉXITO', description: 'VÍNCULO ELIMINADO' });
      setDeleteDialogOpen(false);
      setDeletingId(null);
      loadSuppliers();
    } catch { toast({ variant: 'destructive', title: 'ERROR', description: 'FALLO AL ELIMINAR' }); }
  };

  if (loading) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner color="success" size="lg" /></div>;

  return (
    <div className="flex flex-col min-h-screen gap-3 p-3 bg-gray-100 dark:bg-zinc-950 transition-all duration-700 pb-20">
      
      {/* Header Premium Zero Friction */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-2xl shrink-0 shadow-sm relative overflow-hidden">
        <div className="absolute top-0 right-0 p-4 opacity-5 text-emerald-500 scale-150"><Truck size={120} /></div>
        
        <div className="flex items-center gap-4 relative z-10">
          <div className="bg-emerald-500 p-3 rounded-2xl text-white shadow-lg shadow-emerald-500/20 rotate-3">
            <Truck size={24} />
          </div>
          <div className="flex flex-col">
            <h1 className="text-xl font-black dark:text-white uppercase leading-none italic tracking-tighter">
              Directorio de <span className="text-emerald-500">Proveedores</span>
            </h1>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[9px] font-black text-emerald-500 uppercase tracking-[0.3em]">Red de Abastecimiento</span>
              <div className="h-1 w-1 bg-gray-300 rounded-full" />
              <div className="flex items-center gap-1 text-[9px] font-bold text-gray-400 uppercase tracking-widest italic">
                <Clock size={10} /> {new Date().toLocaleDateString()}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 relative z-10">
          <div className="relative group/search">
            <Input 
              size="sm" 
              placeholder="RASTREAR FIRMA O SEDE..." 
              value={filter} 
              onValueChange={(v) => { setFilter(v.toUpperCase()); setCurrentPage(1); }} 
              startContent={<Search size={16} className="text-gray-400 group-focus-within/search:text-emerald-500 transition-colors" />} 
              classNames={{ 
                inputWrapper: "h-11 w-full md:w-80 bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-inner rounded-xl group-focus-within/search:border-emerald-500/50 transition-all", 
                input: "text-[11px] font-black bg-transparent tracking-widest italic uppercase" 
              }} 
            />
          </div>
          <Button 
            size="sm" 
            onPress={() => setAddDialogOpen(true)} 
            className="h-11 px-6 bg-emerald-500 text-white font-black text-[11px] rounded-xl shadow-lg shadow-emerald-500/20 hover:scale-105 active:scale-95 transition-all italic tracking-widest uppercase"
          >
            <PlusCircle size={16} className="mr-1" /> NUEVA FIRMA
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