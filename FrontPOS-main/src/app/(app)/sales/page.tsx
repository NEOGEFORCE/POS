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

    if (isLoading && page === 1) return <div className="h-full w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner color="primary" size="lg" /></div>;

    return (
        <div className="flex flex-col w-full max-w-[1600px] mx-auto h-full min-h-0 bg-transparent transition-all duration-500 overflow-hidden relative">
            
            {/* HEADER SECTION: FIXED (TOP) */}
            <div className="shrink-0 px-3 pt-1.5 pb-2 flex flex-col gap-3 border-b border-gray-200 dark:border-white/5 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-md">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="bg-emerald-600 h-10 w-10 rounded-xl text-white shadow-lg shadow-emerald-500/20 flex items-center justify-center transform -rotate-3">
                            <HistoryIcon size={20} />
                        </div>
                        <div className="flex flex-col">
                            <h1 className="text-[13px] font-black text-zinc-900 dark:text-white tracking-tighter uppercase italic leading-none">
                                Auditoría de <span className="text-emerald-500">Ventas</span>
                            </h1>
                            <p className="text-[8px] font-black text-zinc-500 uppercase tracking-[0.4em] italic mt-1 flex items-center gap-1">
                                <Clock size={10} className="text-emerald-500" /> Historial Maestro
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <Button 
                            isIconOnly
                            onPress={() => mutate()}
                            className="h-10 w-10 min-w-0 bg-gray-100 dark:bg-zinc-900/50 text-gray-400 dark:text-zinc-500 rounded-xl border border-gray-200 dark:border-white/5 shadow-sm active:scale-90"
                        >
                            <HistoryIcon size={16} />
                        </Button>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <div className="relative flex-1 group/search">
                        <Input 
                            placeholder="BUSCAR VENTA / CLIENTE..." 
                            value={searchQuery} 
                            onValueChange={(v) => setSearchQuery(v.toUpperCase())} 
                            startContent={<Search size={18} className="text-gray-400 dark:text-zinc-500 group-focus-within/search:text-emerald-500" />} 
                            classNames={{ 
                                inputWrapper: "h-12 bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-white/10 shadow-sm rounded-xl group-focus-within/search:border-emerald-500/50 group-focus-within/search:ring-2 group-focus-within/search:ring-emerald-500/20 transition-all", 
                                input: "text-xs font-bold tracking-widest italic uppercase text-zinc-900 dark:text-white" 
                            }} 
                        />
                    </div>
                </div>
            </div>

            {/* CONTENT SECTION (SCROLLABLE) */}
            <div className="flex-1 min-h-0 flex flex-col gap-3 p-3 bg-transparent overflow-hidden">
                <SalesKPIs totalItems={totalItems} />
                <div className="flex-1 bg-white/40 dark:bg-zinc-900/40 border border-gray-200 dark:border-white/5 rounded-2xl overflow-y-auto custom-scrollbar flex flex-col min-h-0 shadow-sm">
                    <SalesTable 
                        sales={sales}
                        onOpenPreview={(s) => { setSelectedSale(s); setIsPreviewOpen(true); }}
                        onOpenEdit={(s) => { setSelectedSale(s); setIsEditOpen(true); }}
                    />

                    {/* Footer Paginación - RESTAURACIÓN CRÍTICA */}
                    <div className="px-8 py-4 flex items-center justify-between border-t border-gray-200 dark:border-white/10 bg-gray-50/50 dark:bg-zinc-900/50 mt-4 pt-4 shrink-0">
                        <div className="flex flex-col">
                            <p className="text-xs text-gray-500 dark:text-zinc-500 tracking-wider leading-none mb-1">
                                MOSTRANDO: <span className="text-gray-900 dark:text-white font-bold">{((page - 1) * pageSize + 1)}-{Math.min(page * pageSize, totalItems)}</span> DE {totalItems}
                            </p>
                            <span className="text-[8px] font-bold text-emerald-500/60 uppercase tracking-widest italic">Sincronización Auditoría Activa</span>
                        </div>
                        
                        <Pagination
                            isCompact
                            showControls
                            total={totalPages}
                            page={page}
                            onChange={setPage}
                            classNames={{
                                wrapper: "gap-2",
                                item: "flex items-center justify-center w-8 h-8 rounded-lg border transition-colors text-sm bg-white border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-zinc-900/50 dark:border-white/10 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white",
                                cursor: "bg-gray-100 text-gray-900 font-bold dark:bg-zinc-800 dark:text-white border-gray-300 dark:border-white/20",
                                prev: "flex items-center justify-center w-8 h-8 rounded-lg border bg-white border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-zinc-900/50 dark:border-white/10 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white",
                                next: "flex items-center justify-center w-8 h-8 rounded-lg border bg-white border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-zinc-900/50 dark:border-white/10 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
                            }} 
                        />
                    </div>
                </div>
            </div>

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