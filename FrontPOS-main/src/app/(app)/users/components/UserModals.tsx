"use client";

import React, { memo } from 'react';
import {
    Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
    Button, Input, Switch, Tabs, Tab, Spinner
} from "@heroui/react";
import { ShieldCheck, ShieldAlert, UserCircle, Mail, KeyRound, Sparkles, AlertTriangle, Zap, ToggleLeft, Info, UserCheck, UserX } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { User } from '@/lib/definitions';
import { validateUser, FieldError } from '@/lib/formValidation';
import ValidationErrors from '@/components/ValidationErrors';

interface FormModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    isEdit: boolean;
    initialUser: Partial<User>;
    onSave: (user: Partial<User>) => void;
    onLookupDni?: (dni: string) => void;
}

export const UserFormModal = memo(({ isOpen, onOpenChange, isEdit, initialUser, onSave, onLookupDni }: FormModalProps) => {
    const { user: currentUser } = useAuth();
    const [localUser, setLocalUser] = React.useState<Partial<User>>({});
    const [isCheckingDni, setIsCheckingDni] = React.useState(false);
    const [validationErrors, setValidationErrors] = React.useState<FieldError[]>([]);

    // Sincronizar estado local al abrir o cambiar de usuario
    React.useEffect(() => {
        if (isOpen) {
            setLocalUser({
                ...initialUser,
                is_active: initialUser.is_active ?? true,
                role: (initialUser.role || (initialUser as any).Role || 'empleado').toLowerCase()
            });
        }
    }, [isOpen, initialUser, isEdit]); // Añadido isEdit para detectar cambio de modo activo


    const currentRole = (currentUser?.role || "").toLowerCase();
    const isTargetSuperAdmin = (localUser?.role?.toLowerCase() === 'superadmin');
    const isSelf = currentUser?.dni === localUser?.dni;
    const canFullEdit = currentRole === 'superadmin' || !isTargetSuperAdmin || (isTargetSuperAdmin && isSelf);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const result = validateUser({
            dni: localUser.dni,
            name: localUser.name,
            email: localUser.email,
            password: localUser.password,
            role: localUser.role,
            isEdit: isEdit,
        });
        if (!result.isValid) {
            setValidationErrors(result.errors);
            return;
        }
        setValidationErrors([]);
        onSave(localUser);
    };

    return (
        <Modal
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            backdrop="opaque"
            size="2xl"
            scrollBehavior="inside"
            classNames={{
                base: "bg-white dark:bg-zinc-950 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-2xl overflow-visible mx-2 md:mx-0",
                wrapper: "items-start sm:items-center mt-12 sm:mt-0 justify-center",
                closeButton: "absolute right-5 top-5 text-gray-400 dark:text-zinc-500 hover:text-rose-500 transition-colors z-[100] rounded-full",
                backdrop: "bg-black/50 backdrop-blur-md"
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <form onSubmit={handleSubmit}>
                        <ModalHeader className="flex flex-col gap-1 px-5 md:px-12 py-3 md:py-4 border-b border-gray-100 dark:border-white/5 bg-white/5 dark:bg-zinc-900/50 backdrop-blur-md rounded-t-2xl md:rounded-t-[2rem]">
                            <h2 className="text-lg md:text-2xl font-black text-gray-900 dark:text-white italic tracking-tighter uppercase leading-none flex items-center gap-3 md:gap-4">
                                <div className="h-8 w-8 md:h-14 md:w-14 bg-emerald-500/10 text-emerald-500 flex items-center justify-center rounded-lg md:rounded-2xl border border-emerald-500/20"><ShieldCheck size={16} className="md:size-7" /></div>
                                <div className="flex flex-col gap-0.5 md:gap-1">
                                    <span>{!isEdit ? "Cifrar " : "Actualizar "} <span className="text-emerald-500">Acceso</span></span>
                                    <span className="text-[7px] md:text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest not-italic opacity-80">Seguro v4.0</span>
                                </div>
                            </h2>
                        </ModalHeader>

                        <ModalBody className="px-5 md:px-12 py-3 md:py-6 gap-2 md:gap-4 pb-4 sm:pb-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 md:gap-4">
                                <div>
                                    <Input
                                        autoFocus
                                        label="DNI"
                                        labelPlacement="inside"
                                        placeholder=" "
                                        value={localUser?.dni || ''}
                                        onValueChange={(v) => {
                                            setLocalUser(p => ({ ...p, dni: v }));
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !isEdit && localUser.dni && localUser.dni.length >= 5 && onLookupDni) {
                                                onLookupDni(localUser.dni);
                                            }
                                        }}
                                        onBlur={() => {
                                            if (!isEdit && localUser.dni && localUser.dni.length >= 5 && onLookupDni) {
                                                onLookupDni(localUser.dni);
                                            }
                                        }}
                                        onFocus={(e) => setTimeout(() => e.target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300)}
                                        isDisabled={isEdit}
                                        endContent={isCheckingDni ? <Spinner size="sm" color="success" /> : null}
                                        startContent={<UserCircle size={20} className="text-emerald-500 mr-3" />}
                                        classNames={{
                                            label: "absolute z-10 pointer-events-none origin-top-left shrink-0 rtl:origin-top-right subpixel-antialiased block cursor-text will-change-auto !duration-200 !ease-out motion-reduce:transition-none transition-[transform,color,left,opacity,translate,scale] group-data-[filled-within=true]:text-default-600 group-data-[filled-within=true]:pointer-events-auto group-data-[filled-within=true]:scale-85 group-data-[filled-within=true]:-translate-y-[calc(50%_+_var(--heroui-font-size-small)/2_-_6px)] pe-2 max-w-full text-ellipsis overflow-hidden text-[9px] md:text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest",
                                            inputWrapper: "relative w-full inline-flex tap-highlight-transparent shadow-xs data-[hover=true]:bg-default-200 group-data-[focus=true]:bg-default-100 min-h-10 flex-col items-start justify-center gap-0 motion-reduce:transition-none !duration-150 outline-solid outline-transparent group-data-[focus-visible=true]:z-10 group-data-[focus-visible=true]:ring-2 group-data-[focus-visible=true]:ring-focus group-data-[focus-visible=true]:ring-offset-2 group-data-[focus-visible=true]:ring-offset-background py-2 h-13 md:h-18 md:min-h-[72px] px-4 bg-white/50 dark:bg-black/20 border-2 transition-all shadow-inner rounded-2xl border-transparent focus-within:!border-emerald-500/30",
                                            input: "w-full bg-transparent !outline-solid placeholder:text-foreground-500 focus-visible:outline-solid outline-transparent data-[has-start-content=true]:ps-1.5 data-[has-end-content=true]:pe-1.5 data-[type=color]:rounded-none file:cursor-pointer file:bg-transparent file:border-0 autofill:bg-transparent bg-clip-text dark:autofill:[-webkit-text-fill-color:hsl(var(--heroui-foreground))] [&::-ms-reveal]:hidden group-data-[has-value=true]:text-default-foreground font-black text-sm md:text-base uppercase italic text-gray-900 dark:text-white"
                                        }}
                                    />
                                </div>

                                <div>
                                    <Input
                                        label="NOMBRE COMPLETO"
                                        labelPlacement="inside"
                                        placeholder=" "
                                        value={localUser?.name || ''}
                                        onValueChange={(v) => setLocalUser(p => ({ ...p, name: v.toUpperCase() }))}
                                        onFocus={(e) => setTimeout(() => e.target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300)}
                                        startContent={<Sparkles size={20} className="text-emerald-500 mr-3" />}
                                        isDisabled={!canFullEdit}
                                        classNames={{
                                            label: "absolute z-10 pointer-events-none origin-top-left shrink-0 rtl:origin-top-right subpixel-antialiased block cursor-text will-change-auto !duration-200 !ease-out motion-reduce:transition-none transition-[transform,color,left,opacity,translate,scale] group-data-[filled-within=true]:text-default-600 group-data-[filled-within=true]:pointer-events-auto group-data-[filled-within=true]:scale-85 group-data-[filled-within=true]:-translate-y-[calc(50%_+_var(--heroui-font-size-small)/2_-_6px)] pe-2 max-w-full text-ellipsis overflow-hidden text-[9px] md:text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest",
                                            inputWrapper: "relative w-full inline-flex tap-highlight-transparent shadow-xs data-[hover=true]:bg-default-200 group-data-[focus=true]:bg-default-100 min-h-10 flex-col items-start justify-center gap-0 motion-reduce:transition-none !duration-150 outline-solid outline-transparent group-data-[focus-visible=true]:z-10 group-data-[focus-visible=true]:ring-2 group-data-[focus-visible=true]:ring-focus group-data-[focus-visible=true]:ring-offset-2 group-data-[focus-visible=true]:ring-offset-background py-2 h-13 md:h-18 md:min-h-[72px] px-4 bg-white/50 dark:bg-black/20 border-2 transition-all shadow-inner rounded-2xl border-transparent focus-within:!border-emerald-500/30",
                                            input: "w-full bg-transparent !outline-solid placeholder:text-foreground-500 focus-visible:outline-solid outline-transparent data-[has-start-content=true]:ps-1.5 data-[has-end-content=true]:pe-1.5 data-[type=color]:rounded-none file:cursor-pointer file:bg-transparent file:border-0 autofill:bg-transparent bg-clip-text dark:autofill:[-webkit-text-fill-color:hsl(var(--heroui-foreground))] [&::-ms-reveal]:hidden group-data-[has-value=true]:text-default-foreground font-black text-sm md:text-base uppercase italic text-gray-900 dark:text-white"
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
                                    fullWidth
                                    classNames={{
                                        tabList: "bg-gray-200/50 dark:bg-black/80 border-2 border-gray-400 dark:border-white/10 p-2 rounded-2xl h-14 md:h-20 shadow-inner",
                                        cursor: "bg-emerald-500 dark:bg-emerald-700 rounded-xl md:rounded-2xl shadow-[0_0_20px_rgba(16,185,129,0.4)] border-2 border-white/10",
                                        tab: "h-full transition-all duration-400",
                                        tabContent: "font-black text-[10px] md:text-[13px] uppercase tracking-[0.1em] md:tracking-[0.15em] text-gray-400 dark:text-white/30 group-data-[selected=true]:text-black dark:group-data-[selected=true]:!text-white group-data-[selected=true]:scale-115 md:group-data-[selected=true]:scale-120 group-data-[selected=true]:opacity-100 opacity-60 transition-all duration-400 dark:group-data-[selected=true]:drop-shadow-[0_0_8px_rgba(255,255,255,0.8)]"
                                    }}
                                >
                                    <Tab
                                        key="empleado"
                                        title={
                                            <div className="flex items-center gap-3">
                                                <UserCircle size={20} />
                                                <span>EMPLEADO</span>
                                            </div>
                                        }
                                    />
                                    <Tab
                                        key="administrador"
                                        title={
                                            <div className="flex items-center gap-3">
                                                <ShieldCheck size={20} />
                                                <span>ADMINISTRADOR</span>
                                            </div>
                                        }
                                    />
                                    {isTargetSuperAdmin && (
                                        <Tab
                                            key="superadmin"
                                            title={
                                                <div className="flex items-center gap-3">
                                                    <ShieldAlert size={20} />
                                                    <span>SUPER-ADMIN</span>
                                                </div>
                                            }
                                        />
                                    )}
                                </Tabs>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 md:gap-4">
                                <div>
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
                                        startContent={<Mail size={20} className={`transition-colors mr-3 ${['admin', 'administrador', 'superadmin'].includes(localUser?.role || '') ? 'text-emerald-500' : 'text-gray-400'}`} />}
                                        classNames={{
                                            label: "absolute z-10 pointer-events-none origin-top-left shrink-0 rtl:origin-top-right subpixel-antialiased block cursor-text will-change-auto !duration-200 !ease-out motion-reduce:transition-none transition-[transform,color,left,opacity,translate,scale] group-data-[filled-within=true]:text-default-600 group-data-[filled-within=true]:pointer-events-auto group-data-[filled-within=true]:scale-85 group-data-[filled-within=true]:-translate-y-[calc(50%_+_var(--heroui-font-size-small)/2_-_6px)] pe-2 max-w-full text-ellipsis overflow-hidden text-[9px] md:text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest",
                                            inputWrapper: `relative w-full inline-flex tap-highlight-transparent shadow-xs data-[hover=true]:bg-default-200 group-data-[focus=true]:bg-default-100 min-h-10 flex-col items-start justify-center gap-0 motion-reduce:transition-none !duration-150 outline-solid outline-transparent group-data-[focus-visible=true]:z-10 group-data-[focus-visible=true]:ring-2 group-data-[focus-visible=true]:ring-focus group-data-[focus-visible=true]:ring-offset-2 group-data-[focus-visible=true]:ring-offset-background py-2 h-13 md:h-18 md:min-h-[72px] px-4 bg-white/50 dark:bg-black/20 border-2 transition-all shadow-inner rounded-2xl ${['admin', 'administrador', 'superadmin'].includes(localUser?.role || '') ? 'border-emerald-500/30' : 'border-transparent'}`,
                                            input: "w-full bg-transparent !outline-solid placeholder:text-foreground-500 focus-visible:outline-solid outline-transparent data-[has-start-content=true]:ps-1.5 data-[has-end-content=true]:pe-1.5 data-[type=color]:rounded-none file:cursor-pointer file:bg-transparent file:border-0 autofill:bg-transparent bg-clip-text dark:autofill:[-webkit-text-fill-color:hsl(var(--heroui-foreground))] [&::-ms-reveal]:hidden group-data-[has-value=true]:text-default-foreground font-black text-sm md:text-base uppercase italic text-gray-900 dark:text-white"
                                        }}
                                    />
                                </div>
                                <div className="relative">
                                    <input type="text" name="username" autoComplete="username" className="hidden" value={localUser?.email || localUser?.dni || ''} readOnly />
                                    <Input
                                        label="NUEVA CLAVE DE ACCESO"
                                        labelPlacement="inside"
                                        placeholder={isEdit ? "(OPCIONAL)" : "DEFINIR CLAVE"}
                                        type="text"
                                        value={localUser?.password || ''}
                                        onValueChange={(v) => setLocalUser(p => ({ ...p, password: v }))}
                                        onFocus={(e) => setTimeout(() => e.target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300)}
                                        startContent={<ShieldCheck size={20} className="text-emerald-500 mr-3" />}
                                        classNames={{
                                            label: "absolute z-10 pointer-events-none origin-top-left shrink-0 rtl:origin-top-right subpixel-antialiased block cursor-text will-change-auto !duration-200 !ease-out motion-reduce:transition-none transition-[transform,color,left,opacity,translate,scale] group-data-[filled-within=true]:text-default-600 group-data-[filled-within=true]:pointer-events-auto group-data-[filled-within=true]:scale-85 group-data-[filled-within=true]:-translate-y-[calc(50%_+_var(--heroui-font-size-small)/2_-_6px)] pe-2 max-w-full text-ellipsis overflow-hidden text-[9px] md:text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest",
                                            inputWrapper: "relative w-full inline-flex tap-highlight-transparent shadow-sm data-[hover=true]:bg-default-200 group-data-[focus=true]:bg-default-100 min-h-10 flex-col items-start justify-center gap-0 motion-reduce:transition-none !duration-150 outline-solid outline-transparent group-data-[focus-visible=true]:z-10 group-data-[focus-visible=true]:ring-2 group-data-[focus-visible=true]:ring-focus group-data-[focus-visible=true]:ring-offset-2 group-data-[focus-visible=true]:ring-offset-background py-2 h-13 md:h-18 md:min-h-[72px] px-4 bg-white dark:bg-zinc-900 border-2 transition-all rounded-2xl border-gray-100 dark:border-white/5 focus-within:!border-emerald-500/30",
                                            input: "w-full bg-transparent !outline-solid placeholder:text-foreground-500 focus-visible:outline-solid outline-transparent data-[has-start-content=true]:ps-1.5 data-[has-end-content=true]:pe-1.5 data-[type=color]:rounded-none file:cursor-pointer file:bg-transparent file:border-0 autofill:bg-transparent bg-clip-text dark:autofill:[-webkit-text-fill-color:hsl(var(--heroui-foreground))] [&::-ms-reveal]:hidden group-data-[has-value=true]:text-default-foreground font-black text-sm md:text-base uppercase italic text-gray-900 dark:text-white"
                                        }}
                                    />
                                </div>
                            </div>
                        </ModalBody>

                        <ModalFooter className="px-5 md:px-12 py-3 md:py-4 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-b-2xl md:rounded-b-[2.5rem]">
                            {validationErrors.length > 0 && (
                                <div className="w-full mb-3">
                                    <ValidationErrors errors={validationErrors} />
                                </div>
                            )}
                            <Button
                                type="submit"
                                isDisabled={!localUser?.dni?.trim() || !localUser?.name?.trim()}
                                className="w-full h-11 md:h-14 bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase text-[10px] md:text-[11px] tracking-widest rounded-xl transition-all shadow-xl hover:scale-[1.01] active:scale-95 italic"
                            >
                                <ShieldCheck size={18} className="mr-3" />
                                {!isEdit ? "AUTORIZAR ACCESO" : "GUARDAR CAMBIOS"}
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
                base: "bg-white dark:bg-zinc-950 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-2xl mx-2 md:mx-0",
                wrapper: "items-start sm:items-center mt-12 sm:mt-0 justify-center",
                closeButton: "absolute right-5 top-5 text-gray-400 hover:text-rose-500 transition-colors z-[100] rounded-full",
                backdrop: "bg-black/40 backdrop-blur-md"
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="flex items-center gap-4 px-6 md:px-10 py-5 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-t-[2.5rem]">
                            <div className="h-16 w-16 bg-rose-500/10 text-rose-500 flex items-center justify-center rounded-2xl shadow-inner -rotate-3"><AlertTriangle size={32} /></div>
                            <div className="flex flex-col">
                                <span className="text-xl font-black text-gray-900 dark:text-white uppercase italic tracking-tighter leading-none">Revocar Acceso</span>
                                <span className="text-[10px] font-black text-rose-500 uppercase tracking-[0.3em] mt-3 not-italic">Acción de Auditoría</span>
                            </div>
                        </ModalHeader>
                        <ModalBody className="p-6 md:p-10 text-center gap-6">
                            <div className="flex justify-center">
                                <div className="h-20 w-20 bg-rose-500/5 rounded-full flex items-center justify-center text-rose-500 animate-pulse ring-8 ring-rose-500/5">
                                    <ShieldCheck size={40} className="opacity-50" />
                                </div>
                            </div>
                            <p className="text-base font-bold text-gray-500 dark:text-zinc-400 uppercase leading-relaxed tracking-widest italic px-4">
                                ¿Confirma la revocación permanente de permisos? <br />
                                <span className="text-rose-500 font-black">Este colaborador perderá toda facultad operativa en el sistema.</span>
                            </p>
                        </ModalBody>
                        <ModalFooter className="px-6 md:px-10 py-6 border-t border-gray-100 dark:border-white/5 flex gap-4 rounded-b-[2.5rem] bg-gray-50/50 dark:bg-zinc-900/50">
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
            size="lg"
            classNames={{
                base: "bg-white dark:bg-zinc-950 rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-2xl mx-2 md:mx-0",
                wrapper: "items-start sm:items-center mt-12 sm:mt-0 justify-center",
                closeButton: "absolute right-5 top-5 text-gray-400 hover:text-rose-500 transition-colors z-[100] rounded-full",
                backdrop: "bg-black/40 backdrop-blur-md"
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
                        <ModalHeader className="flex items-center gap-4 px-6 md:px-10 py-4 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-t-[2.5rem]">
                            <div className="h-16 w-16 bg-amber-500/10 text-amber-500 flex items-center justify-center rounded-2xl shadow-inner rotate-6"><Zap size={32} /></div>
                            <div className="flex flex-col">
                                <span className="text-xl font-black text-gray-900 dark:text-white uppercase italic tracking-tighter leading-none">Nueva Credencial</span>
                                <span className="text-[10px] font-black text-amber-500 uppercase tracking-[0.3em] mt-3 not-italic">Sobreescritura de Seguridad</span>
                            </div>
                        </ModalHeader>
                        <ModalBody className="p-6 gap-4 pb-6 sm:pb-6">
                            <div className="space-y-4">
                                <p className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-relaxed text-center italic">
                                    Generando nueva clave de acceso para:<br />
                                    <span className="text-gray-900 dark:text-white text-sm">{user?.name} (DNI: {user?.dni})</span>
                                </p>
                                <input type="text" name="username" autoComplete="username" className="hidden" value={user?.dni || ''} readOnly />
                                <Input
                                    type="password"
                                    name="password"
                                    autoComplete="new-password"
                                    label="DEFINIR NUEVA CLAVE"
                                    labelPlacement="inside"
                                    placeholder=" "
                                    value={password}
                                    onValueChange={setPassword}
                                    onFocus={(e) => setTimeout(() => e.target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300)}
                                    startContent={<KeyRound size={22} className="text-amber-500/40 mr-5" />}
                                    classNames={{
                                        label: "absolute z-10 pointer-events-none origin-top-left shrink-0 rtl:origin-top-right subpixel-antialiased block cursor-text will-change-auto !duration-200 !ease-out motion-reduce:transition-none transition-[transform,color,left,opacity,translate,scale] group-data-[filled-within=true]:text-default-600 group-data-[filled-within=true]:pointer-events-auto group-data-[filled-within=true]:scale-85 group-data-[filled-within=true]:-translate-y-[calc(50%_+_var(--heroui-font-size-small)/2_-_6px)] pe-2 max-w-full text-ellipsis overflow-hidden text-[9px] md:text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest",
                                        inputWrapper: "relative w-full inline-flex tap-highlight-transparent shadow-xs data-[hover=true]:bg-default-200 group-data-[focus=true]:bg-default-100 min-h-10 flex-col items-start justify-center gap-0 motion-reduce:transition-none !duration-150 outline-solid outline-transparent group-data-[focus-visible=true]:z-10 group-data-[focus-visible=true]:ring-2 group-data-[focus-visible=true]:ring-focus group-data-[focus-visible=true]:ring-offset-2 group-data-[focus-visible=true]:ring-offset-background py-2 h-13 md:h-18 md:min-h-[72px] px-4 bg-gray-50/50 dark:bg-zinc-900/30 border-2 border-transparent focus-within:!border-amber-500 transition-all shadow-inner rounded-2xl",
                                        input: "w-full bg-transparent !outline-solid placeholder:text-foreground-500 focus-visible:outline-solid outline-transparent data-[has-start-content=true]:ps-1.5 data-[has-end-content=true]:pe-1.5 data-[type=color]:rounded-none file:cursor-pointer file:bg-transparent file:border-0 autofill:bg-transparent bg-clip-text dark:autofill:[-webkit-text-fill-color:hsl(var(--heroui-foreground))] [&::-ms-reveal]:hidden group-data-[has-value=true]:text-default-foreground font-black text-base text-gray-900 dark:text-white tracking-[0.2em]"
                                    }}
                                />
                            </div>
                        </ModalBody>
                        <ModalFooter className="px-6 md:px-10 py-4 border-t border-gray-100 dark:border-white/5 flex gap-4 rounded-b-[2.5rem] bg-gray-50/50 dark:bg-zinc-900/50">
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

// COMPONENTE WRAPPER PRINCIPAL (ENTRADA ÚNICA)
export const UserModals = memo(({ 
    isOpen, 
    onOpenChange, 
    editMode, 
    user, 
    onSave,
    onLookupDni
}: { 
    isOpen: boolean, 
    onOpenChange: (open: boolean) => void, 
    editMode: boolean, 
    user: any, 
    onSave: (user: any) => void,
    onLookupDni?: (dni: string) => void
}) => {
    return (
        <UserFormModal 
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            isEdit={editMode}
            initialUser={user || {}}
            onSave={onSave}
            onLookupDni={onLookupDni}
        />
    );
});

UserModals.displayName = 'UserModals';