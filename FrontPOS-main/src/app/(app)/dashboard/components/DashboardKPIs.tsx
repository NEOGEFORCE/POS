"use client";

import { 
    ShoppingCart, Wallet, CreditCard, ArrowDownRight, HandCoins, ChevronRight, TrendingUp, DollarSign,
    PlusCircle, MinusCircle, Smartphone, Coins, Info, LineChart, Package, Landmark, Banknote, RotateCcw, Trash2
} from "lucide-react";
import { formatCurrency } from "@/lib/utils";

import { Chip, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Tooltip } from "@heroui/react";
import React from 'react';
import AuditModal from "./AuditModal";
import Cookies from 'js-cookie';
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import { Stagger, StaggerItem, useReducedMotionSafe } from "@/components/ui/motion";
import { RollingDigits } from "@/components/charts/RollingDigits";



const formatCurrencyWithColor = (value: number, label?: string) => {
    const formatted = formatCurrency(value);
    const isNegative = value < 0;
    
    // Nueva logica: si el valor es negativo en balance, es un FALTANTE/EGRESO (rojo o neutro)
    // Pero aqui solo formateamos.
    if (isNegative) {
        return (
            <span className="text-rose-500 font-bold">
                -${formatCurrency(Math.abs(value))}
            </span>
        );
    }
    
    return (
        <span className="text-zinc-900 dark:text-zinc-100 font-bold">
            ${formatted}
        </span>
    );
};

function KpiCard({ 
    label, value, sub, icon: Icon, color, onClick, isCurrency = false, chartData, subColor, badge, variant = "default", footer, hideHeader = false, topAction
}: {
    label: string; value: string | number | React.ReactNode; sub: React.ReactNode; icon: any; color: string; onClick?: () => void; isCurrency?: boolean; chartData?: any[]; subColor?: string; badge?: React.ReactNode; variant?: "default" | "audit"; footer?: React.ReactNode; hideHeader?: boolean;
    topAction?: React.ReactNode;
}) {
    const isAudit = variant === "audit";
    const reduced = useReducedMotionSafe();

    const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
        const target = e.currentTarget;
        const rect = target.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        target.style.setProperty('--spotlight-x', `${x}%`);
        target.style.setProperty('--spotlight-y', `${y}%`);
    };

    return (
        <motion.div
            onClick={onClick}
            onMouseMove={handleMouseMove}
            whileHover={reduced ? undefined : { y: -2 }}
            transition={{ type: 'spring', stiffness: 400, damping: 25 }}
            className={`relative group flex-1 ${isAudit ? 'card-featured' : 'card-base'} card-spotlight overflow-hidden transition-all duration-150 hover:scale-[1.01] ${onClick ? 'cursor-pointer active:scale-[0.98]' : ''} ${isAudit ? 'md:col-span-2' : ''}`}
        >


            <div className={`relative z-10 h-full flex flex-col ${isAudit ? 'p-0' : 'p-5'}`}>
                {/* Header Section */}
                {!hideHeader && (
                    <div className={`${isAudit ? 'p-6 pb-4 bg-gradient-to-br from-zinc-500/5 to-transparent' : 'mb-4'} flex justify-between items-start`}>
                        {!isAudit && (
                            <div className="w-10 h-10 flex items-center justify-center rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-white/8 text-gray-500 dark:text-zinc-500 dark:text-zinc-400 shrink-0">
                                <Icon size={18} />
                            </div>
                        )}
                        
                        <div className={`flex flex-col ${isAudit ? 'items-start w-full' : 'items-end overflow-hidden'}`}>
                            <div className="flex items-center justify-between w-full gap-2">
                                <span className={`uppercase tracking-widest leading-none mb-2 ${isAudit ? 'text-[11px] font-medium text-gray-500 dark:text-zinc-500' : 'text-[11px] font-medium text-gray-500 dark:text-zinc-500 truncate flex-1'}`}>
                                    {label}
                                </span>
                                {topAction && <div className="mb-2">{topAction}</div>}
                            </div>
                            
                            <div className={`flex items-center gap-3 ${isAudit ? 'w-full justify-between' : ''}`}>
                                <span className={`font-light tracking-tight text-zinc-900 dark:text-zinc-50 tabular-nums font-['DM_Mono'] truncate pr-1 ${isAudit ? 'text-4xl sm:text-5xl lg:text-6xl text-zinc-900 dark:text-zinc-100' : 'text-3xl'}`}>
                                    {isCurrency && typeof value === 'number' && !isAudit ? (
                                        Math.round(value) < 0 ? (
                                            <span className="text-rose-500 font-bold">
                                                -$<RollingDigits value={Math.abs(Math.round(value))} format={(n) => formatCurrency(n)} duration={1.6} />
                                            </span>
                                        ) : (
                                            <span className="text-zinc-900 dark:text-zinc-100 font-bold">
                                                $<RollingDigits value={Math.round(value)} format={(n) => formatCurrency(n)} duration={1.6} />
                                            </span>
                                        )
                                    ) : isCurrency && typeof value === 'number' ? formatCurrencyWithColor(Math.round(value)) : value}
                                </span>
                                {!isAudit && badge && <div>{badge}</div>}
                            </div>
                        </div>
                    </div>
                )}

                {/* Sub/Breakdown Content */}
                <div className={`${isAudit ? (hideHeader ? 'h-full flex items-center px-6 py-8' : 'px-6 py-4 border-y border-zinc-200 dark:border-white/5 bg-zinc-100 dark:bg-zinc-800/30') : 'mt-auto'}`}>
                    <div className={`${isAudit ? 'w-full' : 'text-xs text-zinc-600 mt-1'}`}>
                        <div className="break-words" style={{ color: subColor || undefined }}>{sub}</div>
                        {onClick && !isAudit && (
                            <div className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 flex items-center gap-1 mt-2 justify-end transition-all duration-150 group-hover:text-gray-600 dark:text-zinc-300">
                                VER DETALLES <ChevronRight size={12} />
                            </div>
                        )}
                    </div>
                </div>

                {/* Audit Footer */}
                {isAudit && footer && (
                    <div className="mt-auto p-4 bg-white dark:bg-zinc-950/50 flex justify-between items-center border-t border-zinc-200 dark:border-white/10">
                        {footer}
                    </div>
                )}
            </div>
        </motion.div>
    );
}

interface DashboardKPIsProps {
    data: any;
    onOpenDebts?: () => void;
}

export default function DashboardKPIs({ data, onOpenDebts }: DashboardKPIsProps) {
    if (!data) return null;
    const { toast } = useToast();

    // ESTADOS GLOBALES DE CONTROL
    const [isAuditModalOpen, setIsAuditModalOpen] = React.useState(false);
    const [isResetProfitModalOpen, setIsResetProfitModalOpen] = React.useState(false);
    const [isResetExpectedModalOpen, setIsResetExpectedModalOpen] = React.useState(false);
    const [isResetting, setIsResetting] = React.useState(false);
    const [isResettingExpected, setIsResettingExpected] = React.useState(false);

    // MANEJADORES DE REINICIO Y AJUSTE
    const handleResetProfit = async () => {
        setIsResetting(true);
        try {
            const response = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/dashboard/reset-profit`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${Cookies.get('org-pos-token')}`
                }
            });

            if (response.ok) {
                toast({ variant: 'success', title: 'EXITO', description: 'UTILIDAD REINICIADA CORRECTAMENTE.' });
                setTimeout(() => window.location.reload(), 1000);
            } else {
                const err = await response.json();
                toast({ variant: 'destructive', title: 'ERROR', description: err.message || 'FALLO AL REINICIAR UTILIDAD' });
            }
        } catch (error) {
            toast({ variant: 'destructive', title: 'ERROR DE RED', description: 'NO HAY COMUNICACION CON EL SERVIDOR.' });
        } finally {
            setIsResetting(false);
            setIsResetProfitModalOpen(false);
        }
    };

    const handleResetExpectedBalance = async () => {
        setIsResettingExpected(true);
        try {
            const response = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/dashboard/reset-expected-balance`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${Cookies.get('org-pos-token')}`
                }
            });

            if (response.ok) {
                toast({ variant: 'success', title: 'EXITO', description: 'SALDO ESPERADO REINICIADO.' });
                setTimeout(() => window.location.reload(), 1000);
            } else {
                const err = await response.json();
                toast({ variant: 'destructive', title: 'ERROR', description: err.message || 'FALLO AL REINICIAR SALDO' });
            }
        } catch (error) {
            toast({ variant: 'destructive', title: 'ERROR DE RED', description: 'SIN CONEXION AL SERVIDOR.' });
        } finally {
            setIsResettingExpected(false);
            setIsResetExpectedModalOpen(false);
        }
    };

    const handleAdjustBalance = async (balances: any) => {
        try {
            const response = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/dashboard/adjust-initial-balance`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${Cookies.get('org-pos-token')}`
                },
                body: JSON.stringify(balances)
            });

            if (response.ok) {
                toast({ variant: 'success', title: 'EXITO', description: 'FONDO DE CAJA AJUSTADO.' });
                setTimeout(() => window.location.reload(), 1000);
            } else {
                const err = await response.json();
                toast({ variant: 'destructive', title: 'ERROR', description: err.message || 'FALLO AL AJUSTAR FONDO' });
            }
        } catch (error) {
            toast({ variant: 'destructive', title: 'ERROR DE RED', description: 'FALLO EN LA COMUNICACION.' });
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="grid grid-cols-1 md:grid-cols-4 gap-4 w-full"
        >
            {/* FILA 1 */}
            <KpiCard
                label="Venta Real del Cierre"
                value={data.shiftVentaReal || 0}
                sub={
                    <div className="flex flex-col gap-1 mt-1">
                        <span className="text-[10px] text-gray-500 dark:text-zinc-400">{data.shiftSalesCount || 0} transacciones</span>
                        <div className="grid grid-cols-2 gap-x-2 gap-y-1 mt-1">
                            <div className="flex items-center gap-1">
                                <Coins size={10} className="text-zinc-900 dark:text-zinc-100" />
                                <span className="text-[8.5px] font-medium uppercase text-gray-500 dark:text-zinc-500 dark:text-zinc-400">EFE: <span className="text-zinc-900 dark:text-zinc-100">${formatCurrency(data.shiftSalesByMethod?.EFECTIVO || 0)}</span></span>
                            </div>
                            <div className="flex items-center gap-1">
                                <Smartphone size={10} className="text-purple-500" />
                                <span className="text-[8.5px] font-medium uppercase text-gray-500 dark:text-zinc-500 dark:text-zinc-400">NEQUI: <span className="text-zinc-900 dark:text-zinc-100">${formatCurrency(data.shiftSalesByMethod?.NEQUI || 0)}</span></span>
                            </div>
                            <div className="flex items-center gap-1">
                                <Smartphone size={10} className="text-rose-500" />
                                <span className="text-[8.5px] font-medium uppercase text-gray-500 dark:text-zinc-500 dark:text-zinc-400">DAVI: <span className="text-zinc-900 dark:text-zinc-100">${formatCurrency(data.shiftSalesByMethod?.DAVIPLATA || 0)}</span></span>
                            </div>
                            <div className="flex items-center gap-1">
                                <Wallet size={10} className="text-blue-500" />
                                <span className="text-[8.5px] font-medium uppercase text-gray-500 dark:text-zinc-500 dark:text-zinc-400">FIADOS: <span className="text-zinc-900 dark:text-zinc-100">${formatCurrency(data.shiftSalesByMethod?.FIADO || 0)}</span></span>
                            </div>
                        </div>
                    </div>
                }
                icon={TrendingUp}
                color="#10b981"
                isCurrency={true}

            />

            {/* Specialized Audit Card (Dinero Real) */}
            <KpiCard
                variant="audit"
                hideHeader={true}
                label="AUDITORIA DE CAJA"
                value={0}
                sub={
                                <div className="flex flex-col gap-0 w-full">
                                    <div className="p-6 pb-6 bg-gradient-to-br from-zinc-500/5 to-transparent flex flex-col items-start">
                                        <div className="flex items-center gap-1 mb-3">
                                            <span className="font-medium uppercase tracking-widest leading-none tracking-tight text-[11px] text-gray-500 dark:text-zinc-500">
                                                EFECTIVO REAL EN MANO (ACUMULADO)
                                            </span>
                                            <Tooltip content={
                                                <div className="p-2 max-w-[250px]">
                                                    <p className="text-[10px] font-bold text-gray-600 dark:text-zinc-300 mb-1 uppercase tracking-widest">Formula de Auditoria</p>
                                                    <p className="text-[10px] text-gray-500 dark:text-zinc-400">Efectivo Fisico + Ingresos Digitales - Egresos Pagados = Efectivo Real</p>
                                                </div>
                                            } placement="top" className="bg-gray-50 dark:bg-zinc-900 border border-black/5 dark:border-white/10">
                                                <Info size={12} className="text-gray-500 dark:text-zinc-500 cursor-help" />
                                            </Tooltip>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <span className="font-medium tracking-tight leading-none tracking-tighter tabular-nums truncate text-2xl sm:text-3xl lg:text-4xl text-zinc-900 dark:text-zinc-100">
                                                {formatCurrencyWithColor(Math.round(data.reportedBalance || 0))}
                                            </span>
                                        </div>
                                    </div>

                                    <div className="px-6 py-6 border-t border-zinc-200 dark:border-white/5 bg-[#18181b]">
                                        <div className="flex flex-col">
                                            <span className="text-[12px] text-zinc-100 font-bold uppercase tracking-widest mb-1">
                                                TOTAL GENERAL GUARDADO (CAJA + DIGITAL)
                                            </span>
                                            <span className="text-xl text-zinc-100 font-bold tracking-tight">
                                                ${formatCurrency(Math.round(data.totalLiquidity || 0))}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            }
                            icon={LineChart}
                            color="#3b82f6"
                            footer={
                                <>
                                    <div className="flex flex-col">
                                        <span className="text-[9px] text-gray-500 dark:text-zinc-500 font-medium tracking-tight uppercase tracking-widest leading-none">
                                            Billeteras Digitales (Total)
                                        </span>
                                            <div className="flex items-center gap-3 mt-1.5">
                                                <div className="flex items-center gap-1.5 bg-purple-500/10 px-2 py-0.5 rounded-2xl border border-purple-500/20">
                                                    <Smartphone size={10} className="text-purple-500" />
                                                    <span className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100">NEQUI: ${formatCurrency(data.realCashFlow?.nequi || 0)}</span>
                                                </div>
                                                <div className="flex items-center gap-1.5 bg-rose-500/10 px-2 py-0.5 rounded-2xl border border-rose-500/20">
                                                    <Smartphone size={10} className="text-rose-500" />
                                                    <span className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100">DAVIPLATA: ${formatCurrency(data.realCashFlow?.daviplata || 0)}</span>
                                                </div>
                                            </div>
                                    </div>
                                    <div className="flex flex-col items-end gap-1.5">
                                        <button 
                                            onClick={() => setIsAuditModalOpen(true)}
                                            className="h-8 px-3 bg-blue-500/10 hover:bg-blue-500/20 text-blue-500 border border-blue-500/30 rounded-2xl font-medium uppercase text-[8px] tracking-tight tracking-widest flex items-center gap-2 transition-all active:scale-95 shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-blue-500/10"
                                        >
                                            <PlusCircle size={10} /> Ajustar Fondo
                                        </button>
                                        <span className="text-[7px] text-zinc-600 font-bold uppercase tracking-widest">Protocolo de Auditoria Maestro</span>
                                    </div>
                                </>
                            }
                        />
                        {/* MODAL DE REINICIO DE SALDO ESPERADO */}
                        <Modal 
                            isOpen={isResetExpectedModalOpen} 
                            onOpenChange={setIsResetExpectedModalOpen}
                            backdrop="blur"
                            classNames={{
                                base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-[2.5rem]",
                            }}
                        >
                            <ModalContent>
                                {(onClose) => (
                                    <>
                                        <ModalHeader className="flex flex-col gap-1 p-8 pb-4">
                                            <div className="flex items-center gap-4">
                                                <div className="h-12 w-12 bg-amber-500/10 text-amber-500 rounded-2xl flex items-center justify-center border border-amber-500/20">
                                                    <RotateCcw size={24} />
                                                </div>
                                                <div className="flex flex-col">
                                                    <h3 className="font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight tracking-tighter text-xl">Reiniciar <span className="text-amber-500">Saldo Sistema</span></h3>
                                                    <p className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest tracking-tight">Punto de Partida Teorico</p>
                                                </div>
                                            </div>
                                        </ModalHeader>
                                        <ModalBody className="p-8 pt-2">
                                            <p className="text-sm font-medium text-gray-600 dark:text-zinc-400 tracking-tight leading-relaxed">
                                                ¿Estas seguro de que deseas reiniciar el saldo esperado del sistema? Esto ignorara todos los registros teoricos previos y comenzara a calcular la diferencia desde cero basandose en las nuevas operaciones.
                                                <br /><br />
                                                <span className="text-amber-600 dark:text-amber-500 font-medium uppercase text-[10px] tracking-widest">âš ï¸ Ideal para cuando terminas el montaje inicial de productos.</span>
                                            </p>
                                        </ModalBody>
                                        <ModalFooter className="p-6 bg-gray-50/50 dark:bg-white/[0.02] border-t border-gray-100 dark:border-white/5">
                                            <Button variant="light" onPress={onClose} className="font-medium uppercase text-[10px] tracking-widest">Cancelar</Button>
                                            <Button 
                                                color="warning" 
                                                onPress={handleResetExpectedBalance} 
                                                isLoading={isResettingExpected}
                                                className="bg-amber-500 text-white font-medium uppercase text-[10px] tracking-widest px-8 rounded-2xl"
                                            >
                                                Confirmar Reinicio
                                            </Button>
                                        </ModalFooter>
                                    </>
                                )}
                            </ModalContent>
                        </Modal>

            <AuditModal 
                isOpen={isAuditModalOpen} 
                onOpenChange={setIsAuditModalOpen} 
                onConfirm={handleAdjustBalance} 
            />

            <KpiCard
                label="UTILIDAD DEL MES"
                value={data.estimatedNetProfit || 0}
                sub="Ganancia real del mes (Ventas - Egresos)"
                icon={LineChart}
                color="#8b5cf6"
                isCurrency={true}
                topAction={
                    <button 
                        onClick={(e) => { e.stopPropagation(); setIsResetProfitModalOpen(true); }}
                        className="p-1.5 hover:bg-rose-500/10 rounded-2xl text-gray-500 dark:text-zinc-500 hover:text-rose-500 transition-all active:scale-90 group/btn"
                        title="Reiniciar Conteo de Utilidad"
                    >
                        <RotateCcw size={14} className="group-hover/btn:rotate-[-45deg] transition-transform" />
                    </button>
                }
            />

            {/* MODAL DE REINICIO DE UTILIDAD */}
            <Modal 
                isOpen={isResetProfitModalOpen} 
                onOpenChange={setIsResetProfitModalOpen}
                backdrop="blur"
                classNames={{
                    base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-[2.5rem]",
                }}
            >
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader className="flex flex-col gap-1 p-8 pb-4">
                                <div className="flex items-center gap-4">
                                    <div className="h-12 w-12 bg-rose-500/10 text-rose-500 rounded-2xl flex items-center justify-center border border-rose-500/20">
                                        <RotateCcw size={24} />
                                    </div>
                                    <div className="flex flex-col">
                                        <h3 className="font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight tracking-tighter text-xl">Reiniciar <span className="text-rose-500">Utilidad</span></h3>
                                        <p className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest tracking-tight">Punto de Partida Maestro</p>
                                    </div>
                                </div>
                            </ModalHeader>
                            <ModalBody className="p-8 pt-2">
                                <p className="text-sm font-medium text-gray-600 dark:text-zinc-400 tracking-tight leading-relaxed">
                                    ¿Estas seguro de que deseas reiniciar el conteo de utilidad? Esta accion establecera la fecha actual como el nuevo punto de inicio para el calculo de ganancias, ignorando datos previos.
                                    <br /><br />
                                    <span className="text-rose-500 font-medium uppercase text-[10px] tracking-widest">âš ï¸ Esta accion no se puede deshacer.</span>
                                </p>
                            </ModalBody>
                            <ModalFooter className="p-6 bg-gray-50/50 dark:bg-white/[0.02] border-t border-gray-100 dark:border-white/5">
                                <Button variant="light" onPress={onClose} className="font-medium uppercase text-[10px] tracking-widest">Cancelar</Button>
                                <Button 
                                    color="danger" 
                                    onPress={handleResetProfit} 
                                    isLoading={isResetting}
                                    className="bg-rose-500 text-white font-medium uppercase text-[10px] tracking-widest px-8 rounded-2xl"
                                >
                                    Confirmar Reinicio
                                </Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>

            {/* FILA 2 */}
            <KpiCard
                label="Egresos del Ultimo Cierre"
                value={typeof data.todayExpenses === 'object' ? (data.todayExpenses?.amount || 0) : (data.todayExpenses || 0)}
                sub={`${typeof data.todayExpenses === 'object' ? (data.todayExpenses?.count || 0) : 0} salidas pagadas`}
                icon={DollarSign}
                color="#f43f5e"
                isCurrency={true}

            />

            {/* Doble Inventario Card */}
            <KpiCard
                variant="audit"
                hideHeader={true}
                label="VALOR DEL INVENTARIO"
                value={data.inventoryCostValue || 0}
                isCurrency={true}
                color="#3b82f6"
                icon={Package}
                sub={
                    <div className="grid grid-cols-2 gap-8 items-center">
                        <div className="flex flex-col border-r border-zinc-200 dark:border-white/5 pr-4">
                            <span className="text-[10px] text-zinc-900 dark:text-zinc-100 font-medium tracking-tight uppercase leading-none mb-1">Capital Invertido</span>
                            <span className="text-[8px] text-gray-500 dark:text-zinc-500 font-bold uppercase mb-2">(Stock × Compra)</span>
                            <span className="text-lg sm:text-xl lg:text-2xl font-medium text-zinc-900 dark:text-zinc-100 tabular-nums tracking-tighter truncate">
                                ${formatCurrency(Math.round(data.inventoryCostValue || 0))}
                            </span>
                        </div>
                        <div className="flex flex-col pl-4">
                            <span className="text-[10px] text-purple-500 font-medium tracking-tight uppercase leading-none mb-1">Valor de Venta</span>
                            <span className="text-[8px] text-gray-500 dark:text-zinc-500 font-bold uppercase mb-2">(Stock × Venta)</span>
                            <span className="text-lg sm:text-xl lg:text-2xl font-medium text-zinc-900 dark:text-zinc-100 tabular-nums tracking-tighter truncate">
                                ${formatCurrency(Math.round(data.inventoryRetailValue || 0))}
                            </span>
                        </div>
                    </div>
                }
            />


            <KpiCard
                label="Cuentas por Pagar"
                value={data.pendingDebts?.amount ?? 0}
                sub={`${data.pendingDebts?.count ?? 0} registros pendientes`}
                icon={HandCoins}
                color="#f59e0b"
                isCurrency={true}
                onClick={onOpenDebts}
            />


        </motion.div>
    );
}


