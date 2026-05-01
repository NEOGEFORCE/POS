"use client";

import { 
    ShoppingCart, Wallet, CreditCard, ArrowDownRight, HandCoins, ChevronRight, TrendingUp, DollarSign,
    PlusCircle, MinusCircle, Smartphone, Coins, Info, LineChart, Package
} from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { AreaChart, Area, ResponsiveContainer } from 'recharts';
import { Chip } from "@heroui/react";
import React from 'react';

const dummyData = [
    { pv: 4200 }, { pv: 7398 }, { pv: 2800 }, { pv: 5908 }, { pv: 1800 }, { pv: 6800 }, { pv: 3300 },
];

const formatCurrencyWithColor = (value: number) => {
    const formatted = formatCurrency(Math.abs(value));
    const isNegative = value < 0;
    return (
        <span className={isNegative ? "text-rose-500 font-bold" : ""}>
            {isNegative ? "-" : ""}${formatted}
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
            {/* Background Sparkline - Hidden if audit or low opacity */}
            {chartData && !isAudit && (
                <div className="absolute inset-x-0 bottom-0 h-10 opacity-10 pointer-events-none">
                    <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData}>
                            <Area 
                                type="monotone" 
                                dataKey="pv" 
                                stroke={color} 
                                fillOpacity={0.1} 
                                fill={color} 
                                strokeWidth={2}
                            />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>
            )}

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
                label="Ventas del Día"
                value={data.todaySalesAmount || 0}
                sub={`${data.todaySalesCount || 0} transacciones`}
                icon={TrendingUp}
                color="#10b981"
                isCurrency={true}
                chartData={dummyData}
            />

            {/* Specialized Audit Card (Dinero Real) */}
            {(() => {
                const globalExpenses = data.totalExpensesPaid ?? data.total_expenses_paid ?? 0;
                const netReportedBalance = (data.reportedBalance || 0) - globalExpenses;

                const handleAdjustBalance = async () => {
                    const realBalanceStr = window.prompt("Introduce el SALDO REAL ACTUAL (Efectivo + Bancos) para resetear la auditoría a $0:");
                    if (realBalanceStr === null) return;
                    
                    const realBalance = parseFloat(realBalanceStr);
                    if (isNaN(realBalance)) {
                        alert("Por favor, introduce un número válido.");
                        return;
                    }

                    if (!window.confirm(`¿Estás seguro de que quieres ajustar el saldo inicial a $${formatCurrency(realBalance)}? Esto reseteará la diferencia a $0 hoy.`)) {
                        return;
                    }

                    try {
                        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/dashboard/adjust-initial-balance`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${localStorage.getItem('token')}`
                            },
                            body: JSON.stringify({ realBalance })
                        });

                        if (response.ok) {
                            alert("✅ Saldo inicial ajustado con éxito. El dashboard se actualizará.");
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
                    <KpiCard
                        variant="audit"
                        label="DINERO REAL EN MANO (CIERRES)"
                        value={netReportedBalance}
                        isCurrency={true}
                        sub={
                            <div className="flex flex-row justify-between items-center gap-6">
                                <div className="flex items-center gap-2">
                                    <Smartphone size={14} className={data.realCashFlow?.nequi < 0 ? "text-rose-500 animate-pulse" : "text-purple-500"} />
                                    <div className="flex flex-col">
                                        <span className="text-[8px] text-zinc-500 font-bold">NEQUI</span>
                                        <span className={`text-[12px] font-black tabular-nums ${data.realCashFlow?.nequi < 0 ? "text-rose-500" : "text-purple-400"}`}>
                                            {formatCurrencyWithColor(data.realCashFlow?.nequi || 0)}
                                        </span>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Smartphone size={14} className={data.realCashFlow?.daviplata < 0 ? "text-rose-500 animate-pulse" : "text-rose-500"} />
                                    <div className="flex flex-col">
                                        <span className="text-[8px] text-zinc-500 font-bold">DAVIPLATA</span>
                                        <span className={`text-[12px] font-black tabular-nums ${data.realCashFlow?.daviplata < 0 ? "text-rose-500" : "text-rose-400"}`}>
                                            {formatCurrencyWithColor(data.realCashFlow?.daviplata || 0)}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        }
                        icon={Wallet}
                        color="#10b981"
                        footer={
                            <>
                                <div className="flex flex-col">
                                    <span className="text-[9px] text-zinc-500 font-black italic">SALDO ESPERADO (SISTEMA)</span>
                                    <span className="text-lg font-black text-white italic tracking-tighter">
                                        ${formatCurrency(Math.round(data.systemBalance || 0))}
                                    </span>
                                    <button 
                                        onClick={handleAdjustBalance}
                                        className="text-[7.5px] xs:text-[8px] sm:text-[9px] text-emerald-500 hover:text-emerald-400 font-black uppercase mt-1 text-left flex items-center gap-1 transition-colors whitespace-nowrap"
                                    >
                                        <PlusCircle size={8} className="shrink-0" /> Ajustar Saldo Inicial
                                    </button>
                                </div>
                                {(data.globalDifference || 0) !== 0 && (
                                    <div className={`
                                        relative flex items-center gap-2 px-4 py-2 rounded-xl border-2 font-black italic text-xs uppercase
                                        ${data.globalDifference > 0 
                                            ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.3)]' 
                                            : 'border-rose-500/50 bg-rose-500/10 text-rose-400 shadow-[0_0_15px_rgba(244,63,94,0.3)]'}
                                    `}>
                                        {data.globalDifference > 0 ? <PlusCircle size={14} /> : <MinusCircle size={14} />}
                                        {data.globalDifference > 0 ? 'Sobrante' : 'Faltante'}: ${formatCurrency(Math.abs(Math.round(data.globalDifference || 0)))}
                                    </div>
                                )}
                            </>
                        }
                    />
                );
            })()}

            <KpiCard
                label="GANANCIAS (ESTE MES)"
                value={data.estimatedNetProfit || 0}
                sub="Utilidad real (Ventas - Costos - Gastos)"
                icon={LineChart}
                color="#8b5cf6"
                isCurrency={true}
                chartData={dummyData}
            />

            {/* FILA 2 */}
            <KpiCard
                label="Egresos de Hoy"
                value={typeof data.todayExpenses === 'object' ? (data.todayExpenses?.amount || 0) : (data.todayExpenses || 0)}
                sub={`${typeof data.todayExpenses === 'object' ? (data.todayExpenses?.count || 0) : 0} salidas pagadas`}
                icon={DollarSign}
                color="#f43f5e"
                isCurrency={true}
                chartData={dummyData}
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
                chartData={(data.pendingDebts?.amount ?? 0) > 0 ? dummyData : undefined}
                onClick={onOpenDebts}
            />
        </div>
    );
}
