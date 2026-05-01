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
    const name = newCatName.trim().toUpperCase();
    if (!name) return;
    const token = Cookies.get('org-pos-token');
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/categories/create-categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name })
      });

      if (!res.ok) {
        if (res.status === 409) {
          const errData = await res.json();
          const category = errData.error?.data || {};
          const isActive = category.is_active ?? true;
          const catId = category.id;

          toast({
            variant: 'destructive',
            title: 'CATEGORÍA DUPLICADA',
            description: isActive
              ? `"${name}" ya existe como una categoría activa.`
              : `Existe un registro inactivo para "${name}". ¿Deseas reactivarlo?`,
            action: !isActive ? (
              <Button
                size="sm"
                color="success"
                className="font-black text-[9px] uppercase"
                onPress={async () => {
                  try {
                    const reactRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/categories/update-categories/${catId}`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                      body: JSON.stringify({ name, isActive: true })
                    });
                    if (!reactRes.ok) throw new Error('Fallo al reactivar');
                    toast({ title: 'ÉXITO', description: 'CATEGORÍA REACTIVADA' });
                    setAddDialogOpen(false);
                    loadCategories();
                  } catch (e: any) {
                    toast({ variant: 'destructive', title: 'ERROR', description: 'FALLO AL REACTIVAR' });
                  }
                }}
              >
                REACTIVAR
              </Button>
            ) : undefined
          });
          return;
        }
        const errorMsg = await extractApiError(res, "FALLO AL CREAR CATEGORÍA");
        throw new Error(errorMsg);
      }
      toast({ variant: 'success', title: 'ÉXITO', description: 'CATEGORÍA REGISTRADA.' });
      setAddDialogOpen(false);
      setNewCatName('');
      loadCategories();
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'ERROR', description: err.message || "FALLO AL CREAR" });
    }
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

  if (loading) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950 flex-col gap-4">
    <Spinner color="success" size="lg" />
    <p className="text-[10px] font-black text-emerald-500 uppercase tracking-[0.4em] animate-pulse">Sincronizando Categorías...</p>
  </div>;

  return (
    <div className="flex flex-col w-full max-w-[1600px] mx-auto h-full min-h-0 bg-transparent text-gray-900 dark:text-white transition-all duration-500 overflow-hidden relative">

      {/* HEADER SECTION: FIXED (TOP) - MATCHING SUPPLIERS/USERS 3-PANEL STYLE */}
      <div className="shrink-0 px-4 py-4 flex flex-col gap-3 md:gap-5 border-b border-gray-200/50 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-950/50 backdrop-blur-md">

        {/* PANEL 1: TITULO Y BOTONES ACCIÓN */}
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-emerald-500 flex items-center justify-center text-white shadow-xl shadow-emerald-500/20 shrink-0 transform -rotate-2 hover:rotate-0 transition-all duration-500">
              <LayoutGrid size={20} className="md:size-5" strokeWidth={2.5} />
            </div>
            <div className="flex flex-col">
              <h1 className="text-[13px] md:text-[14px] font-black uppercase tracking-tighter leading-none italic text-gray-900 dark:text-white">
                CATÁLOGO DE <span className="text-emerald-500 text-[14px] md:text-[15px]">CATEGORÍAS</span>
              </h1>
              <p className="text-[8px] font-black text-gray-400 dark:text-zinc-600 uppercase tracking-[0.4em] mt-1.5 flex items-center gap-1.5 leading-none">
                <Sparkles size={8} className="text-emerald-500" /> TAXONOMÍA MAESTRA
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              isIconOnly
              size="sm"
              onPress={() => loadCategories()}
              className="h-8 w-8 bg-white/80 dark:bg-zinc-900/80 text-gray-400 dark:text-zinc-500 rounded-lg shadow-sm border border-gray-200 dark:border-white/5 active:scale-90 transition-all"
            >
              <Clock size={14} />
            </Button>
            <Button
              onPress={() => setAddDialogOpen(true)}
              className="h-8 px-4 bg-emerald-500 text-white font-black text-[9px] uppercase tracking-widest italic rounded-lg shadow-lg shadow-emerald-500/20 active:scale-95 transition-all shrink-0"
            >
              <PlusCircle size={14} className="mr-2" /> NUEVO
            </Button>
          </div>
        </div>

        {/* PANEL 2: BARRA DE BÚSQUEDA NIVEL 2 */}
        <div className="px-1">
          <Input
            size="sm"
            placeholder="LOCALIZAR DEPARTAMENTO O ID..."
            value={filter}
            onValueChange={(v) => { setFilter(v.toUpperCase()); setCurrentPage(1); }}
            startContent={<Search size={14} className="text-emerald-500 mr-2" />}
            classNames={{
              inputWrapper: "h-11 px-4 bg-white/50 dark:bg-black/20 border border-gray-200 dark:border-white/5 focus-within:!border-emerald-500/30 transition-all w-full shadow-inner rounded-xl",
              input: "text-[11px] font-black tracking-widest uppercase text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-600"
            }}
          />
        </div>

        {/* PANEL 3: ESTADÍSTICAS INTEGRADAS EN HEADER */}
        <div className="px-1 pb-1">
          <CategoryStats
            total={stats.total}
            topCat={stats.topCat}
            totalProds={stats.totalProds}
          />
        </div>
      </div>

      {/* CONTENT SECTION (SCROLLABLE) */}
      <div className="flex-1 min-h-0 overflow-hidden px-1 md:px-2 py-1 flex flex-col min-w-0">
        <CategoryTable
          categories={paginatedCategories}
          currentPage={currentPage}
          totalPages={totalPages}
          pageSize={pageSize}
          totalFiltered={filteredCategories.length}
          onEdit={(cat) => { setEditingCategory({ ...cat }); setEditDialogOpen(true); }}
          onDelete={(id) => { setDeletingId(id); setDeleteDialogOpen(true); }}
          onPageChange={setCurrentPage}
          onPageSizeChange={(s) => { setPageSize(s); setCurrentPage(1); }}
        />
      </div>

      {/* Modals */}
      <CategoryFormModal
        isOpen={addDialogOpen || editDialogOpen}
        onOpenChange={(o) => { if (!o) { setAddDialogOpen(false); setEditDialogOpen(false); setEditingCategory(null); setNewCatName(''); } }}
        isEdit={editDialogOpen}
        categoryName={addDialogOpen ? newCatName : (editingCategory?.name || '')}
        setCategoryName={(name) => {
          const val = name.toUpperCase().trim();
          if (addDialogOpen) {
            setNewCatName(name);
            // Detección automática de categoría existente
            if (val.length >= 3) {
              const existing = categories.find(c => c.name.toUpperCase() === val);
              if (existing) {
                toast({
                  variant: "success",
                  title: "CATEGORÍA DETECTADA",
                  description: "CARGANDO DATOS EXISTENTES..."
                });
                setAddDialogOpen(false);
                setEditingCategory(existing);
                setEditDialogOpen(true);
                setNewCatName('');
              }
            }
          } else {
            setEditingCategory(p => p ? { ...p, name } : null);
          }
        }}
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