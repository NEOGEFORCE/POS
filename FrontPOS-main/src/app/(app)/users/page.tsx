"use client";
import { useState, useEffect, useMemo, useCallback, memo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import dynamic from 'next/dynamic';
import Cookies from 'js-cookie';
import { extractApiError, apiFetch } from '@/lib/api-error';
import { 
  Users, Search, PlusCircle 
} from 'lucide-react';
import { Input, Button, Spinner } from "@heroui/react";
import { User } from '@/lib/definitions';

const UserStats = dynamic(() => import('./components/UserStats'), { ssr: false });
const UserTable = dynamic(() => import('./components/UserTable'), { ssr: false });
import { UserFormModal, DeleteUserModal, ResetPasswordModal } from './components/UserModals';

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
  return await apiFetch(`/admin/reset-password/${dni}`, {
    method: 'POST',
    body: JSON.stringify(userData),
    fallbackError: 'FALLO AL RESETEAR CONTRASEÑA'
  }, token);
}

// COMPONENTE HEADER MEMOIZADO PARA RENDIMIENTO
const UserHeader = memo(({ searchInput, onSearch, onAdd }: { searchInput: string, onSearch: (v: string) => void, onAdd: () => void }) => (
  <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 bg-white/70 dark:bg-zinc-900/50 backdrop-blur-xl border border-gray-200 dark:border-white/5 rounded-[2.5rem] shrink-0 shadow-2xl shadow-emerald-500/5 transition-all mb-4">
    <div className="flex items-center gap-4">
      <div className="h-12 w-12 rounded-2xl bg-emerald-500 flex items-center justify-center text-white shadow-lg shadow-emerald-500/20 shrink-0 transform -rotate-3 transition-transform hover:rotate-0">
        <Users size={24} />
      </div>
      <div className="flex flex-col">
        <h1 className="text-lg font-black uppercase tracking-tighter leading-none italic">GESTIÓN DE <span className="text-emerald-500">PERSONAL</span></h1>
        <p className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.3em] mt-2 not-italic opacity-80">Arquitectura de Accesos POS V4.0</p>
      </div>
    </div>

    <div className="flex items-center justify-between md:justify-end gap-4 w-full md:w-auto mt-3 md:mt-0">
      <Input
        size="sm"
        placeholder="FILTRAR POR NOMBRE O DNI..."
        value={searchInput} 
        onValueChange={onSearch}
        classNames={{
          inputWrapper: "h-14 px-8 rounded-2xl bg-white/50 dark:bg-black/20 border-2 border-transparent focus-within:!border-emerald-500/30 transition-all flex-1 md:w-96 shadow-inner",
          input: "font-black text-sm uppercase text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 bg-transparent tracking-[0.05em]"
        }}
        startContent={<Search size={20} className="text-emerald-500 mr-2" />}
      />
      <Button
        size="sm"
        onPress={onAdd}
        className="h-14 bg-emerald-500 text-white font-black uppercase text-[10px] px-8 rounded-2xl shadow-xl shadow-emerald-500/20 italic transition-all hover:scale-[1.05] active:scale-95 shrink-0"
      >
        <PlusCircle size={18} /> 
        <span className="ml-1 tracking-widest">NUEVO ACCESO</span>
      </Button>
    </div>
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

  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);

  const loadUsers = useCallback(() => {
    const token = Cookies.get('org-pos-token');
    if (!token) { setLoading(false); return; }
    setLoading(true);
    fetchUsers(token)
      .then(data => {
        const userList = Array.isArray(data) ? data : [];
        setUsers(userList.map(u => ({ ...u, id: u.dni, status: 'Activo', lastLogin: new Date().toISOString() })));
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
  }, [users, filter]);

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
      await updateUser(dni!, { name: name!.toUpperCase(), email, role, is_active, password }, token!);
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
      if (!o) { setAddDialogOpen(false); setEditDialogOpen(false); setEditingUser(null); }
  }, []);

  const modalInitialUser = useMemo(() => (editDialogOpen ? editingUser : { role: 'empleado', is_active: true }) || {}, [editDialogOpen, editingUser]);
  const modalOnSave = useMemo(() => editDialogOpen ? handleEditUser : handleAddUser, [editDialogOpen, handleEditUser, handleAddUser]);

  if (authLoading || loading) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner color="success" size="lg" /></div>;
  const role = user?.role?.toLowerCase();
  if (role !== 'admin' && role !== 'administrador' && role !== 'superadmin') return null;

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6 w-full max-w-[1600px] mx-auto min-h-[100dvh] bg-gray-50/50 dark:bg-zinc-950 text-gray-900 dark:text-white transition-all duration-500">
      <UserHeader searchInput={searchInput} onSearch={setSearchInput} onAdd={handleAddOpen} />
      <UserStats total={stats.total} admins={stats.admins} employees={stats.employees} />

      <div className="flex-1 pb-10">
        <UserTable 
            users={paginatedUsers}
            onEdit={handleEditOpen}
            onDelete={handleDeleteOpen}
            onResetPassword={handleResetOpen}
            currentPage={currentPage}
            totalPages={totalPages}
            pageSize={pageSize}
            totalRecords={filteredUsers.length}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
        />
      </div>

      {(addDialogOpen || editDialogOpen) && (
        <UserFormModal 
          isOpen={addDialogOpen || editDialogOpen}
          onOpenChange={handleModalClose}
          isEdit={editDialogOpen}
          initialUser={modalInitialUser}
          onSave={modalOnSave}
        />
      )}

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