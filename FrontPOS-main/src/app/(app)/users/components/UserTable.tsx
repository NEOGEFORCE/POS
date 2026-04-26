"use client";

import React, { memo } from 'react';
import {
    Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
    Button, Avatar, Tooltip
} from "@heroui/react";
import { 
    Edit, Trash2, Zap, ShieldCheck, Info, RefreshCw, 
    ChevronLeft, ChevronRight 
} from 'lucide-react';
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
    onReload?: () => void;
    isLoading?: boolean;
    currentDni?: string;
}

const COLUMNS = [
    { name: "IDENTIDAD", uid: "identity", align: "center" },
    { name: "NIVEL ACCESO", uid: "role", align: "center" },
    { name: "ÚLTIMA CONEXIÓN", uid: "insights", align: "center", hideOnMobile: true },
    { name: "GESTIÓN", uid: "actions", align: "end" },
];

const UserTable = memo(({ 
    users, onEdit, onDelete, onResetPassword, currentPage, totalPages, pageSize, 
    totalRecords, onPageChange, onPageSizeChange, onReload, isLoading, currentDni 
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
        const nameDisplay = u.name || (u as any).Name || 'SIN NOMBRE';

        switch (String(columnKey)) {
            case "identity":
                return (
                    <div className="flex items-center justify-center gap-3 py-0.5">
                        <div className="relative group shrink-0">
                            <Avatar 
                                size="sm" 
                                name={nameDisplay} 
                                className={`transition-all border-2 ${isSuperAdmin ? 'border-black dark:border-white shadow-lg' : 'border-emerald-500/20'}`}
                                classNames={{ base: isSuperAdmin ? "bg-black dark:bg-white" : "bg-emerald-500/10", name: isSuperAdmin ? "text-white dark:text-black font-black" : "text-emerald-500 font-black text-[10px]" }}
                            />
                            {isSuperAdmin && (
                                <div className="absolute -bottom-1 -right-1 bg-black dark:bg-white text-white dark:text-black rounded-full p-1 shadow-xl border border-white dark:border-zinc-950 z-20 scale-90">
                                    <ShieldCheck size={8} />
                                </div>
                            )}
                        </div>
                        <div className="flex flex-col items-start">
                            <span className="text-[11px] font-black text-gray-900 dark:text-white uppercase italic leading-tight">{nameDisplay}</span>
                            <span className="text-[8px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-tight">DNI: {u.dni}</span>
                        </div>
                    </div>
                );
            case "role":
                return (
                    <div className="flex flex-col items-center">
                        <span className={`text-[9px] font-black px-2 py-0.5 rounded-full uppercase tracking-widest ${
                            isSuperAdmin ? 'bg-black text-white dark:bg-white dark:text-black' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                        }`}>
                            {roleDisplay}
                        </span>
                    </div>
                );
            case "insights":
                const lastLoginStr = u.last_login || u.lastLogin;
                const lastLoginDate = lastLoginStr ? new Date(lastLoginStr) : null;
                const isRecentlyActive = lastLoginDate ? (new Date().getTime() - lastLoginDate.getTime() < 5 * 60 * 1000) : false;
                const isMe = currentDni === u.dni;
                const isOnline = isMe || isRecentlyActive;

                return (
                    <div className="flex flex-col items-center">
                        <div className="flex items-center gap-1.5">
                            <div className={`h-1.5 w-1.5 rounded-full ${isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-gray-400'}`} />
                            <span className={`text-[9px] font-black uppercase tracking-widest italic ${isOnline ? 'text-emerald-500' : 'text-gray-400'}`}>
                                {isOnline ? "EN LÍNEA" : "DESCONECTADO"}
                            </span>
                        </div>
                        <span className="text-[7px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-tighter">
                            {lastLoginDate ? lastLoginDate.toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : "SIN REGISTRO"}
                        </span>
                    </div>
                );
            case "actions":
                return (
                    <div className="flex items-center justify-end gap-1 px-1">
                        <Tooltip content="EDITAR" delay={0} closeDelay={0} showArrow classNames={{ content: "font-black text-[9px] uppercase tracking-widest bg-emerald-500 text-white py-1 px-2 rounded-none shadow-xl" }}>
                            <Button isIconOnly size="sm" variant="flat" className="bg-emerald-500/5 text-emerald-500 hover:bg-emerald-500 hover:text-white transition-all rounded-lg" onPress={() => onEdit(u)}>
                                <Edit size={14} />
                            </Button>
                        </Tooltip>
                        <Tooltip content={isSuperAdmin ? "INAMOVIBLE" : "PASS RESET"} delay={0} closeDelay={0} showArrow classNames={{ content: `font-black text-[9px] uppercase tracking-widest drop-shadow-xl py-1 px-2 rounded-none shadow-xl ${isSuperAdmin ? 'bg-slate-900 text-white' : 'bg-amber-500 text-white'}` }}>
                            <Button isIconOnly size="sm" variant="flat" isDisabled={isSuperAdmin} className={`bg-amber-500/10 text-amber-500 hover:bg-amber-500 hover:text-white transition-all rounded-lg ${isSuperAdmin ? 'opacity-10 grayscale cursor-not-allowed' : ''}`} onPress={() => onResetPassword(u)}>
                                <Zap size={14} />
                            </Button>
                        </Tooltip>
                        <Tooltip content={isSuperAdmin ? "INAMOVIBLE" : "ELIMINAR"} delay={0} closeDelay={0} showArrow classNames={{ content: `font-black text-[9px] uppercase tracking-widest py-1 px-2 rounded-none shadow-xl ${isSuperAdmin ? 'bg-slate-900 text-white' : 'bg-rose-500 text-white'}` }} placement="top-end">
                            <Button isIconOnly size="sm" variant="flat" isDisabled={isSuperAdmin} className={`bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white transition-all rounded-lg ${isSuperAdmin ? 'opacity-10 grayscale cursor-not-allowed' : ''}`} onPress={() => onDelete(u.dni)}>
                                <Trash2 size={14} />
                            </Button>
                        </Tooltip>
                    </div>
                );
            default:
                return null;
        }
    }, [onEdit, onDelete, onResetPassword]);

    return (
        <div className="flex-1 min-h-0 bg-white/50 dark:bg-zinc-900/30 backdrop-blur-sm border border-gray-200 dark:border-white/5 rounded-2xl overflow-hidden flex flex-col shadow-2xl shadow-emerald-500/5 transition-all">
            {/* ÁREA DE CONTENIDO PRINCIPAL */}
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                {/* VISTA DESKTOP */}
                {!isMobile && (
                    <Table 
                        isCompact 
                        isHeaderSticky
                        aria-label="Directorio Empleados" 
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
                        <TableBody items={users ?? []} emptyContent="SIN REGISTROS">
                            {(item) => (
                                <TableRow key={item.id || item.dni}>
                                    {(columnKey) => <TableCell>{renderCell(item, columnKey)}</TableCell>}
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                )}

                {/* VISTA MÓVIL CON SCROLL INTERNO (TARJETAS) */}
                {isMobile && (
                    <div className="flex-1 min-h-0 overflow-auto scroll-smooth custom-scrollbar p-2 flex flex-col gap-2 bg-gray-50/50 dark:bg-black/20">
                        {users?.map((u) => {
                            const isSuperAdmin = (u.role || (u as any).Role || u.Role || '').toLowerCase() === 'superadmin';
                            const roleDisplay = u.role || (u as any).Role || u.Role || 'EMPLEADO';
                            const nameDisplay = u.name || (u as any).Name || u.Name || 'SIN NOMBRE';

                            return (
                                <div key={u.id || u.dni} className={`p-4 rounded-xl border transition-all flex items-center justify-between shrink-0 ${u.is_active ? 'bg-white dark:bg-zinc-900 border-gray-200 dark:border-white/5 shadow-sm' : 'bg-white dark:bg-zinc-900 border-emerald-500/20 shadow-sm border-dashed'}`}>
                                    <div className="flex items-center gap-3">
                                        <div className="relative">
                                            <Avatar 
                                                size="sm" 
                                                name={nameDisplay} 
                                                className={`h-10 w-10 border ${isSuperAdmin ? 'border-black dark:border-white shadow-lg' : 'border-emerald-500/20'}`}
                                                classNames={{ base: isSuperAdmin ? "bg-black dark:bg-white" : "bg-emerald-500/10", name: isSuperAdmin ? "text-white dark:text-black font-black text-[10px]" : "text-emerald-500 font-black text-[10px]" }}
                                            />
                                            {isSuperAdmin && (
                                                <div className="absolute -bottom-1 -right-1 bg-black dark:bg-white text-white dark:text-black rounded-full p-1 shadow-xl border border-white dark:border-zinc-950 z-20 scale-90">
                                                    <ShieldCheck size={8} />
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex flex-col">
                                            <span className="text-[11px] font-black text-gray-900 dark:text-white uppercase italic truncate max-w-[120px] leading-tight">{nameDisplay}</span>
                                            <div className="flex items-center gap-1.5 mt-0.5">
                                                <span className={`text-[7px] font-black uppercase tracking-widest leading-tight ${isSuperAdmin ? 'text-black dark:text-white' : 'text-emerald-500'}`}>{roleDisplay}</span>
                                                <span className="text-[6px] font-bold text-gray-300 dark:text-zinc-600">|</span>
                                                <span className="text-[6px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-tighter">
                                                    {(() => {
                                                        const lastLoginStr = u.last_login || u.lastLogin;
                                                        const lastLoginDate = lastLoginStr ? new Date(lastLoginStr) : null;
                                                        const isMe = currentDni === u.dni;
                                                        const isRecentlyActive = lastLoginDate ? (new Date().getTime() - lastLoginDate.getTime() < 5 * 60 * 1000) : false;
                                                        if (isMe || isRecentlyActive) return "VISTO: AHORA MISMO";
                                                        return lastLoginDate ? `VISTO: ${lastLoginDate.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : "NUNCA VISTO";
                                                    })()}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex gap-1">
                                        <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-gray-100 dark:bg-zinc-800 rounded-lg" onPress={() => onEdit(u)}><Edit size={12}/></Button>
                                        <Button isIconOnly size="sm" variant="flat" isDisabled={isSuperAdmin} className={`h-8 w-8 bg-amber-500/10 text-amber-500 rounded-lg ${isSuperAdmin ? 'opacity-20 grayscale' : ''}`} onPress={() => onResetPassword(u)}><Zap size={12}/></Button>
                                        <Button isIconOnly size="sm" variant="flat" isDisabled={isSuperAdmin} className={`h-8 w-8 bg-rose-500/10 text-rose-500 rounded-lg ${isSuperAdmin ? 'opacity-20 grayscale' : ''}`} onPress={() => onDelete(u.dni)}><Trash2 size={12}/></Button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* PAGINACIÓN FIJA - SIEMPRE AL FINAL */}
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

UserTable.displayName = 'UserTable';

export default UserTable;
