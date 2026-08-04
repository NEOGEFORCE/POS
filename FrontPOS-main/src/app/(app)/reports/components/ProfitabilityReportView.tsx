"use client";

import React, { useState, useEffect, useMemo } from "react";
import { Button, Input, Spinner, Card, CardBody } from "@heroui/react";
import {
  TrendingUp,
  DollarSign,
  Receipt,
  Wallet,
  Building2,
  Users,
  CreditCard,
  Download,
  Calendar,
  ChevronDown,
  ChevronUp,
  Send,
  AlertTriangle,
  CheckCircle2,
  ArrowUpRight,
  ArrowDownRight
} from "lucide-react";
import Cookies from "js-cookie";
import { formatCurrency } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

interface ProfitabilityReportViewProps {
  initialFrom?: string;
  initialTo?: string;
}

export default function ProfitabilityReportView({ initialFrom, initialTo }: ProfitabilityReportViewProps) {
  const { toast } = useToast();

  // State de rango de fechas
  const [datePreset, setDatePreset] = useState<'this_month' | 'last_month' | 'today' | 'yesterday' | 'all' | 'custom'>('this_month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  // Limite de registros en tablas
  const [showAllClients, setShowAllClients] = useState(false);
  const [showAllDebts, setShowAllDebts] = useState(false);

  // Data del reporte
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);

  // Calcular limites de fecha segun preset
  const dateBounds = useMemo(() => {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    if (datePreset === 'today') {
      return { from: todayStr, to: todayStr };
    }
    if (datePreset === 'yesterday') {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      const yStr = y.toISOString().split('T')[0];
      return { from: yStr, to: yStr };
    }
    if (datePreset === 'this_month') {
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
      return { from: firstDay, to: lastDay };
    }
    if (datePreset === 'last_month') {
      const firstDay = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
      const lastDay = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];
      return { from: firstDay, to: lastDay };
    }
    if (datePreset === 'custom') {
      return { from: customFrom || '2020-01-01', to: customTo || '2099-12-31' };
    }
    return { from: '2020-01-01', to: '2099-12-31' };
  }, [datePreset, customFrom, customTo]);

  // Cargar reporte desde el backend
  const fetchReport = async () => {
    const token = Cookies.get("org-pos-token");
    if (!token) return;
    setLoading(true);

    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined'
        ? process.env.NEXT_PUBLIC_API_URL
        : '/api';
      const response = await fetch(
        `${baseUrl}/dashboard/reports/profitability?from=${dateBounds.from}&to=${dateBounds.to}`,
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      if (!response.ok) throw new Error("Fallo al obtener datos");
      const res = await response.json();
      setData(res);
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Error al cargar reporte",
        description: err.message || "No se pudo obtener la información de rentabilidad"
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReport();
  }, [dateBounds]);

  // Descargar PDF desde el backend
  const handleDownloadPDF = async () => {
    const token = Cookies.get("org-pos-token");
    if (!token) return;
    setDownloading(true);

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api/v1'}/dashboard/reports/export?type=profitability&format=PDF&from=${dateBounds.from}&to=${dateBounds.to}`,
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      if (!response.ok) throw new Error("Error al generar PDF");

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Reporte_Rentabilidad_${dateBounds.from}_a_${dateBounds.to}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

      toast({
        variant: "success",
        title: "Reporte Descargado",
        description: "El PDF se generó y descargó correctamente."
      });
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Fallo al descargar PDF",
        description: err.message || "No se pudo descargar el archivo"
      });
    } finally {
      setDownloading(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center p-12 gap-3 text-zinc-500">
        <Spinner size="lg" color="success" />
        <span className="text-sm font-medium uppercase tracking-wider">Cargando reporte de rentabilidad...</span>
      </div>
    );
  }

  // Extraer valores o ceros por defecto
  const totalSales = data?.totalSales || 0;
  const totalCost = data?.totalCost || 0;
  const grossProfit = data?.grossProfit || (totalSales - totalCost);

  const publicServices = data?.publicServicesExp || 0;
  const rent = data?.rentExp || 0;
  const maintenance = data?.maintenanceExp || 0;
  const payroll = data?.payrollExp || 0;
  const otherOp = data?.otherOpExp || 0;
  const totalOpExpenses = data?.totalOpExpenses || (publicServices + rent + maintenance + payroll + otherOp);

  const totalCashInflows = data?.totalCashInflows || ((data?.cashSales || 0) + (data?.creditPaymentsCash || 0));
  const cashExpenses = data?.cashExpenses || 0;
  const creditSales = data?.creditSales || 0;
  const transferSales = data?.transferSales || 0;

  const totalCreditReceivable = data?.totalCreditReceivable || 0;
  const creditReceivables = data?.creditReceivables || [];

  const totalDebtsPayable = data?.totalDebtsPayable || 0;
  const debtsPayable = data?.debtsPayable || [];

  const netProfit = data?.netProfit || (grossProfit - totalOpExpenses);

  const visibleClients = showAllClients ? creditReceivables : creditReceivables.slice(0, 5);
  const visibleDebts = showAllDebts ? debtsPayable : debtsPayable.slice(0, 5);

  return (
    <div className="flex flex-col gap-6 max-w-[900px] mx-auto p-2 sm:p-6 bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 font-sans rounded-3xl shadow-sm border border-zinc-200/80 dark:border-white/5 transition-all">

      {/* ENCABEZADO Y PERÍODO */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-zinc-200 dark:border-white/10">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-zinc-900 dark:text-white flex items-center gap-3">
            <TrendingUp className="text-emerald-600 dark:text-emerald-400" size={28} />
            Reporte de rentabilidad
          </h1>
          <p className="text-sm sm:text-base text-zinc-500 dark:text-zinc-400 mt-1 flex flex-wrap items-center gap-2">
            <span>Resumen financiero claro del negocio &middot; <span className="font-semibold text-zinc-700 dark:text-zinc-300">{dateBounds.from}</span> al <span className="font-semibold text-zinc-700 dark:text-zinc-300">{dateBounds.to}</span></span>
            <span className="text-xs px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 font-mono border border-emerald-200 dark:border-emerald-800/40 font-bold flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Generado: {new Date().toLocaleString('es-CO')}
            </span>
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            onPress={handleDownloadPDF}
            isLoading={downloading}
            className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm px-5 h-11 rounded-2xl shadow-sm flex items-center gap-2 transition-all"
          >
            <Download size={18} />
            Descargar PDF
          </Button>
        </div>
      </div>

      {/* BARRA DE SELECCION DE FECHAS */}
      <div className="p-3 bg-zinc-100/80 dark:bg-zinc-900/80 rounded-2xl border border-zinc-200/80 dark:border-white/5 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Calendar size={16} className="text-emerald-600 dark:text-emerald-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
              Período: {datePreset === 'all' ? 'Todos los registros' : datePreset === 'this_month' ? 'Este Mes' : datePreset === 'last_month' ? 'Mes Pasado' : datePreset === 'today' ? 'Hoy' : datePreset === 'yesterday' ? 'Ayer' : 'Personalizado'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1 bg-white dark:bg-zinc-950 p-1 rounded-xl border border-zinc-200 dark:border-white/5">
            {[
              { id: 'all', label: 'Todos' },
              { id: 'today', label: 'Hoy' },
              { id: 'yesterday', label: 'Ayer' },
              { id: 'this_month', label: 'Este Mes' },
              { id: 'last_month', label: 'Mes Pasado' },
              { id: 'custom', label: 'Personalizado' },
            ].map(preset => (
              <Button
                key={preset.id}
                size="sm"
                variant={datePreset === preset.id ? "solid" : "light"}
                onPress={() => setDatePreset(preset.id as any)}
                className={`h-7 px-3 text-xs font-semibold uppercase tracking-wider rounded-lg transition-all ${
                  datePreset === preset.id
                    ? 'bg-emerald-600 text-white font-bold shadow-sm'
                    : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
                }`}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>

        {datePreset === 'custom' && (
          <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-zinc-200 dark:border-white/5 animate-in fade-in duration-200">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium uppercase text-zinc-500">Desde:</span>
              <Input
                type="date"
                size="sm"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="w-36 text-xs font-mono"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium uppercase text-zinc-500">Hasta:</span>
              <Input
                type="date"
                size="sm"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="w-36 text-xs font-mono"
              />
            </div>
          </div>
        )}
      </div>

      {/* 1. GANANCIA GENERAL DE LO VENDIDO */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold text-zinc-900 dark:text-white flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" />
          1. Ganancia de todo lo vendido
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-5 rounded-2xl bg-zinc-100/90 dark:bg-zinc-900/90 border border-zinc-200/80 dark:border-white/5 flex flex-col justify-between">
            <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Ventas totales</span>
            <span className="text-2xl sm:text-3xl font-extrabold text-zinc-900 dark:text-white mt-2">
              {formatCurrency(totalSales)}
            </span>
          </div>

          <div className="p-5 rounded-2xl bg-zinc-100/90 dark:bg-zinc-900/90 border border-zinc-200/80 dark:border-white/5 flex flex-col justify-between">
            <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Costo de la mercancía</span>
            <span className="text-2xl sm:text-3xl font-extrabold text-zinc-900 dark:text-white mt-2">
              {formatCurrency(totalCost)}
            </span>
          </div>

          <div className="p-5 rounded-2xl bg-emerald-100/80 dark:bg-emerald-950/40 border border-emerald-300/80 dark:border-emerald-500/30 flex flex-col justify-between">
            <span className="text-sm font-semibold text-emerald-900 dark:text-emerald-300">Ganancia bruta</span>
            <span className="text-2xl sm:text-3xl font-black text-emerald-950 dark:text-emerald-200 mt-2">
              {formatCurrency(grossProfit)}
            </span>
          </div>
        </div>
      </section>

      {/* 2. GASTOS DEL NEGOCIO (SIN PROVEEDORES) */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold text-zinc-900 dark:text-white flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block" />
          2. Gastos del negocio (sin proveedores)
        </h2>

        <div className="flex flex-col gap-3">
          {[
            {
              id: 'services',
              name: "Servicios públicos (Luz, Agua, Gas, Internet)",
              amount: publicServices,
              items: (data?.opExpenseItems || []).filter((i: any) => {
                const c = (i.category + ' ' + i.description).toUpperCase();
                return c.includes('SERVICIO') || c.includes('LUZ') || c.includes('INTERNET') || c.includes('TELEFONO') || c.includes('ENEL') || c.includes('EPM') || c.includes('VANTI') || (c.includes('AGUA') && !c.includes('AGUA MIA'));
              })
            },
            {
              id: 'rent',
              name: "Arriendo del local",
              amount: rent,
              items: (data?.opExpenseItems || []).filter((i: any) => {
                const c = (i.category + ' ' + i.description).toUpperCase();
                return c.includes('ARRIENDO') || c.includes('ALQUILER') || c.includes('RENTA') || c.includes('LOCAL') || c.includes('INMUEBLE');
              })
            },
            {
              id: 'payroll',
              name: "Sueldos y nómina",
              amount: payroll,
              items: (data?.opExpenseItems || []).filter((i: any) => {
                const c = (i.category + ' ' + i.description).toUpperCase();
                return c.includes('SUELDO') || c.includes('NOMINA') || c.includes('PERSONAL') || c.includes('EMPLEADO') || c.includes('SALARIO') || c.includes('QUINCENA');
              })
            },
            {
              id: 'maintenance',
              name: "Imprevistos, arreglos y daños del local",
              amount: maintenance,
              items: (data?.opExpenseItems || []).filter((i: any) => {
                const c = (i.category + ' ' + i.description).toUpperCase();
                return c.includes('IMPREVISTO') || c.includes('ARREGLO') || c.includes('DANO') || c.includes('MANTENIMIENTO') || c.includes('REPARAC');
              })
            },
            {
              id: 'other',
              name: "Otros gastos varios del local",
              amount: otherOp,
              items: (data?.opExpenseItems || []).filter((i: any) => {
                const c = (i.category + ' ' + i.description).toUpperCase();
                const isR = c.includes('ARRIENDO') || c.includes('ALQUILER') || c.includes('RENTA') || c.includes('LOCAL');
                const isS = c.includes('SERVICIO') || c.includes('LUZ') || c.includes('INTERNET') || c.includes('TELEFONO') || c.includes('ENEL') || c.includes('EPM') || c.includes('VANTI') || (c.includes('AGUA') && !c.includes('AGUA MIA'));
                const isP = c.includes('SUELDO') || c.includes('NOMINA') || c.includes('PERSONAL') || c.includes('EMPLEADO') || c.includes('SALARIO') || c.includes('QUINCENA');
                const isM = c.includes('IMPREVISTO') || c.includes('ARREGLO') || c.includes('DANO') || c.includes('MANTENIMIENTO') || c.includes('REPARAC');
                return !isR && !isS && !isP && !isM;
              })
            },
          ].map((group, idx) => (
            <div key={idx} className="rounded-2xl border border-zinc-200/80 dark:border-white/10 overflow-hidden bg-white dark:bg-zinc-900 flex flex-col">
              <div className="flex items-center justify-between p-4 bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-200/80 dark:border-white/5">
                <span className="text-base text-zinc-900 dark:text-white font-bold flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-rose-500 inline-block" />
                  {group.name}
                </span>
                <span className="text-base font-black text-rose-600 dark:text-rose-400">{formatCurrency(group.amount)}</span>
              </div>

              {group.items.length > 0 ? (
                <div className="divide-y divide-zinc-200/60 dark:divide-white/5">
                  {group.items.map((item: any, i: number) => (
                    <div key={i} className="flex items-center justify-between p-3 pl-8 text-xs hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30 transition-colors">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-semibold text-zinc-800 dark:text-zinc-200">{item.description || item.category}</span>
                        <span className="text-[10px] text-zinc-400 font-mono">{item.date ? new Date(item.date).toLocaleDateString('es-CO') : '-'}</span>
                      </div>
                      <span className="font-bold text-zinc-700 dark:text-zinc-300">{formatCurrency(item.amount)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-3 pl-8 text-xs text-zinc-400 italic">No hay egresos registrados en este rubro durante el período.</div>
              )}
            </div>
          ))}
        </div>

        {/* Total Destacado Rojo */}
        <div className="p-4 rounded-2xl bg-rose-100/90 dark:bg-rose-950/40 border border-rose-300/80 dark:border-rose-500/30 flex items-center justify-between mt-1">
          <span className="text-base sm:text-lg font-bold text-rose-900 dark:text-rose-300">Total de gastos del negocio</span>
          <span className="text-xl sm:text-2xl font-black text-rose-950 dark:text-rose-200">{formatCurrency(totalOpExpenses)}</span>
        </div>
      </section>

      {/* 3. MOVIMIENTO DE EFECTIVO (CAJA) */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold text-zinc-900 dark:text-white flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-sky-500 inline-block" />
          3. Movimiento del efectivo (caja)
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-4 rounded-2xl bg-zinc-100/90 dark:bg-zinc-900/90 border border-zinc-200/80 dark:border-white/5 flex flex-col justify-between">
            <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">Efectivo que entró</span>
            <span className="text-xl sm:text-2xl font-bold text-zinc-900 dark:text-white mt-2">{formatCurrency(totalCashInflows)}</span>
          </div>

          <div className="p-4 rounded-2xl bg-zinc-100/90 dark:bg-zinc-900/90 border border-zinc-200/80 dark:border-white/5 flex flex-col justify-between">
            <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">Efectivo gastado local</span>
            <span className="text-xl sm:text-2xl font-bold text-zinc-900 dark:text-white mt-2">{formatCurrency(cashExpenses)}</span>
          </div>

          <div className="p-4 rounded-2xl bg-zinc-100/90 dark:bg-zinc-900/90 border border-zinc-200/80 dark:border-white/5 flex flex-col justify-between">
            <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">Prestado a clientes (fiado)</span>
            <span className="text-xl sm:text-2xl font-bold text-zinc-900 dark:text-white mt-2">{formatCurrency(creditSales)}</span>
          </div>

          <div className="p-4 rounded-2xl bg-zinc-100/90 dark:bg-zinc-900/90 border border-zinc-200/80 dark:border-white/5 flex flex-col justify-between">
            <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">Ventas por transferencia</span>
            <span className="text-xl sm:text-2xl font-bold text-zinc-900 dark:text-white mt-2">{formatCurrency(transferSales)}</span>
          </div>
        </div>
      </section>

      {/* 4. CARTERA Y DEUDAS */}
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-bold text-zinc-900 dark:text-white flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" />
          4. A quién se le debe y quién debe
        </h2>

        {/* 4.1 PLATA QUE LOS CLIENTES LE DEBEN (FIADOS) */}
        <div className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-zinc-600 dark:text-zinc-400">Plata que los clientes le deben a usted (fiado)</span>
          
          <div className="p-4 rounded-2xl bg-amber-100/90 dark:bg-amber-950/40 border border-amber-300/80 dark:border-amber-500/30 flex items-center justify-between">
            <span className="text-base sm:text-lg font-bold text-amber-900 dark:text-amber-300">Total por cobrar</span>
            <span className="text-xl sm:text-2xl font-black text-amber-950 dark:text-amber-200">{formatCurrency(totalCreditReceivable)}</span>
          </div>

          {creditReceivables.length > 0 ? (
            <div className="rounded-2xl border border-zinc-200/80 dark:border-white/10 overflow-hidden bg-white dark:bg-zinc-900">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 font-semibold border-b border-zinc-200 dark:border-white/5">
                    <th className="p-3">Cliente</th>
                    <th className="p-3">Cédula</th>
                    <th className="p-3 hidden sm:table-cell">Teléfono</th>
                    <th className="p-3 text-right">Debe</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleClients.map((client: any, i: number) => (
                    <tr key={i} className="border-b border-zinc-200/60 dark:border-white/5 last:border-b-0 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors">
                      <td className="p-3 font-medium text-zinc-900 dark:text-white">{client.clientName}</td>
                      <td className="p-3 text-zinc-600 dark:text-zinc-400 font-mono">{client.clientDNI || '-'}</td>
                      <td className="p-3 text-zinc-600 dark:text-zinc-400 hidden sm:table-cell">{client.phone || '-'}</td>
                      <td className="p-3 text-right font-bold text-amber-600 dark:text-amber-400">{formatCurrency(client.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {creditReceivables.length > 5 && (
                <div className="p-2 text-center bg-zinc-50 dark:bg-zinc-800/50 border-t border-zinc-200/80 dark:border-white/5">
                  <Button
                    size="sm"
                    variant="light"
                    onPress={() => setShowAllClients(!showAllClients)}
                    className="text-xs font-semibold text-zinc-600 dark:text-zinc-300 flex items-center gap-1 mx-auto"
                  >
                    {showAllClients ? (
                      <>Ver menos <ChevronUp size={14} /></>
                    ) : (
                      <>Ver todos ({creditReceivables.length} clientes) <ChevronDown size={14} /></>
                    )}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-zinc-500 italic px-2">No hay saldo de fiados registrado en este período.</p>
          )}
        </div>

        {/* 4.2 PLATA QUE EL NEGOCIO DEBE */}
        <div className="flex flex-col gap-2 pt-2">
          <span className="text-sm font-semibold text-zinc-600 dark:text-zinc-400">Plata que el negocio debe (proveedores o préstamos)</span>

          <div className="p-4 rounded-2xl bg-zinc-100/90 dark:bg-zinc-900/90 border border-zinc-200/80 dark:border-white/5 flex items-center justify-between">
            <span className="text-base sm:text-lg font-bold text-zinc-800 dark:text-zinc-200">Total por pagar</span>
            <span className="text-xl sm:text-2xl font-black text-zinc-900 dark:text-white">{formatCurrency(totalDebtsPayable)}</span>
          </div>

          {debtsPayable.length > 0 ? (
            <div className="rounded-2xl border border-zinc-200/80 dark:border-white/10 overflow-hidden bg-white dark:bg-zinc-900">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 font-semibold border-b border-zinc-200 dark:border-white/5">
                    <th className="p-3">A quién se le debe</th>
                    <th className="p-3">Concepto / Detalle</th>
                    <th className="p-3 text-right">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleDebts.map((debt: any, i: number) => (
                    <tr key={i} className="border-b border-zinc-200/60 dark:border-white/5 last:border-b-0 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors">
                      <td className="p-3 font-bold text-zinc-900 dark:text-white">
                        {debt.providerName || debt.creditor || 'Acreedor Varios'}
                      </td>
                      <td className="p-3 text-zinc-600 dark:text-zinc-400 font-medium">
                        {debt.concept || debt.description || 'Deuda pendiente'}
                      </td>
                      <td className="p-3 text-right font-bold text-rose-600 dark:text-rose-400">{formatCurrency(debt.balance || debt.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {debtsPayable.length > 5 && (
                <div className="p-2 text-center bg-zinc-50 dark:bg-zinc-800/50 border-t border-zinc-200/80 dark:border-white/5">
                  <Button
                    size="sm"
                    variant="light"
                    onPress={() => setShowAllDebts(!showAllDebts)}
                    className="text-xs font-semibold text-zinc-600 dark:text-zinc-300 flex items-center gap-1 mx-auto"
                  >
                    {showAllDebts ? (
                      <>Ver menos <ChevronUp size={14} /></>
                    ) : (
                      <>Ver todos ({debtsPayable.length} acreedores) <ChevronDown size={14} /></>
                    )}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-zinc-500 italic px-2">No hay deudas a proveedores pendientes en este período.</p>
          )}
        </div>
      </section>

      {/* 5. RESULTADO FINAL */}
      <section className="flex flex-col gap-3 pt-2">
        <h2 className="text-lg font-bold text-zinc-900 dark:text-white flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" />
          5. Con lo pagado, esto quedó
        </h2>

        <div className="p-6 sm:p-8 rounded-3xl bg-emerald-100/90 dark:bg-emerald-950/50 border-2 border-emerald-400/80 dark:border-emerald-500/40 text-center flex flex-col items-center justify-center gap-2 shadow-sm">
          <p className="text-sm sm:text-base font-semibold text-emerald-800 dark:text-emerald-300">
            Ganancia bruta ({formatCurrency(grossProfit)}) menos gastos del negocio ({formatCurrency(totalOpExpenses)})
          </p>

          <span className="text-3xl sm:text-5xl font-black text-emerald-950 dark:text-emerald-100 tracking-tight my-1">
            {formatCurrency(netProfit)}
          </span>

          <span className="text-sm font-bold text-emerald-800 dark:text-emerald-300 uppercase tracking-wider bg-emerald-200/80 dark:bg-emerald-900/60 px-4 py-1.5 rounded-full">
            Ganancia libre del período
          </span>
        </div>
      </section>

    </div>
  );
}
