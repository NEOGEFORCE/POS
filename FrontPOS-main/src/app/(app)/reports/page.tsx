"use client";

import React, { useState, useMemo, memo } from 'react';
import { 
  Card, CardHeader, CardBody, Button, Chip, 
  Divider, Tab, Tabs, Spinner, Table, TableHeader, 
  TableColumn, TableBody, TableRow, TableCell,
  Input, Pagination, Tooltip, Avatar, Progress
} from "@heroui/react";
import { 
  BarChart3, FileText, Download, Wallet, ShoppingCart, 
  Package, Users, AlertTriangle, TrendingUp, History, 
  FileSearch, Printer, Calendar, Target, Zap, 
  CreditCard as CreditCardIcon, PlusCircle, Search,
  Clock, Mail, ChevronRight, Filter, MoreHorizontal
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
];

const SCHEDULED_REPORTS = [
    { id: "1", name: "Cierre Diario Automatizado", frequency: "Diary", next: "2024-04-16 23:59", recipient: "gerencia@pos.com" },
    { id: "2", name: "Alerta Stock Crítico", frequency: "Hourly", next: "Sig. Hora", recipient: "compras@pos.com" },
    { id: "3", name: "Balance PyG Mensual", frequency: "Monthly", next: "2024-05-01 08:00", recipient: "contabilidad@pos.com" },
];

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
  
  const { toast } = useToast();

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
            filename: `Cuadre_Caja_${new Date().toISOString().split('T')[0]}`,
            columns: [
              { header: 'Concepto', dataKey: 'label' },
              { header: 'Valor', dataKey: 'value' }
            ],
            data: [
              { label: 'Ventas Totales', value: `$${formatCurrency(data.totalSales)}` },
              { label: 'Efectivo en Caja', value: `$${formatCurrency(data.totalCash)}` },
              { label: 'Base de Apertura', value: `$${formatCurrency(data.openingCash)}` },
              { label: 'Gastos Registrados', value: `$${formatCurrency(data.totalExpenses)}` },
              { label: 'Devoluciones', value: `$${formatCurrency(data.totalReturns)}` },
              { label: 'Balance Neto', value: `$${formatCurrency(data.netBalance)}` }
            ],
            summary: [{ label: 'Total Operativo', value: data.netBalance }]
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
            filename: 'Reporte_Pagos',
            columns: [
              { header: 'Método de Pago', dataKey: 'method' },
              { header: 'Total Recaudado', dataKey: 'amount' }
            ],
            data: paymentData,
            summary: [{ label: 'Gran Total', value: data.totalSalesAmount }]
          });
          break;
        }
        case 'ranking': {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/dashboard/reports/ranking?from=${fromD}&to=${toD}`, { headers: getHeaders() });
          const data = await res.json();
          generatePDFReport({
            title: 'Ranking de Productos',
            subtitle: 'Top ventas por volumen y rentabilidad',
            filename: 'Ranking_Productos',
            columns: [
              { header: 'Barcode', dataKey: 'barcode' },
              { header: 'Producto', dataKey: 'name' },
              { header: 'Cant.', dataKey: 'quantity' },
              { header: 'Subtotal', dataKey: 'total_fmt' }
            ],
            data: data.map((item: any) => ({ ...item, total_fmt: `$${formatCurrency(item.total)}` })),
          });
          break;
        }
        case 'inventory': {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/products/all-products`, { headers: getHeaders() });
          const data = await res.json();
          let totalCost = 0;
          let totalValue = 0;
          const items = data.map((p: any) => {
              const subCost = p.cost_price * p.quantity;
              const subValue = p.sale_price * p.quantity;
              totalCost += subCost;
              totalValue += subValue;
              return {
                  name: p.product_name,
                  stock: p.quantity,
                  cost: `$${formatCurrency(p.cost_price)}`,
                  price: `$${formatCurrency(p.sale_price)}`,
                  total: `$${formatCurrency(subValue)}`
              };
          });
          generatePDFReport({
            title: 'Inventario Valorizado',
            subtitle: 'Auditoría de activos en stock',
            filename: 'Inventario_Valorizado',
            columns: [
              { header: 'Producto', dataKey: 'name' },
              { header: 'Stock', dataKey: 'stock' },
              { header: 'Costo Unit.', dataKey: 'cost' },
              { header: 'Precio Venta', dataKey: 'price' },
              { header: 'Total Venta', dataKey: 'total' }
            ],
            data: items,
            summary: [
                { label: 'Valor a Costo', value: totalCost },
                { label: 'Valor a Venta', value: totalValue }
            ]
          });
          break;
        }
        case 'pnl': {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/dashboard/reports/pnl?from=${fromD}&to=${toD}`, { headers: getHeaders() });
          const data = await res.json();
          generatePDFReport({
            title: 'Estado de Resultados (PyG)',
            subtitle: `Balance de rentabilidad: ${fromD} al ${toD}`,
            filename: 'Estado_Resultados',
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
            summary: [{ label: 'Margen Neto', value: `${data.marginPercentage.toFixed(2)}%` }]
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
    <div className="flex flex-col gap-6 md:gap-8 max-w-[1600px] mx-auto px-4 md:px-6 pb-20 w-full min-h-[100dvh]">
      
      {/* HEADER TACTICO */}
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 pt-6">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
             <div className="bg-emerald-500 w-14 h-14 rounded-[1.5rem] text-white shadow-2xl shadow-emerald-500/20 flex items-center justify-center transform -rotate-6 group hover:rotate-0 transition-all">
                <BarChart3 size={32} />
             </div>
             <div className="flex flex-col">
                <h1 className="text-3xl md:text-5xl font-black text-gray-900 dark:text-white tracking-tighter uppercase italic leading-none">
                  Central de <span className="text-emerald-500">Reportes</span>
                </h1>
                <p className="text-[10px] md:text-xs font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.4em] italic ml-1 mt-2">
                  Business Intelligence & Audit Ledger V4.0
                </p>
             </div>
          </div>
        </div>

        <div className="flex items-center gap-1 bg-white/50 dark:bg-zinc-900/50 backdrop-blur-md p-1.5 rounded-[1.5rem] border border-gray-200 dark:border-white/5 shadow-inner">
           <Button 
             variant="light"
             onPress={() => setDateRangeOpen(true)}
             className="h-12 rounded-[1rem] text-[10px] font-black uppercase tracking-widest italic text-gray-400 hover:text-emerald-500 transition-all"
           >
             <Calendar size={16} className="mr-2" /> PERSONALIZAR FECHAS
           </Button>
           <Divider orientation="vertical" className="h-6 mx-1" />
           <Button 
            onPress={() => setIsGenerateModalOpen(true)}
            className="h-12 rounded-[1rem] bg-emerald-500 text-white text-[10px] font-black uppercase tracking-widest italic shadow-xl shadow-emerald-500/20 px-8"
           >
             <Zap size={16} className="mr-2" /> GENERADOR MAESTRO
           </Button>
        </div>
      </header>

      {/* DASHBOARD ANALITICO SUPERIOR */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <MetricCard label="Reportes Generados" value="1,450" trend="+12.5%" subValue="Últimos 30 días" />
        <MetricCard label="Exportaciones Exitosas" value="98.2%" subValue="Audit Ledger Health" />
        <MetricCard label="Programaciones" value="24" trend="Activos" subValue="Next run in 2h" />
        <MetricCard label="Almacenamiento Cloud" value="2.4 GB" subValue="Uso de repositorio" />
      </div>

      <div className="flex flex-col xl:flex-row gap-8">
        {/* PANEL PRINCIPAL: TABLAS DE GESTION */}
        <div className="flex-1 space-y-8 min-w-0">
            {/* TABLA HISTORIAL */}
            <Card className="bg-white/70 dark:bg-zinc-900/30 backdrop-blur-2xl border border-gray-200 dark:border-white/5 rounded-[2.5rem] shadow-2xl">
                <CardHeader className="p-8 pb-0 flex justify-between items-center">
                    <div className="flex items-center gap-3">
                        <History size={20} className="text-emerald-500" />
                        <h2 className="text-lg font-black text-gray-900 dark:text-white uppercase italic tracking-tighter">Historial de <span className="text-emerald-500">Archivos</span></h2>
                    </div>
                    <Button isIconOnly variant="flat" size="sm" className="rounded-xl"><Filter size={16} /></Button>
                </CardHeader>
                <CardBody className="p-8">
                    <Table aria-label="Archived Reports" removeWrapper classNames={{
                        th: "bg-transparent text-gray-400 dark:text-zinc-500 font-black uppercase text-[9px] tracking-widest border-b border-gray-100 dark:border-white/5",
                        td: "py-4 text-sm font-black italic text-gray-900 dark:text-white border-b border-gray-50 dark:border-white/5"
                    }}>
                        <TableHeader>
                            <TableColumn>NOMBRE DEL REPORTE</TableColumn>
                            <TableColumn>FECHA</TableColumn>
                            <TableColumn>FORMATO</TableColumn>
                            <TableColumn>TAMAÑO</TableColumn>
                            <TableColumn align="end">GESTIÓN</TableColumn>
                        </TableHeader>
                        <TableBody>
                            {ARCHIVED_REPORTS.map((r) => (
                                <TableRow key={r.id}>
                                    <TableCell>
                                        <div className="flex items-center gap-3">
                                            <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500"><FileText size={14} /></div>
                                            {r.name}
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-gray-400 uppercase text-[10px] tabular-nums">{r.date}</TableCell>
                                    <TableCell>
                                        <Chip size="sm" variant="flat" className="font-black text-[9px]">{r.format}</Chip>
                                    </TableCell>
                                    <TableCell className="text-zinc-500 text-[10px]">{r.size}</TableCell>
                                    <TableCell>
                                        <Button isIconOnly variant="light" size="sm" className="text-gray-400"><Download size={16} /></Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardBody>
            </Card>

            {/* TABLA PROGRAMADOS */}
            <Card className="bg-emerald-500/5 dark:bg-emerald-500/5 backdrop-blur-2xl border border-emerald-500/10 rounded-[2.5rem] shadow-xl">
                <CardHeader className="p-8 pb-0">
                    <div className="flex items-center gap-3">
                        <Clock size={20} className="text-emerald-500" />
                        <h2 className="text-lg font-black text-gray-900 dark:text-white uppercase italic tracking-tighter text-emerald-500">Automatizaciones <span className="text-gray-900 dark:text-white">(Scheduled)</span></h2>
                    </div>
                </CardHeader>
                <CardBody className="p-8">
                    <Table aria-label="Scheduled Reports" removeWrapper classNames={{
                        th: "bg-transparent text-emerald-500/30 font-black uppercase text-[9px] tracking-widest border-b border-emerald-500/10",
                        td: "py-4 text-sm font-black italic text-gray-900 dark:text-white border-b border-emerald-500/5"
                    }}>
                        <TableHeader>
                            <TableColumn>REPORTE</TableColumn>
                            <TableColumn>FRECUENCIA</TableColumn>
                            <TableColumn>PROX. ENVÍO</TableColumn>
                            <TableColumn>DESTINATARIO</TableColumn>
                            <TableColumn align="end">ACCIONES</TableColumn>
                        </TableHeader>
                        <TableBody>
                            {SCHEDULED_REPORTS.map((s) => (
                                <TableRow key={s.id}>
                                    <TableCell>{s.name}</TableCell>
                                    <TableCell><Chip size="sm" variant="dot" color="success" className="font-black text-[9px] uppercase tracking-tighter">{s.frequency}</Chip></TableCell>
                                    <TableCell className="text-[10px] tabular-nums text-zinc-500 italic">{s.next}</TableCell>
                                    <TableCell className="text-[10px] text-emerald-500 flex items-center gap-2 underline decoration-emerald-500/20"><Mail size={12} /> {s.recipient}</TableCell>
                                    <TableCell><Button isIconOnly variant="flat" size="sm" className="rounded-xl"><MoreHorizontal size={16} /></Button></TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardBody>
            </Card>
        </div>

        {/* SIDEBAR TACTICA DERECHA */}
        <aside className="w-full xl:w-96 flex flex-col gap-6 shrink-0">
            {/* REPORT GENERATION PANEL (Sidebar Derecha) */}
            <Card className="bg-gray-900 dark:bg-white text-white dark:text-black rounded-[2.5rem] shadow-2xl p-8 border-none transform xl:-rotate-2">
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
                                    tabList: "bg-white/10 dark:bg-black/5 p-1 rounded-xl w-full",
                                    cursor: "bg-emerald-500 rounded-lg",
                                    tab: "h-10",
                                    tabContent: "font-black text-[10px] uppercase italic tracking-widest group-data-[selected=true]:text-white"
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
                                className="w-full bg-white/10 dark:bg-black/5 border border-white/5 dark:border-black/5 h-12 rounded-2xl justify-between px-4 hover:border-emerald-500/50 transition-all font-black text-[10px] uppercase tracking-widest"
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
                                    tabList: "bg-white/10 dark:bg-black/5 p-1 rounded-xl w-full",
                                    cursor: "bg-gray-800 dark:bg-gray-200 rounded-lg",
                                    tab: "h-10",
                                    tabContent: "font-black text-[10px] uppercase italic tracking-widest group-data-[selected=true]:text-white dark:group-data-[selected=true]:text-black"
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
            <Card className="bg-emerald-500 text-white rounded-[2.5rem] p-8 shadow-xl shadow-emerald-500/20 overflow-hidden relative">
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

      {dateRangeOpen && (
        <DateRangeModal 
          isOpen={dateRangeOpen}
          onOpenChange={() => setDateRangeOpen(false)}
          startDate={dateFrom}
          endDate={dateTo}
          onSetStartDate={setDateFrom}
          onSetEndDate={setDateTo}
          onDownloadRange={() => setDateRangeOpen(false)}
        />
      )}

      {isGenerateModalOpen && (
        <GenerateReportModal 
          isOpen={isGenerateModalOpen}
          onOpenChange={() => setIsGenerateModalOpen(false)}
          onGenerate={handleDownload}
        />
      )}
    </div>
  );
}
