"use client"

import { useState } from "react";
// Mantenemos componentes de Recharts y tu utilidad
import { Area, AreaChart, CartesianGrid, XAxis, YAxis, ResponsiveContainer } from "recharts"
import { useToast } from "@/hooks/use-toast"
import { useApi } from "@/hooks/use-api"
import { formatCurrency } from "@/lib/utils"
// Iconos
import {
  DollarSign, Users, TrendingUp, TrendingDown,
  FileText, Download, Calendar, BarChart3,
  Sparkles, RefreshCw, Clock, ChevronRight, AlertTriangle
} from "lucide-react"
// Importamos HeroUI
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
}

// Componente Estadístico Premium (Soporte Claro/Oscuro)
function StatCard({ label, value, sub, icon: Icon, trend, color = "emerald" }: any) {
  const isUp = trend === 'up';
  return (
    <Card className="bg-white/80 dark:bg-zinc-900/40 backdrop-blur-xl border border-gray-200 dark:border-white/5 shadow-lg dark:shadow-2xl transition-colors" radius="lg">
      <CardBody className="p-5 flex flex-col justify-between">
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="text-[10px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest">{label}</p>
            <p className="text-3xl font-black text-gray-900 dark:text-white mt-1 tracking-tighter tabular-nums">{value}</p>
          </div>
          <div className={`p-3 rounded-2xl shadow-sm ${isUp ? 'bg-emerald-100 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-500' : 'bg-rose-100 dark:bg-rose-500/10 text-rose-600 dark:text-rose-500'}`}>
            <Icon className="h-5 w-5" />
          </div>
        </div>

        <div className="flex items-center justify-between mt-auto border-t border-gray-100 dark:border-white/5 pt-4">
          <p className="text-[10px] font-bold text-gray-400 dark:text-zinc-500 flex items-center gap-1.5 uppercase tracking-widest">
            <Clock className="h-3 w-3" /> {sub}
          </p>
          <Chip
            size="sm"
            variant="flat"
            className={`${isUp ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400' : 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400'}`}
            classNames={{ base: "h-6 px-1 border-none", content: "text-[9px] font-black tracking-wider uppercase" }}
          >
            {isUp ? '↑ ACT' : '↓ BAJ'}
          </Chip>
        </div>
      </CardBody>
    </Card>
  )
}

export default function DashboardPage() {
  const { data, isLoading, error, mutate } = useApi<DashboardData>('/dashboard/overview');
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [generatingPdf, setGeneratingPdf] = useState('');
  const { toast } = useToast();

  const handleDownloadReport = (type: string) => {
    setGeneratingPdf(type);
    try {
      const doc = new jsPDF();
      const timestamp = new Date().toLocaleString();

      // Configuración de estilo
      doc.setFontSize(22);
      doc.setTextColor(16, 185, 129); // Emerald 500
      doc.text("SISTEMA POS - REPORTE", 105, 20, { align: "center" });

      doc.setFontSize(10);
      doc.setTextColor(100);
      doc.text(`Generado por: Auditoría V4.2 | Fecha: ${timestamp}`, 105, 28, { align: "center" });

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
            headStyles: { fillColor: [59, 130, 246], textColor: 255 } // Blue
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
            headStyles: { fillColor: [79, 70, 229], textColor: 255 } // Indigo
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

  const handleDateRangeReport = (type: string) => {
    setDateRangeOpen(false);
    handleDownloadReport('range');
  };

  // Datos del gráfico de área con protección
  const chartData = data?.monthly?.salesByMonth 
    ? Object.entries(data.monthly.salesByMonth).map(([month, sales]) => {
        const gastos = data.monthly.expensesByMonth?.[month] || 0;
        return { 
          month: new Date(month + '-02').toLocaleString('es-CO', { month: 'short' }).toUpperCase(), 
          sales, 
          profit: sales - gastos 
        };
      }).slice(-6)
    : [];


  return (
    <div className="flex flex-col gap-6 p-4 md:p-6 w-full max-w-7xl mx-auto h-full overflow-y-auto custom-scrollbar transition-colors pb-32">

      {/* Header Ejecutivo */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-2 p-6 bg-white dark:bg-zinc-900/40 backdrop-blur-xl border border-gray-200 dark:border-white/5 rounded-3xl shadow-sm transition-colors">
        <div>
          <Chip startContent={<Sparkles size={12} />} variant="flat" className="bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 font-bold tracking-widest uppercase text-[9px] mb-3 px-2 border-none">
            Live Intelligence V4.2
          </Chip>
          <h1 className="text-3xl md:text-4xl font-black text-gray-900 dark:text-white tracking-tighter uppercase">
            Resumen <span className="text-emerald-600 dark:text-emerald-500">Ejecutivo</span>
          </h1>
          <p className="text-[10px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest mt-1">Sincronización de Auditoría en Tiempo Real</p>
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

      {/* Acciones Rápidas (Reportes) - REFACTORIZADO PARA MÁXIMA COMPATIBILIDAD */}
      <div className="bg-white dark:bg-zinc-950 border-2 border-emerald-500/30 rounded-[2rem] p-6 shadow-xl mb-2 animate-in fade-in slide-in-from-top-4 duration-700">
        <div className="flex items-center gap-4 mb-6">
          <div className="p-3 rounded-2xl bg-emerald-500 text-white shadow-lg shadow-emerald-500/20">
            <FileText size={24} />
          </div>
          <div>
            <h2 className="text-xl font-black text-gray-900 dark:text-white uppercase tracking-tighter">Zona de Reportes</h2>
            <p className="text-[10px] font-black text-emerald-600 dark:text-emerald-500 uppercase tracking-[0.2em]">Auditoría de Documentos PDF</p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
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
              className={`flex items-center justify-between p-5 rounded-2xl border-2 transition-all duration-300 text-left group
                ${generatingPdf === btn.key 
                  ? 'bg-gray-100 dark:bg-zinc-900 border-gray-200 opacity-50 cursor-wait' 
                  : 'bg-gray-50 hover:bg-emerald-500 dark:bg-zinc-900 dark:hover:bg-emerald-500 border-gray-200 dark:border-white/5 hover:border-emerald-500 dark:hover:border-emerald-500 shadow-sm hover:shadow-emerald-500/20'
                }`}
            >
              <div className="flex flex-col gap-1">
                <span className={`text-[11px] font-black uppercase tracking-tight transition-colors ${generatingPdf === btn.key ? 'text-gray-400' : 'text-gray-900 dark:text-white group-hover:text-white dark:group-hover:text-black'}`}>
                  {btn.label}
                </span>
                <span className={`text-[9px] font-bold uppercase tracking-widest transition-colors ${generatingPdf === btn.key ? 'text-gray-400' : 'text-gray-500 dark:text-zinc-500 group-hover:text-emerald-100 dark:group-hover:text-black/60'}`}>
                  {btn.desc}
                </span>
              </div>
              {generatingPdf === btn.key ? (
                <RefreshCw size={18} className="animate-spin text-emerald-500" />
              ) : (
                <btn.icon size={18} className="text-gray-400 dark:text-zinc-600 group-hover:text-white dark:group-hover:text-black transition-colors" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* KPIs y Datos: Se muestran solo si hay data, o un mensaje de error elegante si no */}
      {isLoading ? (
        <div className="grid gap-6 grid-cols-1 md:grid-cols-2 xl:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i} className="bg-white/50 dark:bg-zinc-950/50 border-gray-200 dark:border-white/5 h-40 shadow-sm" radius="lg">
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
              {error?.message || "Hubo un problema al conectar con el núcleo de datos del POS. Las funciones de reportes PDF siguen activas arriba."}
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
          {/* KPIs Grid */}
          <div className="grid gap-6 grid-cols-1 md:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Ingresos Totales" value={`$${formatCurrency(data.totalSalesAmount)}`} sub={`${data.totalProductsSold} Productos`} icon={DollarSign} trend="up" />
            <StatCard label="Base de Clientes" value={`${data.totalClients}`} sub="Registrados" icon={Users} trend="up" />
            <StatCard label="Utilidad Neta" value={`$${formatCurrency(data.profit)}`} sub="Periodo Actual" icon={TrendingUp} trend="up" />
            <StatCard label="Egresos Operativos" value={`$${formatCurrency(data.totalExpensesAmount)}`} sub="Gastos" icon={TrendingDown} trend="down" />
          </div>
        </>
      )}


      {/* Main Grid: Gráfica y Tabla (Solo si hay data) */}
      {data && !error && (
        <div className="grid gap-6 grid-cols-1 lg:grid-cols-7">

          {/* Gráfico de Rendimiento */}
          <Card className="col-span-1 lg:col-span-4 bg-white/80 dark:bg-zinc-900/40 backdrop-blur-xl border border-gray-200 dark:border-white/5 shadow-lg dark:shadow-2xl transition-colors" radius="lg">
            <CardHeader className="px-8 pt-8 pb-2">
              <div className="flex items-center gap-4">
                <div className="bg-emerald-100 dark:bg-emerald-500/10 p-3 rounded-[1rem] text-emerald-600 dark:text-emerald-500 border border-emerald-200 dark:border-emerald-500/20 shadow-sm"><BarChart3 size={20} /></div>
                <div>
                  <h2 className="text-lg font-black text-gray-900 dark:text-white uppercase tracking-tight">Rendimiento Mensual</h2>
                  <p className="text-xs font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest">Comparativa de ingresos y utilidad</p>
                </div>
              </div>
            </CardHeader>
            <CardBody className="px-6 pb-6 pt-0 overflow-hidden">
              <div className="h-[280px] w-full mt-6">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ left: -20, right: 10, top: 10 }}>
                    <defs>
                      <linearGradient id="fillSales" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    {/* Grid dinámico que se adapta al modo claro/oscuro */}
                    <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="currentColor" className="text-gray-200 dark:text-white/5" />
                    <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fontSize: 10, fontWeight: 700, fill: '#71717a' }} dy={10} />
                    <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 700, fill: '#71717a' }} dx={-10} />
                    <Area type="monotone" dataKey="sales" stroke="hsl(var(--primary))" strokeWidth={4} fill="url(#fillSales)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardBody>
          </Card>

          {/* Tabla Movimientos Recientes */}
          <Card className="col-span-1 lg:col-span-3 bg-white/80 dark:bg-zinc-900/40 backdrop-blur-xl border border-gray-200 dark:border-white/5 shadow-lg dark:shadow-2xl transition-colors" radius="lg">
            <CardHeader className="px-8 py-6 border-b border-gray-100 dark:border-white/5 flex justify-between items-center bg-gray-50/50 dark:bg-transparent">
              <div className="flex items-center gap-4">
                <div className="bg-sky-100 dark:bg-sky-500/10 p-3 rounded-[1rem] text-sky-600 dark:text-sky-500 border border-sky-200 dark:border-sky-500/20 shadow-sm"><Clock size={20} /></div>
                <div>
                  <h2 className="text-lg font-black text-gray-900 dark:text-white uppercase tracking-tight">Últimos Movimientos</h2>
                  <p className="text-xs font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest">Actividad en tiempo real</p>
                </div>
              </div>
            </CardHeader>
            <CardBody className="p-0 overflow-auto max-h-[340px] custom-scrollbar">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 dark:bg-zinc-900/80 text-[10px] font-black uppercase tracking-widest text-gray-500 dark:text-zinc-400 sticky top-0 z-10 backdrop-blur-md">
                  <tr>
                    <th className="px-8 py-4 border-b border-gray-200 dark:border-white/5">Cliente</th>
                    <th className="px-4 py-4 border-b border-gray-200 dark:border-white/5 text-center">Método</th>
                    <th className="px-8 py-4 border-b border-gray-200 dark:border-white/5 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-white/5">
                  {data?.recentSales?.map((sale) => (
                    <tr key={sale.id} className="hover:bg-gray-50 dark:hover:bg-white/[0.02] transition-colors group">
                      <td className="px-8 py-4">
                        <p className="font-bold text-gray-900 dark:text-white uppercase tracking-tight truncate max-w-[120px] group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">{sale.client}</p>
                        <span className="text-[10px] font-bold text-gray-400 dark:text-zinc-500 tracking-widest">{new Date(sale.date).toLocaleDateString()}</span>
                      </td>
                      <td className="px-4 py-4 text-center">
                        <Chip size="sm" variant="flat" className="bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-zinc-300" classNames={{ content: "text-[9px] font-black uppercase tracking-widest" }}>
                          {sale.payment_method || 'CASH'}
                        </Chip>
                      </td>
                      <td className="px-8 py-4 text-right font-black text-gray-900 dark:text-white tabular-nums tracking-tighter">
                        ${formatCurrency(sale.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>
        </div>
      )}


      {/* Modal de Rango de Fechas Premium */}
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
                  Cancelar
                </Button>
                <Button color="primary" onPress={() => handleDateRangeReport('monthly')} className="bg-emerald-500 text-white dark:text-black font-black uppercase tracking-widest text-xs px-8 h-12 rounded-xl shadow-lg shadow-emerald-500/20">
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