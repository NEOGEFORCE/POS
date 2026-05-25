"use client";

import { memo } from "react";
import { PackageSearch, Clock, CheckCircle2, User } from "lucide-react";
import { Button, Tooltip, Chip } from "@heroui/react";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-error";
import { formatTime } from "@/lib/utils";
import Cookies from "js-cookie";

interface MissingItem {
    id: number;
    product_name: string;
    status: string;
    note: string;
    reporter?: { name: string };
    created_at: string;
}

interface MissingItemsListProps {
    items: MissingItem[];
    onRefresh: () => void;
}

const MissingItemsList = memo(({ items, onRefresh }: MissingItemsListProps) => {
    const { toast } = useToast();

    const handleUpdateStatus = async (id: number, status: string) => {
        const token = Cookies.get("org-pos-token");
        try {
            await apiFetch("/admin/missing-items/status", {
                method: "PUT",
                body: JSON.stringify({ id, status }),
                fallbackError: "FALLO AL ACTUALIZAR ESTADO"
            }, token);
            
            toast({
                title: "ESTADO ACTUALIZADO",
                description: `EL PRODUCTO HA SIDO MARCADO COMO ${status}`,
                variant: "success",
            });
            onRefresh();
        } catch (error: any) {
            toast({
                title: "ERROR AL ACTUALIZAR",
                description: error.message || "NO SE PUDO CAMBIAR EL ESTADO DEL REPORTE.",
                variant: "destructive",
            });
        }
    };

    return (
        <div className="card-base border-none rounded-[2rem] p-8 shadow-[0_8px_30px_rgb(0,0,0,0.12)] h-full flex flex-col">
            <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-4">
                    <div className="h-12 w-12 bg-rose-500/10 text-rose-500 flex items-center justify-center rounded-2xl shadow-inner">
                        <PackageSearch size={24} />
                    </div>
                    <div>
                        <h3 className="text-lg font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight tracking-tighter leading-none">
                            Control <span className="text-rose-500">Faltantes</span>
                        </h3>
                        <p className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest mt-1.5 leading-none">
                            Productos agotados reportados
                        </p>
                    </div>
                </div>
                <Chip 
                    variant="flat" 
                    color="danger" 
                    className="h-6 font-medium text-[9px] uppercase tracking-widest px-3 border-none bg-rose-50 dark:bg-rose-500/10 text-rose-500"
                >
                    {items?.length || 0} PENDIENTES
                </Chip>
            </div>

            <div className="space-y-4 flex-1 overflow-hidden custom-scrollbar pr-2">
                {(!items || items.length === 0) ? (
                    <div className="h-full flex flex-col items-center justify-center text-center py-10 opacity-50">
                        <CheckCircle2 size={40} className="mb-4 text-zinc-900 dark:text-zinc-100 opacity-20" />
                        <p className="text-[10px] font-medium text-gray-400 uppercase tracking-[0.2em]">Todo bajo control</p>
                        <p className="text-[9px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-widest mt-1">No hay reportes de faltantes</p>
                    </div>
                ) : (
                    items.slice(0, 4).map((item) => (
                        <div 
                            key={item.id} 
                            className="p-5 bg-gray-50/50 dark:bg-zinc-800/30 border border-gray-100 dark:border-white/5 rounded-2xl hover:border-rose-500/30 transition-all group"
                        >
                            <div className="flex justify-between items-start gap-4">
                                <div className="flex-1 min-w-0">
                                    <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-50 uppercase truncate tracking-tight mb-1">
                                        {item.product_name}
                                    </h4>
                                    <div className="flex flex-wrap gap-3">
                                        <div className="flex items-center gap-1.5 text-[9px] font-medium text-zinc-500 dark:text-zinc-400 uppercase">
                                            <User size={10} className="text-rose-500" />
                                            {item.reporter?.name || "SISTEMA"}
                                        </div>
                                        <div className="flex items-center gap-1.5 text-[9px] font-medium text-zinc-500 dark:text-zinc-400 uppercase">
                                            <Clock size={10} className="text-rose-500" />
                                            {formatTime(item.created_at)}
                                        </div>
                                    </div>
                                    {item.note && (
                                        <p className="mt-3 text-[10px] leading-relaxed text-gray-500 dark:text-zinc-400 font-medium tracking-tight p-2 card-base border-none rounded-2xl border border-gray-100 dark:border-white/5">
                                            "{item.note}"
                                        </p>
                                    )}
                                </div>
                                <Tooltip 
                                    content="Marcar como ADQUIRIDO" 
                                    placement="left" 
                                    classNames={{ content: "font-bold text-[8px] uppercase tracking-wider bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-zinc-900 dark:text-zinc-100 py-0.5 px-2 shadow-[0_8px_30px_rgb(0,0,0,0.12)]" }}
                                >
                                    <Button
                                        isIconOnly
                                        size="sm"
                                        onPress={() => handleUpdateStatus(item.id, "ADQUIRIDO")}
                                        className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-zinc-900 dark:text-zinc-100 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:scale-110 active:scale-90 transition-all shrink-0"
                                    >
                                        <CheckCircle2 size={16} />
                                    </Button>
                                </Tooltip>
                            </div>
                        </div>
                    ))
                )}
            </div>

            <div className="mt-6">
                <Button
                    fullWidth
                    variant="light"
                    className="h-10 text-[9px] font-medium uppercase tracking-widest text-zinc-500 dark:text-zinc-400 tracking-tight hover:text-rose-500 transition-all"
                >
                    Ver todo el historial
                </Button>
            </div>
        </div>
    );
});

MissingItemsList.displayName = "MissingItemsList";
export default MissingItemsList;
