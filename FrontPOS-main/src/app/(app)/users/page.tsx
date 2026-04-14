"use client";
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import dynamic from 'next/dynamic';
import Cookies from 'js-cookie';
import { 
  Users, Search, PlusCircle 
} from 'lucide-react';
import { Input, Button, Spinner } from "@heroui/react";
import { User } from '@/lib/definitions';

const UserStats = dynamic(() => import('./components/UserStats'), { ssr: false });
const UserTable = dynamic(() => import('./components/UserTable'), { ssr: false });
import { UserFormModal, DeleteUserModal } from './components/UserModals';

async function fetchUsers(token: string): Promise<User[]> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/admin/users`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error("Failed to fetch users");
  return await res.json();
}

async function createUser(userData: any, token: string) {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/admin/register-user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(userData)
  });
  if (!res.ok) {
    throw new Error('Failed to create user');
  }
  return await res.json();
}

async function updateUser(dni: string, userData: any, token: string) {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/admin/user/${dni}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(userData)
  });
  if (!res.ok) {
    throw new Error('Failed to update user');
  }
  return await res.json();
}

async function deleteUser(dni: string, token: string) {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/admin/user/${dni}`, {
    method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new Error('Failed to delete user');
  }
}

export default function UsersPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const { toast } = useToast();

  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  // ESTADOS MODALES
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // DATOS FORMULARIO
  const [newUser, setNewUser] = useState<Partial<User>>({ dni: '', name: '', email: '', password: '', role: 'empleado' });
  const [editingUser, setEditingUser] = useState<Partial<User> | null>(null);
  const [deletingDni, setDeletingDni] = useState<string | null>(null);

  // PAGINACIÓN
  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);

  const loadUsers = () => {
    const token = Cookies.get('org-pos-token');
    if (!token) { setLoading(false); return; }
    setLoading(true);
    fetchUsers(token)
      .then(data => setUsers(data.map(u => ({ ...u, id: u.dni, status: 'Activo', lastLogin: new Date().toISOString() }))))
      .catch(() => toast({ variant: "destructive", title: "ERROR", description: "SÍNCRONIZACIÓN DE PERSONAL FALLIDA" }))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!authLoading) {
      const role = user?.role?.toLowerCase();
      const isAdmin = role === 'admin' || role === 'administrador';
      
      if (!isAdmin) {
        router.replace('/dashboard');
      } else {
        loadUsers();
      }
    }
  }, [user, authLoading, router]);

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

  const handleAddUser = async () => {
    const token = Cookies.get('org-pos-token');
    if (!newUser.name || !newUser.password || !newUser.role) {
      toast({ variant: 'destructive', title: 'ERROR', description: 'CAMPOS INCOMPLETOS' });
      return;
    }
    try {
      await createUser({ ...newUser, name: newUser.name.toUpperCase() }, token!);
      toast({ variant: 'success', title: 'ÉXITO', description: 'ACCESO CREADO CORRECTAMENTE' });
      setAddDialogOpen(false);
      setNewUser({ dni: '', name: '', email: '', password: '', role: 'empleado' });
      loadUsers();
    } catch { toast({ variant: 'destructive', title: 'ERROR', description: 'FALLO AL CREAR ACCESO' }); }
  };

  const handleEditUser = async () => {
    if (!editingUser) return;
    const token = Cookies.get('org-pos-token');
    try {
      const { dni, name, email, role } = editingUser;
      await updateUser(dni!, { name: name!.toUpperCase(), email, role }, token!);
      toast({ variant: 'success', title: 'ÉXITO', description: 'PERMISOS ACTUALIZADOS' });
      setEditDialogOpen(false);
      setEditingUser(null);
      loadUsers();
    } catch { toast({ variant: 'destructive', title: 'ERROR', description: 'FALLO AL ACTUALIZAR PERMISOS' }); }
  };

  const handleDeleteUser = async () => {
    if (!deletingDni) return;
    const token = Cookies.get('org-pos-token');
    try {
      await deleteUser(deletingDni, token!);
      toast({ variant: 'success', title: 'ÉXITO', description: 'ACCESO REVOCADO' });
      setDeleteDialogOpen(false);
      setDeletingDni(null);
      loadUsers();
    } catch { toast({ variant: 'destructive', title: 'ERROR', description: 'FALLO AL REVOCAR ACCESO' }); }
  };

  if (authLoading || loading) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner color="success" size="lg" /></div>;
  
  const role = user?.role?.toLowerCase();
  if (role !== 'admin' && role !== 'administrador') return null;

  return (
    <div className="flex flex-col min-h-screen gap-2 p-2 bg-gray-50 dark:bg-zinc-950 text-gray-900 dark:text-white transition-colors duration-500 pb-20">

      <header className="flex flex-col md:flex-row md:items-center justify-between gap-3 p-2 md:p-3 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-xl shrink-0 shadow-sm transition-colors">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-emerald-500 flex items-center justify-center text-white shadow-sm shrink-0">
            <Users size={14} />
          </div>
          <div className="flex flex-col">
            <h1 className="text-sm font-black uppercase tracking-tighter leading-none">USUARIOS</h1>
            <p className="text-[8px] font-black text-emerald-500 uppercase tracking-widest mt-0.5 opacity-80 italic">CENTRAL DE ACCESOS</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Input
            size="sm"
            placeholder="BUSCAR..."
            value={filter} onValueChange={(v) => { setFilter(v.toUpperCase()); setCurrentPage(1); }}
            classNames={{
              inputWrapper: "h-8 px-3 rounded-md bg-transparent border border-gray-200 dark:border-white/10 transition-colors w-40 md:w-64 shadow-none",
              input: "font-black text-[10px] uppercase text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 bg-transparent"
            }}
            startContent={<Search size={14} className="text-gray-400" />}
          />
          <Button
            size="sm"
            onPress={() => setAddDialogOpen(true)}
            className="h-8 bg-emerald-500 text-white font-black uppercase text-[10px] px-4 rounded-md shadow-sm italic transition-transform active:scale-95"
          >
            <PlusCircle size={14} className="mr-1" /> NUEVO ACCESO
          </Button>
        </div>
      </header>

      <UserStats 
        total={stats.total}
        admins={stats.admins}
        employees={stats.employees}
      />

      <UserTable 
        users={paginatedUsers}
        onEdit={(u) => { setEditingUser(u); setEditDialogOpen(true); }}
        onDelete={(dni) => { setDeletingDni(dni); setDeleteDialogOpen(true); }}
        currentPage={currentPage}
        totalPages={totalPages}
        pageSize={pageSize}
        totalRecords={filteredUsers.length}
        onPageChange={setCurrentPage}
        onPageSizeChange={(size) => { setPageSize(size); setCurrentPage(1); }}
      />

      <UserFormModal 
        isOpen={addDialogOpen || editDialogOpen}
        onOpenChange={(o) => { if (!o) { setAddDialogOpen(false); setEditDialogOpen(false); setEditingUser(null); } }}
        isEdit={editDialogOpen}
        user={(addDialogOpen ? newUser : editingUser) || {}}
        setUser={(u) => {
          if (addDialogOpen) setNewUser(u as any);
          else setEditingUser(u as any);
        }}
        onSave={addDialogOpen ? handleAddUser : handleEditUser}
      />

      <DeleteUserModal 
        isOpen={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteUser}
      />
    </div>
  );
}