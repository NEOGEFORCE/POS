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
    History as HistoryIcon
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

    const getStatusColor = (method: string) => {
        const m = method?.toUpperCase() || '';
        if (m.includes('EFECTIVO')) return "success";
        if (m.includes('TRANSFER')) return "primary";
        if (m.includes('FIADO') || m.includes('CREDITO')) return "warning";
        return "default";
    };

    return (
        <div className="flex flex-col gap-6 p-4 md:p-8 w-full min-h-screen bg-gray-50 dark:bg-zinc-950 transition-colors duration-500">

            {/* Header Moderno (Soporta Claro / Oscuro) */}
            <header className="flex flex-col md:flex-row md:items-center justify-between gap-6 px-8 py-6 bg-white dark:bg-zinc-900 backdrop-blur-2xl rounded-[2.5rem] border border-gray-200 dark:border-white/5 shadow-xl">
                <div className="flex items-center gap-5">
                    <div className="h-16 w-16 rounded-[1.5rem] bg-emerald-100 dark:bg-emerald-500/10 flex items-center justify-center border border-emerald-200 dark:border-emerald-500/20 shadow-inner">
                        <HistoryIcon className="h-8 w-8 text-emerald-600 dark:text-emerald-500" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-black text-gray-900 dark:text-white uppercase tracking-tighter">
                            Historial de <span className="text-emerald-600 dark:text-emerald-500">Ventas</span>
                        </h1>
                        <p className="text-[10px] text-gray-500 dark:text-zinc-400 font-black uppercase tracking-[0.2em] mt-1">
                            Gestión integral de transacciones
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-3 w-full md:w-auto">
                    <div className="relative group w-full md:w-80">
                        <Input
                            placeholder="Buscar por ID, Cliente o DNI..."
                            value={searchQuery}
                            onValueChange={setSearchQuery}
                            isClearable
                            onClear={() => setSearchQuery('')}
                            startContent={<Search className="text-gray-400 dark:text-zinc-500 h-4 w-4" />}
                            classNames={{
                                inputWrapper: "h-14 bg-gray-100 dark:bg-zinc-800 border-gray-200 dark:border-white/5 group-hover:border-emerald-500/50 transition-all rounded-2xl w-full font-bold text-sm",
                                input: "placeholder:text-gray-400 dark:placeholder:text-zinc-500 text-gray-900 dark:text-white"
                            }}
                        />
                    </div>
                    <Button
                        isIconOnly
                        variant="flat"
                        className="h-14 w-14 rounded-2xl bg-emerald-100 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-500 border border-emerald-200 dark:border-emerald-500/20 shadow-lg shrink-0"
                    >
                        <Download className="h-5 w-5" />
                    </Button>
                </div>
            </header>

            {/* Grid de KPIs */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
                {[
                    { label: "Ventas Totales", val: totalItems, icon: TrendingUp, color: "emerald", desc: "Acumulado histórico" },
                    { label: "Cierres Pendientes", val: "0", icon: Clock, color: "amber", desc: "Ventas sin liquidar" },
                    { label: "Clientes Únicos", val: "84", icon: User, color: "blue", desc: "Base de datos activa" },
                    { label: "Promedio Ticket", val: "$12.450", icon: ShoppingCart, color: "purple", desc: "Valor medio de venta" }
                ].map((kpi, i) => (
                    <Card key={i} className="rounded-[2rem] bg-white dark:bg-zinc-900 border-gray-200 dark:border-white/5 shadow-lg hover:shadow-2xl transition-all duration-500 group overflow-hidden">
                        <CardBody className="p-8">
                            <div className="flex items-center justify-between mb-4">
                                <div className={`h-12 w-12 rounded-2xl bg-${kpi.color}-100 dark:bg-${kpi.color}-500/10 flex items-center justify-center border border-${kpi.color}-200 dark:border-${kpi.color}-500/20 group-hover:scale-110 transition-transform duration-500`}>
                                    <kpi.icon className={`h-6 w-6 text-${kpi.color}-600 dark:text-${kpi.color}-500`} />
                                </div>
                                <ArrowRight className="h-4 w-4 text-gray-300 dark:text-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity" />
                            </div>
                            <h3 className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest">{kpi.label}</h3>
                            <div className="text-2xl font-black text-gray-900 dark:text-white mt-1 tabular-nums">{kpi.val}</div>
                            <p className="text-[9px] text-gray-400 dark:text-zinc-600 font-bold mt-2 uppercase">{kpi.desc}</p>
                        </CardBody>
                    </Card>
                ))}
            </div>

            {/* Tabla de Resultados */}
            <Card className="rounded-[2.5rem] bg-white dark:bg-zinc-900 border-gray-200 dark:border-white/5 shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-8 duration-1000">
                <CardBody className="p-0">
                    <Table
                        aria-label="Historial de ventas"
                        removeWrapper
                        isCompact
                        classNames={{
                            base: "overflow-x-auto",
                            th: "bg-gray-50 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 font-black uppercase text-[10px] tracking-widest h-14 border-b border-gray-200 dark:border-white/5 px-8",
                            td: "py-6 border-b border-gray-100 dark:border-white/5 px-8",
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
                                        <span className="font-black text-sm text-gray-500 dark:text-zinc-400 group-hover:text-emerald-500 transition-colors">#{sale.id}</span>
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex flex-col">
                                            <span className="font-bold text-sm text-gray-900 dark:text-white uppercase">{new Date(sale.date || '').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
                                            <span className="text-[10px] text-gray-500 dark:text-zinc-500 font-mono mt-0.5">{new Date(sale.date || '').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex flex-col">
                                            <span className="font-bold text-sm text-gray-900 dark:text-white uppercase tracking-tight">{sale.client?.name || 'Consumidor Final'}</span>
                                            <span className="text-[10px] text-gray-500 dark:text-zinc-500 font-bold uppercase tracking-widest mt-0.5">{sale.client?.dni || 'SN-0000'}</span>
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <Chip
                                            size="sm"
                                            variant="flat"
                                            color={getStatusColor(sale.paymentMethod)}
                                            className="font-black uppercase tracking-widest text-[9px] px-2"
                                        >
                                            {sale.paymentMethod || 'Efectivo'}
                                        </Chip>
                                    </TableCell>
                                    <TableCell>
                                        <div className="font-black text-lg text-gray-900 dark:text-white tabular-nums tracking-tighter">
                                            ${sale.total?.toLocaleString() || 0}
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex items-center justify-center gap-2">
                                            <Tooltip content="Ver Factura" showArrow radius="lg" classNames={{ content: "bg-gray-900 text-white font-bold uppercase text-[10px] tracking-widest px-4 py-2" }}>
                                                <Button
                                                    isIconOnly
                                                    size="sm"
                                                    variant="flat"
                                                    className="h-10 w-10 rounded-xl bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 hover:bg-emerald-500 hover:text-white dark:hover:bg-emerald-500 dark:hover:text-white transition-all duration-300"
                                                >
                                                    <Eye className="h-4 w-4" />
                                                </Button>
                                            </Tooltip>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>

                    {/* Paginación */}
                    <div className="px-8 py-6 bg-gray-50 dark:bg-zinc-950 flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-gray-200 dark:border-white/5">
                        <div className="text-[10px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest">
                            Mostrando <span className="text-gray-900 dark:text-white font-mono">{totalItems === 0 ? 0 : ((page - 1) * pageSize) + 1} - {Math.min(page * pageSize, totalItems)}</span> de <span className="text-gray-900 dark:text-white font-mono">{totalItems}</span>
                        </div>
                        <Pagination
                            total={totalPages}
                            page={page}
                            onChange={setPage}
                            showControls
                            color="success"
                            variant="flat"
                            classNames={{
                                wrapper: "gap-2",
                                item: "w-10 h-10 min-w-10 rounded-xl font-black text-xs bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5",
                                cursor: "bg-emerald-600 dark:bg-emerald-500 text-white shadow-lg shadow-emerald-500/30",
                                next: "bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-white/5",
                                prev: "bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-white/5"
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
                                                        <TableCell className="text-right font-black text-sm text-gray-900 dark:text-white tabular-nums">${(detail.price * detail.quantity).toLocaleString()}</TableCell>
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
                                <Button color="danger" variant="light" onPress={onClose} className="font-bold uppercase text-[10px] tracking-widest px-8 h-12">Cerrar</Button>
                                <Button
                                    className="h-12 px-10 bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase text-[10px] tracking-widest rounded-2xl shadow-xl hover:scale-105 active:scale-95 transition-all"
                                    startContent={<Download className="h-4 w-4" />}
                                >
                                    Descargar PDF
                                </Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>
        </div>
    );
}