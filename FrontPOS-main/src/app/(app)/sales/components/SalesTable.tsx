"use client";

import { 
    Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
    Chip, Button, Tooltip 
} from "@heroui/react";
import { Eye, Edit3, Calendar, User, DollarSign } from 'lucide-react';
import { Sale } from '@/lib/definitions';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

interface SalesTableProps {
    sales: Sale[];
    onOpenPreview: (sale: Sale) => void;
    onOpenEdit: (sale: Sale) => void;
}

export default function SalesTable({ sales, onOpenPreview, onOpenEdit }: SalesTableProps) {
    const formatCurrency = (amount: number) => {
        return new Intl.NumberFormat('es-CO', {
            style: 'currency',
            currency: 'COP',
            maximumFractionDigits: 0
        }).format(amount);
    };

    return (
        <Table 
            aria-label="Registro maestro de ventas"
            removeWrapper
            classNames={{
                base: "flex-1 overflow-auto",
                th: "bg-gray-50/50 dark:bg-zinc-900/50 text-gray-400 dark:text-zinc-500 font-black text-[10px] uppercase tracking-widest py-4 border-b border-gray-100 dark:border-white/5 first:pl-8 last:pr-8",
                td: "py-4 first:pl-8 last:pr-8 border-b border-gray-50 dark:border-white/5 font-bold text-xs"
            }}
        >
            <TableHeader>
                <TableColumn>FECHA / HORA</TableColumn>
                <TableColumn>CLIENTE / DNI</TableColumn>
                <TableColumn>MÉTODO</TableColumn>
                <TableColumn>TOTAL</TableColumn>
                <TableColumn align="center">ACCIONES</TableColumn>
            </TableHeader>
            <TableBody emptyContent={<div className="flex flex-col items-center py-12 gap-2 opacity-50"><HistoryIcon size={40} className="text-gray-300"/><p className="text-[10px] font-black uppercase tracking-widest">No se encontraron registros de auditoría</p></div>}>
                {sales.map((sale) => (
                    <TableRow key={sale.id} className="hover:bg-gray-50/50 dark:hover:bg-white/5 transition-colors group">
                        <TableCell>
                            <div className="flex items-center gap-3">
                                <div className="p-2 bg-blue-50 dark:bg-blue-500/10 text-blue-500 rounded-lg group-hover:scale-110 transition-transform">
                                    <Calendar size={14} />
                                </div>
                                <div className="flex flex-col">
                                    <span className="text-gray-900 dark:text-white uppercase italic">{format(new Date(sale.date), "dd MMM yyyy", { locale: es })}</span>
                                    <span className="text-[10px] text-gray-400 dark:text-zinc-500 font-medium font-mono">{format(new Date(sale.date), "HH:mm:ss")}</span>
                                </div>
                            </div>
                        </TableCell>
                        <TableCell>
                            <div className="flex items-center gap-3">
                                <div className="p-2 bg-gray-100 dark:bg-zinc-800 text-gray-400 dark:text-zinc-500 rounded-lg">
                                    <User size={14} />
                                </div>
                                <div className="flex flex-col">
                                    <span className="text-gray-900 dark:text-white uppercase truncate max-w-[150px]">{sale.client?.name || 'CONSUMIDOR FINAL'}</span>
                                    <span className="text-[10px] text-gray-400 dark:text-zinc-500 font-medium font-mono">#{sale.client?.dni || '888888888'}</span>
                                </div>
                            </div>
                        </TableCell>
                        <TableCell>
                            <Chip 
                                size="sm" 
                                variant="flat" 
                                color={sale.paymentMethod === 'EFECTIVO' ? 'success' : (sale.paymentMethod === 'MIXTO' ? 'secondary' : 'primary')}
                                className="font-black text-[9px] uppercase tracking-tighter"
                            >
                                {sale.paymentMethod}
                            </Chip>
                        </TableCell>
                        <TableCell>
                            <span className="text-gray-900 dark:text-white font-black italic text-sm tracking-tighter tabular-nums">
                                {formatCurrency(sale.total)}
                            </span>
                        </TableCell>
                        <TableCell>
                            <div className="flex items-center justify-center gap-2">
                                <Tooltip content="AUDITAR DETALLE" closeDelay={0} classNames={{ content: "font-black text-[10px] uppercase tracking-widest bg-gray-900 dark:bg-white text-white dark:text-black rounded-lg" }}>
                                    <Button isIconOnly size="sm" variant="light" className="text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded-lg active:scale-90" onPress={() => onOpenPreview(sale)}>
                                        <Eye size={18} />
                                    </Button>
                                </Tooltip>
                                <Tooltip content="CORREGIR REGISTRO" closeDelay={0} classNames={{ content: "font-black text-[10px] uppercase tracking-widest bg-gray-900 dark:bg-white text-white dark:text-black rounded-lg" }}>
                                    <Button isIconOnly size="sm" variant="light" className="text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-500/10 rounded-lg active:scale-90" onPress={() => onOpenEdit(sale)}>
                                        <Edit3 size={18} />
                                    </Button>
                                </Tooltip>
                            </div>
                        </TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    );
}

// Add missing icon
const HistoryIcon = ({ size, className }: { size: number, className: string }) => (
    <div className={className}><DollarSign size={size} /></div>
);
