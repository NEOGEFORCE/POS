"use client";

import { memo } from "react";
import { TrendingUp, Award, Box } from "lucide-react";
import { Tooltip } from "@heroui/react";

interface ProductRankingItem {
    barcode: string;
    name: string;
    quantity: number;
    total: number;
}

interface RankingListProps {
    products: ProductRankingItem[];
}

const RankingList = memo(({ products }: RankingListProps) => {
    // Calcular el maximo para normalizar las barras de progreso
    const maxQty = products?.length > 0 ? Math.max(...products.map(p => p.quantity)) : 0;

    return (
        <div className="card-base border-none rounded-[2rem] p-8 shadow-[0_8px_30px_rgb(0,0,0,0.12)] h-full flex flex-col overflow-x-hidden">
            <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-4">
                    <div className="h-12 w-12 bg-amber-500/10 text-amber-500 flex items-center justify-center rounded-2xl shadow-inner">
                        <TrendingUp size={24} />
                    </div>
                    <div>
                        <h3 className="text-lg font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight tracking-tighter leading-none">
                            Top <span className="text-amber-500">Ventas</span>
                        </h3>
                        <p className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest mt-1.5 leading-none">
                            Productos con mayor rotacion
                        </p>
                    </div>
                </div>
                <div className="h-8 w-8 bg-gray-50 dark:bg-[#18181b] flex items-center justify-center rounded-2xl text-gray-400">
                    <Award size={16} />
                </div>
            </div>

            <div className="space-y-6 flex-1 overflow-hidden custom-scrollbar pr-2">
                {(!products || products.length === 0) ? (
                    <div className="h-full flex flex-col items-center justify-center text-center py-10 opacity-50">
                        <Box size={40} className="mb-4 text-gray-300 dark:text-zinc-700" />
                        <p className="text-[10px] font-medium text-gray-400 uppercase tracking-[0.2em]">Sin datos de ventas este mes</p>
                    </div>
                ) : (
                    products.slice(0, 10).map((p, index) => {
                        const percentage = maxQty > 0 ? (p.quantity / maxQty) * 100 : 0;
                        const rankColors = [
                            "from-amber-400 to-amber-600 shadow-amber-500/20",
                            "from-emerald-400 to-emerald-600 ",
                            "from-blue-400 to-blue-600 shadow-blue-500/20",
                            "from-gray-400 to-gray-600 shadow-gray-500/20",
                            "from-zinc-400 to-zinc-600 shadow-zinc-500/20",
                        ];

                        return (
                            <div key={p.barcode} className="group flex flex-col gap-2">
                                <div className="flex justify-between items-end">
                                    <div className="flex flex-col max-w-[70%]">
                                        <span className="text-[9px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest mb-1 leading-none tracking-tight">
                                            #{index + 1} {p.barcode}
                                        </span>
                                        <span className="text-xs font-medium text-gray-800 dark:text-zinc-900 dark:text-zinc-100 uppercase truncate tracking-tight">
                                            {p.name}
                                        </span>
                                    </div>
                                    <div className="text-right">
                                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 tracking-tight leading-none block">
                                            {p.quantity.toLocaleString()}
                                        </span>
                                        <span className="text-[9px] font-medium text-gray-400 uppercase tracking-widest leading-none">
                                            Unidades
                                        </span>
                                    </div>
                                </div>
                                <Tooltip
                                    content={`Total: ${p.total.toLocaleString()} COP`}
                                    placement="top"
                                    classNames={{ content: "font-bold text-[8px] uppercase tracking-wider bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-zinc-900 dark:text-zinc-100 py-0.5 px-2 shadow-[0_8px_30px_rgb(0,0,0,0.12)]" }}
                                >
                                    <div className="relative w-full h-1.5 bg-gray-100 dark:bg-zinc-800 rounded-2xl overflow-hidden shadow-inner">
                                        <div
                                            className={`absolute left-0 top-0 h-full rounded-2xl bg-gradient-to-r ${rankColors[index] || "from-gray-500 to-gray-700"} transition-all duration-1000 ease-out shadow-[0_8px_30px_rgb(0,0,0,0.12)]`}
                                            style={{ width: `${percentage}%` }}
                                        />
                                    </div>
                                </Tooltip>
                            </div>
                        );
                    })
                )}
            </div>

            <div className="mt-6 pt-6 border-t border-gray-100 dark:border-white/5">
                <p className="text-[9px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.2em] tracking-tight text-center">
                    Calculo basado en movimientos de los ultimos 30 dias
                </p>
            </div>
        </div>
    );
});

RankingList.displayName = "RankingList";
export default RankingList;
