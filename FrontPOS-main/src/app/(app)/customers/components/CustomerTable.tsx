"use client";

import React, { memo } from 'react';
import {
    Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
    Button, Chip, Avatar, Tooltip
} from "@heroui/react";
import { 
    Edit, 
    Trash2, 
    Phone, 
    DollarSign, 
    SearchX,
    ChevronLeft,
    ChevronRight,
    Info,
    CreditCard,
    PlusCircle
} from 'lucide-react';
import { Customer } from '@/lib/definitions';

interface TableProps {
    customers: Customer[];
    onPay: (customer: Customer) => void;
    onEdit: (customer: Customer) => void;
    onDelete: (dni: string) => void;
    currentPage: number;
    totalPages: number;
    pageSize: number;
    totalRecords: number;
    onPageChange: (page: number) => void;
    onPageSizeChange: (size: number) => void;
    onAdd?: () => void;
}

const COLUMNS = [
    { name: "IDENTIFICACIÓN / CLIENTE", uid: "identity", align: "start" },
    { name: "LÍNEA DIRECTA", uid: "contact", align: "center", hideOnMobile: true },
    { name: "BALANCE CARTERA", uid: "balance", align: "center" },
    { name: "GESTIÓN", uid: "actions", align: "end" },
];

const CustomerTable = memo(({ 
    customers, onPay, onEdit, onDelete,
    currentPage, totalPages, pageSize, totalRecords,
    onPageChange, onPageSizeChange, onAdd
}: TableProps) => {
    const [isMobile, setIsMobile] = React.useState(false);

    React.useEffect(() => {
        const mql = window.matchMedia("(max-width: 768px)");
        const onChange = () => setIsMobile(mql.matches);
        mql.addEventListener("change", onChange);
        setIsMobile(mql.matches);
        return () => mql.removeEventListener("change", onChange);
    }, []);

    const renderCell = React.useCallback((c: Customer, columnKey: React.Key) => {
        switch (columnKey) {
            case "identity":
                return (
                    <div className="flex items-center gap-4 py-0.5 group/id">
                        <div className="relative shrink-0">
                            <Avatar 
                                size="sm" 
                                name={c.name[0]} 
                                className="h-10 w-10 text-xs font-black bg-emerald-500/10 text-emerald-500 rounded-2xl shadow-sm border border-emerald-500/20 group-hover/id:scale-110 transition-transform" 
                            />
                            {Number(c.currentCredit) > 0 && (
                                <div className="absolute -top-1 -right-1 h-3 w-3 bg-rose-500 border-2 border-white dark:border-zinc-900 rounded-full animate-pulse shadow-lg z-10" />
                            )}
                        </div>
                        <div className="flex flex-col min-w-0">
                            <span className="text-[11px] font-black text-gray-900 dark:text-white uppercase italic leading-tight truncate max-w-[150px] md:max-w-none group-hover/id:text-emerald-500 transition-colors">
                                {c.name}
                            </span>
                            <span className="text-[8px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest mt-0.5 leading-none">
                                CC: {c.dni}
                            </span>
                        </div>
                    </div>
                );
            case "contact":
                return (
                    <div className="flex justify-center">
                        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/5 w-full max-w-[140px] shadow-sm italic transition-all hover:border-emerald-500/30">
                            <Phone size={10} className="text-emerald-500" />
                            <span className="text-[9px] font-black text-gray-900 dark:text-white uppercase tracking-widest tabular-nums leading-none">
                                {c.phone || 'S.T.'}
                            </span>
                        </div>
                    </div>
                );
            case "balance":
                const debt = Number(c.currentCredit);
                return (
                    <div className="flex justify-center">
                        <Chip 
                            size="sm" 
                            variant="flat" 
                            className={`font-black text-[9px] h-6 px-3 border-none shadow-sm uppercase tracking-widest italic leading-none ${
                                debt > 0 
                                    ? 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400' 
                                    : 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            }`}
                        >
                            $ {debt.toLocaleString()}
                        </Chip>
                    </div>
                );
            case "actions":
                return (
                    <div className="flex justify-end gap-1 px-1 items-center">
                        {Number(c.currentCredit) > 0 && (
                            <Tooltip content="ABONAR" delay={0} placement="top" classNames={{ content: "font-black text-[9px] uppercase tracking-widest bg-emerald-500 text-white py-1 px-2 rounded-none shadow-xl" }}>
                                <Button 
                                    isIconOnly
                                    size="sm" 
                                    onPress={() => onPay(c)} 
                                    className="h-8 w-8 md:h-9 md:w-9 bg-emerald-500 text-white font-black rounded-lg md:rounded-xl shadow-lg shadow-emerald-500/20 active:scale-90 transition-all"
                                >
                                    <DollarSign size={16} strokeWidth={3} />
                                </Button>
                            </Tooltip>
                        )}
                        <Tooltip content="EDITAR" delay={0} placement="top" classNames={{ content: "font-black text-[9px] uppercase tracking-widest bg-emerald-500 text-white py-1 px-2 rounded-none shadow-xl" }}>
                            <Button 
                                isIconOnly 
                                size="sm" 
                                variant="flat" 
                                className="h-8 w-8 md:h-9 md:w-9 bg-emerald-500/5 text-emerald-500 hover:text-white hover:bg-emerald-500 transition-all rounded-lg md:rounded-xl border border-emerald-500/10 active:scale-90" 
                                onPress={() => onEdit(c)}
                            >
                                <Edit size={14} />
                            </Button>
                        </Tooltip>
                        <Tooltip content="ELIMINAR" delay={0} placement="top-end" classNames={{ content: "font-black text-[9px] uppercase tracking-widest bg-rose-500 text-white py-1 px-2 rounded-none shadow-xl" }}>
                            <Button 
                                isIconOnly 
                                size="sm" 
                                variant="flat" 
                                className="h-8 w-8 md:h-9 md:w-9 bg-rose-500/5 text-rose-500 hover:text-white hover:bg-rose-500 transition-all rounded-lg md:rounded-xl border border-rose-500/10 active:scale-90" 
                                onPress={() => onDelete(c.dni)}
                            >
                                <Trash2 size={14} />
                            </Button>
                        </Tooltip>
                    </div>
                );
            default:
                return null;
        }
    }, [onPay, onEdit, onDelete]);

    return (
        <div className="flex-1 min-h-0 bg-white/50 dark:bg-zinc-900/30 backdrop-blur-sm border border-gray-200 dark:border-white/5 rounded-2xl overflow-hidden flex flex-col shadow-2xl shadow-emerald-500/5 transition-all">
            
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
                {!isMobile ? (
                    <Table 
                        isCompact 
                        removeWrapper 
                        isHeaderSticky
                        aria-label="Registro Maestro Clientes"
                        className="flex-1"
                        classNames={{ 
                            base: "flex-1 overflow-hidden",
                            wrapper: "flex-1 overflow-auto custom-scrollbar bg-transparent shadow-none p-0 rounded-none",
                            th: "bg-[#f9fafb] dark:bg-[#09090b] text-gray-500 dark:text-zinc-400 font-extrabold uppercase text-[10px] tracking-[0.2em] h-12 py-2 border-b-2 border-gray-200 dark:border-white/10 sticky top-0 !z-[500] shadow-sm", 
                            td: "py-1.5 font-medium border-b border-gray-100 dark:border-white/5", 
                            tr: "hover:bg-emerald-500/5 dark:hover:bg-emerald-500/5 transition-colors border-l-4 border-transparent hover:border-emerald-500 active:bg-emerald-500/10 h-10 relative z-0" 
                        }}
                    >
                        <TableHeader columns={COLUMNS}>
                            {(column) => (
                                <TableColumn 
                                    key={column.uid} 
                                    align={column.align as any}
                                    className={column.hideOnMobile ? "hidden md:table-cell" : ""}
                                >
                                    {column.name}
                                </TableColumn>
                            )}
                        </TableHeader>
                        <TableBody 
                            items={customers || []} 
                            emptyContent={
                                <div className="py-24 flex flex-col items-center justify-center text-gray-400 dark:text-zinc-700">
                                    <div className="h-20 w-20 bg-emerald-500/5 rounded-full flex items-center justify-center mb-4 border border-emerald-500/10">
                                        <SearchX size={32} strokeWidth={1} className="opacity-40" />
                                    </div>
                                    <span className="text-[10px] font-black uppercase tracking-[0.5em] italic mb-6">Red Inactiva de Clientes</span>
                                    {onAdd && (
                                        <Button 
                                            onPress={onAdd}
                                            className="bg-emerald-500 text-white font-black text-[9px] uppercase tracking-widest italic rounded-xl px-8 shadow-lg shadow-emerald-500/20 active:scale-95 transition-all"
                                        >
                                            <PlusCircle size={14} className="mr-2" /> REGISTRAR PRIMER CLIENTE
                                        </Button>
                                    )}
                                </div>
                            }
                        >
                            {(item) => (
                                <TableRow key={item.dni}>
                                    {(columnKey) => <TableCell>{renderCell(item, columnKey)}</TableCell>}
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                ) : (
                    <div className="flex-1 min-h-0 overflow-auto scroll-smooth custom-scrollbar p-2 flex flex-col gap-2 bg-gray-50/50 dark:bg-black/20">
                        {customers.length === 0 ? (
                            <div className="py-24 flex flex-col items-center justify-center text-gray-400 dark:text-zinc-700">
                                <SearchX size={32} strokeWidth={1} className="mb-4 opacity-20" />
                                <span className="text-[8px] font-black uppercase tracking-[0.3em] italic">Sin resultados</span>
                                {onAdd && (
                                    <Button 
                                        onPress={onAdd}
                                        className="mt-4 bg-emerald-500 text-white font-black text-[8px] uppercase tracking-widest italic rounded-lg px-6 shadow-lg shadow-emerald-500/20"
                                    >
                                        <PlusCircle size={12} className="mr-2" /> CREAR NUEVO
                                    </Button>
                                )}
                            </div>
                        ) : (
                            customers.map((c) => (
                                <div key={c.dni} className="p-4 rounded-xl border bg-white dark:bg-zinc-900 border-gray-200 dark:border-white/5 shadow-sm flex items-center justify-between gap-4 transition-all shrink-0">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className="relative shrink-0">
                                            <Avatar 
                                                size="sm" 
                                                name={c.name[0]} 
                                                className="h-10 w-10 bg-emerald-500/10 text-emerald-500 rounded-xl font-black italic shadow-inner border border-emerald-500/20" 
                                            />
                                            {Number(c.currentCredit) > 0 && (
                                                <div className="absolute -top-1 -right-1 h-3 w-3 bg-rose-500 border-2 border-white dark:border-zinc-900 rounded-full animate-pulse shadow-rose-500/50" />
                                            )}
                                        </div>
                                        <div className="flex flex-col min-w-0">
                                            <span className="text-[11px] font-black text-gray-900 dark:text-white uppercase italic leading-none truncate max-w-[140px] mb-1">
                                                {c.name}
                                            </span>
                                            <div className="flex items-center gap-2">
                                                <span className="text-[7px] font-black text-emerald-500 uppercase tracking-widest italic opacity-80 leading-none">
                                                    CC: {c.dni}
                                                </span>
                                                <span className="text-[8px] text-gray-300 dark:text-zinc-700 opacity-30">|</span>
                                                <div className="flex items-center gap-1">
                                                    <CreditCard size={8} className="text-gray-400 shrink-0" />
                                                    <span className={`text-[8px] font-black italic tabular-nums leading-none ${Number(c.currentCredit) > 0 ? 'text-rose-500' : 'text-emerald-500/60'}`}>
                                                        ${Number(c.currentCredit).toLocaleString()}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        {Number(c.currentCredit) > 0 && (
                                            <Button isIconOnly size="sm" className="h-8 w-8 bg-emerald-500 text-white rounded-lg shadow-lg shadow-emerald-500/20" onPress={() => onPay(c)}>
                                                <DollarSign size={14} strokeWidth={3} />
                                            </Button>
                                        )}
                                        <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-gray-100 dark:bg-zinc-800 rounded-lg text-gray-500" onPress={() => onEdit(c)}>
                                            <Edit size={14} />
                                        </Button>
                                        <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-rose-500/10 text-rose-500 rounded-lg" onPress={() => onDelete(c.dni)}>
                                            <Trash2 size={14} />
                                        </Button>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                )}
            </div>

            {/* PAGINACIÓN FIJA - SINCRONIZADA CON USERS */}
            {totalRecords > 0 && (
                <div className="shrink-0 px-3 py-2 flex items-center justify-between gap-2 border-t border-gray-200 dark:border-white/10 bg-gray-50/95 dark:bg-zinc-950 backdrop-blur-md z-40 shadow-[0_-4px_15px_rgba(0,0,0,0.1)]">
                    <div className="flex items-center gap-2 font-black">
                        <Button
                            isIconOnly
                            size="sm"
                            variant="flat"
                            onPress={() => onPageChange(Math.max(1, currentPage - 1))}
                            isDisabled={currentPage === 1}
                            className="h-8 w-8 min-w-0 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white rounded-lg border border-gray-200 dark:border-white/5 shadow-sm active:scale-90 transition-transform"
                        >
                            <ChevronLeft size={18} />
                        </Button>
                        
                        <div className="flex flex-col items-start px-1 leading-none">
                            <span className="text-[7px] text-gray-400 dark:text-zinc-500 uppercase font-black tracking-tighter">MOSTRANDO</span>
                            <p className="text-[10px] text-gray-900 dark:text-white uppercase tracking-widest flex items-center gap-1">
                                <span className="italic font-black text-emerald-500">{((currentPage - 1) * pageSize + 1)}-{Math.min(currentPage * pageSize, totalRecords)}</span> 
                                <span className="opacity-20 text-[8px]">DE</span> 
                                <span className="italic font-black">{totalRecords}</span>
                            </p>
                        </div>

                        <Button
                            isIconOnly
                            size="sm"
                            variant="flat"
                            onPress={() => onPageChange(Math.min(totalPages, currentPage + 1))}
                            isDisabled={currentPage === totalPages || totalPages === 0}
                            className="h-8 w-8 min-w-0 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white rounded-lg border border-gray-200 dark:border-white/5 shadow-sm active:scale-90 transition-transform"
                        >
                            <ChevronRight size={18} />
                        </Button>
                    </div>

                    <div className="flex items-center gap-2">
                        <div className="relative">
                            <select 
                                value={pageSize} 
                                onChange={(e) => onPageSizeChange(Number(e.target.value))} 
                                className="h-8 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white text-[10px] font-black uppercase tracking-widest px-2 pr-6 outline-none rounded-lg border border-gray-200 dark:border-white/10 cursor-pointer shadow-sm appearance-none"
                            >
                                {[10, 20, 50].map(n => <option key={n} value={n}>{n}</option>)}
                            </select>
                            <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-30">
                                <Info size={10} />
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

CustomerTable.displayName = 'CustomerTable';
export default CustomerTable;
