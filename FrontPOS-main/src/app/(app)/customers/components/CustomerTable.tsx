"use client";

import React, { memo } from 'react';
import {
    Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
    Button, Chip, Avatar
} from "@heroui/react";
import { 
    Edit, 
    Trash2, 
    Phone, 
    DollarSign, 
    SearchX
} from 'lucide-react';
import { Customer } from '@/lib/definitions';

interface TableProps {
    customers: Customer[];
    onPay: (customer: Customer) => void;
    onEdit: (customer: Customer) => void;
    onDelete: (dni: string) => void;
}

const CustomerTable = memo(({ customers, onPay, onEdit, onDelete }: TableProps) => {
    return (
        <div className="flex-1 bg-white/90 dark:bg-zinc-950/60 backdrop-blur-3xl border border-gray-200 dark:border-white/10 rounded-[2.5rem] overflow-hidden flex flex-col min-h-0 shadow-2xl transition-all">
            <div className="flex-1 overflow-x-auto w-full custom-scrollbar">
                <Table 
                    isCompact 
                    removeWrapper 
                    aria-label="Directorio Principal de Clientes"
                    classNames={{ 
                        th: "bg-transparent text-gray-400 dark:text-emerald-500/50 font-black uppercase text-[9px] tracking-widest h-14 py-1 border-b border-emerald-500/10 sticky top-0 z-20 px-6", 
                        td: "py-4 border-b border-emerald-500/5 px-6", 
                        tr: "hover:bg-emerald-500/5 transition-colors border-l-4 border-transparent hover:border-emerald-500 active:bg-emerald-500/10 cursor-pointer group" 
                    }}
                >
                    <TableHeader>
                        <TableColumn>ENTIDAD / IDENTIFICACIÓN</TableColumn>
                        <TableColumn align="center" className="hidden md:table-cell">LÍNEA DIRECTA</TableColumn>
                        <TableColumn align="center">BALANCE CARTERA</TableColumn>
                        <TableColumn align="end">ACCIONES DE GESTIÓN</TableColumn>
                    </TableHeader>
                    <TableBody 
                        emptyContent={
                            <div className="py-24 flex flex-col items-center justify-center text-gray-400 dark:text-zinc-700">
                                <SearchX size={48} strokeWidth={1} className="mb-4 opacity-20" />
                                <span className="text-[10px] font-black uppercase tracking-[0.5em] italic">No se hallaron registros en la base de datos</span>
                            </div>
                        }
                    >
                        {customers.map((c) => (
                            <TableRow key={c.dni}>
                                <TableCell>
                                    <div className="flex items-center gap-4">
                                        <div className="relative">
                                            <Avatar 
                                                size="sm" 
                                                name={c.name[0]} 
                                                className="h-10 w-10 text-xs font-black bg-emerald-500/10 text-emerald-500 rounded-2xl shadow-sm border border-emerald-500/20" 
                                            />
                                            {Number(c.currentCredit) > 0 && (
                                                <div className="absolute -top-1 -right-1 h-3 w-3 bg-rose-500 border-2 border-white dark:border-zinc-900 rounded-full animate-pulse" />
                                            )}
                                        </div>
                                        <div className="flex flex-col min-w-0">
                                            <span className="text-sm font-black text-gray-900 dark:text-white uppercase leading-tight italic truncate max-w-[150px] md:max-w-none group-hover:text-emerald-500 transition-colors">
                                                {c.name}
                                            </span>
                                            <span className="text-[9px] text-gray-400 dark:text-zinc-500 font-mono tracking-widest mt-1 uppercase">
                                                ID: {c.dni}
                                            </span>
                                        </div>
                                    </div>
                                </TableCell>
                                <TableCell className="hidden md:table-cell">
                                    <div className="inline-flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/5 w-full max-w-[120px]">
                                        <Phone size={10} className="text-gray-400" />
                                        <span className="text-[10px] font-black text-gray-900 dark:text-white uppercase tracking-widest italic leading-none">
                                            {c.phone || 'S.T.'}
                                        </span>
                                    </div>
                                </TableCell>
                                <TableCell>
                                    <div className="flex justify-center">
                                        <Chip 
                                            size="sm" 
                                            variant="flat" 
                                            className={`font-black text-[10px] h-6 px-3 border-none shadow-sm ${
                                                Number(c.currentCredit) > 0 
                                                    ? 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400' 
                                                    : 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                            }`}
                                        >
                                            $ {Number(c.currentCredit).toLocaleString()}
                                        </Chip>
                                    </div>
                                </TableCell>
                                <TableCell>
                                    <div className="flex justify-end gap-2">
                                        {Number(c.currentCredit) > 0 && (
                                            <Button 
                                                size="sm" 
                                                onPress={() => onPay(c)} 
                                                className="h-9 px-5 bg-emerald-500 text-white font-black text-[10px] rounded-xl shadow-lg shadow-emerald-500/20 italic hover:scale-105 active:scale-95 transition-all"
                                            >
                                                <DollarSign size={14} className="mr-1" /> ABONAR
                                            </Button>
                                        )}
                                        <Button 
                                            isIconOnly 
                                            size="sm" 
                                            variant="flat" 
                                            className="h-9 w-9 bg-gray-50 dark:bg-zinc-800 text-gray-400 dark:text-zinc-500 hover:text-emerald-500 hover:bg-emerald-500/10 rounded-xl transition-all border border-gray-200 dark:border-white/5" 
                                            onPress={() => onEdit(c)}
                                        >
                                            <Edit size={14} />
                                        </Button>
                                        <Button 
                                            isIconOnly 
                                            size="sm" 
                                            variant="flat" 
                                            className="h-9 w-9 bg-gray-50 dark:bg-zinc-800 text-gray-400 dark:text-zinc-500 hover:text-rose-500 hover:bg-rose-500/10 rounded-xl transition-all border border-gray-200 dark:border-white/5" 
                                            onPress={() => onDelete(c.dni)}
                                        >
                                            <Trash2 size={14} />
                                        </Button>
                                    </div>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
});

CustomerTable.displayName = 'CustomerTable';
export default CustomerTable;
