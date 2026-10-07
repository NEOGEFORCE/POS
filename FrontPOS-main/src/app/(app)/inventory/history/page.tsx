"use client";

import { useEffect, useMemo, useState } from 'react';
import {
    Button,
    Card,
    CardBody,
    Chip,
    Spinner,
    Modal,
    ModalContent,
    ModalHeader,
    ModalBody,
    ModalFooter,
    Table,
    TableHeader,
    TableColumn,
    TableBody,
    TableRow,
    TableCell,
} from "@heroui/react";
import {
    ArrowLeft,
    Trash2,
    Calendar,
    Package,
    User,
    FileText,
    AlertTriangle,
    Search,
    ChevronDown,
    PackageOpen,
    Pencil,
    AlertCircle,
    Lock,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useApi } from "@/hooks/use-api";
import { formatTime, formatDate, formatCurrency } from "@/lib/utils";
import { apiFetch } from '@/lib/api-error';
import Cookies from 'js-cookie';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/lib/auth';

/**
 * Shape devuelto por el backend en GET /api/dashboard/receptions-history.
 *
 * El contrato declara camelCase, pero toleramos snake_case por si algun
 * cliente antiguo o un futuro mock vuelca el shape con otro casing: el
 * sistema debe ser honesto sobre que no sabe el proveedor en vez de romper
 * en runtime. El fallback literal "Proveedor no registrado" lo pinta el
 * backend; aqui solo lo reutilizamos si por alguna razon llega vacio.
 */
type ReceptionLine = {
    barcode?: string;
    name?: string;
    quantity?: number;
    reason?: string;
    purchasePrice?: number | null;
    supplierName?: string;
    // Tolerancia snake_case:
    supplier_name?: string;
    purchase_price?: number | null;
};

type Reception = {
    receptionId?: string;
    reception_id?: string;
    date: string;
    employee?: string;
    supplierName?: string;
    supplier_name?: string;
    suppliers?: string[];
    multiSupplier?: boolean;
    multi_supplier?: boolean;
    totalLines?: number;
    total_lines?: number;
    totalUnits?: number;
    total_units?: number;
    totalCost?: number | null;
    total_cost?: number | null;
    isBypass?: boolean;
    is_bypass?: boolean;
    isEdited?: boolean;
    is_edited?: boolean;
    lines?: ReceptionLine[];
};

function pick<T>(...vals: Array<T | undefined | null>): T | undefined {
    for (const v of vals) if (v !== undefined && v !== null) return v;
    return undefined;
}

function normalizeReception(raw: Reception) {
    const supplierName = pick(raw.supplierName, raw.supplier_name) ?? 'Proveedor no registrado';
    const suppliers = raw.suppliers ?? [];
    const multiSupplier = pick(raw.multiSupplier, raw.multi_supplier) ?? suppliers.length > 1;
    const lines = (raw.lines ?? []).map((ln) => ({
        barcode: ln.barcode ?? '',
        name: ln.name ?? ln.barcode ?? 'Producto sin nombre',
        quantity: Number(ln.quantity ?? 0),
        reason: ln.reason ?? 'RECEPTION',
        purchasePrice: pick(ln.purchasePrice, ln.purchase_price) ?? null,
        supplierName: pick(ln.supplierName, ln.supplier_name) ?? '',
    }));
    return {
        id: pick(raw.receptionId, raw.reception_id) ?? 'UNKNOWN',
        date: raw.date,
        employee: raw.employee || 'SISTEMA',
        supplierName,
        suppliers,
        multiSupplier,
        totalLines: pick(raw.totalLines, raw.total_lines) ?? lines.length,
        totalUnits: pick(raw.totalUnits, raw.total_units) ?? 0,
        totalCost: pick(raw.totalCost, raw.total_cost) ?? null,
        isBypass: pick(raw.isBypass, raw.is_bypass) ?? false,
        isEdited: pick(raw.isEdited, raw.is_edited) ?? false,
        lines,
    };
}

export default function ReceptionHistoryPage() {
    const router = useRouter();
    const { toast } = useToast();
    const { user } = useAuth();
    const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
    const [filterText, setFilterText] = useState('');
    const [isDeleting, setIsDeleting] = useState(false);
    const [receptionToDelete, setReceptionToDelete] = useState<string | null>(null);
    const [detailOf, setDetailOf] = useState<string | null>(null);

    const isAdmin = useMemo(() => {
        const role = ((user as any)?.role || (user as any)?.Role || '').toLowerCase();
        return ['admin', 'administrador', 'superadmin'].includes(role);
    }, [user]);

    const displayDate = useMemo(() => {
        const [y, m, d] = selectedDate.split('-');
        return `${d}/${m}/${y}`;
    }, [selectedDate]);

    // Nuevo endpoint dedicado al historial agrupado por recepcion.
    // El contrato devuelve supplierName ya resuelto en el backend, con un
    // fallback honesto "Proveedor no registrado" cuando no hay forma de
    // atribuirlo. Antes la pantalla usaba /dashboard/reports/movements, que
    // omitia el metadata y pintaba TODAS las tarjetas como "SIN PROVEEDOR".
    const { data: raw, isLoading, error, mutate } = useApi<Reception[]>(
        `/dashboard/receptions-history?from=${selectedDate}&to=${selectedDate}`,
    );

    const receptions = useMemo(() => (raw ?? []).map(normalizeReception), [raw]);

    const filteredReceptions = useMemo(() => {
        const q = filterText.trim().toLowerCase();
        if (!q) return receptions;
        return receptions.filter((rec) => {
            if (rec.supplierName.toLowerCase().includes(q)) return true;
            if (rec.employee.toLowerCase().includes(q)) return true;
            if (rec.id.toLowerCase().includes(q)) return true;
            return rec.lines.some((ln) =>
                ln.name.toLowerCase().includes(q) || ln.barcode.toLowerCase().includes(q),
            );
        });
    }, [receptions, filterText]);

    const detailReception = useMemo(
        () => (detailOf ? receptions.find((r) => r.id === detailOf) : null),
        [detailOf, receptions],
    );

    // Cerrar el detalle si el usuario cambia de dia y el id deja de existir.
    useEffect(() => {
        if (detailOf && !receptions.find((r) => r.id === detailOf)) {
            setDetailOf(null);
        }
    }, [detailOf, receptions]);

    const handleDelete = async () => {
        if (!receptionToDelete) return;
        setIsDeleting(true);
        try {
            const token = Cookies.get('org-pos-token');
            await apiFetch(`/products/reception/${receptionToDelete}`, { method: 'DELETE' }, token);
            toast({ title: "EXITO", description: "Recepcion eliminada y stock revertido." });
            mutate();
            setReceptionToDelete(null);
        } catch (err: any) {
            toast({ variant: 'destructive', title: "ERROR", description: err.message });
        } finally {
            setIsDeleting(false);
        }
    };

    const errorStatus = (error as any)?.status as number | undefined;
    const isForbidden = errorStatus === 403;

    return (
        <div className="flex flex-col flex-1 min-h-0 h-full w-full max-w-[1600px] mx-auto overflow-hidden bg-zinc-50 dark:bg-zinc-950 p-4 md:p-6 gap-6">
            {/* HEADER */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                    <Button
                        isIconOnly
                        variant="flat"
                        onPress={() => router.push('/inventory/receive')}
                        className="card-base border-none border border-zinc-200 dark:border-white/10 shrink-0"
                        aria-label="Volver a Recibir Mercancia"
                    >
                        <ArrowLeft size={18} />
                    </Button>
                    <div className="min-w-0">
                        <h1 className="text-xl md:text-2xl font-medium text-zinc-900 dark:text-white uppercase tracking-tight truncate">
                            Historial de <span className="text-emerald-600 dark:text-emerald-400">Recepciones</span>
                        </h1>
                        <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-400 uppercase tracking-[0.2em]">Auditoria de Entradas de Mercancia</p>
                    </div>
                </div>

                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                    <div className="relative flex-1 sm:flex-none">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-zinc-400 pointer-events-none" />
                        <input
                            type="text"
                            value={filterText}
                            onChange={(e) => setFilterText(e.target.value)}
                            placeholder="Proveedor, producto, responsable o Nº"
                            aria-label="Filtrar recepciones"
                            className="h-10 w-full sm:w-72 pl-9 pr-3 card-base border border-zinc-200 dark:border-white/10 rounded-2xl text-xs font-medium outline-none focus:ring-2 focus:ring-emerald-500/20"
                        />
                    </div>
                    <div className="relative">
                        <Calendar size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-zinc-400 pointer-events-none" />
                        <input
                            type="date"
                            value={selectedDate}
                            onChange={(e) => setSelectedDate(e.target.value)}
                            aria-label="Fecha a consultar"
                            className="h-10 pl-9 pr-3 card-base border border-zinc-200 dark:border-white/10 rounded-2xl text-xs font-medium uppercase tracking-wider outline-none focus:ring-2 focus:ring-emerald-500/20 cursor-pointer"
                        />
                    </div>
                </div>
            </div>

            {/* LISTA DE RECEPCIONES */}
            <div className="flex flex-col flex-1 min-h-0 overflow-y-auto custom-scrollbar gap-3 pr-1">
                {isLoading ? (
                    <div className="flex flex-col items-center justify-center py-20 gap-4" role="status" aria-live="polite">
                        <Spinner color="success" size="lg" />
                        <p className="text-xs font-bold text-gray-500 dark:text-zinc-400 uppercase tracking-widest animate-pulse">Cargando Historial...</p>
                    </div>
                ) : isForbidden ? (
                    <Card className="card-base border border-amber-200 dark:border-amber-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                        <CardBody className="py-16 flex flex-col items-center justify-center gap-3 text-center">
                            <Lock size={32} className="text-amber-500" />
                            <p className="text-sm font-bold text-amber-600 dark:text-amber-400 uppercase">Sin acceso al historial</p>
                            <p className="text-[11px] text-gray-500 dark:text-zinc-400 max-w-md">
                                El historial de recepciones esta restringido a usuarios con rol administrador. Solicita acceso a un administrador o inicia sesion con una cuenta con permisos.
                            </p>
                        </CardBody>
                    </Card>
                ) : error ? (
                    <Card className="card-base border border-rose-200 dark:border-rose-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                        <CardBody className="py-16 flex flex-col items-center justify-center gap-3 text-center">
                            <AlertCircle size={32} className="text-rose-500" />
                            <p className="text-sm font-bold text-rose-500 uppercase">Error al cargar el historial</p>
                            <p className="text-[10px] text-gray-500 dark:text-zinc-500 max-w-md">
                                {(error as any)?.message || 'No se pudo contactar al servidor. Verifica tu conexion e intenta de nuevo.'}
                            </p>
                            <Button
                                size="sm"
                                variant="flat"
                                className="mt-2 font-semibold text-[11px] uppercase"
                                onPress={() => mutate()}
                            >
                                Reintentar
                            </Button>
                        </CardBody>
                    </Card>
                ) : filteredReceptions.length === 0 ? (
                    <Card className="card-base border border-zinc-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                        <CardBody className="py-20 flex flex-col items-center justify-center gap-4 text-center">
                            <div className="h-16 w-16 rounded-2xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-gray-600 dark:text-zinc-400">
                                <PackageOpen size={32} />
                            </div>
                            <div>
                                <h3 className="text-sm font-bold text-zinc-900 dark:text-white uppercase">
                                    {filterText ? 'Sin resultados para el filtro' : 'No hay recepciones'}
                                </h3>
                                <p className="text-[10px] text-gray-500 dark:text-zinc-500 mt-1">
                                    {filterText
                                        ? `Prueba limpiar el filtro o cambiar la fecha.`
                                        : `No se registraron entradas de mercancia el ${displayDate}.`}
                                </p>
                            </div>
                        </CardBody>
                    </Card>
                ) : (
                    filteredReceptions.map((rec) => (
                        <ReceptionCard
                            key={rec.id}
                            rec={rec}
                            isAdmin={isAdmin}
                            isDeleting={isDeleting}
                            onEdit={() => router.push('/inventory/receive?edit_reception=' + rec.id)}
                            onDelete={() => setReceptionToDelete(rec.id)}
                            onShowDetail={() => setDetailOf(rec.id)}
                        />
                    ))
                )}
            </div>

            {/* MODAL DETALLE DE LINEAS (expandible) */}
            <Modal
                isOpen={!!detailReception}
                onClose={() => setDetailOf(null)}
                size="2xl"
                scrollBehavior="inside"
                backdrop="blur"
                classNames={{
                    base: "bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-white/10 max-w-[100vw] md:max-w-2xl mx-0 md:mx-4 rounded-none md:rounded-2xl",
                    wrapper: "fixed inset-0 z-[9999] flex items-end md:items-center justify-center",
                    header: "border-b border-zinc-200 dark:border-white/10",
                    footer: "border-t border-zinc-200 dark:border-white/10",
                }}
            >
                <ModalContent>
                    {detailReception && (
                        <>
                            <ModalHeader className="flex flex-col gap-1">
                                <h3 className="text-base md:text-lg font-semibold text-zinc-900 dark:text-white uppercase tracking-tight truncate">
                                    {detailReception.supplierName}
                                </h3>
                                <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-400 uppercase tracking-wider">
                                    {detailReception.id} · {formatDate(detailReception.date)} · {formatTime(detailReception.date)}
                                </p>
                            </ModalHeader>
                            <ModalBody className="py-4">
                                {detailReception.multiSupplier && detailReception.suppliers.length > 0 && (
                                    <div className="mb-3 flex flex-wrap gap-1.5">
                                        {detailReception.suppliers.map((s) => (
                                            <Chip key={s} size="sm" variant="flat" color="warning" className="text-[10px] font-semibold uppercase">{s}</Chip>
                                        ))}
                                    </div>
                                )}
                                <Table
                                    aria-label="Lineas de recepcion"
                                    removeWrapper
                                    classNames={{
                                        th: "bg-transparent text-gray-500 dark:text-zinc-400 font-medium uppercase text-[9px] tracking-widest h-8",
                                        td: "text-[11px] py-2 border-b border-zinc-100 dark:border-white/5",
                                    }}
                                >
                                    <TableHeader>
                                        <TableColumn>PRODUCTO</TableColumn>
                                        <TableColumn align="end">CANTIDAD</TableColumn>
                                        <TableColumn align="end">COSTO</TableColumn>
                                        <TableColumn>MOTIVO</TableColumn>
                                    </TableHeader>
                                    <TableBody>
                                        {detailReception.lines.map((ln, idx) => (
                                            <TableRow key={`${ln.barcode}-${idx}`}>
                                                <TableCell>
                                                    <div className="flex flex-col">
                                                        <span className="text-zinc-900 dark:text-white uppercase truncate max-w-[260px]">{ln.name}</span>
                                                        <span className="text-[9px] text-gray-500 dark:text-zinc-500 font-medium tracking-wider">{ln.barcode}</span>
                                                        {ln.supplierName && detailReception.multiSupplier && (
                                                            <span className="text-[9px] text-amber-600 dark:text-amber-400 font-medium uppercase mt-0.5">{ln.supplierName}</span>
                                                        )}
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <span className="tabular-nums font-semibold">{ln.quantity}</span>
                                                </TableCell>
                                                <TableCell>
                                                    <span className="tabular-nums">
                                                        {typeof ln.purchasePrice === 'number' && ln.purchasePrice > 0
                                                            ? `$${formatCurrency(ln.purchasePrice)}`
                                                            : '—'}
                                                    </span>
                                                </TableCell>
                                                <TableCell>
                                                    <Chip size="sm" variant="flat" color={ln.reason === 'RECEPTION_BONUS' ? 'warning' : ln.reason.startsWith('ADJUSTMENT') ? 'secondary' : 'success'} className="text-[9px] uppercase font-semibold">
                                                        {ln.reason}
                                                    </Chip>
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </ModalBody>
                            <ModalFooter>
                                <Button variant="light" onPress={() => setDetailOf(null)} className="font-bold text-xs uppercase">
                                    Cerrar
                                </Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>

            {/* MODAL CONFIRMACION ELIMINAR */}
            <Modal
                isOpen={!!receptionToDelete}
                onClose={() => setReceptionToDelete(null)}
                backdrop="blur"
                classNames={{
                    base: "bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-white/10",
                    header: "border-b border-zinc-200 dark:border-white/10",
                    footer: "border-t border-zinc-200 dark:border-white/10"
                }}
            >
                <ModalContent>
                    <ModalHeader className="flex flex-col gap-1">
                        <h3 className="text-lg font-medium text-rose-500 uppercase tracking-tight">¿Deshacer Recepcion?</h3>
                    </ModalHeader>
                    <ModalBody className="py-6 flex flex-col items-center text-center gap-4">
                        <div className="h-20 w-20 rounded-2xl bg-rose-500/10 text-rose-500 flex items-center justify-center">
                            <AlertTriangle size={40} />
                        </div>
                        <div className="flex flex-col gap-2">
                            <p className="text-sm font-bold text-zinc-900 dark:text-white uppercase">¡ACCION CRITICA!</p>
                            <p className="text-xs text-gray-500 dark:text-zinc-500 px-4">
                                Al deshacer la recepcion <span className="font-medium text-zinc-900 dark:text-white">{receptionToDelete}</span>, se
                                <span className="text-rose-500 font-bold"> restara el stock</span> ingresado y se <span className="text-rose-500 font-bold"> eliminara el egreso</span> vinculado de la caja.
                            </p>
                        </div>
                    </ModalBody>
                    <ModalFooter>
                        <Button variant="light" onPress={() => setReceptionToDelete(null)} className="font-bold text-xs uppercase">Cancelar</Button>
                        <Button
                            color="danger"
                            className="font-medium text-xs uppercase tracking-wider shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/20 bg-rose-500"
                            isLoading={isDeleting}
                            onPress={handleDelete}
                        >
                            Confirmar Deshacer
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>
        </div>
    );
}

// -------------------------------------------------------------------------
// Tarjeta de recepcion (responsive, con detalle expandible)
// -------------------------------------------------------------------------
function ReceptionCard({
    rec,
    isAdmin,
    isDeleting,
    onEdit,
    onDelete,
    onShowDetail,
}: {
    rec: ReturnType<typeof normalizeReception>;
    isAdmin: boolean;
    isDeleting: boolean;
    onEdit: () => void;
    onDelete: () => void;
    onShowDetail: () => void;
}) {
    const preview = rec.lines.slice(0, 3);
    const hiddenCount = Math.max(0, rec.lines.length - preview.length);

    const isHonestFallback = rec.supplierName === 'Proveedor no registrado';

    return (
        <Card className="card-base border border-zinc-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-hidden group hover:border-emerald-500/30 transition-all">
            <CardBody className="p-0">
                <div className="flex flex-col md:flex-row">
                    {/* HEADER (proveedor, fecha, responsable, badges) */}
                    <div className="p-4 md:w-72 bg-zinc-50 dark:bg-zinc-900/60 border-b md:border-b-0 md:border-r border-zinc-200 dark:border-white/5 flex flex-col gap-3">
                        <div className="flex items-start gap-2 min-w-0">
                            <div className="h-9 w-9 shrink-0 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
                                <Package size={16} />
                            </div>
                            <div className="flex flex-col min-w-0 flex-1">
                                <span
                                    className={`text-sm md:text-base font-semibold uppercase tracking-tight break-words ${isHonestFallback ? 'text-amber-600 dark:text-amber-400 italic' : 'text-zinc-900 dark:text-white'}`}
                                    title={rec.supplierName}
                                >
                                    {rec.supplierName}
                                </span>
                                <span className="text-[10px] font-bold text-gray-500 dark:text-zinc-400 uppercase tracking-wider">
                                    {formatDate(rec.date)} · {formatTime(rec.date)}
                                </span>
                            </div>
                        </div>

                        <div className="flex flex-wrap gap-1.5">
                            {rec.multiSupplier && (
                                <Chip size="sm" variant="flat" color="warning" className="text-[9px] uppercase font-semibold">
                                    {rec.suppliers.length} proveedores
                                </Chip>
                            )}
                            {rec.isBypass && (
                                <Chip size="sm" variant="flat" color="secondary" className="text-[9px] uppercase font-semibold">
                                    Sin egreso
                                </Chip>
                            )}
                            {rec.isEdited && (
                                <Chip size="sm" variant="flat" color="primary" className="text-[9px] uppercase font-semibold">
                                    Editada
                                </Chip>
                            )}
                        </div>

                        <div className="flex items-center gap-2">
                            <User size={12} className="text-gray-500 dark:text-zinc-400 shrink-0" />
                            <span className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 uppercase truncate">{rec.employee}</span>
                        </div>

                        {isAdmin && (
                            <div className="flex gap-2 mt-auto">
                                <Button
                                    size="sm"
                                    variant="flat"
                                    color="warning"
                                    className="flex-1 font-semibold text-[10px] uppercase h-9 rounded-xl bg-amber-500/10 hover:bg-amber-500 text-amber-600 dark:text-amber-500 hover:text-white transition-all"
                                    startContent={<Pencil size={13} />}
                                    isDisabled={isDeleting}
                                    onPress={onEdit}
                                >
                                    Editar
                                </Button>
                                <Button
                                    size="sm"
                                    variant="flat"
                                    color="danger"
                                    className="flex-1 font-semibold text-[10px] uppercase h-9 rounded-xl bg-rose-500/10 hover:bg-rose-500 text-rose-500 hover:text-white transition-all"
                                    startContent={<Trash2 size={13} />}
                                    onPress={onDelete}
                                >
                                    Deshacer
                                </Button>
                            </div>
                        )}
                    </div>

                    {/* RESUMEN (lineas top + totales) */}
                    <div className="flex-1 p-4 flex flex-col gap-3 min-w-0">
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            <SummaryCell
                                label="Lineas"
                                value={rec.totalLines.toString()}
                            />
                            <SummaryCell
                                label="Unidades"
                                value={rec.totalUnits.toLocaleString('es-CO')}
                            />
                            <SummaryCell
                                label="Valor compra"
                                value={typeof rec.totalCost === 'number' ? `$${formatCurrency(rec.totalCost)}` : 'Sin dato'}
                                dim={rec.totalCost == null}
                            />
                        </div>

                        <div className="flex flex-col gap-1.5">
                            <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-400 uppercase tracking-widest">Productos</p>
                            <div className="flex flex-col divide-y divide-zinc-100 dark:divide-white/5">
                                {preview.map((ln, idx) => (
                                    <div key={`${ln.barcode}-${idx}`} className="py-1.5 flex items-center justify-between gap-3">
                                        <div className="flex flex-col min-w-0">
                                            <span className="text-[12px] font-medium text-zinc-900 dark:text-white uppercase truncate">{ln.name}</span>
                                            <span className="text-[9px] text-gray-500 dark:text-zinc-500 tracking-wider truncate">{ln.barcode}</span>
                                        </div>
                                        <Chip size="sm" variant="flat" color={ln.reason === 'RECEPTION_BONUS' ? 'warning' : 'success'} className="text-[10px] font-semibold tabular-nums shrink-0">
                                            +{ln.quantity}
                                        </Chip>
                                    </div>
                                ))}
                            </div>
                            {hiddenCount > 0 && (
                                <Button
                                    size="sm"
                                    variant="light"
                                    className="font-semibold text-[11px] uppercase tracking-wider w-full sm:w-auto self-start"
                                    endContent={<ChevronDown size={13} />}
                                    onPress={onShowDetail}
                                >
                                    Ver {hiddenCount} linea{hiddenCount === 1 ? '' : 's'} mas
                                </Button>
                            )}
                        </div>

                        <div className="mt-auto flex items-center gap-2 pt-2 border-t border-zinc-100 dark:border-white/5">
                            <FileText size={11} className="text-gray-500 dark:text-zinc-500" />
                            <span className="text-[10px] text-gray-500 dark:text-zinc-500 font-medium tracking-wider truncate" title={rec.id}>
                                {rec.id}
                            </span>
                        </div>
                    </div>
                </div>
            </CardBody>
        </Card>
    );
}

function SummaryCell({ label, value, dim = false }: { label: string; value: string; dim?: boolean }) {
    return (
        <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[9px] font-bold text-gray-500 dark:text-zinc-400 uppercase tracking-widest">{label}</span>
            <span className={`text-[13px] font-semibold tabular-nums tracking-tight truncate ${dim ? 'text-gray-400 dark:text-zinc-500 italic' : 'text-zinc-900 dark:text-white'}`}>
                {value}
            </span>
        </div>
    );
}
