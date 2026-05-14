"use client";

import React, { useEffect, useState, useMemo } from 'react';
import {
    Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
    Button, Spinner, Card, CardBody, Chip, Divider, ScrollShadow
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
    CheckCircle2
} from 'lucide-react';
import { Customer, Sale, CreditPayment } from '@/lib/definitions';
import { apiFetch } from '@/lib/api-error';
import Cookies from 'js-cookie';

interface StatementData {
    client: Customer;
    pending: Sale[];
    payments: CreditPayment[];
}

interface Props {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    customer: Customer | null;
}

export default function ClientStatementModal({ isOpen, onOpenChange, customer }: Props) {
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState<StatementData | null>(null);

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
        }
    }, [isOpen, customer]);

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
                        .footer { margin-top: 50px; font-size: 10px; color: #999; text-align: center; }
                        @media print { .no-print { display: none; } }
                    </style>
                </head>
                <body>
                    <div class="header">
                        <h1>ESTADO DE CUENTA</h1>
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
                            ${data.pending.map(s => `
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
                                        $${s.creditAmount.toLocaleString()}
                                    </td>
                                </tr>
                            `).join('')}
                            ${data.pending.length === 0 ? '<tr><td colspan="3" style="text-align:center">No hay facturas pendientes</td></tr>' : ''}
                        </tbody>
                    </table>

                    <div class="section-title">Historial de Abonos</div>
                    <table>
                        <thead>
                            <tr>
                                <th>Fecha</th>
                                <th>Referencia</th>
                                <th>Método</th>
                                <th class="text-right">Monto</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${data.payments.map(p => `
                                <tr>
                                    <td>${new Date(p.paymentDate).toLocaleDateString()}</td>
                                    <td>RECIBO-${p.id}</td>
                                    <td>${p.amountCash > 0 ? 'Efectivo' : p.transferSource || 'Transferencia'}</td>
                                    <td class="text-right">$${p.totalPaid.toLocaleString()}</td>
                                </tr>
                            `).join('')}
                            ${data.payments.length === 0 ? '<tr><td colspan="4" style="text-align:center">No se registran abonos recientes</td></tr>' : ''}
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
            size="4xl"
            backdrop="blur"
            classNames={{
                base: "bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/5 shadow-2xl rounded-[32px]",
                header: "border-b border-gray-200 dark:border-white/5 pb-4",
                body: "py-6",
                footer: "border-t border-gray-200 dark:border-white/5 pt-4"
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="flex flex-col gap-1">
                            <div className="flex items-center gap-3">
                                <div className="h-10 w-10 rounded-2xl bg-emerald-500 flex items-center justify-center text-white shadow-lg shadow-emerald-500/20">
                                    <FileText size={22} />
                                </div>
                                <div className="flex flex-col">
                                    <h2 className="text-lg font-black uppercase italic tracking-tight">Estado de Cuenta</h2>
                                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest leading-none">Reporte Financiero Consolidado</p>
                                </div>
                            </div>
                        </ModalHeader>
                        <ModalBody>
                            {loading ? (
                                <div className="h-64 w-full flex items-center justify-center">
                                    <Spinner color="success" size="lg" />
                                </div>
                            ) : data ? (
                                <div className="grid grid-cols-1 md:grid-cols-12 gap-6 h-full">
                                    {/* Sidebar: Información Cliente */}
                                    <div className="md:col-span-4 flex flex-col gap-4">
                                        <Card className="bg-white dark:bg-zinc-900 border border-gray-100 dark:border-white/5 shadow-sm rounded-3xl">
                                            <CardBody className="p-5 flex flex-col gap-4">
                                                <div className="flex flex-col">
                                                    <span className="text-[8px] font-black text-emerald-500 uppercase tracking-[0.2em] mb-1">Cliente</span>
                                                    <h3 className="text-md font-black uppercase italic truncate">{data.client.name}</h3>
                                                    <span className="text-[9px] font-bold text-gray-400">CC: {data.client.dni}</span>
                                                </div>
                                                
                                                <Divider className="opacity-50" />

                                                <div className="flex flex-col gap-3">
                                                    <div className="flex items-center justify-between">
                                                        <span className="text-[9px] font-black uppercase text-gray-400">Límite Crédito</span>
                                                        <span className="text-[10px] font-black">$ {data.client.creditLimit.toLocaleString()}</span>
                                                    </div>
                                                    <div className="p-4 rounded-2xl bg-rose-500/5 border border-rose-500/10 flex flex-col gap-1">
                                                        <span className="text-[8px] font-black text-rose-500 uppercase tracking-widest">Saldo Pendiente</span>
                                                        <span className="text-xl font-black text-rose-600 dark:text-rose-400 italic">
                                                            $ {data.client.currentCredit.toLocaleString()}
                                                        </span>
                                                    </div>
                                                </div>

                                                <div className="flex flex-col gap-2 mt-2">
                                                    <div className="flex items-center gap-2 text-[9px] font-bold text-gray-500">
                                                        <CreditCard size={12} className="text-emerald-500" />
                                                        <span>Último movimiento: {data.client.lastPurchaseDate ? new Date(data.client.lastPurchaseDate).toLocaleDateString() : 'N/A'}</span>
                                                    </div>
                                                </div>
                                            </CardBody>
                                        </Card>

                                        <div className="p-5 rounded-3xl bg-emerald-500/5 border border-emerald-500/10 flex flex-col gap-2">
                                            <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                                                <AlertCircle size={14} />
                                                <span className="text-[9px] font-black uppercase italic tracking-widest">Aviso de Cobranza</span>
                                            </div>
                                            <p className="text-[10px] text-gray-500 font-medium leading-relaxed italic">
                                                Este reporte incluye todas las facturas a crédito que no han sido canceladas en su totalidad.
                                            </p>
                                        </div>
                                    </div>

                                    {/* Main Content: Tablas */}
                                    <div className="md:col-span-8 flex flex-col gap-6">
                                        <div className="flex flex-col h-[200px]">
                                            <div className="flex items-center gap-2 mb-3 px-1">
                                                <ArrowUpRight size={14} className="text-rose-500" />
                                                <span className="text-[10px] font-black uppercase tracking-widest italic">Facturas Pendientes</span>
                                                <Chip size="sm" className="bg-rose-500 text-white font-black text-[9px] h-5">{data.pending.length}</Chip>
                                            </div>
                                            <ScrollShadow className="flex-1 rounded-2xl border border-gray-100 dark:border-white/5 bg-white/50 dark:bg-zinc-900/50">
                                                <div className="p-0">
                                                    <table className="w-full text-left text-[11px] border-separate border-spacing-0">
                                                        <thead className="sticky top-0 bg-gray-50 dark:bg-zinc-950 z-10 shadow-sm">
                                                            <tr>
                                                                <th className="px-4 py-3 font-black text-gray-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5">Fecha</th>
                                                                <th className="px-4 py-3 font-black text-gray-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5">Factura</th>
                                                                <th className="px-4 py-3 font-black text-gray-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5 text-right">Saldo</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {data.pending.map((s) => (
                                                                <React.Fragment key={s.id}>
                                                                    <tr className="hover:bg-rose-500/5 transition-colors group">
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
                                                                                        <span className="text-[10px] font-black uppercase text-gray-600 dark:text-zinc-400 truncate">
                                                                                            {d.product?.productName || d.barcode}
                                                                                        </span>
                                                                                        <span className="text-[9px] font-bold text-emerald-500 shrink-0">
                                                                                            x{d.quantity}
                                                                                        </span>
                                                                                    </div>
                                                                                ))}
                                                                            </div>
                                                                        </td>
                                                                        <td className="px-4 py-3 text-right font-black text-rose-500 group-hover:scale-105 transition-transform origin-right align-top">
                                                                            $ {s.creditAmount.toLocaleString()}
                                                                        </td>
                                                                    </tr>
                                                                </React.Fragment>
                                                            ))}
                                                            {data.pending.length === 0 && (
                                                                <tr>
                                                                    <td colSpan={3} className="px-4 py-8 text-center text-gray-400 italic">No hay deudas activas</td>
                                                                </tr>
                                                            )}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            </ScrollShadow>
                                        </div>

                                        <div className="flex flex-col h-[200px]">
                                            <div className="flex items-center gap-2 mb-3 px-1">
                                                <History size={14} className="text-emerald-500" />
                                                <span className="text-[10px] font-black uppercase tracking-widest italic">Historial de Abonos</span>
                                                <Chip size="sm" className="bg-emerald-500 text-white font-black text-[9px] h-5">{data.payments.length}</Chip>
                                            </div>
                                            <ScrollShadow className="flex-1 rounded-2xl border border-gray-100 dark:border-white/5 bg-white/50 dark:bg-zinc-900/50">
                                                <div className="p-0">
                                                    <table className="w-full text-left text-[11px] border-separate border-spacing-0">
                                                        <thead className="sticky top-0 bg-gray-50 dark:bg-zinc-950 z-10 shadow-sm">
                                                            <tr>
                                                                <th className="px-4 py-3 font-black text-gray-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5">Fecha</th>
                                                                <th className="px-4 py-3 font-black text-gray-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5">Método</th>
                                                                <th className="px-4 py-3 font-black text-gray-400 uppercase tracking-widest text-[8px] border-b border-gray-100 dark:border-white/5 text-right">Monto</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {data.payments.map((p) => (
                                                                <tr key={p.id} className="hover:bg-emerald-500/5 transition-colors group">
                                                                    <td className="px-4 py-3 font-bold tabular-nums">{new Date(p.paymentDate).toLocaleDateString()}</td>
                                                                    <td className="px-4 py-3 font-black text-emerald-500 uppercase text-[9px]">
                                                                        {p.amountCash > 0 ? 'Efectivo' : p.transferSource || 'Transf.'}
                                                                    </td>
                                                                    <td className="px-4 py-3 text-right font-black text-emerald-600 group-hover:scale-105 transition-transform origin-right">
                                                                        $ {p.totalPaid.toLocaleString()}
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                            {data.payments.length === 0 && (
                                                                <tr>
                                                                    <td colSpan={3} className="px-4 py-8 text-center text-gray-400 italic">No se registran abonos</td>
                                                                </tr>
                                                            )}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            </ScrollShadow>
                                        </div>
                                    </div>
                                </div>
                            ) : null}
                        </ModalBody>
                        <ModalFooter>
                            <Button 
                                variant="light" 
                                onPress={onClose}
                                className="font-black uppercase text-[10px] tracking-widest px-8 rounded-2xl italic"
                            >
                                Cerrar
                            </Button>
                            <Button 
                                color="success"
                                onPress={handlePrint}
                                isDisabled={!data}
                                className="h-12 bg-emerald-500 text-white font-black uppercase text-[10px] tracking-[0.2em] italic px-10 rounded-2xl shadow-xl shadow-emerald-500/30 flex items-center gap-2"
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
