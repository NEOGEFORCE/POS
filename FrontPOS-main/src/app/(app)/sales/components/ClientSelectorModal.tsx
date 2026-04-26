"use client";

import {
    Modal, ModalContent, ModalHeader, ModalBody,
    Input, Button, Spinner
} from "@heroui/react";
import { Search, User, X, ChevronRight } from 'lucide-react';
import { useState, useMemo } from 'react';
import React from 'react';

interface ClientSelectorModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    customers: any[];
    onSelect: (customer: any) => void;
    selectedClientDni?: string | number;
}

export default function ClientSelectorModal({
    isOpen,
    onOpenChange,
    customers,
    onSelect,
    selectedClientDni
}: ClientSelectorModalProps) {
    const [clientSearch, setClientSearch] = useState('');

    const filteredCustomers = useMemo(() => {
        const query = clientSearch.toLowerCase();
        return customers.filter(c => 
            c.dni !== '0' && (
                (c.name || '').toLowerCase().includes(query) || 
                (c.dni || '').includes(query)
            )
        ).slice(0, 20);
    }, [clientSearch, customers]);

    return (
        <Modal 
            isOpen={isOpen} 
            onOpenChange={onOpenChange} 
            backdrop="blur" 
            hideCloseButton
            classNames={{ 
                base: "bg-white dark:bg-zinc-900 rounded-2xl border border-gray-200 dark:border-white/10 shadow-2xl overflow-hidden max-w-md mx-4 relative z-[1001] pointer-events-auto",
                wrapper: "z-[1001] pointer-events-auto",
                backdrop: "z-[1000]"
            }}
            shouldBlockScroll={false}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader key="modal-header-clients" className="flex items-center justify-between p-5 border-b border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/50">
                            <h2 className="text-sm font-bold tracking-[0.15em] text-gray-900 dark:text-white uppercase italic">
                                Seleccionar Cliente
                            </h2>
                            <Button 
                                isIconOnly 
                                variant="light" 
                                size="sm" 
                                onPress={onClose}
                                className="text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors rounded-full"
                            >
                                <X size={20} />
                            </Button>
                        </ModalHeader>

                        <ModalBody key="modal-body-clients" className="p-0">
                            {/* FASE 2: BUSCADOR ZERO FRICTION */}
                            <div className="p-4 bg-white dark:bg-zinc-900">
                                <div className="relative group">
                                    <Search 
                                        className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 group-focus-within:text-emerald-500 transition-colors z-10" 
                                    />
                                    <input 
                                        autoFocus 
                                        placeholder="Buscar por nombre o DNI..." 
                                        value={clientSearch} 
                                        onChange={(e) => setClientSearch(e.target.value)}
                                        className="w-full bg-gray-50 dark:bg-zinc-950/50 border border-gray-200 dark:border-white/5 text-gray-900 dark:text-white rounded-xl px-4 py-3 pl-11 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 transition-all font-bold text-sm placeholder:text-gray-400 placeholder:font-medium uppercase"
                                    />
                                </div>
                            </div>
                            
                            {/* FASE 3: LISTA DE CLIENTES Y FORMATEO */}
                            <div className="px-2 pb-4 max-h-[400px] overflow-y-auto custom-scrollbar">
                                <div 
                                    key="client-selector-default"
                                    onClick={() => { onSelect({ dni: '0', name: 'CONSUMIDOR FINAL', id: '0' }); onClose(); }}
                                    className={`flex items-center gap-4 p-4 mx-2 my-1 rounded-2xl cursor-pointer transition-all duration-200 group border ${
                                        String(selectedClientDni) === '0' || !selectedClientDni
                                            ? 'bg-emerald-50 border-emerald-200 dark:bg-emerald-500/10 dark:border-emerald-500/20 shadow-sm' 
                                            : 'bg-transparent border-transparent hover:bg-gray-50 dark:hover:bg-white/5'
                                    }`}
                                >
                                    <div className={`h-10 w-10 rounded-xl flex items-center justify-center transition-all duration-300 ${
                                        String(selectedClientDni) === '0' || !selectedClientDni ? 'bg-emerald-500 text-white' : 'bg-sky-100 dark:bg-sky-500/10 text-sky-500'
                                    }`}>
                                        <User size={20} />
                                    </div>
                                    <div className="flex flex-col">
                                        <p className={`text-[11px] font-black uppercase tracking-wider ${
                                            String(selectedClientDni) === '0' || !selectedClientDni ? 'text-emerald-700 dark:text-emerald-400' : 'text-gray-900 dark:text-white'
                                        }`}>
                                            Consumidor Final
                                        </p>
                                        <span className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Venta General</span>
                                    </div>
                                </div>

                                {filteredCustomers.length > 0 ? (
                                    filteredCustomers.map((c) => {
                                        const isActive = String(c.dni) === String(selectedClientDni);
                                        return (
                                            <div
                                                key={c.id || c.dni}
                                                onClick={() => {
                                                    onSelect(c);
                                                    onClose();
                                                }}
                                                className={`flex items-center gap-4 p-4 mx-2 my-1 rounded-2xl cursor-pointer transition-all duration-200 group border ${
                                                    isActive 
                                                        ? 'bg-emerald-50 border-emerald-200 dark:bg-emerald-500/10 dark:border-emerald-500/20 shadow-sm' 
                                                        : 'bg-transparent border-transparent hover:bg-gray-50 dark:hover:bg-white/5'
                                                }`}
                                            >
                                                <div className={`h-10 w-10 rounded-xl flex items-center justify-center transition-all duration-300 ${
                                                    isActive 
                                                        ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20' 
                                                        : 'bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-500 group-hover:bg-white dark:group-hover:bg-zinc-700 shadow-inner'
                                                }`}>
                                                    <User size={20} />
                                                </div>
                                                <div className="flex flex-col flex-1 overflow-hidden">
                                                    <p className={`text-[11px] font-black uppercase tracking-wider truncate transition-colors ${
                                                        isActive ? 'text-emerald-700 dark:text-emerald-400' : 'text-gray-900 dark:text-white'
                                                    }`}>
                                                        {c.name}
                                                    </p>
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-[9px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest">DNI: {c.dni}</span>
                                                        {c.currentCredit > 0 && (
                                                            <span className="h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" />
                                                        )}
                                                    </div>
                                                </div>
                                                <ChevronRight size={16} className={`transition-all ${isActive ? 'text-emerald-500 translate-x-0' : 'text-gray-300 opacity-0 group-hover:opacity-100 group-hover:translate-x-1'}`} />
                                            </div>
                                        );
                                    })
                                ) : (
                                    <div key="no-results-clients" className="py-12 text-center">
                                        <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-gray-50 dark:bg-zinc-950/50 mb-4 border border-dashed border-gray-200 dark:border-white/10">
                                            <Search className="h-6 w-6 text-gray-300" />
                                        </div>
                                        <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest italic">
                                            Sin resultados para su búsqueda
                                        </p>
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
