"use client";

import {
    Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
    Button, Chip, Divider, Table, TableHeader, TableColumn, TableBody, TableRow, TableCell
} from "@heroui/react";
import { FileText, Printer, X } from 'lucide-react';
import { Sale } from '@/lib/definitions';
import React from 'react';
import { getPaymentDescription, getPaymentColor } from '@/lib/payment-helpers';

interface SaleDetailModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    sale: Sale | null;
    onPrint: () => void;
}

export default function SaleDetailModal({ isOpen, onOpenChange, sale, onPrint }: SaleDetailModalProps) {
    const sortedDetails = React.useMemo(() => {
        return [...(sale?.details || [])].sort((a, b) => 
            (a.product?.productName || '').localeCompare(b.product?.productName || '')
        );
    }, [sale?.details]);

    if (!sale) return null;


    return (
        <Modal
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            size="3xl"
            backdrop="blur"
            scrollBehavior="inside"
            classNames={{
                base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-[2rem] shadow-[0_8px_30px_rgb(0,0,0,0.12)]",
                closeButton: "hover:bg-white/5 hover:text-zinc-900 dark:text-zinc-100 transition-colors"
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="flex items-center gap-4 p-8 border-b border-gray-100 dark:border-white/5 rounded-t-[2rem]">
                            <div className="bg-white/5 p-3 rounded-2xl text-zinc-900 dark:text-zinc-100 shadow-inner -rotate-3">
                                <FileText size={24} />
                            </div>
                            <div className="flex flex-col min-w-0">
                                <span className="text-xl font-medium text-zinc-900 dark:text-white uppercase tracking-tight tracking-tighter leading-none">Venta Maestro #{sale.id}</span>
                                <span className="text-[9px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-[0.3em] mt-2 not-tracking-tight">Comprobante de Transaccion Oficial</span>
                            </div>
                            <div className="ml-auto">
                                <Chip variant="dot" color="success" size="sm" className="font-bold border-zinc-200 dark:border-white/10 uppercase tracking-widest text-[8px]">Sincronizado</Chip>
                            </div>
                        </ModalHeader>
                        <ModalBody className="p-8 gap-8">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                <div className="space-y-4">
                                    <h4 className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-widest px-1">Informacion del Cliente</h4>
                                    <div className="p-6 bg-gray-50 dark:bg-[#18181b] rounded-[2rem] border border-gray-100 dark:border-white/5 space-y-4">
                                        <div className="flex justify-between items-center">
                                            <span className="text-[9px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em]">Nombre</span>
                                            <span className="text-sm font-medium text-zinc-900 dark:text-white uppercase tracking-tight">{sale.client?.name || 'Consumidor Final'}</span>
                                        </div>
                                        <div className="flex justify-between items-center">
                                            <span className="text-[9px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em]">DNI / NIT</span>
                                            <span className="text-sm font-medium text-zinc-900 dark:text-white font-mono">{sale.client?.dni || 'SN-0000'}</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="space-y-4">
                                    <h4 className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-widest px-1">Resumen de Pago</h4>
                                    <div className="p-6 bg-gray-50 dark:bg-[#18181b] rounded-[2rem] border border-gray-100 dark:border-white/5 space-y-4">
                                        <div className="flex justify-between items-center">
                                            <span className="text-[9px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em]">Metodo</span>
                                            <Chip size="sm" color={getPaymentColor(sale.paymentMethod)} variant="flat" className="font-medium uppercase text-[8px] tracking-[0.2em]">{getPaymentDescription(sale)}</Chip>
                                        </div>
                                        <div className="flex justify-between items-center">
                                            <span className="text-[9px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em]">Fecha</span>
                                            <span className="text-sm font-medium text-zinc-900 dark:text-white tracking-tight">{new Date(sale.date || '').toLocaleDateString('es-CO')}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-4">
                                <h4 className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-widest px-1">Articulos Vendidos</h4>
                                <div className="rounded-[2rem] border border-gray-100 dark:border-white/5 overflow-hidden">
                                    <Table isCompact removeWrapper aria-label="Detalle de productos" classNames={{ th: "bg-gray-50 dark:bg-[#18181b] text-[9px] font-medium uppercase tracking-widest text-zinc-500 dark:text-zinc-400 h-10 px-6", td: "py-5 border-b border-gray-100 dark:border-white/5 bg-white dark:bg-zinc-950 px-6 group-hover:bg-gray-50/50 dark:group-hover:bg-[#18181b] transition-colors" }}>
                                        <TableHeader>
                                            <TableColumn>PRODUCTO</TableColumn>
                                            <TableColumn align="center">CANT</TableColumn>
                                            <TableColumn align="end">SUBTOTAL</TableColumn>
                                        </TableHeader>
                                        <TableBody>
                                            {sortedDetails.map((detail: any, idx: number) => (
                                                <TableRow key={idx} className="group">
                                                    <TableCell>
                                                        <div className="flex flex-col">
                                                            <span className="font-medium text-xs text-zinc-900 dark:text-white uppercase tracking-tight tracking-tighter">{detail.product?.productName || 'Producto'}</span>
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="text-center font-medium text-xs text-gray-400 dark:text-zinc-400 tabular-nums">{detail.quantity}</TableCell>
                                                    <TableCell className="text-right font-medium text-sm text-zinc-900 dark:text-white tabular-nums">${(detail.subtotal || (detail.unitPrice * detail.quantity)).toLocaleString()}</TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </div>
                            </div>

                            <div className="flex justify-end">
                                <div className="w-80 space-y-4">
                                    <div className="flex justify-between items-center px-4">
                                        <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest">Subtotal Gravado</span>
                                        <span className="text-sm font-medium text-zinc-900 dark:text-white tabular-nums">${(sale.total || 0).toLocaleString()}</span>
                                    </div>
                                    <Divider className="bg-[#18181b]" />
                                    <div className="flex justify-between items-center p-8 bg-white/5 dark:bg-white/5 rounded-[2rem] border border-emerald-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-emerald-500/10">
                                        <span className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-[0.3em]">Total Neto</span>
                                        <span className="text-3xl font-medium text-zinc-900 dark:text-zinc-100 dark:text-white tabular-nums tracking-tighter">${(sale.total || 0).toLocaleString()}</span>
                                    </div>
                                </div>
                            </div>
                        </ModalBody>
                        <ModalFooter className="p-8 border-t border-gray-100 dark:border-white/5 flex gap-4 rounded-b-[2rem] bg-gray-50/50 dark:bg-transparent">
                            <Button 
                                variant="flat" 
                                className="flex-1 h-14 rounded-2xl font-medium uppercase text-[10px] bg-gray-200 dark:bg-[#18181b] text-gray-500 dark:text-zinc-500 hover:bg-gray-300 dark:hover:bg-zinc-100 dark:bg-zinc-800 tracking-tight tracking-widest" 
                                onPress={onClose}
                            >
                                VOLVER <X size={14} className="ml-1" />
                            </Button>
                            <Button
                                color="primary"
                                className="flex-[2] h-14 rounded-2xl font-medium uppercase text-[10px] bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] tracking-tight tracking-widest"
                                startContent={<Printer size={16} />}
                                onPress={onPrint}
                            >
                                IMPRIMIR COMPROBANTE
                            </Button>
                        </ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
}
