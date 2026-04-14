"use client";

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
    Button, Input, Pagination, Spinner
} from "@heroui/react";
import {
    Search, History as HistoryIcon, Clock, Filter
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { useToast } from '@/hooks/use-toast';
import { Sale } from '@/lib/definitions';
import { useApiWithPagination } from '@/hooks/use-api';
import Cookies from 'js-cookie';

// COMPONENTES MODULARIADOS
const SalesKPIs = dynamic(() => import('./components/SalesKPIs'), { ssr: false });
const SaleDetailModal = dynamic(() => import('./components/SaleDetailModal'), { ssr: false });
const SaleEditModal = dynamic(() => import('./components/SaleEditModal'), { ssr: false });
const ClientSelectorModal = dynamic(() => import('./components/ClientSelectorModal'), { ssr: false });
const SalesTable = dynamic(() => import('./components/SalesTable'), { ssr: false });

import { useApi } from '@/hooks/use-api';
import { Customer } from '@/lib/definitions';

export default function SalesHistoryPage() {
    const { toast } = useToast();
    const [page, setPage] = useState(1);
    const pageSize = 12;

    const [searchQuery, setSearchQuery] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
    const [isPreviewOpen, setIsPreviewOpen] = useState(false);
    const [isEditOpen, setIsEditOpen] = useState(false);
    const [isClientDialogOpen, setIsClientDialogOpen] = useState(false);

    const { data: customersData } = useApi<Customer[]>('/clients/all-clients');
    const customers = customersData || [];

    const handlePrint = useCallback(() => {
        if (!selectedSale) return;
        window.print();
    }, [selectedSale]);

    // Debounce búsqueda
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedSearch(searchQuery);
            setPage(1);
        }, 500);
        return () => clearTimeout(timer);
    }, [searchQuery]);

    const endpoint = debouncedSearch
        ? `/sales/history?search=${encodeURIComponent(debouncedSearch)}`
        : '/sales/history';

    const { data, isLoading, mutate } = useApiWithPagination<{ items: Sale[], total: number }>(
        endpoint,
        page,
        pageSize,
        { keepPreviousData: true }
    );

    const sales = data?.items || [];
    const totalItems = data?.total || 0;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

    if (isLoading && page === 1) return <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner color="primary" size="lg" /></div>;

    return (
        <div className="flex flex-col h-screen gap-3 p-3 bg-gray-100 dark:bg-zinc-950 overflow-hidden transition-all duration-700">
            
            {/* Header Premium Zero Friction */}
            <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-2xl shrink-0 shadow-sm relative overflow-hidden">
                <div className="absolute top-0 right-0 p-4 opacity-5 text-blue-500 scale-150 rotate-12"><HistoryIcon size={120} /></div>
                
                <div className="flex items-center gap-4 relative z-10">
                    <div className="bg-blue-600 p-3 rounded-2xl text-white shadow-lg shadow-blue-500/20 -rotate-3">
                        <HistoryIcon size={24} />
                    </div>
                    <div className="flex flex-col">
                        <h1 className="text-xl font-black dark:text-white uppercase leading-none italic tracking-tighter">
                            Auditoría de <span className="text-blue-600">Ventas</span>
                        </h1>
                        <div className="flex items-center gap-2 mt-1">
                            <span className="text-[9px] font-black text-blue-600 uppercase tracking-[0.3em]">Historial Maestro</span>
                            <div className="h-1 w-1 bg-gray-300 rounded-full" />
                            <div className="flex items-center gap-1 text-[9px] font-bold text-gray-400 uppercase tracking-widest italic">
                                <Clock size={10} /> {new Date().toLocaleDateString()}
                            </div>
                        </div>
                    </div>
                </div>

                <div className="flex items-center gap-3 relative z-10">
                    <div className="relative group/search">
                        <Input 
                            size="sm" 
                            placeholder="BUSCAR VENTA / CLIENTE..." 
                            value={searchQuery} 
                            onValueChange={(v) => setSearchQuery(v.toUpperCase())} 
                            startContent={<Search size={16} className="text-gray-400 group-focus-within/search:text-blue-600 transition-colors" />} 
                            classNames={{ 
                                inputWrapper: "h-11 w-full md:w-80 bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-inner rounded-xl group-focus-within/search:border-blue-600/50 transition-all", 
                                input: "text-[11px] font-black bg-transparent tracking-widest italic uppercase" 
                            }} 
                        />
                    </div>
                </div>
            </header>

            {/* KPIs */}
            <SalesKPIs totalItems={totalItems} />

            {/* Table */}
            <div className="flex-1 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-2xl overflow-hidden flex flex-col min-h-0 shadow-sm">
                <SalesTable 
                    sales={sales}
                    onOpenPreview={(s) => { setSelectedSale(s); setIsPreviewOpen(true); }}
                    onOpenEdit={(s) => { setSelectedSale(s); setIsEditOpen(true); }}
                />

                {/* Footer Paginación */}
                <div className="px-8 py-4 flex items-center justify-between border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900 shrink-0">
                    <div className="flex flex-col">
                        <p className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.2em] leading-none mb-1">
                            MOSTRANDO: <span className="text-gray-900 dark:text-white italic">{((page - 1) * pageSize + 1)}-{Math.min(page * pageSize, totalItems)}</span> DE {totalItems}
                        </p>
                        <span className="text-[8px] font-bold text-blue-500/60 uppercase tracking-widest italic">Sincronización Auditoría Activa</span>
                    </div>
                    
                    <Pagination
                        isCompact
                        showControls
                        total={totalPages}
                        page={page}
                        onChange={setPage}
                        classNames={{
                            wrapper: "gap-1",
                            item: "bg-white dark:bg-zinc-800 text-gray-400 dark:text-zinc-500 font-black text-[10px] uppercase rounded-xl border border-gray-200 dark:border-white/5 hover:border-blue-500/50 hover:bg-blue-500/5 min-w-[36px] h-9",
                            cursor: "bg-gray-900 dark:bg-white text-white dark:text-black font-black",
                            prev: "bg-white dark:bg-zinc-800 text-gray-400 dark:text-zinc-500 rounded-xl border border-gray-200 dark:border-white/5 min-w-[36px] h-9 hover:border-blue-500/50",
                            next: "bg-white dark:bg-zinc-800 text-gray-400 dark:text-zinc-500 rounded-xl border border-gray-200 dark:border-white/5 min-w-[36px] h-9 hover:border-blue-500/50"
                        }}
                    />
                </div>
            </div>

            {/* Modals */}
            <SaleDetailModal 
                isOpen={isPreviewOpen} 
                onOpenChange={setIsPreviewOpen} 
                sale={selectedSale} 
                onPrint={handlePrint}
            />
            <SaleEditModal 
                isOpen={isEditOpen} 
                onOpenChange={setIsEditOpen} 
                sale={selectedSale} 
                customers={customers}
                onClientSelectorOpen={() => setIsClientDialogOpen(true)}
                onSuccess={() => { mutate(); setIsEditOpen(false); }}
            />
            <ClientSelectorModal 
                isOpen={isClientDialogOpen} 
                onOpenChange={setIsClientDialogOpen} 
                customers={customers}
                onSelect={(c) => { 
                    // Si se selecciona un cliente desde el selector de la edición
                    if(isEditOpen && selectedSale) {
                        // El modal de edición suele manejar su propio estado interno
                    }
                }}
            />
        </div>
    );
}