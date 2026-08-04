"use client";

import React, { useState, useMemo, memo, useEffect } from 'react';
import {
  Card, CardHeader, CardBody, Button, Chip,
  Divider, Tab, Tabs, Spinner, Table, TableHeader,
  TableColumn, TableBody, TableRow, TableCell,
  Input, Pagination, Tooltip, Avatar
} from "@heroui/react";
import {
  BarChart3, FileText, Download, Wallet, ShoppingCart,
  Package, Users, AlertTriangle, TrendingUp, History,
  FileSearch, Printer, Calendar, Target, Zap, Banknote,
  CreditCard as CreditCardIcon, PlusCircle, Search,
  Clock, Mail, ChevronRight, Filter, MoreHorizontal, Trash2, Loader2
} from "lucide-react";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { generatePDFReport } from "@/lib/reportGenerator";
import { useToast } from "@/hooks/use-toast";
import Cookies from 'js-cookie';
import nextDynamic from "next/dynamic";
import { ResponsiveContainer, AreaChart, Area } from 'recharts';

import { useApi } from "@/hooks/use-api";

// Componentes dinamicos
const DateRangeModal = nextDynamic(() => import("../dashboard/components/DateRangeModal"));
const GenerateReportModal = nextDynamic(() => import("./components/GenerateReportModal"));
const ClosuresHistory = nextDynamic(() => import("./components/ClosuresHistory"));
const ProfitabilityReportView = nextDynamic(() => import("./components/ProfitabilityReportView"));

const MetricCard = memo(({ label, value, subValue, trend }: any) => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  return (
    <div className="card-base p-6 relative group hover:border-zinc-200 dark:border-white/10 transition-all duration-150">
      {mounted && (
        <div className="absolute inset-x-0 bottom-0 h-10 opacity-10 pointer-events-none">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={[{ val: 10 }, { val: 25 }, { val: 15 }, { val: 35 }, { val: 20 }, { val: 45 }, { val: 30 }]}>
              <Area type="monotone" dataKey="val" stroke="#3f3f46" fill="#3f3f46" fillOpacity={0.2} strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className="relative z-10">
        <span className="text-[11px] font-medium tracking-widest uppercase text-gray-500 dark:text-zinc-500 block mb-2">{label}</span>
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-light tracking-tight text-zinc-900 dark:text-zinc-50 tabular-nums font-['DM_Mono']">{value}</span>
          <span className="text-xs font-medium text-gray-500 dark:text-zinc-500">{trend}</span>
        </div>
        <p className="text-xs text-zinc-600 mt-1">{subValue}</p>
      </div>
    </div>
  );
});

MetricCard.displayName = "MetricCard";

export default function ReportsPage() {
  const { toast } = useToast();
  const [mainTab, setMainTab] = useState<'closures' | 'profitability'>('closures');
  const [loadingReport, setLoadingReport] = useState<string | null>(null);
  const [isGenerateModalOpen, setIsGenerateModalOpen] = useState(false);
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return `${d.toISOString().split('T')[0]}T00:00`;
  });
  const [dateTo, setDateTo] = useState(`${new Date().toISOString().split('T')[0]}T23:59`);
  const [quickCategory, setQuickCategory] = useState("box-closure");

  const { data } = useApi<any>(`/dashboard/overview?startDate=${dateFrom}&endDate=${dateTo}`);

  const getHeaders = () => {
    const token = Cookies.get('org-pos-token');
    return { 'Authorization': `Bearer ${token}` };
  };
  const handleDownload = async (type: string, customOptions?: any) => {
    setLoadingReport(type);
    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api';

      // Categorias que SIEMPRE pasan por el backend export unificado.
      // Incluye todas las nuevas: cuadre-real, profitability, shrinkage, rotation
      const backendCategories = [
        'box-closure', 'cuadre-real', 'cuadre-real-day', 'payments',
        'inventory', 'pnl', 'cashflow', 'cashflow-detailed', 'ranking', 'savings',
        'vault-audit', 'global-credit', 'voids-audit',
        'profitability', 'shrinkage', 'rotation', 'expenses'
      ];

      // Solo dejamos el fallback frontend si la categoria no es soportada por el backend
      // (por seguridad, mantenemos el fallback jsPDF como red de seguridad).
      if (!backendCategories.includes(type)) {
          let url = '';
          let title = '';
          if (type === 'savings') { url = `${baseUrl}/inventory/savings-opportunities`; title = 'Ahorros y Costos'; }
          if (!url) {
            throw new Error(`Tipo de reporte desconocido: ${type}`);
          }

          const res = await fetch(url, { headers: getHeaders() });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Fallo al generar reporte");

          generatePDFReport({
            title,
            subtitle: 'Generado hoy',
            filename: customOptions?.reportName || type,
            columns: [],
            data: Array.isArray(data) ? data : [],
            sendToTelegram: customOptions?.sendToTelegram
          });
          setLoadingReport(null);
          return;
      }

      // FLUJO CENTRALIZADO EN EL BACKEND (Go)
      const format = customOptions?.format || 'PDF';
      const sendTelegram = customOptions?.sendToTelegram ? 'true' : 'false';

      const params = new URLSearchParams({
        type,
        from: customOptions?.dateFrom || dateFrom,
        to: customOptions?.dateTo || dateTo,
        format,
        telegram: sendTelegram,
      });

      // Parametro extra para rentabilidad: target margin (default 0.17)
      if (type === 'profitability') {
        params.set('target', String(customOptions?.target ?? 0.17));
      }
      
      // Parametro extra para egresos: concept
      if (type === 'expenses' && customOptions?.concept) {
        params.set('concept', customOptions.concept);
      }

      const url = `${baseUrl}/dashboard/reports/export?${params.toString()}`;

      const res = await fetch(url, { headers: getHeaders() });
      if (!res.ok) {
        let errMsg = `Error ${res.status} al exportar reporte`;
        try {
          const errData = await res.json();
          errMsg = errData?.error || errData?.userMessage || errMsg;
        } catch {
          // Respuesta no es JSON (p.ej. HTML del SPA fallback) → mantener el mensaje generico
        }
        throw new Error(errMsg);
      }

      const blob = await res.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;

      const extensionMap: Record<string, string> = {
        EXCEL: 'xlsx',
        XLSX: 'xlsx',
        CSV: 'csv',
        PDF: 'pdf',
      };
      const extension = extensionMap[format] || 'pdf';
      a.download = `${customOptions?.reportName || type}.${extension}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(downloadUrl);
      document.body.removeChild(a);

      toast({
        title: "Reporte Generado",
        description: `Descargado exitosamente.${customOptions?.sendToTelegram ? ' Se envio copia por Telegram.' : ''}`,
        variant: "default"
      });

    } catch (error: any) {
      console.error(error);
      toast({
        title: "Error al generar",
        description: error.message || "Error desconocido",
        variant: "destructive"
      });
    } finally {
      setLoadingReport(null);
    }
  };

  return (
    <div className="flex flex-col w-full max-w-[1600px] mx-auto bg-transparent text-zinc-900 dark:text-zinc-50 transition-all duration-500 relative">
      
      {/* HEADER */}
      <div className="shrink-0 px-3 pt-1.5 pb-2 flex flex-col gap-3 border-b border-gray-200/50 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-950/50">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 h-10 w-10 rounded-2xl text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex items-center justify-center transform -rotate-3 shrink-0">
              <BarChart3 size={20} />
            </div>
            <div className="flex flex-col">
              <h1 className="text-[13px] font-medium text-zinc-900 dark:text-zinc-50 tracking-tighter uppercase tracking-tight leading-none">
                Central de <span className="text-zinc-900 dark:text-zinc-100">Reportes</span>
              </h1>
              <p className="text-[8px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.4em] tracking-tight mt-1 flex items-center gap-1">
                <Target size={10} className="text-zinc-900 dark:text-zinc-100" /> Business Intelligence V4.0
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
            <Button
              variant="flat"
              onPress={() => setDateRangeOpen(true)}
              className="bg-transparent text-gray-500 dark:text-zinc-500 dark:text-zinc-400 text-sm font-medium border border-white/[0.08] rounded-xl px-4 h-10 hover:bg-zinc-100 dark:bg-zinc-800 hover:text-zinc-200 transition-all duration-150"
            >
              <Calendar size={14} className="mr-1.5" /> Rango de Fechas
            </Button>
            <Button
              onPress={() => setIsGenerateModalOpen(true)}
              className="bg-transparent text-gray-500 dark:text-zinc-500 dark:text-zinc-400 text-sm font-medium border border-white/[0.08] rounded-xl px-4 h-10 hover:bg-zinc-100 dark:bg-zinc-800 hover:text-zinc-200 transition-all duration-150"
            >
              <Zap size={14} className="mr-1.5" /> Generador Maestro
            </Button>
          </div>
        </div>
      </div>

      {/* CONTENT */}
      <div className="bg-gray-100/50 dark:bg-zinc-950/20 p-4">
        <div className="flex flex-col gap-6 max-w-full">
          
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            <MetricCard 
              label="Ventas Hoy" 
              value={data ? formatCurrency(data.todaySalesAmount || 0) : "---"} 
              subValue={`${data?.todaySalesCount || 0} Transacciones`} 
              trend="Actualizado" 
            />
            <MetricCard 
              label="Egresos Hoy" 
              value={data ? formatCurrency(data.todayExpenses?.amount || 0) : "---"} 
              subValue={`${data?.todayExpenses?.count || 0} Movimientos`} 
              trend="Auditado" 
            />
            <MetricCard 
              label="Riesgo Cartera" 
              value={data?.pendingDebts ? formatCurrency(data.pendingDebts.amount || 0) : "---"} 
              subValue={`${data?.pendingDebts?.count || 0} Fiados Pendientes`} 
              trend="Critico" 
            />
            <MetricCard 
              label="Productos Totales" 
              value={data ? (data.totalProducts || 0).toLocaleString() : "---"} 
              subValue={`${data?.activeProducts || 0} Activos`} 
              trend="Actualizado" 
            />
          </div>

          {/* PESTAÑAS PRINCIPALES DEL MÓDULO DE REPORTES */}
          <div className="flex items-center gap-2 border-b border-gray-200 dark:border-white/10 pb-3">
            <Button
              size="md"
              variant={mainTab === 'closures' ? "solid" : "flat"}
              color={mainTab === 'closures' ? "success" : "default"}
              onPress={() => setMainTab('closures')}
              className={`font-semibold text-xs uppercase tracking-wider rounded-xl ${
                mainTab === 'closures' ? 'shadow-sm text-white font-bold' : 'text-zinc-600 dark:text-zinc-400'
              }`}
            >
              <History size={16} />
              Historial de Cierres de Caja
            </Button>

            <Button
              size="md"
              variant={mainTab === 'profitability' ? "solid" : "flat"}
              color={mainTab === 'profitability' ? "success" : "default"}
              onPress={() => setMainTab('profitability')}
              className={`font-semibold text-xs uppercase tracking-wider rounded-xl ${
                mainTab === 'profitability' ? 'shadow-sm text-white font-bold' : 'text-zinc-600 dark:text-zinc-400'
              }`}
            >
              <TrendingUp size={16} />
              Reporte de Rentabilidad
            </Button>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[1fr_384px] gap-8 items-start">
            <div className="flex-1 flex flex-col min-w-0 gap-8">
               {mainTab === 'closures' ? (
                 <ClosuresHistory />
               ) : (
                 <ProfitabilityReportView />
               )}
            </div>

            <aside className="sticky top-0 flex flex-col gap-6 pb-10 xl:pb-0">
               <Card className="card-base p-6 md:p-8">
                  <div className="flex flex-col gap-6 text-center">
                    <h3 className="text-2xl font-medium tracking-tight uppercase tracking-tighter">Acceso <span className="opacity-40">Rapido</span></h3>
                    <Tabs
                      aria-label="Quick Report Type"
                      color="success"
                      selectedKey={quickCategory}
                      onSelectionChange={(k) => setQuickCategory(String(k))}
                      classNames={{ tabList: "bg-gray-100 dark:bg-zinc-950/50 p-1 rounded-2xl w-full overflow-x-auto", cursor: "bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5", tabContent: "font-medium text-[10px] uppercase tracking-tight tracking-widest" }}
                    >
                      <Tab key="cuadre-real" title="Real" />
                      <Tab key="profitability" title="Margen" />
                      <Tab key="shrinkage" title="Mermas" />
                      <Tab key="rotation" title="Rotacion" />
                      <Tab key="payments" title="Ventas" />
                      <Tab key="inventory" title="Stock" />
                      <Tab key="cashflow" title="Flujo" />
                    </Tabs>
                    <Button
                      onPress={() => handleDownload(quickCategory)}
                      isLoading={loadingReport === quickCategory}
                      className="w-full h-10 bg-zinc-50 text-zinc-950 font-medium text-sm rounded-xl px-4 hover:bg-zinc-200 transition-colors duration-150"
                    >
                      DESCARGAR REPORTE
                    </Button>
                  </div>
               </Card>
            </aside>
          </div>
        </div>
      </div>

      <DateRangeModal
        isOpen={dateRangeOpen}
        onOpenChange={() => setDateRangeOpen(false)}
        startDate={dateFrom}
        endDate={dateTo}
        onSetStartDate={setDateFrom}
        onSetEndDate={setDateTo}
        onDownloadRange={() => setDateRangeOpen(false)}
      />

      <GenerateReportModal
        isOpen={isGenerateModalOpen}
        onOpenChange={() => setIsGenerateModalOpen(false)}
        onGenerate={handleDownload}
      />
    </div>
  );
}


