"use client";

import React, { memo } from 'react';
import { ShieldCheck, ShieldAlert, UserCircle } from 'lucide-react';

interface StatsProps {
    total: number;
    admins: number;
    employees: number;
}

const UserStats = memo(({ total, admins, employees }: StatsProps) => {
    const statCards = [
        { label: "PERSONAL AUTORIZADO", val: total, color: "emerald", icon: ShieldCheck },
        { label: "ADMINISTRADORES", val: admins, color: "emerald", icon: ShieldAlert },
        { label: "EMPLEADOS DE TURNO", val: employees, color: "zinc", icon: UserCircle }
    ];

    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-1 shrink-0">
            {statCards.map((k, i) => (
                <div key={i} className="bg-white dark:bg-zinc-900 p-2 lg:p-3 border border-gray-200 dark:border-white/5 rounded-lg flex items-center justify-between shadow-sm transition-all hover:border-emerald-500/20">
                    <div className="flex flex-col">
                        <span className="text-[8px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-none mb-1 italic">
                            {k.label}
                        </span>
                        <span className={`text-sm lg:text-base font-black tabular-nums ${k.color === 'emerald' ? 'text-emerald-500' : 'text-gray-900 dark:text-white'} italic leading-tight tracking-tighter`}>
                            {k.val}
                        </span>
                    </div>
                    <k.icon size={16} className={`${k.color === 'emerald' ? 'text-emerald-500' : 'text-gray-400 dark:text-zinc-600'} opacity-20`} />
                </div>
            ))}
        </div>
    );
});

UserStats.displayName = 'UserStats';

export default UserStats;
