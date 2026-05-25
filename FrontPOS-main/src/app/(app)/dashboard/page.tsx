"use client";

// Dashboard V5.0 - Premium SaaS Expansion

import { useState, useEffect } from "react";
import Cookies from "js-cookie";
import nextDynamic from "next/dynamic";
import RankingList from "./components/RankingList";
import LowStockPanel from "./components/LowStockPanel";
import RecentActivity from "./components/RecentActivity";
import QuickActionsPanel from "./components/QuickActionsPanel";
import CashFlowWidget from "./components/CashFlowWidget";
import AdvancedAnalyticsChart from "./components/AdvancedAnalyticsChart";
import IncomingOrdersWidget from "./components/IncomingOrdersWidget";
import PendingDebtsModal from "./components/PendingDebtsModal";
import { Expense, SavingsOpportunity } from "@/lib/definitions";
import { apiFetch } from "@/lib/api-error";
import { PackageSearch, Clock, CheckCircle2, User } from "lucide-react";
import { useToast } from "@/hooks/use-toast"
import { useApi } from "@/hooks/use-api"
import { formatCurrency } from "@/lib/utils"
import { Sparkles, RefreshCw, AlertTriangle, Bell } from "lucide-react"
import { broadcastRevalidate, setupSyncListener } from '@/lib/revalidate'
import { Button, Skeleton, Chip } from "@heroui/react"

// Componentes estables que pueden seguir siendo dinámicos
const DashboardKPIs = nextDynamic(() => import("./components/DashboardKPIs"), {
    loading: () => <Skeleton className="h-[160px] w-full rounded-[2rem]" />
});
const DashboardCharts = nextDynamic(() => import("./components/DashboardCharts"), {
    loading: () => <Skeleton className="h-[420px] w-full rounded-2xl" />
});
const ReportButtons = nextDynamic(() => import("./components/ReportButtons"), {
    loading: () => <Skeleton className="h-[96px] w-full rounded-2xl" />
});
const DateRangeModal = nextDynamic(() => import("./components/DateRangeModal"));

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
    shiftSalesAmount: number;
    shiftSalesCount: number;
    shiftSalesByMethod: Record<string, number>;
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
        bills?: number;
        coins1000?: number;
        coins200?: number;
        coins100?: number;
    };
    globalHistoricalReal: number;
    globalHistoricalExpected: number;
    globalHistoricalBills?: number;
    globalHistoricalCoins1000?: number;
    globalHistoricalCoins200?: number;
    globalHistoricalCoins100?: number;
    pendingDebts: {
        amount: number;
        count: number;
        items: Expense[];
    };
    systemBalance: number;
    reportedBalance: number;
    globalDifference: number;
    todayCashFlow?: {
        income: Record<string, number>;
        expense: Record<string, number>;
        balance: number;
    };
    priceChangesTodayCount: number;
}

export default function DashboardPage() {
    const [dateFrom, setDateFrom] = useState(`${new Date().toISOString().split('T')[0]}T00:00`);
    const [dateTo, setDateTo] = useState(`${new Date().toISOString().split('T')[0]}T23:59`);

    const { data, isLoading, error, mutate } = useApi<DashboardData>(`/dashboard/overview?startDate=${dateFrom}&endDate=${dateTo}`, {
        refreshInterval: 60000, // 1 minuto (Ahora que tenemos refresco eficiente en el backend)
        revalidateOnFocus: true
    });
    const { toast } = useToast();

    const [isRangeModalOpen, setIsRangeModalOpen] = useState(false);
    const [isDebtsModalOpen, setIsDebtsModalOpen] = useState(false);

    const handleSettleDebt = async (id: string, paymentSource: string, amount: number) => {
        const token = Cookies.get('org-pos-token');
        if (!token) return;

        try {
            await apiFetch(`/expenses/settle/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ paymentSource, amount }),
                fallbackError: 'FALLO AL SALDAR DEUDA'
            }, token);

            toast({
                variant: "success",
                title: "DEUDA SALDADA",
                description: `EL EGRESO SE HA MARCADO COMO PAGADO CON ${paymentSource}`,
            });
            mutate(); // Actualizar datos del dashboard
            const { broadcastRevalidate } = await import('@/lib/revalidate');
            broadcastRevalidate('SALE_MADE'); // Disparamos SALE_MADE para refrescar reportes y caja ya que el egreso afecta el flujo

        } catch (err: any) {
            toast({
                variant: "destructive",
                title: "FALLO AL SALDAR",
                description: err.message || 'FALLO AL SALDAR DEUDA',
            });
        }
    };

    useEffect(() => {
        // Sincronización Local (Entre pestañas y GlobalSyncProvider)
        const cleanupSync = setupSyncListener((event) => {
            const dashboardEvents = [
                'SALE_MADE', 
                'EXPENSE_UPDATE', 
                'PRODUCT_UPDATE', 
                'CATEGORY_UPDATE', 
                'SUPPLIER_UPDATE', 
                'CUSTOMER_UPDATE', 
                'CASH_REGISTER_UPDATE', 
                'DASHBOARD_UPDATE', 
                'CLOSURE_MADE'
            ];
            
            if (dashboardEvents.includes(event)) {
                mutate();
            }
        });

        return () => {
            cleanupSync();
        };
    }, [mutate, toast]);

    const stockHealth = data ? (data.totalProducts > 0 ? (data.activeProducts / data.totalProducts) * 100 : 0) : 0;
    const stockHealthColor = stockHealth >= 80 ? '#10b981' : stockHealth >= 50 ? '#f59e0b' : '#ef4444';

    return (
        // FIX DE SCROLL: h-[100dvh] fuerza el alto total de la ventana y overflow-y-auto habilita el scroll sin zonas muertas.
        <main className="h-[100dvh] overflow-y-auto relative block w-full bg-gray-50/50 dark:bg-zinc-950/20">

            <div className="flex flex-col w-full max-w-[1600px] mx-auto text-zinc-900 dark:text-zinc-50 transition-all duration-500 pb-32 md:pb-24 pt-4">

                {/* CONTENIDO PRINCIPAL */}
                <div className="p-4 md:p-6 flex flex-col gap-6 w-full">
                    
                    {/* TÍTULO Y ACCIONES DE CABECERA (NO STICKY) */}
                    {!isLoading && data && (
                        <div className="flex flex-row items-center justify-between mb-2">
                            <div className="flex items-center gap-3">
                                <div className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 h-10 w-10 rounded-2xl text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex items-center justify-center transform -rotate-3 shrink-0">
                                    <Sparkles size={20} strokeWidth={3} />
                                </div>
                                <div className="flex flex-col">
                                    <h1 className="text-[13px] md:text-base font-medium text-zinc-900 dark:text-zinc-50 tracking-tighter uppercase tracking-tight leading-none">
                                        Centro de <span className="text-zinc-900 dark:text-zinc-100">Control</span>
                                    </h1>
                                    <p className="text-[8px] md:text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.4em] tracking-tight mt-1 flex items-center gap-1">
                                        <span className="h-1.5 w-1.5 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 animate-pulse" /> Inteligencia V5.3
                                    </p>
                                </div>
                            </div>

                            <div className="flex items-center gap-2">
                                {/* Filtro Temporal Dinámico */}
                                <div className="hidden md:flex items-center gap-2 card-base border-none dark:bg-[#18181b]/50 p-1.5 rounded-2xl border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                                    <input 
                                        type="date" 
                                        value={dateFrom.split('T')[0]} 
                                        onChange={(e) => setDateFrom(`${e.target.value}T00:00`)}
                                        className="text-[10px] font-medium uppercase tracking-tight bg-transparent border-none outline-none text-gray-700 dark:text-zinc-300 w-[110px]"
                                    />
                                    <span className="text-gray-400 font-medium">-</span>
                                    <input 
                                        type="date" 
                                        value={dateTo.split('T')[0]} 
                                        onChange={(e) => setDateTo(`${e.target.value}T23:59`)}
                                        className="text-[10px] font-medium uppercase tracking-tight bg-transparent border-none outline-none text-gray-700 dark:text-zinc-300 w-[110px]"
                                    />
                                    <Button size="sm" variant="flat" onPress={() => {
                                        const today = new Date().toISOString().split('T')[0];
                                        setDateFrom(`${today}T00:00`);
                                        setDateTo(`${today}T23:59`);
                                    }} className="h-7 px-2 bg-white/5 text-zinc-900 dark:text-zinc-100 font-medium text-[9px] uppercase rounded-2xl">Hoy</Button>
                                </div>

                                <Button
                                    variant="flat"
                                    onPress={() => mutate()}
                                    className="h-10 px-4 card-base border-none dark:bg-[#18181b] text-zinc-900 dark:text-zinc-50 font-medium uppercase text-[10px] rounded-2xl border border-gray-200 dark:border-white/10 tracking-tight tracking-widest shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all active:scale-95"
                                >
                                    <RefreshCw size={16} strokeWidth={2.5} className={`mr-1.5 ${isLoading ? 'animate-spin' : ''}`} />
                                    <span className="hidden sm:inline">Sincronizar</span>
                                </Button>
                            </div>
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
                            <h3 className="text-xl font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight tracking-tighter">Error de Conexión</h3>
                            <Button onPress={() => mutate()} color="primary" className="font-medium rounded-2xl">Reintentar</Button>
                        </div>
                    ) : (
                        <>
                            {/* ALERTA DE CAMBIOS DE PRECIO */}
                            {data.priceChangesTodayCount > 0 && (
                                <div className="bg-gradient-to-r from-emerald-500/10 via-emerald-500/5 to-transparent border border-emerald-500/20 rounded-2xl p-4 flex items-center justify-between animate-in fade-in slide-in-from-top-4 duration-1000">
                                    <div className="flex items-center gap-4">
                                        <div className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 h-10 w-10 rounded-2xl text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex items-center justify-center shrink-0">
                                            <Bell size={20} fill="currentColor" />
                                        </div>
                                        <div className="flex flex-col">
                                            <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight tracking-tight">Auditoría de Precios</h4>
                                            <p className="text-[11px] text-gray-500 dark:text-zinc-400 font-medium">
                                                <span className="font-medium text-zinc-900 dark:text-zinc-100">{data.priceChangesTodayCount} productos</span> han cambiado de precio hoy.
                                            </p>
                                        </div>
                                    </div>
                                    <Button 
                                        size="sm"
                                        variant="shadow"
                                        color="success"
                                        className="font-medium uppercase text-[10px] tracking-tight tracking-tighter rounded-2xl"
                                        onPress={() => window.open(`https://t.me/${process.env.NEXT_PUBLIC_TELEGRAM_BOT_NAME || 'POSProBot'}`, '_blank')}
                                    >
                                        Ver en Telegram
                                    </Button>
                                </div>
                            )}

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
                                    <CashFlowWidget data={data.todayCashFlow} />
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