'use client';

import React, { useState } from 'react';
import { 
    Modal, 
    ModalContent, 
    ModalHeader, 
    ModalBody, 
    ModalFooter, 
    Button, 
    Chip, 
    Divider 
} from "@heroui/react";
import { 
    FileText, 
    Printer, 
    Calendar, 
    User, 
    CreditCard, 
    Building2, 
    CheckCircle2, 
    Barcode, 
    Copy, 
    Check, 
    MessageSquare, 
    X,
    Hash
} from 'lucide-react';
import { Sale } from '@/lib/definitions';
import { getPaymentDescription, getPaymentColor } from '@/lib/payment-helpers';
import { formatCurrency } from '@/lib/utils';

interface SaleDetailModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    sale: Sale | null;
    onPrint: () => void;
}

export default function SaleDetailModal({
    isOpen,
    onOpenChange,
    sale,
    onPrint
}: SaleDetailModalProps) {
    const [copied, setCopied] = useState(false);

    if (!sale) return null;

    const sortedDetails = sale.details 
        ? [...sale.details].sort((a: any, b: any) => (a.id || 0) - (b.id || 0)) 
        : [];

    const formattedDate = sale.date ? new Date(sale.date).toLocaleString('es-CO', {
        dateStyle: 'medium',
        timeStyle: 'short'
    }) : 'FECHA DESCONOCIDA';

    const handleCopyId = () => {
        navigator.clipboard.writeText(sale.id);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleWhatsAppShare = () => {
        if (!sale) return;
        const clientName = sale.client?.name || 'CONSUMIDOR FINAL';
        const clientDni = sale.client?.dni || '0';
        const paymentMethod = getPaymentDescription(sale);

        const itemsText = (sortedDetails || []).map((detail: any) => {
            const pName = detail.product?.productName || 'Producto';
            const qty = detail.quantity;
            const unitPrice = detail.unitPrice || (detail.subtotal / (detail.quantity || 1));
            const subtotal = detail.subtotal || (unitPrice * qty);
            return `• *${qty}x* ${pName}\n   $${formatCurrency(unitPrice)} c/u — *$${formatCurrency(subtotal)}*`;
        }).join('\n');

        let msg = `🧾 *FACTURA DE VENTA N° #${sale.id}*\n`;
        msg += `🏢 *SISTEMA POS PRO*\n`;
        msg += `📅 *Fecha:* ${formattedDate}\n`;
        msg += `👤 *Cliente:* ${clientName}\n`;
        msg += `📄 *NIT/DNI:* ${clientDni}\n\n`;
        msg += `🛒 *DETALLE DE PRODUCTOS:*\n${itemsText}\n\n`;
        msg += `💰 *TOTAL VENTA:* *$${formatCurrency(sale.total)}*\n`;
        msg += `💳 *Método de Pago:* ${paymentMethod}\n`;
        
        if (sale.cashAmount > 0 && sale.change > 0) {
            msg += `💵 *Efectivo Recibido:* $${formatCurrency(sale.cashAmount)}\n`;
            msg += `🪙 *Cambio:* $${formatCurrency(sale.change)}\n`;
        }

        msg += `\n¡Gracias por su compra! 🙏✨`;

        let rawPhone = sale.client?.phone?.replace(/\D/g, '') || '';
        if (rawPhone && !rawPhone.startsWith('57') && rawPhone.length === 10) {
            rawPhone = `57${rawPhone}`;
        }
        const url = rawPhone 
            ? `https://wa.me/${rawPhone}?text=${encodeURIComponent(msg)}`
            : `https://wa.me/?text=${encodeURIComponent(msg)}`;
        window.open(url, '_blank');
    };

    return (
        <Modal
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            size="4xl"
            backdrop="blur"
            placement="center"
            scrollBehavior="inside"
            classNames={{
                base: "bg-gray-100 dark:bg-zinc-950 border border-gray-300 dark:border-white/10 rounded-[2.5rem] shadow-[0_20px_60px_rgba(0,0,0,0.3)] max-h-[92vh] my-auto overflow-hidden flex flex-col",
                closeButton: "hover:bg-black/5 dark:hover:bg-white/10 text-gray-500 dark:text-zinc-400 transition-colors z-50 top-6 right-6",
                header: "shrink-0 border-b border-gray-200 dark:border-white/10 p-6 px-8 bg-white dark:bg-[#121215]",
                body: "overflow-y-auto p-6 md:p-8 bg-gray-100 dark:bg-zinc-950 flex flex-col gap-6 flex-1",
                footer: "shrink-0 p-6 px-8 bg-white dark:bg-[#121215] border-t border-gray-200 dark:border-white/10 flex flex-col sm:flex-row gap-3"
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        {/* ACCIONES SUPERIORES EN ENCABEZADO */}
                        <ModalHeader className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="p-2.5 rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                                    <FileText size={22} />
                                </div>
                                <div className="flex flex-col">
                                    <div className="flex items-center gap-2">
                                        <span className="text-lg font-bold text-gray-900 dark:text-white tracking-tight uppercase">FACTURA DE VENTA</span>
                                        <Chip variant="flat" color="success" size="sm" startContent={<CheckCircle2 size={12} />} className="font-semibold text-[9px] uppercase tracking-wider">
                                            OFICIAL # {sale.id}
                                        </Chip>
                                    </div>
                                    <span className="text-[10px] font-medium text-gray-500 dark:text-zinc-400 tracking-wider">Comprobante de Transacción Comercial</span>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 pr-8">
                                <Button 
                                    size="sm" 
                                    variant="flat" 
                                    className="h-8 text-[10px] font-bold uppercase tracking-wider rounded-xl bg-gray-100 dark:bg-zinc-800 text-gray-700 dark:text-zinc-300 border border-gray-200 dark:border-white/5"
                                    onPress={handleCopyId}
                                >
                                    {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                                    {copied ? 'COPIADO' : 'COPIAR N°'}
                                </Button>
                            </div>
                        </ModalHeader>

                        <ModalBody className="p-4 md:p-6 bg-gray-100 dark:bg-zinc-950 flex flex-col gap-6 overflow-y-auto custom-scrollbar">
                            {/* HOJA ESTILO FACTURA REAL */}
                            <div className="bg-white dark:bg-[#18181c] rounded-[2rem] border border-gray-200 dark:border-white/10 p-6 md:p-8 shadow-sm flex flex-col gap-6 relative">
                                
                                {/* DECORATIVO DE BORDES SUPERIOR */}
                                <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-emerald-500 via-teal-500 to-indigo-500" />

                                {/* ENCABEZADO DE FACTURA - DATOS DEL EMISOR Y DOCUMENTO */}
                                <div className="flex flex-col md:flex-row justify-between gap-6 pb-6 border-b border-gray-100 dark:border-white/10">
                                    <div className="flex flex-col gap-1">
                                        <div className="flex items-center gap-2 text-gray-900 dark:text-white font-black text-xl tracking-tight uppercase">
                                            <Building2 size={20} className="text-emerald-500" />
                                            SISTEMA POS PRO
                                        </div>
                                        <span className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400 uppercase">Punto de Venta & Sistema Integrado</span>
                                        <span className="text-[10px] font-medium text-gray-400 dark:text-zinc-500">Documento Soporte Electrónico Interno</span>
                                    </div>

                                    <div className="bg-gray-50 dark:bg-zinc-900/80 p-4 rounded-2xl border border-gray-200 dark:border-white/5 flex flex-col gap-2 min-w-[240px]">
                                        <div className="flex justify-between items-center text-xs">
                                            <span className="text-[10px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-wider">Factura N°:</span>
                                            <span className="font-mono font-bold text-gray-900 dark:text-white">#{sale.id}</span>
                                        </div>
                                        <div className="flex justify-between items-center text-xs">
                                            <span className="text-[10px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-wider">Fecha:</span>
                                            <span className="font-semibold text-gray-900 dark:text-white flex items-center gap-1">
                                                <Calendar size={11} className="text-gray-400" /> {formattedDate}
                                            </span>
                                        </div>
                                        <div className="flex justify-between items-center text-xs">
                                            <span className="text-[10px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-wider">Estado:</span>
                                            <span className="font-bold text-emerald-600 dark:text-emerald-400 text-[10px] uppercase">COMPLETADA</span>
                                        </div>
                                    </div>
                                </div>

                                {/* SECCION DATOS DEL CLIENTE Y METODO PAGO */}
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    {/* BLOQUE CLIENTE */}
                                    <div className="p-5 rounded-2xl bg-gray-50 dark:bg-zinc-900/50 border border-gray-200/80 dark:border-white/5 flex flex-col gap-2">
                                        <div className="flex items-center gap-2 mb-1">
                                            <User size={14} className="text-indigo-500" />
                                            <span className="text-[10px] font-black text-gray-400 dark:text-zinc-400 uppercase tracking-widest">INFORMACIÓN DEL CLIENTE</span>
                                        </div>
                                        <div className="flex justify-between items-center">
                                            <span className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400">Nombre / Razón:</span>
                                            <span className="text-xs font-bold text-gray-900 dark:text-white uppercase">{sale.client?.name || 'CONSUMIDOR FINAL'}</span>
                                        </div>
                                        <div className="flex justify-between items-center">
                                            <span className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400">DNI / NIT:</span>
                                            <span className="text-xs font-mono font-bold text-gray-800 dark:text-zinc-300">{sale.client?.dni || '0'}</span>
                                        </div>
                                        {sale.client?.phone && (
                                            <div className="flex justify-between items-center">
                                                <span className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400">Teléfono:</span>
                                                <span className="text-xs font-mono text-gray-700 dark:text-zinc-300">{sale.client.phone}</span>
                                            </div>
                                        )}
                                    </div>

                                    {/* BLOQUE PAGO */}
                                    <div className="p-5 rounded-2xl bg-gray-50 dark:bg-zinc-900/50 border border-gray-200/80 dark:border-white/5 flex flex-col gap-2">
                                        <div className="flex items-center gap-2 mb-1">
                                            <CreditCard size={14} className="text-teal-500" />
                                            <span className="text-[10px] font-black text-gray-400 dark:text-zinc-400 uppercase tracking-widest">FORMA DE PAGO</span>
                                        </div>
                                        <div className="flex justify-between items-center">
                                            <span className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400">Método Principal:</span>
                                            <Chip size="sm" color={getPaymentColor(sale)} variant="flat" className="font-bold uppercase text-[9px] tracking-wider">
                                                {getPaymentDescription(sale)}
                                            </Chip>
                                        </div>
                                        {sale.cashAmount > 0 && (
                                            <div className="flex justify-between items-center">
                                                <span className="text-[11px] font-semibold text-gray-500 dark:text-zinc-400">Efectivo Recibido:</span>
                                                <span className="text-xs font-bold font-mono text-gray-900 dark:text-white">${formatCurrency(sale.cashAmount)}</span>
                                            </div>
                                        )}
                                        {sale.change > 0 && (
                                            <div className="flex justify-between items-center">
                                                <span className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">Cambio Entregado:</span>
                                                <span className="text-xs font-bold font-mono text-emerald-600 dark:text-emerald-400">${formatCurrency(sale.change)}</span>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* TABLA DE ARTICULOS VENDIDOS */}
                                <div className="flex flex-col gap-2 mt-2">
                                    <div className="flex items-center justify-between px-1">
                                        <span className="text-[11px] font-black text-gray-500 dark:text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                                            <Hash size={13} className="text-indigo-500" /> DETALLE DE ARTÍCULOS ({sortedDetails.length})
                                        </span>
                                    </div>

                                    <div className="rounded-2xl border border-gray-200 dark:border-white/10 overflow-x-auto shadow-inner">
                                        <table className="w-full text-left border-collapse">
                                            <thead>
                                                <tr className="bg-gray-100 dark:bg-zinc-900 text-gray-600 dark:text-zinc-400 text-[10px] font-black uppercase tracking-wider border-b border-gray-200 dark:border-white/10">
                                                    <th className="py-3 px-4 w-12 text-center">#</th>
                                                    <th className="py-3 px-4">CÓDIGO</th>
                                                    <th className="py-3 px-4">DESCRIPCIÓN DEL PRODUCTO</th>
                                                    <th className="py-3 px-4 text-center">CANT</th>
                                                    <th className="py-3 px-4 text-right">PRECIO UNIT.</th>
                                                    <th className="py-3 px-4 text-right">SUBTOTAL</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-gray-100 dark:divide-white/5 text-xs">
                                                {sortedDetails.map((detail: any, idx: number) => {
                                                    const unitPrice = detail.unitPrice || (detail.subtotal / (detail.quantity || 1));
                                                    const subtotal = detail.subtotal || (unitPrice * detail.quantity);
                                                    return (
                                                        <tr key={idx} className="hover:bg-gray-50/80 dark:hover:bg-zinc-900/50 transition-colors">
                                                            <td className="py-3.5 px-4 text-center text-gray-400 dark:text-zinc-500 font-mono text-[11px]">{idx + 1}</td>
                                                            <td className="py-3.5 px-4 font-mono text-[11px] text-gray-500 dark:text-zinc-400">{detail.barcode || detail.product?.barcode || 'N/A'}</td>
                                                            <td className="py-3.5 px-4">
                                                                <span className="font-bold text-gray-900 dark:text-white uppercase tracking-tight">
                                                                    {detail.product?.productName || 'PRODUCTO SIN NOMBRE'}
                                                                </span>
                                                            </td>
                                                            <td className="py-3.5 px-4 text-center font-bold font-mono text-gray-800 dark:text-zinc-200">
                                                                {detail.quantity}
                                                            </td>
                                                            <td className="py-3.5 px-4 text-right font-mono text-gray-600 dark:text-zinc-400">
                                                                ${formatCurrency(unitPrice)}
                                                            </td>
                                                            <td className="py-3.5 px-4 text-right font-mono font-bold text-gray-900 dark:text-white">
                                                                ${formatCurrency(subtotal)}
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>

                                {/* DESGLOSE FINANCIERO Y TOTAL */}
                                <div className="flex flex-col md:flex-row justify-between items-end gap-6 pt-4 border-t border-gray-100 dark:border-white/10 mt-2">
                                    {/* SELLO Y FIRMA DIGITAL SIMULADA */}
                                    <div className="flex flex-col gap-2 max-w-sm">
                                        <div className="flex items-center gap-2 text-gray-400 dark:text-zinc-500">
                                            <Barcode size={32} />
                                            <div className="flex flex-col font-mono text-[9px] leading-tight">
                                                <span>TX-REF: {sale.id}-SYSTEM-VERIFIED</span>
                                                <span>COMPROBANTE AUTÉNTICO POS PRO</span>
                                            </div>
                                        </div>
                                        <p className="text-[10px] text-gray-400 dark:text-zinc-500 font-medium italic">
                                            Gracias por su compra. Conserve este comprobante como recibo oficial de su transacción.
                                        </p>
                                    </div>

                                    {/* CUADRO DE TOTALES */}
                                    <div className="w-full md:w-80 bg-gray-50 dark:bg-zinc-900/90 rounded-2xl border border-gray-200 dark:border-white/10 p-5 flex flex-col gap-3 shadow-sm">
                                        <div className="flex justify-between items-center text-xs">
                                            <span className="font-semibold text-gray-500 dark:text-zinc-400 uppercase text-[10px] tracking-wider">SUBTOTAL BASE:</span>
                                            <span className="font-mono font-bold text-gray-800 dark:text-zinc-200">${formatCurrency(sale.total || 0)}</span>
                                        </div>
                                        <div className="flex justify-between items-center text-xs">
                                            <span className="font-semibold text-gray-500 dark:text-zinc-400 uppercase text-[10px] tracking-wider">IMPUESTOS (IVA 0%):</span>
                                            <span className="font-mono font-semibold text-gray-500 dark:text-zinc-400">$0</span>
                                        </div>
                                        <Divider className="my-0.5 bg-gray-200 dark:bg-white/10" />
                                        <div className="flex justify-between items-center p-3.5 rounded-xl bg-emerald-500/10 dark:bg-emerald-500/20 border border-emerald-500/30">
                                            <span className="font-black text-emerald-700 dark:text-emerald-300 uppercase text-xs tracking-wider">TOTAL NETO</span>
                                            <span className="font-mono font-black text-2xl text-emerald-600 dark:text-emerald-400 tracking-tight">${formatCurrency(sale.total || 0)}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </ModalBody>

                        {/* PIE CON BOTONES DE ACCION */}
                        <ModalFooter>
                            <Button 
                                variant="flat" 
                                className="h-12 rounded-2xl font-bold uppercase text-[11px] bg-gray-100 dark:bg-zinc-800 text-gray-700 dark:text-zinc-300 hover:bg-gray-200 dark:hover:bg-zinc-700 tracking-wider" 
                                onPress={onClose}
                            >
                                VOLVER <X size={15} className="ml-1" />
                            </Button>
                            <Button
                                className="h-12 flex-1 rounded-2xl font-bold uppercase text-[11px] bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20 tracking-wider"
                                startContent={<MessageSquare size={18} />}
                                onPress={handleWhatsAppShare}
                            >
                                ENVIAR POR WHATSAPP
                            </Button>
                            <Button
                                color="primary"
                                className="h-12 flex-1 rounded-2xl font-bold uppercase text-[11px] bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/20 tracking-wider"
                                startContent={<Printer size={18} />}
                                onPress={onPrint}
                            >
                                IMPRIMIR FACTURA
                            </Button>
                        </ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
}
