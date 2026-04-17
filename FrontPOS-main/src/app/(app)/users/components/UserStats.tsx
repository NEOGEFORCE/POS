"use client";
import React, { memo, useMemo } from 'react';
import { ShieldCheck, ShieldAlert, UserCircle, Users, Activity } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area } from 'recharts';
import { Progress } from "@heroui/react";

interface StatsProps {
    total: number;
    admins: number;
    employees: number;
}

const AnalyticalUserCard = ({ 
    label, 
    value, 
    subValue, 
    icon: Icon, 
    color, 
    chartData, 
    progress 
}: { 
    label: string, 
    value: number, 
    subValue: string, 
    icon: any, 
    color: string, 
    chartData?: any[],
    progress?: number
}) => (
    <div className="relative group min-w-[200px] md:min-w-0 bg-white/80 dark:bg-zinc-900/50 backdrop-blur-xl p-5 border border-gray-200 dark:border-white/5 rounded-[2rem] shadow-xl overflow-hidden shadow-emerald-500/5 transition-all hover:scale-[1.02] hover:border-emerald-500/20">
        {/* Background Sparkline */}
        {chartData && (
            <div className="absolute inset-x-0 bottom-0 h-16 opacity-30 dark:opacity-20 pointer-events-none">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData}>
                        <defs>
                            <linearGradient id={`color-${color}`} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={color} stopOpacity={0.8}/>
                                <stop offset="95%" stopColor={color} stopOpacity={0}/>
                            </linearGradient>
                        </defs>
                        <Area 
                            type="monotone" 
                            dataKey="val" 
                            stroke={color} 
                            fillOpacity={1} 
                            fill={`url(#color-${color})`} 
                            strokeWidth={2}
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        )}

        <div className="relative z-10">
            <div className="flex justify-between items-start mb-4">
                <div className={`p-3 rounded-2xl bg-${color}-500/10 text-${color}-500 shadow-inner`}>
                    <Icon size={20} />
                </div>
                <div className="text-right">
                    <span className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-none italic block mb-1">
                        {label}
                    </span>
                    <span className="text-2xl font-black text-gray-900 dark:text-white italic leading-none tracking-tighter tabular-nums">
                        {value}
                    </span>
                </div>
            </div>

            <div className="flex flex-col gap-2">
                <div className="flex justify-between items-center text-[9px] font-black uppercase tracking-wider">
                    <span className="text-gray-400 dark:text-zinc-500">{subValue}</span>
                    {progress !== undefined && <span style={{ color: color }}>{progress}%</span>}
                </div>
                {progress !== undefined && (
                    <div className="h-1 w-full bg-gray-100 dark:bg-white/5 rounded-full overflow-hidden shadow-inner">
                        <div 
                            className="h-full rounded-full transition-all duration-1000 ease-out"
                            style={{ width: `${progress}%`, backgroundColor: color }}
                        />
                    </div>
                )}
            </div>
        </div>
    </div>
);

const UserStats = memo(({ total, admins, employees }: StatsProps) => {
    // Datos simulados para tendencias (ya que la API no los provee aún)
    const trends = useMemo(() => [
        { val: 2 }, { val: 4 }, { val: 3 }, { val: 7 }, { val: 5 }, { val: 9 }, { val: 12 }
    ], []);

    const activityTrends = useMemo(() => [
        { val: 10 }, { val: 15 }, { val: 8 }, { val: 20 }, { val: 12 }, { val: 25 }, { val: 18 }
    ], []);

    const adminPercent = total > 0 ? Math.round((admins / total) * 100) : 0;
    const employeePercent = total > 0 ? Math.round((employees / total) * 100) : 0;

    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 shrink-0 mb-4 px-1">
            <AnalyticalUserCard 
                label="Personal Total"
                value={total}
                subValue="Crecimiento Mensual"
                icon={Users}
                color="#10b981" // Emerald
                chartData={trends}
            />
            <AnalyticalUserCard 
                label="Administradores"
                value={admins}
                subValue="Proporción de Control"
                icon={ShieldAlert}
                progress={adminPercent}
                color="#f59e0b" // Amber
            />
            <AnalyticalUserCard 
                label="Operativos de Turno"
                value={employees}
                subValue="Actividad en Tiempo Real"
                icon={Activity}
                progress={employeePercent}
                color="#3b82f6" // Blue
                chartData={activityTrends}
            />
        </div>
    );
});

UserStats.displayName = 'UserStats';
export default UserStats;
