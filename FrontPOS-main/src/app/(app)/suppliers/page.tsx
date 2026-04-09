"use client";

import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, Input, Spinner
} from "@heroui/react";
import {
  Truck, PlusCircle, Edit, Trash2, Search, AlertTriangle,
  Building2, Zap, Sparkles, X, Phone, MapPin
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Supplier } from '@/lib/definitions';

async function fetchSuppliers(token: string): Promise<Supplier[]> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/suppliers/all-suppliers`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('Error al cargar proveedores');
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export default function SuppliersPage() {
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const [newSupplier, setNewSupplier] = useState<Partial<Supplier>>({ name: '', phone: '', address: '' });
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [deletingId, setDeletingId] = useState<string | number | null>(null);

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const { toast } = useToast();

  // PAGINACIÓN
  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);

  const loadSuppliers = useCallback(() => {
    const token = localStorage.getItem('org-pos-token');
    if (!token) { setLoading(false); return; }
    setLoading(true);
    fetchSuppliers(token).then(setSuppliers).catch(() => toast({ variant: "destructive", title: "Error de conexión" })).finally(() => setLoading(false));
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

  const paginatedSuppliers = useMemo(() => filteredSuppliers.slice((currentPage - 1) * pageSize, currentPage * pageSize), [filteredSuppliers, currentPage, pageSize]);
  const totalPages = Math.ceil(filteredSuppliers.length / pageSize || 1);

  const stats = useMemo(() => {
    return { total: suppliers.length, withPhone: suppliers.filter(s => !!s.phone).length };
  }, [suppliers]);

  const handleAddSupplier = async () => {
    const token = localStorage.getItem('org-pos-token');
    const finalName = newSupplier.name?.trim().toUpperCase();
    if (!finalName) {
      toast({ variant: 'destructive', title: 'Error', description: 'La razón social no puede estar vacía' });
      return;
    }

    if (suppliers.some(s => s.name.toUpperCase().trim() === finalName)) {
      toast({ variant: 'destructive', title: 'Registro Bloqueado', description: `La firma ${finalName} ya está en la base de datos.` });
      return;
    }

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/suppliers/create-suppliers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ ...newSupplier, name: finalName })
      });
      if (!res.ok) throw new Error('Error');
      toast({ title: 'Éxito', description: 'Proveedor registrado.' });
      setAddDialogOpen(false);
      setNewSupplier({ name: '', phone: '', address: '' });
      loadSuppliers();
    } catch (error: any) { toast({ variant: 'destructive', title: 'Error al registrar' }); }
  };

  const handleEditSupplier = async () => {
    if (!editingSupplier) return;
    const token = localStorage.getItem('org-pos-token');
    
    const finalName = editingSupplier.name?.trim().toUpperCase();
    if (!finalName) {
      toast({ variant: 'destructive', title: 'Error', description: 'La razón social no puede estar vacía' });
      return;
    }

    if (suppliers.some(s => s.id !== editingSupplier.id && s.name.toUpperCase().trim() === finalName)) {
      toast({ variant: 'destructive', title: 'Edición Bloqueada', description: `Esa razón social ya pertenece a otro proveedor registrado.` });
      return;
    }

    try {
      const { id, ...data } = editingSupplier;
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/suppliers/update-suppliers/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ ...data, name: finalName })
      });
      if (!res.ok) throw new Error('Error');
      toast({ title: 'Éxito', description: 'Proveedor actualizado.' });
      setEditDialogOpen(false);
      loadSuppliers();
    } catch (error: any) { toast({ variant: 'destructive', title: 'Error al actualizar' }); }
  };

  const handleDeleteSupplier = async () => {
    if (!deletingId) return;
    const token = localStorage.getItem('org-pos-token');
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/suppliers/delete-suppliers/${deletingId}`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Error');
      toast({ title: 'PURGA COMPLETADA' });
      setDeleteDialogOpen(false);
      setDeletingId(null);
      loadSuppliers();
    } catch (error: any) { toast({ variant: 'destructive', title: 'Error al purgar registro' }); }
  };

  if (loading) return <div className="h-screen w-full flex items-center justify-center bg-[#0a0a0a]"><Spinner color="success" size="lg" /></div>;

  return (
    <div className="flex flex-col h-[100dvh] w-full max-w-full min-w-0 gap-3 p-3 bg-[#0a0a0a] text-white overflow-hidden select-none">

      {/* HEADER MASTER (VERDE ESMERALDA) */}
      <header className="flex flex-col md:flex-row items-center justify-between gap-4 p-4 bg-zinc-950 border border-white/5 rounded-2xl shrink-0">
        <div className="flex items-center gap-3 w-full md:w-auto">
          <div className="h-10 w-10 rounded-xl bg-emerald-500 flex items-center justify-center text-black shadow-lg shadow-emerald-500/20">
            <Truck size={20} />
          </div>
          <div className="flex flex-col">
            <span className="text-lg font-black uppercase italic tracking-tighter leading-none">PROVEEDORES</span>
            <span className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest mt-1">Supply Chain V4.0</span>
          </div>
        </div>

        <div className="flex items-center gap-3 w-full md:w-auto">
          <div className="relative w-full md:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
            <Input
              placeholder="BUSCAR..."
              value={filter} onValueChange={(v) => { setFilter(v.toUpperCase()); setCurrentPage(1); }}
              classNames={{
                inputWrapper: "h-10 pl-9 pr-4 rounded-xl bg-zinc-900 border border-white/5 focus-within:border-emerald-500/50 transition-colors",
                input: "font-black text-[11px] uppercase italic text-white placeholder:text-zinc-600"
              }}
            />
          </div>
          <Button onPress={() => setAddDialogOpen(true)} className="bg-emerald-500 text-black font-black uppercase text-[10px] h-10 px-6 rounded-xl shrink-0 shadow-lg shadow-emerald-500/20">
            <PlusCircle size={14} className="mr-1" /> NUEVA FIRMA
          </Button>
        </div>
      </header>

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 shrink-0">
        {[
          { label: "ABASTECEDORES ACTIVOS", val: stats.total, color: "emerald", icon: Building2 },
          { label: "LÍNEAS DE CONTACTO", val: stats.withPhone, color: "emerald", icon: Phone },
          { label: "ESTADO DE CONECTIVIDAD", val: "ESTABLE", color: "white", icon: Zap }
        ].map((k, i) => (
          <div key={i} className="bg-zinc-950 p-4 border border-white/5 rounded-2xl flex items-center justify-between group">
            <div className="flex flex-col">
              <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest mb-1">{k.label}</span>
              <span className={`text-2xl font-black tabular-nums text-${k.color}-500 ${k.color !== 'white' && 'italic'} leading-none tracking-tighter`}>{k.val}</span>
            </div>
            <k.icon size={24} className={`text-${k.color}-500 opacity-20`} />
          </div>
        ))}
      </div>

      {/* TABLA PRINCIPAL */}
      <div className="flex-1 bg-zinc-950 border border-white/5 rounded-2xl overflow-hidden flex flex-col min-h-0 min-w-0 w-full">
        <div className="flex-1 overflow-y-auto overflow-x-hidden w-full custom-scrollbar">
          <Table isCompact removeWrapper aria-label="Directorio Proveedores" classNames={{ th: "bg-zinc-950 text-zinc-500 font-black uppercase text-[9px] tracking-widest h-12 py-2 border-b border-white/5 sticky top-0 z-10", td: "py-4 font-medium border-b border-white/5", tr: "hover:bg-white/5 transition-colors" }}>
            <TableHeader>
              <TableColumn className="pl-3 md:pl-6">RAZÓN SOCIAL</TableColumn>
              <TableColumn align="center">CONTACTO</TableColumn>
              <TableColumn align="start" className="hidden sm:table-cell">SEDE FÍSICA</TableColumn>
              <TableColumn align="end" className="pr-3 md:pr-6">ACCIONES</TableColumn>
            </TableHeader>
            <TableBody emptyContent={<div className="py-20 text-[11px] font-black text-zinc-600 uppercase text-center italic tracking-widest">Sin abastecedores registrados</div>}>
              {paginatedSuppliers.map((supplier) => (
                <TableRow key={supplier.id}>
                  <TableCell className="pl-3 md:pl-6">
                    <div className="flex items-center gap-3 md:gap-4">
                      <div className="h-8 w-8 md:h-10 md:w-10 rounded-xl bg-zinc-900 border border-white/5 flex items-center justify-center text-emerald-500 shrink-0">
                        <Building2 size={16} className="md:w-[18px] md:h-[18px]" />
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="text-xs md:text-sm font-black text-white uppercase leading-tight italic truncate max-w-[120px] md:max-w-[400px]">{supplier.name}</span>
                        <span className="text-[8px] md:text-[9px] text-zinc-500 font-mono tracking-widest mt-0.5 md:mt-1">ID: #{supplier.id}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-center px-1 md:px-3">
                    <div className="inline-flex items-center gap-1.5 md:gap-2 px-2 py-1 md:px-3 md:py-1.5 rounded-lg bg-zinc-900 border border-white/5">
                      <Phone size={10} className="text-zinc-500 md:w-3 md:h-3" />
                      <span className="text-[10px] md:text-xs font-black text-white tabular-nums tracking-widest italic">{supplier.phone || 'S.T.'}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <div className="flex items-center gap-2">
                      <MapPin size={12} className="text-zinc-600 shrink-0" />
                      <span className="text-[10px] font-black text-zinc-400 uppercase tracking-tighter italic truncate max-w-[150px] md:max-w-[250px]">{supplier.address || 'NO REGISTRADA'}</span>
                    </div>
                  </TableCell>
                  <TableCell className="pr-3 md:pr-6">
                    <div className="flex justify-end gap-1.5 md:gap-2">
                      <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 md:h-9 md:w-9 bg-zinc-900 text-emerald-500 rounded-xl hover:bg-emerald-500 hover:text-black border border-white/5" onPress={() => { setEditingSupplier(supplier); setEditDialogOpen(true); }}>
                        <Edit size={14} />
                      </Button>
                      <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 md:h-9 md:w-9 bg-zinc-900 text-rose-500 rounded-xl hover:bg-rose-500 hover:text-white border border-white/5" onPress={() => { setDeletingId(supplier.id); setDeleteDialogOpen(true); }}>
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* PAGINACIÓN */}
        {filteredSuppliers.length > 0 && (
          <div className="px-6 py-3 flex items-center justify-between border-t border-white/5 bg-zinc-950 shrink-0">
            <p className="text-[9px] font-black text-zinc-500 uppercase tracking-widest leading-none">
              VISTA: <span className="text-white italic">{((currentPage - 1) * pageSize + 1)}-{Math.min(currentPage * pageSize, filteredSuppliers.length)}</span> / <span className="text-emerald-500 italic">{filteredSuppliers.length}</span>
            </p>
            <div className="flex items-center gap-4">
              <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setCurrentPage(1); }} className="h-7 bg-zinc-900 text-zinc-400 text-[9px] font-black uppercase tracking-widest px-2 outline-none rounded-lg border border-white/5 cursor-pointer">
                {[10, 20, 50, 100].map(n => <option key={n} value={n} className="bg-black">{n} REGISTROS</option>)}
              </select>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="flat" onPress={() => setCurrentPage(prev => Math.max(1, prev - 1))} isDisabled={currentPage === 1} className="h-7 px-3 bg-zinc-900 text-white font-black text-[9px] uppercase border border-white/5 rounded-lg hover:bg-zinc-800">PREV</Button>
                <span className="text-[10px] font-black text-white italic px-2 tabular-nums">{currentPage} / {totalPages}</span>
                <Button size="sm" variant="flat" onPress={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))} isDisabled={currentPage === totalPages || totalPages === 0} className="h-7 px-3 bg-zinc-900 text-white font-black text-[9px] uppercase border border-white/5 rounded-lg hover:bg-zinc-800">NEXT</Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* MODAL CREAR/EDITAR */}
      <Modal placement="top-center" isOpen={addDialogOpen || editDialogOpen} onOpenChange={(o) => { if (!o) { setAddDialogOpen(false); setEditDialogOpen(false); setEditingSupplier(null); } }} backdrop="blur" size="2xl" classNames={{ base: "bg-[#0a0a0a] rounded-3xl border border-white/10", closeButton: "text-zinc-500 hover:text-white" }}>
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex flex-col gap-1 p-6 border-b border-white/5 bg-zinc-950">
                <h2 className="text-2xl font-black text-white italic tracking-tighter uppercase leading-none flex items-center gap-3">
                  <div className="p-3 bg-emerald-500/10 text-emerald-500 rounded-xl"><Truck size={24} /></div>
                  {addDialogOpen ? "Nuevo " : "Actualizar "} <span className="text-emerald-500">Vínculo</span>
                </h2>
                <p className="text-[9px] font-black text-zinc-500 uppercase tracking-widest mt-2 ml-[3.5rem]">Arquitectura de Suministro Maestro</p>
              </ModalHeader>

              <ModalBody className="p-8 gap-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-zinc-500 uppercase tracking-widest italic ml-1">Razón Social o Nombre</label>
                  <Input
                    value={addDialogOpen ? newSupplier.name : editingSupplier?.name}
                    onValueChange={(v) => {
                      if (addDialogOpen) setNewSupplier(p => ({ ...p, name: v.toUpperCase() }));
                      else setEditingSupplier(p => p ? { ...p, name: v.toUpperCase() } : null);
                    }}
                    placeholder="EJ: DISTRIBUIDORA GLOBAL S.A.S..."
                    classNames={{ inputWrapper: "h-14 bg-zinc-950 border border-white/10 rounded-xl focus-within:border-emerald-500/50", input: "font-black text-sm uppercase italic text-white" }}
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-zinc-500 uppercase tracking-widest italic ml-1">Canal Telefónico</label>
                    <Input
                      value={addDialogOpen ? newSupplier.phone : editingSupplier?.phone}
                      onValueChange={(v) => {
                        if (addDialogOpen) setNewSupplier(p => ({ ...p, phone: v }));
                        else setEditingSupplier(p => p ? { ...p, phone: v } : null);
                      }}
                      placeholder="+57..."
                      startContent={<Phone size={14} className="text-zinc-600 mr-1" />}
                      classNames={{ inputWrapper: "h-14 bg-zinc-950 border border-white/10 rounded-xl focus-within:border-emerald-500/50", input: "font-black text-sm uppercase italic text-white" }}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-zinc-500 uppercase tracking-widest italic ml-1">Sede Física / Dirección</label>
                    <Input
                      value={addDialogOpen ? newSupplier.address : editingSupplier?.address}
                      onValueChange={(v) => {
                        if (addDialogOpen) setNewSupplier(p => ({ ...p, address: v.toUpperCase() }));
                        else setEditingSupplier(p => p ? { ...p, address: v.toUpperCase() } : null);
                      }}
                      placeholder="CIUDAD, CALLE..."
                      startContent={<MapPin size={14} className="text-zinc-600 mr-1" />}
                      classNames={{ inputWrapper: "h-14 bg-zinc-950 border border-white/10 rounded-xl focus-within:border-emerald-500/50", input: "font-black text-sm uppercase italic text-white" }}
                    />
                  </div>
                </div>
              </ModalBody>

              <ModalFooter className="p-6 border-t border-white/5 bg-zinc-950">
                <Button
                  className="w-full h-14 bg-white text-black hover:bg-emerald-500 hover:text-black font-black uppercase text-xs tracking-widest rounded-xl transition-all shadow-xl hover:shadow-emerald-500/20"
                  onPress={addDialogOpen ? handleAddSupplier : handleEditSupplier}
                >
                  <Sparkles size={16} className="mr-2" />
                  {addDialogOpen ? "VINCULAR ABASTECEDOR MAESTRO" : "SINCRONIZAR ACTUALIZACIÓN MAESTRA"}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* MODAL ELIMINAR */}
      <Modal isOpen={deleteDialogOpen} onOpenChange={setDeleteDialogOpen} backdrop="blur" classNames={{ base: "bg-[#0a0a0a] rounded-3xl border border-white/10", closeButton: "text-zinc-500" }}>
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="text-rose-500 font-black uppercase text-sm p-6 italic flex items-center gap-2">
                <AlertTriangle size={18} /> Protocolo de Purga
              </ModalHeader>
              <ModalBody className="p-6 text-center text-xs font-bold text-zinc-500 uppercase leading-relaxed tracking-widest italic">
                ¿Seguro que desea eliminar permanentemente este proveedor del directorio maestro? Perderá el rastro de sus despachos.
              </ModalBody>
              <ModalFooter className="p-6 pt-2 flex gap-2 border-t border-white/5">
                <Button variant="flat" className="flex-1 font-black text-[10px] bg-zinc-900 text-white" onPress={onClose}>MANTENER ENLACE</Button>
                <Button color="danger" className="flex-1 font-black text-[10px] bg-rose-600 text-white" onPress={handleDeleteSupplier}>SÍ, PURGAR</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}