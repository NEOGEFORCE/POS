"use client";

import React, { memo } from 'react';
import {
    Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
    Button, Input, Switch, Tabs, Tab
} from "@heroui/react";
import { ShieldCheck, ShieldAlert, UserCircle, Mail, KeyRound, Sparkles, AlertTriangle, Zap, ToggleLeft, Info } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { User } from '@/lib/definitions';

interface FormModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    isEdit: boolean;
    initialUser: Partial<User>;
    onSave: (user: Partial<User>) => void;
}

export const UserFormModal = memo(({ isOpen, onOpenChange, isEdit, initialUser, onSave }: FormModalProps) => {
    const { user: currentUser } = useAuth();
    const [localUser, setLocalUser] = React.useState<Partial<User>>({});
    
    // Sincronizar estado local al abrir o cambiar de usuario
    React.useEffect(() => {
        if (isOpen) {
            setLocalUser({ 
                ...initialUser, 
                is_active: initialUser.is_active ?? true,
                role: (initialUser.role || (initialUser as any).Role || 'empleado').toLowerCase()
            });
        }
    }, [isOpen, initialUser]);

    const currentRole = (currentUser?.role || "").toLowerCase();
    const isTargetSuperAdmin = (localUser?.role?.toLowerCase() === 'superadmin');
    const isSelf = currentUser?.dni === localUser?.dni;
    const canFullEdit = currentRole === 'superadmin' || !isTargetSuperAdmin || (isTargetSuperAdmin && isSelf);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(localUser);
    };

    return (
        <Modal
            isOpen={isOpen} 
            onOpenChange={onOpenChange} 
            backdrop="opaque" 
            size="lg" 
            scrollBehavior="inside"
            classNames={{ 
                base: "bg-white dark:bg-zinc-950 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-2xl overflow-visible", 
                wrapper: "items-start sm:items-center mt-4 sm:mt-0 justify-center",
                closeButton: "text-gray-400 dark:text-zinc-500 hover:text-rose-500 transition-colors z-50 rounded-full",
                backdrop: "bg-black/50 backdrop-grayscale"
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <form onSubmit={handleSubmit}>
                        <ModalHeader className="flex flex-col gap-1 p-8 border-b border-gray-100 dark:border-white/5 bg-white/5 dark:bg-zinc-900/50 backdrop-blur-md rounded-t-[2rem]">
                            <h2 className="text-2xl font-black text-gray-900 dark:text-white italic tracking-tighter uppercase leading-none flex items-center gap-4">
                                <div className="h-14 w-14 bg-emerald-500/10 text-emerald-500 flex items-center justify-center rounded-2xl shadow-inner border border-emerald-500/20"><ShieldCheck size={28} /></div>
                                <div className="flex flex-col">
                                    <span>{!isEdit ? "Cifrar " : "Actualizar "} <span className="text-emerald-500">Acceso</span></span>
                                    <span className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.3em] mt-2 not-italic opacity-80">Nivel de Seguridad V4.0</span>
                                </div>
                            </h2>
                        </ModalHeader>

                        <ModalBody className="p-8 gap-8 pb-[40vh] sm:pb-8">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div className="space-y-1">
                                    <Input
                                        autoFocus
                                        label="DOCUMENTO DE IDENTIDAD"
                                        labelPlacement="inside"
                                        placeholder=" "
                                        value={localUser?.dni || ''}
                                        onValueChange={(v) => setLocalUser(p => ({ ...p, dni: v }))}
                                        onFocus={(e) => setTimeout(() => e.target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300)}
                                        isDisabled={isEdit}
                                        startContent={<UserCircle size={20} className="text-emerald-500 mr-2" />}
                                        classNames={{ 
                                            label: "text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.2em] mb-1.5",
                                            inputWrapper: "h-16 px-6 bg-white/50 dark:bg-black/20 border-2 border-transparent focus-within:!border-emerald-500/30 transition-all shadow-inner rounded-2xl", 
                                            input: "font-black text-sm uppercase italic text-gray-900 dark:text-white" 
                                        }}
                                    />
                                </div>

                                <div className="space-y-1">
                                    <Input
                                        label="NOMBRE COMPLETO"
                                        labelPlacement="inside"
                                        placeholder=" "
                                        value={localUser?.name || ''}
                                        onValueChange={(v) => setLocalUser(p => ({ ...p, name: v.toUpperCase() }))}
                                        onFocus={(e) => setTimeout(() => e.target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300)}
                                        startContent={<Sparkles size={18} className="text-emerald-500 mr-2" />}
                                        isDisabled={!canFullEdit}
                                        classNames={{ 
                                            label: "text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.2em] mb-1.5",
                                            inputWrapper: "h-16 px-6 bg-white/50 dark:bg-black/20 border-2 border-transparent focus-within:!border-emerald-500/30 transition-all shadow-inner rounded-2xl", 
                                            input: "font-black text-sm uppercase italic text-gray-900 dark:text-white" 
                                        }}
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <label className="text-[10px] font-black text-emerald-600 dark:text-emerald-400 uppercase tracking-widest ml-1 flex items-center gap-2">
                                    <ShieldCheck size={14} /> NIVEL DE PERMISOS / ROL DEL USUARIO
                                </label>
                                <Tabs 
                                    aria-label="Nivel de Rol"
                                    selectedKey={localUser?.role || 'empleado'}
                                    onSelectionChange={(key) => {
                                        if (!canFullEdit || isTargetSuperAdmin) return;
                                        setLocalUser(p => ({ ...p, role: String(key) }));
                                    }}
                                    isDisabled={!canFullEdit || isTargetSuperAdmin}
                                    variant="solid"
                                    color="success"
                                    fullWidth
                                    classNames={{
                                        tabList: "bg-gray-100 dark:bg-zinc-900 border border-gray-200 dark:border-white/5 p-1 rounded-xl h-12 shadow-inner",
                                        cursor: "bg-emerald-500 rounded-lg shadow-lg",
                                        tab: "h-full",
                                        tabContent: "font-black text-[9px] uppercase italic tracking-widest group-data-[selected=true]:text-white transition-all"
                                    }}
                                >
                                    <Tab key="empleado" title="EMPLEADO" />
                                    <Tab key="administrador" title="ADMINISTRADOR" />
                                    {isTargetSuperAdmin && (
                                        <Tab key="superadmin" title="SUPERADMIN" />
                                    )}
                                </Tabs>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                                <div className="space-y-1">
                                    <Input
                                        label={['admin', 'administrador', 'superadmin'].includes(localUser?.role || '') ? "EMAIL (REQUERIDO)" : "EMAIL (OPCIONAL)"}
                                        labelPlacement="inside"
                                        name="email"
                                        autoComplete="username"
                                        placeholder=" "
                                        value={localUser?.email || ''}
                                        onValueChange={(v) => setLocalUser(p => ({ ...p, email: v }))}
                                        isDisabled={!canFullEdit}
                                        onFocus={(e) => setTimeout(() => e.target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300)}
                                        startContent={<Mail size={22} className={`transition-colors mr-5 ${['admin', 'administrador', 'superadmin'].includes(localUser?.role || '') ? 'text-emerald-500' : 'text-gray-400'}`} />}
                                        classNames={{ 
                                            label: "text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest",
                                            inputWrapper: `h-18 px-10 bg-gray-50/50 dark:bg-zinc-900/30 border-2 transition-all shadow-inner rounded-2xl ${['admin', 'administrador', 'superadmin'].includes(localUser?.role || '') ? 'border-emerald-500/30' : 'border-transparent'}`, 
                                            input: "font-black text-sm italic text-gray-900 dark:text-white bg-transparent" 
                                        }}
                                    />
                                </div>
                                <div className="space-y-1">
                                    <input type="text" name="username" autoComplete="username" className="hidden" value={localUser?.email || localUser?.dni || ''} readOnly />
                                    <Input
                                        type="password"
                                        name="password"
                                        autoComplete="new-password"
                                        label={isEdit ? "NUEVA CONTRASEÑA (OPCIONAL)" : "CONTRASEÑA"}
                                        labelPlacement="inside"
                                        placeholder=" "
                                        value={localUser?.password || ''}
                                        onValueChange={(v) => setLocalUser(p => ({ ...p, password: v }))}
                                        isDisabled={!canFullEdit}
                                        onFocus={(e) => setTimeout(() => e.target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300)}
                                        startContent={<KeyRound size={22} className="text-emerald-500/40 mr-5" />}
                                        classNames={{ 
                                            label: "text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest",
                                            inputWrapper: "h-18 px-10 bg-gray-50/50 dark:bg-zinc-900/30 border border-transparent focus-within:!border-emerald-500/50 transition-all shadow-inner rounded-2xl", 
                                            input: "font-black text-base text-gray-900 dark:text-white tracking-[0.2em] bg-transparent" 
                                        }}
                                    />
                                </div>
                            </div>
                            
                            {isEdit && !isTargetSuperAdmin && (
                                <div className="flex items-center justify-between p-5 bg-gray-50 dark:bg-zinc-900/50 border border-gray-200 dark:border-white/10 rounded-xl shadow-inner group">
                                    <div className="flex flex-col">
                                        <span className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.2em] italic mb-1">Estado de Acceso</span>
                                        <span className={`text-xs font-black italic uppercase ${(localUser?.is_active || isTargetSuperAdmin) ? 'text-emerald-500' : 'text-rose-500'}`}>
                                            {(localUser?.is_active || isTargetSuperAdmin) ? 'Perfil Activo / Operativo' : 'Perfil Suspendido / Inactivo'}
                                        </span>
                                    </div>
                                    <Switch 
                                        isDisabled={!canFullEdit || isTargetSuperAdmin}
                                        isSelected={localUser?.is_active || isTargetSuperAdmin} 
                                        onValueChange={(v) => {
                                            if (!canFullEdit || isTargetSuperAdmin) return;
                                            setLocalUser(p => ({ ...p, is_active: v }));
                                        }}
                                        color={(localUser?.is_active || isTargetSuperAdmin) ? "success" : "danger"}
                                        classNames={{
                                            wrapper: "group-data-[selected=true]:bg-emerald-500 bg-rose-500",
                                            thumb: "bg-white"
                                        }}
                                    />
                                </div>
                            )}
                            
                            {isEdit && isTargetSuperAdmin && (
                                <div className="bg-emerald-500/5 border border-emerald-500/20 p-5 rounded-xl flex items-center gap-4 shadow-sm">
                                    <ShieldAlert size={18} className="text-emerald-500 shrink-0" />
                                    <p className="text-[9px] font-black text-emerald-600 dark:text-emerald-400 uppercase tracking-[0.15em] leading-relaxed italic">
                                        CUENTA MAESTRA DEL SISTEMA: <span className="underline underline-offset-4 decoration-2">PROTECCIÓN TOTAL</span>. ESTE PERFIL ES INDISPENSABLE PARA EL FUNCIONAMIENTO DEL NEGOCIO Y NO PUEDE SER DESACTIVADO.
                                    </p>
                                </div>
                            )}
                        </ModalBody>

                        <ModalFooter className="p-10 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-b-[2.5rem]">
                                <Button
                                    type="submit"
                                    isDisabled={!localUser?.dni?.trim() || !localUser?.name?.trim()}
                                    className="w-full h-12 bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase text-[10px] tracking-[0.2em] rounded-xl transition-all shadow-xl hover:scale-[1.02] active:scale-95 italic ring-4 ring-black/5 dark:ring-white/5 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <Sparkles size={24} className="mr-3" />
                                    {!isEdit ? "AUTORIZAR ACCESO MAESTRO" : "SINCRONIZAR CAMBIOS"}
                                </Button>
                        </ModalFooter>
                    </form>
                )}
            </ModalContent>
        </Modal>
    );
});

UserFormModal.displayName = 'UserFormModal';

interface DeleteModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
}

export const DeleteUserModal = memo(({ isOpen, onOpenChange, onConfirm }: DeleteModalProps) => {
    return (
        <Modal
            isOpen={isOpen} 
            onOpenChange={onOpenChange} 
            placement="top"
            backdrop="blur"
            scrollBehavior="inside"
            classNames={{ 
                base: "bg-white dark:bg-zinc-950 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-2xl m-4 sm:m-0", 
                wrapper: "items-start sm:items-center mt-4 sm:mt-0 justify-center",
                closeButton: "text-gray-400 hover:text-rose-500 transition-colors z-50 rounded-full",
                backdrop: "bg-black/50 backdrop-grayscale"
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="flex items-center gap-4 p-10 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-t-[2.5rem]">
                            <div className="h-16 w-16 bg-rose-500/10 text-rose-500 flex items-center justify-center rounded-2xl shadow-inner -rotate-3"><AlertTriangle size={32} /></div>
                            <div className="flex flex-col">
                                <span className="text-xl font-black text-gray-900 dark:text-white uppercase italic tracking-tighter leading-none">Revocar Acceso</span>
                                <span className="text-[10px] font-black text-rose-500 uppercase tracking-[0.3em] mt-3 not-italic">Acción de Auditoría</span>
                            </div>
                        </ModalHeader>
                        <ModalBody className="p-10 text-center gap-8">
                            <div className="flex justify-center">
                                <div className="h-24 w-24 bg-rose-500/5 rounded-full flex items-center justify-center text-rose-500 animate-pulse ring-8 ring-rose-500/5">
                                    <ShieldCheck size={48} className="opacity-50" />
                                </div>
                            </div>
                            <p className="text-base font-bold text-gray-500 dark:text-zinc-400 uppercase leading-relaxed tracking-widest italic px-4">
                                ¿Confirma la revocación permanente de permisos? <br/>
                                <span className="text-rose-500 font-black">Este colaborador perderá toda facultad operativa en el sistema.</span>
                            </p>
                        </ModalBody>
                        <ModalFooter className="p-10 border-t border-gray-100 dark:border-white/5 flex gap-4 rounded-b-[2.5rem] bg-gray-50/50 dark:bg-zinc-900/50">
                            <Button 
                                variant="flat" 
                                className="flex-1 h-12 rounded-xl font-black text-[10px] tracking-widest bg-gray-100 dark:bg-zinc-900 text-gray-400 dark:text-zinc-500 uppercase hover:bg-gray-200 dark:hover:bg-zinc-800 italic transition-all" 
                                onPress={onClose}
                            >
                                CANCELAR
                            </Button>
                            <Button 
                                color="danger" 
                                className="flex-1 h-12 rounded-xl font-black text-[10px] tracking-widest shadow-xl shadow-rose-500/20 uppercase bg-rose-500 text-white italic hover:scale-[1.02] active:scale-95 transition-all" 
                                onPress={onConfirm}
                            >
                                SÍ, REVOCAR
                            </Button>
                        </ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
});

DeleteUserModal.displayName = 'DeleteUserModal';

interface ResetPasswordModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    user: Partial<User>;
    onConfirm: (newPassword: string) => void;
}

export const ResetPasswordModal = memo(({ isOpen, onOpenChange, user, onConfirm }: ResetPasswordModalProps) => {
    const [password, setPassword] = React.useState("");

    return (
        <Modal
            isOpen={isOpen} 
            onOpenChange={onOpenChange} 
            placement="top"
            backdrop="blur"
            scrollBehavior="inside"
            classNames={{ 
                base: "bg-white dark:bg-zinc-950 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-2xl m-4 sm:m-0", 
                wrapper: "items-start sm:items-center mt-4 sm:mt-0 justify-center",
                closeButton: "text-gray-400 hover:text-rose-500 transition-colors z-50 rounded-full",
                backdrop: "bg-black/50 backdrop-grayscale"
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <form onSubmit={(e) => {
                        e.preventDefault();
                        onConfirm(password);
                        setPassword("");
                        onClose();
                    }}>
                        <ModalHeader className="flex items-center gap-4 p-10 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-t-[2.5rem]">
                            <div className="h-16 w-16 bg-amber-500/10 text-amber-500 flex items-center justify-center rounded-2xl shadow-inner rotate-6"><Zap size={32} /></div>
                            <div className="flex flex-col">
                                <span className="text-xl font-black text-gray-900 dark:text-white uppercase italic tracking-tighter leading-none">Nueva Credencial</span>
                                <span className="text-[10px] font-black text-amber-500 uppercase tracking-[0.3em] mt-3 not-italic">Sobreescritura de Seguridad</span>
                            </div>
                        </ModalHeader>
                        <ModalBody className="p-10 gap-8 pb-[40vh] sm:pb-10">
                            <div className="space-y-4">
                                <p className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-relaxed text-center italic">
                                    Generando nueva clave de acceso para:<br/>
                                    <span className="text-gray-900 dark:text-white text-sm">{user?.name} (DNI: {user?.dni})</span>
                                </p>
                                <input type="text" name="username" autoComplete="username" className="hidden" value={user?.dni || ''} readOnly />
                                <Input
                                    type="password"
                                    name="password"
                                    autoComplete="new-password"
                                    label="Contraseña Temporal"
                                    labelPlacement="inside"
                                    placeholder=" "
                                    value={password}
                                    onValueChange={setPassword}
                                    onFocus={(e) => setTimeout(() => e.target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300)}
                                    startContent={<KeyRound size={22} className="text-gray-400 dark:text-zinc-500/40 mr-5" />}
                                    classNames={{ 
                                        label: "text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest",
                                        inputWrapper: "h-18 px-10 bg-gray-50/50 dark:bg-zinc-900/30 border border-gray-100 dark:border-white/5 rounded-2xl focus-within:!border-amber-500 transition-all shadow-inner", 
                                        input: "font-black text-base text-gray-900 dark:text-white tracking-[0.2em] bg-transparent" 
                                    }}
                                />
                            </div>
                        </ModalBody>
                        <ModalFooter className="p-10 border-t border-gray-100 dark:border-white/5 flex gap-4 rounded-b-[2.5rem] bg-gray-50/50 dark:bg-zinc-900/50">
                            <Button 
                                variant="flat" 
                                className="flex-1 h-12 rounded-xl font-black text-[10px] tracking-widest bg-gray-100 dark:bg-zinc-900 text-gray-400 dark:text-zinc-500 uppercase hover:bg-gray-200 dark:hover:bg-zinc-800 italic transition-all" 
                                onPress={() => { setPassword(""); onClose(); }}
                            >
                                CANCELAR
                            </Button>
                            <Button 
                                type="submit"
                                isDisabled={!password.trim()}
                                className="flex-1 h-12 rounded-xl font-black text-[10px] tracking-widest shadow-xl shadow-amber-500/20 uppercase bg-amber-500 text-white italic hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed" 
                            >
                                ACTUALIZAR CLAVE
                            </Button>
                        </ModalFooter>
                    </form>
                )}
            </ModalContent>
        </Modal>
    );
});

ResetPasswordModal.displayName = 'ResetPasswordModal';