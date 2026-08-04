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
    PlusCircle,
    FileText,
    History
} from 'lucide-react';
import { Customer } from '@/lib/definitions';

interface TableProps {
    customers: Customer[];
    onPay: (customer: Customer) => void;
    onEdit: (customer: Customer) => void;
    onDelete: (dni: string) => void;
    onViewStatement: (customer: Customer) => void;
    currentPage: number;
    totalPages: number;
    pageSize: number;
    totalRecords: number;
    onPageChange: (page: number) => void;
    onPageSizeChange: (size: number) => void;
    onAdd?: () => void;
    isAdmin?: boolean;
}

const COLUMNS = [
    { name: "IDENTIFICACION / CLIENTE", uid: "identity", align: "start" },
    { name: "LINEA DIRECTA", uid: "contact", align: "center", hideOnMobile: true },
    { name: "BALANCE CARTERA", uid: "balance", align: "center" },
    { name: "GESTION", uid: "actions", align: "end" },
];

const CustomerTable = memo(({
    customers, onPay, onEdit, onDelete, onViewStatement,
    currentPage, totalPages, pageSize, totalRecords,
    onPageChange, onPageSizeChange, onAdd, isAdmin
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
                    <div className="flex-1 min-h-0 h-full flex items-center gap-4 py-0.5 group/id">
                        <div className="relative shrink-0">
                            <Avatar
                                size="sm"
                                name={c.name[0]}
                                className="h-10 w-10 text-xs font-medium bg-black/5 dark:bg-white/5 text-zinc-900 dark:text-zinc-100 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-emerald-500/20 group-hover/id:scale-110 transition-transform"
                            />
                            {Number(c.currentCredit) > 0 && (
                                <div className="absolute -top-1 -right-1 h-3 w-3 bg-rose-500 border-2 border-white dark:border-zinc-900 rounded-2xl animate-pulse shadow-[0_8px_30px_rgb(0,0,0,0.12)] z-10" />
                            )}
                        </div>
                        <div className="flex flex-col flex-1 min-h-0 min-w-0 h-full w-full">
                            <span className="text-[11px] font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight leading-tight truncate max-w-[150px] md:max-w-none group-hover/id:text-zinc-900 dark:text-zinc-100 transition-colors">
                                {c.name}
                            </span>
                            <span className="text-[8px] font-bold text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest mt-0.5 leading-none">
                                CC: {c.dni}
                            </span>
                        </div>
                    </div>
                );
            case "contact":
                return (
                    <div className="flex justify-center">
                        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-2xl bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/5 w-full max-w-[140px] shadow-[0_8px_30px_rgb(0,0,0,0.12)] tracking-tight transition-all hover:border-emerald-500/30">
                            <Phone size={10} className="text-zinc-900 dark:text-zinc-100" />
                            <span className="text-[9px] font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-widest tabular-nums leading-none">
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
                            className={`font-medium text-[9px] h-6 px-3 border-none shadow-[0_8px_30px_rgb(0,0,0,0.12)] uppercase tracking-widest tracking-tight leading-none ${debt > 0
                                    ? 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400'
                                    : 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 dark:bg-white/5 text-zinc-900 dark:text-zinc-100 dark:text-zinc-300'
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
                            <Button
                                size="md"
                                onPress={() => onPay(c)}
                                className="h-11 px-6 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white font-medium rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95 transition-all animate-pulse flex items-center gap-3 border-2 border-black/10 dark:border-white/20"
                            >
                                <DollarSign size={18} strokeWidth={4} />
                                <span className="text-[12px] tracking-[0.15em] mb-0.5">ABONAR</span>
                            </Button>
                        )}
                        <Tooltip content="EDITAR" delay={0} placement="top" classNames={{ content: "font-medium text-[9px] uppercase tracking-widest bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white py-1 px-2 rounded-none shadow-[0_8px_30px_rgb(0,0,0,0.12)]" }}>
                            <Button
                                isIconOnly
                                size="sm"
                                variant="flat"
                                className="h-8 w-8 md:h-9 md:w-9 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-zinc-900 dark:text-zinc-100 hover:text-white hover:bg-zinc-50 dark:hover:bg-white/5 bg-white dark:bg-transparent border border-zinc-200 dark:border-white/5 transition-all rounded-2xl md:rounded-2xl border border-emerald-500/10 active:scale-90"
                                onPress={() => onEdit(c)}
                            >
                                <Edit size={14} />
                            </Button>
                        </Tooltip>
                        {isAdmin && (
                            <Tooltip content="ELIMINAR" delay={0} placement="top-end" classNames={{ content: "font-medium text-[9px] uppercase tracking-widest bg-rose-500 text-white py-1 px-2 rounded-none shadow-[0_8px_30px_rgb(0,0,0,0.12)]" }}>
                                <Button
                                    isIconOnly
                                    size="sm"
                                    variant="flat"
                                    className="h-8 w-8 md:h-9 md:w-9 bg-rose-500/5 text-rose-500 hover:text-white hover:bg-rose-500 transition-all rounded-2xl md:rounded-2xl border border-rose-500/10 active:scale-90"
                                    onPress={() => onDelete(c.dni)}
                                >
                                    <Trash2 size={14} />
                                </Button>
                            </Tooltip>
                        )}
                        <Button
                            size="md"
                            onPress={() => onViewStatement(c)}
                            className="h-11 px-6 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95 transition-all flex items-center gap-2.5 border-2 border-black/10 dark:border-white/20"
                        >
                            <History size={18} strokeWidth={2.5} />
                            <span className="text-[12px] tracking-[0.15em] mb-0.5">HISTORIAL</span>
                        </Button>
                    </div>
                );
            default:
                return null;
        }
    }, [onPay, onEdit, onDelete, onViewStatement]);

    return (
        <div className="flex-1 min-h-0 h-full w-full bg-black/5 dark:bg-[#18181b]/30 border border-gray-200 dark:border-white/5 rounded-2xl overflow-hidden flex flex-col shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-emerald-500/5 transition-all">

            <div className="flex flex-col flex-1 min-h-0 min-w-0 h-full w-full relative">
                {!isMobile ? (
                    <div className="overflow-auto overscroll-contain custom-scrollbar w-full flex-1 min-h-0 h-full">
                        <Table
                            isCompact
                            removeWrapper
                            isHeaderSticky
                            aria-label="Registro Maestro Clientes"
                            classNames={{
                                base: "min-w-[720px]",
                                th: "bg-[#f9fafb] dark:bg-[#09090b] text-gray-500 dark:text-zinc-400 font-extrabold uppercase text-[10px] tracking-[0.2em] h-12 py-2 border-b-2 border-gray-200 dark:border-white/10 sticky top-0 !z-[500] shadow-[0_8px_30px_rgb(0,0,0,0.12)]",
                                td: "py-1.5 font-medium border-b border-gray-100 dark:border-white/5",
                                tr: "hover:bg-zinc-50 dark:hover:bg-white/5 bg-white dark:bg-transparent border border-zinc-200 dark:border-white/5 transition-colors border-l-4 border-transparent hover:border-emerald-500 active:bg-black/5 dark:bg-white/5 h-10 relative z-0"
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
                                emptyContent={
                                    <div className="py-24 flex flex-col items-center justify-center text-gray-400 dark:text-zinc-700">
                                        <div className="h-20 w-20 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 rounded-2xl flex items-center justify-center mb-4 border border-emerald-500/10">
                                            <SearchX size={32} strokeWidth={1} className="opacity-40" />
                                        </div>
                                        <span className="text-[10px] font-medium uppercase tracking-[0.5em] tracking-tight mb-6">Red Inactiva de Clientes</span>
                                        {onAdd && (
                                            <Button
                                                onPress={onAdd}
                                                className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white font-medium text-[9px] uppercase tracking-widest tracking-tight rounded-2xl px-8 shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95 transition-all"
                                            >
                                                <PlusCircle size={14} className="mr-2" /> REGISTRAR PRIMER CLIENTE
                                            </Button>
                                        )}
                                    </div>
                                }
                                items={customers || []}
                            >
                                {(item) => (
                                    <TableRow key={item.dni}>
                                        {COLUMNS.map((column) => (
                                            <TableCell key={column.uid}>{renderCell(item, column.uid)}</TableCell>
                                        ))}
                                    </TableRow>
                                )}
                            </TableBody>
                        </Table>
                    </div>
                ) : (
                    <div className="overflow-y-auto scroll-smooth custom-scrollbar p-2 flex flex-col gap-2 bg-gray-50/50 dark:bg-[#18181b] flex-1 min-h-0 h-full">
                        {customers.length === 0 ? (
                            <div className="py-24 flex flex-col items-center justify-center text-gray-400 dark:text-zinc-700">
                                <SearchX size={32} strokeWidth={1} className="mb-4 opacity-20" />
                                <span className="text-[8px] font-medium uppercase tracking-[0.3em] tracking-tight">Sin resultados</span>
                                {onAdd && (
                                    <Button
                                        onPress={onAdd}
                                        className="mt-4 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white font-medium text-[8px] uppercase tracking-widest tracking-tight rounded-2xl px-6 shadow-[0_8px_30px_rgb(0,0,0,0.12)]"
                                    >
                                        <PlusCircle size={12} className="mr-2" /> CREAR NUEVO
                                    </Button>
                                )}
                            </div>
                        ) : (
                            customers.map((c) => (
                                <div key={c.dni} className="p-4 rounded-2xl border card-base border-none border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex items-center justify-between gap-4 transition-all shrink-0">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className="relative shrink-0">
                                            <Avatar
                                                size="sm"
                                                name={c.name[0]}
                                                className="h-10 w-10 bg-black/5 dark:bg-white/5 text-zinc-900 dark:text-zinc-100 rounded-2xl font-medium tracking-tight shadow-inner border border-emerald-500/20"
                                            />
                                            {Number(c.currentCredit) > 0 && (
                                                <div className="absolute -top-1 -right-1 h-3 w-3 bg-rose-500 border-2 border-white dark:border-zinc-900 rounded-2xl animate-pulse shadow-rose-500/50" />
                                            )}
                                        </div>
                                        <div className="flex flex-col flex-1 min-h-0 min-w-0 h-full w-full">
                                            <span className="text-[11px] font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight leading-none truncate max-w-[140px] mb-1">
                                                {c.name}
                                            </span>
                                            <div className="flex items-center gap-2">
                                                <span className="text-[7px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-widest tracking-tight opacity-80 leading-none">
                                                    CC: {c.dni}
                                                </span>
                                                <span className="text-[8px] text-gray-300 dark:text-zinc-700 opacity-30">|</span>
                                                <div className="flex items-center gap-1">
                                                    <CreditCard size={8} className="text-gray-400 shrink-0" />
                                                    <span className={`text-[8px] font-medium tracking-tight tabular-nums leading-none ${Number(c.currentCredit) > 0 ? 'text-rose-500' : 'text-zinc-900 dark:text-zinc-100/60'}`}>
                                                        ${Number(c.currentCredit).toLocaleString()}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        {Number(c.currentCredit) > 0 && (
                                            <Button size="sm" className="h-10 px-4 bg-emerald-500 text-white rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex items-center gap-2 active:scale-95 transition-all animate-pulse border border-zinc-200 dark:border-white/10" onPress={() => onPay(c)}>
                                                <DollarSign size={15} strokeWidth={3} />
                                                <span className="text-[10px] font-medium tracking-wider mb-0.5">ABONAR</span>
                                            </Button>
                                        )}
                                        <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-gray-100 dark:bg-zinc-800 rounded-2xl text-gray-500" onPress={() => onEdit(c)}>
                                            <Edit size={14} />
                                        </Button>
                                        {isAdmin && (
                                            <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-rose-500/10 text-rose-500 rounded-2xl" onPress={() => onDelete(c.dni)}>
                                                <Trash2 size={14} />
                                            </Button>
                                        )}
                                        <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-blue-500/10 text-blue-500 rounded-2xl" onPress={() => onViewStatement(c)}>
                                            <FileText size={14} />
                                        </Button>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                )}
            </div>

            {/* PAGINACION FIJA - SINCRONIZADA CON USERS */}
            {totalRecords > 0 && (
                <div className="shrink-0 px-3 py-2 flex items-center justify-between gap-2 border-t border-gray-200 dark:border-white/10 bg-gray-50/95 dark:bg-zinc-950 z-40 shadow-[0_-4px_15px_rgba(0,0,0,0.1)]">
                    <div className="flex items-center gap-2 font-medium">
                        <Button
                            isIconOnly
                            size="sm"
                            variant="flat"
                            onPress={() => onPageChange(Math.max(1, currentPage - 1))}
                            isDisabled={currentPage === 1}
                            className="h-8 w-8 min-w-0 card-base border-none text-zinc-900 dark:text-zinc-50 rounded-2xl border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-90 transition-transform"
                        >
                            <ChevronLeft size={18} />
                        </Button>

                        <div className="flex flex-col items-start px-1 leading-none">
                            <span className="text-[7px] text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase font-medium tracking-tighter">MOSTRANDO</span>
                            <p className="text-[10px] text-zinc-900 dark:text-zinc-50 uppercase tracking-widest flex items-center gap-1">
                                <span className="tracking-tight font-medium text-zinc-900 dark:text-zinc-100">{((currentPage - 1) * pageSize + 1)}-{Math.min(currentPage * pageSize, totalRecords)}</span>
                                <span className="opacity-20 text-[8px]">DE</span>
                                <span className="tracking-tight font-medium">{totalRecords}</span>
                            </p>
                        </div>

                        <Button
                            isIconOnly
                            size="sm"
                            variant="flat"
                            onPress={() => onPageChange(Math.min(totalPages, currentPage + 1))}
                            isDisabled={currentPage === totalPages || totalPages === 0}
                            className="h-8 w-8 min-w-0 card-base border-none text-zinc-900 dark:text-zinc-50 rounded-2xl border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-90 transition-transform"
                        >
                            <ChevronRight size={18} />
                        </Button>
                    </div>

                    <div className="flex items-center gap-2">
                        <div className="relative">
                            <select
                                value={pageSize}
                                onChange={(e) => onPageSizeChange(Number(e.target.value))}
                                className="h-8 card-base border-none text-zinc-900 dark:text-zinc-50 text-[10px] font-medium uppercase tracking-widest px-2 pr-6 outline-none rounded-2xl border border-gray-200 dark:border-white/10 cursor-pointer shadow-[0_8px_30px_rgb(0,0,0,0.12)] appearance-none"
                            >
                                {[10, 20, 50, 10000].map(n => <option key={n} value={n}>{n === 10000 ? 'TODOS' : n}</option>)}
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



