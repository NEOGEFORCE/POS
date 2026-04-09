"use client";

import { useEffect, useState, useMemo } from 'react';
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, Input, Spinner
} from "@heroui/react";
import { PlusCircle, Shapes, Edit, Trash2, Zap, LayoutGrid, Sparkles, FolderTree, Search, AlertTriangle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Category } from '@/lib/definitions';

async function fetchCategories(token: string): Promise<Category[]> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/categories/all-categories`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('Error al cargar categorías');
  const data = await res.json();
  const categories = data.map((cat: any) => ({ ...cat, productCount: cat.productCount || 0 }));
  return categories.sort((a: Category, b: Category) => a.name.localeCompare(b.name));
}

export default function CategoriesPage() {
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const [newCategoryName, setNewCategoryName] = useState('');
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const { toast } = useToast();

  // PAGINACIÓN LIGERA (Para mantener consistencia)
  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);

  const loadCategories = () => {
    const token = localStorage.getItem('org-pos-token');
    if (!token) { setLoading(false); return; }
    setLoading(true);
    fetchCategories(token)
      .then(setCategories)
      .catch(() => toast({ variant: "destructive", title: "Error de conexión" }))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadCategories(); }, []);

  const filteredCategories = useMemo(() => {
    const query = filter.toLowerCase();
    return categories.filter((c: Category) =>
      c.name.toLowerCase().includes(query) ||
      String(c.id).includes(query)
    );
  }, [categories, filter]);

  const paginatedCategories = useMemo(() => filteredCategories.slice((currentPage - 1) * pageSize, currentPage * pageSize), [filteredCategories, currentPage, pageSize]);
  const totalPages = Math.ceil(filteredCategories.length / pageSize || 1);

  const stats = useMemo(() => {
    const total = categories.length;
    const topCat = [...categories].sort((a, b) => b.productCount - a.productCount)[0]?.name || 'NINGUNA';
    const totalProds = categories.reduce((acc, c) => acc + c.productCount, 0);
    return { total, topCat, totalProds };
  }, [categories]);

  const handleAddCategory = async () => {
    const token = localStorage.getItem('org-pos-token');
    if (!newCategoryName.trim()) return;
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/categories/create-categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name: newCategoryName.toUpperCase() })
      });
      if (!res.ok) throw new Error('Error');
      toast({ title: 'Éxito', description: 'Categoría creada.' });
      setAddDialogOpen(false);
      setNewCategoryName('');
      loadCategories();
    } catch (error: any) { toast({ variant: 'destructive', title: 'Error', description: 'No se pudo crear la categoría' }); }
  };

  const handleEditCategory = async () => {
    if (!editingCategory) return;
    const token = localStorage.getItem('org-pos-token');
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/categories/update-categories/${editingCategory.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name: editingCategory.name.toUpperCase() })
      });
      if (!res.ok) throw new Error('Error');
      toast({ title: 'Éxito', description: 'Categoría actualizada.' });
      setEditDialogOpen(false);
      loadCategories();
    } catch (error: any) { toast({ variant: 'destructive', title: 'Error', description: 'No se pudo actualizar' }); }
  };

  const handleDeleteCategory = async () => {
    if (!deletingId) return;
    const token = localStorage.getItem('org-pos-token');
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/categories/delete-categories/${deletingId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Error');
      toast({ title: 'PURGA COMPLETADA', description: 'Categoría eliminada.' });
      setDeleteDialogOpen(false);
      setDeletingId(null);
      loadCategories();
    } catch (error: any) { toast({ variant: 'destructive', title: 'Error', description: 'Error al purgar registro' }); }
  };

  if (loading) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner color="success" size="lg" /></div>;

  return (
    <div className="flex flex-col h-screen gap-2 p-2 bg-gray-50 dark:bg-zinc-950 text-gray-900 dark:text-white overflow-hidden select-none transition-colors duration-500">

      {/* HEADER QUE RESPETA CLARO/OSCURO */}
      <header className="flex flex-col md:flex-row items-center justify-between gap-4 p-4 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-2xl shrink-0 shadow-sm transition-colors">
        <div className="flex items-center gap-3 w-full md:w-auto">
          <div className="h-12 w-12 rounded-xl bg-emerald-500/10 flex items-center justify-center text-emerald-500 shadow-inner">
            <LayoutGrid size={24} />
          </div>
          <div className="flex flex-col">
            <span className="text-xl font-black uppercase italic tracking-tighter leading-none">CATEGORÍAS</span>
            <span className="text-[9px] font-black text-emerald-500 uppercase tracking-widest mt-1">Taxonomy Engine V5.0</span>
          </div>
        </div>

        <div className="flex items-center gap-3 w-full md:w-auto">
          <div className="relative w-full md:w-64 group">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 group-focus-within:text-emerald-500 transition-colors" />
            <Input
              placeholder="BUSCAR DEPARTAMENTO..."
              value={filter} onValueChange={(v) => { setFilter(v.toUpperCase()); setCurrentPage(1); }}
              classNames={{
                inputWrapper: "h-10 pl-10 pr-4 rounded-xl bg-gray-100 dark:bg-black border border-gray-200 dark:border-white/5 focus-within:border-emerald-500/50 transition-colors shadow-inner",
                input: "font-black text-xs uppercase italic text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-600"
              }}
            />
          </div>
          <Button onPress={() => setAddDialogOpen(true)} className="bg-emerald-500 text-white font-black uppercase text-[10px] h-10 px-6 rounded-xl shrink-0 shadow-lg shadow-emerald-500/20 italic tracking-widest hover:scale-105 transition-transform">
            <PlusCircle size={16} className="mr-1" /> NUEVA CATEGORÍA
          </Button>
        </div>
      </header>

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 shrink-0">
        {[
          { label: "DEPARTAMENTOS", val: stats.total, color: "emerald", icon: Shapes },
          { label: "TOP DENSIDAD", val: stats.topCat, color: "emerald", icon: Zap },
          { label: "ARTÍCULOS ASIGNADOS", val: stats.totalProds, color: "emerald", icon: FolderTree }
        ].map((k, i) => (
          <div key={i} className="bg-white dark:bg-zinc-900 p-4 border border-gray-200 dark:border-white/5 rounded-2xl flex items-center justify-between shadow-sm transition-colors">
            <div className="flex flex-col min-w-0 pr-2">
              <span className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest mb-1">{k.label}</span>
              <span className="text-2xl font-black tabular-nums text-emerald-500 italic leading-none tracking-tighter truncate">{k.val}</span>
            </div>
            <k.icon size={24} className="text-emerald-500 opacity-20 shrink-0" />
          </div>
        ))}
      </div>

      {/* TABLA PRINCIPAL (DISEÑO SLIM) */}
      <div className="flex-1 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-2xl overflow-hidden flex flex-col min-h-0 shadow-sm transition-colors">
        <div className="flex-1 overflow-auto custom-scrollbar">
          <Table isCompact removeWrapper aria-label="Jerarquía de Categorías" classNames={{ th: "bg-gray-50 dark:bg-zinc-950 text-gray-400 dark:text-zinc-500 font-black uppercase text-[9px] tracking-widest h-12 py-2 border-b border-gray-200 dark:border-white/5 sticky top-0 z-10", td: "py-3 font-medium border-b border-gray-100 dark:border-white/5", tr: "hover:bg-gray-50 dark:hover:bg-white/5 transition-colors" }}>
            <TableHeader>
              <TableColumn className="pl-6">DEPARTAMENTO MAESTRO</TableColumn>
              <TableColumn align="center">DENSIDAD STOCK</TableColumn>
              <TableColumn align="end" className="pr-6">ACCIONES</TableColumn>
            </TableHeader>
            <TableBody emptyContent={<div className="py-20 text-[11px] font-black text-gray-400 dark:text-zinc-600 uppercase text-center italic tracking-widest">Sin categorías registradas</div>}>
              {paginatedCategories.map((category) => (
                <TableRow key={category.id} className="group">
                  <TableCell className="pl-6">
                    <div className="flex items-center gap-4">
                      <div className="h-10 w-10 shrink-0 bg-gray-100 dark:bg-black border border-gray-200 dark:border-white/5 rounded-xl flex items-center justify-center text-gray-400 dark:text-zinc-600">
                        <Shapes size={18} />
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm font-black text-gray-900 dark:text-white uppercase leading-tight italic truncate max-w-[200px] md:max-w-[400px]">{category.name}</span>
                        <span className="text-[9px] text-gray-400 dark:text-zinc-500 font-mono tracking-widest mt-1 uppercase">ID: #{category.id}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-center">
                    <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/5">
                      <span className="text-xs font-black text-gray-900 dark:text-white tabular-nums tracking-widest">{category.productCount}</span>
                      <span className="text-[8px] font-bold text-gray-400 dark:text-zinc-500 uppercase mt-0.5">REFS</span>
                    </div>
                  </TableCell>
                  <TableCell className="pr-6">
                    <div className="flex justify-end gap-2">
                      <Button isIconOnly size="sm" variant="flat" className="h-9 w-9 bg-gray-50 dark:bg-zinc-900 text-emerald-500 rounded-xl hover:bg-emerald-500 hover:text-white dark:hover:text-black border border-gray-200 dark:border-white/5 transition-all shadow-sm" onPress={() => { setEditingCategory(category); setEditDialogOpen(true); }}>
                        <Edit size={14} />
                      </Button>
                      <Button isIconOnly size="sm" variant="flat" className="h-9 w-9 bg-gray-50 dark:bg-zinc-900 text-rose-500 rounded-xl hover:bg-rose-500 hover:text-white border border-gray-200 dark:border-white/5 transition-all shadow-sm" onPress={() => { setDeletingId(category.id); setDeleteDialogOpen(true); }}>
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
        {filteredCategories.length > 0 && (
          <div className="px-6 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-gray-200 dark:border-white/5 bg-gray-50 dark:bg-zinc-950 shrink-0 transition-colors">
            <p className="text-[9px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest leading-none text-center sm:text-left">
              VISTA: <span className="text-gray-900 dark:text-white italic">{((currentPage - 1) * pageSize + 1)}-{Math.min(currentPage * pageSize, filteredCategories.length)}</span> / <span className="text-emerald-500 italic">{filteredCategories.length}</span>
            </p>
            <div className="flex items-center justify-center gap-4">
              <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setCurrentPage(1); }} className="h-8 bg-white dark:bg-zinc-900 text-gray-500 dark:text-zinc-400 text-[9px] font-black uppercase tracking-widest px-2 outline-none rounded-lg border border-gray-200 dark:border-white/5 cursor-pointer shadow-sm">
                {[10, 20, 50].map(n => <option key={n} value={n}>{n} REGISTROS</option>)}
              </select>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="flat" onPress={() => setCurrentPage(prev => Math.max(1, prev - 1))} isDisabled={currentPage === 1} className="h-8 px-3 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white font-black text-[9px] uppercase border border-gray-200 dark:border-white/5 rounded-lg shadow-sm hover:border-emerald-500/30">PREV</Button>
                <span className="text-[10px] font-black text-gray-900 dark:text-white italic px-2 tabular-nums">{currentPage} / {totalPages}</span>
                <Button size="sm" variant="flat" onPress={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))} isDisabled={currentPage === totalPages || totalPages === 0} className="h-8 px-3 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white font-black text-[9px] uppercase border border-gray-200 dark:border-white/5 rounded-lg shadow-sm hover:border-emerald-500/30">NEXT</Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* MODAL CREAR/EDITAR ADAPTADO CLARO/OSCURO */}
      <Modal isOpen={addDialogOpen || editDialogOpen} placement="top-center" scrollBehavior="inside" onOpenChange={(o) => { if (!o) { setAddDialogOpen(false); setEditDialogOpen(false); setEditingCategory(null); setNewCategoryName(''); } }} backdrop="blur" size="lg" classNames={{ base: "bg-white dark:bg-zinc-950 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-2xl overflow-visible", closeButton: "text-gray-400 dark:text-zinc-500 hover:text-rose-500 transition-colors" }}>
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex flex-col gap-1 p-8 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50">
                <h2 className="text-3xl font-black text-gray-900 dark:text-white italic tracking-tighter uppercase leading-none flex items-center gap-4">
                  <div className="h-12 w-12 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-500 flex items-center justify-center rounded-2xl shadow-inner"><LayoutGrid size={28} /></div>
                  <div className="flex flex-col">
                    <span>{addDialogOpen ? "Nueva " : "Modificar "} <span className="text-emerald-500">Categoría</span></span>
                    <span className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest mt-1 not-italic">Taxonomía Maestra</span>
                  </div>
                </h2>
              </ModalHeader>

              <ModalBody className="p-8">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic ml-1">Nombre del Departamento</label>
                  <Input
                    value={addDialogOpen ? newCategoryName : editingCategory?.name}
                    onValueChange={(v) => addDialogOpen ? setNewCategoryName(v.toUpperCase()) : setEditingCategory(p => p ? { ...p, name: v.toUpperCase() } : null)}
                    onKeyDown={(e) => e.key === 'Enter' && (addDialogOpen ? handleAddCategory() : handleEditCategory())}
                    placeholder="EJ: BEBIDAS FRÍAS..."
                    classNames={{ inputWrapper: "h-16 bg-gray-50 dark:bg-black border border-gray-200 dark:border-white/10 rounded-2xl focus-within:border-emerald-500/50 shadow-inner", input: "font-black text-base uppercase italic text-gray-900 dark:text-white" }}
                  />
                </div>
              </ModalBody>

              <ModalFooter className="p-8 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50">
                <Button
                  className="w-full h-16 bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase text-xs tracking-[0.2em] rounded-2xl transition-all shadow-xl hover:scale-105 active:scale-95 italic"
                  onPress={addDialogOpen ? handleAddCategory : handleEditCategory}
                >
                  <Sparkles size={20} className="mr-2" />
                  {addDialogOpen ? "ESTABLECER DEPARTAMENTO" : "GUARDAR CAMBIOS"}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* MODAL ELIMINAR */}
      <Modal isOpen={deleteDialogOpen} onOpenChange={setDeleteDialogOpen} backdrop="blur" classNames={{ base: "bg-white dark:bg-zinc-950 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-2xl", closeButton: "text-gray-400 hover:text-rose-500 transition-colors" }}>
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="text-rose-500 font-black uppercase text-xl p-8 pb-4 italic flex items-center gap-3">
                <div className="p-3 bg-rose-50 dark:bg-rose-500/10 rounded-xl"><AlertTriangle size={24} /></div> Protocolo de Purga
              </ModalHeader>
              <ModalBody className="px-8 pb-8 text-center text-sm font-bold text-gray-500 dark:text-zinc-400 uppercase leading-relaxed tracking-widest italic">
                ¿Seguro que desea eliminar permanentemente este departamento?
                <span className="text-rose-500 dark:text-rose-400 font-black text-xs mt-3 block">Los productos asociados podrían perder su clasificación.</span>
              </ModalBody>
              <ModalFooter className="p-6 border-t border-gray-100 dark:border-white/5 flex gap-3">
                <Button variant="flat" className="flex-1 h-14 rounded-xl font-black text-[11px] tracking-widest bg-gray-100 dark:bg-zinc-900 text-gray-900 dark:text-white" onPress={onClose}>DESCARTAR</Button>
                <Button color="danger" className="flex-1 h-14 rounded-xl font-black text-[11px] tracking-widest shadow-xl shadow-rose-500/20" onPress={handleDeleteCategory}>SÍ, ELIMINAR</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}