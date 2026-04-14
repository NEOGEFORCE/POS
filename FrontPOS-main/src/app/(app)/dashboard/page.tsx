"use client"

import { useState } from "react";
import dynamic from "next/dynamic";
import { useToast } from "@/hooks/use-toast"
import { useApi } from "@/hooks/use-api"
import { formatCurrency } from "@/lib/utils"
import { Sparkles, RefreshCw, AlertTriangle } from "lucide-react"
import { Button, Skeleton, Chip } from "@heroui/react"
import jsPDF from "jspdf"
import autoTable from "jspdf-autotable"

// Dynamic imports for improved HMR performance
const DashboardKPIs = dynamic(() => import("./components/DashboardKPIs"), { 
    loading: () => <Skeleton className="h-40 w-full rounded-2xl" /> 
});
const DashboardCharts = dynamic(() => import("./components/DashboardCharts"), { 
    loading: () => <Skeleton className="h-80 w-full rounded-2xl" /> 
});
const LowStockPanel = dynamic(() => import("./components/LowStockPanel"), { 
    loading: () => <Skeleton className="h-60 w-full rounded-2xl" /> 
});
const RecentActivity = dynamic(() => import("./components/RecentActivity"), { 
    loading: () => <Skeleton className="h-60 w-full rounded-2xl" /> 
});
const ReportButtons = dynamic(() => import("./components/ReportButtons"), {
    loading: () => <Skeleton className="h-24 w-full rounded-3xl" />
});
const DateRangeModal = dynamic(() => import("./components/DateRangeModal"));

// Metadata augmentation for jsPDF
declare module "jspdf" {
  interface jsPDF {
    lastAutoTable: {
      finalY: number;
    };
  }
}

interface LowStockItem {
  barcode: string;
  name: string;
  stock: number;
  minStock: number;
}

interface DailyPoint {
  date: string;
  amount: number;
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
    transfer_source?: string;
  }[];
  todaySalesAmount: number;
  todaySalesCount: number;
  todayExpenses: number;
  activeProducts: number;
  totalProducts: number;
  categoriesCount: number;
  lowStockProducts: LowStockItem[];
  salesByPayment: Record<string, number>;
  dailySalesLast7: DailyPoint[];
}

export default function DashboardPage() {
  const { data, isLoading, error, mutate } = useApi<DashboardData>('/dashboard/overview');
  const { toast } = useToast();
  
  const [isRangeModalOpen, setIsRangeModalOpen] = useState(false);
  const [dateFrom, setDateFrom] = useState(`${new Date().toISOString().split('T')[0]}T00:00`);
  const [dateTo, setDateTo] = useState(`${new Date().toISOString().split('T')[0]}T23:59`);

  const stockHealth = data ? (data.totalProducts > 0 ? (data.activeProducts / data.totalProducts) * 100 : 0) : 0;
  const stockHealthColor = stockHealth >= 80 ? '#10b981' : stockHealth >= 50 ? '#f59e0b' : '#ef4444';

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6 w-full max-w-7xl mx-auto h-full overflow-y-auto custom-scrollbar transition-colors pb-32">
      
      {/* HEADER */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-2 p-4 md:p-6 bg-white dark:bg-zinc-900/40 backdrop-blur-xl border border-gray-200 dark:border-white/5 rounded-3xl shadow-sm transition-colors shrink-0">
        <div className="flex items-center gap-4">
          <div>
            <Chip variant="flat" className="bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 font-bold tracking-widest uppercase text-[9px] mb-3 px-2 border-none">
              Dashboard V5.0
            </Chip>
            <h1 className="text-2xl md:text-4xl font-black text-gray-900 dark:text-white tracking-tighter uppercase">
              Resumen <span className="text-emerald-600 dark:text-emerald-500">Ejecutivo</span>
            </h1>
            <p className="text-[10px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest mt-1">Estado actual de tu negocio</p>
          </div>
        </div>
        <Button
          variant="flat"
          startContent={<RefreshCw size={16} />}
          onPress={() => mutate()}
          className="bg-gray-100 dark:bg-white/5 text-gray-700 dark:text-white font-bold uppercase tracking-widest text-[10px] rounded-xl hover:bg-emerald-500 hover:text-white dark:hover:bg-emerald-500 dark:hover:text-black transition-all shadow-sm h-12 px-6"
        >
          Sincronizar
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
          {[1,2,3,4,5,6].map(i => <Skeleton key={i} className="h-36 rounded-2xl" />)}
        </div>
      ) : error || !data ? (
        <div className="py-20 flex flex-col items-center justify-center gap-6">
            <AlertTriangle className="h-16 w-16 text-rose-500" />
            <h3 className="text-2xl font-black text-gray-900 dark:text-white uppercase">Error de Conexión</h3>
            <Button onPress={() => mutate()} color="primary" className="font-bold">Reintentar</Button>
        </div>
      ) : (
        <>
            <DashboardKPIs data={data} />
            <DashboardCharts 
                dailySalesLast7={data.dailySalesLast7} 
                salesByPayment={data.salesByPayment} 
                stockHealth={stockHealth} 
                stockHealthColor={stockHealthColor} 
            />
            
            <ReportButtons onOpenRange={() => setIsRangeModalOpen(true)} />

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                <LowStockPanel items={data.lowStockProducts} />
                <RecentActivity sales={data.recentSales} />
            </div>

            <DateRangeModal 
                isOpen={isRangeModalOpen}
                onOpenChange={setIsRangeModalOpen}
                startDate={dateFrom}
                endDate={dateTo}
                onSetStartDate={setDateFrom}
                onSetEndDate={setDateTo}
                onDownloadRange={() => setIsRangeModalOpen(false)}
            />
        </>
      )}

    </div>
  )
}