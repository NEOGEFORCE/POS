"use client";

import React, { useEffect, useState, useMemo } from 'react';
import dynamic from 'next/dynamic';
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
    Trash,
    ChevronDown,
    ChevronUp,
    ChevronRight,
    Eye,
    ShoppingBag,
    MessageSquare,
    Pencil,
    ShieldAlert
} from 'lucide-react';
import { Customer, Sale, CreditPayment } from '@/lib/definitions';
import { apiFetch, extractApiError } from '@/lib/api-error';
import { toast } from "@/hooks/use-toast";
import Cookies from 'js-cookie';
import { useAuth } from '@/lib/auth';
import { API_URL } from '@/lib/constants';
import { broadcastRevalidate } from '@/lib/revalidate';

const SaleDetailModal = dynamic(() => import('@/app/(app)/sales/components/SaleDetailModal'), { ssr: false });
const UniversalPaymentModal = dynamic(() => import('@/components/shared/UniversalPaymentModal'), { ssr: false });

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
    const { user } = useAuth();
    const userRole = (user?.role || '').toUpperCase();
    const isAdmin = userRole === 'ADMIN' || userRole === 'SUPERADMIN' || userRole === 'ADMINISTRADOR';

    const [loading, setLoading] = useState(false);
    const [data, setData] = useState<StatementData | null>(null);
    const [activeTab, setActiveTab] = useState("saldo");
    const [isDeleting, setIsDeleting] = useState<number | null>(null);
    const [expandedInvoices, setExpandedInvoices] = useState<Record<string | number, boolean>>({});
    const [selectedSaleForPreview, setSelectedSaleForPreview] = useState<Sale | null>(null);

    const [editingPayment, setEditingPayment] = useState<CreditPayment | null>(null);
    const [selectedNewMethod, setSelectedNewMethod] = useState<string>('EFECTIVO');
    const [isUpdatingMethod, setIsUpdatingMethod] = useState(false);

    const toggleInvoiceExpand = (id: string | number) => {
        setExpandedInvoices(prev => ({
            ...prev,
            [id]: !prev[id]
        }));
    };

    const handleUpdatePaymentMethod = async (id: number | string, newMethod: string) => {
        const token = Cookies.get('org-pos-token');
        try {
            const res = await fetch(`${API_URL}/clients/update-credit-payment/${id}`, {
                method: 'PUT',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}` 
                },
                body: JSON.stringify({ paymentMethod: newMethod })
            });
            if (!res.ok) {
                const errorMsg = await extractApiError(res, "Error al actualizar método de pago");
                throw new Error(errorMsg);
            }
            toast({ variant: "success", title: "Canal Actualizado", description: `Método de pago cambiado a ${newMethod}` });
            loadStatement();
            broadcastRevalidate('CUSTOMER_UPDATE');
            broadcastRevalidate('CLOSURE_MADE');
        } catch (err: any) {
            toast({ variant: "destructive", title: "Error", description: err.message });
        }
    };

    const handleSaveEditPaymentMethod = async (payData: {
        cash: number;
        transfer: number;
        transferSource: string;
        totalPaid: number;
    }) => {
        if (!editingPayment) return;
        setIsUpdatingMethod(true);
        let newMethod = 'EFECTIVO';
        if (payData.transfer > 0) {
            newMethod = (payData.transferSource || 'NEQUI').toUpperCase();
        } else {
            newMethod = 'EFECTIVO';
        }

        try {
            await handleUpdatePaymentMethod(editingPayment.id, newMethod);
            setEditingPayment(null);
        } finally {
            setIsUpdatingMethod(false);
        }
    };

    const handleDeletePayment = async (id: number | string) => {
        if (!confirm("¿Esta seguro de anular este abono? El saldo de la deuda se recalculara.")) return;
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
            broadcastRevalidate('CUSTOMER_UPDATE');
            broadcastRevalidate('CLOSURE_MADE');
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
            setExpandedInvoices({});
        }
    }, [isOpen, customer]);

    // Libro Mayor: merge historySales + historyPayments cronologicamente
    const libroMayorEntries = useMemo(() => {
        if (!data) return [];
        const entries: { date: Date; type: 'VENTA' | 'ABONO'; amount: number; detail: string; balance: number; id: number | string; fullSale?: Sale }[] = [];

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
                id: s.id,
                fullSale: s
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

        // Ordenar cronologicamente (mas antiguo primero)
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

    // Calcular facturas pendientes cronologicas reales basado en el pool de abonos
    const dynamicPendingInvoices = useMemo(() => {
        if (!data) return [];
        let remainingPayments = data.historyPayments?.reduce((sum, p) => sum + p.totalPaid, 0) || 0;
        
        // Clonar y ordenar facturas desde la mas antigua a la mas nueva
        const salesOldestFirst = [...(data.historySales || [])].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        
        const pending: Sale[] = [];
        for (const sale of salesOldestFirst) {
            const saleTotal = sale.creditAmount || sale.debtPending || 0;
            if (saleTotal <= 0) continue;
            
            if (remainingPayments >= saleTotal) {
                remainingPayments -= saleTotal;
            } else {
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
        
        return pending.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    }, [data]);

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
                            <strong>TELEFONO:</strong> ${data.client.phone || 'N/A'}
                        </div>
                        <div class="text-right">
                            <strong>LIMITE CREDITO:</strong> $${data.client.creditLimit.toLocaleString()}<br>
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
                                <th class="text-right">Debito</th>
                                <th class="text-right">Credito</th>
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

    const handleSendDebtReminder = () => {
        if (!data || !data.client) return;

        const currentDebt = data.client.currentCredit || 0;
        if (currentDebt <= 0) {
            toast({
                variant: "default",
                title: "Sin deuda pendiente",
                description: "Este cliente se encuentra al día y no registra saldo pendiente."
            });
            return;
        }

        const clientName = data.client.name || 'Cliente';
        const oldestPendingInvoice = dynamicPendingInvoices.length > 0 ? dynamicPendingInvoices[dynamicPendingInvoices.length - 1] : null;
        const oldestDateStr = oldestPendingInvoice ? new Date(oldestPendingInvoice.date).toLocaleDateString('es-CO') : 'fecha anterior';
        const pendingCount = dynamicPendingInvoices.length;

        let msg = `👋 *Hola, ${clientName}*\n\n`;
        msg += `Le saludamos de *SISTEMA POS PRO* 🏢\n\n`;
        msg += `📌 *RECORDATORIO DE ESTADO DE CUENTA*\n`;
        msg += `Le informamos cordialmente que presenta un saldo pendiente en su crédito:\n\n`;
        msg += `💰 *Deuda Total:* *$${currentDebt.toLocaleString('es-CO')}*\n`;
        msg += `📅 *Pendiente desde:* ${oldestDateStr}\n`;
        msg += `📄 *Facturas Pendientes:* ${pendingCount} ${pendingCount === 1 ? 'factura' : 'facturas'}\n\n`;
        msg += `Agradecemos su valioso apoyo para ponerse al día con su saldo. Si ya realizó el pago, por favor ignore este mensaje. ¡Muchas gracias por su preferencia! 🙏✨`;

        let rawPhone = data.client.phone?.replace(/\D/g, '') || '';
        if (rawPhone && !rawPhone.startsWith('57') && rawPhone.length === 10) {
            rawPhone = `57${rawPhone}`;
        }

        const url = rawPhone 
            ? `https://wa.me/${rawPhone}?text=${encodeURIComponent(msg)}`
            : `https://wa.me/?text=${encodeURIComponent(msg)}`;
        
        window.open(url, '_blank');
    };

    return (
        <>
        <Modal 
            isOpen={isOpen} 
            onOpenChange={onOpenChange}
            size="5xl"
            backdrop="blur"
            scrollBehavior="inside"
            classNames={{
                base: "bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-[0_20px_60px_rgba(0,0,0,0.3)] rounded-[32px] overflow-hidden max-h-[92vh]",
                header: "border-b border-gray-200 dark:border-white/5 p-6 bg-white dark:bg-[#121215]",
                body: "p-6 bg-gray-50 dark:bg-zinc-950",
                footer: "border-t border-gray-200 dark:border-white/5 p-6 bg-white dark:bg-[#121215]"
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="flex flex-col gap-1">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white shadow-md">
                                        <BookOpen size={22} />
                                    </div>
                                    <div className="flex flex-col">
                                        <h2 className="text-lg font-bold uppercase tracking-tight text-gray-900 dark:text-white">ESTADO DE CUENTA INTEGRAL</h2>
                                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest leading-none">Libro Mayor y Control de Cartera</p>
                                    </div>
                                </div>
                                <Chip variant="flat" color="success" size="sm" startContent={<CheckCircle2 size={12} />} className="font-bold text-[9px] uppercase tracking-wider">
                                    ACTIVO
                                </Chip>
                            </div>
                        </ModalHeader>

                        <ModalBody className="flex flex-col gap-5">
                            {loading ? (
                                <div className="h-64 w-full flex items-center justify-center">
                                    <Spinner color="success" size="lg" />
                                </div>
                            ) : data ? (
                                <div className="flex flex-col gap-5">
                                    {/* CARDS DE METRICAS REDISTRIBUIDAS */}
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                        <div className="p-4 rounded-2xl bg-white dark:bg-[#18181c] border border-gray-200 dark:border-white/5 shadow-sm flex flex-col justify-between">
                                            <span className="text-[9px] font-black text-gray-400 dark:text-zinc-400 uppercase tracking-widest">CLIENTE</span>
                                            <p className="text-sm font-bold text-gray-900 dark:text-white uppercase truncate mt-1">{data.client.name}</p>
                                            <span className="text-[10px] font-mono font-medium text-gray-400">CC: {data.client.dni}</span>
                                        </div>
                                        <div className="p-4 rounded-2xl bg-rose-500/10 dark:bg-rose-500/15 border border-rose-500/20 shadow-sm flex flex-col justify-between relative group">
                                            <div className="flex items-center justify-between">
                                                <span className="text-[9px] font-black text-rose-600 dark:text-rose-400 uppercase tracking-widest">DEUDA ACTUAL</span>
                                                {data.client.currentCredit > 0 && (
                                                    <button 
                                                        type="button"
                                                        onClick={handleSendDebtReminder}
                                                        title="Enviar recordatorio por WhatsApp"
                                                        className="p-1 rounded-lg bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500 hover:text-white transition-colors"
                                                    >
                                                        <MessageSquare size={12} />
                                                    </button>
                                                )}
                                            </div>
                                            <p className="text-xl font-mono font-black text-rose-600 dark:text-rose-400 tracking-tight mt-1">
                                                $ {data.client.currentCredit.toLocaleString()}
                                            </p>
                                            {dynamicPendingInvoices.length > 0 && (
                                                <span className="text-[9px] text-rose-500/80 font-semibold mt-1">
                                                    Desde: {new Date(dynamicPendingInvoices[dynamicPendingInvoices.length - 1].date).toLocaleDateString('es-CO')}
                                                </span>
                                            )}
                                        </div>
                                        <div className="p-4 rounded-2xl bg-indigo-500/10 dark:bg-indigo-500/15 border border-indigo-500/20 shadow-sm flex flex-col justify-between">
                                            <span className="text-[9px] font-black text-indigo-600 dark:text-indigo-400 uppercase tracking-widest">LÍMITE CRÉDITO</span>
                                            <p className="text-xl font-mono font-bold text-indigo-600 dark:text-indigo-400 mt-1">
                                                $ {data.client.creditLimit.toLocaleString()}
                                            </p>
                                        </div>
                                        <div className="p-4 rounded-2xl bg-emerald-500/10 dark:bg-emerald-500/15 border border-emerald-500/20 shadow-sm flex flex-col justify-between">
                                            <span className="text-[9px] font-black text-emerald-600 dark:text-emerald-400 uppercase tracking-widest">TOTAL ABONADO</span>
                                            <p className="text-xl font-mono font-bold text-emerald-600 dark:text-emerald-400 mt-1">
                                                $ {totalAbonado.toLocaleString()}
                                            </p>
                                        </div>
                                    </div>

                                    {/* TABS CON MEJOR DISEÑO */}
                                    <Tabs 
                                        selectedKey={activeTab} 
                                        onSelectionChange={(key) => setActiveTab(String(key))}
                                        variant="underlined"
                                        classNames={{
                                            tabList: "gap-6 w-full relative rounded-none p-0 border-b border-gray-200 dark:border-white/10",
                                            cursor: "w-full bg-emerald-500 h-0.5",
                                            tab: "max-w-fit px-1 h-10",
                                            tabContent: "group-data-[selected=true]:text-emerald-600 dark:group-data-[selected=true]:text-emerald-400 text-xs font-bold uppercase tracking-wider text-gray-400"
                                        }}
                                    >
                                        {/* TAB 1: Saldo Actual */}
                                        <Tab key="saldo" title={
                                            <div className="flex items-center gap-2">
                                                <Wallet size={15} />
                                                <span>Saldo Actual</span>
                                                {dynamicPendingInvoices.length > 0 && (
                                                    <Chip size="sm" color="danger" variant="solid" className="font-bold text-[9px] h-5 min-w-5">{dynamicPendingInvoices.length}</Chip>
                                                )}
                                            </div>
                                        }>
                                            <div className="flex flex-col gap-4 pt-3">
                                                {/* Encabezado Facturas Pendientes */}
                                                <div className="flex items-center justify-between px-1">
                                                    <div className="flex items-center gap-2">
                                                        <ArrowUpRight size={16} className="text-rose-500" />
                                                        <span className="text-xs font-black uppercase tracking-wider text-gray-800 dark:text-white">Facturas Pendientes</span>
                                                        <Chip size="sm" color="danger" variant="flat" className="font-bold text-[10px]">{dynamicPendingInvoices.length}</Chip>
                                                    </div>
                                                    <span className="text-[10px] font-semibold text-gray-400">Clic en la factura para abrir comprobante | 🔽 Vista rápida</span>
                                                </div>

                                                <ScrollShadow className="max-h-[320px] rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#18181c] shadow-sm">
                                                    <table className="w-full text-left text-xs border-separate border-spacing-0">
                                                        <thead className="sticky top-0 bg-gray-100 dark:bg-zinc-900 z-10 border-b border-gray-200 dark:border-white/10">
                                                            <tr className="text-gray-500 dark:text-zinc-400 font-black text-[9px] uppercase tracking-wider">
                                                                <th className="px-4 py-3 border-b border-gray-200 dark:border-white/10 w-10"></th>
                                                                <th className="px-4 py-3 border-b border-gray-200 dark:border-white/10">Fecha / N° Factura</th>
                                                                <th className="px-4 py-3 border-b border-gray-200 dark:border-white/10">Artículos</th>
                                                                <th className="px-4 py-3 border-b border-gray-200 dark:border-white/10 text-right">Venta Original</th>
                                                                <th className="px-4 py-3 border-b border-gray-200 dark:border-white/10 text-right">Saldo Pendiente</th>
                                                                <th className="px-4 py-3 border-b border-gray-200 dark:border-white/10 text-center w-28">Factura</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-gray-100 dark:divide-white/5">
                                                            {dynamicPendingInvoices.map((s) => {
                                                                const isExpanded = !!expandedInvoices[s.id];
                                                                const detailCount = s.details?.length || 0;
                                                                const pendingAmount = s.debtPending ?? s.creditAmount;
                                                                return (
                                                                    <React.Fragment key={s.id}>
                                                                        <tr 
                                                                            className="hover:bg-rose-500/5 transition-colors cursor-pointer group"
                                                                            onClick={() => setSelectedSaleForPreview(s)}
                                                                        >
                                                                            <td className="px-4 py-3.5 text-center">
                                                                                <button 
                                                                                    type="button"
                                                                                    className="p-1 rounded-lg bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 group-hover:text-rose-500 transition-colors"
                                                                                    onClick={(e) => {
                                                                                        e.stopPropagation();
                                                                                        toggleInvoiceExpand(s.id);
                                                                                    }}
                                                                                >
                                                                                    {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                                                                </button>
                                                                            </td>
                                                                            <td className="px-4 py-3.5 font-bold tabular-nums">
                                                                                <div className="flex flex-col">
                                                                                    <span className="text-gray-900 dark:text-white">{new Date(s.date).toLocaleDateString('es-CO')}</span>
                                                                                    <span className="text-[10px] text-rose-500 font-mono font-bold tracking-tight"># {s.id}</span>
                                                                                </div>
                                                                            </td>
                                                                            <td className="px-4 py-3.5">
                                                                                <div className="flex items-center gap-1.5">
                                                                                    <Chip size="sm" variant="flat" color="default" startContent={<ShoppingBag size={11} />} className="font-semibold text-[10px] uppercase">
                                                                                        {detailCount} {detailCount === 1 ? 'producto' : 'productos'}
                                                                                    </Chip>
                                                                                </div>
                                                                            </td>
                                                                            <td className="px-4 py-3.5 text-right font-mono font-semibold text-gray-500 dark:text-zinc-400">
                                                                                $ {(s.creditAmount || 0).toLocaleString()}
                                                                            </td>
                                                                            <td className="px-4 py-3.5 text-right font-mono font-black text-rose-600 dark:text-rose-400 text-sm">
                                                                                $ {pendingAmount.toLocaleString()}
                                                                            </td>
                                                                            <td className="px-4 py-3.5 text-center">
                                                                                <Button 
                                                                                    size="sm" 
                                                                                    variant="solid" 
                                                                                    color="primary"
                                                                                    className="h-8 text-[10px] font-bold uppercase rounded-xl tracking-wider bg-emerald-600 hover:bg-emerald-500 text-white"
                                                                                    onClick={(e) => {
                                                                                        e.stopPropagation();
                                                                                        setSelectedSaleForPreview(s);
                                                                                    }}
                                                                                    startContent={<FileText size={12} />}
                                                                                >
                                                                                    Factura
                                                                                </Button>
                                                                            </td>
                                                                        </tr>

                                                                        {/* FILA EXPANDIBLE CON EL DETALLE DE PRODUCTOS */}
                                                                        {isExpanded && (
                                                                            <tr className="bg-rose-500/5 dark:bg-rose-500/10 border-b border-rose-500/20">
                                                                                <td colSpan={6} className="p-4 px-8">
                                                                                    <div className="flex flex-col gap-2 bg-white dark:bg-zinc-900 p-4 rounded-2xl border border-rose-500/20 shadow-sm">
                                                                                        <div className="flex justify-between items-center pb-2 border-b border-gray-100 dark:border-white/5">
                                                                                            <span className="text-[10px] font-black text-rose-600 dark:text-rose-400 uppercase tracking-widest">DESGLOSE DE PRODUCTOS (# {s.id})</span>
                                                                                            <span className="text-[10px] font-mono text-gray-400">{s.details?.length || 0} ÍTEMS</span>
                                                                                        </div>
                                                                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-1">
                                                                                            {s.details?.map((d, i) => (
                                                                                                <div key={i} className="flex justify-between items-center p-2.5 rounded-xl bg-gray-50 dark:bg-zinc-800/80 border border-gray-200/60 dark:border-white/5">
                                                                                                    <div className="flex flex-col">
                                                                                                        <span className="text-xs font-bold text-gray-900 dark:text-white uppercase">
                                                                                                            {d.product?.productName || d.barcode}
                                                                                                        </span>
                                                                                                        <span className="text-[9px] font-mono text-gray-400">Cod: {d.barcode || 'N/A'}</span>
                                                                                                    </div>
                                                                                                    <div className="flex items-center gap-3">
                                                                                                        <span className="text-xs font-mono font-bold text-gray-600 dark:text-zinc-300 bg-gray-200 dark:bg-zinc-700 px-2 py-0.5 rounded-lg">
                                                                                                            x{d.quantity}
                                                                                                        </span>
                                                                                                        <span className="text-xs font-mono font-bold text-gray-900 dark:text-white">
                                                                                                            $ {(d.subtotal || ((d.unitPrice || 0) * d.quantity)).toLocaleString()}
                                                                                                        </span>
                                                                                                    </div>
                                                                                                </div>
                                                                                            ))}
                                                                                        </div>
                                                                                    </div>
                                                                                </td>
                                                                            </tr>
                                                                        )}
                                                                    </React.Fragment>
                                                                );
                                                            })}
                                                            {dynamicPendingInvoices.length === 0 && (
                                                                <tr>
                                                                    <td colSpan={6} className="px-4 py-10 text-center text-gray-400 tracking-tight">
                                                                        <CheckCircle2 size={24} className="inline mr-2 text-emerald-500" />
                                                                        No hay deudas activas — Cliente al día
                                                                    </td>
                                                                </tr>
                                                            )}
                                                        </tbody>
                                                    </table>
                                                </ScrollShadow>

                                                {/* Abonos del ciclo actual */}
                                                <div className="flex items-center gap-2 px-1 mt-2">
                                                    <ArrowDownLeft size={16} className="text-emerald-500" />
                                                    <span className="text-xs font-black uppercase tracking-wider text-gray-800 dark:text-white">Abonos del Ciclo</span>
                                                    <Chip size="sm" color="success" variant="flat" className="font-bold text-[10px]">{(data.payments || []).length}</Chip>
                                                </div>
                                                <ScrollShadow className="max-h-[200px] rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#18181c] shadow-sm">
                                                    <table className="w-full text-left text-xs border-separate border-spacing-0">
                                                        <thead className="sticky top-0 bg-gray-100 dark:bg-zinc-900 z-10 border-b border-gray-200 dark:border-white/10">
                                                            <tr className="text-gray-500 dark:text-zinc-400 font-black text-[9px] uppercase tracking-wider">
                                                                <th className="px-4 py-3 border-b border-gray-200 dark:border-white/10">Fecha</th>
                                                                <th className="px-4 py-3 border-b border-gray-200 dark:border-white/10">Método de Pago</th>
                                                                <th className="px-4 py-3 border-b border-gray-200 dark:border-white/10 text-right">Monto Abonado</th>
                                                                <th className="px-4 py-3 border-b border-gray-200 dark:border-white/10 text-center w-24">Acciones</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-gray-100 dark:divide-white/5">
                                                            {(data.payments || []).map((p) => (
                                                                <tr key={p.id} className="hover:bg-emerald-500/5 transition-colors">
                                                                    <td className="px-4 py-3 font-bold font-mono">{new Date(p.paymentDate).toLocaleDateString('es-CO')}</td>
                                                                    <td className="px-4 py-3 font-bold text-gray-900 dark:text-white uppercase text-[10px]">
                                                                        <Chip size="sm" variant="flat" color="success" className="font-bold text-[9px] uppercase">
                                                                            {p.amountCash > 0 ? 'Efectivo' : p.transferSource || 'Transferencia'}
                                                                        </Chip>
                                                                    </td>
                                                                    <td className="px-4 py-3 text-right font-mono font-bold text-emerald-600 dark:text-emerald-400 text-sm">
                                                                        $ {p.totalPaid.toLocaleString()}
                                                                    </td>
                                                                    <td className="px-4 py-3 text-center">
                                                                        {isAdmin ? (
                                                                            <div className="flex items-center justify-center gap-1">
                                                                                <Button 
                                                                                    isIconOnly 
                                                                                    size="sm" 
                                                                                    color="warning" 
                                                                                    variant="light" 
                                                                                    title="Cambiar Canal / Método de Pago" 
                                                                                    className="min-w-7 w-7 h-7 p-0 text-amber-500 hover:bg-amber-500/10 rounded-lg"
                                                                                    onPress={() => {
                                                                                        setEditingPayment(p);
                                                                                        setSelectedNewMethod(p.amountCash > 0 ? 'EFECTIVO' : p.transferSource || 'NEQUI');
                                                                                    }}
                                                                                >
                                                                                    <Pencil size={13} />
                                                                                </Button>
                                                                                <Button 
                                                                                    isIconOnly 
                                                                                    size="sm" 
                                                                                    color="danger" 
                                                                                    variant="light" 
                                                                                    title="Anular / Cancelar Abono"
                                                                                    className="min-w-7 w-7 h-7 p-0 text-rose-500 hover:bg-rose-500/10 rounded-lg" 
                                                                                    onPress={() => handleDeletePayment(p.id)} 
                                                                                    isLoading={isDeleting === p.id}
                                                                                >
                                                                                    <Trash size={13} />
                                                                                </Button>
                                                                            </div>
                                                                        ) : (
                                                                            <span className="text-[9px] font-semibold text-gray-400">Registrado</span>
                                                                        )}
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                            {(data.payments || []).length === 0 && (
                                                                <tr>
                                                                    <td colSpan={4} className="px-4 py-8 text-center text-gray-400 tracking-tight">No se registran abonos en este ciclo</td>
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
                                                <BookOpen size={15} />
                                                <span>Libro Mayor</span>
                                                <Chip size="sm" color="secondary" variant="solid" className="font-bold text-[9px] h-5 min-w-5">{libroMayorEntries.length}</Chip>
                                            </div>
                                        }>
                                            <div className="flex flex-col gap-4 pt-3">
                                                {/* Resumen del historial */}
                                                <div className="grid grid-cols-3 gap-3">
                                                    <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-center">
                                                        <span className="text-[9px] font-black text-rose-500 uppercase tracking-widest">Total Fiado</span>
                                                        <p className="text-base font-mono font-bold text-rose-600 dark:text-rose-400 mt-0.5">$ {totalFiado.toLocaleString()}</p>
                                                    </div>
                                                    <div className="p-3.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-center">
                                                        <span className="text-[9px] font-black text-emerald-500 uppercase tracking-widest">Total Abonado</span>
                                                        <p className="text-base font-mono font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">$ {totalAbonado.toLocaleString()}</p>
                                                    </div>
                                                    <div className="p-3.5 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-center">
                                                        <span className="text-[9px] font-black text-indigo-500 uppercase tracking-widest">Movimientos</span>
                                                        <p className="text-base font-mono font-bold text-indigo-600 dark:text-indigo-400 mt-0.5">{libroMayorEntries.length}</p>
                                                    </div>
                                                </div>

                                                {/* Tabla cronologica tipo Libro Mayor */}
                                                <ScrollShadow className="max-h-[340px] rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#18181c] shadow-sm">
                                                    <table className="w-full text-left text-xs border-separate border-spacing-0">
                                                        <thead className="sticky top-0 bg-gray-100 dark:bg-zinc-900 z-10 border-b border-gray-200 dark:border-white/10">
                                                            <tr className="text-gray-500 dark:text-zinc-400 font-black text-[9px] uppercase tracking-wider">
                                                                <th className="px-4 py-3 border-b border-gray-200 dark:border-white/10">Fecha</th>
                                                                <th className="px-4 py-3 border-b border-gray-200 dark:border-white/10">Tipo</th>
                                                                <th className="px-4 py-3 border-b border-gray-200 dark:border-white/10">Detalle</th>
                                                                <th className="px-4 py-3 border-b border-gray-200 dark:border-white/10 text-right text-rose-500">Débito</th>
                                                                <th className="px-4 py-3 border-b border-gray-200 dark:border-white/10 text-right text-emerald-500">Crédito</th>
                                                                <th className="px-4 py-3 border-b border-gray-200 dark:border-white/10 text-right">Saldo</th>
                                                                <th className="px-4 py-3 border-b border-gray-200 dark:border-white/10 text-center w-12">Acción</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-gray-100 dark:divide-white/5">
                                                            {libroMayorEntries.map((entry, idx) => (
                                                                <tr key={`${entry.type}-${entry.id}-${idx}`} className="hover:bg-gray-50 dark:hover:bg-white/5 transition-colors">
                                                                    <td className="px-4 py-3 font-mono font-bold text-[11px]">
                                                                        {entry.date.toLocaleDateString('es-CO')}
                                                                    </td>
                                                                    <td className="px-4 py-3">
                                                                        <Chip 
                                                                            size="sm" 
                                                                            color={entry.type === 'VENTA' ? 'danger' : 'success'}
                                                                            variant="flat"
                                                                            className="font-bold text-[9px] uppercase"
                                                                        >
                                                                            {entry.type === 'VENTA' ? '📤 Fiado' : '💰 Abono'}
                                                                        </Chip>
                                                                    </td>
                                                                    <td className="px-4 py-3 text-[11px] font-bold text-gray-800 dark:text-zinc-300 truncate max-w-[200px]">
                                                                        {entry.detail}
                                                                    </td>
                                                                    <td className="px-4 py-3 text-right font-mono font-bold text-rose-600 dark:text-rose-400">
                                                                        {entry.type === 'VENTA' ? `$ ${entry.amount.toLocaleString()}` : ''}
                                                                    </td>
                                                                    <td className="px-4 py-3 text-right font-mono font-bold text-emerald-600 dark:text-emerald-400">
                                                                        {entry.type === 'ABONO' ? `$ ${entry.amount.toLocaleString()}` : ''}
                                                                    </td>
                                                                    <td className="px-4 py-3 text-right font-mono font-bold text-gray-900 dark:text-white">
                                                                        $ {entry.balance.toLocaleString()}
                                                                    </td>
                                                                    <td className="px-4 py-3 text-center">
                                                                        {entry.type === 'ABONO' ? (
                                                                            isAdmin ? (
                                                                                <div className="flex items-center justify-center gap-1">
                                                                                    <Button 
                                                                                        isIconOnly 
                                                                                        size="sm" 
                                                                                        color="warning" 
                                                                                        variant="light" 
                                                                                        title="Cambiar Canal / Método de Pago"
                                                                                        className="min-w-7 w-7 h-7 p-0 text-amber-500 hover:bg-amber-500/10 rounded-lg"
                                                                                        onPress={() => {
                                                                                            const originalP = data?.payments?.find(p => p.id === Number(entry.id));
                                                                                            if (originalP) setEditingPayment(originalP);
                                                                                            else setEditingPayment({ id: Number(entry.id), totalPaid: entry.amount } as any);
                                                                                            setSelectedNewMethod('EFECTIVO');
                                                                                        }}
                                                                                    >
                                                                                        <Pencil size={13} />
                                                                                    </Button>
                                                                                    <Button 
                                                                                        isIconOnly 
                                                                                        size="sm" 
                                                                                        color="danger" 
                                                                                        variant="light" 
                                                                                        title="Anular / Cancelar Abono"
                                                                                        className="min-w-7 w-7 h-7 p-0 text-rose-500 hover:bg-rose-500/10 rounded-lg" 
                                                                                        onPress={() => handleDeletePayment(entry.id)} 
                                                                                        isLoading={isDeleting === entry.id}
                                                                                    >
                                                                                        <Trash size={13} />
                                                                                    </Button>
                                                                                </div>
                                                                            ) : (
                                                                                <span className="text-[9px] font-semibold text-gray-400">Registrado</span>
                                                                            )
                                                                        ) : entry.fullSale ? (
                                                                            <Button isIconOnly size="sm" color="primary" variant="light" className="min-w-7 w-7 h-7 p-0 rounded-lg" onPress={() => setSelectedSaleForPreview(entry.fullSale!)}>
                                                                                <Eye size={13} />
                                                                            </Button>
                                                                        ) : null}
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                            {libroMayorEntries.length === 0 && (
                                                                <tr>
                                                                    <td colSpan={7} className="px-4 py-8 text-center text-gray-400 tracking-tight">
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
                        <ModalFooter className="flex flex-col sm:flex-row items-center justify-between gap-3">
                            <Button 
                                variant="flat" 
                                onPress={onClose}
                                className="font-bold uppercase text-[11px] tracking-wider px-6 h-11 rounded-2xl w-full sm:w-auto"
                            >
                                Cerrar
                            </Button>
                            <div className="flex items-center gap-2 w-full sm:w-auto">
                                <Button
                                    className="h-11 bg-emerald-600 hover:bg-emerald-500 text-white font-bold uppercase text-[11px] tracking-wider px-6 rounded-2xl shadow-lg shadow-emerald-600/20 flex items-center gap-2 flex-1 sm:flex-initial"
                                    startContent={<MessageSquare size={16} />}
                                    onPress={handleSendDebtReminder}
                                    isDisabled={!data || (data.client?.currentCredit || 0) <= 0}
                                >
                                    Enviar Recordatorio
                                </Button>
                                <Button 
                                    color="primary"
                                    onPress={handlePrint}
                                    isDisabled={!data}
                                    className="h-11 bg-indigo-600 hover:bg-indigo-500 text-white font-bold uppercase text-[11px] tracking-wider px-6 rounded-2xl shadow-lg shadow-indigo-600/20 flex items-center gap-2 flex-1 sm:flex-initial"
                                    startContent={<Printer size={16} />}
                                >
                                    Imprimir Reporte
                                </Button>
                            </div>
                        </ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>

        {/* MODAL DE PREVISUALIZACION DE FACTURA SELECCIONADA */}
        <SaleDetailModal
            isOpen={!!selectedSaleForPreview}
            onOpenChange={(open) => { if (!open) setSelectedSaleForPreview(null); }}
            sale={selectedSaleForPreview}
            onPrint={() => {
                if (typeof window !== 'undefined') window.print();
            }}
        />

        {/* MODAL PARA CORREGIR CANAL DE PAGO USANDO EL MISMO MODAL UNIVERSAL DE PAGO */}
        {editingPayment && (
            <UniversalPaymentModal
                isOpen={!!editingPayment}
                onOpenChange={(open) => { if (!open) setEditingPayment(null); }}
                title={`Editar Canal de Pago (Abono #${editingPayment.id})`}
                client={data?.client || customer}
                totalToPay={editingPayment.totalPaid}
                initialPaidAmounts={{
                    cash: editingPayment.amountCash || (editingPayment.totalPaid && !editingPayment.transferSource ? editingPayment.totalPaid : 0),
                    transfer: editingPayment.amountTransfer || (editingPayment.transferSource ? editingPayment.totalPaid : 0),
                    transferSource: editingPayment.transferSource || 'NEQUI',
                    credit: 0
                }}
                showSuccessScreen={false}
                submittingPayment={isUpdatingMethod}
                lastChange={0}
                showCreditTab={false}
                isAbono={true}
                onPay={handleSaveEditPaymentMethod}
            />
        )}
        </>
    );
}
