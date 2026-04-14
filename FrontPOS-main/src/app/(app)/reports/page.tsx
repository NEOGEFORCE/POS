"use client";

import React, { useState } from 'react';
import { 
  Card, CardHeader, CardBody, Button, Chip, 
  Divider, Tab, Tabs, Spinner
} from "@heroui/react";
import { 
  BarChart3, FileText, Download, Wallet, ShoppingCart, 
  Package, Users, AlertTriangle, TrendingUp, History, 
  FileSearch, Printer, Calendar, Target, Zap, CreditCard as CreditCardIcon
} from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { generatePDFReport } from "@/lib/reportGenerator";
import { useToast } from "@/hooks/use-toast";
import Cookies from 'js-cookie';
import dynamic from "next/dynamic";

const DateRangeModal = dynamic(() => import("../dashboard/components/DateRangeModal"));

const PreviewModal = dynamic(() => import("./components/PreviewModal"));

interface ReportCardProps {
  title: string;
  description: string;
  icon: any;
  color: string;
  isLoading?: boolean;
  onDownload: () => void;
  onPreview?: () => void;
  isPopular?: boolean;
}

function ReportCard({ title, description, icon: Icon, color, onDownload, onPreview, isPopular, isLoading }: ReportCardProps) {
  return (
    <Card className="bg-white/90 dark:bg-zinc-900/50 backdrop-blur-xl border border-gray-200/80 dark:border-white/5 shadow-lg hover:shadow-2xl transition-all duration-300 group hover:-translate-y-1 overflow-hidden" radius="lg">
      <CardBody className="p-0">
        <div className="p-6">
          <div className="flex justify-between items-start mb-4">
            <div className={`p-4 rounded-2xl ${color} bg-opacity-10 shadow-inner group-hover:rotate-6 transition-transform duration-500`}>
              <Icon size={24} className={color.replace('bg-', 'text-')} />
            </div>
            {isPopular && (
              <Chip size="sm" variant="shadow" color="success" className="font-black uppercase text-[8px] tracking-[0.2em] shadow-emerald-500/20">
                Frecuente
              </Chip>
            )}
          </div>
          <h3 className="text-sm font-black text-gray-900 dark:text-white uppercase tracking-tight mb-2 group-hover:text-emerald-500 transition-colors">{title}</h3>
          <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest leading-relaxed">{description}</p>
        </div>
        <div className="flex border-t border-gray-100 dark:border-white/5">
          <button 
            onClick={onPreview}
            disabled={isLoading}
            className="flex-1 py-4 text-[9px] font-black uppercase tracking-[0.2em] text-gray-400 hover:text-emerald-500 hover:bg-emerald-500/5 transition-all flex items-center justify-center gap-2 border-r border-gray-100 dark:border-white/5 italic disabled:opacity-50"
          >
            Vista <FileSearch size={14} />
          </button>
          <button 
            onClick={onDownload}
            disabled={isLoading}
            className="flex-1 py-4 text-[9px] font-black uppercase tracking-[0.2em] text-gray-900 dark:text-white hover:bg-gray-900 dark:hover:bg-white hover:text-white dark:hover:text-black transition-all flex items-center justify-center gap-2 italic disabled:opacity-50"
          >
            {isLoading ? <Spinner size="sm" color="current" /> : <>PDF <Download size={14} /></>}
          </button>
        </div>
      </CardBody>
    </Card>
  );
}

export default function ReportsPage() {
  const [activeTab, setActiveTab] = useState("operativos");
  const [loadingReport, setLoadingReport] = useState<string | null>(null);
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const [dateFrom, setDateFrom] = useState(`${new Date().toISOString().split('T')[0]}T00:00`);
  const [dateTo, setDateTo] = useState(`${new Date().toISOString().split('T')[0]}T23:59`);
  
  // Preview states
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<any>(null);
  const [previewTitle, setPreviewTitle] = useState("");
  
  const { toast } = useToast();

  const getHeaders = () => ({
    'Authorization': `Bearer ${Cookies.get('org-pos-token')}`,
    'Content-Type': 'application/json'
  });

  const handleDownload = async (type: string) => {
    setLoadingReport(type);
    try {
      const fromD = dateFrom || new Date().toISOString().split('T')[0];
      const toD = dateTo || new Date().toISOString().split('T')[0];

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

        case 'expenses': {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/expenses/list`, { headers: getHeaders() });
            const data = await res.json();
            generatePDFReport({
              title: 'Libro de Gastos',
              subtitle: 'Detalle cronológico de egresos',
              filename: 'Libro_Gastos',
              columns: [
                { header: 'Fecha', dataKey: 'date_fmt' },
                { header: 'Categoría', dataKey: 'category' },
                { header: 'Descripción', dataKey: 'description' },
                { header: 'Monto', dataKey: 'amount_fmt' }
              ],
              data: data.map((e: any) => ({
                  ...e,
                  date_fmt: new Date(e.date).toLocaleDateString(),
                  amount_fmt: `$${formatCurrency(e.amount)}`
              })),
              summary: [{ label: 'Gasto Total', value: data.reduce((acc: number, e: any) => acc + e.amount, 0) }]
            });
            break;
        }

        case 'categories': {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/dashboard/reports/categories?from=${fromD}&to=${toD}`, { headers: getHeaders() });
          const data = await res.json();
          generatePDFReport({
            title: 'Ventas por Categoría',
            subtitle: 'Análisis de rotación por grupos',
            filename: 'Ventas_Categorias',
            columns: [
              { header: 'Categoría', dataKey: 'category' },
              { header: 'Cant. Items', dataKey: 'quantity' },
              { header: 'Total Recaudado', dataKey: 'total_fmt' }
            ],
            data: data.map((item: any) => ({ ...item, total_fmt: `$${formatCurrency(item.total)}` })),
          });
          break;
        }

        case 'clients': {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/dashboard/reports/clients-vip?from=${fromD}&to=${toD}`, { headers: getHeaders() });
          const data = await res.json();
          generatePDFReport({
            title: 'Ranking de Clientes VIP',
            subtitle: 'Basado en volumen de compra mensual',
            filename: 'Ranking_Clientes_VIP',
            columns: [
              { header: 'DNI/NIT', dataKey: 'dni' },
              { header: 'Nombre', dataKey: 'name' },
              { header: 'Ventas', dataKey: 'count' },
              { header: 'Gasto Total', dataKey: 'total_fmt' }
            ],
            data: data.map((item: any) => ({ ...item, total_fmt: `$${formatCurrency(item.total)}` })),
          });
          break;
        }

        case 'voids': {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/dashboard/reports/voids?from=${fromD}&to=${toD}`, { headers: getHeaders() });
          const data = await res.json();
          generatePDFReport({
            title: 'Log de Auditoría: Anulaciones',
            subtitle: 'Control de seguridad operacional',
            filename: 'Auditoria_Anulaciones',
            columns: [
              { header: 'ID Venta', dataKey: 'saleId' },
              { header: 'Fecha', dataKey: 'date_fmt' },
              { header: 'Empleado', dataKey: 'employee' },
              { header: 'Monto Devuelto', dataKey: 'total_fmt' }
            ],
            data: data.map((item: any) => ({ 
                ...item, 
                date_fmt: new Date(item.date).toLocaleString(),
                total_fmt: `$${formatCurrency(item.total)}` 
            })),
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

        case 'shardex': {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/dashboard/reports/movements?from=${fromD}&to=${toD}`, { headers: getHeaders() });
          const data = await res.json();
          generatePDFReport({
            title: 'Movimientos de Inventario (Kárdex)',
            subtitle: `Trazabilidad de auditoría: ${fromD} al ${toD}`,
            filename: 'Reporte_Kardex',
            columns: [
              { header: 'Fecha', dataKey: 'date_fmt' },
              { header: 'Producto', dataKey: 'name' },
              { header: 'Cant.', dataKey: 'quantity' },
              { header: 'Tipo', dataKey: 'type' },
              { header: 'Motivo', dataKey: 'reason' },
              { header: 'Responsable', dataKey: 'employee' }
            ],
            data: data.map((item: any) => ({
              ...item,
              date_fmt: new Date(item.date).toLocaleString(),
            }))
          });
          break;
        }

        case 'low-stock': {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/dashboard/overview`, { headers: getHeaders() });
          const { lowStockProducts } = await res.json();
          generatePDFReport({
            title: 'Alerta de Quiebre Stock',
            subtitle: 'Productos por debajo del nivel de seguridad',
            filename: 'Alerta_Stock',
            columns: [
              { header: 'Barcode', dataKey: 'barcode' },
              { header: 'Producto', dataKey: 'name' },
              { header: 'Existencias', dataKey: 'stock' },
              { header: 'Mínimo', dataKey: 'minStock' }
            ],
            data: lowStockProducts
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
  const handlePreview = async (type: string, title: string) => {
    setLoadingReport(type);
    try {
      const fromD = dateFrom || new Date().toISOString().split('T')[0];
      const toD = dateTo || new Date().toISOString().split('T')[0];
      let url = "";

      // Mapeo simple de tipo a endpoint para vista previa
      switch(type) {
        case 'box-closure': url = `${process.env.NEXT_PUBLIC_API_URL}/dashboard/cashier-closure`; break;
        case 'payments': url = `${process.env.NEXT_PUBLIC_API_URL}/dashboard/overview`; break;
        case 'ranking': url = `${process.env.NEXT_PUBLIC_API_URL}/dashboard/reports/ranking?from=${fromD}&to=${toD}`; break;
        case 'categories': url = `${process.env.NEXT_PUBLIC_API_URL}/dashboard/reports/categories?from=${fromD}&to=${toD}`; break;
        case 'clients': url = `${process.env.NEXT_PUBLIC_API_URL}/dashboard/reports/clients-vip?from=${fromD}&to=${toD}`; break;
        case 'voids': url = `${process.env.NEXT_PUBLIC_API_URL}/dashboard/reports/voids?from=${fromD}&to=${toD}`; break;
        case 'inventory': url = `${process.env.NEXT_PUBLIC_API_URL}/products/all-products`; break;
        case 'expenses': url = `${process.env.NEXT_PUBLIC_API_URL}/expenses/list`; break;
        case 'pnl': url = `${process.env.NEXT_PUBLIC_API_URL}/dashboard/reports/pnl?from=${fromD}&to=${toD}`; break;
        case 'shardex': url = `${process.env.NEXT_PUBLIC_API_URL}/dashboard/reports/movements?from=${fromD}&to=${toD}`; break;
        case 'low-stock': url = `${process.env.NEXT_PUBLIC_API_URL}/dashboard/overview`; break;
      }

      const res = await fetch(url, { headers: getHeaders() });
      const data = await res.json();

      setPreviewTitle(title);
      setPreviewData(data);
      setPreviewOpen(true);
    } catch (err) {
      toast({ title: "Error", description: "No se pudo cargar la vista previa", variant: "destructive" });
    } finally {
      setLoadingReport(null);
    }
  };

  return (
    <div className="flex flex-col gap-6 md:gap-8 max-w-7xl mx-auto px-4 md:px-6 pb-20">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 pt-4">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
             <div className="bg-emerald-500 p-2.5 rounded-xl text-white shadow-lg shadow-emerald-500/20"><BarChart3 size={24} /></div>
             <h1 className="text-3xl md:text-5xl font-black text-gray-900 dark:text-white tracking-tighter uppercase italic leading-none">
              Central de <span className="text-emerald-500">Reportes</span>
             </h1>
          </div>
          <p className="text-[10px] md:text-xs font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.4em] italic ml-1">
            Inteligencia de Negocio & Audit Ledger Maestro
          </p>
        </div>

        <div className="flex items-center gap-3">
           <Button 
             variant="flat" 
             onPress={() => setDateRangeOpen(true)}
             className="h-12 rounded-xl text-[10px] font-black uppercase tracking-widest italic bg-white dark:bg-zinc-900 border border-gray-100 dark:border-white/5 shadow-sm"
           >
             {dateFrom && dateTo ? `${dateFrom} / ${dateTo}` : "Personalizar Periodo"} <Calendar size={16} className="ml-1" />
           </Button>
           <Button className="h-12 rounded-xl bg-gray-900 dark:bg-white text-white dark:text-black text-[10px] font-black uppercase tracking-widest italic shadow-xl">
             Consolidado Global <Target size={16} className="ml-1" />
           </Button>
        </div>
      </header>

      <Divider className="opacity-50" />

      <div className="flex flex-col gap-8">
        <Tabs 
          aria-label="Report Categories" 
          variant="underlined"
          selectedKey={activeTab}
          onSelectionChange={(key) => setActiveTab(key as string)}
          classNames={{
            base: "w-full",
            tabList: "gap-6 w-full relative rounded-none p-0 border-b border-divider",
            cursor: "w-full bg-emerald-500",
            tab: "max-w-fit px-0 h-12",
            tabContent: "group-data-[selected=true]:text-emerald-500 text-[11px] font-black uppercase tracking-[0.2em] italic transition-colors"
          }}
        >
          <Tab key="operativos" title="Operativos (Caja)" />
          <Tab key="comerciales" title="Comerciales (Ventas)" />
          <Tab key="logisticos" title="Logísticos (Stock)" />
          <Tab key="fiscales" title="Administrativos" />
        </Tabs>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {activeTab === "operativos" && (
            <>
              <ReportCard 
                title="Cuadre de Caja (X/Z)" 
                description="Resumen total del turno: Base, ingresos, egresos y ventas netas por cajero."
                icon={Wallet}
                color="bg-emerald-500"
                isLoading={loadingReport === 'box-closure'}
                onDownload={() => handleDownload('box-closure')}
                onPreview={() => handlePreview('box-closure', 'Cuadre de Caja')}
                isPopular
              />
              <ReportCard 
                title="Ventas por Medio de Pago" 
                description="Desglose detallado de Efectivo, Bancos, Transferencias y Fiados."
                icon={CreditCardIcon}
                color="bg-sky-500"
                isLoading={loadingReport === 'payments'}
                onDownload={() => handleDownload('payments')}
                onPreview={() => handlePreview('payments', 'Ventas por Medio de Pago')}
              />
              <ReportCard 
                title="Log de Anulaciones" 
                description="Auditoría de facturas modificadas o canceladas por seguridad operativa."
                icon={History}
                color="bg-rose-500"
                isLoading={loadingReport === 'voids'}
                onDownload={() => handleDownload('voids')}
                onPreview={() => handlePreview('voids', 'Log de Anulaciones')}
              />
            </>
          )}

          {activeTab === "comerciales" && (
            <>
              <ReportCard 
                title="Ranking de Productos" 
                description="Identifica tus artículos estrella y los de baja rotación en el periodo seleccionado."
                icon={ShoppingCart}
                color="bg-violet-500"
                isLoading={loadingReport === 'ranking'}
                onDownload={() => handleDownload('ranking')}
                onPreview={() => handlePreview('ranking', 'Ranking de Productos')}
                isPopular
              />
              <ReportCard 
                title="Ventas por Categoría" 
                description="Análisis de rentabilidad por grupos de productos para optimizar pasillos."
                icon={Package}
                color="bg-amber-500"
                isLoading={loadingReport === 'categories'}
                onDownload={() => handleDownload('categories')}
                onPreview={() => handlePreview('categories', 'Ventas por Categoría')}
              />
              <ReportCard 
                title="Lista de Clientes VIP" 
                description="Top de compradores con mayor frecuencia y gasto total acumulado."
                icon={Users}
                color="bg-indigo-500"
                isLoading={loadingReport === 'clients'}
                onDownload={() => handleDownload('clients')}
                onPreview={() => handlePreview('clients', 'Ranking de Clientes VIP')}
              />
            </>
          )}

          {activeTab === "logisticos" && (
            <>
              <ReportCard 
                title="Inventario Valorizado" 
                description="Valor total de tu stock a precio de costo y precio de venta estimado."
                icon={Package}
                color="bg-emerald-500"
                isLoading={loadingReport === 'inventory'}
                onDownload={() => handleDownload('inventory')}
                isPopular
              />
              <ReportCard 
                title="Alerta de Quiebre Stock" 
                description="Informe crítico de productos por debajo del mínimo para reposición inmediata."
                icon={AlertTriangle}
                color="bg-rose-500"
                isLoading={loadingReport === 'low-stock'}
                onDownload={() => handleDownload('low-stock')}
                onPreview={() => handlePreview('low-stock', 'Alerta de Quiebre Stock')}
              />
              <ReportCard 
                title="Movimientos Kárdex" 
                description="Trazabilidad completa de entradas y salidas por cada producto individual."
                icon={History}
                color="bg-sky-500"
                isLoading={loadingReport === 'shardex'}
                onDownload={() => handleDownload('shardex')}
                onPreview={() => handlePreview('shardex', 'Movimientos Kárdex')}
              />
            </>
          )}

          {activeTab === "fiscales" && (
            <>
              <ReportCard 
                title="Estado de Resultados" 
                description="Balance simplificado de Ventas Brutas vs Gastos Operativos totales (PyG)."
                icon={TrendingUp}
                color="bg-emerald-500"
                isLoading={loadingReport === 'pnl'}
                onDownload={() => handleDownload('pnl')}
                onPreview={() => handlePreview('pnl', 'Estado de Resultados (PyG)')}
                isPopular
              />
              <ReportCard 
                title="Libro de Gastos" 
                description="Listado cronológico de todos los egresos registrados por categoría."
                icon={FileText}
                color="bg-gray-500"
                isLoading={loadingReport === 'expenses'}
                onDownload={() => handleDownload('expenses')}
                onPreview={() => handlePreview('expenses', 'Libro de Gastos')}
              />
              <ReportCard 
                title="Facturación Mensual" 
                description="Listado continuo de folios emitidos para reporte contable externo."
                icon={Printer}
                color="bg-amber-500"
                onDownload={() => handleDownload('fiscal')}
                onPreview={() => handlePreview('fiscal', 'Facturación Mensual')}
              />
            </>
          )}
        </div>
      </div>

      <footer className="mt-auto pt-10 flex flex-col items-center gap-4 opacity-40">
        <div className="flex items-center gap-2">
           <Zap size={14} className="text-emerald-500" />
           <span className="text-[10px] font-black uppercase tracking-[0.2em]">Cifras actualizadas en tiempo real</span>
        </div>
        <p className="text-[8px] font-bold text-center max-w-sm uppercase tracking-widest text-gray-500">
          Este tablero genera reportes basados en la actividad registrada en el Audit Ledger. Los datos tienen validez operativa y comercial interna.
        </p>
      </footer>

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

      {previewOpen && (
        <PreviewModal 
          isOpen={previewOpen}
          onOpenChange={() => setPreviewOpen(false)}
          title={previewTitle}
          data={previewData}
        />
      )}
    </div>
  );
}
