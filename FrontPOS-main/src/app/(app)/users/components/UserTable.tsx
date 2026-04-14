"use client";

import React, { memo } from 'react';
import {
    Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
    Button, Chip, Avatar
} from "@heroui/react";
import { Edit, Trash2, Zap } from 'lucide-react';
import { User } from '@/lib/definitions';

interface TableProps {
    users: User[];
    onEdit: (user: User) => void;
    onDelete: (dni: string) => void;
    currentPage: number;
    totalPages: number;
    pageSize: number;
    totalRecords: number;
    onPageChange: (page: number) => void;
    onPageSizeChange: (size: number) => void;
}

const UserTable = memo(({ 
    users, onEdit, onDelete, currentPage, totalPages, pageSize, totalRecords, onPageChange, onPageSizeChange 
}: TableProps) => {
    return (
        <div className="flex-1 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-lg overflow-hidden flex flex-col shadow-sm transition-colors">
            {/* VISTA DESKTOP: TABLA */}
            <div className="hidden md:block flex-1 overflow-auto custom-scrollbar">
                <Table 
                    isCompact 
                    removeWrapper 
                    aria-label="Directorio Empleados" 
                    classNames={{ 
                        th: "bg-gray-50 dark:bg-zinc-950 text-gray-400 dark:text-zinc-500 font-black uppercase text-[8px] md:text-[9px] tracking-widest h-12 py-1 border-b border-gray-200 dark:border-white/5 sticky top-0 z-10", 
                        td: "py-2.5 font-medium border-b border-gray-100 dark:border-white/5", 
                        tr: "hover:bg-emerald-500/5 dark:hover:bg-emerald-500/10 transition-colors border-l-4 border-transparent hover:border-emerald-500 active:bg-emerald-500/10" 
                    }}
                >
                    <TableHeader>
                        <TableColumn className="pl-6">IDENTIDAD</TableColumn>
                        <TableColumn align="center">PERMISOS / ROL</TableColumn>
                        <TableColumn align="start" className="hidden lg:table-cell">ÚLTIMO ACCESO</TableColumn>
                        <TableColumn align="end" className="pr-6">CONTROL</TableColumn>
                    </TableHeader>
                    <TableBody 
                        emptyContent={
                            <div className="py-20 flex flex-col items-center justify-center opacity-40">
                                <span className="text-[11px] font-black text-gray-400 dark:text-zinc-600 uppercase text-center italic tracking-widest">Sin personal registrado</span>
                            </div>
                        }
                    >
                        {users.map((u) => (
                            <TableRow key={u.id}>
                                <TableCell className="pl-6">
                                    <div className="flex items-center gap-4">
                                        <Avatar 
                                            size="sm"
                                            className="h-10 w-10 shrink-0 border border-gray-200 dark:border-white/5 rounded-xl shadow-sm" 
                                            name={u.name} 
                                            classNames={{ base: "bg-emerald-100 dark:bg-emerald-500/10", name: "text-emerald-700 dark:text-emerald-500 font-black uppercase" }} 
                                        />
                                        <div className="flex flex-col min-w-0">
                                            <span className="text-xs font-black text-gray-900 dark:text-white uppercase leading-tight italic truncate max-w-[300px]">
                                                {u.name}
                                            </span>
                                            <span className="text-[9px] text-gray-400 dark:text-zinc-500 font-mono tracking-widest mt-1 uppercase">
                                                DNI: {u.dni || 'NO REGISTRADO'}
                                            </span>
                                        </div>
                                    </div>
                                </TableCell>
                                <TableCell className="text-center">
                                    <Chip
                                        size="sm" 
                                        variant="flat"
                                        className={`h-6 px-3 text-[8px] font-black uppercase tracking-widest border-none ${
                                            (u.role?.toLowerCase() === 'admin' || u.role?.toLowerCase() === 'administrador') 
                                                ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-500' 
                                                : 'bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400'
                                        }`}
                                    >
                                        {u.role}
                                    </Chip>
                                </TableCell>
                                <TableCell className="hidden lg:table-cell">
                                    <div className="flex items-center gap-2">
                                        <Zap size={14} className="text-gray-300 dark:text-zinc-600 shrink-0" />
                                        <span className="text-[10px] font-black text-gray-500 dark:text-zinc-400 uppercase tracking-tighter italic">
                                            {u.lastLogin ? new Date(u.lastLogin).toLocaleString('es-CO') : 'NUNCA'}
                                        </span>
                                    </div>
                                </TableCell>
                                <TableCell className="pr-6">
                                    <div className="flex justify-end gap-2">
                                        <Button 
                                            isIconOnly 
                                            size="sm" 
                                            variant="flat" 
                                            className="h-9 w-9 bg-gray-50 dark:bg-zinc-800 text-emerald-500 rounded-xl hover:bg-emerald-500 hover:text-white dark:hover:text-black border border-gray-200 dark:border-white/5 transition-all shadow-sm" 
                                            onPress={() => onEdit(u)}
                                        >
                                            <Edit size={14} />
                                        </Button>
                                        <Button 
                                            isIconOnly 
                                            size="sm" 
                                            variant="flat" 
                                            className="h-9 w-9 bg-gray-50 dark:bg-zinc-800 text-rose-500 rounded-xl hover:bg-rose-500 hover:text-white border border-gray-200 dark:border-white/5 transition-all shadow-sm" 
                                            onPress={() => onDelete(u.dni)}
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

            {/* VISTA MÓVIL: CARDS */}
            <div className="md:hidden flex-1 p-2 flex flex-col gap-2 bg-gray-50/50 dark:bg-black/20">
                {users.map((u) => (
                    <div key={u.id} className="bg-white dark:bg-zinc-900 p-4 rounded-xl border border-gray-200 dark:border-white/5 shadow-sm flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <Avatar 
                                size="sm" 
                                name={u.name} 
                                className="h-10 w-10 border border-emerald-500/20"
                                classNames={{ base: "bg-emerald-500/10", name: "text-emerald-500 font-black" }}
                            />
                            <div className="flex flex-col">
                                <span className="text-[11px] font-black text-gray-900 dark:text-white uppercase italic truncate max-w-[120px]">{u.name}</span>
                                <span className="text-[8px] font-bold text-emerald-500 uppercase tracking-widest">{u.role}</span>
                            </div>
                        </div>
                        <div className="flex gap-1">
                            <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-gray-100 dark:bg-zinc-800" onPress={() => onEdit(u)}><Edit size={12}/></Button>
                            <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-rose-500/10 text-rose-500" onPress={() => onDelete(u.dni)}><Trash2 size={12}/></Button>
                        </div>
                    </div>
                ))}
            </div>

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
