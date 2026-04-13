"use client";

import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/lib/auth';
import { useRouter } from 'next/navigation';
import { User } from '@/lib/definitions';
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, Input, Spinner, Select, SelectItem, Chip, Avatar
} from "@heroui/react";
import {
  PlusCircle, Edit, Trash2, Search, AlertTriangle,
  ShieldAlert, Users, ShieldCheck, Sparkles, KeyRound, Mail, UserCircle, Zap
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

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
    const errorData = await res.json();
    throw new Error(errorData.error || 'Failed to create user');
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
    const errorData = await res.json();
    throw new Error(errorData.error || 'Failed to update user');
  }
  return await res.json();
}

async function deleteUser(dni: string, token: string) {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/admin/user/${dni}`, {
    method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || 'Failed to delete user');
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
  const [newUser, setNewUser] = useState({ dni: '', name: '', email: '', password: '', role: 'empleado' });
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [deletingDni, setDeletingDni] = useState<string | null>(null);

  // PAGINACIÓN
  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);

  const loadUsers = () => {
    const token = localStorage.getItem('org-pos-token');
    if (!token) { setLoading(false); return; }
    setLoading(true);
    fetchUsers(token)
      .then(data => setUsers(data.map(u => ({ ...u, id: u.dni, status: 'Activo', lastLogin: new Date().toISOString() }))))
      .catch(() => toast({ variant: "destructive", title: "Error de conexión" }))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    // CORRECCIÓN: Solo validamos 'administrador'
    if (!authLoading && user?.role !== 'administrador') {
      router.replace('/dashboard');
    } else if (!authLoading && user?.role === 'administrador') {
      loadUsers();
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
      // CORRECCIÓN: Solo buscamos 'administrador'
      admins: users.filter(u => u.role === 'administrador').length,
      employees: users.filter(u => u.role === 'empleado').length
    };
  }, [users]);

  const handleAddUser = async () => {
    const token = localStorage.getItem('org-pos-token');
    if (!newUser.name || !newUser.password || !newUser.role) {
      toast({ variant: 'destructive', title: 'Campos incompletos', description: 'Nombre, Contraseña y Rol son obligatorios.' });
      return;
    }
    try {
      await createUser({ ...newUser, name: newUser.name.toUpperCase() }, token!);
      toast({ title: 'Éxito', description: 'Cuenta de acceso creada.' });
      setAddDialogOpen(false);
      setNewUser({ dni: '', name: '', email: '', password: '', role: 'empleado' });
      loadUsers();
    } catch (err: any) { toast({ variant: 'destructive', title: 'Error', description: err.message }); }
  };

  const handleEditUser = async () => {
    if (!editingUser) return;
    const token = localStorage.getItem('org-pos-token');
    try {
      const { dni, name, email, role } = editingUser;
      await updateUser(dni, { name: name.toUpperCase(), email, role }, token!);
      toast({ title: 'Éxito', description: 'Permisos actualizados.' });
      setEditDialogOpen(false);
      setEditingUser(null);
      loadUsers();
    } catch (err: any) { toast({ variant: 'destructive', title: 'Error', description: err.message }); }
  };

  const handleDeleteUser = async () => {
    if (!deletingDni) return;
    const token = localStorage.getItem('org-pos-token');
    try {
      await deleteUser(deletingDni, token!);
      toast({ title: 'REVOCADO', description: 'Acceso eliminado permanentemente.' });
      setDeleteDialogOpen(false);
      setDeletingDni(null);
      loadUsers();
    } catch (err: any) { toast({ variant: 'destructive', title: 'Error al purgar', description: err.message }); }
  };

  if (authLoading || loading) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner color="success" size="lg" /></div>;
  // CORRECCIÓN: Solo validamos 'administrador'
  if (user?.role !== 'administrador') return null;

  return (
    <div className="flex flex-col h-screen gap-1 p-1 bg-gray-50 dark:bg-zinc-950 text-gray-900 dark:text-white overflow-hidden select-none transition-colors duration-500">

      <header className="flex items-center justify-between gap-2 p-2 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-lg shrink-0 shadow-sm transition-colors">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-md bg-emerald-500 flex items-center justify-center text-white shadow-sm shrink-0">
            <Users size={16} />
          </div>
          <div className="flex flex-col">
            <h1 className="text-sm font-black uppercase tracking-tighter leading-none">USUARIOS</h1>
            <p className="text-[9px] font-black text-emerald-500 uppercase tracking-widest mt-0.5 opacity-80 italic">CENTRAL DE ACCESOS</p>
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

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-1 shrink-0">
        {[
          { label: "PERSONAL AUTORIZADO", val: stats.total, color: "emerald", icon: ShieldCheck },
          { label: "ADMINISTRADORES", val: stats.admins, color: "emerald", icon: ShieldAlert },
          { label: "EMPLEADOS DE TURNO", val: stats.employees, color: "zinc", icon: UserCircle }
        ].map((k, i) => (
          <div key={i} className="bg-white dark:bg-zinc-900 p-2 border border-gray-200 dark:border-white/5 rounded-lg flex items-center justify-between shadow-sm transition-colors">
            <div className="flex flex-col">
              <span className="text-[8px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-none mb-0.5">{k.label}</span>
              <span className={`text-sm font-black tabular-nums ${k.color === 'emerald' ? 'text-emerald-500' : 'text-gray-900 dark:text-white'} italic leading-tight tracking-tighter`}>{k.val}</span>
            </div>
            <k.icon size={14} className={`${k.color === 'emerald' ? 'text-emerald-500' : 'text-gray-400 dark:text-zinc-600'} opacity-20`} />
          </div>
        ))}
      </div>

      {/* TABLA PRINCIPAL (DISEÑO SLIM) */}
      <div className="flex-1 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-lg overflow-hidden flex flex-col min-h-0 shadow-sm transition-colors">
        <div className="flex-1 overflow-auto custom-scrollbar">
          <Table isCompact removeWrapper aria-label="Directorio Empleados" classNames={{ th: "bg-gray-50 dark:bg-zinc-950 text-gray-400 dark:text-zinc-500 font-black uppercase text-[8px] md:text-[9px] tracking-widest h-10 py-1 border-b border-gray-200 dark:border-white/5 sticky top-0 z-10", td: "py-1.5 font-medium border-b border-gray-100 dark:border-white/5", tr: "hover:bg-emerald-500/5 transition-colors border-l-4 border-transparent hover:border-emerald-500 active:bg-emerald-500/10 cursor-pointer" }}>
            <TableHeader>
              <TableColumn className="pl-6">IDENTIDAD</TableColumn>
              <TableColumn align="center">PERMISOS / ROL</TableColumn>
              <TableColumn align="start">ÚLTIMO ACCESO</TableColumn>
              <TableColumn align="end" className="pr-6">CONTROL</TableColumn>
            </TableHeader>
            <TableBody emptyContent={<div className="py-20 text-[11px] font-black text-gray-400 dark:text-zinc-600 uppercase text-center italic tracking-widest">Sin personal registrado</div>}>
              {paginatedUsers.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="pl-6">
                    <div className="flex items-center gap-4">
                      <Avatar className="h-10 w-10 shrink-0" src={undefined} name={u.name} classNames={{ base: "bg-gray-100 dark:bg-black border border-gray-200 dark:border-white/5", name: "text-emerald-500 font-black uppercase" }} />
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm font-black text-gray-900 dark:text-white uppercase leading-tight italic truncate max-w-[150px] md:max-w-[300px]">{u.name}</span>
                        <span className="text-[9px] text-gray-400 dark:text-zinc-500 font-mono tracking-widest mt-1 uppercase">DNI: {u.dni || 'NO REGISTRADO'}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-center">
                    <Chip
                      size="sm" variant="flat"
                      // CORRECCIÓN: Solo validamos 'administrador'
                      className={`h-6 px-2 text-[8px] font-black uppercase tracking-widest border ${u.role === 'administrador' ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-500 border-emerald-500/20' : 'bg-gray-100 dark:bg-zinc-900 text-gray-500 dark:text-zinc-400 border-gray-200 dark:border-white/5'}`}
                    >
                      {u.role}
                    </Chip>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Zap size={14} className="text-gray-300 dark:text-zinc-600 shrink-0" />
                      <span className="text-[10px] font-black text-gray-500 dark:text-zinc-400 uppercase tracking-tighter italic">{u.lastLogin ? new Date(u.lastLogin).toLocaleString('es-CO') : 'NUNCA HA INGRESADO'}</span>
                    </div>
                  </TableCell>
                  <TableCell className="pr-6">
                    <div className="flex justify-end gap-2">
                      <Button isIconOnly size="sm" variant="flat" className="h-9 w-9 bg-gray-50 dark:bg-zinc-900 text-emerald-500 rounded-xl hover:bg-emerald-500 hover:text-white dark:hover:text-black border border-gray-200 dark:border-white/5 transition-all shadow-sm" onPress={() => { setEditingUser(u); setEditDialogOpen(true); }}>
                        <Edit size={14} />
                      </Button>
                      <Button isIconOnly size="sm" variant="flat" className="h-9 w-9 bg-gray-50 dark:bg-zinc-900 text-rose-500 rounded-xl hover:bg-rose-500 hover:text-white border border-gray-200 dark:border-white/5 transition-all shadow-sm" onPress={() => { setDeletingDni(u.dni); setDeleteDialogOpen(true); }}>
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
        {filteredUsers.length > 0 && (
          <div className="px-6 py-3 flex items-center justify-between border-t border-gray-200 dark:border-white/5 bg-gray-50 dark:bg-zinc-950 shrink-0 transition-colors">
            <p className="text-[9px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest leading-none">
              VISTA: <span className="text-gray-900 dark:text-white italic">{((currentPage - 1) * pageSize + 1)}-{Math.min(currentPage * pageSize, filteredUsers.length)}</span> / <span className="text-emerald-500 italic">{filteredUsers.length}</span>
            </p>
            <div className="flex items-center gap-4">
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
      <Modal isOpen={addDialogOpen || editDialogOpen} onOpenChange={(o) => { if (!o) { setAddDialogOpen(false); setEditDialogOpen(false); setEditingUser(null); } }} backdrop="blur" size="xl" classNames={{ base: "bg-white dark:bg-zinc-950 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-2xl", closeButton: "text-gray-400 dark:text-zinc-500 hover:text-rose-500 transition-colors" }}>
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex flex-col gap-1 p-8 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50">
                <h2 className="text-3xl font-black text-gray-900 dark:text-white italic tracking-tighter uppercase leading-none flex items-center gap-4">
                  <div className="h-12 w-12 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-500 flex items-center justify-center rounded-2xl shadow-inner"><ShieldCheck size={28} /></div>
                  <div className="flex flex-col">
                    <span>{addDialogOpen ? "Nuevo " : "Modificar "} <span className="text-emerald-500">Acceso</span></span>
                    <span className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest mt-1 not-italic">Control de Permisos</span>
                  </div>
                </h2>
              </ModalHeader>

              <ModalBody className="p-8 gap-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-1.5">
                    <Input
                      autoFocus
                      label="Documento (DNI)"
                      labelPlacement="outside"
                      value={addDialogOpen ? newUser.dni : editingUser?.dni}
                      onValueChange={(v) => addDialogOpen ? setNewUser(p => ({ ...p, dni: v })) : null}
                      isDisabled={!addDialogOpen}
                      startContent={<UserCircle size={12} className="text-gray-400 dark:text-zinc-500 mr-1" />}
                      classNames={{ 
                        label: "text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic mb-2",
                        inputWrapper: "h-14 bg-transparent border border-gray-200 dark:border-white/10 rounded-xl focus-within:!border-emerald-500 transition-all shadow-none", 
                        input: "font-black text-sm uppercase italic text-gray-900 dark:text-white bg-transparent" 
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Select
                      label="Nivel de Rol"
                      labelPlacement="outside"
                      selectedKeys={addDialogOpen ? [newUser.role] : [String(editingUser?.role || 'empleado')]}
                      onSelectionChange={(keys) => {
                        const v = Array.from(keys)[0] as string;
                        if (addDialogOpen) setNewUser(p => ({ ...p, role: v }));
                        else setEditingUser(p => p ? { ...p, role: v as any } : null);
                      }}
                      classNames={{ 
                        label: "text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic mb-2",
                        trigger: "h-14 bg-transparent border border-gray-200 dark:border-white/10 rounded-xl focus-within:!border-emerald-500 transition-all shadow-none", 
                        value: "font-black text-sm uppercase italic text-gray-900 dark:text-white" 
                      }}
                    >
                      <SelectItem key="empleado" textValue="EMPLEADO (Ventas)">EMPLEADO (Ventas)</SelectItem>
                      <SelectItem key="administrador" textValue="ADMINISTRADOR (Total)">ADMINISTRADOR (Total)</SelectItem>
                    </Select>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Input
                    label="Nombre Completo"
                    labelPlacement="outside"
                    value={addDialogOpen ? newUser.name : editingUser?.name}
                    onValueChange={(v) => {
                      if (addDialogOpen) setNewUser(p => ({ ...p, name: v.toUpperCase() }));
                      else setEditingUser(p => p ? { ...p, name: v.toUpperCase() } : null);
                    }}
                    classNames={{ 
                      label: "text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic mb-2",
                      inputWrapper: "h-14 bg-transparent border border-gray-200 dark:border-white/10 rounded-xl focus-within:!border-emerald-500 transition-all shadow-none", 
                      input: "font-black text-sm uppercase italic text-gray-900 dark:text-white bg-transparent" 
                    }}
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-1.5">
                    <Input
                      label="Email (Opcional)"
                      labelPlacement="outside"
                      value={addDialogOpen ? newUser.email : editingUser?.email}
                      onValueChange={(v) => {
                        if (addDialogOpen) setNewUser(p => ({ ...p, email: v }));
                        else setEditingUser(p => p ? { ...p, email: v } : null);
                      }}
                      startContent={<Mail size={12} className="text-gray-400 dark:text-zinc-500 mr-1" />}
                      classNames={{ 
                        label: "text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic mb-2",
                        inputWrapper: "h-14 bg-transparent border border-gray-200 dark:border-white/10 rounded-xl focus-within:!border-emerald-500 transition-all shadow-none", 
                        input: "font-black text-sm italic text-gray-900 dark:text-white bg-transparent" 
                      }}
                    />
                  </div>

                  {addDialogOpen && (
                    <div className="space-y-1.5">
                      <Input
                        type="password"
                        label="Contraseña Acceso"
                        labelPlacement="outside"
                        value={newUser.password}
                        onValueChange={(v) => setNewUser(p => ({ ...p, password: v }))}
                        startContent={<KeyRound size={12} className="text-gray-400 dark:text-zinc-500 mr-1" />}
                        classNames={{ 
                          label: "text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic mb-2",
                          inputWrapper: "h-14 bg-transparent border border-gray-200 dark:border-white/10 rounded-xl focus-within:!border-emerald-500 transition-all shadow-none", 
                          input: "font-black text-lg text-gray-900 dark:text-white tracking-widest bg-transparent" 
                        }}
                      />
                    </div>
                  )}
                </div>
                {editDialogOpen && (
                  <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 p-4 rounded-xl flex items-start gap-3 shadow-inner">
                    <AlertTriangle size={18} className="text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-[10px] font-bold text-amber-600 dark:text-amber-500/80 uppercase tracking-widest leading-relaxed">
                      La contraseña es fija y no puede ser modificada desde este panel por directrices de seguridad.
                    </p>
                  </div>
                )}
              </ModalBody>

              <ModalFooter className="p-8 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50">
                <Button
                  className="w-full h-16 bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase text-xs tracking-[0.2em] rounded-2xl transition-all shadow-xl hover:scale-105 active:scale-95 italic"
                  onPress={addDialogOpen ? handleAddUser : handleEditUser}
                >
                  <Sparkles size={20} className="mr-2" />
                  {addDialogOpen ? "AUTORIZAR ACCESO" : "GUARDAR CAMBIOS"}
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
                <div className="p-3 bg-rose-50 dark:bg-rose-500/10 rounded-xl"><AlertTriangle size={24} /></div> Revocar Acceso
              </ModalHeader>
              <ModalBody className="px-8 pb-8 text-center text-sm font-bold text-gray-500 dark:text-zinc-400 uppercase leading-relaxed tracking-widest italic">
                ¿Seguro que desea revocar permanentemente los permisos? Este empleado no podrá volver a ingresar al sistema POS.
              </ModalBody>
              <ModalFooter className="p-6 border-t border-gray-100 dark:border-white/5 flex gap-3">
                <Button variant="flat" className="flex-1 h-14 rounded-xl font-black text-[11px] tracking-widest bg-gray-100 dark:bg-zinc-900 text-gray-900 dark:text-white" onPress={onClose}>CANCELAR / MANTENER</Button>
                <Button color="danger" className="flex-1 h-14 rounded-xl font-black text-[11px] tracking-widest shadow-xl shadow-rose-500/20" onPress={handleDeleteUser}>SÍ, REVOCAR</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}