"use client";

import { FileText, Calendar, LayoutGrid } from "lucide-react";
import React from 'react';
import Link from 'next/link';
import { Button } from "@heroui/react";

interface ReportButtonsProps {
    onOpenRange: () => void;
}

export default function ReportButtons({ onOpenRange }: ReportButtonsProps) {
    return (
        <div className="bg-white dark:bg-zinc-900/40 backdrop-blur-xl border border-gray-200 dark:border-white/5 rounded-3xl p-4 md:p-6 shadow-sm transition-all duration-500 animate-in fade-in slide-in-from-bottom-4">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                    <div className="p-3 rounded-2xl bg-emerald-500 text-white shadow-lg shadow-emerald-500/20">
                        <FileText size={20} />
                    </div>
                    <div>
                        <h2 className="text-sm font-black text-gray-900 dark:text-white uppercase tracking-tight">Centro de Control</h2>
                        <p className="text-[9px] font-black text-emerald-600 dark:text-emerald-500 uppercase tracking-widest">Auditoría & Análisis</p>
                    </div>
                </div>

                <div className="flex items-center gap-2 w-full sm:w-auto">
                    <Button
                        as={Link}
                        href="/reports"
                        variant="flat"
                        startContent={<LayoutGrid size={16} />}
                        className="bg-gray-100 dark:bg-white/5 text-gray-700 dark:text-white font-bold uppercase tracking-widest text-[10px] rounded-xl hover:bg-emerald-500 hover:text-white dark:hover:bg-emerald-500 dark:hover:text-black transition-all h-12 flex-1 sm:flex-none px-6"
                    >
                        Vista Supervisor
                    </Button>
                    
                    <Button
                        onPress={onOpenRange}
                        variant="flat"
                        startContent={<Calendar size={16} />}
                        className="bg-gray-100 dark:bg-white/5 text-gray-700 dark:text-white font-bold uppercase tracking-widest text-[10px] rounded-xl hover:bg-emerald-500 hover:text-white dark:hover:bg-emerald-500 dark:hover:text-black transition-all h-12 flex-1 sm:flex-none px-6"
                    >
                        Rango de Fecha
                    </Button>
                </div>
            </div>
        </div>
    );
}
