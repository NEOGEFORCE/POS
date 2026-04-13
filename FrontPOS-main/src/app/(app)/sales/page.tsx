"use client";

import { useState, useEffect } from 'react';
import {
    Button,
    Input,
    Table, TableHeader, TableBody, TableColumn, TableRow, TableCell,
    Card, CardBody,
    Chip,
    Pagination,
    Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
    Divider,
    Spinner,
    Tooltip
} from "@heroui/react";
import {
    Search,
    Eye,
    FileText,
    User,
    ArrowRight,
    ShoppingCart,
    Clock,
    Download,
    TrendingUp,
    History as HistoryIcon,
    Pencil,
    Printer,
    Wallet,
    Banknote,
    CreditCard,
    Zap,
    ChevronDown,
    X,
    Check
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Sale } from '@/lib/definitions';
import { useApiWithPagination } from '@/hooks/use-api';

export default function SalesHistoryPage() {
    const { toast } = useToast();
    const [page, setPage] = useState(1);
    const pageSize = 12;

    // Estados para la búsqueda con Debounce
    const [searchQuery, setSearchQuery] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');

    const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
    const [isPreviewOpen, setIsPreviewOpen] = useState(false);
    const [isEditOpen, setIsEditOpen] = useState(false);
    
    // Estados para edición de pago (replicando lógica de caja)
    const [editActiveTab, setEditActiveTab] = useState<'cash' | 'NEQUI' | 'DAVIPLATA' | 'credit'>('cash');
    const [editCashPaid, setEditCashPaid] = useState('');
    const [editTransferPaid, setEditTransferPaid] = useState('');
    const [editCreditPaid, setEditCreditPaid] = useState('');
    const [editTransferSource, setEditTransferSource] = useState('NEQUI');
    const [editDialogAmount, setEditDialogAmount] = useState('');
    const [editCustomerDni, setEditCustomerDni] = useState('0');
    const [isClientDialogOpen, setIsClientDialogOpen] = useState(false);
    const [customers, setCustomers] = useState<any[]>([]);
    const [clientSearch, setClientSearch] = useState('');
    const [isUpdating, setIsUpdating] = useState(false);
    const [showSuccessScreen, setShowSuccessScreen] = useState(false);
    const [lastChange, setLastChange] = useState(0);

    // Cargar clientes al montar el componente
    useEffect(() => {
        const fetchCustomers = async () => {
            try {
                const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api'}/clients/all-clients`, {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('org-pos-token')}` }
                });
                if (res.ok) {
                    const data = await res.json();
                    setCustomers(data || []);
                }
            } catch (err) {
                console.error("Error loading customers:", err);
            }
        };
        fetchCustomers();
    }, []);

    // Efecto Debounce para la búsqueda (espera 500ms)
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedSearch(searchQuery);
            setPage(1); // Regresa a la primera página al buscar
        }, 500);
        return () => clearTimeout(timer);
    }, [searchQuery]);

    const endpoint = debouncedSearch
        ? `/sales/history?search=${encodeURIComponent(debouncedSearch)}`
        : '/sales/history';

    const { data, isLoading, error } = useApiWithPagination<{ items: Sale[], total: number }>(
        endpoint,
        page,
        pageSize,
        { keepPreviousData: true }
    );

    const sales = data?.items || [];
    const totalItems = data?.total || 0;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize)); // Evita que sea 0

    const handleOpenPreview = (sale: Sale) => {
        setSelectedSale(sale);
        setIsPreviewOpen(true);
    };

    const handleOpenEdit = (sale: Sale) => {
        setSelectedSale(sale);
        const source = sale.transferSource || 'NEQUI';
        setEditTransferSource(source);
        if (sale.transferAmount > 0) {
            setEditActiveTab(source as any);
        } else if (sale.creditAmount > 0) {
            setEditActiveTab('credit');
        } else {
            setEditActiveTab('cash');
        }
        setEditCustomerDni(sale.client?.dni || '0');
        setEditDialogAmount('');
        setIsEditOpen(true);
    };

    // Cálculos de balance movidos aquí para ser accesibles por handleNumpadAction y el teclado
    const total = selectedSale?.total || 0;
    const numCashStored = Number(editCashPaid) || 0;
    const numTransfer = Number(editTransferPaid) || 0;
    const numCredit = Number(editCreditPaid) || 0;
    const numManual = Number(editDialogAmount) || 0;

    const effectiveTendered = editActiveTab === 'cash' ? (numManual || numCashStored) : numCashStored;
    const totalPaidForDisplays = numManual + numCashStored + numTransfer + numCredit;
    
    const remaining = Math.max(0, total - totalPaidForDisplays);
    const change = Math.max(0, totalPaidForDisplays - total);
    const isReadyToFinalize = (editActiveTab === 'cash' && numManual >= remaining) || (numManual === 0 && (editActiveTab === 'cash' || editActiveTab === 'NEQUI' || editActiveTab === 'DAVIPLATA') && remaining > 0) || remaining === 0;

    const handleNumpadAction = () => {
        const val = numManual > 0 ? numManual : remaining;
        
        if (isReadyToFinalize) {
            handleSaveEdit(numManual > 0 ? numManual : undefined);
        } else if (val > 0) {
            if (editActiveTab === 'cash') {
                setEditCashPaid(String((Number(editCashPaid) || 0) + val));
            } else if (editActiveTab === 'NEQUI' || editActiveTab === 'DAVIPLATA') {
                setEditTransferPaid(String((Number(editTransferPaid) || 0) + val));
                setEditTransferSource(editActiveTab);
                setEditActiveTab('cash');
            } else if (editActiveTab === 'credit') {
                setEditCreditPaid(String((Number(editCreditPaid) || 0) + val));
                setEditActiveTab('cash');
            }
            setEditDialogAmount('');
        }
    };

    // Soporte para teclado físico en el modal de edición
    useEffect(() => {
        if (!isEditOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (isClientDialogOpen) return; // No interferir con el diálogo de cliente

            if (e.key >= '0' && e.key <= '9') {
                setEditDialogAmount(prev => prev + e.key);
            } else if (e.key === 'Backspace') {
                setEditDialogAmount(prev => prev.slice(0, -1));
            } else if (e.key === 'Enter') {
                handleNumpadAction();
            } else if (e.key === 'Escape') {
                if (editDialogAmount) setEditDialogAmount('');
                else setIsEditOpen(false);
            } else if (e.key === '.') {
                if (!editDialogAmount.includes('.')) setEditDialogAmount(prev => prev + '.');
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isEditOpen, editDialogAmount, editActiveTab, isClientDialogOpen]);

    const handlePrint = () => {
        window.print();
    };

    const handleResetPayments = () => {
        setEditCashPaid('0');
        setEditTransferPaid('0');
        setEditCreditPaid('0');
        setEditDialogAmount('');
        setEditActiveTab('cash');
        toast({ title: "Pagos Reiniciados", description: "Puedes ingresar los montos desde cero." });
    };

    const handleSaveEdit = async (manualValOverride?: number) => {
        if (!selectedSale) return;
        setIsUpdating(true);
        try {
            const manualVal = manualValOverride !== undefined ? manualValOverride : (Number(editDialogAmount) || 0);
            let numCash = Number(editCashPaid) || 0;
            let numTransfer = Number(editTransferPaid) || 0;
            let numCredit = Number(editCreditPaid) || 0;
            let payloadSource = editTransferSource;

            // 1. Aplicamos el monto manual si existe
            if (manualVal > 0) {
                if (editActiveTab === 'cash') numCash += manualVal;
                else if (editActiveTab === 'NEQUI' || editActiveTab === 'DAVIPLATA') {
                    numTransfer += manualVal;
                    // Aseguramos que el source sea el activo si se usa el monto manual
                    payloadSource = editActiveTab;
                }
                else if (editActiveTab === 'credit') numCredit += manualVal;
            }

            // 2. Lógica Zero Friction: Si aún falta para completar el total, auto-completamos con el método activo
            const currentSubtotal = numCash + numTransfer + numCredit;
            const pendingRemainder = total - currentSubtotal;

            if (pendingRemainder > 0) {
                if (editActiveTab === 'cash') numCash += pendingRemainder;
                else if (editActiveTab === 'NEQUI' || editActiveTab === 'DAVIPLATA') {
                    numTransfer += pendingRemainder;
                    payloadSource = editActiveTab;
                }
                else if (editActiveTab === 'credit') numCredit += pendingRemainder;
            }

            const totalPaid = numCash + numTransfer + numCredit;
            const finalChange = Math.max(0, totalPaid - (selectedSale.total || 0));
            
            const payload = {
                clientDni: editCustomerDni,
                paymentMethod: numCredit > 0 ? "FIADO" : (numCash > 0 && numTransfer > 0 ? "MIXTO" : numTransfer > 0 ? "TRANSFERENCIA" : "EFECTIVO"),
                cashAmount: numCash,
                transferAmount: numTransfer,
                transferSource: payloadSource,
                creditAmount: numCredit,
                amountPaid: totalPaid,
                change: finalChange
            };

            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api'}/sales/update-payment/${selectedSale.id}`, {
                method: 'PUT',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('org-pos-token')}` 
                },
                body: JSON.stringify(payload)
            });

            if (!res.ok) throw new Error('Error al actualizar pago');
            
            setLastChange(finalChange);
            setShowSuccessScreen(true);
            setEditDialogAmount('');
            toast({ title: "✓ Actualizado", description: "El método de pago ha sido corregido." });
        } catch (err: any) {
            toast({ variant: "destructive", title: "Error", description: err.message });
        } finally {
            setIsUpdating(false);
        }
    };

    const getStatusColor = (method: string) => {
        const m = method?.toUpperCase() || '';
        if (m.includes('EFECTIVO')) return "success";
        if (m.includes('TRANSFER')) return "primary";
        if (m.includes('FIADO') || m.includes('CREDITO')) return "warning";
        return "default";
    };

    return (
        <div className="flex flex-col h-screen gap-1 p-1 bg-gray-50 dark:bg-zinc-950 transition-colors duration-500 overflow-hidden">

            {/* Header Moderno (Soporta Claro / Oscuro) */}
            <header className="flex items-center justify-between gap-2 p-2 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-lg shrink-0 shadow-sm transition-colors">
                <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-md bg-emerald-500 flex items-center justify-center text-white shadow-sm shrink-0">
                        <HistoryIcon size={16} />
                    </div>
                    <div className="flex flex-col">
                        <h1 className="text-sm font-black text-gray-900 dark:text-white uppercase leading-none">
                            HISTORIAL <span className="text-emerald-600 dark:text-emerald-500">VENTAS</span>
                        </h1>
                        <p className="text-[9px] font-bold text-gray-500 dark:text-zinc-400 uppercase tracking-widest leading-none mt-0.5">
                            Gestión transacciones
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <Input
                        size="sm"
                        placeholder="BUSCAR VENTA..."
                        value={searchQuery}
                        onValueChange={setSearchQuery}
                        isClearable
                        onClear={() => setSearchQuery('')}
                        startContent={<Search className="text-gray-400 dark:text-zinc-500 h-3.5 w-3.5" />}
                        classNames={{
                            inputWrapper: "h-8 bg-transparent border border-gray-200 dark:border-white/10 transition-all rounded-md w-48 md:w-64 font-bold text-[10px] shadow-none",
                            input: "placeholder:text-gray-400 dark:placeholder:text-zinc-500 text-gray-900 dark:text-white bg-transparent"
                        }}
                    />
                    <Button
                        size="sm"
                        isIconOnly
                        variant="flat"
                        className="h-8 w-8 rounded-md bg-emerald-500 text-white shadow-lg shrink-0"
                    >
                        <Download size={14} />
                    </Button>
                </div>
            </header>

            {/* Grid de KPIs */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-1 shrink-0">
                {[
                    { label: "Ventas Totales", val: totalItems, icon: TrendingUp, color: "emerald", desc: "Acumulado histórico" },
                    { label: "Cierres Pendientes", val: "0", icon: Clock, color: "amber", desc: "Ventas sin liquidar" },
                    { label: "Clientes Únicos", val: "84", icon: User, color: "blue", desc: "Base de datos activa" },
                    { label: "Promedio Ticket", val: "$12.450", icon: ShoppingCart, color: "purple", desc: "Valor medio de venta" }
                ].map((kpi, i) => (
                    <Card key={i} className="rounded-lg bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 shadow-sm hover:shadow-md transition-all duration-500 group overflow-hidden">
                        <CardBody className="p-2">
                            <h3 className="text-[7px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest">{kpi.label}</h3>
                            <div className="flex items-center justify-between">
                                <div className="text-sm font-black text-gray-900 dark:text-white mt-0.5 tabular-nums leading-none">{kpi.val}</div>
                                <kpi.icon className={`h-3 w-3 text-${kpi.color}-600 dark:text-${kpi.color}-500 opacity-20 group-hover:opacity-100 transition-opacity`} />
                            </div>
                        </CardBody>
                    </Card>
                ))}
            </div>

            {/* Tabla de Resultados */}
            <Card className="flex-1 rounded-lg bg-white dark:bg-zinc-900 border-gray-200 dark:border-white/5 shadow-sm overflow-hidden min-h-0 flex flex-col">
                <CardBody className="p-0 flex-1 overflow-hidden flex flex-col">
                    <Table
                        aria-label="Historial de ventas"
                        removeWrapper
                        isCompact
                        classNames={{
                            base: "flex-1 overflow-auto custom-scrollbar",
                            th: "bg-gray-50 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 font-black uppercase text-[9px] tracking-widest h-10 border-b border-gray-200 dark:border-white/5 px-4 sticky top-0 z-10",
                            td: "py-2 border-b border-gray-100 dark:border-white/5 px-4",
                            tr: "hover:bg-gray-50 dark:hover:bg-zinc-800/50 cursor-pointer transition-colors group"
                        }}
                    >
                        <TableHeader>
                            <TableColumn>ID VENTA</TableColumn>
                            <TableColumn>FECHA Y HORA</TableColumn>
                            <TableColumn>CLIENTE / DNI</TableColumn>
                            <TableColumn>MÉTODO</TableColumn>
                            <TableColumn align="end">TOTAL</TableColumn>
                            <TableColumn align="center">ACCIONES</TableColumn>
                        </TableHeader>
                        <TableBody
                            emptyContent={
                                <div className="py-20 flex flex-col items-center gap-4">
                                    <Search className="h-12 w-12 text-gray-300 dark:text-zinc-700" />
                                    <p className="text-gray-400 dark:text-zinc-500 font-black uppercase text-xs">
                                        {searchQuery ? 'No se encontraron resultados' : 'No hay ventas registradas'}
                                    </p>
                                </div>
                            }
                            loadingContent={<Spinner color="success" size="lg" />}
                            isLoading={isLoading}
                        >
                            {sales.map((sale) => (
                                <TableRow key={sale.id} onClick={() => handleOpenPreview(sale)}>
                                    <TableCell>
                                        <span className="font-black text-xs text-gray-500 dark:text-zinc-400 group-hover:text-emerald-500 transition-colors">#{sale.id}</span>
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex flex-col">
                                            <span className="font-bold text-xs text-gray-900 dark:text-white uppercase leading-none">{new Date(sale.date || '').toLocaleDateString('es-CO', { day: '2-digit', month: 'short' })}</span>
                                            <span className="text-[8px] text-gray-500 dark:text-zinc-500 font-mono mt-0.5">{new Date(sale.date || '').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex flex-col">
                                            <span className="font-bold text-xs text-gray-900 dark:text-white uppercase tracking-tight leading-none">{sale.client?.name || 'Consumidor Final'}</span>
                                            <span className="text-[8px] text-gray-500 dark:text-zinc-500 font-bold uppercase tracking-widest mt-0.5">{sale.client?.dni || 'SN-0000'}</span>
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex flex-wrap gap-1">
                                            {sale.cashAmount > 0 && (
                                                <Chip size="sm" variant="flat" color="success" className="font-black uppercase text-[8px] h-5 px-1">EFECTIVO</Chip>
                                            )}
                                            {sale.transferAmount > 0 && (
                                                <Chip size="sm" variant="flat" color="secondary" className="font-black uppercase text-[8px] h-5 px-1">{sale.transferSource || 'TRANSFER'}</Chip>
                                            )}
                                            {sale.creditAmount > 0 && (
                                                <Chip size="sm" variant="flat" color="warning" className="font-black uppercase text-[8px] h-5 px-1">FIADO</Chip>
                                            )}
                                            {!(sale.cashAmount > 0 || sale.transferAmount > 0 || sale.creditAmount > 0) && (
                                                <Chip size="sm" variant="flat" color="default" className="font-black uppercase text-[8px] h-5 px-1">{sale.paymentMethod || 'EFECTIVO'}</Chip>
                                            )}
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <div className="font-black text-sm text-gray-900 dark:text-white tabular-nums tracking-tighter">
                                            ${sale.total?.toLocaleString() || 0}
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex items-center justify-center gap-1">
                                            <Button
                                                isIconOnly
                                                size="sm"
                                                variant="flat"
                                                className="h-7 w-7 rounded-lg bg-gray-50 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:bg-emerald-500 hover:text-white dark:hover:bg-emerald-500 dark:hover:text-white transition-all"
                                                onClick={(e) => { e.stopPropagation(); handleOpenPreview(sale); }}
                                            >
                                                <Eye size={14} />
                                            </Button>
                                            <Button
                                                isIconOnly
                                                size="sm"
                                                variant="flat"
                                                className="h-7 w-7 rounded-lg bg-gray-50 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:bg-amber-500 hover:text-white dark:hover:bg-amber-500 dark:hover:text-white transition-all"
                                                onClick={(e) => { e.stopPropagation(); handleOpenEdit(sale); }}
                                            >
                                                <Pencil size={12} />
                                            </Button>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>

                    {/* Paginación */}
                    <div className="px-4 py-2 bg-gray-50 dark:bg-zinc-950 flex items-center justify-between gap-2 border-t border-gray-200 dark:border-white/5 shrink-0">
                        <div className="text-[9px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest">
                             {totalItems} REGISTROS
                        </div>
                        <Pagination
                            total={totalPages}
                            page={page}
                            onChange={setPage}
                            showControls
                            size="sm"
                            color="success"
                            variant="flat"
                            classNames={{
                                wrapper: "gap-1",
                                item: "w-7 h-7 min-w-7 rounded-lg font-black text-[10px] bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5",
                                cursor: "bg-emerald-600 dark:bg-emerald-500 text-white shadow-sm",
                                next: "bg-white dark:bg-zinc-900 rounded-lg border border-gray-200 dark:border-white/5",
                                prev: "bg-white dark:bg-zinc-900 rounded-lg border border-gray-200 dark:border-white/5"
                            }}
                        />
                    </div>
                </CardBody>
            </Card>

            {/* Modal de Detalle */}
            <Modal
                isOpen={isPreviewOpen}
                onOpenChange={setIsPreviewOpen}
                size="3xl"
                backdrop="blur"
                scrollBehavior="inside"
                classNames={{
                    base: "bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-[2.5rem] shadow-2xl",
                    header: "border-b border-gray-100 dark:border-white/5 p-8",
                    body: "p-8",
                    footer: "border-t border-gray-100 dark:border-white/5 p-8"
                }}
            >
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader className="flex flex-col gap-1">
                                <div className="flex items-center justify-between w-full">
                                    <div className="flex items-center gap-4">
                                        <div className="h-12 w-12 rounded-2xl bg-emerald-100 dark:bg-emerald-500/10 flex items-center justify-center border border-emerald-200 dark:border-emerald-500/20">
                                            <FileText className="h-6 w-6 text-emerald-600 dark:text-emerald-500" />
                                        </div>
                                        <div>
                                            <h2 className="text-2xl font-black text-gray-900 dark:text-white uppercase tracking-tight">Comprobante #{selectedSale?.id}</h2>
                                            <p className="text-[10px] text-gray-400 dark:text-zinc-500 font-black uppercase tracking-widest leading-none mt-1">Detalle de transacción comercial</p>
                                        </div>
                                    </div>
                                    <Chip variant="dot" color="success" className="font-bold border-gray-200 dark:border-white/10">Sincronizado</Chip>
                                </div>
                            </ModalHeader>
                            <ModalBody>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
                                    <div className="space-y-4">
                                        <h4 className="text-[10px] font-black text-emerald-600 dark:text-emerald-500 uppercase tracking-widest px-1">Información del Cliente</h4>
                                        <div className="p-5 bg-gray-50 dark:bg-zinc-800 rounded-3xl border border-gray-200 dark:border-white/5 space-y-3">
                                            <div className="flex justify-between items-center">
                                                <span className="text-[10px] font-bold text-gray-400 dark:text-zinc-400 uppercase tracking-widest">Nombre</span>
                                                <span className="text-sm font-black text-gray-900 dark:text-white uppercase">{selectedSale?.client?.name || 'Consumidor Final'}</span>
                                            </div>
                                            <div className="flex justify-between items-center">
                                                <span className="text-[10px] font-bold text-gray-400 dark:text-zinc-400 uppercase tracking-widest">DNI / NIT</span>
                                                <span className="text-sm font-black text-gray-900 dark:text-white font-mono">{selectedSale?.client?.dni || 'SN-0000'}</span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="space-y-4">
                                        <h4 className="text-[10px] font-black text-emerald-600 dark:text-emerald-500 uppercase tracking-widest px-1">Resumen de Pago</h4>
                                        <div className="p-5 bg-gray-50 dark:bg-zinc-800 rounded-3xl border border-gray-200 dark:border-white/5 space-y-3">
                                            <div className="flex justify-between items-center">
                                                <span className="text-[10px] font-bold text-gray-400 dark:text-zinc-400 uppercase tracking-widest">Método</span>
                                                <Chip size="sm" color={getStatusColor(selectedSale?.paymentMethod || '')} variant="flat" className="font-black uppercase text-[8px] tracking-[0.2em]">{selectedSale?.paymentMethod || 'Efectivo'}</Chip>
                                            </div>
                                            <div className="flex justify-between items-center">
                                                <span className="text-[10px] font-bold text-gray-400 dark:text-zinc-400 uppercase tracking-widest">Fecha</span>
                                                <span className="text-sm font-black text-gray-900 dark:text-white">{new Date(selectedSale?.date || '').toLocaleDateString('es-CO')}</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-4">
                                    <h4 className="text-[10px] font-black text-emerald-600 dark:text-emerald-500 uppercase tracking-widest px-1">Artículos Vendidos</h4>
                                    <div className="rounded-[2rem] border border-gray-200 dark:border-white/5 overflow-hidden">
                                        <Table isCompact removeWrapper aria-label="Detalle de productos" classNames={{ th: "bg-gray-50 dark:bg-zinc-800 text-[9px] font-black uppercase tracking-widest text-gray-400 dark:text-zinc-400 h-10", td: "py-4 border-b border-gray-100 dark:border-white/5 bg-white dark:bg-zinc-900" }}>
                                            <TableHeader>
                                                <TableColumn>PRODUCTO</TableColumn>
                                                <TableColumn align="center">CANT</TableColumn>
                                                <TableColumn align="end">SUBTOTAL</TableColumn>
                                            </TableHeader>
                                            <TableBody>
                                                {(selectedSale?.details || []).map((detail: any, idx: number) => (
                                                    <TableRow key={idx}>
                                                        <TableCell>
                                                            <div className="flex flex-col">
                                                                <span className="font-bold text-xs text-gray-900 dark:text-white uppercase">{detail.product?.productName || 'Producto'}</span>
                                                            </div>
                                                        </TableCell>
                                                        <TableCell className="text-center font-black text-xs text-gray-500 dark:text-zinc-400 tabular-nums">{detail.quantity}</TableCell>
                                                        <TableCell className="text-right font-black text-sm text-gray-900 dark:text-white tabular-nums">${(detail.subtotal || (detail.unitPrice * detail.quantity)).toLocaleString()}</TableCell>
                                                    </TableRow>
                                                ))}
                                            </TableBody>
                                        </Table>
                                    </div>
                                </div>

                                <div className="mt-8 flex justify-end">
                                    <div className="w-80 space-y-4">
                                        <div className="flex justify-between items-center px-4">
                                            <span className="text-[10px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest">Subtotal Gravado</span>
                                            <span className="text-sm font-black text-gray-900 dark:text-white tabular-nums">${(selectedSale?.total || 0).toLocaleString()}</span>
                                        </div>
                                        <Divider className="dark:bg-white/5" />
                                        <div className="flex justify-between items-center p-6 bg-emerald-600 rounded-[1.5rem] shadow-xl shadow-emerald-500/20">
                                            <span className="text-[10px] font-black text-emerald-100 uppercase tracking-[0.2em]">Total Transacción</span>
                                            <span className="text-2xl font-black text-white tabular-nums tracking-tighter">${(selectedSale?.total || 0).toLocaleString()}</span>
                                        </div>
                                    </div>
                                </div>
                            </ModalBody>
                            <ModalFooter>
                                <Button color="danger" variant="light" onPress={onClose} className="font-bold uppercase text-[10px] tracking-widest px-8 h-12">CERRAR</Button>
                                <Button
                                    className="h-12 px-10 bg-emerald-600 text-white font-black uppercase text-[10px] tracking-widest rounded-2xl shadow-xl hover:scale-105 active:scale-95 transition-all"
                                    startContent={<Printer className="h-4 w-4" />}
                                    onPress={handlePrint}
                                >
                                    Imprimir Factura
                                </Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>

             {/* Modal de Edición de Pago (Zero Friction Style) */}
            <Modal
                isOpen={isEditOpen}
                onOpenChange={setIsEditOpen}
                size="full"
                backdrop="blur"
                classNames={{
                    base: "bg-gray-100 dark:bg-zinc-950 border border-gray-300 dark:border-white/5 rounded-none md:rounded-2xl w-[100vw] md:w-[95vw] max-w-[1000px] h-[100vh] md:h-auto md:max-h-[85vh] overflow-hidden",
                    header: "hidden",
                    body: "p-0",
                    footer: "hidden",
                    closeButton: "hidden"
                }}
            >
                <ModalContent className="flex flex-col p-0 overflow-hidden">
                    {(onClose) => {
                        const selectedCustomer = customers.find(c => c.dni === editCustomerDni) || { name: 'Consumidor Final' };

                        return (
                            <div className="flex flex-col lg:flex-row h-full min-h-0 lg:min-h-[400px] relative overflow-y-auto lg:overflow-hidden custom-scrollbar">
                                {showSuccessScreen && (
                                    <div className="absolute inset-0 z-[100] bg-white dark:bg-zinc-950 flex flex-col items-center justify-center p-8 animate-in fade-in zoom-in duration-300">
                                        <div className="h-28 w-28 rounded-full bg-emerald-500 text-white flex items-center justify-center mb-8 shadow-lg shadow-emerald-500/20">
                                            <Check className="h-14 w-14 stroke-[4]" />
                                        </div>
                                        <h2 className="text-3xl font-black text-gray-900 dark:text-white uppercase tracking-widest mb-10">Pago Actualizado</h2>
                                        <div className="bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-white/5 px-16 py-10 rounded-3xl text-center shadow-xl mb-12">
                                            <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4">CAMBIO A ENTREGAR</p>
                                            <p className="text-[5.5rem] font-black text-emerald-600 tabular-nums leading-none tracking-tighter">${lastChange.toLocaleString()}</p>
                                        </div>
                                        <Button 
                                            className="h-16 px-12 font-black text-lg uppercase rounded-2xl shadow-md bg-emerald-500 text-white hover:bg-emerald-600 active:scale-95 transition-all" 
                                            onPress={() => window.location.reload()}
                                        >
                                            FINALIZAR (RECARGAR)
                                        </Button>
                                    </div>
                                )}
                                {/* COLUMNA 1: TABS (Sidebar) */}
                                <div className="w-full lg:w-[200px] bg-white dark:bg-zinc-900 border-b lg:border-r lg:border-b-0 border-gray-200 dark:border-white/5 p-4 flex flex-row lg:flex-col gap-1.5 lg:gap-2 overflow-x-auto lg:overflow-y-auto shrink-0 custom-scrollbar sticky top-0 z-10">
                                    <h3 className="hidden lg:block text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1 pl-1">Pago</h3>
                                    {[
                                        { id: 'cash', label: 'Efectivo', icon: Banknote, color: 'emerald' },
                                        { id: 'NEQUI', label: 'Nequi', logo: '/logos/nequi.png', color: 'pink' },
                                        { id: 'DAVIPLATA', label: 'Daviplata', logo: '/logos/daviplata.png', color: 'red' },
                                        { id: 'credit', label: 'Fiado', icon: Wallet, color: 'rose' }
                                    ].map((tab: any) => (
                                        <button
                                            key={tab.id}
                                            onClick={() => {
                                                setEditActiveTab(tab.id as any);
                                                if (tab.id === 'NEQUI' || tab.id === 'DAVIPLATA') {
                                                    setEditTransferSource(tab.id);
                                                }
                                            }}
                                            className={`h-10 lg:h-12 px-3 lg:px-4 rounded-lg flex items-center gap-2 lg:gap-3 border transition-all shrink-0 font-black uppercase text-[9px] lg:text-[10px] tracking-widest leading-none ${
                                                editActiveTab === tab.id
                                                ? `bg-emerald-500/10 dark:bg-emerald-500/20 border-${tab.color}-500 text-emerald-600 dark:text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.1)] ring-1 ring-emerald-500/30`
                                                : 'border-transparent text-gray-500 hover:bg-gray-50 dark:hover:bg-zinc-800/50'
                                            }`}
                                        >
                                            {tab.logo ? <img src={tab.logo} className="h-4 w-4 lg:h-5 lg:w-5 object-contain rounded-sm" /> : <tab.icon className={`h-3.5 w-3.5 lg:h-4 lg:w-4 ${editActiveTab === tab.id ? `text-${tab.color}-500` : ''}`} />}
                                            {tab.label}
                                        </button>
                                    ))}

                                    <div className="mt-auto pt-4 border-t border-gray-200 dark:border-white/5 flex flex-col gap-2">
                                        <p className="text-[8px] font-black text-gray-400 uppercase tracking-widest pl-1">Acciones</p>
                                        <Button 
                                            size="sm" 
                                            variant="flat" 
                                            color="warning"
                                            className="w-full justify-start h-10 px-3 rounded-lg font-bold text-[10px] uppercase bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-500 hover:bg-amber-100 border border-amber-200 dark:border-amber-500/20"
                                            onPress={handleResetPayments}
                                        >
                                            <HistoryIcon className="h-4 w-4 mr-2" />
                                            Limpiar Pagos
                                        </Button>
                                        <Button 
                                            size="sm" 
                                            variant="flat" 
                                            className="w-full justify-start h-10 px-3 rounded-lg font-bold text-[10px] uppercase bg-sky-50 dark:bg-sky-500/10 text-sky-600 dark:text-sky-500 hover:bg-sky-100 border border-sky-200 dark:border-sky-500/20 truncate"
                                            onPress={() => setIsClientDialogOpen(true)}
                                        >
                                            <User className="h-4 w-4 mr-2" />
                                            <span className="truncate">{selectedCustomer.name}</span>
                                        </Button>
                                        <Button variant="flat" color="danger" className="w-full h-10 font-bold uppercase text-[10px] rounded-lg bg-rose-50 dark:bg-rose-500/10 text-rose-500" onPress={onClose}>Cancelar</Button>
                                    </div>
                                </div>

                                {/* COLUMNA 2: CONTENIDO CENTRAL */}
                                <div className="flex-1 bg-gray-50 dark:bg-zinc-950 flex flex-col p-4 lg:p-6 min-h-0">
                                    <div className="flex flex-col md:flex-row gap-2 lg:gap-4 mb-4 lg:mb-6">
                                        <div className="bg-white dark:bg-zinc-900 px-4 lg:px-6 py-3 lg:py-4 rounded-xl border border-gray-200 dark:border-white/5 flex-1 shadow-sm flex items-center lg:block gap-3 lg:gap-0">
                                            <p className="text-[8px] lg:text-[9px] font-bold text-gray-500 uppercase lg:mb-1">TOTAL VENTA</p>
                                            <p className="text-xl lg:text-2xl font-black text-gray-900 dark:text-white tabular-nums">${total.toLocaleString()}</p>
                                        </div>
                                        <div className={`${remaining > 0 ? 'bg-sky-50 dark:bg-sky-500/10 border-sky-100' : 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-100'} px-4 lg:px-6 py-3 lg:py-4 rounded-xl border-sky-100 dark:border-sky-500/20 flex-1 shadow-sm transition-colors flex items-center lg:block gap-3 lg:gap-0`}>
                                            <p className={`text-[8px] lg:text-[9px] font-bold ${remaining > 0 ? 'text-sky-600' : 'text-emerald-600'} uppercase lg:mb-1`}>{remaining > 0 ? 'PENDIENTE' : 'PAGADO OK'}</p>
                                            <p className={`text-xl lg:text-2xl font-black ${remaining > 0 ? 'text-sky-700' : 'text-emerald-700'} tabular-nums`}>${remaining.toLocaleString()}</p>
                                        </div>
                                    </div>

                                    {editActiveTab === 'cash' ? (
                                        <div className="flex flex-col flex-1 gap-4 lg:gap-0">
                                            <div className="flex flex-col md:flex-row gap-2 lg:gap-4 mb-4 lg:mb-6 lg:flex-1">
                                                <div className="bg-white dark:bg-zinc-900 p-4 lg:p-6 rounded-xl border border-gray-200 dark:border-white/5 flex-1 flex flex-row lg:flex-col justify-between lg:justify-center items-center lg:items-start shadow-sm">
                                                    <p className="text-[9px] lg:text-[10px] font-bold text-gray-400 uppercase lg:mb-2">EFECTIVO RECIBIDO</p>
                                                    <p className="text-2xl lg:text-4xl font-black text-gray-900 dark:text-white tabular-nums">${effectiveTendered.toLocaleString()}</p>
                                                </div>
                                                <div className="bg-white dark:bg-zinc-900 p-4 lg:p-6 rounded-xl border border-gray-200 dark:border-white/5 flex-1 flex flex-row lg:flex-col justify-between lg:justify-center items-center lg:items-start shadow-sm">
                                                    <p className="text-[9px] lg:text-[10px] font-bold text-gray-400 uppercase lg:mb-2">CAMBIO</p>
                                                    <p className="text-2xl lg:text-4xl font-black text-emerald-600 tabular-nums">${change.toLocaleString()}</p>
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-2 lg:grid-cols-2 gap-2">
                                                {[
                                                    { v: 100000, img: '/logos/100.000.jpg' },
                                                    { v: 50000, img: '/logos/50.000.jpg' },
                                                    { v: 20000, img: '/logos/20.000.jpg' },
                                                    { v: 10000, img: '/logos/10.000.jpg' },
                                                    { v: 5000, img: '/logos/5.000.jpg' },
                                                    { v: 2000, img: '/logos/2.000.png' }
                                                ].map(bill => (
                                                    <button
                                                        key={bill.v}
                                                        className="h-16 bg-white dark:bg-zinc-900 hover:ring-2 hover:ring-emerald-500 rounded-xl overflow-hidden border border-gray-200 dark:border-white/10 transition-all active:scale-95 shadow-sm"
                                                        onClick={() => setEditDialogAmount(prev => String(Number(prev || 0) + bill.v))}
                                                    >
                                                        <img src={bill.img} alt={`$${bill.v}`} className="w-full h-full object-cover" />
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex flex-col items-center justify-center flex-1 py-10 lg:py-0">
                                    {editActiveTab === 'NEQUI' || editActiveTab === 'DAVIPLATA' ? (
                                        <div className="flex flex-col items-center justify-center animate-in fade-in zoom-in duration-500">
                                            <div className="h-32 w-32 lg:h-48 lg:w-48 mb-6 flex items-center justify-center">
                                                <img 
                                                    src={editActiveTab === 'NEQUI' ? '/logos/nequi.png' : '/logos/daviplata.png'} 
                                                    className="w-full h-full object-contain filter drop-shadow-2xl" 
                                                    alt={editActiveTab}
                                                />
                                            </div>
                                            <h3 className="text-lg lg:text-xl font-black uppercase text-gray-900 dark:text-white pb-1 tracking-tight">{editActiveTab}</h3>
                                        </div>
                                            ) : (
                                                <div className="flex flex-col items-center justify-center">
                                                    <div className="h-16 w-16 lg:h-24 lg:w-24 rounded-full flex items-center justify-center bg-rose-100 dark:bg-rose-500/10 text-rose-500 mb-4 font-bold uppercase tracking-widest text-[8px] lg:text-[10px]">
                                                        <Zap className="h-6 w-6 lg:h-10 lg:w-10 fill-current" />
                                                    </div>
                                                    <h3 className="text-lg lg:text-xl font-black uppercase text-gray-900 dark:text-white pb-1 tracking-tight">CRÉDITO / FIADO</h3>
                                                </div>
                                            )}
                                            <div className="bg-white dark:bg-zinc-900 px-8 py-4 rounded-2xl border border-gray-200 dark:border-white/5 mt-4 group">
                                                <p className="text-[9px] font-bold text-gray-400 uppercase mb-1 group-hover:text-emerald-500 transition-colors">MONTO ACTUAL</p>
                                                <p className="text-2xl font-black text-gray-900 dark:text-white tabular-nums">${(editActiveTab === 'NEQUI' || editActiveTab === 'DAVIPLATA' ? numTransfer : numCredit).toLocaleString()}</p>
                                            </div>
                                            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-6 animate-pulse">Usa el teclado para ingresar el monto</p>
                                        </div>
                                    )}
                                </div>

                                {/* COLUMNA 3: NUMPAD */}
                                <div className="w-full lg:w-[260px] bg-white dark:bg-zinc-900 border-t lg:border-l lg:border-t-0 border-gray-200 dark:border-white/5 p-4 lg:p-6 flex flex-col gap-3 lg:gap-4 lg:min-h-0">
                                    <div className="bg-gray-50 dark:bg-zinc-950 p-3 lg:p-4 rounded-xl border border-gray-200 dark:border-white/5 text-right shadow-inner flex flex-row lg:flex-col justify-between lg:justify-center items-center lg:items-end">
                                        <p className="text-[8px] lg:text-[9px] font-bold text-emerald-600 uppercase lg:mb-1">MONTO MANUAL</p>
                                        <p className="text-xl lg:text-3xl font-black text-gray-900 dark:text-white tabular-nums lg:h-8">{editDialogAmount ? `$${Number(editDialogAmount).toLocaleString()}` : ''}</p>
                                    </div>
                                    <div className="grid grid-cols-3 gap-2 flex-1 min-h-[160px] lg:min-h-0">
                                        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0, '00', 'CE'].map(n => (
                                            <Button 
                                                key={n} 
                                                className={`h-10 lg:h-full text-lg font-bold rounded-lg ${n === 'CE' ? 'text-rose-500 bg-rose-50 dark:bg-rose-500/10' : 'text-gray-900 dark:text-white bg-gray-50 dark:bg-zinc-800'}`}
                                                onPress={() => n === 'CE' ? setEditDialogAmount('') : setEditDialogAmount(p => p + String(n))}
                                            >
                                                {n}
                                            </Button>
                                        ))}
                                    </div>
                                    <Button 
                                        className={`h-12 lg:h-16 font-black text-sm uppercase rounded-xl shadow-md transition-all ${isReadyToFinalize ? 'bg-emerald-500 text-white' : 'bg-sky-500 text-white'}`}
                                        isLoading={isUpdating}
                                        onPress={handleNumpadAction}
                                    >
                                        {isReadyToFinalize ? 'FINALIZAR' : 'CARGAR'}
                                    </Button>
                                </div>
                            </div>
                        );
                    }}
                </ModalContent>
            </Modal>

            {/* Modal de Selección de Cliente (Igual que en ventas) */}
            <Modal 
                isOpen={isClientDialogOpen} 
                onOpenChange={setIsClientDialogOpen} 
                backdrop="blur" 
                classNames={{ base: "bg-white dark:bg-zinc-950 rounded-[2.5rem] border border-gray-200 dark:border-white/10 p-4" }}
            >
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader className="text-gray-900 dark:text-white font-black uppercase text-base p-6 border-b border-gray-100 dark:border-white/5">Cambiar Cliente de Venta</ModalHeader>
                            <ModalBody className="p-6">
                                <Input 
                                    autoFocus 
                                    placeholder="BUSCAR CLIENTE..." 
                                    value={clientSearch} 
                                    onValueChange={setClientSearch} 
                                    size="lg" 
                                    startContent={<Search className="h-4 w-4 text-gray-400" />} 
                                    classNames={{ 
                                        inputWrapper: "bg-transparent border border-gray-200 dark:border-white/10 h-14 rounded-2xl shadow-none focus-within:!border-emerald-500",
                                        input: "bg-transparent font-bold capitalize"
                                    }} 
                                />
                                <div className="max-h-[300px] overflow-y-auto mt-4 space-y-2 pr-2 custom-scrollbar">
                                    <Button 
                                        variant="flat" 
                                        className="w-full justify-start h-14 bg-sky-50 dark:bg-sky-500/10 text-gray-900 dark:text-white font-black rounded-2xl text-xs uppercase" 
                                        onPress={() => { setEditCustomerDni('0'); onClose(); }}
                                    >
                                        <User className="h-5 w-5 mr-3 text-sky-500" /> Consumidor Final
                                    </Button>
                                    {customers.filter(c => 
                                        c.name?.toLowerCase().includes(clientSearch.toLowerCase()) || 
                                        c.dni?.includes(clientSearch)
                                    ).map(c => (
                                        <Button 
                                            key={c.dni} 
                                            variant="flat" 
                                            className="w-full justify-start h-14 bg-white dark:bg-zinc-800 text-gray-900 dark:text-white font-bold rounded-2xl text-xs uppercase border border-gray-100 dark:border-white/5" 
                                            onPress={() => { setEditCustomerDni(c.dni); onClose(); }}
                                        >
                                            <User className="h-5 w-5 mr-3 text-gray-400" /> {c.name}
                                        </Button>
                                    ))}
                                </div>
                            </ModalBody>
                        </>
                    )}
                </ModalContent>
            </Modal>

            {/* THERMAL RECEIPT (VISIBLE SOLO AL IMPRIMIR) */}
            <div className="hidden print:block fixed inset-0 bg-white text-black font-mono p-4 w-[80mm]" style={{ margin: 0 }}>
                <div className="text-center font-bold mb-4 uppercase">
                    <h1 className="text-xl">POS NEOGEFORCE</h1>
                    <p className="text-[10px]">Copia de Factura</p>
                </div>
                <div className="text-[10px] border-b border-black pb-2 mb-2">
                    <p>ID VENTA: #{selectedSale?.id}</p>
                    <p>FECHA: {selectedSale?.date ? new Date(selectedSale.date).toLocaleString('es-CO') : ''}</p>
                    <p>CLIENTE: {selectedSale?.client?.name || 'Consumidor Final'}</p>
                    <p>DNI/NIT: {selectedSale?.client?.dni || 'SN-0000'}</p>
                </div>
                <table className="w-full text-[9px] uppercase mb-2 border-b border-black">
                    <thead>
                        <tr className="border-b border-black text-left">
                            <th className="py-1">CANT</th>
                            <th className="py-1">DESC</th>
                            <th className="py-1 text-right">TOTAL</th>
                        </tr>
                    </thead>
                    <tbody>
                        {(selectedSale?.details || []).map((it: any, idx: number) => (
                            <tr key={idx}>
                                <td className="py-1 font-bold">{it.quantity}</td>
                                <td className="py-1">{it.product?.productName}</td>
                                <td className="py-1 text-right font-black">${(it.subtotal || (it.unitPrice * it.quantity)).toLocaleString()}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <div className="text-right text-[10px] space-y-1">
                    <div className="flex justify-between font-bold">
                        <span>SUBTOTAL:</span>
                        <span>${(selectedSale?.total || 0).toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between text-lg font-black pt-1">
                        <span>TOTAL:</span>
                        <span>${(selectedSale?.total || 0).toLocaleString()}</span>
                    </div>
                </div>
                <div className="text-[10px] mt-4 pt-2 border-t border-dotted border-black">
                    <p className="flex justify-between"><span>METODO:</span> <span>{selectedSale?.paymentMethod}</span></p>
                    {selectedSale && selectedSale.cashAmount > 0 && <p className="flex justify-between"><span>EFECTIVO:</span> <span>${selectedSale.cashAmount.toLocaleString()}</span></p>}
                    {selectedSale && selectedSale.transferAmount > 0 && <p className="flex justify-between"><span>{selectedSale.transferSource}:</span> <span>${selectedSale.transferAmount.toLocaleString()}</span></p>}
                    {selectedSale && selectedSale.change > 0 && <p className="flex justify-between font-black"><span>SU CAMBIO:</span> <span>${selectedSale.change.toLocaleString()}</span></p>}
                </div>
                <div className="text-center text-[9px] mt-8 pt-4 border-t border-black uppercase font-bold">
                    <p>¡Gracias por su visita!</p>
                </div>
            </div>
        </div>
    );
}