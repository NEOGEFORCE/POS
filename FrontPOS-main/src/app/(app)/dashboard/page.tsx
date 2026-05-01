"use client" // Dashboard V5.0 - Premium SaaS Expansion

import { useState, useEffect } from "react";
import Cookies from "js-cookie";
import dynamic from "next/dynamic";
import RankingList from "./components/RankingList";
import LowStockPanel from "./components/LowStockPanel";
import RecentActivity from "./components/RecentActivity";
import QuickActionsPanel from "./components/QuickActionsPanel";
import AdvancedAnalyticsChart from "./components/AdvancedAnalyticsChart";
import IncomingOrdersWidget from "./components/IncomingOrdersWidget";
import PendingDebtsModal from "./components/PendingDebtsModal";
import { Expense, SavingsOpportunity } from "@/lib/definitions";
import { apiFetch } from "@/lib/api-error";
import { PackageSearch, Clock, CheckCircle2, User } from "lucide-react";
import { useToast } from "@/hooks/use-toast"
import { useApi } from "@/hooks/use-api"
import { formatCurrency } from "@/lib/utils"
import { Sparkles, RefreshCw, AlertTriangle } from "lucide-react"
import { Button, Skeleton, Chip } from "@heroui/react"

// Componentes estables que pueden seguir siendo dinámicos
const DashboardKPIs = dynamic(() => import("./components/DashboardKPIs"), {
    loading: () => <Skeleton className="h-[160px] w-full rounded-[2rem]" />
});
const DashboardCharts = dynamic(() => import("./components/DashboardCharts"), {
    loading: () => <Skeleton className="h-[420px] w-full rounded-2xl" />
});
const ReportButtons = dynamic(() => import("./components/ReportButtons"), {
    loading: () => <Skeleton className="h-[96px] w-full rounded-3xl" />
});
const DateRangeModal = dynamic(() => import("./components/DateRangeModal"));

type StockStatus = 'CRITICAL' | 'WARNING' | 'OPTIMAL';

interface LowStockItem {
    barcode: string;
    name: string;
    stock: number;
    minStock: number;
    threshold: number;
    status: StockStatus;
}

interface DailyPoint {
    date: string;
    amount: number;
}

interface ProductRankingItem {
    barcode: string;
    name: string;
    quantity: number;
    total: number;
}

interface MissingItem {
    id: number;
    product_name: string;
    status: string;
    note: string;
    reporter?: { name: string };
    created_at: string;
}

interface DashboardData {
    totalSalesAmount: number;
    totalExpensesAmount: number;
    profit: number;
    totalProductsSold: number;
    totalClients: number;
    monthly: {
        salesByMonth: Record<string, number>;
        expensesByMonth: Record<string, number>;
        profitByMonth: Record<string, number>;
    };
    recentSales: {
        id: string;
        total: number;
        date: string;
        client: string;
        status?: 'Completado' | 'Pendiente' | 'Cancelado';
        payment_method?: string;
    }[];
    todaySalesAmount: number;
    todaySalesCount: number;
    todayExpenses: {
        amount: number;
        count: number;
    };
    activeProducts: number;
    totalProducts: number;
    categoriesCount: number;
    criticalStockCount: number;
    warningStockCount: number;
    lowStockProducts: LowStockItem[];
    salesByPayment: Record<string, number>;
    dailySalesLast7: DailyPoint[];
    topProducts: ProductRankingItem[];
    missingItems: MissingItem[];
    savingsOpportunities: SavingsOpportunity[];
    realCashFlow: {
        total: number;
        cash: number;
        nequi: number;
        daviplata: number;
    };
    pendingDebts: {
        amount: number;
        count: number;
        items: Expense[];
    };
    systemBalance: number;
    reportedBalance: number;
    globalDifference: number;
}

export default function DashboardPage() {
    const { data, isLoading, error, mutate } = useApi<DashboardData>('/dashboard/overview', {
        refreshInterval: 300000,
        revalidateOnFocus: false
    });
    const { toast } = useToast();

    const [isRangeModalOpen, setIsRangeModalOpen] = useState(false);
    const [dateFrom, setDateFrom] = useState(`${new Date().toISOString().split('T')[0]}T00:00`);
    const [dateTo, setDateTo] = useState(`${new Date().toISOString().split('T')[0]}T23:59`);

    const [isDebtsModalOpen, setIsDebtsModalOpen] = useState(false);

    const handleSettleDebt = async (id: string, paymentSource: string) => {
        const token = Cookies.get('org-pos-token');
        if (!token) return;

        try {
            await apiFetch(`/expenses/settle/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ paymentSource }),
                fallbackError: 'FALLO AL SALDAR DEUDA'
            }, token);

            toast({
                variant: "success",
                title: "DEUDA SALDADA",
                description: `EL EGRESO SE HA MARCADO COMO PAGADO CON ${paymentSource}`,
            });
            mutate(); // Actualizar datos del dashboard
        } catch (err: any) {
            toast({
                variant: "destructive",
                title: "FALLO AL SALDAR",
                description: err.message || 'FALLO AL SALDAR DEUDA',
            });
        }
    };

    useEffect(() => {
        const token = Cookies.get('org-pos-token');
        if (!token) return;

        const sseUrl = `${process.env.NEXT_PUBLIC_API_URL}/sse?token=${token}`;
        const eventSource = new EventSource(sseUrl);

        eventSource.addEventListener('NEW_SALE', (event) => {
            mutate();
            toast({
                title: "VENTA EN TIEMPO REAL",
                description: "DASHBOARD ACTUALIZADO",
                variant: "success"
            });
        });

        eventSource.onerror = (err) => {
            eventSource.close();
        };

        return () => {
            eventSource.close();
        };
    }, [mutate, toast]);

    const stockHealth = data ? (data.totalProducts > 0 ? (data.activeProducts / data.totalProducts) * 100 : 0) : 0;
    const stockHealthColor = stockHealth >= 80 ? '#10b981' : stockHealth >= 50 ? '#f59e0b' : '#ef4444';

    return (
        // FIX DE SCROLL: h-[100dvh] fuerza el alto total de la ventana y overflow-y-auto habilita el scroll sin zonas muertas.
        <main className="h-[100dvh] overflow-y-auto relative block w-full bg-gray-50/50 dark:bg-zinc-950/20">

            <div className="flex flex-col w-full max-w-[1600px] mx-auto text-gray-900 dark:text-white transition-all duration-500 pb-32 md:pb-24 pt-4">

                {/* CONTENIDO PRINCIPAL */}
                <div className="p-4 md:p-6 flex flex-col gap-6 w-full">
                    
                    {/* TÍTULO Y ACCIONES DE CABECERA (NO STICKY) */}
                    {!isLoading && data && (
                        <div className="flex flex-row items-center justify-between mb-2">
                            <div className="flex items-center gap-3">
                                <div className="bg-emerald-500 h-10 w-10 rounded-xl text-white shadow-lg shadow-emerald-500/20 flex items-center justify-center transform -rotate-3 shrink-0">
                                    <Sparkles size={20} strokeWidth={3} />
                                </div>
                                <div className="flex flex-col">
                                    <h1 className="text-[13px] md:text-base font-black text-gray-900 dark:text-white tracking-tighter uppercase italic leading-none">
                                        Centro de <span className="text-emerald-500">Control</span>
                                    </h1>
                                    <p className="text-[8px] md:text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.4em] italic mt-1 flex items-center gap-1">
                                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> Inteligencia V5.3
                                    </p>
                                </div>
                            </div>

                            <Button
                                variant="flat"
                                onPress={() => mutate()}
                                className="h-10 px-4 bg-white/80 dark:bg-white/5 text-gray-900 dark:text-white font-black uppercase text-[10px] rounded-xl border border-gray-200 dark:border-white/10 italic tracking-widest shadow-sm transition-all active:scale-95"
                            >
                                <RefreshCw size={16} strokeWidth={2.5} className={`mr-1.5 ${isLoading ? 'animate-spin' : ''}`} />
                                <span className="hidden sm:inline">Sincronizar</span>
                            </Button>
                        </div>
                    )}
                    {isLoading ? (
                        <div className="flex flex-col gap-6 w-full animate-pulse">
                            <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
                                {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-[160px] w-full rounded-[2rem]" />)}
                            </div>
                            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                                <div className="lg:col-span-8 flex flex-col gap-6">
                                    <Skeleton className="h-[240px] w-full rounded-[2.5rem]" />
                                    <Skeleton className="h-[600px] w-full rounded-2xl" />
                                </div>
                                <div className="lg:col-span-4 flex flex-col gap-6">
                                    <Skeleton className="h-[320px] w-full rounded-2xl" />
                                    <Skeleton className="h-[450px] w-full rounded-[2rem]" />
                                </div>
                            </div>
                        </div>
                    ) : error || !data ? (
                        <div className="flex flex-col items-center justify-center gap-4 py-20 opacity-50">
                            <AlertTriangle className="h-12 w-12 text-rose-500" />
                            <h3 className="text-xl font-black text-gray-900 dark:text-white uppercase italic tracking-tighter">Error de Conexión</h3>
                            <Button onPress={() => mutate()} color="primary" className="font-black rounded-xl">Reintentar</Button>
                        </div>
                    ) : (
                        <>
                            {/* KPIs (Las 4 Tarjetas de arriba) */}
                            <DashboardKPIs data={data} onOpenDebts={() => setIsDebtsModalOpen(true)} />

                            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                                {/* IZQUIERDA: Pedidos y Tablas grandes */}
                                <div className="lg:col-span-8 flex flex-col gap-6">
                                    <IncomingOrdersWidget />

                                    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
                                        <div className="xl:col-span-7">
                                            <LowStockPanel items={data.lowStockProducts} />
                                        </div>
                                        <div className="xl:col-span-5">
                                            <RecentActivity sales={data.recentSales} />
                                        </div>
                                    </div>
                                </div>

                                {/* DERECHA: Acciones, Ranking y Gráficas (Sticky) */}
                                <div className="lg:col-span-4 flex flex-col gap-6 sticky top-[80px]">
                                    <QuickActionsPanel />
                                    <RankingList products={data.topProducts} />
                                    <DashboardCharts
                                        dailySalesLast7={data.dailySalesLast7}
                                        salesByPayment={data.salesByPayment}
                                        stockHealth={stockHealth}
                                        stockHealthColor={stockHealthColor}
                                    />
                                </div>
                            </div>

                            {/* ABAJO: Gráfica Financiera y Reportes */}
                            <AdvancedAnalyticsChart data={data.monthly} />
                            <ReportButtons onOpenRange={() => setIsRangeModalOpen(true)} />

                            {/* MODALES OCULTOS */}
                            <DateRangeModal
                                isOpen={isRangeModalOpen}
                                onOpenChange={setIsRangeModalOpen}
                                startDate={dateFrom}
                                endDate={dateTo}
                                onSetStartDate={setDateFrom}
                                onSetEndDate={setDateTo}
                                onDownloadRange={() => setIsRangeModalOpen(false)}
                            />

                            {/* MODAL DE DEUDAS */}
                            <PendingDebtsModal
                                isOpen={isDebtsModalOpen}
                                onOpenChange={setIsDebtsModalOpen}
                                debts={data.pendingDebts?.items || []}
                                onSettle={handleSettleDebt}
                            />
                        </>
                    )}
                </div>

            </div>
        </main>
    )
}