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
  <div className="card-base p-6 relative group hover:border-zinc-200 dark:border-white/10 transition-all duration-150">
    <div className="absolute inset-x-0 bottom-0 h-10 opacity-10 pointer-events-none">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={[{ val: 10 }, { val: 25 }, { val: 15 }, { val: 35 }, { val: 20 }, { val: 45 }, { val: 30 }]}>
          <Area type="monotone" dataKey="val" stroke="#3f3f46" fill="#3f3f46" fillOpacity={0.2} strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
    <div className="relative z-10">
      <span className="text-[11px] font-medium tracking-widest uppercase text-zinc-500 block mb-2">{label}</span>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-light tracking-tight text-zinc-900 dark:text-zinc-50 tabular-nums font-['DM_Mono']">{value}</span>
        <span className="text-xs font-medium text-zinc-500">{trend}</span>
      </div>
      <p className="text-xs text-zinc-600 mt-1">{subValue}</p>
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
      const baseUrl = process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api';
      switch (type) {
        case 'box-closure': {
          const res = await fetch(`${baseUrl}/cashier-history?from=${dateFrom}&to=${dateTo}`, { headers: getHeaders() });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Fallo al generar reporte de cierres");
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
            })),
            sendToTelegram: customOptions?.sendToTelegram
          });
          break;
        }
        case 'cashflow': {
          const res = await fetch(`${baseUrl}/dashboard/reports/cashflow?from=${dateFrom}&to=${dateTo}`, { headers: getHeaders() });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Fallo al generar reporte de flujo de caja");
          
          generatePDFReport({
            title: 'Flujo de Caja (Ingresos y Egresos)',
            subtitle: `Rango: ${dateFrom} - ${dateTo} | Ingresos Totales: $${formatCurrency(data.totalIncome)} | Egresos Totales: $${formatCurrency(data.totalExpense)} | Saldo Total: $${formatCurrency(data.totalBalance)}`,
            filename: customOptions?.reportName || 'Flujo_Caja',
            columns: [
              { header: 'Fecha', dataKey: 'date' },
              { header: 'Ingresos', dataKey: 'income' },
              { header: 'Egresos', dataKey: 'expense' },
              { header: 'Saldo Diario', dataKey: 'balance' }
            ],
            data: (data.dailyDetails || []).map((item: any) => ({
              date: item.date,
              income: `$${formatCurrency(item.income)}`,
              expense: `$${formatCurrency(item.expense)}`,
              balance: `$${formatCurrency(item.balance)}`
            })),
            sendToTelegram: customOptions?.sendToTelegram
          });
          break;
        }
        case 'inventory': {
          const res = await fetch(`${baseUrl}/products/inventory`, { headers: getHeaders() });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Fallo al generar reporte de inventario");
          generatePDFReport({
            title: 'Inventario Actual',
            subtitle: `Reporte de Stock`,
            filename: customOptions?.reportName || 'Inventario',
            columns: [
              { header: 'Producto', dataKey: 'name' },
              { header: 'Stock', dataKey: 'stock' },
              { header: 'Costo', dataKey: 'cost' },
              { header: 'Venta', dataKey: 'price' }
            ],
            data: (data || []).map((p: any) => ({
              name: p.name || p.nombre,
              stock: p.stock !== undefined ? p.stock : (p.cantidad || 0),
              cost: `$${formatCurrency(p.costPrice || p.precioCosto || 0)}`,
              price: `$${formatCurrency(p.salePrice || p.precioVenta || 0)}`
            })),
            sendToTelegram: customOptions?.sendToTelegram
          });
          break;
        }
        case 'pnl': {
          const res = await fetch(`${baseUrl}/dashboard/reports/pnl?from=${dateFrom}&to=${dateTo}`, { headers: getHeaders() });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Fallo al generar reporte PnL");
          generatePDFReport({
            title: 'Estado de Resultados (P&L)',
            subtitle: `Rango: ${dateFrom} - ${dateTo}`,
            filename: customOptions?.reportName || 'PnL',
            columns: [
              { header: 'Concepto', dataKey: 'concept' },
              { header: 'Valor', dataKey: 'value' }
            ],
            data: [
              { concept: 'Ingresos Brutos', value: `$${formatCurrency(data.totalRevenue)}` },
              { concept: 'Costo de Mercancía', value: `$${formatCurrency(data.totalCogs)}` },
              { concept: 'Beneficio Bruto', value: `$${formatCurrency(data.grossProfit)}` },
              { concept: 'Gastos Operativos', value: `$${formatCurrency(data.totalExpenses)}` },
              { concept: 'Beneficio Neto', value: `$${formatCurrency(data.netProfit)}` },
              { concept: 'Margen (%)', value: `${(data.marginPercentage || 0).toFixed(2)}%` },
            ],
            sendToTelegram: customOptions?.sendToTelegram
          });
          break;
        }
        case 'ranking': {
          const res = await fetch(`${baseUrl}/dashboard/reports/ranking?from=${dateFrom}&to=${dateTo}`, { headers: getHeaders() });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Fallo al generar ranking");
          generatePDFReport({
            title: 'Ranking de Productos',
            subtitle: `Rango: ${dateFrom} - ${dateTo}`,
            filename: customOptions?.reportName || 'Ranking_Productos',
            columns: [
              { header: 'Producto', dataKey: 'name' },
              { header: 'Cant. Vendida', dataKey: 'quantity' },
              { header: 'Total Generado', dataKey: 'total' }
            ],
            data: (data || []).map((item: any) => ({
              name: item.name || item.productName || item.nombre,
              quantity: item.quantity || item.cantidad || 0,
              total: `$${formatCurrency(item.totalRevenue || item.total || 0)}`
            })),
            sendToTelegram: customOptions?.sendToTelegram
          });
          break;
        }
        case 'vault-audit': {
          const res = await fetch(`${baseUrl}/dashboard/reports/vault-audit`, { headers: getHeaders() });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Fallo al generar auditoría");
          generatePDFReport({
            title: 'Auditoría de Bóveda',
            subtitle: `Generado hoy`,
            filename: customOptions?.reportName || 'Boveda',
            columns: [
              { header: 'Detalle', dataKey: 'detail' },
              { header: 'Monto', dataKey: 'amount' }
            ],
            data: Object.entries(data).map(([k, v]) => ({
              detail: k,
              amount: typeof v === 'number' ? `$${formatCurrency(v)}` : String(v)
            })),
            sendToTelegram: customOptions?.sendToTelegram
          });
          break;
        }
        case 'global-credit': {
          const res = await fetch(`${baseUrl}/dashboard/reports/global-debt`, { headers: getHeaders() });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Fallo al generar cartera");
          generatePDFReport({
            title: 'Cartera Global',
            subtitle: `Deudas Activas`,
            filename: customOptions?.reportName || 'Cartera',
            columns: [
              { header: 'Cliente', dataKey: 'client' },
              { header: 'Deuda', dataKey: 'debt' },
            ],
            data: (data || []).map((c: any) => ({
              client: c.name || c.cliente || c.ClientName || 'Desconocido',
              debt: `$${formatCurrency(c.totalDebt || c.deuda || c.Debt || 0)}`
            })),
            sendToTelegram: customOptions?.sendToTelegram
          });
          break;
        }
        case 'voids-audit': {
          const res = await fetch(`${baseUrl}/dashboard/reports/voids?from=${dateFrom}&to=${dateTo}`, { headers: getHeaders() });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Fallo al generar anulaciones");
          generatePDFReport({
            title: 'Anulaciones',
            subtitle: `Rango: ${dateFrom} - ${dateTo}`,
            filename: customOptions?.reportName || 'Anulaciones',
            columns: [
              { header: 'Fecha', dataKey: 'date' },
              { header: 'Empleado', dataKey: 'employee' },
              { header: 'Monto', dataKey: 'amount' }
            ],
            data: (data || []).map((a: any) => ({
              date: new Date(a.date || a.fecha || a.CreatedAt).toLocaleString(),
              employee: a.employeeName || a.empleado || a.Employee || 'Desconocido',
              amount: `$${formatCurrency(a.amount || a.monto || a.TotalAmount || 0)}`
            })),
            sendToTelegram: customOptions?.sendToTelegram
          });
          break;
        }
        case 'payments': {
          const res = await fetch(`${baseUrl}/dashboard/reports/movements?from=${dateFrom}&to=${dateTo}`, { headers: getHeaders() });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Fallo al generar ventas/pagos");
          generatePDFReport({
            title: 'Movimientos (Ventas/Pagos)',
            subtitle: `Rango: ${dateFrom} - ${dateTo}`,
            filename: customOptions?.reportName || 'Movimientos',
            columns: [
              { header: 'Fecha', dataKey: 'date' },
              { header: 'Tipo', dataKey: 'type' },
              { header: 'Producto', dataKey: 'name' },
              { header: 'Cant.', dataKey: 'qty' }
            ],
            data: (data || []).map((m: any) => ({
              date: new Date(m.date || m.CreatedAt).toLocaleString(),
              type: m.type || m.MovementType || 'Desconocido',
              name: m.name || m.ProductName || m.barcode || 'N/A',
              qty: m.quantity || m.Quantity || 0
            })),
            sendToTelegram: customOptions?.sendToTelegram
          });
          break;
        }
        case 'savings': {
          const res = await fetch(`${baseUrl}/inventory/savings-opportunities`, { headers: getHeaders() });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Fallo al generar ahorros");
          generatePDFReport({
            title: 'Ahorros y Costos',
            subtitle: `Oportunidades de Optimización`,
            filename: customOptions?.reportName || 'Ahorros',
            columns: [
              { header: 'Producto', dataKey: 'name' },
              { header: 'Proveedor', dataKey: 'supplier' },
              { header: 'Mejor Precio', dataKey: 'price' }
            ],
            data: (data || []).map((s: any) => ({
              name: s.productName || s.name || s.ProductName,
              supplier: s.supplierName || s.supplier || s.SupplierName,
              price: `$${formatCurrency(s.bestPrice || s.price || s.BestPrice || 0)}`
            })),
            sendToTelegram: customOptions?.sendToTelegram
          });
          break;
        }
        default:
          toast({ title: 'Atención', description: 'El reporte seleccionado aún no está implementado.', variant: 'default' });
          return;
      }
      toast({ title: 'ÉXITO', description: 'REPORTE GENERADO CORRECTAMENTE', variant: 'success' });
    } catch (error: any) {
      console.error(error);
      toast({ title: 'ERROR', description: error.message || 'FALLO AL GENERAR REPORTE', variant: 'destructive' });
    } finally {
      setLoadingReport(null);
    }
  };

  return (
    <div className="flex flex-col w-full h-full max-w-[1600px] mx-auto bg-transparent text-zinc-900 dark:text-zinc-50 transition-all duration-500 overflow-hidden relative">
      
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
              <p className="text-[8px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.4em] tracking-tight mt-1 flex items-center gap-1">
                <Target size={10} className="text-zinc-900 dark:text-zinc-100" /> Business Intelligence V4.0
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
            <Button
              variant="flat"
              onPress={() => setDateRangeOpen(true)}
              className="bg-transparent text-zinc-500 dark:text-zinc-400 text-sm font-medium border border-white/[0.08] rounded-xl px-4 h-10 hover:bg-zinc-100 dark:bg-zinc-800 hover:text-zinc-200 transition-all duration-150"
            >
              <Calendar size={14} className="mr-1.5" /> Rango de Fechas
            </Button>
            <Button
              onPress={() => setIsGenerateModalOpen(true)}
              className="bg-transparent text-zinc-500 dark:text-zinc-400 text-sm font-medium border border-white/[0.08] rounded-xl px-4 h-10 hover:bg-zinc-100 dark:bg-zinc-800 hover:text-zinc-200 transition-all duration-150"
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
               <Card className="card-base p-6 md:p-8">
                  <div className="flex flex-col gap-6 text-center">
                    <h3 className="text-2xl font-medium tracking-tight uppercase tracking-tighter">Acceso <span className="opacity-40">Rápido</span></h3>
                    <Tabs
                      aria-label="Quick Report Type"
                      color="success"
                      selectedKey={quickCategory}
                      onSelectionChange={(k) => setQuickCategory(String(k))}
                      classNames={{ tabList: "bg-gray-100 dark:bg-zinc-950/50 p-1 rounded-2xl w-full", cursor: "bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5", tabContent: "font-medium text-[10px] uppercase tracking-tight tracking-widest" }}
                    >
                      <Tab key="box-closure" title="Caja" />
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


