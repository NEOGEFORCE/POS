"use client";

import React, { memo } from 'react';
import {
    Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
    Button, Avatar, Tooltip
} from "@heroui/react";
import {
    Building2, Phone, MapPin, Edit, Trash2,
    ChevronLeft, ChevronRight, Info, Calendar, Truck, User
} from 'lucide-react';
import { Supplier } from '@/lib/definitions';
import { useAuth } from '@/lib/auth';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconUsers } from '@tabler/icons-react';

interface TableProps {
    suppliers: Supplier[];
    currentPage: number;
    totalPages: number;
    pageSize: number;
    totalFiltered: number;
    onEdit: (supplier: Supplier) => void;
    onDelete: (id: string | number) => void;
    onPageChange: (page: number) => void;
    onPageSizeChange: (size: number) => void;
}

const COLUMNS = [
    { name: "FIRMA / RAZON SOCIAL", uid: "identity", align: "start" },
    { name: "CANAL CONTACTO", uid: "contact", align: "center" },
    { name: "LOGISTICA", uid: "logistics", align: "center" },
    { name: "GESTION", uid: "actions", align: "end" },
];

const SupplierTable = memo(({
    suppliers,
    currentPage,
    totalPages,
    pageSize,
    totalFiltered,
    onEdit,
    onDelete,
    onPageChange,
    onPageSizeChange
}: TableProps) => {
    const { user } = useAuth();
    const [isMobile, setIsMobile] = React.useState(false);

    const role = user?.role?.toLowerCase() || user?.Role?.toLowerCase() || "";
    const isAdmin = role === "admin" || role === "administrador" || role === "superadmin";

    React.useEffect(() => {
        const mql = window.matchMedia("(max-width: 768px)");
        const onChange = () => setIsMobile(mql.matches);
        mql.addEventListener("change", onChange);
        setIsMobile(mql.matches);
        return () => mql.removeEventListener("change", onChange);
    }, []);

    const renderCell = React.useCallback((s: Supplier, columnKey: React.Key) => {
        switch (String(columnKey)) {
            case "identity":
                return (
                    <div className="flex-1 min-h-0 h-full flex items-center gap-3 py-0.5">
                        <div className="h-9 w-9 bg-black/5 dark:bg-white/5 text-zinc-900 dark:text-zinc-100 flex items-center justify-center rounded-2xl border border-emerald-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)] shrink-0">
                            <Building2 size={18} />
                        </div>
                        <div className="flex flex-col flex-1 min-h-0 min-w-0 h-full">
                            <span className="text-[10px] font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight leading-tight pr-2 whitespace-nowrap">
                                {s.name}
                            </span>
                            <span className="text-[8px] font-bold text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest leading-tight pr-1">NIT: {s.id}</span>
                        </div>
                    </div>
                );
            case "contact":
                return (
                    <div className="flex flex-col items-center min-w-0">
                        <div className="flex items-center gap-1.5">
                            <Phone size={10} className="text-zinc-900 dark:text-zinc-100" />
                            <span className="text-[10px] font-medium tabular-nums text-zinc-900 dark:text-zinc-50 uppercase">
                                {s.phone || 'S/C'}
                            </span>
                        </div>
                        {s.vendorName && (
                            <div className="flex items-center gap-1.5 mt-0.5 group">
                                <User size={10} className="text-gray-400 group-hover:text-zinc-900 dark:text-zinc-100 transition-colors" />
                                <span className="text-[8px] font-bold text-gray-500 dark:text-zinc-500 dark:text-zinc-400 group-hover:text-zinc-900 dark:text-zinc-100 uppercase tracking-tight tracking-wider transition-colors">
                                    ASESOR: {s.vendorName}
                                </span>
                            </div>
                        )}
                    </div>
                );
            case "logistics":
                // Mapeo de nombres de dias a iniciales
                const dayShortNames: Record<string, string> = {
                    'Lunes': 'LU', 'Martes': 'MA', 'Miercoles': 'MI', 'Jueves': 'JU',
                    'Viernes': 'VI', 'Sabado': 'SA', 'Domingo': 'DO'
                };
                // Usar nuevos campos multi-dias o fallback a legacy
                const visitDays = s.visitDays || (s.visitDay ? [s.visitDay] : []);
                const deliveryDays = s.deliveryDays || (s.deliveryDay ? [s.deliveryDay] : []);

                return (
                    <div className="flex items-center justify-center gap-3">
                        {/* VISITA - Chips con iniciales */}
                        <div className="flex flex-col items-center gap-1">
                            <span className="text-[7px] font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-100 uppercase tracking-widest">VISITA</span>
                            <div className="flex items-center gap-1">
                                {visitDays.length > 0 ? (
                                    visitDays.map((day, idx) => (
                                        <span
                                            key={idx}
                                            className="inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-2xl bg-black/5 dark:bg-white/5 border border-emerald-500/30 text-zinc-900 dark:text-zinc-100 dark:text-zinc-300 text-[9px] font-medium"
                                        >
                                            {dayShortNames[day] || day.slice(0, 2).toUpperCase()}
                                        </span>
                                    ))
                                ) : (
                                    <span className="text-[9px] text-gray-400 font-medium">---</span>
                                )}
                            </div>
                        </div>

                        <div className="w-px h-8 bg-gray-200 dark:bg-zinc-800" />

                        {/* ENTREGA - Chips con iniciales */}
                        <div className="flex flex-col items-center gap-1">
                            <span className="text-[7px] font-medium text-orange-600 dark:text-orange-500 uppercase tracking-widest">ENTREGA</span>
                            <div className="flex items-center gap-1">
                                {deliveryDays.length > 0 ? (
                                    deliveryDays.map((day, idx) => (
                                        <span
                                            key={idx}
                                            className="inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-2xl bg-orange-500/10 border border-orange-500/30 text-orange-600 dark:text-orange-400 text-[9px] font-medium"
                                        >
                                            {dayShortNames[day] || day.slice(0, 2).toUpperCase()}
                                        </span>
                                    ))
                                ) : (
                                    <span className="text-[9px] text-gray-400 font-medium">---</span>
                                )}
                            </div>
                        </div>

                        {/* METODO DE ABASTECIMIENTO (si existe) */}
                        {s.restockMethod && (
                            <>
                                <div className="w-px h-8 bg-gray-200 dark:bg-zinc-800" />
                                <div className="flex flex-col items-center gap-1">
                                    <span className="text-[7px] font-medium text-blue-600 dark:text-blue-500 uppercase tracking-widest">METODO</span>
                                    <span className="inline-flex items-center justify-center h-5 px-2 rounded-2xl bg-blue-500/10 border border-blue-500/30 text-blue-600 dark:text-blue-400 text-[8px] font-medium">
                                        {s.restockMethod}
                                    </span>
                                </div>
                            </>
                        )}
                    </div>
                );
            case "actions":
                if (!isAdmin) return <div className="flex justify-end pr-4"><span className="text-[7px] font-medium text-gray-400 uppercase tracking-widest tracking-tight opacity-50">Solo Lectura</span></div>;
                return (
                    <div className="flex items-center justify-end gap-1 px-1">
                        <Tooltip content="EDITAR" delay={0} closeDelay={0} showArrow classNames={{ content: "font-medium text-[9px] uppercase tracking-widest bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white py-1 px-2 rounded-none shadow-[0_8px_30px_rgb(0,0,0,0.12)]" }}>
                            <Button isIconOnly size="sm" variant="flat" className="bg-emerald-500/5 text-zinc-900 dark:text-zinc-100 hover:bg-emerald-500 hover:text-white transition-all rounded-2xl" onPress={() => onEdit(s)}>
                                <Edit size={14} />
                            </Button>
                        </Tooltip>
                        <Tooltip content="ELIMINAR" delay={0} closeDelay={0} showArrow classNames={{ content: "font-medium text-[9px] uppercase tracking-widest bg-rose-500 text-white py-1 px-2 rounded-none shadow-[0_8px_30px_rgb(0,0,0,0.12)]" }} placement="top-end">
                            <Button isIconOnly size="sm" variant="flat" className="bg-rose-500/5 text-rose-500 hover:bg-rose-500 hover:text-white transition-all rounded-2xl" onPress={() => onDelete(s.id)}>
                                <Trash2 size={14} />
                            </Button>
                        </Tooltip>
                    </div>
                );
            default:
                return null;
        }
    }, [onEdit, onDelete]);

    return (
        <div className="flex-1 min-h-0 h-full w-full bg-white dark:bg-[#18181b]/30 border border-gray-200 dark:border-white/5 rounded-2xl overflow-hidden flex flex-col shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-emerald-500/5 transition-all">
            {/* AREA DE CONTENIDO PRINCIPAL */}
            <div className="flex flex-col flex-1 min-h-0 min-w-0 h-full w-full relative">
                {!isMobile ? (
                    <Table
                        isCompact
                        isHeaderSticky
                        aria-label="Directorio Maestro Proveedores"
                        className="flex-1"
                        classNames={{
                            base: "flex-1 overflow-hidden",
                            wrapper: "overflow-auto custom-scrollbar bg-transparent shadow-none p-0 rounded-none flex-1 min-h-0 h-full",
                            th: "bg-[#f9fafb] dark:bg-[#09090b] text-gray-500 dark:text-zinc-400 font-extrabold uppercase text-[10px] tracking-widest h-12 py-2 border-b-2 border-gray-200 dark:border-white/10 sticky top-0 !z-[500] shadow-[0_8px_30px_rgb(0,0,0,0.12)]",
                            td: "py-1.5 font-medium border-b border-gray-100 dark:border-white/5",
                            tr: "hover:bg-zinc-50 dark:hover:bg-white/5 bg-white dark:bg-transparent border-b border-gray-100 dark:border-white/5 transition-colors border-l-4 border-transparent hover:border-emerald-500 active:bg-black/5 dark:active:bg-white/10 h-10 relative z-0"
                        }}
                    >
                        <TableHeader columns={COLUMNS}>
                            {(column) => (
                                <TableColumn
                                    key={column.uid}
                                    align={column.align as any}
                                    className=""
                                >
                                    {column.name}
                                </TableColumn>
                            )}
                        </TableHeader>
                        <TableBody
                            emptyContent={
                                <EmptyState
                                    title="Sin proveedores registrados"
                                    description="No hemos encontrado proveedores en este directorio. Intenta ajustar los filtros o registra uno nuevo."
                                    icon={<IconUsers size={48} className="text-gray-300" />}
                                />
                            }
                        >
                            {(suppliers || []).map((item) => (
                                <TableRow key={item.id}>
                                    {COLUMNS.map((column) => (
                                        <TableCell key={column.uid}>{renderCell(item, column.uid)}</TableCell>
                                    ))}
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                ) : (
                    <div className="overflow-auto scroll-smooth custom-scrollbar p-2 flex flex-col gap-2 bg-gray-50/50 dark:bg-[#18181b] flex-1 min-h-0 h-full">
                        {suppliers.length > 0 ? (
                            suppliers.map((s) => (
                                <div key={s.id} className="p-4 rounded-2xl border card-base border-none border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex items-center justify-between shrink-0">
                                    {/* ... existing card content ... */}
                                    <div className="flex items-center gap-3">
                                        <div className="h-10 w-10 bg-black/5 dark:bg-white/5 text-zinc-900 dark:text-zinc-100 flex items-center justify-center rounded-2xl border border-emerald-500/20 shrink-0">
                                            <Building2 size={20} />
                                        </div>
                                        <div className="flex flex-col flex-1 min-h-0 min-w-0 h-full w-full">
                                            <span className="text-[10px] font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight pr-2 leading-tight whitespace-nowrap">
                                                {s.name}
                                            </span>
                                            <div className="flex flex-col mt-0.5">
                                                <span className="text-[7px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-widest leading-tight pr-1">
                                                    {s.phone || 'S/C'}
                                                </span>
                                                {s.vendorName && (
                                                    <div className="flex items-center gap-1 mt-0.5">
                                                        <User size={8} className="text-gray-400" />
                                                        <span className="text-[6px] font-bold text-gray-400 uppercase tracking-tight pr-1">
                                                            {s.vendorName}
                                                        </span>
                                                    </div>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-1.5 mt-2">
                                                <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-2xl bg-black/5 dark:bg-white/5 border border-emerald-500/20">
                                                    <Calendar size={8} className="text-zinc-900 dark:text-zinc-100" />
                                                    <span className="text-[8px] font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-300 uppercase tracking-tight pr-0.5 leading-none">
                                                        {s.visitDay || '---'}
                                                    </span>
                                                </div>
                                                <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-2xl bg-orange-500/10 border border-orange-500/20">
                                                    <Truck size={8} className="text-orange-500" />
                                                    <span className="text-[8px] font-medium text-orange-600 dark:text-orange-400 uppercase tracking-tight pr-0.5 leading-none">
                                                        {s.deliveryDay || '---'}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    {isAdmin && (
                                        <div className="flex gap-1">
                                            <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-gray-100 dark:bg-zinc-800 rounded-2xl" onPress={() => onEdit(s)}><Edit size={12} /></Button>
                                            <Button isIconOnly size="sm" variant="flat" className="h-8 w-8 bg-rose-500/10 text-rose-500 rounded-2xl" onPress={() => onDelete(s.id)}><Trash2 size={12} /></Button>
                                        </div>
                                    )}
                                </div>
                            ))
                        ) : (
                            <EmptyState
                                title="Sin resultados"
                                description="No hay proveedores que coincidan con tu busqueda en este dispositivo."
                            />
                        )}
                    </div>
                )}
            </div>

            {/* PAGINACION FIJA - IDENTICAL TO USERS */}
            {totalFiltered > 0 && (
                <div className="shrink-0 px-3 py-2 flex items-center justify-between gap-2 border-t border-gray-200 dark:border-white/10 bg-gray-50/95 dark:bg-zinc-950 z-40 shadow-[0_-4px_15px_rgba(0,0,0,0.1)]">
                    <div className="flex items-center gap-2 font-medium">
                        <Button
                            isIconOnly
                            size="sm"
                            variant="flat"
                            onClick={() => onPageChange(Math.max(1, currentPage - 1))}
                            isDisabled={currentPage === 1}
                            className="h-8 w-8 min-w-0 card-base border-none text-zinc-900 dark:text-zinc-50 rounded-2xl border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-90 transition-transform"
                        >
                            <ChevronLeft size={18} />
                        </Button>

                        <div className="flex flex-col items-start px-1 leading-none">
                            <span className="text-[7px] text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase font-medium tracking-tighter">MOSTRANDO</span>
                            <p className="text-[10px] text-zinc-900 dark:text-zinc-50 uppercase tracking-widest flex items-center gap-1">
                                <span className="tracking-tight font-medium text-zinc-900 dark:text-zinc-100">{((currentPage - 1) * pageSize + 1)}-{Math.min(currentPage * pageSize, totalFiltered)}</span>
                                <span className="opacity-20 text-[8px]">DE</span>
                                <span className="tracking-tight font-medium">{totalFiltered}</span>
                            </p>
                        </div>

                        <Button
                            isIconOnly
                            size="sm"
                            variant="flat"
                            onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
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

SupplierTable.displayName = 'SupplierTable';
export default SupplierTable;



