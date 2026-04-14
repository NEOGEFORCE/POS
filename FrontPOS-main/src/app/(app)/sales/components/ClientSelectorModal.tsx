"use client";

import {
    Modal, ModalContent, ModalHeader, ModalBody,
    Input, Button, Spinner
} from "@heroui/react";
import { Search, User, ChevronRight } from 'lucide-react';
import { useState, useMemo } from 'react';
import React from 'react';

interface ClientSelectorModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    customers: any[];
    onSelect: (customer: any) => void;
}

export default function ClientSelectorModal({
    isOpen,
    onOpenChange,
    customers,
    onSelect
}: ClientSelectorModalProps) {
    const [clientSearch, setClientSearch] = useState('');

    const filteredCustomers = useMemo(() => {
        const query = clientSearch.toLowerCase();
        return customers.filter(c => 
            c.name.toLowerCase().includes(query) || 
            c.dni.includes(query)
        ).slice(0, 10); // Limitar para rendimiento
    }, [clientSearch, customers]);

    return (
        <Modal 
            isOpen={isOpen} 
            onOpenChange={onOpenChange} 
            backdrop="blur" 
            classNames={{ 
                base: "bg-white dark:bg-zinc-950 rounded-[2rem] border border-gray-200 dark:border-white/5 shadow-2xl overflow-hidden",
                closeButton: "hover:bg-emerald-500/10 hover:text-emerald-500 transition-colors z-50" 
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="flex flex-col gap-1 p-8 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50">
                            <div className="flex items-center gap-4">
                                <div className="h-14 w-14 bg-emerald-500 text-white flex items-center justify-center rounded-2xl shadow-lg shadow-emerald-500/20 -rotate-3">
                                    <User size={28} />
                                </div>
                                <div className="flex flex-col">
                                    <h3 className="text-2xl font-black text-gray-900 dark:text-white uppercase italic tracking-tighter leading-none">Selector <span className="text-emerald-500">Maestro</span></h3>
                                    <p className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.3em] mt-2 italic">Asignar Cliente a Venta</p>
                                </div>
                            </div>
                        </ModalHeader>

                        <ModalBody className="p-8 pb-10">
                            <Input 
                                autoFocus 
                                placeholder="BUSCAR POR NOMBRE O DNI..." 
                                value={clientSearch} 
                                onValueChange={setClientSearch} 
                                size="lg" 
                                startContent={<Search className="text-emerald-500 mr-2" size={18} />}
                                classNames={{
                                    inputWrapper: "h-14 bg-gray-50 dark:bg-white/5 border-2 border-transparent focus-within:border-emerald-500/50 rounded-2xl shadow-inner transition-all",
                                    input: "font-black uppercase text-xs italic tracking-widest placeholder:text-gray-400 dark:placeholder:text-zinc-600"
                                }}
                            />
                            
                            <div className="mt-8 flex flex-col gap-2.5 max-h-[350px] overflow-y-auto custom-scrollbar p-1">
                                {filteredCustomers.length > 0 ? (
                                    filteredCustomers.map((c) => (
                                        <button
                                            key={c.id}
                                            onClick={() => {
                                                onSelect(c);
                                                onClose();
                                            }}
                                            className="w-full p-4 rounded-3xl bg-gray-50 dark:bg-zinc-900/40 hover:bg-emerald-500 hover:text-white dark:hover:bg-emerald-610 border border-gray-100 dark:border-white/5 transition-all text-left flex items-center justify-between group shadow-sm hover:shadow-emerald-500/20"
                                        >
                                            <div className="flex items-center gap-4">
                                                <div className="h-12 w-12 rounded-2xl bg-white dark:bg-zinc-800 flex items-center justify-center group-hover:bg-white/20 shadow-sm border border-gray-100 dark:border-white/5 transition-colors">
                                                    <User size={20} className="text-emerald-500 group-hover:text-white" />
                                                </div>
                                                <div>
                                                    <p className="font-black uppercase text-[12px] italic tracking-tight leading-tight group-hover:text-white transition-colors">{c.name}</p>
                                                    <div className="flex items-center gap-2 mt-1">
                                                        <span className="text-[8px] font-black bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 group-hover:bg-white/20 group-hover:text-white px-1.5 py-0.5 rounded-md transition-colors tracking-widest">DNI: {c.dni}</span>
                                                    </div>
                                                </div>
                                            </div>
                                            <ChevronRight size={18} className="opacity-20 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
                                        </button>
                                    ))
                                ) : (
                                    <div className="py-16 flex flex-col items-center justify-center text-center opacity-30">
                                        <div className="h-20 w-20 rounded-full border-2 border-dashed border-gray-300 flex items-center justify-center mb-6">
                                            <User size={40} strokeWidth={1} />
                                        </div>
                                        <p className="font-black text-[10px] uppercase tracking-[0.4em] italic text-gray-400">Sin Coincidencias</p>
                                    </div>
                                )}
                            </div>
                        </ModalBody>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
}
