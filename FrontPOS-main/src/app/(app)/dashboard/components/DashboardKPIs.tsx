"use client";

import { 
    ShoppingCart, Wallet, CreditCard, ArrowDownRight, HandCoins, ChevronRight, TrendingUp, DollarSign,
    PlusCircle, MinusCircle, Smartphone, Coins, Info, LineChart, Package, Landmark
} from "lucide-react";
import { formatCurrency } from "@/lib/utils";

import { Chip } from "@heroui/react";
import React from 'react';
import AuditModal from "./AuditModal";
import Cookies from 'js-cookie';



const formatCurrencyWithColor = (value: number, label?: string) => {
    const formatted = formatCurrency(value);
    const isNegative = value < 0;
    
    // Nueva lógica: si el valor es negativo en balance, es un FALTANTE/EGRESO (rojo o neutro)
    // Pero aquí solo formateamos.
    if (isNegative) {
        return (
            <span className="text-rose-500 font-bold">
                -${formatCurrency(Math.abs(value))}
            </span>
        );
    }
    
    return (
        <span className="text-emerald-500 font-bold">
            ${formatted}
        </span>
    );
};

function KpiCard({ 
    label, value, sub, icon: Icon, color, onClick, isCurrency = false, chartData, subColor, badge, variant = "default", footer, hideHeader = false
}: {
    label: string; value: string | number | React.ReactNode; sub: React.ReactNode; icon: any; color: string; onClick?: () => void; isCurrency?: boolean; chartData?: any[]; subColor?: string; badge?: React.ReactNode; variant?: "default" | "audit"; footer?: React.ReactNode; hideHeader?: boolean;
}) {
    const isAudit = variant === "audit";

    return (
        <div 
            onClick={onClick}
            className={`relative group flex-1 bg-white/80 dark:bg-zinc-900/50 backdrop-blur-xl border border-gray-200 dark:border-white/5 rounded-2xl shadow-xl overflow-hidden transition-all hover:scale-[1.01] ${onClick ? 'cursor-pointer active:scale-95' : ''} ${isAudit ? 'md:col-span-2' : ''}`}
        >


            <div className={`relative z-10 h-full flex flex-col ${isAudit ? 'p-0' : 'p-5'}`}>
                {/* Header Section */}
                {!hideHeader && (
                    <div className={`${isAudit ? 'p-6 pb-4 bg-gradient-to-br from-zinc-500/5 to-transparent' : 'mb-4'} flex justify-between items-start`}>
                        {!isAudit && (
                            <div className={`p-2.5 rounded-xl bg-opacity-10 shadow-inner shrink-0`} style={{ backgroundColor: `${color}20`, color: color }}>
                                <Icon size={20} />
                            </div>
                        )}
                        
                        <div className={`flex flex-col ${isAudit ? 'items-start w-full' : 'items-end overflow-hidden'}`}>
                            <span className={`font-black uppercase tracking-widest leading-none mb-2 italic ${isAudit ? 'text-[11px] text-zinc-500' : 'text-[10px] text-gray-500 dark:text-zinc-400 truncate w-full'}`}>
                                {label}
                            </span>
                            
                            <div className={`flex items-center gap-3 ${isAudit ? 'w-full justify-between' : ''}`}>
                                <span className={`font-black italic leading-none tracking-tighter tabular-nums truncate pr-1 ${isAudit ? 'text-2xl sm:text-3xl lg:text-4xl text-white' : 'text-lg sm:text-xl lg:text-2xl text-gray-900 dark:text-white'}`}>
                                    {isCurrency && typeof value === 'number' ? formatCurrencyWithColor(Math.round(value)) : value}
                                </span>
                                {!isAudit && badge && <div>{badge}</div>}
                            </div>
                        </div>
                    </div>
                )}

                {/* Sub/Breakdown Content */}
                <div className={`${isAudit ? (hideHeader ? 'h-full flex items-center px-6 py-8' : 'px-6 py-4 border-y border-white/5 bg-zinc-800/30') : 'mt-auto'}`}>
                    <div className={`${isAudit ? 'w-full' : 'text-[10px] font-bold uppercase tracking-wider'}`}>
                        <div className="break-words" style={{ color: subColor || undefined }}>{sub}</div>
                        {onClick && !isAudit && (
                            <div className="text-[8px] font-black text-rose-500 flex items-center gap-1 mt-2 animate-pulse justify-end">
                                VER DETALLES <ChevronRight size={10} />
                            </div>
                        )}
                    </div>
                </div>

                {/* Audit Footer */}
                {isAudit && footer && (
                    <div className="mt-auto p-4 bg-zinc-950/50 flex justify-between items-center border-t border-white/10">
                        {footer}
                    </div>
                )}
            </div>
        </div>
    );
}

interface DashboardKPIsProps {
    data: any;
    onOpenDebts?: () => void;
}

export default function DashboardKPIs({ data, onOpenDebts }: DashboardKPIsProps) {
    if (!data) return null;

    return (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 w-full">
            {/* FILA 1 */}
            <KpiCard
                label="Ventas del Último Cierre"
                value={data.shiftSalesAmount || 0}
                sub={
                    <div className="flex flex-col gap-1 mt-1">
                        <span className="text-[10px] text-gray-500 dark:text-zinc-400">{data.shiftSalesCount || 0} transacciones</span>
                        <div className="grid grid-cols-2 gap-x-2 gap-y-1 mt-1">
                            <div className="flex items-center gap-1">
                                <Coins size={10} className="text-emerald-500" />
                                <span className="text-[8.5px] font-black uppercase text-zinc-400">EFE: <span className="text-white">${formatCurrency(data.shiftSalesByMethod?.EFECTIVO || 0)}</span></span>
                            </div>
                            <div className="flex items-center gap-1">
                                <Smartphone size={10} className="text-purple-500" />
                                <span className="text-[8.5px] font-black uppercase text-zinc-400">NEQUI: <span className="text-white">${formatCurrency(data.shiftSalesByMethod?.NEQUI || 0)}</span></span>
                            </div>
                            <div className="flex items-center gap-1">
                                <Smartphone size={10} className="text-rose-500" />
                                <span className="text-[8.5px] font-black uppercase text-zinc-400">DAVI: <span className="text-white">${formatCurrency(data.shiftSalesByMethod?.DAVIPLATA || 0)}</span></span>
                            </div>
                            <div className="flex items-center gap-1">
                                <Wallet size={10} className="text-blue-500" />
                                <span className="text-[8.5px] font-black uppercase text-zinc-400">FIADOS: <span className="text-white">${formatCurrency(data.shiftSalesByMethod?.FIADO || 0)}</span></span>
                            </div>
                        </div>
                    </div>
                }
                icon={TrendingUp}
                color="#10b981"
                isCurrency={true}

            />

            {/* Specialized Audit Card (Dinero Real) */}
            {(() => {
                const netReportedBalance = (data.reportedBalance || 0);
                const [isAuditModalOpen, setIsAuditModalOpen] = React.useState(false);

                const handleAdjustBalance = async (balances: any) => {
                    try {
                        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/dashboard/adjust-initial-balance`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${Cookies.get('org-pos-token')}`
                            },
                            body: JSON.stringify(balances)
                        });

                        if (response.ok) {
                            window.location.reload();
                        } else {
                            const err = await response.json();
                            alert("❌ Error al ajustar saldo: " + (err.message || "Error desconocido"));
                        }
                    } catch (error) {
                        alert("❌ Error de conexión al servidor.");
                    }
                };

                return (
                    <>
                        <KpiCard
                            variant="audit"
                            hideHeader={true}
                            label="AUDITORIA DE CAJA"
                            value={0}
                            sub={
                                <div className="flex flex-col gap-0 w-full">
                                    {/* CABECERA DINÁMICA DE 2 COLUMNAS */}
                                    <div className="p-6 pb-6 bg-gradient-to-br from-zinc-500/5 to-transparent grid grid-cols-2 gap-8 items-start">
                                        <div className="flex flex-col items-start border-r border-white/5 pr-4">
                                            <span className="font-black uppercase tracking-widest leading-none mb-3 italic text-[11px] text-zinc-500">
                                                EFECTIVO REAL EN MANO (ACUMULADO)
                                            </span>
                                            <div className="flex items-center gap-3">
                                                <span className="font-black italic leading-none tracking-tighter tabular-nums truncate text-2xl sm:text-3xl lg:text-4xl text-white">
                                                    {formatCurrencyWithColor(Math.round(data.globalHistoricalReal || 0))}
                                                </span>
                                            </div>
                                            <span className="text-[9px] text-zinc-600 font-bold italic mt-2 uppercase tracking-tight">Suma de cierres - Egresos de Fondo</span>
                                        </div>

                                        <div className="flex flex-col items-end pl-4">
                                            <span className="font-black uppercase tracking-widest leading-none mb-3 italic text-[11px] text-zinc-500 text-right">
                                                SALDO ESPERADO TOTAL (SISTEMA)
                                            </span>
                                            <div className="flex items-center gap-3 justify-end">
                                                <span className="font-black italic leading-none tracking-tighter tabular-nums truncate text-2xl sm:text-3xl lg:text-4xl text-white">
                                                    {formatCurrencyWithColor(Math.round(data.globalHistoricalExpected || 0))}
                                                </span>
                                            </div>
                                            <span className="text-[9px] text-zinc-600 font-bold italic mt-2 uppercase tracking-tight text-right">Cálculo teórico histórico total</span>
                                        </div>
                                    </div>

                                    {/* SECCIÓN INFERIOR DE DETALLES DEL TURNO */}
                                    <div className="px-6 py-6 border-t border-white/5 bg-zinc-900/20">
                                        <div className="flex flex-col">
                                            <span className="text-[8px] text-zinc-500 font-bold uppercase tracking-widest mb-1">Diferencia Global</span>
                                            <span className={`text-sm font-black italic ${(data.globalDifference >= 0) ? 'text-emerald-500' : 'text-rose-500'}`}>
                                                ${formatCurrency(Math.abs(Math.round(data.globalDifference || 0)))} 
                                                {(data.globalDifference >= 0) ? ' (SOBRANTE)' : ' (FALTANTE)'}
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
                                        <span className="text-[9px] text-zinc-500 font-black italic uppercase tracking-widest leading-none">
                                            Billeteras Digitales (Total)
                                        </span>
                                            <div className="flex items-center gap-3 mt-1.5">
                                                <div className="flex items-center gap-1.5 bg-purple-500/10 px-2 py-0.5 rounded-lg border border-purple-500/20">
                                                    <Smartphone size={10} className="text-purple-500" />
                                                    <span className="text-[10px] font-black text-white">NEQUI: ${formatCurrency(data.realCashFlow?.nequi || 0)}</span>
                                                </div>
                                                <div className="flex items-center gap-1.5 bg-rose-500/10 px-2 py-0.5 rounded-lg border border-rose-500/20">
                                                    <Smartphone size={10} className="text-rose-500" />
                                                    <span className="text-[10px] font-black text-white">DAVIPLATA: ${formatCurrency(data.realCashFlow?.daviplata || 0)}</span>
                                                </div>
                                            </div>
                                    </div>
                                    <div className="flex flex-col items-end gap-1.5">
                                        <button 
                                            onClick={() => setIsAuditModalOpen(true)}
                                            className="h-8 px-3 bg-blue-500/10 hover:bg-blue-500/20 text-blue-500 border border-blue-500/30 rounded-lg font-black uppercase text-[8px] italic tracking-widest flex items-center gap-2 transition-all active:scale-95 shadow-lg shadow-blue-500/10"
                                        >
                                            <PlusCircle size={10} /> Ajustar Fondo
                                        </button>
                                        <span className="text-[7px] text-zinc-600 font-bold uppercase tracking-widest">Protocolo de Auditoría Maestro</span>
                                    </div>
                                </>
                            }
                        />
                        <AuditModal 
                            isOpen={isAuditModalOpen} 
                            onOpenChange={setIsAuditModalOpen} 
                            onConfirm={handleAdjustBalance} 
                        />
                    </>
                );
            })()}

            <KpiCard
                label="UTILIDAD DEL MES"
                value={data.estimatedNetProfit || 0}
                sub="Ganancia real del mes (Ventas - Costos - Gastos)"
                icon={LineChart}
                color="#8b5cf6"
                isCurrency={true}

            />

            {/* FILA 2 */}
            <KpiCard
                label="Egresos del Último Cierre"
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
                        <div className="flex flex-col border-r border-white/5 pr-4">
                            <span className="text-[10px] text-emerald-500 font-black italic uppercase leading-none mb-1">Capital Invertido</span>
                            <span className="text-[8px] text-zinc-500 font-bold uppercase mb-2">(Stock × Compra)</span>
                            <span className="text-lg sm:text-xl lg:text-2xl font-black text-white tabular-nums tracking-tighter truncate">
                                ${formatCurrency(Math.round(data.inventoryCostValue || 0))}
                            </span>
                        </div>
                        <div className="flex flex-col pl-4">
                            <span className="text-[10px] text-purple-500 font-black italic uppercase leading-none mb-1">Valor de Venta</span>
                            <span className="text-[8px] text-zinc-500 font-bold uppercase mb-2">(Stock × Venta)</span>
                            <span className="text-lg sm:text-xl lg:text-2xl font-black text-white tabular-nums tracking-tighter truncate">
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

            {/* Tarjeta de relleno para completar 4 cols o informativa */}
            <div className="hidden md:flex flex-col justify-center p-6 bg-emerald-500/5 rounded-2xl border border-emerald-500/10 border-dashed">
                <div className="flex items-center gap-2 mb-2">
                    <TrendingUp size={16} className="text-emerald-500" />
                    <span className="text-[10px] font-black text-emerald-500 uppercase tracking-widest italic">Análisis de Turno</span>
                </div>
                <p className="text-[11px] text-zinc-500 leading-relaxed font-bold italic">
                    "El éxito no es solo vender, es saber cuánto dinero tienes realmente en la mano."
                </p>
            </div>
        </div>
    );
}
