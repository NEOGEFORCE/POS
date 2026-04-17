"use client";

import React, { memo } from 'react';
import {
    Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
    Button, Chip, Avatar, Tooltip
} from "@heroui/react";
import { Edit, Trash2, Zap, ShieldCheck, Info, Calendar, Clock, UserCheck } from 'lucide-react';
import { User } from '@/lib/definitions';

interface TableProps {
    users: User[];
    onEdit: (user: User) => void;
    onDelete: (dni: string) => void;
    onResetPassword: (user: User) => void;
    currentPage: number;
    totalPages: number;
    pageSize: number;
    totalRecords: number;
    onPageChange: (page: number) => void;
    onPageSizeChange: (size: number) => void;
}

const COLUMNS = [
    { name: "IDENTIDAD", uid: "identity", align: "start" },
    { name: "NIVEL ACCESO", uid: "role", align: "center" },
    { name: "ESTADO", uid: "status", align: "center" },
    { name: "REGISTRO", uid: "registration", align: "center", hideOnMobile: true },
    { name: "DETALLES", uid: "insights", align: "center", hideOnMobile: true },
    { name: "GESTIÓN", uid: "actions", align: "end" },
];

const UserTable = memo(({ 
    users, onEdit, onDelete, onResetPassword, currentPage, totalPages, pageSize, totalRecords, onPageChange, onPageSizeChange 
}: TableProps) => {
    const [isMobile, setIsMobile] = React.useState(false);

    React.useEffect(() => {
        const mql = window.matchMedia("(max-width: 768px)");
        const onChange = () => setIsMobile(mql.matches);
        mql.addEventListener("change", onChange);
        setIsMobile(mql.matches);
        return () => mql.removeEventListener("change", onChange);
    }, []);

    const renderCell = React.useCallback((u: User, columnKey: React.Key) => {
        const isSuperAdmin = (u.role || (u as any).Role || '').toLowerCase() === 'superadmin';
        const roleDisplay = u.role || (u as any).Role || 'EMPLEADO';
        
        // Simulación de fecha si no existe el campo en el objeto User
        const createdAt = (u as any).created_at || new Date().toISOString();
        const formattedDate = new Date(createdAt).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });

        switch (columnKey) {
            case "identity":
                return (
                    <div className="flex items-center gap-4 py-1">
                        <div className="relative group">
                            <Avatar 
                                isBordered
                                radius="lg"
                                size="md" 
                                name={u.name || (u as any).Name || 'U'} 
                                className="h-11 w-11 shrink-0 border border-white dark:border-zinc-800 shadow-md transition-transform group-hover:scale-105" 
                                classNames={{ base: "bg-emerald-100 dark:bg-emerald-500/10", name: "text-emerald-700 dark:text-emerald-500 font-black uppercase italic" }} 
                            />
                            {isSuperAdmin && (
                                <div className="absolute -bottom-1 -right-1 bg-black dark:bg-white text-white dark:text-black rounded-full p-1.5 shadow-xl border-2 border-white dark:border-zinc-950 z-20 scale-90 animate-appearance-in">
                                    <ShieldCheck size={10} />
                                </div>
                            )}
                        </div>
                        <div className="flex flex-col">
                            <span className="text-sm font-black text-gray-900 dark:text-white uppercase italic tracking-tighter leading-none">{u.name || (u as any).Name}</span>
                            <span className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest mt-1.5 not-italic">DNI: {u.dni}</span>
                        </div>
                    </div>
                );
            case "role":
                return (
                    <Chip 
                        variant="flat" 
                        size="sm" 
                        className={`font-black text-[9px] uppercase italic tracking-widest border border-transparent shadow-sm px-4 ${isSuperAdmin ? 'bg-black dark:bg-white text-white dark:text-black border-black/20 dark:border-white/20' : 'bg-emerald-500/5 text-emerald-600 dark:text-emerald-400 border-emerald-500/10'}`}
                    >
                        {roleDisplay}
                    </Chip>
                );
            case "status":
                return (
                    <div className="flex items-center justify-center gap-3">
                        <div className="relative flex h-2 w-2">
                            {u.is_active && (
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                            )}
                            <span className={`relative inline-flex rounded-full h-2 w-2 ${u.is_active ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.8)]' : 'bg-gray-400 opacity-50'}`}></span>
                        </div>
                        <span className={`text-[10px] font-black uppercase italic tracking-wider ${u.is_active ? 'text-emerald-500' : 'text-gray-400 dark:text-zinc-600'}`}>
                            {u.is_active ? 'ACTIVO' : 'SUSPENDIDO'}
                        </span>
                    </div>
                );
            case "registration":
                return (
                    <div className="flex items-center justify-center gap-2 text-gray-400 dark:text-zinc-500">
                        <Calendar size={12} className="opacity-50" />
                        <span className="text-[10px] font-black uppercase italic tabular-nums">{formattedDate}</span>
                    </div>
                );
            case "insights":
                return (
                    <Tooltip 
                        content={
                            <div className="px-3 py-2 flex flex-col gap-2">
                                <div className="flex items-center gap-2 border-b border-white/10 pb-1 mb-1">
                                    <Info size={12} className="text-emerald-500" />
                                    <span className="text-[10px] font-black uppercase italic tracking-widest">Resumen Analítico</span>
                                </div>
                                <div className="flex flex-col gap-1.5">
                                    <div className="flex justify-between items-center gap-4 text-[9px] font-black">
                                        <span className="text-zinc-500 uppercase tracking-tighter">Última Conexión:</span>
                                        <span className="text-white uppercase italic">Hoy 14:30</span>
                                    </div>
                                    <div className="flex justify-between items-center gap-4 text-[9px] font-black">
                                        <span className="text-zinc-500 uppercase tracking-tighter">Estado de Cuenta:</span>
                                        <span className={u.is_active ? "text-emerald-500" : "text-rose-500"}>{u.is_active ? "VERIFICADO" : "BLOQUEADO"}</span>
                                    </div>
                                </div>
                            </div>
                        }
                        className="bg-black/95 dark:bg-zinc-900 border border-white/5 shadow-2xl rounded-2xl"
                    >
                        <Button isIconOnly size="sm" variant="light" className="text-zinc-500 hover:text-emerald-500 transition-all">
                            <Info size={16} />
                        </Button>
                    </Tooltip>
                );
            case "actions":
                return (
                    <div className="flex items-center justify-end gap-1">
                        <Button 
                            isIconOnly 
                            size="sm" 
                            variant="flat" 
                            className="bg-gray-100 dark:bg-zinc-900 text-gray-400 dark:text-zinc-500 hover:text-emerald-500 hover:bg-emerald-500/10 transition-all rounded-lg" 
                            onPress={() => onEdit(u)}
                        >
                            <Edit size={14} />
                        </Button>
                        <Button 
                            isIconOnly 
                            size="sm" 
                            variant="flat" 
                            className="bg-amber-500/5 text-amber-500/50 hover:text-amber-500 hover:bg-amber-500/10 transition-all rounded-lg" 
                            onPress={() => onResetPassword(u)}
                        >
                            <Zap size={14} />
                        </Button>
                        <Button 
                            isIconOnly 
                            size="sm" 
                            variant="flat" 
                            isDisabled={isSuperAdmin}
                            className={`bg-rose-500/5 text-rose-500/30 hover:text-rose-500 hover:bg-rose-500/10 transition-all rounded-lg ${isSuperAdmin ? 'opacity-10 grayscale cursor-not-allowed' : ''}`} 
                            onPress={() => onDelete(u.dni)}
                        >
                            <Trash2 size={14} />
                        </Button>
                    </div>
                );
            default:
                return null;
        }
    }, [onEdit, onDelete, onResetPassword]);

    return (
        <div className="flex-1 bg-white/50 dark:bg-zinc-900/30 backdrop-blur-sm border border-gray-200 dark:border-white/5 rounded-[2rem] overflow-hidden flex flex-col shadow-2xl shadow-emerald-500/5 transition-all">
            {/* VISTA DESKTOP: TABLA */}
            {!isMobile && (
                <div className="flex-1 overflow-auto custom-scrollbar">
                    <Table 
                        isCompact 
                        removeWrapper 
                        aria-label="Directorio Empleados" 
                        classNames={{ 
                            th: "bg-white/50 dark:bg-zinc-950/50 backdrop-blur-md text-gray-400 dark:text-zinc-500 font-black uppercase text-[9px] tracking-[0.2em] h-16 py-1 border-b border-gray-100 dark:border-white/5 sticky top-0 z-10", 
                            td: "py-4 font-medium border-b border-gray-50 dark:border-white/5", 
                            tr: "hover:bg-emerald-500/5 dark:hover:bg-emerald-500/5 transition-colors border-l-4 border-transparent hover:border-emerald-500 active:bg-emerald-500/10" 
                        }}
                    >
                    <TableHeader columns={COLUMNS}>
                        {(column) => (
                            <TableColumn 
                                key={column.uid} 
                                align={column.align as "start" | "center" | "end"}
                                className={`h-14 bg-gray-50/50 dark:bg-zinc-950/50 text-gray-400 dark:text-zinc-500 font-black uppercase text-[8px] tracking-[0.2em] border-b border-gray-100 dark:border-white/5 ${column.uid === 'identity' ? 'pl-6' : ''} ${column.uid === 'actions' ? 'pr-6' : ''} ${column.hideOnMobile ? 'hidden lg:table-cell' : ''}`}
                            >
                                {column.name}
                            </TableColumn>
                        )}
                    </TableHeader>
                    <TableBody 
                        items={users || []}
                        emptyContent={
                            <div className="py-20 flex flex-col items-center justify-center opacity-40">
                                <span className="text-[11px] font-black text-gray-400 dark:text-zinc-600 uppercase text-center italic tracking-widest">Sin personal registrado</span>
                            </div>
                        }
                    >
                        {(item) => (
                            <TableRow key={item.id || item.dni} data-suspended={!item.is_active}>
                                {(columnKey) => (
                                    <TableCell className={`${columnKey === 'identity' ? 'pl-6' : ''} ${columnKey === 'actions' ? 'pr-6' : ''} ${columnKey === 'activity' ? 'hidden lg:table-cell' : ''}`}>
                                        {renderCell(item, columnKey)}
                                    </TableCell>
                                )}
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
                </div>
            )}

            {/* VISTA MÓVIL: CARDS */}
            {isMobile && (
                <div className="flex-1 p-2 flex flex-col gap-2 bg-gray-50/50 dark:bg-black/20 overflow-auto">
                    {users?.map((u) => {
                        const isSuperAdmin = (u.role || (u as any).Role || '').toLowerCase() === 'superadmin';
                        const roleDisplay = u.role || (u as any).Role || 'EMPLEADO';
                        const nameDisplay = u.name || (u as any).Name || 'SIN NOMBRE';

                        return (
                            <div key={u.id || u.dni} className={`p-4 rounded-xl border transition-all flex items-center justify-between ${u.is_active ? 'bg-white dark:bg-zinc-900 border-gray-200 dark:border-white/5 shadow-sm' : 'bg-gray-100 dark:bg-zinc-950 border-gray-300 dark:border-zinc-800 opacity-50 grayscale shadow-inner'}`}>
                                <div className="flex items-center gap-3">
                                    <Avatar 
                                        size="sm" 
                                        name={nameDisplay} 
                                        className={`h-10 w-10 border ${isSuperAdmin ? 'border-black dark:border-white shadow-lg' : 'border-emerald-500/20'}`}
                                        classNames={{ base: isSuperAdmin ? "bg-black dark:bg-white" : "bg-emerald-500/10", name: isSuperAdmin ? "text-white dark:text-black font-black" : "text-emerald-500 font-black" }}
                                    />
                                    <div className="flex flex-col">
                                        <span className="text-[11px] font-black text-gray-900 dark:text-white uppercase italic truncate max-w-[120px]">{nameDisplay}</span>
                                        <span className={`text-[8px] font-bold uppercase tracking-widest ${isSuperAdmin ? 'text-black dark:text-white' : 'text-emerald-500'}`}>{roleDisplay}</span>
                                    </div>
                                </div>
                                <div className="flex gap-1">
                                    <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-gray-100 dark:bg-zinc-800" onPress={() => onEdit(u)}><Edit size={12}/></Button>
                                    <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-amber-500/10 text-amber-500" onPress={() => onResetPassword(u)}><Zap size={12}/></Button>
                                    <Button isIconOnly size="sm" variant="flat" isDisabled={isSuperAdmin} className={`h-8 w-8 bg-rose-500/10 text-rose-500 ${isSuperAdmin ? 'opacity-20 grayscale' : ''}`} onPress={() => onDelete(u.dni)}><Trash2 size={12}/></Button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* PAGINACIÓN RESPONSIVA */}
            {totalRecords > 0 && (
                <div className="px-4 md:px-6 py-3 flex flex-col md:flex-row items-center justify-between gap-4 border-t border-gray-200 dark:border-white/5 bg-gray-50 dark:bg-zinc-950 shrink-0 transition-colors">
                    <p className="text-[9px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest leading-none">
                        VISTA: <span className="text-gray-900 dark:text-white italic">{((currentPage - 1) * pageSize + 1)}-{Math.min(currentPage * pageSize, totalRecords)}</span> / <span className="text-emerald-500 italic">{totalRecords}</span>
                    </p>
                    <div className="flex flex-col sm:flex-row items-center gap-3 md:gap-4 w-full md:w-auto">
                        <select 
                            value={pageSize} 
                            onChange={(e) => onPageSizeChange(Number(e.target.value))} 
                            className="w-full sm:w-auto h-8 bg-white dark:bg-zinc-900 text-gray-500 dark:text-zinc-400 text-[9px] font-black uppercase tracking-widest px-3 outline-none rounded-lg border border-gray-200 dark:border-white/5 cursor-pointer shadow-sm hover:border-emerald-500/30 transition-all"
                        >
                            {[10, 20, 50].map(n => <option key={n} value={n}>{n} REGISTROS</option>)}
                        </select>
                        <div className="flex items-center gap-1 justify-center">
                            <Button 
                                size="sm" 
                                variant="flat" 
                                onPress={() => onPageChange(Math.max(1, currentPage - 1))} 
                                isDisabled={currentPage === 1} 
                                className="h-8 px-4 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white font-black text-[9px] uppercase border border-gray-200 dark:border-white/5 rounded-lg shadow-sm hover:border-emerald-500/30 transition-all"
                            >
                                PREV
                            </Button>
                            <span className="text-[10px] font-black text-gray-900 dark:text-white italic px-3 tabular-nums">
                                {currentPage} / {totalPages}
                            </span>
                            <Button 
                                size="sm" 
                                variant="flat" 
                                onPress={() => onPageChange(Math.min(totalPages, currentPage + 1))} 
                                isDisabled={currentPage === totalPages || totalPages === 0} 
                                className="h-8 px-4 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white font-black text-[9px] uppercase border border-gray-200 dark:border-white/5 rounded-lg shadow-sm hover:border-emerald-500/30 transition-all"
                            >
                                NEXT
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

UserTable.displayName = 'UserTable';

export default UserTable;
