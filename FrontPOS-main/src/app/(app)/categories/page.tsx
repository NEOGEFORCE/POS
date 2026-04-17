"use client";

import { useEffect, useState, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { Button, Input, Spinner } from "@heroui/react";
import { 
    LayoutGrid, Search, PlusCircle, Clock, Sparkles 
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Category } from '@/lib/definitions';
import Cookies from 'js-cookie';
import { extractApiError } from '@/lib/api-error';

// Dinámicos para aligerar HMR y carga inicial
const CategoryStats = dynamic(() => import('./components/CategoryStats'), { ssr: false });
const CategoryTable = dynamic(() => import('./components/CategoryTable'), { ssr: false });
const CategoryFormModal = dynamic(() => import('./components/CategoryFormModal'), { ssr: false });
const DeleteCategoryModal = dynamic(() => import('./components/DeleteCategoryModal'), { ssr: false });

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
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<Category[]>([]);
  const [filter, setFilter] = useState('');

  // Estados de Paginación
  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);

  // Estados de Modales
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Estados de Datos
  const [newCatName, setNewCatName] = useState('');
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadCategories = useCallback(async () => {
    const token = Cookies.get('org-pos-token');
    if (!token) { setLoading(false); return; }
    try {
      const data = await fetchCategories(token);
      setCategories(data);
    } catch {
      toast({ variant: "destructive", title: "Error de conexión", description: "No se pudieron obtener las categorías" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadCategories(); }, [loadCategories]);

  const filteredCategories = useMemo(() => {
    const query = filter.toLowerCase();
    return categories.filter((c: Category) =>
      c.name.toLowerCase().includes(query) ||
      String(c.id).includes(query)
    );
  }, [categories, filter]);

  const stats = useMemo(() => {
    const total = categories.length;
    const topCatObj = [...categories].sort((a, b) => b.productCount - a.productCount)[0];
    const topCatName = topCatObj?.name || 'NINGUNA';
    const totalProds = categories.reduce((acc, c) => acc + (c.productCount || 0), 0);
    return { total, topCat: topCatName, totalProds };
  }, [categories]);

  const paginatedCategories = useMemo(() => 
    filteredCategories.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [filteredCategories, currentPage, pageSize]
  );

  const totalPages = Math.ceil(filteredCategories.length / pageSize || 1);

  // Acciones (Handlers)
  const handleAddCategory = async () => {
    if (!newCatName.trim()) return;
    const token = Cookies.get('org-pos-token');
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/categories/create-categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name: newCatName.toUpperCase() })
      });
      if (!res.ok) {
        const errorMsg = await extractApiError(res, "FALLO AL CREAR CATEGORÍA");
        throw new Error(errorMsg);
      }
      toast({ variant: 'success', title: 'ÉXITO', description: 'CATEGORÍA REGISTRADA.' });
      setAddDialogOpen(false);
      setNewCatName('');
      loadCategories();
    } catch (err: any) { toast({ variant: 'destructive', title: 'ERROR', description: err.message || "FALLO AL CREAR" }); }
  };

  const handleEditCategory = async () => {
    if (!editingCategory) return;
    const token = Cookies.get('org-pos-token');
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/categories/update-categories/${editingCategory.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name: editingCategory.name.toUpperCase() })
      });
      if (!res.ok) {
        const errorMsg = await extractApiError(res, "FALLO AL ACTUALIZAR CATEGORÍA");
        throw new Error(errorMsg);
      }
      toast({ variant: 'success', title: 'ÉXITO', description: 'NOMBRE DE CATEGORÍA SINCRONIZADO.' });
      setEditDialogOpen(false);
      setEditingCategory(null);
      loadCategories();
    } catch (err: any) { toast({ variant: 'destructive', title: 'ERROR', description: err.message || "FALLO AL ACTUALIZAR" }); }
  };

  const handleDeleteCategory = async () => {
    if (!deletingId) return;
    const token = Cookies.get('org-pos-token');
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/categories/delete-categories/${deletingId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) {
        const errorMsg = await extractApiError(res, "FALLO AL ELIMINAR CATEGORÍA");
        throw new Error(errorMsg);
      }
      toast({ variant: 'success', title: 'ÉXITO', description: 'REGISTRO ELIMINADO CORRECTAMENTE.' });
      setDeleteDialogOpen(false);
      setDeletingId(null);
      loadCategories();
    } catch (err: any) { toast({ variant: 'destructive', title: 'ERROR', description: err.message || "FALLO AL ELIMINAR" }); }
  };

  if (loading) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner color="success" size="lg" /></div>;

  return (
    <div className="flex flex-col min-h-screen gap-3 p-3 bg-gray-100 dark:bg-zinc-950 transition-all duration-700 pb-20">
      
      {/* Header Premium Zero Friction */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-2xl shrink-0 shadow-sm relative overflow-hidden group">
        <div className="absolute top-0 right-0 p-4 opacity-5 text-emerald-500 scale-150"><LayoutGrid size={120} /></div>
        
        <div className="flex items-center gap-4 relative z-10">
          <div className="bg-emerald-500 p-3 rounded-2xl text-white shadow-lg shadow-emerald-500/20 rotate-3">
            <LayoutGrid size={24} />
          </div>
          <div className="flex flex-col">
            <h1 className="text-xl font-black dark:text-white uppercase leading-none italic tracking-tighter">
              Jerarquía de <span className="text-emerald-500">Categorías</span>
            </h1>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[9px] font-black text-emerald-500 uppercase tracking-[0.3em]">Taxonomía Maestros</span>
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
              placeholder="RASTREAR DEPARTAMENTO..." 
              value={filter} 
              onValueChange={(v) => { setFilter(v.toUpperCase()); setCurrentPage(1); }} 
              startContent={<Search size={16} className="text-gray-400 group-focus-within/search:text-emerald-500 transition-colors" />} 
              classNames={{ 
                inputWrapper: "h-11 w-full md:w-80 bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-inner rounded-xl group-focus-within/search:border-emerald-500/50 transition-all", 
                input: "text-[11px] font-black bg-transparent tracking-widest italic" 
              }} 
            />
          </div>
          <Button 
            size="sm" 
            onPress={() => setAddDialogOpen(true)} 
            className="h-11 px-6 bg-emerald-500 text-white font-black text-[11px] rounded-xl shadow-lg shadow-emerald-500/20 hover:scale-105 active:scale-95 transition-all italic tracking-widest"
          >
            <PlusCircle size={16} className="mr-1" /> NUEVO DEP.
          </Button>
        </div>
      </header>

      {/* KPI Section */}
      <CategoryStats 
        total={stats.total}
        topCat={stats.topCat}
        totalProds={stats.totalProds}
      />

      {/* Table Section */}
      <CategoryTable 
        categories={paginatedCategories}
        currentPage={currentPage}
        totalPages={totalPages}
        pageSize={pageSize}
        totalFiltered={filteredCategories.length}
        onEdit={(cat) => { setEditingCategory({...cat}); setEditDialogOpen(true); }}
        onDelete={(id) => { setDeletingId(id); setDeleteDialogOpen(true); }}
        onPageChange={setCurrentPage}
        onPageSizeChange={(s) => { setPageSize(s); setCurrentPage(1); }}
      />

      {/* Modals */}
      <CategoryFormModal 
        isOpen={addDialogOpen || editDialogOpen}
        onOpenChange={(o) => { if (!o) { setAddDialogOpen(false); setEditDialogOpen(false); setEditingCategory(null); setNewCatName(''); } }}
        isEdit={editDialogOpen}
        categoryName={addDialogOpen ? newCatName : (editingCategory?.name || '')}
        setCategoryName={addDialogOpen ? setNewCatName : (name) => setEditingCategory(p => p ? {...p, name} : null)}
        onSave={addDialogOpen ? handleAddCategory : handleEditCategory}
      />

      <DeleteCategoryModal 
        isOpen={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteCategory}
      />
    </div>
  );
}