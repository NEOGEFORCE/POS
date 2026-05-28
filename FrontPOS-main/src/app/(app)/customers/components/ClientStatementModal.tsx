"use client";

import React, { useEffect, useState, useMemo } from 'react';
import {
    Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
    Button, Spinner, Card, CardBody, Chip, Divider, ScrollShadow, Tabs, Tab
} from "@heroui/react";
import { 
    FileText, 
    Printer, 
    Calendar, 
    ArrowUpRight, 
    ArrowDownLeft, 
    CreditCard, 
    History,
    AlertCircle,
    CheckCircle2,
    BookOpen,
    Receipt,
    Wallet,
    Trash
} from 'lucide-react';
import { Customer, Sale, CreditPayment } from '@/lib/definitions';
import { apiFetch, extractApiError } from '@/lib/api-error';
import { toast } from "@/hooks/use-toast";
import Cookies from 'js-cookie';

interface StatementData {
    client: Customer;
    pending: Sale[];
    payments: CreditPayment[];
    historySales?: Sale[];
    historyPayments?: CreditPayment[];
}

interface Props {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    customer: Customer | null;
}

export default function ClientStatementModal({ isOpen, onOpenChange, customer }: Props) {
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState<StatementData | null>(null);
    const [activeTab, setActiveTab] = useState("saldo");
    const [isDeleting, setIsDeleting] = useState<number | null>(null);

    const handleDeletePayment = async (id: number | string) => {
        if (!confirm("¿Está seguro de anular este abono? El saldo de la deuda se recalculará.")) return;
        setIsDeleting(Number(id));
        const token = Cookies.get('org-pos-token');
        try {
            const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/clients/delete-credit-payment/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) {
                const errorMsg = await extractApiError(res, "Error al anular abono");
                throw new Error(errorMsg);
            }
            toast({ variant: "success", title: "Abono anulado", description: "El saldo ha sido recalculado" });
            loadStatement();
        } catch (err: any) {
            toast({ variant: "destructive", title: "Error", description: err.message });
        } finally {
            setIsDeleting(null);
        }
    };

    const loadStatement = async () => {
        if (!customer) return;
        setLoading(true);
        const token = Cookies.get('org-pos-token');
        try {
            const result = await apiFetch(`/clients/get-statement/${customer.dni}`, {
                method: 'GET'
            }, token!);
            setData(result);
        } catch (error) {
            console.error("Error loading statement:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen && customer) {
            loadStatement();
            setActiveTab("saldo");
        }
    }, [isOpen, customer]);

    // Libro Mayor: merge historySales + historyPayments cronológicamente
    const libroMayorEntries = useMemo(() => {
        if (!data) return [];
        const entries: { date: Date; type: 'VENTA' | 'ABONO'; amount: number; detail: string; balance: number; id: number | string }[] = [];

        const allSales = data.historySales || [];
        const allPayments = data.historyPayments || [];

        // Unificar todas las entradas
        allSales.forEach(s => {
            entries.push({
                date: new Date(s.date),
                type: 'VENTA',
                amount: s.creditAmount || s.debtPending || 0,
                detail: s.details?.map(d => d.product?.productName || d.barcode).join(', ') || `Factura #${s.id}`,
                balance: 0,
                id: s.id
            });
        });

        allPayments.forEach(p => {
            entries.push({
                date: new Date(p.paymentDate),
                type: 'ABONO',
                amount: p.totalPaid,
                detail: p.amountCash > 0 ? 'Efectivo' : p.transferSource || 'Transferencia',
                balance: 0,
                id: p.id
            });
        });

        // Ordenar cronológicamente (más antiguo primero)
        entries.sort((a, b) => a.date.getTime() - b.date.getTime());

        // Calcular saldo acumulado (running balance)
        let runningBalance = 0;
        entries.forEach(e => {
            if (e.type === 'VENTA') {
                runningBalance += e.amount;
            } else {
                runningBalance -= e.amount;
            }
            e.balance = Math.max(0, runningBalance);
        });

        return entries;
    }, [data]);

    // Calcular facturas pendientes cronológicas reales basado en el pool de abonos
    const dynamicPendingInvoices = useMemo(() => {
        if (!data) return [];
        let remainingPayments = data.historyPayments?.reduce((sum, p) => sum + p.totalPaid, 0) || 0;
        
        // Clonar y ordenar facturas desde la más antigua a la más nueva
        const salesOldestFirst = [...(data.historySales || [])].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        
        const pending: Sale[] = [];
        for (const sale of salesOldestFirst) {
            // Asumimos que solo las ventas a CRÉDITO entran acá, si paymentMethod existiera. Si no, usamos creditAmount > 0
            const saleTotal = sale.creditAmount || sale.debtPending || 0;
            if (saleTotal <= 0) continue; // Si la venta no fue a crédito, saltar
            
            if (remainingPayments >= saleTotal) {
                // Totalmente pagada
                remainingPayments -= saleTotal;
            } else {
                // Parcial o totalmente pendiente
                const currentDebt = saleTotal - remainingPayments;
                remainingPayments = 0;
                if (currentDebt > 0) {
                    pending.push({
                        ...sale,
                        debtPending: currentDebt
                    });
                }
            }
        }
        
        // Devolver ordenadas de la más reciente a la más antigua para mostrar
        return pending.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    }, [data]);

    // Total abonado historial
    const totalAbonado = useMemo(() => {
        if (!data?.historyPayments) return 0;
        return data.historyPayments.reduce((sum, p) => sum + p.totalPaid, 0);
    }, [data]);

    const totalFiado = useMemo(() => {
        if (!data?.historySales) return 0;
        return data.historySales.reduce((sum, s) => sum + (s.creditAmount || 0), 0);
    }, [data]);

    const handlePrint = () => {
        if (!data) return;
        const printWindow = window.open('', '_blank');
        if (!printWindow) return;

        const html = `
            <html>
                <head>
                    <title>Estado de Cuenta - ${data.client.name}</title>
                    <style>
                        body { font-family: 'Inter', sans-serif; padding: 40px; color: #111; }
                        .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #eee; padding-bottom: 20px; }
                        .info { display: flex; justify-content: space-between; margin-bottom: 30px; }
                        .balance-card { background: #f9fafb; padding: 20px; border-radius: 12px; text-align: center; margin-bottom: 30px; }
                        .section-title { font-size: 14px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0 10px; color: #666; }
                        table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
                        th { background: #f4f4f5; padding: 12px; text-align: left; font-size: 11px; text-transform: uppercase; }
                        td { padding: 12px; border-bottom: 1px solid #eee; font-size: 12px; }
                        .text-right { text-align: right; }
                        .total { font-weight: 800; font-size: 16px; color: #e11d48; }
                        .abono { color: #059669; }
                        .footer { margin-top: 50px; font-size: 10px; color: #999; text-align: center; }
                        @media print { .no-print { display: none; } }
                    </style>
                </head>
                <body>
                    <div class="header">
                        <h1>LIBRO MAYOR - ESTADO DE CUENTA</h1>
                        <p>GENERADO EL ${new Date().toLocaleDateString()}</p>
                    </div>
                    <div class="info">
                        <div>
                            <strong>CLIENTE:</strong> ${data.client.name}<br>
                            <strong>DNI/CC:</strong> ${data.client.dni}<br>
                            <strong>TELÉFONO:</strong> ${data.client.phone || 'N/A'}
                        </div>
                        <div class="text-right">
                            <strong>LÍMITE CRÉDITO:</strong> $${data.client.creditLimit.toLocaleString()}<br>
                            <span class="total">DEUDA ACTUAL: $${data.client.currentCredit.toLocaleString()}</span>
                        </div>
                    </div>

                    <div class="section-title">Facturas Pendientes</div>
                    <table>
                        <thead>
                            <tr>
                                <th>Fecha / ID</th>
                                <th>Detalle de Productos</th>
                                <th class="text-right">Saldo</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${dynamicPendingInvoices.map(s => `
                                <tr>
                                    <td style="vertical-align: top;">
                                        <strong>${new Date(s.date).toLocaleDateString()}</strong><br>
                                        <small>#${s.id}</small>
                                    </td>
                                    <td style="vertical-align: top;">
                                        ${s.details?.map(d => `
                                            <div style="display: flex; justify-content: space-between; font-size: 10px; margin-bottom: 2px;">
                                                <span>${d.product?.productName || d.barcode}</span>
                                                <strong>x${d.quantity}</strong>
                                            </div>
                                        `).join('') || 'Sin detalle'}
                                    </td>
                                    <td class="text-right total" style="vertical-align: top;">
                                        $${(s.debtPending ?? s.creditAmount).toLocaleString()}
                                    </td>
                                </tr>
                            `).join('')}
                            ${dynamicPendingInvoices.length === 0 ? '<tr><td colspan="3" style="text-align:center">No hay facturas pendientes</td></tr>' : ''}
                        </tbody>
                    </table>

                    <div class="section-title">Libro Mayor (Historial Completo)</div>
                    <table>
                        <thead>
                            <tr>
                                <th>Fecha</th>
                                <th>Tipo</th>
                                <th>Detalle</th>
                                <th class="text-right">Débito</th>
                                <th class="text-right">Crédito</th>
                                <th class="text-right">Saldo</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${libroMayorEntries.map(e => `
                                <tr>
                                    <td>${e.date.toLocaleDateString()}</td>
                                    <td>${e.type === 'VENTA' ? '📤 Venta' : '💰 Abono'}</td>
                                    <td>${e.detail}</td>
                                    <td class="text-right total">${e.type === 'VENTA' ? '$' + e.amount.toLocaleString() : ''}</td>
                                    <td class="text-right abono">${e.type === 'ABONO' ? '$' + e.amount.toLocaleString() : ''}</td>
                                    <td class="text-right"><strong>$${e.balance.toLocaleString()}</strong></td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>

                    <div class="footer">
                        Este documento es un informativo del estado de su cuenta a la fecha. 
                        Gracias por su puntualidad en los pagos.
                    </div>
                    <script>window.print();</script>
                </body>
            </html>
        `;

        printWindow.document.write(html);
        printWindow.document.close();
    };

    return (
        <Modal 
            isOpen={isOpen} 
            onOpenChange={onOpenChange}
            size="5xl"
            backdrop="blur"
            classNames={{
                base: "bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-[32px]",
                header: "border-b border-gray-200 dark:border-white/5 pb-4",
                body: "py-4",
                footer: "border-t border-gray-200 dark:border-white/5 pt-4"
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="flex flex-col gap-1">
                            <div className="flex items-center gap-3">
                                <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                                    <BookOpen size={22} />
                                </div>
                                <div className="flex flex-col">
                                    <h2 className="text-lg font-medium uppercase tracking-tight tracking-tight">Libro Mayor</h2>
                                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest leading-none">Estado de Cuenta Integral</p>
                                </div>
                            </div>
                        </ModalHeader>
                        <ModalBody>
                            {loading ? (
                                <div className="h-64 w-full flex items-center justify-center">
                                    <Spinner color="success" size="lg" />
                                </div>
                            ) : data ? (
                                <div className="flex flex-col gap-4">
                                    {/* Info del cliente compacta */}
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                        <div className="p-3 rounded-2xl card-base border-none border border-gray-100 dark:border-white/5">
                                            <span className="text-[8px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-[0.2em]">Cliente</span>
                                            <p className="text-sm font-medium uppercase truncate">{data.client.name}</p>
                                            <span className="text-[9px] text-gray-400">CC: {data.client.dni}</span>
                                        </div>
                                        <div className="p-3 rounded-2xl bg-rose-500/5 border border-rose-500/10">
                                            <span className="text-[8px] font-medium text-rose-500 uppercase tracking-[0.2em]">Deuda Actual</span>
                                            <p className="text-lg font-medium text-rose-600 dark:text-rose-400 tracking-tight">
                                                $ {data.client.currentCredit.toLocaleString()}
                                            </p>
                                        </div>
                                        <div className="p-3 rounded-2xl bg-blue-500/5 border border-blue-500/10">
                                            <span className="text-[8px] font-medium text-blue-500 uppercase tracking-[0.2em]">Límite Crédito</span>
                                            <p className="text-lg font-medium text-blue-600 dark:text-blue-400">
                                                $ {data.client.creditLimit.toLocaleString()}
                                            </p>
                                        </div>
                                        <div className="p-3 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 border border-emerald-500/10">
                                            <span className="text-[8px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-[0.2em]">Total Abonado</span>
                                            <p className="text-lg font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-300">
                                                $ {totalAbonado.toLocaleString()}
                                            </p>
                                        </div>
                                    </div>

                                    {/* Tabs */}
                                    <Tabs 
                                        selectedKey={activeTab} 
                                        onSelectionChange={(key) => setActiveTab(String(key))}
                                        variant="underlined"
                                        classNames={{
                                            tabList: "gap-4 w-full relative rounded-none p-0 border-b border-gray-200 dark:border-white/5",
                                            cursor: "w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5",
                                            tab: "max-w-fit px-0 h-10",
                                            tabContent: "group-data-[selected=true]:text-zinc-900 dark:text-zinc-100 text-[10px] font-medium uppercase tracking-widest"
                                        }}
                                    >
                                        {/* TAB 1: Saldo Actual */}
                                        <Tab key="saldo" title={
                                            <div className="flex items-center gap-2">
                                                <Wallet size={14} />
                                                <span>Saldo Actual</span>
                                                {dynamicPendingInvoices.length > 0 && (
                                                    <Chip size="sm" className="bg-rose-500 text-white font-medium text-[8px] h-4 min-w-4">{dynamicPendingInvoices.length}</Chip>
                                                )}
                                            </div>
                                        }>
                                            <div className="flex flex-col gap-4 pt-2">
                                                {/* Facturas Pendientes */}
                                                <div className="flex items-center gap-2 px-1">
                                                    <ArrowUpRight size={14} className="text-rose-500" />
                                                    <span className="text-[10px] font-medium uppercase tracking-widest tracking-tight">Facturas Pendientes</span>
                                                    <Chip size="sm" className="bg-rose-500 text-white font-medium text-[9px] h-5">{dynamicPendingInvoices.length}</Chip>
                                                </div>
                                                <ScrollShadow className="max-h-[250px] rounded-2xl border border-gray-100 dark:border-white/5 bg-white/50 dark:bg-[#18181b]/50">
                                                    <table className="w-full text-left text-[11px] border-separate border-spacing-0">
                                                        <thead className="sticky top-0 bg-gray-50 dark:bg-zinc-950 z-10 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                                                            <tr>
                                                                <th className="px-4 py-3 font-medium text-gray-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5">Fecha</th>
                                                                <th className="px-4 py-3 font-medium text-gray-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5">Factura</th>
                                                                <th className="px-4 py-3 font-medium text-gray-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5">Venta Original</th>
                                                                <th className="px-4 py-3 font-medium text-gray-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5 text-right">Saldo Pendiente</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {dynamicPendingInvoices.map((s) => (
                                                                <tr key={s.id} className="hover:bg-rose-500/5 transition-colors group">
                                                                    <td className="px-4 py-3 font-bold tabular-nums align-top">
                                                                        <div className="flex flex-col">
                                                                            <span>{new Date(s.date).toLocaleDateString()}</span>
                                                                            <span className="text-[9px] text-gray-400 font-medium tracking-tighter">#{s.id}</span>
                                                                        </div>
                                                                    </td>
                                                                    <td className="px-4 py-3 align-top max-w-[200px]">
                                                                        <div className="flex flex-col gap-1">
                                                                            {s.details?.map((d, i) => (
                                                                                <div key={i} className="flex justify-between items-center gap-2 border-b border-gray-100 dark:border-white/5 last:border-0 pb-1">
                                                                                    <span className="text-[10px] font-medium uppercase text-gray-600 dark:text-zinc-400 truncate">
                                                                                        {d.product?.productName || d.barcode}
                                                                                    </span>
                                                                                    <span className="text-[9px] font-bold text-zinc-900 dark:text-zinc-100 shrink-0">
                                                                                        x{d.quantity}
                                                                                    </span>
                                                                                </div>
                                                                            ))}
                                                                        </div>
                                                                    </td>
                                                                    <td className="px-4 py-3 align-top text-[10px] font-bold text-gray-500 tabular-nums">
                                                                        $ {(s.creditAmount || 0).toLocaleString()}
                                                                    </td>
                                                                    <td className="px-4 py-3 text-right font-medium text-rose-500 group-hover:scale-105 transition-transform origin-right align-top">
                                                                        $ {(s.debtPending ?? s.creditAmount).toLocaleString()}
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                            {dynamicPendingInvoices.length === 0 && (
                                                                <tr>
                                                                    <td colSpan={4} className="px-4 py-8 text-center text-gray-400 tracking-tight">
                                                                        <CheckCircle2 size={20} className="inline mr-2 text-zinc-900 dark:text-zinc-100" />
                                                                        No hay deudas activas — Cliente al día
                                                                    </td>
                                                                </tr>
                                                            )}
                                                        </tbody>
                                                    </table>
                                                </ScrollShadow>

                                                {/* Abonos del ciclo actual */}
                                                <div className="flex items-center gap-2 px-1 mt-2">
                                                    <ArrowDownLeft size={14} className="text-zinc-900 dark:text-zinc-100" />
                                                    <span className="text-[10px] font-medium uppercase tracking-widest tracking-tight">Abonos del Ciclo</span>
                                                    <Chip size="sm" className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white font-medium text-[9px] h-5">{data.payments.length}</Chip>
                                                </div>
                                                <ScrollShadow className="max-h-[180px] rounded-2xl border border-gray-100 dark:border-white/5 bg-white/50 dark:bg-[#18181b]/50">
                                                    <table className="w-full text-left text-[11px] border-separate border-spacing-0">
                                                        <thead className="sticky top-0 bg-gray-50 dark:bg-zinc-950 z-10 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                                                            <tr>
                                                                <th className="px-4 py-3 font-medium text-gray-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5">Fecha</th>
                                                                <th className="px-4 py-3 font-medium text-gray-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5">Método</th>
                                                                <th className="px-4 py-3 font-medium text-gray-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5 text-right">Monto</th>
                                                                <th className="px-4 py-3 font-medium text-gray-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5 text-center w-12">Anular</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {data.payments.map((p) => (
                                                                <tr key={p.id} className="hover:bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 transition-colors group">
                                                                    <td className="px-4 py-3 font-bold tabular-nums">{new Date(p.paymentDate).toLocaleDateString()}</td>
                                                                    <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100 uppercase text-[9px]">
                                                                        {p.amountCash > 0 ? 'Efectivo' : p.transferSource || 'Transf.'}
                                                                    </td>
                                                                    <td className="px-4 py-3 text-right font-medium text-zinc-900 dark:text-zinc-100 group-hover:scale-105 transition-transform origin-right">
                                                                        $ {p.totalPaid.toLocaleString()}
                                                                    </td>
                                                                    <td className="px-4 py-3 text-center">
                                                                        <Button isIconOnly size="sm" color="danger" variant="light" className="min-w-6 w-6 h-6 p-0 text-rose-500 hover:bg-rose-500/10" onPress={() => handleDeletePayment(p.id)} isLoading={isDeleting === p.id}>
                                                                            <Trash size={12} />
                                                                        </Button>
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                            {data.payments.length === 0 && (
                                                                <tr>
                                                                    <td colSpan={3} className="px-4 py-8 text-center text-gray-400 tracking-tight">No se registran abonos en este ciclo</td>
                                                                </tr>
                                                            )}
                                                        </tbody>
                                                    </table>
                                                </ScrollShadow>
                                            </div>
                                        </Tab>

                                        {/* TAB 2: Libro Mayor (Historial Completo) */}
                                        <Tab key="libromayor" title={
                                            <div className="flex items-center gap-2">
                                                <BookOpen size={14} />
                                                <span>Libro Mayor</span>
                                                <Chip size="sm" className="bg-purple-500 text-white font-medium text-[8px] h-4 min-w-4">{libroMayorEntries.length}</Chip>
                                            </div>
                                        }>
                                            <div className="flex flex-col gap-4 pt-2">
                                                {/* Resumen del historial */}
                                                <div className="grid grid-cols-3 gap-3">
                                                    <div className="p-3 rounded-2xl bg-rose-500/5 border border-rose-500/10 text-center">
                                                        <span className="text-[8px] font-medium text-rose-500 uppercase tracking-widest">Total Fiado</span>
                                                        <p className="text-sm font-medium text-rose-600 dark:text-rose-400">$ {totalFiado.toLocaleString()}</p>
                                                    </div>
                                                    <div className="p-3 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 border border-emerald-500/10 text-center">
                                                        <span className="text-[8px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-widest">Total Abonado</span>
                                                        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-300">$ {totalAbonado.toLocaleString()}</p>
                                                    </div>
                                                    <div className="p-3 rounded-2xl bg-amber-500/5 border border-amber-500/10 text-center">
                                                        <span className="text-[8px] font-medium text-amber-500 uppercase tracking-widest">Movimientos</span>
                                                        <p className="text-sm font-medium text-amber-600 dark:text-amber-400">{libroMayorEntries.length}</p>
                                                    </div>
                                                </div>

                                                {/* Tabla cronológica tipo Libro Mayor */}
                                                <ScrollShadow className="max-h-[350px] rounded-2xl border border-gray-100 dark:border-white/5 bg-white/50 dark:bg-[#18181b]/50">
                                                    <table className="w-full text-left text-[11px] border-separate border-spacing-0">
                                                        <thead className="sticky top-0 bg-gray-50 dark:bg-zinc-950 z-10 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                                                            <tr>
                                                                <th className="px-3 py-3 font-medium text-gray-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5">Fecha</th>
                                                                <th className="px-3 py-3 font-medium text-gray-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5">Tipo</th>
                                                                <th className="px-3 py-3 font-medium text-gray-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5">Detalle</th>
                                                                <th className="px-3 py-3 font-medium text-rose-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5 text-right">Débito</th>
                                                                <th className="px-3 py-3 font-medium text-zinc-300 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5 text-right">Crédito</th>
                                                                <th className="px-3 py-3 font-medium text-gray-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5 text-right">Saldo</th>
                                                                <th className="px-3 py-3 font-medium text-gray-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5 text-center w-8">Acción</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {libroMayorEntries.map((entry, idx) => (
                                                                <tr key={`${entry.type}-${entry.id}-${idx}`} className={`transition-colors ${entry.type === 'VENTA' ? 'hover:bg-rose-500/5' : 'hover:bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5'}`}>
                                                                    <td className="px-3 py-2.5 font-bold tabular-nums text-[10px]">
                                                                        {entry.date.toLocaleDateString()}
                                                                    </td>
                                                                    <td className="px-3 py-2.5">
                                                                        <Chip 
                                                                            size="sm" 
                                                                            className={`font-medium text-[8px] h-5 ${
                                                                                entry.type === 'VENTA' 
                                                                                    ? 'bg-rose-500/10 text-rose-500 border border-rose-500/20' 
                                                                                    : 'bg-white/5 text-zinc-900 dark:text-zinc-100 border border-emerald-500/20'
                                                                            }`}
                                                                        >
                                                                            {entry.type === 'VENTA' ? '📤 Fiado' : '💰 Abono'}
                                                                        </Chip>
                                                                    </td>
                                                                    <td className="px-3 py-2.5 text-[10px] font-bold text-gray-600 dark:text-zinc-400 truncate max-w-[180px]">
                                                                        {entry.detail}
                                                                    </td>
                                                                    <td className="px-3 py-2.5 text-right font-medium text-rose-500 tabular-nums">
                                                                        {entry.type === 'VENTA' ? `$ ${entry.amount.toLocaleString()}` : ''}
                                                                    </td>
                                                                    <td className="px-3 py-2.5 text-right font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">
                                                                        {entry.type === 'ABONO' ? `$ ${entry.amount.toLocaleString()}` : ''}
                                                                    </td>
                                                                    <td className="px-3 py-2.5 text-right font-medium tabular-nums text-[10px]">
                                                                        $ {entry.balance.toLocaleString()}
                                                                    </td>
                                                                    <td className="px-3 py-2.5 text-center">
                                                                        {entry.type === 'ABONO' && (
                                                                            <Button isIconOnly size="sm" color="danger" variant="light" className="min-w-6 w-6 h-6 p-0 text-rose-500 hover:bg-rose-500/10" onPress={() => handleDeletePayment(entry.id)} isLoading={isDeleting === entry.id}>
                                                                                <Trash size={12} />
                                                                            </Button>
                                                                        )}
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                            {libroMayorEntries.length === 0 && (
                                                                <tr>
                                                                    <td colSpan={6} className="px-4 py-8 text-center text-gray-400 tracking-tight">
                                                                        No hay movimientos registrados
                                                                    </td>
                                                                </tr>
                                                            )}
                                                        </tbody>
                                                    </table>
                                                </ScrollShadow>
                                            </div>
                                        </Tab>
                                    </Tabs>
                                </div>
                            ) : null}
                        </ModalBody>
                        <ModalFooter>
                            <Button 
                                variant="light" 
                                onPress={onClose}
                                className="font-medium uppercase text-[10px] tracking-widest px-8 rounded-2xl tracking-tight"
                            >
                                Cerrar
                            </Button>
                            <Button 
                                color="success"
                                onPress={handlePrint}
                                isDisabled={!data}
                                className="h-12 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white font-medium uppercase text-[10px] tracking-[0.2em] tracking-tight px-10 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex items-center gap-2"
                            >
                                <Printer size={16} />
                                Imprimir Reporte
                            </Button>
                        </ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
}
