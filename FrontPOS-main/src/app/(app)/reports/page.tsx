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
  FileSearch, Printer, Calendar, Target, Zap, 
  CreditCard as CreditCardIcon, PlusCircle, Search,
  Clock, Mail, ChevronRight, Filter, MoreHorizontal, Trash2, Loader2
} from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { generatePDFReport } from "@/lib/reportGenerator";
import { useToast } from "@/hooks/use-toast";
import Cookies from 'js-cookie';
import dynamic from "next/dynamic";
import { ResponsiveContainer, AreaChart, Area } from 'recharts';

// Componentes dinámicos
const DateRangeModal = dynamic(() => import("../dashboard/components/DateRangeModal"));
// El nuevo Modal avanzado se creará en el siguiente paso
const GenerateReportModal = dynamic(() => import("./components/GenerateReportModal"));

// ----- DATOS SIMULADOS (MOCK) -----
const ARCHIVED_REPORTS = [
    { id: "1", name: "CIERRE_GENERAL_ABRIL", date: "2024-04-15", user: "Admin", format: "PDF", size: "1.2MB" },
    { id: "2", name: "AUDITORIA_VENTAS_Q1", date: "2024-04-14", user: "Jaider", format: "XLS", size: "3.5MB" },
    { id: "3", name: "VALORACION_INV_FIX", date: "2024-04-12", user: "SuperAdmin", format: "PDF", size: "850KB" },
    { id: "4", name: "LOG_ANULACIONES_TURNO_A", date: "2024-04-10", user: "Cajero_2", format: "PDF", size: "420KB" },
    { id: "5", name: "REPORTE_GASTOS_OPERATIVOS", date: "2024-04-05", user: "Admin", format: "CSV", size: "2.1MB" },
    { id: "6", name: "AHORROS_COSTOS_MAYO", date: "2024-05-01", user: "Admin", format: "PDF", size: "680KB" },
];

// Mapeo de nombres técnicos a nombres comerciales
const BUSINESS_NAMES: Record<string, string> = {
    "CIERRE_GENERAL_ABRIL": "Cierre de Caja del Mes",
    "AUDITORIA_VENTAS_Q1": "Auditoría de Ventas",
    "VALORACION_INV_FIX": "Valor Total del Inventario",
    "LOG_ANULACIONES_TURNO_A": "Registro de Anulaciones",
    "REPORTE_GASTOS_OPERATIVOS": "Reporte de Gastos del Negocio",
    "AHORROS_COSTOS_MAYO": "Oportunidades de Ahorro",
};

// Chip premium de formato - estilo consistente con Inventario
const FormatChip = ({ format }: { format: string }) => {
    const colorMap: Record<string, { color: "success" | "primary" | "warning" | "default"; bg: string; text: string }> = {
        "PDF": { color: "success", bg: "bg-emerald-500/10", text: "text-emerald-600 dark:text-emerald-400" },
        "XLS": { color: "primary", bg: "bg-sky-500/10", text: "text-sky-600 dark:text-sky-400" },
        "CSV": { color: "warning", bg: "bg-amber-500/10", text: "text-amber-600 dark:text-amber-400" },
    };
    const style = colorMap[format] || { color: "default", bg: "bg-gray-500/10", text: "text-gray-600" };
    return (
        <div className={`inline-flex items-center px-2 py-1 rounded-lg ${style.bg} border border-${style.color}-500/20`}>
            <span className={`text-[10px] font-bold ${style.text} uppercase`}>{format}</span>
        </div>
    );
};

const SCHEDULED_REPORTS = [
    { id: "1", name: "Cierre Diario Automatizado", frequency: "Diary", next: "2024-04-16 23:59", recipient: "gerencia@pos.com" },
    { id: "2", name: "Alerta Stock Crítico", frequency: "Hourly", next: "Sig. Hora", recipient: "compras@pos.com" },
    { id: "3", name: "Balance PyG Mensual", frequency: "Monthly", next: "2024-05-01 08:00", recipient: "contabilidad@pos.com" },
];

// Tipo para tracking de descargas
interface DownloadState {
  [key: string]: boolean;
}

const SPARKLINE_DATA = [
    { val: 10 }, { val: 25 }, { val: 15 }, { val: 35 }, { val: 20 }, { val: 45 }, { val: 30 }
];

// ----- COMPONENTES AUXILIARES -----

const MetricCard = memo(({ label, value, subValue, trend }: any) => (
    <div className="bg-white/80 dark:bg-zinc-900/50 backdrop-blur-xl p-5 rounded-[2.5rem] border border-gray-200 dark:border-white/5 shadow-xl relative overflow-hidden group hover:border-emerald-500/30 transition-all">
        <div className="absolute inset-x-0 bottom-0 h-10 opacity-20 pointer-events-none">
            <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={SPARKLINE_DATA}>
                    <Area type="monotone" dataKey="val" stroke="#10b981" fill="#10b981" fillOpacity={0.2} strokeWidth={2}/>
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

export default function ReportsPage() {
  const [loadingReport, setLoadingReport] = useState<string | null>(null);
  const [isGenerateModalOpen, setIsGenerateModalOpen] = useState(false);
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const [dateFrom, setDateFrom] = useState(`${new Date().toISOString().split('T')[0]}T00:00`);
  const [dateTo, setDateTo] = useState(`${new Date().toISOString().split('T')[0]}T23:59`);
  
  // Quick Panel State
  const [quickCategory, setQuickCategory] = useState("box-closure");
  const [quickFormat, setQuickFormat] = useState("PDF");
  
  // Estado de carga para descargas de archivos del historial
  const [downloadingIds, setDownloadingIds] = useState<DownloadState>({});
  
  const { toast } = useToast();

  // Handler de descarga real para archivos del historial
  const handleArchiveDownload = async (report: typeof ARCHIVED_REPORTS[0]) => {
    setDownloadingIds(prev => ({ ...prev, [report.id]: true }));
    try {
      // Simular delay de descarga (reemplazar con llamada real al backend)
      await new Promise(resolve => setTimeout(resolve, 800));
      
      // Crear blob simulado (en producción, esto vendría del backend)
      const blob = new Blob(['%PDF-1.4\n%...'], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = `${report.name.replace(/ /g, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
      }, 100);
      
      toast({ 
        variant: 'success', 
        title: 'DESCARGA COMPLETADA', 
        description: `${BUSINESS_NAMES[report.name] || report.name} listo.` 
      });
    } catch (error) {
      toast({ 
        variant: 'destructive', 
        title: 'ERROR DE DESCARGA', 
        description: 'No se pudo descargar el archivo.' 
      });
    } finally {
      setDownloadingIds(prev => ({ ...prev, [report.id]: false }));
    }
  };

  // Event listeners para notificaciones de Telegram desde reportGenerator
  useEffect(() => {
    const handleTelegramSuccess = (event: any) => {
      toast({ variant: 'success', title: 'TELEGRAM', description: event.detail.message });
    };
    
    const handleTelegramError = (event: any) => {
      toast({ variant: 'destructive', title: 'TELEGRAM ERROR', description: event.detail.message });
    };

    window.addEventListener('telegram-success', handleTelegramSuccess);
    window.addEventListener('telegram-error', handleTelegramError);

    return () => {
      window.removeEventListener('telegram-success', handleTelegramSuccess);
      window.removeEventListener('telegram-error', handleTelegramError);
    };
  }, [toast]);

  const getHeaders = () => ({
    'Authorization': `Bearer ${Cookies.get('org-pos-token')}`,
    'Content-Type': 'application/json'
  });

  // Lógica de descarga heredada del original
  const handleDownload = async (type: string, customOptions?: any) => {
    setLoadingReport(type);
    try {
      const fromD = customOptions?.dateFrom || dateFrom || new Date().toISOString().split('T')[0];
      const toD = customOptions?.dateTo || dateTo || new Date().toISOString().split('T')[0];

      switch(type) {
        case 'box-closure': {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/dashboard/cashier-closure`, { headers: getHeaders() });
          const data = await res.json();
          generatePDFReport({
            title: 'Cuadre de Caja (X)',
            subtitle: 'Estado actual del turno en piso',
            filename: customOptions?.reportName || `Cuadre_Caja_${new Date().toISOString().split('T')[0]}`,
            columns: [
              { header: 'Concepto', dataKey: 'label' },
              { header: 'Valor', dataKey: 'value' }
            ],
            data: [
              { label: 'Ventas Totales', value: `$${formatCurrency(data.totalSales)}` },
              { label: 'Efectivo en Caja', value: `$${formatCurrency(data.totalCash)}` },
              { label: 'Gastos Registrados', value: `$${formatCurrency(data.totalExpenses)}` },
              { label: 'Devoluciones', value: `$${formatCurrency(data.totalReturns)}` },
              { label: 'Balance Neto', value: `$${formatCurrency(data.netBalance)}` }
            ],
            summary: [{ label: 'Total Operativo', value: data.netBalance }],
            sendToTelegram: true
          });
          break;
        }
        case 'payments': {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/dashboard/overview`, { headers: getHeaders() });
          const data = await res.json();
          const paymentData = Object.entries(data.salesByPayment).map(([method, amount]) => ({
            method,
            amount: `$${formatCurrency(amount as number)}`
          }));
          generatePDFReport({
            title: 'Ventas por Medio de Pago',
            subtitle: `Periodo: ${fromD} al ${toD}`,
            filename: customOptions?.reportName || 'Reporte_Pagos',
            columns: [
              { header: 'Método de Pago', dataKey: 'method' },
              { header: 'Total Recaudado', dataKey: 'amount' }
            ],
            data: paymentData,
            summary: [{ label: 'Gran Total', value: data.totalSalesAmount }],
            sendToTelegram: true
          });
          break;
        }
        case 'ranking': {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/dashboard/reports/ranking?from=${fromD}&to=${toD}`, { headers: getHeaders() });
          const data = await res.json();
          generatePDFReport({
            title: 'Ranking de Productos',
            subtitle: 'Top ventas por volumen y rentabilidad',
            filename: customOptions?.reportName || 'Ranking_Productos',
            columns: [
              { header: 'Barcode', dataKey: 'barcode' },
              { header: 'Producto', dataKey: 'name' },
              { header: 'Cant.', dataKey: 'quantity' },
              { header: 'Subtotal', dataKey: 'total_fmt' }
            ],
            data: (data || []).map((item: any) => ({ ...item, total_fmt: `$${formatCurrency(item.total)}` })),
            sendToTelegram: true
          });
          break;
        }
        case 'inventory': {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/products/all-products`, { headers: getHeaders() });
          const data = await res.json();
          
          // Validar que data sea array
          const products = Array.isArray(data) ? data : (data?.products || []);
          
          let totalCost = 0;
          let totalValue = 0;
          const categorySummary: Record<string, { count: number; cost: number; value: number }> = {};
          
          const items = products.map((p: any) => {
              // Validación estricta de precios con fallback a 0
              const purchasePrice = Number(p.purchasePrice ?? p.cost_price ?? p.purchase_price ?? 0) || 0;
              const salePrice = Number(p.salePrice ?? p.sale_price ?? p.price ?? 0) || 0;
              const quantity = Number(p.quantity ?? p.stock ?? 0) || 0;
              
              const subCost = purchasePrice * quantity;
              const subValue = salePrice * quantity;
              totalCost += subCost;
              totalValue += subValue;
              
              // Agrupar por categoría
              const category = p.category?.categoryName || p.categoryName || 'Sin Categoría';
              if (!categorySummary[category]) {
                categorySummary[category] = { count: 0, cost: 0, value: 0 };
              }
              categorySummary[category].count += 1;
              categorySummary[category].cost += subCost;
              categorySummary[category].value += subValue;
              
              return {
                  name: p.productName || p.product_name || p.name || 'Sin Nombre',
                  stock: quantity,
                  cost: `$${formatCurrency(purchasePrice)}`,
                  price: `$${formatCurrency(salePrice)}`,
                  total: `$${formatCurrency(subValue)}`,
                  category
              };
          });
          
          // Construir resumen extendido
          const summary = [
            { label: 'Total Productos', value: items.length },
            { label: 'Valor a Costo', value: `$${formatCurrency(totalCost)}` },
            { label: 'Valor a Venta', value: `$${formatCurrency(totalValue)}` },
            { label: 'Margen Potencial', value: `$${formatCurrency(totalValue - totalCost)}` }
          ];
          
          // Agregar top categorías al resumen
          const topCategories = Object.entries(categorySummary)
            .sort((a, b) => b[1].value - a[1].value)
            .slice(0, 3);
          
          topCategories.forEach(([cat, stats]) => {
            summary.push({ 
              label: `Cat: ${cat}`, 
              value: `${stats.count} prod - $${formatCurrency(stats.value)}` 
            });
          });
          
          generatePDFReport({
            title: 'Inventario Valorizado',
            subtitle: `Auditoría de activos en stock - ${new Date().toLocaleDateString('es-CO')}`,
            filename: customOptions?.reportName || `Inventario_Valorizado_${new Date().toISOString().split('T')[0]}`,
            columns: [
              { header: 'Producto', dataKey: 'name' },
              { header: 'Stock', dataKey: 'stock' },
              { header: 'Costo Unit.', dataKey: 'cost' },
              { header: 'Precio Venta', dataKey: 'price' },
              { header: 'Total Venta', dataKey: 'total' }
            ],
            data: items,
            summary,
            sendToTelegram: true
          });
          break;
        }
        case 'pnl': {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/dashboard/reports/pnl?from=${fromD}&to=${toD}`, { headers: getHeaders() });
          const data = await res.json();
          generatePDFReport({
            title: 'Estado de Resultados (PyG)',
            subtitle: `Balance de rentabilidad: ${fromD} al ${toD}`,
            filename: customOptions?.reportName || 'Estado_Resultados',
            columns: [
              { header: 'Indicador', dataKey: 'label' },
              { header: 'Monto Actual', dataKey: 'amount' }
            ],
            data: [
              { label: 'INGRESOS TOTALES (Ventas)', amount: `$${formatCurrency(data.totalRevenue)}` },
              { label: 'COSTO DE MERCANCÍA (COGS)', amount: `$${formatCurrency(data.totalCogs)}` },
              { label: 'UTILIDAD BRUTA', amount: `$${formatCurrency(data.grossProfit)}` },
              { label: 'GASTOS OPERATIVOS', amount: `$${formatCurrency(data.totalExpenses)}` },
              { label: 'UTILIDAD NETA', amount: `$${formatCurrency(data.netProfit)}` }
            ],
            summary: [{ label: 'Margen Neto', value: `${data.marginPercentage.toFixed(2)}%` }],
            sendToTelegram: true
          });
          break;
        }
        case 'savings': {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/inventory/savings-opportunities`, { headers: getHeaders() });
          const data = await res.json();
          generatePDFReport({
            title: 'Ahorros & Oportunidades de Costos',
            subtitle: `Análisis de mejores precios por proveedor - ${new Date().toLocaleDateString('es-CO')}`,
            filename: customOptions?.reportName || `Ahorros_Costos_${new Date().toISOString().split('T')[0]}`,
            columns: [
              { header: 'Producto', dataKey: 'productName' },
              { header: 'Costo Actual', dataKey: 'currentCost' },
              { header: 'Mejor Costo', dataKey: 'bestCost' },
              { header: 'Mejor Proveedor', dataKey: 'bestSupplier' },
              { header: 'Ahorro Potencial', dataKey: 'savings' }
            ],
            data: data.map((item: any) => ({
              productName: item.productName || item.product_name || 'N/A',
              currentCost: `$${formatCurrency(item.currentCost || item.current_cost || 0)}`,
              bestCost: `$${formatCurrency(item.bestCost || item.best_cost || 0)}`,
              bestSupplier: item.bestSupplier || item.best_supplier || 'N/A',
              savings: `$${formatCurrency(item.potentialSavings || item.potential_savings || 0)}`
            })),
            summary: [
              { label: 'Total Oportunidades', value: data.length },
              { label: 'Ahorro Total Potencial', value: data.reduce((sum: number, item: any) => sum + (item.potentialSavings || item.potential_savings || 0), 0) }
            ],
            sendToTelegram: true
          });
          break;
        }
        case 'vault-audit': {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/dashboard/reports/vault-audit`, { headers: getHeaders() });
          const data = await res.json();
          generatePDFReport({
            title: 'Arqueo General de Bóveda',
            subtitle: `Consolidado de Efectivo: ${new Date().toLocaleString('es-CO')}`,
            filename: customOptions?.reportName || 'Arqueo_Boveda',
            columns: [
              { header: 'Concepto', dataKey: 'label' },
              { header: 'Monto', dataKey: 'amount' }
            ],
            data: [
              { label: 'Cajas en Piso (Teórico)', amount: `$${formatCurrency(data.systemCash)}` },
              { label: 'Cajas en Piso (Físico)', amount: `$${formatCurrency(data.reportedCash)}` },
              { label: 'Descuadre Cajas', amount: `$${formatCurrency(data.difference)}` },
              { label: 'Fondo Bóveda/Caja Fuerte', amount: `$${formatCurrency(data.vaultFund)}` },
              { label: 'TOTAL EFECTIVO EN LOCAL', amount: `$${formatCurrency(data.totalPhysical)}` }
            ],
            sendToTelegram: true
          });
          break;
        }
        case 'global-credit': {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/dashboard/reports/global-debt`, { headers: getHeaders() });
          const data = await res.json();
          generatePDFReport({
            title: 'Cartera Global (Fiados)',
            subtitle: `Riesgo Total en Calle - ${new Date().toLocaleDateString('es-CO')}`,
            filename: customOptions?.reportName || 'Cartera_Global',
            columns: [
              { header: 'Indicador', dataKey: 'label' },
              { header: 'Valor', dataKey: 'value' }
            ],
            data: [
              { label: 'RIESGO TOTAL (DEUDA)', value: `$${formatCurrency(data.totalDebt)}` }
            ],
            sendToTelegram: true
          });
          break;
        }
        case 'voids-audit': {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/dashboard/reports/voids`, { headers: getHeaders() });
          const data = await res.json();
          generatePDFReport({
            title: 'Auditoría de Anulaciones',
            subtitle: `Control antifraude y devoluciones`,
            filename: customOptions?.reportName || 'Auditoria_Anulaciones',
            columns: [
              { header: 'ID Venta', dataKey: 'saleId' },
              { header: 'Total', dataKey: 'total' },
              { header: 'Empleado', dataKey: 'employee' },
              { header: 'Fecha', dataKey: 'date' }
            ],
            data: (data || []).map((item: any) => ({
              ...item,
              total: `$${formatCurrency(item.total)}`,
              date: new Date(item.voidedAt || item.date).toLocaleString('es-CO')
            })),
            sendToTelegram: true
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
    <div className="flex flex-col w-full max-w-[1600px] mx-auto h-[calc(100vh-64px)] min-h-0 bg-transparent text-gray-900 dark:text-white transition-all duration-500 overflow-x-hidden overflow-y-hidden relative">
      
      {/* HEADER SECTION: FIXED (TOP) */}
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

      {/* CONTENT SECTION (SCROLLABLE) */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col gap-6 p-4 bg-gray-100/50 dark:bg-zinc-950/20">

      {/* DASHBOARD ANALITICO SUPERIOR */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <MetricCard label="Reportes Generados" value="1,450" trend="+12.5%" subValue="Últimos 30 días" />
        <MetricCard label="Exportaciones Exitosas" value="98.2%" subValue="Audit Ledger Health" />
        <MetricCard label="Programaciones" value="24" trend="Activos" subValue="Next run in 2h" />
        <MetricCard label="Almacenamiento Cloud" value="2.4 GB" subValue="Uso de repositorio" />
      </div>

      <div className="flex-1 flex flex-col xl:flex-row gap-8 min-h-0 overflow-hidden">
        {/* PANEL PRINCIPAL: TABLAS DE GESTION */}
        <div className="flex-1 space-y-8 min-w-0 overflow-y-auto custom-scrollbar pr-2">
            {/* TABLA HISTORIAL */}
            <Card className="bg-white/70 dark:bg-zinc-900/30 backdrop-blur-2xl border border-gray-200 dark:border-white/5 rounded-[2.5rem] shadow-2xl">
                <CardHeader className="p-8 pb-0 flex justify-between items-center">
                    <div className="flex items-center gap-3">
                        <History size={20} className="text-emerald-500" />
                        <h2 className="text-lg font-black text-gray-900 dark:text-white uppercase italic tracking-tighter">Historial de <span className="text-emerald-500">Archivos</span></h2>
                    </div>
                    <Button isIconOnly variant="flat" size="sm" className="rounded-xl"><Filter size={16} /></Button>
                </CardHeader>
                <CardBody className="p-4 md:p-8">
                    <div className="bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/5 rounded-2xl overflow-hidden flex flex-col shadow-sm transition-colors">
                        <div className="max-w-full overflow-x-auto custom-scrollbar">
                            <Table 
                                aria-label="Archived Reports" 
                                removeWrapper 
                                isCompact
                                classNames={{
                                    base: "w-full",
                                    wrapper: "bg-transparent shadow-none p-0 rounded-none",
                                    th: "bg-gray-50/80 dark:bg-zinc-950/80 backdrop-blur-md text-gray-400 dark:text-zinc-500 font-black uppercase text-[9px] tracking-widest h-10 py-1 border-b border-gray-200 dark:border-white/5 sticky top-0 z-10 px-4",
                                    td: "py-1.5 border-b border-gray-100 dark:border-white/5 px-4",
                                    tr: "hover:bg-emerald-500/5 transition-colors border-l-4 border-transparent hover:border-emerald-500 active:bg-emerald-500/10 cursor-default group h-10",
                                }}
                            >
                                <TableHeader>
                                    <TableColumn>NOMBRE DEL REPORTE</TableColumn>
                                    <TableColumn className="hidden sm:table-cell">FECHA</TableColumn>
                                    <TableColumn className="hidden md:table-cell">FORMATO</TableColumn>
                                    <TableColumn className="hidden md:table-cell">TAMAÑO</TableColumn>
                                    <TableColumn align="end">GESTIÓN</TableColumn>
                                </TableHeader>
                                <TableBody emptyContent="SIN REPORTES ARCHIVADOS">
                                    {ARCHIVED_REPORTS.map((r) => (
                                        <TableRow key={r.id}>
                                            <TableCell>
                                                <div className="flex items-center gap-3 py-1">
                                                    <div className="h-9 w-9 rounded-xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center border border-emerald-500/20 shadow-sm shrink-0">
                                                        <FileText size={18} />
                                                    </div>
                                                    <div className="flex flex-col min-w-0">
                                                        <span className="text-[10px] font-black text-gray-900 dark:text-white uppercase italic leading-tight break-all">
                                                            {BUSINESS_NAMES[r.name] || r.name}
                                                        </span>
                                                        <span className="text-[8px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-tight">
                                                            {r.name}
                                                        </span>
                                                    </div>
                                                </div>
                                            </TableCell>
                                            <TableCell className="hidden sm:table-cell">
                                                <span className="text-[10px] font-bold text-gray-500 uppercase tabular-nums">{r.date}</span>
                                            </TableCell>
                                            <TableCell className="hidden md:table-cell">
                                                <FormatChip format={r.format} />
                                            </TableCell>
                                            <TableCell className="hidden md:table-cell">
                                                <span className="text-[10px] font-bold text-gray-400 tabular-nums">{r.size}</span>
                                            </TableCell>
                                            <TableCell>
                                                <div className="flex items-center justify-end gap-1 px-1">
                                                    <Button 
                                                        isIconOnly 
                                                        size="sm" 
                                                        variant="flat" 
                                                        isLoading={downloadingIds[r.id]}
                                                        className="h-8 w-8 bg-emerald-500/5 text-emerald-500 rounded-lg hover:bg-emerald-500 hover:text-white transition-all shadow-sm"
                                                        onPress={() => handleArchiveDownload(r)}
                                                    >
                                                        {downloadingIds[r.id] ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                                                    </Button>
                                                    <Button 
                                                        isIconOnly 
                                                        size="sm" 
                                                        variant="flat" 
                                                        className="h-8 w-8 bg-rose-500/5 text-rose-500 rounded-lg hover:bg-rose-500 hover:text-white transition-all shadow-sm"
                                                    >
                                                        <Trash2 size={14} />
                                                    </Button>
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    </div>
                </CardBody>
            </Card>

            {/* TABLA PROGRAMADOS */}
            <Card className="bg-emerald-500/5 dark:bg-emerald-500/5 backdrop-blur-2xl border border-emerald-500/10 rounded-[2.5rem] shadow-xl">
                <CardHeader className="p-8 pb-0">
                    <div className="flex items-center gap-3">
                        <Clock size={20} className="text-emerald-500" />
                        <h2 className="text-sm sm:text-lg font-black text-gray-900 dark:text-white uppercase italic tracking-tighter text-emerald-500 flex flex-wrap gap-1">
                            <span>Automatizaciones</span> 
                            <span className="text-gray-900 dark:text-white opacity-40 sm:opacity-100">(Scheduled)</span>
                        </h2>
                    </div>
                </CardHeader>
                <CardBody className="p-4 md:p-8">
                    <div className="max-w-full overflow-x-auto custom-scrollbar">
                        <Table aria-label="Scheduled Reports" removeWrapper classNames={{
                            base: "w-full",
                            th: "bg-transparent text-emerald-500/30 font-black uppercase text-[9px] tracking-widest border-b border-emerald-500/10",
                            td: "py-4 text-sm font-black italic text-gray-900 dark:text-white border-b border-emerald-500/5"
                        }}>
                            <TableHeader>
                                <TableColumn>REPORTE</TableColumn>
                                <TableColumn className="hidden xs:table-cell">FRECUENCIA</TableColumn>
                                <TableColumn className="hidden sm:table-cell">PROX. ENVÍO</TableColumn>
                                <TableColumn className="hidden md:table-cell">DESTINATARIO</TableColumn>
                                <TableColumn align="end">ACCIONES</TableColumn>
                            </TableHeader>
                            <TableBody>
                                {SCHEDULED_REPORTS.map((s) => (
                                    <TableRow key={s.id}>
                                        <TableCell className="max-w-[120px] sm:max-w-none truncate sm:whitespace-normal font-black uppercase italic tracking-tighter">
                                            {s.name}
                                        </TableCell>
                                        <TableCell className="hidden xs:table-cell">
                                            <Chip size="sm" variant="dot" color="success" className="font-black text-[9px] uppercase tracking-tighter">{s.frequency}</Chip>
                                        </TableCell>
                                        <TableCell className="hidden sm:table-cell text-[10px] tabular-nums text-zinc-500 italic">{s.next}</TableCell>
                                        <TableCell className="hidden md:table-cell text-[10px] text-emerald-500 flex items-center gap-2 underline decoration-emerald-500/20"><Mail size={12} /> {s.recipient}</TableCell>
                                        <TableCell><Button isIconOnly variant="flat" size="sm" className="rounded-xl"><MoreHorizontal size={16} /></Button></TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                </CardBody>
            </Card>
        </div>

        {/* SIDEBAR TACTICA DERECHA */}
        <aside className="w-full xl:w-96 flex flex-col gap-6 shrink-0 pb-10 xl:pb-0 overflow-y-auto custom-scrollbar pr-2">
            {/* REPORT GENERATION PANEL (Sidebar Derecha) */}
            <Card className="bg-white/80 dark:bg-zinc-900/50 backdrop-blur-xl border border-gray-200 dark:border-white/5 text-gray-900 dark:text-white rounded-[2.5rem] shadow-2xl p-6 md:p-8 border-none transform xl:-rotate-2">
                <div className="flex flex-col gap-6">
                    <div className="space-y-1 text-center">
                        <h3 className="text-2xl font-black italic uppercase tracking-tighter">Acceso <span className="opacity-40">Rápido</span></h3>
                        <p className="text-[9px] font-bold uppercase tracking-[0.3em] opacity-50">Report Generation Panel</p>
                    </div>
                    
                    <div className="flex flex-col gap-4">
                        <div className="space-y-1">
                            <label className="text-[9px] font-black uppercase tracking-widest opacity-50 ml-1">Report Type</label>
                            <Tabs 
                                aria-label="Quick Report Type" 
                                color="success"
                                selectedKey={quickCategory}
                                onSelectionChange={(k) => setQuickCategory(String(k))}
                                classNames={{
                                    tabList: "bg-gray-100 dark:bg-zinc-950/50 p-1 rounded-xl w-full flex-wrap",
                                    cursor: "bg-emerald-500 rounded-lg",
                                    tab: "h-10",
                                    tabContent: "font-black text-[10px] uppercase italic tracking-widest group-data-[selected=true]:text-white dark:group-data-[selected=true]:text-white"
                                }}
                            >
                                <Tab key="box-closure" title="Caja" />
                                <Tab key="payments" title="Ventas" />
                                <Tab key="inventory" title="Stock" />
                            </Tabs>
                        </div>

                        <div className="space-y-1">
                            <label className="text-[9px] font-black uppercase tracking-widest opacity-50 ml-1">Date Range</label>
                            <Button 
                                onPress={() => setDateRangeOpen(true)}
                                className="w-full bg-gray-100 dark:bg-zinc-950/50 border border-gray-200 dark:border-white/5 h-12 rounded-2xl justify-between px-4 hover:border-emerald-500/50 transition-all font-black text-[10px] uppercase tracking-widest text-gray-900 dark:text-white"
                            >
                                <span>{dateFrom} - {dateTo}</span>
                                <Calendar size={14} className="text-emerald-500" />
                            </Button>
                        </div>

                        <div className="space-y-1">
                            <label className="text-[9px] font-black uppercase tracking-widest opacity-50 ml-1">Output Format</label>
                            <Tabs 
                                aria-label="Quick Output Format" 
                                selectedKey={quickFormat}
                                onSelectionChange={(k) => setQuickFormat(String(k))}
                                classNames={{
                                    tabList: "bg-gray-100 dark:bg-zinc-950/50 p-1 rounded-xl w-full flex-wrap",
                                    cursor: "bg-gray-200 dark:bg-gray-700 rounded-lg",
                                    tab: "h-10",
                                    tabContent: "font-black text-[10px] uppercase italic tracking-widest group-data-[selected=true]:text-black dark:group-data-[selected=true]:text-white"
                                }}
                            >
                                <Tab key="PDF" title="PDF" />
                                <Tab key="CSV" title="CSV" />
                            </Tabs>
                        </div>

                        <Button 
                            className="bg-emerald-500 text-white font-black uppercase tracking-widest italic rounded-2xl h-14 mt-2 shadow-xl shadow-emerald-500/20"
                            isLoading={!!loadingReport}
                            onPress={() => {
                                if (quickFormat !== 'PDF') {
                                    toast({ title: "EN DESARROLLO", description: "Formato CSV en desarrollo. Usando PDF.", variant: "default" });
                                }
                                handleDownload(quickCategory);
                            }}
                        >
                            Generate Report
                        </Button>
                    </div>

                    <Divider className="bg-white/10 dark:bg-black/10" />

                    <div className="space-y-4">
                        <span className="text-[9px] font-black uppercase tracking-widest opacity-50 block text-center">Quick Actions</span>
                        <div className="flex flex-col gap-2">
                             <Button variant="flat" className="bg-emerald-500/10 text-emerald-500 font-black uppercase tracking-widest text-[9px] h-10 w-full" onPress={() => setIsGenerateModalOpen(true)}>
                                Build Custom Template
                             </Button>
                             <Button variant="flat" className="bg-white/5 dark:bg-black/5 text-gray-400 font-black uppercase tracking-widest text-[9px] h-10 w-full">
                                Schedule Report
                             </Button>
                        </div>
                    </div>
                </div>
            </Card>

            {/* ADVISOR WIDGET */}
            <Card className="bg-emerald-500 text-white rounded-[2.5rem] p-4 md:p-8 shadow-xl shadow-emerald-500/20 overflow-hidden relative">
                <BarChart3 className="absolute -right-10 -bottom-10 w-40 h-40 opacity-20 transform rotate-12" />
                <div className="relative z-10 space-y-4">
                    <h4 className="text-xl font-black italic uppercase tracking-tighter leading-none">Smart <br/>Advisor</h4>
                    <p className="text-[10px] font-bold uppercase tracking-widest opacity-80 leading-relaxed">
                        Detectamos que el 80% de tus ventas coinciden con los jueves tarde. ¿Cifrar reporte de tendencias?
                    </p>
                    <Button fullWidth className="bg-white text-emerald-500 font-black uppercase text-[10px] tracking-widest rounded-xl hover:scale-105 transition-all shadow-xl">Analizar Ahora</Button>
                </div>
            </Card>
        </aside>
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
