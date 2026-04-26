"use client";
import { useState, useEffect, useMemo, useCallback, memo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import dynamic from 'next/dynamic';
import Cookies from 'js-cookie';
import { extractApiError, apiFetch } from '@/lib/api-error';
import { 
  Users, Search, PlusCircle, RefreshCw
} from 'lucide-react';
import { Input, Button, Spinner } from "@heroui/react";
import { User } from '@/lib/definitions';

const UserStats = dynamic(() => import('./components/UserStats'), { ssr: false });
const UserTable = dynamic(() => import('./components/UserTable'), { ssr: false });
import { UserModals, DeleteUserModal, ResetPasswordModal } from './components/UserModals';

async function fetchUsers(token: string): Promise<User[]> {
  return await apiFetch('/admin/users', {
    method: 'GET',
    fallbackError: 'FALLO AL OBTENER LISTA DE PERSONAL'
  }, token);
}

async function createUser(userData: any, token: string) {
  return await apiFetch('/admin/register-user', {
    method: 'POST',
    body: JSON.stringify(userData),
    fallbackError: 'FALLO AL CREAR ACCESO'
  }, token);
}

async function updateUser(dni: string, userData: any, token: string) {
  return await apiFetch(`/admin/user/${dni}`, {
    method: 'PUT',
    body: JSON.stringify(userData),
    fallbackError: 'FALLO AL ACTUALIZAR PERMISOS'
  }, token);
}

async function deleteUser(dni: string, token: string) {
  return await apiFetch(`/admin/user/${dni}`, {
    method: 'DELETE',
    fallbackError: 'FALLO AL REVOCAR ACCESO'
  }, token);
}

async function resetPassword(dni: string, userData: { password?: string }, token: string) {
  return await apiFetch(`/admin/force-reset-password/${dni}`, {
    method: 'PATCH',
    body: JSON.stringify(userData),
    fallbackError: 'FALLO AL RESETEAR CONTRASEÑA'
  }, token);
}

async function lookupUser(dni: string, token: string): Promise<User | null> {
  try {
    return await apiFetch(`/admin/user/${dni}`, {
      method: 'GET',
      fallbackError: 'USUARIO NO ENCONTRADO'
    }, token);
  } catch (err) {
    return null;
  }
}

// COMPONENTE HEADER MEMOIZADO PARA RENDIMIENTO
const UserHeader = memo(({ searchInput, onSearch, onAdd, onReload, isLoading }: { 
    searchInput: string, 
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
          <h1 className="text-[13px] font-black uppercase tracking-tighter leading-none italic">GESTIÓN DE <span className="text-emerald-500">PERSONAL</span></h1>
          <p className="text-[8px] font-black text-gray-400 dark:text-zinc-600 uppercase tracking-[0.4em] mt-1">Directorio POS V4.0</p>
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
      placeholder="FILTRAR POR NOMBRE O DNI..."
      value={searchInput} 
      onValueChange={onSearch}
      classNames={{
        inputWrapper: "h-11 px-4 rounded-xl bg-white/50 dark:bg-black/20 border border-gray-200 dark:border-white/5 focus-within:!border-emerald-500/30 transition-all w-full shadow-inner",
        input: "font-black text-[11px] uppercase text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 bg-transparent tracking-widest"
      }}
      startContent={<Search size={14} className="text-emerald-500 mr-1" />}
    />
  </header>
));
UserHeader.displayName = 'UserHeader';

export default function UsersPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const { toast } = useToast();

  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');

  // ... (rest of states remain same)
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);

  const [editingUser, setEditingUser] = useState<Partial<User> | null>(null);
  const [resetUser, setResetUser] = useState<Partial<User> | null>(null);
  const [deletingDni, setDeletingDni] = useState<string | null>(null);
  const targetDeleteUser = useMemo(() => users.find(u => u.dni === deletingDni), [users, deletingDni]);

  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);

  const loadUsers = useCallback(() => {
    const token = Cookies.get('org-pos-token');
    if (!token) { setLoading(false); return; }
    setLoading(true);
    fetchUsers(token)
      .then(data => {
        const userList = Array.isArray(data) ? data : [];
        setUsers(userList.map(u => ({ ...u, id: u.dni, status: 'Activo' })));
      })
      .catch(() => toast({ variant: "destructive", title: "ERROR", description: "SÍNCRONIZACIÓN DE PERSONAL FALLIDA" }))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => {
    if (!authLoading) {
      const role = user?.role?.toLowerCase();
      const hasAccess = role === 'admin' || role === 'administrador' || role === 'superadmin';
      
      if (!hasAccess) {
        router.replace('/dashboard');
      } else {
        loadUsers();
      }
    }
  }, [user, authLoading, router, loadUsers]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setFilter(searchInput.toUpperCase());
      setCurrentPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const filteredUsers = useMemo(() => {
    const query = filter.toLowerCase();
    return users.filter(u =>
      u.name.toLowerCase().includes(query) ||
             (u.email && u.email.toLowerCase().includes(query)) ||
             (u.dni && u.dni.includes(query))
    );
  }, [users, filter, user]);

  const paginatedUsers = useMemo(() => filteredUsers.slice((currentPage - 1) * pageSize, currentPage * pageSize), [filteredUsers, currentPage, pageSize]);
  const totalPages = Math.ceil(filteredUsers.length / pageSize || 1);

  const stats = useMemo(() => {
    return {
      total: users.length,
      admins: users.filter(u => {
        const r = u.role?.toLowerCase();
        return r === 'admin' || r === 'administrador';
      }).length,
      employees: users.filter(u => u.role === 'empleado').length
    };
  }, [users]);

  const handleAddUser = useCallback(async (data: Partial<User>) => {
    const token = Cookies.get('org-pos-token');
    const existingLocal = users.find(u => u.dni === data.dni);
    if (existingLocal) {
      toast({ title: 'DOCUMENTO YA REGISTRADO', description: 'ABRIENDO PERFIL EXISTENTE PARA EDICIÓN...' });
      setAddDialogOpen(false);
      setEditingUser({ ...existingLocal, is_active: existingLocal.is_active ?? true });
      setEditDialogOpen(true);
      return;
    }
    if (!data.dni) { toast({ variant: 'destructive', title: 'DATOS INVÁLIDOS', description: 'EL DNI ES OBLIGATORIO PARA EL ACCESO' }); return; }
    if (!data.name) { toast({ variant: 'destructive', title: 'DATOS INVÁLIDOS', description: 'EL NOMBRE ES REQUERIDO' }); return; }
    if (!data.password) { toast({ variant: 'destructive', title: 'DATOS INVÁLIDOS', description: 'DEBES ASIGNAR UNA CONTRASEÑA' }); return; }
    const roleStr = (data.role || "").toLowerCase();
    const isTargetAdmin = ['admin', 'administrador', 'superadmin'].includes(roleStr);
    if (isTargetAdmin && !data.email) {
      toast({ variant: 'destructive', title: 'SEGURIDAD V4.0', description: 'EL EMAIL ES OBLIGATORIO PARA ROLES ADMINISTRATIVOS' });
      return;
    }
    try {
      await createUser({ ...data, name: data.name!.toUpperCase() }, token!);
      toast({ variant: 'success', title: 'ÉXITO', description: 'ACCESO CREADO CORRECTAMENTE' });
      setAddDialogOpen(false);
      loadUsers();
    } catch (err: any) { toast({ variant: 'destructive', title: 'ERROR', description: err.message || 'FALLO AL CREAR ACCESO' }); }
  }, [users, loadUsers, toast]);

  const handleEditUser = useCallback(async (data: Partial<User>) => {
    if (!data.dni) return;
    const token = Cookies.get('org-pos-token');
    const roleStr = (data.role || "").toLowerCase();
    const isTargetAdmin = ['admin', 'administrador', 'superadmin'].includes(roleStr);
    if (isTargetAdmin && !data.email) {
      toast({ variant: 'destructive', title: 'SEGURIDAD V4.0', description: 'EL EMAIL ES OBLIGATORIO PARA ROLES ADMINISTRATIVOS' });
      return;
    }
    try {
      const { dni, name, email, role, is_active, password } = data;
      await updateUser(dni!, { dni, name: name!.toUpperCase(), email, role, is_active, password }, token!);
      toast({ variant: 'success', title: 'ÉXITO', description: 'PERMISOS ACTUALIZADOS' });
      setEditDialogOpen(false);
      setEditingUser(null);
      loadUsers();
    } catch (err: any) { toast({ variant: 'destructive', title: 'ERROR', description: err.message || 'FALLO AL ACTUALIZAR PERMISOS' }); }
  }, [loadUsers, toast]);

  const handleDeleteUser = useCallback(async () => {
    if (!deletingDni) return;
    const token = Cookies.get('org-pos-token');
    try {
      await deleteUser(deletingDni, token!);
      toast({ variant: 'success', title: 'ÉXITO', description: 'ACCESO REVOCADO' });
      setDeleteDialogOpen(false);
      setDeletingDni(null);
      loadUsers();
    } catch (err: any) { toast({ variant: 'destructive', title: 'ERROR', description: err.message || 'FALLO AL REVOCAR ACCESO' }); }
  }, [deletingDni, loadUsers, toast]);

  const handleResetPassword = useCallback(async (newPassword: string) => {
    if (!resetUser || !newPassword) return;
    const token = Cookies.get('org-pos-token');
    try {
      await resetPassword(resetUser.dni!, { password: newPassword }, token!);
      toast({ variant: 'success', title: 'ÉXITO', description: 'CONTRASEÑA ACTUALIZADA' });
      setResetDialogOpen(false);
      setResetUser(null);
    } catch (err: any) { toast({ variant: 'destructive', title: 'ERROR', description: err.message || 'FALLO AL RESETEAR CONTRASEÑA' }); }
  }, [resetUser, toast]);

  const handleEditOpen = useCallback((u: User) => {
    setEditingUser({ ...u, is_active: u.is_active ?? true });
    setEditDialogOpen(true);
  }, []);

  const handleDeleteOpen = useCallback((dni: string) => {
    setDeletingDni(dni);
    setDeleteDialogOpen(true);
  }, []);

  const handleResetOpen = useCallback((u: User) => {
    setResetUser(u);
    setResetDialogOpen(true);
  }, []);

  const handlePageChange = useCallback((page: number) => { setCurrentPage(page); }, []);
  const handlePageSizeChange = useCallback((size: number) => { setPageSize(size); setCurrentPage(1); }, []);
  const handleAddOpen = useCallback(() => setAddDialogOpen(true), []);
  const handleModalClose = useCallback((o: boolean) => {
      if (!o) { 
        setAddDialogOpen(false); 
        setEditDialogOpen(false); 
        setEditingUser(null); 
      }
  }, []);

  const handleLookupUser = useCallback(async (dni: string) => {
    const token = Cookies.get('org-pos-token');
    if (!token) return;

    const existingUser = await lookupUser(dni, token);
    if (existingUser) {
        toast({ 
            variant: 'success',
            title: 'USUARIO IDENTIFICADO', 
            description: `EL DNI ${dni} YA EXISTE. ABRIENDO MODO EDICIÓN PARA ${existingUser.name}.` 
        });
        
        // Cambiar de modo Agregar a modo Editar
        setAddDialogOpen(false);
        setEditingUser({ ...existingUser, is_active: existingUser.is_active ?? true });
        setEditDialogOpen(true);
    }
  }, [toast]);

  const modalInitialUser = useMemo(() => (editDialogOpen ? editingUser : { role: 'empleado', is_active: true }) || {}, [editDialogOpen, editingUser]);
  const modalOnSave = useMemo(() => editDialogOpen ? handleEditUser : handleAddUser, [editDialogOpen, handleEditUser, handleAddUser]);

  if (authLoading || (loading && users.length === 0)) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950 flex-col gap-4">
    <Spinner color="success" size="lg" />
    <p className="text-[10px] font-black text-emerald-500 uppercase tracking-[0.4em] animate-pulse">Iniciando POS-PRO...</p>
  </div>;
  const role = user?.role?.toLowerCase();
  if (role !== 'admin' && role !== 'administrador' && role !== 'superadmin') return null;

  return (
    <div className="flex flex-col w-full max-w-[1600px] mx-auto h-full min-h-0 bg-transparent text-gray-900 dark:text-white transition-all duration-500 overflow-hidden relative">
      
      {/* HEADER SECTION: FIXED (TOP) */}
      <div className="shrink-0 px-3 pt-1.5 pb-2 flex flex-col gap-3 md:gap-4 border-b border-gray-200/50 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-950/50 backdrop-blur-md">
        <UserHeader 
            searchInput={searchInput} 
            onSearch={setSearchInput} 
            onAdd={handleAddOpen} 
            onReload={loadUsers}
            isLoading={loading}
        />
        <UserStats total={stats.total} admins={stats.admins} employees={stats.employees} />
      </div>

      {/* LIST SECTION - STRICT INTERNAL SCROLL */}
      <div className="flex-1 min-h-0 overflow-hidden px-1 md:px-2 py-1 flex flex-col">
          <UserTable 
              users={paginatedUsers}
              currentDni={user?.dni}
            onEdit={handleEditOpen}
            onDelete={handleDeleteOpen}
            onResetPassword={handleResetOpen}
            currentPage={currentPage}
            totalPages={totalPages}
            pageSize={pageSize}
            totalRecords={filteredUsers.length}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
            onReload={loadUsers}
            isLoading={loading}
          />
      </div>

      {/* MODALS SECTION */}
      <UserModals 
        isOpen={addDialogOpen || editDialogOpen} 
        onOpenChange={handleModalClose}
        editMode={editDialogOpen}
        user={editingUser}
        onSave={modalOnSave}
        onLookupDni={handleLookupUser}
      />
      
      {deleteDialogOpen && (
        <DeleteUserModal 
          isOpen={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          onConfirm={handleDeleteUser}
        />
      )}

      {resetDialogOpen && (
        <ResetPasswordModal 
          isOpen={resetDialogOpen}
          onOpenChange={setResetDialogOpen}
          user={resetUser || {}}
          onConfirm={handleResetPassword}
        />
      )}
    </div>
  );
}