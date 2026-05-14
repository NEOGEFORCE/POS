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

// Componentes dinámicos
const DateRangeModal = nextDynamic(() => import("../dashboard/components/DateRangeModal"));
const GenerateReportModal = nextDynamic(() => import("./components/GenerateReportModal"));
const ClosuresHistory = nextDynamic(() => import("./components/ClosuresHistory"));

const MetricCard = memo(({ label, value, subValue, trend }: any) => (
  <div className="bg-white/80 dark:bg-zinc-900/50 backdrop-blur-xl p-5 rounded-[2.5rem] border border-gray-200 dark:border-white/5 shadow-xl relative overflow-hidden group hover:border-emerald-500/30 transition-all">
    <div className="absolute inset-x-0 bottom-0 h-10 opacity-20 pointer-events-none">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={[{ val: 10 }, { val: 25 }, { val: 15 }, { val: 35 }, { val: 20 }, { val: 45 }, { val: 30 }]}>
          <Area type="monotone" dataKey="val" stroke="#10b981" fill="#10b981" fillOpacity={0.2} strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
    <div className="relative z-10">
      <span className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.2em] mb-1 block italic">{label}</span>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-black text-gray-900 dark:text-white tracking-tighter italic">{value}</span>
        <span className="text-xs font-black text-emerald-500">{trend}</span>
      </div>
      <p className="text-[9px] font-bold text-gray-400 mt-2 uppercase tracking-widest">{subValue}</p>
    </div>
  </div>
));

MetricCard.displayName = "MetricCard";

export default function ReportsPage() {
  const { toast } = useToast();
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

  const getHeaders = () => {
    const token = Cookies.get('token');
    return { 'Authorization': `Bearer ${token}` };
  };

  const handleDownload = async (type: string, customOptions?: any) => {
    setLoadingReport(type);
    try {
      switch (type) {
        case 'box-closure': {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/dashboard/reports/closures?from=${dateFrom}&to=${dateTo}`, { headers: getHeaders() });
          const data = await res.json();
          generatePDFReport({
            title: 'Reporte de Cierres de Caja',
            subtitle: `Rango: ${dateFrom} - ${dateTo}`,
            filename: customOptions?.reportName || 'Cierres_Caja',
            columns: [
              { header: 'ID', dataKey: 'id' },
              { header: 'Cajero', dataKey: 'createdBy' },
              { header: 'Esperado', dataKey: 'expected' },
              { header: 'Real', dataKey: 'real' },
              { header: 'Diff', dataKey: 'diff' }
            ],
            data: (data || []).map((item: any) => ({
              ...item,
              expected: `$${formatCurrency(item.expectedCash)}`,
              real: `$${formatCurrency(item.totalCashReal)}`,
              diff: `$${formatCurrency(item.difference)}`
            }))
          });
          break;
        }
        case 'inventory-valuation': {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/dashboard/reports/inventory-valuation`, { headers: getHeaders() });
          const data = await res.json();
          generatePDFReport({
            title: 'Valoración de Inventario',
            subtitle: `Estado Actual del Almacén`,
            filename: customOptions?.reportName || 'Valoracion_Stock',
            columns: [
              { header: 'Categoría', dataKey: 'category' },
              { header: 'Items', dataKey: 'count' },
              { header: 'Valor Costo', dataKey: 'totalCost' }
            ],
            data: (data.categories || []).map((c: any) => ({
              category: c.name,
              count: c.productCount,
              totalCost: `$${formatCurrency(c.totalCostValue)}`
            }))
          });
          break;
        }
      }
      toast({ title: "ÉXITO", description: "REPORTE GENERADO CORRECTAMENTE", variant: "success" });
    } catch (error) {
      console.error(error);
      toast({ title: "ERROR", description: "FALLO AL GENERAR REPORTE", variant: "destructive" });
    } finally {
      setLoadingReport(null);
    }
  };

  return (
    <div className="flex flex-col w-full h-full max-w-[1600px] mx-auto bg-transparent text-gray-900 dark:text-white transition-all duration-500 overflow-hidden relative">
      
      {/* HEADER */}
      <div className="shrink-0 px-3 pt-1.5 pb-2 flex flex-col gap-3 border-b border-gray-200/50 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-950/50 backdrop-blur-md">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-500 h-10 w-10 rounded-xl text-white shadow-lg shadow-emerald-500/20 flex items-center justify-center transform -rotate-3 shrink-0">
              <BarChart3 size={20} />
            </div>
            <div className="flex flex-col">
              <h1 className="text-[13px] font-black text-gray-900 dark:text-white tracking-tighter uppercase italic leading-none">
                Central de <span className="text-emerald-500">Reportes</span>
              </h1>
              <p className="text-[8px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.4em] italic mt-1 flex items-center gap-1">
                <Target size={10} className="text-emerald-500" /> Business Intelligence V4.0
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
            <Button
              variant="flat"
              onPress={() => setDateRangeOpen(true)}
              className="h-10 px-4 bg-white/80 dark:bg-white/5 text-gray-900 dark:text-white font-black uppercase text-[10px] rounded-xl border border-gray-200 dark:border-white/10 italic tracking-widest shadow-sm transition-all active:scale-95"
            >
              <Calendar size={14} className="mr-1.5 text-emerald-500" /> Rango de Fechas
            </Button>
            <Button
              onPress={() => setIsGenerateModalOpen(true)}
              className="h-10 px-6 bg-emerald-500 text-white font-black uppercase text-[10px] rounded-xl shadow-lg shadow-emerald-500/20 italic tracking-widest active:scale-95"
            >
              <Zap size={14} className="mr-1.5" /> Generador Maestro
            </Button>
          </div>
        </div>
      </div>

      {/* CONTENT */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar bg-gray-100/50 dark:bg-zinc-950/20 p-4">
        <div className="flex flex-col gap-6 max-w-full">
          
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            <MetricCard label="Ventas Hoy" value="$1.2M" subValue="120 Transacciones" trend="+12%" />
            <MetricCard label="Cajas Cerradas" value="08" subValue="Turno Mañana/Tarde" trend="Auditado" />
            <MetricCard label="Riesgo Cartera" value="$4.5M" subValue="15 Clientes Fiados" trend="Crítico" />
            <MetricCard label="Valor Stock" value="$82M" subValue="1.2k Productos" trend="Actualizado" />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[1fr_384px] gap-8 items-start">
            <div className="flex-1 flex flex-col min-w-0 gap-8 overflow-hidden">
               <ClosuresHistory />
            </div>

            <aside className="sticky top-0 flex flex-col gap-6 pb-10 xl:pb-0">
               <Card className="bg-white/80 dark:bg-zinc-900/50 backdrop-blur-xl border border-gray-200 dark:border-white/5 text-gray-900 dark:text-white rounded-[2.5rem] shadow-2xl p-6 md:p-8 border-none">
                  <div className="flex flex-col gap-6 text-center">
                    <h3 className="text-2xl font-black italic uppercase tracking-tighter">Acceso <span className="opacity-40">Rápido</span></h3>
                    <Tabs
                      aria-label="Quick Report Type"
                      color="success"
                      selectedKey={quickCategory}
                      onSelectionChange={(k) => setQuickCategory(String(k))}
                      classNames={{ tabList: "bg-gray-100 dark:bg-zinc-950/50 p-1 rounded-xl w-full", cursor: "bg-emerald-500", tabContent: "font-black text-[10px] uppercase italic tracking-widest" }}
                    >
                      <Tab key="box-closure" title="Caja" />
                      <Tab key="payments" title="Ventas" />
                      <Tab key="inventory" title="Stock" />
                    </Tabs>
                    <Button
                      onPress={() => handleDownload(quickCategory)}
                      isLoading={loadingReport === quickCategory}
                      className="w-full h-14 bg-emerald-500 text-white font-black uppercase text-[12px] rounded-[1.5rem] shadow-xl shadow-emerald-500/20 italic tracking-[0.2em] transition-all hover:scale-[1.02] active:scale-95"
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
