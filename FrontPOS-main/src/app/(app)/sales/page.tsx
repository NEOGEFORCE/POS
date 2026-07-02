"use client";

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
    Button, Input, Pagination, Spinner
} from "@heroui/react";
import {
    Search, History as HistoryIcon, Clock, Filter, RefreshCw
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { useToast } from '@/hooks/use-toast';
import { Sale } from '@/lib/definitions';
import { useApiWithPagination, useApi } from '@/hooks/use-api';
import Cookies from 'js-cookie';
import { broadcastRevalidate, setupSyncListener } from '@/lib/revalidate';

// COMPONENTES MODULARIADOS
import { saveCartsToIndexedDB, loadCartsFromIndexedDB } from '@/lib/cartStorage';
const SalesKPIs = dynamic(() => import('./components/SalesKPIs'), { ssr: false });
const SaleDetailModal = dynamic(() => import('./components/SaleDetailModal'), { ssr: false });
const SaleEditModal = dynamic(() => import('./components/SaleEditModal'), { ssr: false });
const ClientSelectorModal = dynamic(() => import('./components/ClientSelectorModal'), { ssr: false });
const SalesTable = dynamic(() => import('./components/SalesTable'), { ssr: false });
const SaleDeleteModal = dynamic(() => import('./components/SaleDeleteModal'), { ssr: false });


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
    const [isDeleteOpen, setIsDeleteOpen] = useState(false);
    const [isClientDialogOpen, setIsClientDialogOpen] = useState(false);

    const { data: customersData } = useApi<Customer[]>('/clients/all-clients');
    const customers = customersData || [];
    const router = useRouter();

    const handleAddItems = async (s: Sale) => {
        const cartKey = `Factura EDIT-${s.id}`;
        const cartItems = (s.details || []).map(d => ({
            cartItemId: `edit_${d.id}`,
            barcode: d.barcode,
            productName: d.product?.productName || "PRODUCTO",
            salePrice: d.unitPrice,
            cartQuantity: d.quantity,
            originalQuantity: d.quantity,
            isPreexisting: true,
            categoryId: d.product?.categoryId || 0,
            quantity: d.product?.quantity || 0,
            purchasePrice: d.product?.purchasePrice || 0,
            marginPercentage: d.product?.marginPercentage || 0,
            isWeighted: d.product?.isWeighted || false
        }));
        
        try {
            const currentData = await loadCartsFromIndexedDB();
            const carts = currentData ? currentData.carts : { 'Factura 1': [] };
            const cartCustomers = currentData ? currentData.cartCustomers : { 'Factura 1': '0' };
            
            const clientDni = s.client?.dni && s.client?.dni !== "0" ? s.client?.dni : (s as any).clientDni || '0';
            const customerDni = clientDni !== "0" ? clientDni : (currentData?.customerDni || '0');

            carts[cartKey] = cartItems;
            if (clientDni && clientDni !== "0") {
                cartCustomers[cartKey] = clientDni;
            }

            await saveCartsToIndexedDB(
                carts,
                cartKey,
                customerDni,
                cartCustomers,
                null
            );
            window.location.href = '/sales/new';
        } catch (error) {
            console.error("Error setting cart data:", error);
            localStorage.setItem(`pos_cart_${cartKey}`, JSON.stringify(cartItems));
            localStorage.setItem('pos_active_cart', cartKey);
            window.location.href = '/sales/new';
        }
    };

    const handlePrint = useCallback(() => {
        if (!selectedSale) return;
        window.print();
    }, [selectedSale]);

    // Debounce busqueda
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

    // SINCRONIZACION ZERO-F5
    useEffect(() => {
        const cleanup = setupSyncListener((event) => {
            if (event === 'SALE_MADE' || event === 'DASHBOARD_UPDATE') {
                mutate();
            }
        });
        return cleanup;
    }, [mutate]);

    const sales = data?.items || [];
    const totalItems = data?.total || 0;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

    if (isLoading && page === 1) return <div className="flex-1 h-full w-full flex items-center justify-center bg-gray-50 dark:bg-zinc-950"><Spinner color="primary" size="lg" /></div>;

    return (
        <div className="flex flex-col flex-1 min-h-0 h-full w-full max-w-[1600px] mx-auto overflow-hidden bg-transparent transition-all duration-500 relative">

            {/* HEADER SECTION: FIXED (TOP) */}
            <div className="shrink-0 px-3 pt-1.5 pb-2 flex flex-col gap-3 border-b border-gray-200 dark:border-white/5 card-base border-none dark:bg-zinc-950/80">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 h-10 w-10 rounded-2xl text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex items-center justify-center transform -rotate-3">
                            <HistoryIcon size={20} />
                        </div>
                        <div className="flex flex-col">
                            <h1 className="text-[13px] font-medium text-zinc-900 dark:text-white tracking-tighter uppercase tracking-tight leading-none">
                                Auditoria de <span className="text-zinc-900 dark:text-zinc-100">Ventas</span>
                            </h1>
                            <p className="text-[8px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-[0.4em] tracking-tight mt-1 flex items-center gap-1">
                                <Clock size={10} className="text-zinc-900 dark:text-zinc-100" /> Historial Maestro
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <Button
                            isIconOnly
                            onPress={() => mutate()}
                            isLoading={isLoading}
                            className="h-10 w-10 min-w-0 card-base border-none text-gray-500 dark:text-zinc-500 dark:text-zinc-400 rounded-2xl border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-90"
                        >
                            <RefreshCw size={16} />
                        </Button>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <div className="relative flex-1 group/search">
                        <Input
                            placeholder="BUSCAR VENTA / CLIENTE..."
                            value={searchQuery}
                            onValueChange={(v) => setSearchQuery(v.toUpperCase())}
                            startContent={<Search size={18} className="text-gray-500 dark:text-zinc-500 dark:text-zinc-400 group-focus-within/search:text-zinc-900 dark:text-zinc-100" />}
                            classNames={{
                                inputWrapper: "h-12 bg-gray-50 dark:bg-[#18181b] border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-2xl group-focus-within/search:border-emerald-500/50 group-focus-within/search:ring-2 group-focus-within/search:ring-emerald-500/20 transition-all",
                                input: "text-xs font-bold tracking-widest tracking-tight uppercase text-zinc-900 dark:text-white"
                            }}
                        />
                    </div>
                </div>
            </div>

            {/* CONTENT SECTION (SCROLLABLE) */}
            <div className="flex flex-col gap-3 p-3 bg-transparent">
                <SalesKPIs totalItems={totalItems} />
                <div className="bg-white/40 dark:bg-[#18181b]/40 border border-gray-200 dark:border-white/5 rounded-2xl flex flex-col shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                    <SalesTable
                        sales={sales}
                        onOpenPreview={(s) => { setSelectedSale(s); setIsPreviewOpen(true); }}
                        onOpenEdit={(s) => { setSelectedSale(s); setIsEditOpen(true); }}
                        onOpenAddItems={handleAddItems}
                        onOpenDelete={(s) => { setSelectedSale(s); setIsDeleteOpen(true); }}
                    />

                    {/* Footer Paginacion - RESTAURACION CRITICA */}
                    <div className="px-8 py-4 flex items-center justify-between border-t border-gray-200 dark:border-white/10 bg-gray-50/50 dark:bg-[#18181b]/50 mt-4 pt-4 shrink-0">
                        <div className="flex flex-col">
                            <p className="text-xs text-gray-500 dark:text-zinc-500 tracking-wider leading-none mb-1">
                                MOSTRANDO: <span className="text-zinc-900 dark:text-zinc-50 font-bold">{((page - 1) * pageSize + 1)}-{Math.min(page * pageSize, totalItems)}</span> DE {totalItems}
                            </p>
                            <span className="text-[8px] font-bold text-zinc-900 dark:text-zinc-100/60 uppercase tracking-widest tracking-tight">Sincronizacion Auditoria Activa</span>
                        </div>

                        <Pagination
                            isCompact
                            showControls
                            total={totalPages}
                            page={page}
                            onChange={setPage}
                            classNames={{
                                wrapper: "gap-2",
                                item: "flex items-center justify-center w-8 h-8 rounded-2xl border transition-colors text-sm bg-white border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-[#18181b]/50 dark:border-white/10 dark:text-zinc-400 dark:hover:bg-white/5 dark:bg-transparent dark:hover:text-white",
                                cursor: "bg-gray-100 text-gray-900 font-bold dark:bg-zinc-800 dark:text-white border-gray-300 dark:border-white/20",
                                prev: "flex items-center justify-center w-8 h-8 rounded-2xl border bg-white border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-[#18181b]/50 dark:border-white/10 dark:text-zinc-400 dark:hover:bg-white/5 dark:bg-transparent dark:hover:text-white",
                                next: "flex items-center justify-center w-8 h-8 rounded-2xl border bg-white border-gray-200 text-gray-700 hover:bg-gray-50 dark:bg-[#18181b]/50 dark:border-white/10 dark:text-zinc-400 dark:hover:bg-white/5 dark:bg-transparent dark:hover:text-white"
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
            <SaleDeleteModal
                isOpen={isDeleteOpen}
                onOpenChange={setIsDeleteOpen}
                sale={selectedSale}
                onSuccess={() => { 
                    mutate(); 
                    setIsDeleteOpen(false); 
                    broadcastRevalidate('SALE_MADE');
                    broadcastRevalidate('DASHBOARD_UPDATE');
                }}
            />
            <ClientSelectorModal
                isOpen={isClientDialogOpen}
                onOpenChange={setIsClientDialogOpen}
                customers={customers}
                onSelect={(c) => {
                    if (isEditOpen && selectedSale) {
                        setSelectedSale({ ...selectedSale, client: c });
                        setIsClientDialogOpen(false);
                    }
                }}
            />
        </div>
    );
}


