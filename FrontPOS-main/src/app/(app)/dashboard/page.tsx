"use client"

import { useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis, ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from "recharts"
import { useToast } from "@/hooks/use-toast"
import { useApi } from "@/hooks/use-api"
import { formatCurrency } from "@/lib/utils"
import {
  DollarSign, Users, TrendingUp, TrendingDown,
  FileText, Download, Calendar, BarChart3,
  Sparkles, RefreshCw, Clock, AlertTriangle,
  Package, Tags, Wallet, ShoppingCart, AlertCircle,
  ChevronRight
} from "lucide-react"
import {
  Card, CardHeader, CardBody,
  Button,
  Skeleton,
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Input,
  Chip
} from "@heroui/react"
import jsPDF from "jspdf"
import autoTable from "jspdf-autotable"

// Augment jsPDF type to include lastAutoTable added by jspdf-autotable
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
  // V5 fields
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

// ============================================================
// PROGRESS RING COMPONENT
// ============================================================
function ProgressRing({ percentage, size = 80, strokeWidth = 8, color = "#10b981", label }: {
  percentage: number; size?: number; strokeWidth?: number; color?: string; label: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="transform -rotate-90">
          <circle cx={size / 2} cy={size / 2} r={radius} stroke="currentColor" strokeWidth={strokeWidth}
            fill="none" className="text-gray-200 dark:text-zinc-800" />
          <circle cx={size / 2} cy={size / 2} r={radius} stroke={color} strokeWidth={strokeWidth}
            fill="none" strokeDasharray={circumference} strokeDashoffset={offset}
            strokeLinecap="round" className="transition-all duration-1000 ease-out" />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-lg font-black text-gray-900 dark:text-white tabular-nums">{Math.round(percentage)}%</span>
        </div>
      </div>
      <span className="text-[9px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest text-center leading-tight">{label}</span>
    </div>
  );
}

// ============================================================
// KPI CARD COMPONENT (Themed Colors)
// ============================================================
function KpiCard({ label, value, sub, icon: Icon, colorClass, bgClass }: {
  label: string; value: string; sub: string; icon: any; colorClass: string; bgClass: string;
}) {
  return (
    <Card className="bg-white/90 dark:bg-zinc-900/50 backdrop-blur-xl border border-gray-200/80 dark:border-white/5 shadow-lg dark:shadow-2xl hover:shadow-xl dark:hover:shadow-emerald-500/5 transition-all duration-300 group hover:-translate-y-0.5" radius="lg">
      <CardBody className="p-5 flex flex-col justify-between gap-3">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest">{label}</p>
            <p className="text-2xl md:text-3xl font-black text-gray-900 dark:text-white mt-1 tracking-tighter tabular-nums truncate">{value}</p>
          </div>
          <div className={`p-3 rounded-2xl shadow-sm ${bgClass} ${colorClass} flex-shrink-0`}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
        <div className="flex items-center gap-1.5 border-t border-gray-100 dark:border-white/5 pt-3 mt-auto">
          <Clock className="h-3 w-3 text-gray-400 dark:text-zinc-600" />
          <p className="text-[10px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest">{sub}</p>
        </div>
      </CardBody>
    </Card>
  )
}

// ============================================================
// PAYMENT DONUT COLORS
// ============================================================
const PAYMENT_COLORS: Record<string, string> = {
  'EFECTIVO': '#10b981',
  'NEQUI': '#8b5cf6',
  'DAVIPLATA': '#f43f5e',
  'TRANSFERENCIA': '#f59e0b',
  'FIADO': '#ef4444',
};

const getPaymentColor = (method: string) => PAYMENT_COLORS[method] || '#6b7280';

// ============================================================
// MAIN DASHBOARD
// ============================================================
export default function DashboardPage() {
  const { data, isLoading, error, mutate } = useApi<DashboardData>('/dashboard/overview');
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [generatingPdf, setGeneratingPdf] = useState('');
  const { toast } = useToast();

  // ---- PDF REPORTS (kept from original) ----
  const handleDownloadReport = (type: string) => {
    setGeneratingPdf(type);
    try {
      const doc = new jsPDF();
      const timestamp = new Date().toLocaleString();

      doc.setFontSize(22);
      doc.setTextColor(16, 185, 129);
      doc.text("SISTEMA POS - REPORTE", 105, 20, { align: "center" });

      doc.setFontSize(10);
      doc.setTextColor(100);
      doc.text(`Generado por: Auditoría V5.0 | Fecha: ${timestamp}`, 105, 28, { align: "center" });

      doc.setDrawColor(200);
      doc.line(20, 35, 190, 35);

      if (type === 'monthly' && data) {
        doc.setFontSize(14);
        doc.setTextColor(0);
        doc.text("RESUMEN DE VENTAS POR MES", 20, 45);

        const tableData = Object.entries(data.monthly.salesByMonth).map(([month, sales]) => [
          month,
          `$${formatCurrency(sales)}`,
          `$${formatCurrency(data.monthly.expensesByMonth[month] || 0)}`,
          `$${formatCurrency(sales - (data.monthly.expensesByMonth[month] || 0))}`
        ]);

        autoTable(doc, {
          startY: 55,
          head: [['Mes', 'Ventas', 'Gastos', 'Utilidad']],
          body: tableData,
          theme: 'grid',
          headStyles: { fillColor: [16, 185, 129], textColor: 255, fontStyle: 'bold' }
        });
      } else if (type === 'profit' && data) {
        doc.setFontSize(14);
        doc.setTextColor(0);
        doc.text("BALANCE GENERAL DEL SISTEMA", 20, 45);

        autoTable(doc, {
          startY: 55,
          head: [['Indicador', 'Valor Actual']],
          body: [
            ['Ingresos Totales', `$${formatCurrency(data.totalSalesAmount)}`],
            ['Gastos Operativos', `$${formatCurrency(data.totalExpensesAmount)}`],
            ['Margen de Utilidad', `$${formatCurrency(data.profit)}`],
            ['Productos Vendidos', data.totalProductsSold.toString()],
          ],
          theme: 'striped',
          headStyles: { fillColor: [5, 150, 105], textColor: 255 }
        });

        doc.setFontSize(10);
        doc.text("Este reporte representa el estado financiero consolidado del periodo actual.", 20, doc.lastAutoTable.finalY + 10);
      } else if (type === 'client' && data) {
        doc.setFontSize(14);
        doc.setTextColor(0);
        doc.text("ANÁLISIS DE CLIENTES Y MOVIMIENTOS", 20, 45);

        doc.setFontSize(10);
        doc.text(`Total de Clientes Registrados: ${data.totalClients}`, 20, 52);

        if (data.recentSales) {
          const tableData = data.recentSales.map(s => [
            s.client,
            new Date(s.date).toLocaleDateString(),
            `$${formatCurrency(s.total)}`
          ]);

          autoTable(doc, {
            startY: 60,
            head: [['Cliente', 'Último Movimiento', 'Monto']],
            body: tableData,
            theme: 'grid',
            headStyles: { fillColor: [59, 130, 246], textColor: 255 }
          });
        }
      } else if (type === 'range') {
        doc.setFontSize(14);
        doc.setTextColor(0);
        doc.text(`REPORTE DE RANGO: ${dateFrom} - ${dateTo}`, 20, 45);
        doc.setFontSize(10);
        doc.text("Este reporte contiene los datos filtrados por el rango seleccionado.", 20, 52);

        if (data?.recentSales) {
          const tableData = data.recentSales.map(s => [
            new Date(s.date).toLocaleDateString(),
            s.client,
            s.payment_method || 'EFECTIVO',
            `$${formatCurrency(s.total)}`
          ]);

          autoTable(doc, {
            startY: 60,
            head: [['Fecha', 'Cliente', 'Método', 'Total']],
            body: tableData,
            theme: 'striped',
            headStyles: { fillColor: [79, 70, 229], textColor: 255 }
          });
        }
      } else {
        doc.setFontSize(14);
        doc.text("REPORTE DE AUDITORÍA", 20, 45);
        doc.setFontSize(10);
        doc.text("Generando reporte base con datos consolidados...", 20, 55);
      }

      doc.save(`reporte-${type}-${new Date().getTime()}.pdf`);
      toast({ title: "Reporte Generado", description: "El documento se ha descargado exitosamente." });
    } catch (err) {
      console.error(err);
      toast({ title: "Error", description: "No se pudo generar el PDF.", variant: "destructive" });
    } finally {
      setGeneratingPdf('');
    }
  };

  const handleDateRangeReport = () => {
    setDateRangeOpen(false);
    handleDownloadReport('range');
  };

  // ---- Chart Data ----
  const dailyChartData = data?.dailySalesLast7?.map((d) => ({
    day: new Date(d.date + 'T12:00:00').toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric' }).toUpperCase(),
    ventas: d.amount,
  })) || [];

  const paymentDonutData = data?.salesByPayment
    ? Object.entries(data.salesByPayment).map(([method, amount]) => ({
      name: method,
      value: amount,
      color: getPaymentColor(method),
    }))
    : [];

  const totalPayments = paymentDonutData.reduce((s, d) => s + d.value, 0);

  // Stock health percentage
  const stockHealth = data ? (data.totalProducts > 0 ? (data.activeProducts / data.totalProducts) * 100 : 0) : 0;
  const stockHealthColor = stockHealth >= 80 ? '#10b981' : stockHealth >= 50 ? '#f59e0b' : '#ef4444';

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6 w-full max-w-7xl mx-auto h-full overflow-y-auto custom-scrollbar transition-colors pb-32">

      {/* ========== HEADER ========== */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-2 p-6 bg-white dark:bg-zinc-900/40 backdrop-blur-xl border border-gray-200 dark:border-white/5 rounded-3xl shadow-sm transition-colors">
        <div className="flex items-center gap-4">
          <div>
            <Chip startContent={<Sparkles size={12} />} variant="flat" className="bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 font-bold tracking-widest uppercase text-[9px] mb-3 px-2 border-none">
            Dashboard V5.0
          </Chip>
          <h1 className="text-3xl md:text-4xl font-black text-gray-900 dark:text-white tracking-tighter uppercase">
            Resumen <span className="text-emerald-600 dark:text-emerald-500">Ejecutivo</span>
          </h1>
          <p className="text-[10px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest mt-1">Estado actual de tu negocio</p>
        </div>
      </div>
        <Button
          variant="flat"
          size="md"
          startContent={<RefreshCw size={16} />}
          onPress={() => mutate()}
          className="bg-gray-100 dark:bg-white/5 text-gray-700 dark:text-white font-bold uppercase tracking-widest text-[10px] rounded-xl hover:bg-emerald-500 hover:text-white dark:hover:bg-emerald-500 dark:hover:text-black transition-all shadow-sm h-12 px-6"
        >
          Sincronizar
        </Button>
      </div>

      {/* ========== LOADING / ERROR / CONTENT ========== */}
      {isLoading ? (
        <div className="grid gap-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Card key={i} className="bg-white/50 dark:bg-zinc-950/50 border-gray-200 dark:border-white/5 h-36 shadow-sm" radius="lg">
              <CardBody className="p-5"><Skeleton className="h-full w-full rounded-xl bg-gray-100 dark:bg-zinc-900/50" /></CardBody>
            </Card>
          ))}
        </div>
      ) : !data || error ? (
        <div className="py-12 flex flex-col items-center justify-center gap-6 animate-in fade-in zoom-in duration-500 bg-white/40 dark:bg-zinc-900/20 backdrop-blur-md rounded-[2.5rem] border border-gray-200 dark:border-white/5 shadow-xl">
          <div className="p-8 rounded-full bg-rose-50 dark:bg-rose-500/10 border border-rose-100 dark:border-rose-500/20 shadow-xl dark:shadow-rose-500/5">
            <AlertTriangle className="h-16 w-16 text-rose-500 animate-pulse" />
          </div>
          <div className="text-center space-y-3 max-w-md px-6">
            <h3 className="text-3xl font-black text-gray-900 dark:text-white tracking-tight">Análisis No Disponible</h3>
            <p className="text-sm font-medium text-gray-500 dark:text-zinc-400">
              {error?.message || "Hubo un problema al conectar con el núcleo de datos del POS."}
            </p>
          </div>
          <Button
            className="mt-4 h-14 px-8 bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase tracking-widest rounded-2xl shadow-xl hover:scale-105 transition-transform"
            startContent={<RefreshCw className="h-5 w-5" />}
            onPress={() => mutate()}
          >
            Reintentar Sincronización
          </Button>
        </div>
      ) : (
        <>
          {/* ========== KPI HERO CARDS (6 cards) ========== */}
          <div className="grid gap-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
            <KpiCard
              label="Ventas del Día"
              value={`$${formatCurrency(data.todaySalesAmount)}`}
              sub={`${data.todaySalesCount} transacciones`}
              icon={ShoppingCart}
              colorClass="text-emerald-600 dark:text-emerald-500"
              bgClass="bg-emerald-100 dark:bg-emerald-500/10"
            />
            <KpiCard
              label="Productos Activos"
              value={`${data.activeProducts}`}
              sub={`${data.totalProducts} total`}
              icon={Package}
              colorClass="text-amber-600 dark:text-amber-500"
              bgClass="bg-amber-100 dark:bg-amber-500/10"
            />
            <KpiCard
              label="Clientes"
              value={`${data.totalClients}`}
              sub="Registrados"
              icon={Users}
              colorClass="text-sky-600 dark:text-sky-500"
              bgClass="bg-sky-100 dark:bg-sky-500/10"
            />
            <KpiCard
              label="Categorías"
              value={`${data.categoriesCount}`}
              sub="Activas"
              icon={Tags}
              colorClass="text-violet-600 dark:text-violet-500"
              bgClass="bg-violet-100 dark:bg-violet-500/10"
            />
            <KpiCard
              label="Utilidad Mes"
              value={`$${formatCurrency(data.profit)}`}
              sub={`${data.totalProductsSold} Unidades`}
              icon={TrendingUp}
              colorClass={data.profit >= 0 ? "text-emerald-600 dark:text-emerald-500" : "text-rose-600 dark:text-rose-500"}
              bgClass={data.profit >= 0 ? "bg-emerald-100 dark:bg-emerald-500/10" : "bg-rose-100 dark:bg-rose-500/10"}
            />
            <KpiCard
              label="Gastos del Mes"
              value={`$${formatCurrency(data.totalExpensesAmount)}`}
              sub="Egresos operativos"
              icon={Wallet}
              colorClass="text-rose-600 dark:text-rose-500"
              bgClass="bg-rose-100 dark:bg-rose-500/10"
            />
          </div>

          {/* ========== MAIN CONTENT GRID (Chart + Donut + Progress) ========== */}
          <div className="grid gap-6 grid-cols-1 lg:grid-cols-7">

            {/* --- Tendencia Ventas 7 Días --- */}
            <Card className="col-span-1 lg:col-span-4 bg-white/90 dark:bg-zinc-900/50 backdrop-blur-xl border border-gray-200/80 dark:border-white/5 shadow-lg dark:shadow-2xl transition-colors" radius="lg">
              <CardHeader className="px-6 pt-6 pb-2">
                <div className="flex items-center gap-3">
                  <div className="bg-emerald-100 dark:bg-emerald-500/10 p-2.5 rounded-xl text-emerald-600 dark:text-emerald-500 border border-emerald-200 dark:border-emerald-500/20 shadow-sm"><BarChart3 size={18} /></div>
                  <div>
                    <h2 className="text-base font-black text-gray-900 dark:text-white uppercase tracking-tight">Tendencia de Ventas</h2>
                    <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest">Últimos 7 días</p>
                  </div>
                </div>
              </CardHeader>
              <CardBody className="px-4 pb-4 pt-0 overflow-hidden">
                <div className="h-[260px] w-full mt-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={dailyChartData} margin={{ left: -20, right: 10, top: 10 }}>
                      <defs>
                        <linearGradient id="fillVentas" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="currentColor" className="text-gray-200 dark:text-white/5" />
                      <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fontSize: 10, fontWeight: 700, fill: '#71717a' }} dy={10} />
                      <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 700, fill: '#71717a' }} dx={-10} />
                      <Tooltip
                        contentStyle={{ background: 'rgba(0,0,0,0.85)', border: 'none', borderRadius: '12px', padding: '10px 14px', fontSize: 12 }}
                        labelStyle={{ color: '#a1a1aa', fontWeight: 700, textTransform: 'uppercase', fontSize: 10 }}
                        formatter={(value: number) => [`$${formatCurrency(value)}`, 'Ventas']}
                      />
                      <Area type="monotone" dataKey="ventas" stroke="#10b981" strokeWidth={3} fill="url(#fillVentas)" dot={{ fill: '#10b981', r: 4, strokeWidth: 2, stroke: '#fff' }} activeDot={{ r: 6, stroke: '#10b981', strokeWidth: 2 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardBody>
            </Card>

            {/* --- Donut Métodos de Pago + Progress Rings --- */}
            <Card className="col-span-1 lg:col-span-3 bg-white/90 dark:bg-zinc-900/50 backdrop-blur-xl border border-gray-200/80 dark:border-white/5 shadow-lg dark:shadow-2xl transition-colors" radius="lg">
              <CardHeader className="px-6 pt-6 pb-2">
                <div className="flex items-center gap-3">
                  <div className="bg-violet-100 dark:bg-violet-500/10 p-2.5 rounded-xl text-violet-600 dark:text-violet-500 border border-violet-200 dark:border-violet-500/20 shadow-sm"><DollarSign size={18} /></div>
                  <div>
                    <h2 className="text-base font-black text-gray-900 dark:text-white uppercase tracking-tight">Métodos de Pago</h2>
                    <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest">Distribución del mes</p>
                  </div>
                </div>
              </CardHeader>
              <CardBody className="px-6 pb-6 pt-0">
                {paymentDonutData.length > 0 ? (
                  <div className="flex flex-col items-center gap-4 mt-2">
                    <div className="relative h-[160px] w-[160px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={paymentDonutData}
                            cx="50%" cy="50%"
                            innerRadius={50} outerRadius={72}
                            paddingAngle={3}
                            dataKey="value"
                            stroke="none"
                          >
                            {paymentDonutData.map((entry, idx) => (
                              <Cell key={idx} fill={entry.color} />
                            ))}
                          </Pie>
                          <Tooltip
                            contentStyle={{ background: 'rgba(0,0,0,0.85)', border: 'none', borderRadius: '12px', padding: '8px 12px', fontSize: 11 }}
                            formatter={(value: number) => [`$${formatCurrency(value)}`, '']}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="absolute inset-0 flex flex-col items-center justify-center">
                        <span className="text-lg font-black text-gray-900 dark:text-white tabular-nums tracking-tighter">${formatCurrency(totalPayments)}</span>
                        <span className="text-[8px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest">Total</span>
                      </div>
                    </div>

                    {/* Legend */}
                    <div className="flex flex-wrap gap-x-4 gap-y-1.5 justify-center">
                      {paymentDonutData.map((d) => (
                        <div key={d.name} className="flex items-center gap-1.5">
                          <div className="w-2.5 h-2.5 rounded-full" style={{ background: d.color }} />
                          <span className="text-[9px] font-bold text-gray-600 dark:text-zinc-400 uppercase tracking-wider">{d.name}</span>
                        </div>
                      ))}
                    </div>

                    {/* Progress Ring - Stock Health */}
                    <div className="border-t border-gray-100 dark:border-white/5 pt-4 w-full flex justify-center">
                      <ProgressRing percentage={stockHealth} color={stockHealthColor} label="Salud del Inventario" />
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-40 gap-2">
                    <DollarSign className="h-8 w-8 text-gray-300 dark:text-zinc-700" />
                    <p className="text-[10px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest">Sin datos de pago</p>
                  </div>
                )}
              </CardBody>
            </Card>
          </div>

          {/* ========== ALERTAS STOCK BAJO ========== */}
          {data.lowStockProducts && data.lowStockProducts.length > 0 && (
            <Card className="bg-white/90 dark:bg-zinc-900/50 backdrop-blur-xl border border-gray-200/80 dark:border-white/5 shadow-lg dark:shadow-2xl transition-colors" radius="lg">
              <CardHeader className="px-6 pt-6 pb-3">
                <div className="flex items-center gap-3">
                  <div className="bg-rose-100 dark:bg-rose-500/10 p-2.5 rounded-xl text-rose-600 dark:text-rose-500 border border-rose-200 dark:border-rose-500/20 shadow-sm animate-pulse"><AlertCircle size={18} /></div>
                  <div>
                    <h2 className="text-base font-black text-gray-900 dark:text-white uppercase tracking-tight">Alertas de Stock Bajo</h2>
                    <p className="text-[10px] font-bold text-rose-500 dark:text-rose-400 uppercase tracking-widest">{data.lowStockProducts.length} producto{data.lowStockProducts.length !== 1 ? 's' : ''} requieren atención</p>
                  </div>
                </div>
              </CardHeader>
              <CardBody className="px-6 pb-6 pt-0">
                <div className="overflow-auto custom-scrollbar">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-gray-50 dark:bg-zinc-900/80 text-[10px] font-black uppercase tracking-widest text-gray-500 dark:text-zinc-400">
                      <tr>
                        <th className="px-4 py-3 rounded-l-xl">Producto</th>
                        <th className="px-4 py-3 text-center">Stock Actual</th>
                        <th className="px-4 py-3 text-center">Stock Mínimo</th>
                        <th className="px-4 py-3 text-center rounded-r-xl">Estado</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-white/5">
                      {data.lowStockProducts.map((item) => (
                        <tr key={item.barcode} className="hover:bg-gray-50/80 dark:hover:bg-white/[0.02] transition-colors">
                          <td className="px-4 py-3">
                            <p className="font-bold text-gray-900 dark:text-white uppercase tracking-tight text-xs truncate max-w-[200px]">{item.name}</p>
                            <span className="text-[9px] font-bold text-gray-400 dark:text-zinc-500 tracking-widest">{item.barcode}</span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className={`text-sm font-black tabular-nums ${item.stock <= 0 ? 'text-rose-500' : 'text-amber-500'}`}>{item.stock}</span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className="text-sm font-bold text-gray-500 dark:text-zinc-400 tabular-nums">{item.minStock}</span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <Chip size="sm" variant="flat"
                              className={item.stock <= 0
                                ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400'
                                : 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400'}
                              classNames={{ content: "text-[9px] font-black uppercase tracking-widest" }}
                            >
                              {item.stock <= 0 ? 'AGOTADO' : 'BAJO'}
                            </Chip>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardBody>
            </Card>
          )}

          {/* ========== ÚLTIMOS MOVIMIENTOS ========== */}
          <Card className="bg-white/90 dark:bg-zinc-900/50 backdrop-blur-xl border border-gray-200/80 dark:border-white/5 shadow-lg dark:shadow-2xl transition-colors" radius="lg">
            <CardHeader className="px-6 py-5 border-b border-gray-100 dark:border-white/5 flex justify-between items-center bg-gray-50/50 dark:bg-transparent">
              <div className="flex items-center gap-3">
                <div className="bg-sky-100 dark:bg-sky-500/10 p-2.5 rounded-xl text-sky-600 dark:text-sky-500 border border-sky-200 dark:border-sky-500/20 shadow-sm"><Clock size={18} /></div>
                <div>
                  <h2 className="text-base font-black text-gray-900 dark:text-white uppercase tracking-tight">Últimos Movimientos</h2>
                  <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest">Actividad en tiempo real</p>
                </div>
              </div>
            </CardHeader>
            <CardBody className="p-0 overflow-auto max-h-[320px] custom-scrollbar">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 dark:bg-zinc-900/80 text-[10px] font-black uppercase tracking-widest text-gray-500 dark:text-zinc-400 sticky top-0 z-10 backdrop-blur-md">
                  <tr>
                    <th className="px-6 py-3 border-b border-gray-200 dark:border-white/5">Cliente</th>
                    <th className="px-4 py-3 border-b border-gray-200 dark:border-white/5 text-center">Método</th>
                    <th className="px-6 py-3 border-b border-gray-200 dark:border-white/5 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-white/5">
                  {data?.recentSales?.map((sale) => {
                    const method = sale.transfer_source || sale.payment_method || 'EFECTIVO';
                    const chipColor = method === 'EFECTIVO' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400'
                      : method === 'NEQUI' ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-400'
                      : method === 'DAVIPLATA' ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400'
                      : 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-zinc-300';
                    return (
                      <tr key={sale.id} className="hover:bg-gray-50 dark:hover:bg-white/[0.02] transition-colors group">
                        <td className="px-6 py-3">
                          <p className="font-bold text-gray-900 dark:text-white uppercase tracking-tight truncate max-w-[140px] group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors text-xs">{sale.client}</p>
                          <span className="text-[9px] font-bold text-gray-400 dark:text-zinc-500 tracking-widest">{new Date(sale.date).toLocaleDateString()}</span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <Chip size="sm" variant="flat" className={chipColor} classNames={{ content: "text-[9px] font-black uppercase tracking-widest" }}>
                            {method}
                          </Chip>
                        </td>
                        <td className="px-6 py-3 text-right font-black text-gray-900 dark:text-white tabular-nums tracking-tighter text-sm">
                          ${formatCurrency(sale.total)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardBody>
          </Card>
        </>
      )}

      {/* ========== ZONA DE REPORTES (FONDO) ========== */}
      <div className="bg-white dark:bg-zinc-950 border-2 border-emerald-500/20 rounded-[2rem] p-6 shadow-lg animate-in fade-in slide-in-from-bottom-4 duration-700">
        <div className="flex items-center gap-4 mb-5">
          <div className="p-3 rounded-2xl bg-emerald-500 text-white shadow-lg shadow-emerald-500/20">
            <FileText size={22} />
          </div>
          <div>
            <h2 className="text-lg font-black text-gray-900 dark:text-white uppercase tracking-tighter">Zona de Reportes</h2>
            <p className="text-[10px] font-black text-emerald-600 dark:text-emerald-500 uppercase tracking-[0.2em]">Auditoría de Documentos PDF</p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { key: 'monthly', label: 'Ventas del Mes', desc: 'Ingresos generales', icon: Download },
            { key: 'client', label: 'Mapa de Clientes', desc: 'Análisis por cliente', icon: Users },
            { key: 'profit', label: 'Balance General', desc: 'Ventas vs Gastos', icon: BarChart3 },
            { key: 'range', label: 'Filtro Temporal', desc: 'Fechas específicas', icon: Calendar },
          ].map((btn) => (
            <button
              key={btn.key}
              onClick={btn.key === 'range' ? () => setDateRangeOpen(true) : () => handleDownloadReport(btn.key)}
              disabled={generatingPdf !== ''}
              className={`flex items-center justify-between p-4 rounded-2xl border-2 transition-all duration-300 text-left group
                ${generatingPdf === btn.key
                  ? 'bg-gray-100 dark:bg-zinc-900 border-gray-200 opacity-50 cursor-wait'
                  : 'bg-gray-50 hover:bg-emerald-500 dark:bg-zinc-900 dark:hover:bg-emerald-500 border-gray-200 dark:border-white/5 hover:border-emerald-500 dark:hover:border-emerald-500 shadow-sm hover:shadow-emerald-500/20'
                }`}
            >
              <div className="flex flex-col gap-0.5">
                <span className={`text-[11px] font-black uppercase tracking-tight transition-colors ${generatingPdf === btn.key ? 'text-gray-400' : 'text-gray-900 dark:text-white group-hover:text-white dark:group-hover:text-black'}`}>
                  {btn.label}
                </span>
                <span className={`text-[9px] font-bold uppercase tracking-widest transition-colors ${generatingPdf === btn.key ? 'text-gray-400' : 'text-gray-500 dark:text-zinc-500 group-hover:text-emerald-100 dark:group-hover:text-black/60'}`}>
                  {btn.desc}
                </span>
              </div>
              {generatingPdf === btn.key ? (
                <RefreshCw size={16} className="animate-spin text-emerald-500" />
              ) : (
                <btn.icon size={16} className="text-gray-400 dark:text-zinc-600 group-hover:text-white dark:group-hover:text-black transition-colors" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ========== MODAL RANGO FECHAS ========== */}
      <Modal
        isOpen={dateRangeOpen}
        onOpenChange={setDateRangeOpen}
        backdrop="blur"
        placement="center"
        classNames={{ base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-2xl rounded-[2.5rem]", closeButton: "text-gray-900 dark:text-white" }}
      >
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex flex-col gap-1 border-b border-gray-100 dark:border-white/5 p-8">
                <div className="flex items-center gap-4">
                  <div className="bg-emerald-100 dark:bg-emerald-500/10 p-3 rounded-[1rem] text-emerald-600 dark:text-emerald-500 border border-emerald-200 dark:border-emerald-500/20"><Calendar size={24} /></div>
                  <div>
                    <h2 className="text-2xl font-black text-gray-900 dark:text-white uppercase tracking-tight">Filtro Temporal</h2>
                    <p className="text-xs font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest mt-1">Genera reportes para un periodo específico</p>
                  </div>
                </div>
              </ModalHeader>
              <ModalBody className="p-8">
                <div className="space-y-6">
                  <Input
                    type="date"
                    label="Fecha Inicial"
                    labelPlacement="outside"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    variant="faded"
                    classNames={{
                      label: "text-[10px] font-black uppercase tracking-widest text-gray-500 dark:text-zinc-500",
                      inputWrapper: "bg-gray-50 dark:bg-zinc-900 border-gray-200 dark:border-white/10 h-14 rounded-2xl focus-within:border-emerald-500",
                      input: "text-gray-900 dark:text-white font-bold"
                    }}
                  />
                  <Input
                    type="date"
                    label="Fecha Final"
                    labelPlacement="outside"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    variant="faded"
                    classNames={{
                      label: "text-[10px] font-black uppercase tracking-widest text-gray-500 dark:text-zinc-500",
                      inputWrapper: "bg-gray-50 dark:bg-zinc-900 border-gray-200 dark:border-white/10 h-14 rounded-2xl focus-within:border-emerald-500",
                      input: "text-gray-900 dark:text-white font-bold"
                    }}
                  />
                </div>
              </ModalBody>
              <ModalFooter className="border-t border-gray-100 dark:border-white/5 p-6 bg-gray-50 dark:bg-transparent rounded-b-[2.5rem]">
                <Button color="danger" variant="light" onPress={onClose} className="font-bold uppercase tracking-widest text-xs px-6">
                  CANCELAR
                </Button>
                <Button color="primary" onPress={() => handleDateRangeReport()} className="bg-emerald-500 text-white dark:text-black font-black uppercase tracking-widest text-xs px-8 h-12 rounded-xl shadow-lg shadow-emerald-500/20">
                  Generar Reporte
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

    </div>
  )
}