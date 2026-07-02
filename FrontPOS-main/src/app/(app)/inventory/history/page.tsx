"use client";

import { useEffect, useState, useMemo } from 'react';
import { 
    Button, Table, TableHeader, TableColumn, TableBody, TableRow, TableCell, 
    Card, CardBody, Chip, Spinner, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
    Badge
} from "@heroui/react";
import { ArrowLeft, Trash2, Calendar, Package, User, FileText, AlertTriangle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useApi } from "@/hooks/use-api";
import { formatTime, formatDate } from "@/lib/utils";
import { StockMovement } from "@/lib/definitions";
import { apiFetch } from '@/lib/api-error';
import Cookies from 'js-cookie';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/lib/auth';

export default function ReceptionHistoryPage() {
    const router = useRouter();
    const { toast } = useToast();
    const { user } = useAuth();
    const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
    const [isDeleting, setIsDeleting] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [receptionToDelete, setReceptionToDelete] = useState<string | null>(null);

    const isAdmin = useMemo(() => {
        const role = (user?.role || user?.Role || '').toLowerCase();
        return ['admin', 'administrador', 'superadmin'].includes(role);
    }, [user]);

    const displayDate = useMemo(() => {
        const [y, m, d] = selectedDate.split('-');
        return `${d}/${m}/${y}`;
    }, [selectedDate]);

    // Fetch movements using the existing report endpoint
    const { data: movements, isLoading, error: movementsError, mutate } = useApi<StockMovement[]>(
        `/dashboard/reports/movements?from=${selectedDate}&to=${selectedDate}`
    );

    // Group movements by ReferenceID (Reception ID)
    const receptions = useMemo(() => {
        if (!movements) return [];
        
        const groups: Record<string, {
            id: string;
            date: string;
            employee: string;
            supplierName: string;
            items: StockMovement[];
            totalQty: number;
        }> = {};

        movements.forEach(m => {
            if (m.reason === 'RECEPTION' && (m.referenceId || m.ref)) {
                const ref = m.referenceId || m.ref || 'UNKNOWN';

                // Intentar extraer supplierName y employeeName del metadata
                let metaSupplier = '';
                let metaEmployee = '';
                if (m.metadata) {
                    try {
                        const parsed = JSON.parse(m.metadata);
                        metaSupplier = parsed.supplierName || '';
                        metaEmployee = parsed.employeeName || '';
                    } catch {}
                }

                if (!groups[ref]) {
                    groups[ref] = {
                        id: ref,
                        date: m.date,
                        employee: m.employee || metaEmployee || 'SISTEMA',
                        supplierName: metaSupplier || '',
                        items: [],
                        totalQty: 0
                    };
                } else {
                    // Actualizar con info del primer movimiento que la tenga
                    if (!groups[ref].supplierName && metaSupplier)
                        groups[ref].supplierName = metaSupplier;
                    if (groups[ref].employee === 'SISTEMA' && (m.employee || metaEmployee))
                        groups[ref].employee = m.employee || metaEmployee || 'SISTEMA';
                }
                groups[ref].items.push(m);
                groups[ref].totalQty += m.quantity;
            }
        });

        return Object.values(groups).sort((a, b) => 
            new Date(b.date).getTime() - new Date(a.date).getTime()
        );
    }, [movements]);



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

    return (
        <div className="flex flex-col flex-1 min-h-0 h-full w-full max-w-[1600px] mx-auto overflow-hidden bg-zinc-50 dark:bg-zinc-950 p-4 md:p-6 gap-6">
            {/* HEADER */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                    <Button 
                        isIconOnly 
                        variant="flat" 
                        onPress={() => router.push('/inventory/receive')}
                        className="card-base border-none border border-zinc-200 dark:border-white/10"
                    >
                        <ArrowLeft size={18} />
                    </Button>
                    <div>
                        <h1 className="text-xl md:text-2xl font-medium text-zinc-900 dark:text-white uppercase tracking-tight tracking-tighter">
                            Historial de <span className="text-zinc-900 dark:text-zinc-100">Recepciones</span>
                        </h1>
                        <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em]">Auditoria de Entradas de Mercancia</p>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <div className="relative">
                        <Calendar size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-zinc-500 dark:text-zinc-400 pointer-events-none" />
                        <input 
                            type="date" 
                            value={selectedDate}
                            onChange={(e) => setSelectedDate(e.target.value)}
                            className="h-10 pl-9 pr-3 card-base border-none border border-zinc-200 dark:border-white/10 rounded-2xl text-xs font-medium uppercase tracking-wider outline-none focus:ring-2 focus:ring-emerald-500/20 cursor-pointer"
                        />
                    </div>
                </div>
            </div>

            {/* LISTA DE RECEPCIONES */}
            <div className="flex flex-col flex-1 min-h-0 overflow-y-auto custom-scrollbar gap-4 pr-1">
                {isLoading ? (
                    <div className="flex flex-col items-center justify-center py-20 gap-4">
                        <Spinner color="success" size="lg" />
                        <p className="text-xs font-bold text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest animate-pulse">Cargando Historial...</p>
                    </div>
                ) : movementsError ? (
                    <Card className="card-base border-none border border-rose-200 dark:border-rose-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                        <CardBody className="py-16 flex flex-col items-center justify-center gap-3 text-center">
                            <p className="text-sm font-bold text-rose-500 uppercase">Error al cargar el historial</p>
                            <p className="text-[10px] text-gray-500 dark:text-zinc-500">{movementsError?.message || 'Intenta cambiar la fecha o recargar la pagina.'}</p>
                        </CardBody>
                    </Card>
                ) : receptions.length === 0 ? (
                    <Card className="card-base border-none border border-zinc-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                        <CardBody className="py-20 flex flex-col items-center justify-center gap-4 text-center">
                            <div className="h-16 w-16 rounded-2xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-gray-600 dark:text-zinc-300 dark:text-zinc-600">
                                <Package size={32} />
                            </div>
                            <div>
                                <h3 className="text-sm font-bold text-zinc-900 dark:text-white uppercase">No hay recepciones</h3>
                                <p className="text-[10px] text-gray-500 dark:text-zinc-500 mt-1">No se registraron entradas de mercancia el {displayDate}</p>
                            </div>
                        </CardBody>
                    </Card>
                ) : (
                    receptions.map((rec) => (
                        <Card key={rec.id} className="card-base border-none border border-zinc-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] overflow-hidden group hover:border-emerald-500/30 transition-all">
                            <CardBody className="p-0">
                                <div className="flex flex-col md:flex-row">
                                    {/* HEADER RECEPCION */}
                                    <div className="p-4 md:w-64 bg-zinc-50 dark:bg-zinc-800/50 border-b md:border-b-0 md:border-r border-zinc-200 dark:border-white/5 flex flex-col justify-between gap-4">
                                        <div className="flex flex-col gap-2">
                                            <div className="flex items-center gap-2">
                                                <div className="h-8 w-8 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white flex items-center justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                                                    <FileText size={16} />
                                                </div>
                                                <div className="flex flex-col min-w-0">
                                                    <span className="text-[11px] font-semibold text-zinc-900 dark:text-zinc-100 uppercase tracking-tight truncate">
                                                        {rec.supplierName || 'SIN PROVEEDOR'}
                                                    </span>
                                                    <span className="text-[9px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-wider">{rec.id}</span>
                                                    <span className="text-[9px] font-bold text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase">{formatTime(rec.date)}</span>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2 mt-2">
                                                <User size={12} className="text-gray-500 dark:text-zinc-500 dark:text-zinc-400" />
                                                <span className="text-[10px] font-medium text-zinc-600 dark:text-zinc-300 uppercase truncate">{rec.employee}</span>
                                            </div>
                                        </div>

                                        {isAdmin && (
                                            <div className="flex flex-col gap-2">
                                                <Button 
                                                    size="sm" 
                                                    variant="flat" 
                                                    color="warning"
                                                    className="w-full font-medium text-[10px] uppercase h-8 rounded-2xl bg-amber-500/10 hover:bg-amber-500 text-amber-600 dark:text-amber-500 hover:text-white transition-all"
                                                    startContent={<FileText size={14} />}
                                                    isDisabled={isDeleting}
                                                    onPress={() => router.push('/inventory/receive?edit_reception=' + rec.id)}
                                                >
                                                    Editar
                                                </Button>
                                                <Button 
                                                    size="sm" 
                                                    variant="flat" 
                                                    color="danger"
                                                    className="w-full font-medium text-[10px] uppercase h-8 rounded-2xl bg-rose-500/10 hover:bg-rose-500 text-rose-500 hover:text-white transition-all"
                                                    startContent={<Trash2 size={14} />}
                                                    onPress={() => setReceptionToDelete(rec.id)}
                                                >
                                                    Deshacer
                                                </Button>
                                            </div>
                                        )}
                                    </div>

                                    {/* ITEMS RECEPCION */}
                                    <div className="flex-1 p-4 overflow-x-auto">
                                        <Table 
                                            aria-label="Items de recepcion" 
                                            removeWrapper 
                                            className="min-w-[400px]"
                                            classNames={{
                                                th: "bg-transparent text-gray-500 dark:text-zinc-500 dark:text-zinc-400 font-medium uppercase text-[9px] tracking-widest h-8 border-b border-zinc-100 dark:border-white/5",
                                                td: "text-[10px] font-bold py-2 border-b border-zinc-50 dark:border-white/5 group-hover:bg-zinc-50/50 dark:group-hover:bg-[#18181b] transition-colors"
                                            }}
                                        >
                                            <TableHeader>
                                                <TableColumn>PRODUCTO</TableColumn>
                                                <TableColumn>CANTIDAD</TableColumn>
                                                <TableColumn align="end">ESTADO</TableColumn>
                                            </TableHeader>
                                            <TableBody>
                                                {rec.items.map((item, idx) => (
                                                    <TableRow key={idx}>
                                                        <TableCell>
                                                            <div className="flex flex-col">
                                                                <span className="text-zinc-900 dark:text-white uppercase truncate max-w-[200px]">{item.name}</span>
                                                                <span className="text-[8px] text-gray-500 dark:text-zinc-500 dark:text-zinc-400 font-medium tracking-wider">{item.barcode}</span>
                                                            </div>
                                                        </TableCell>
                                                        <TableCell>
                                                            <Chip size="sm" variant="flat" color="success" className="font-medium text-[10px] bg-black/5 dark:bg-white/5 text-zinc-900 dark:text-zinc-100 border-none">
                                                                +{item.quantity}
                                                            </Chip>
                                                        </TableCell>
                                                        <TableCell>
                                                            <Chip size="sm" variant="flat" color="success" className="font-medium text-[8px] uppercase">Sincronizado</Chip>
                                                        </TableCell>
                                                    </TableRow>
                                                ))}
                                            </TableBody>
                                        </Table>
                                    </div>
                                </div>
                            </CardBody>
                        </Card>
                    ))
                )}
            </div>

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
                        <h3 className="text-lg font-medium text-rose-500 uppercase tracking-tight tracking-tighter">Â¿Deshacer Recepcion?</h3>
                    </ModalHeader>
                    <ModalBody className="py-6 flex flex-col items-center text-center gap-4">
                        <div className="h-20 w-20 rounded-2xl bg-rose-500/10 text-rose-500 flex items-center justify-center">
                            <AlertTriangle size={40} />
                        </div>
                        <div className="flex flex-col gap-2">
                            <p className="text-sm font-bold text-zinc-900 dark:text-white uppercase">Â¡ACCION CRITICA!</p>
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
                            className="font-medium text-xs uppercase tracking-tight tracking-wider shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/20 bg-rose-500"
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


