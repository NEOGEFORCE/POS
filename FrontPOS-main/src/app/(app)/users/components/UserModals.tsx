"use client";

import React, { memo } from 'react';
import {
    Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
    Button, Input, Select, SelectItem
} from "@heroui/react";
import { ShieldCheck, UserCircle, Mail, KeyRound, Sparkles, AlertTriangle } from 'lucide-react';

import { User } from '@/lib/definitions';

interface FormModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    isEdit: boolean;
    user: Partial<User>;
    setUser: React.Dispatch<React.SetStateAction<Partial<User>>>;
    onSave: () => void;
}

export const UserFormModal = memo(({ isOpen, onOpenChange, isEdit, user, setUser, onSave }: FormModalProps) => {
    return (
        <Modal 
            isOpen={isOpen} 
            onOpenChange={onOpenChange} 
            backdrop="blur" 
            size="lg" 
            classNames={{ 
                base: "bg-white dark:bg-zinc-950 rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-2xl overflow-visible", 
                closeButton: "text-gray-400 dark:text-zinc-500 hover:text-rose-500 transition-colors z-50 rounded-full" 
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="flex flex-col gap-1 p-10 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-t-[2.5rem]">
                            <h2 className="text-2xl font-black text-gray-900 dark:text-white italic tracking-tighter uppercase leading-none flex items-center gap-4">
                                <div className="h-16 w-16 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-500 flex items-center justify-center rounded-2xl shadow-inner rotate-3"><ShieldCheck size={32} /></div>
                                <div className="flex flex-col">
                                    <span>{!isEdit ? "Nuevo " : "Modificar "} <span className="text-emerald-500">Acceso</span></span>
                                    <span className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest mt-2 not-italic">Control de Permisos Maestro</span>
                                </div>
                            </h2>
                        </ModalHeader>

                        <ModalBody className="p-10 gap-10">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                                <div className="space-y-3">
                                    <Input
                                        autoFocus
                                        label="Documento (DNI)"
                                        labelPlacement="outside"
                                        placeholder="00000000"
                                        value={user?.dni}
                                        onValueChange={(v) => setUser(p => ({ ...p, dni: v }))}
                                        isDisabled={isEdit}
                                        startContent={<UserCircle size={16} className="text-gray-400 dark:text-zinc-500 mr-2" />}
                                        classNames={{ 
                                            label: "text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic mb-2 ml-1",
                                            inputWrapper: "h-16 bg-gray-50 dark:bg-zinc-900/50 border border-gray-200 dark:border-white/10 rounded-2xl focus-within:!border-emerald-500 transition-all shadow-inner", 
                                            input: "font-black text-base uppercase italic text-gray-900 dark:text-white bg-transparent" 
                                        }}
                                    />
                                </div>
                                <div className="space-y-3">
                                    <Select
                                        label="Nivel de Rol"
                                        labelPlacement="outside"
                                        selectedKeys={[String(user?.role || 'empleado')]}
                                        onSelectionChange={(keys) => {
                                            const v = Array.from(keys)[0] as string;
                                            setUser(p => ({ ...p, role: v }));
                                        }}
                                        classNames={{ 
                                            label: "text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic mb-2 ml-1",
                                            trigger: "h-16 bg-gray-50 dark:bg-zinc-900/50 border border-gray-200 dark:border-white/10 rounded-2xl focus-within:!border-emerald-500 transition-all shadow-inner", 
                                            value: "font-black text-base uppercase italic text-gray-900 dark:text-white" 
                                        }}
                                        aria-label="Nivel de Rol"
                                    >
                                        <SelectItem key="empleado" textValue="EMPLEADO (VENTAS)">EMPLEADO (VENTAS)</SelectItem>
                                        <SelectItem key="administrador" textValue="ADMINISTRADOR (TOTAL)">ADMINISTRADOR (TOTAL)</SelectItem>
                                    </Select>
                                </div>
                            </div>

                            <div className="space-y-3">
                                <Input
                                    label="Nombre Completo"
                                    labelPlacement="outside"
                                    placeholder="NOMBRE DEL COLABORADOR"
                                    value={user?.name}
                                    onValueChange={(v) => setUser(p => ({ ...p, name: v.toUpperCase() }))}
                                    classNames={{ 
                                        label: "text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic mb-2 ml-1",
                                        inputWrapper: "h-16 bg-gray-50 dark:bg-zinc-900/50 border border-gray-200 dark:border-white/10 rounded-2xl focus-within:!border-emerald-500 transition-all shadow-inner", 
                                        input: "font-black text-sm uppercase italic text-gray-900 dark:text-white bg-transparent" 
                                    }}
                                />
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                                <div className="space-y-3">
                                    <Input
                                        label="Email (Opcional)"
                                        labelPlacement="outside"
                                        placeholder="correo@ejemplo.com"
                                        value={user?.email}
                                        onValueChange={(v) => setUser(p => ({ ...p, email: v }))}
                                        startContent={<Mail size={16} className="text-gray-400 dark:text-zinc-500 mr-2" />}
                                        classNames={{ 
                                            label: "text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic mb-2 ml-1",
                                            inputWrapper: "h-16 bg-gray-50 dark:bg-zinc-900/50 border border-gray-200 dark:border-white/10 rounded-2xl focus-within:!border-emerald-500 transition-all shadow-inner", 
                                            input: "font-black text-sm italic text-gray-900 dark:text-white bg-transparent" 
                                        }}
                                    />
                                </div>

                                {!isEdit && (
                                    <div className="space-y-3">
                                        <Input
                                            type="password"
                                            label="Contraseña"
                                            labelPlacement="outside"
                                            placeholder="••••••••"
                                            value={user?.password}
                                            onValueChange={(v) => setUser(p => ({ ...p, password: v }))}
                                            startContent={<KeyRound size={16} className="text-gray-400 dark:text-zinc-500 mr-2" />}
                                            classNames={{ 
                                                label: "text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic mb-2 ml-1",
                                                inputWrapper: "h-16 bg-gray-50 dark:bg-zinc-900/50 border border-gray-200 dark:border-white/10 rounded-2xl focus-within:!border-emerald-500 transition-all shadow-inner", 
                                                input: "font-black text-base text-gray-900 dark:text-white tracking-[0.3em] bg-transparent" 
                                            }}
                                        />
                                    </div>
                                )}
                            </div>
                            
                            {isEdit && (
                                <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 p-6 rounded-2xl flex items-start gap-4 shadow-inner">
                                    <AlertTriangle size={20} className="text-amber-500 shrink-0 mt-1" />
                                    <p className="text-[10px] font-black text-amber-600 dark:text-amber-500/80 uppercase tracking-widest leading-relaxed">
                                        La contraseña es fija y no puede ser modificada desde este panel por directrices de seguridad de la infraestructura.
                                    </p>
                                </div>
                            )}
                        </ModalBody>

                        <ModalFooter className="p-10 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50 rounded-b-[2.5rem]">
                            <Button
                                className="w-full h-20 bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase text-sm tracking-[0.2em] rounded-3xl transition-all shadow-xl hover:scale-[1.02] active:scale-95 italic ring-4 ring-black/5 dark:ring-white/5"
                                onPress={onSave}
                            >
                                <Sparkles size={24} className="mr-3" />
                                {!isEdit ? "AUTORIZAR ACCESO MAESTRO" : "SINCRONIZAR CAMBIOS"}
                            </Button>
                        </ModalFooter>
                    </>
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
            backdrop="blur" 
            size="md"
            classNames={{ 
                base: "bg-white dark:bg-zinc-950 rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-2xl", 
                closeButton: "text-gray-400 hover:text-rose-500 transition-colors z-50 rounded-full" 
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
                                className="flex-1 h-16 rounded-2xl font-black text-[10px] tracking-widest bg-gray-100 dark:bg-zinc-900 text-gray-400 dark:text-zinc-500 uppercase hover:bg-gray-200 dark:hover:bg-zinc-800 italic transition-all" 
                                onPress={onClose}
                            >
                                CANCELAR
                            </Button>
                            <Button 
                                color="danger" 
                                className="flex-1 h-16 rounded-2xl font-black text-[10px] tracking-widest shadow-xl shadow-rose-500/20 uppercase bg-rose-500 text-white italic hover:scale-[1.02] active:scale-95 transition-all" 
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
