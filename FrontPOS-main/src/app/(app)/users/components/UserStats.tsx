"use client";
import React, { memo, useMemo } from 'react';
import { ShieldCheck, ShieldAlert, UserCircle, Users, Activity } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area } from 'recharts';
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
    <div className="relative group flex-1 bg-white/80 dark:bg-zinc-900/50 backdrop-blur-xl p-3.5 border border-gray-200 dark:border-white/5 rounded-2xl shadow-xl overflow-hidden shadow-emerald-500/5 transition-all hover:scale-[1.02] hover:border-emerald-500/20">
        {/* Background Sparkline */}
        {chartData && (
            <div className="absolute inset-x-0 bottom-0 h-6 sm:h-10 opacity-30 dark:opacity-20 pointer-events-none">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData}>
                        <defs>
                            <linearGradient id={`color-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={color} stopOpacity={0.8}/>
                                <stop offset="95%" stopColor={color} stopOpacity={0}/>
                            </linearGradient>
                        </defs>
                        <Area 
                            type="monotone" 
                            dataKey="val" 
                            stroke={color} 
                            fillOpacity={1} 
                            fill={`url(#color-${color.replace('#', '')})`} 
                            strokeWidth={2}
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        )}

        <div className="relative z-10">
            <div className="flex justify-between items-start mb-2 sm:mb-3">
                <div className={`p-1.5 sm:p-2 rounded-xl bg-opacity-10 text-white shadow-inner`} style={{ backgroundColor: `${color}20`, color: color }}>
                    <Icon size={16} className="sm:size-4" />
                </div>
                <div className="text-right">
                    <span className="text-[8px] sm:text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-none italic block mb-0.5">
                        {label}
                    </span>
                    <span className="text-lg sm:text-xl font-black text-gray-900 dark:text-white italic leading-none tracking-tighter tabular-nums">
                        {value}
                    </span>
                </div>
            </div>

            <div className="flex flex-col gap-1 sm:gap-2">
                <div className="flex justify-between items-center text-[7px] sm:text-[9px] font-black uppercase tracking-wider">
                    <span className="text-gray-400 dark:text-zinc-500 truncate max-w-[60px] sm:max-w-none">{subValue}</span>
                    {progress !== undefined && <span style={{ color: color }}>{progress}%</span>}
                </div>
                {progress !== undefined && (
                    <div className="h-0.5 sm:h-1 w-full bg-gray-100 dark:bg-white/5 rounded-full overflow-hidden shadow-inner">
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
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 shrink-0 mb-1 md:mb-2 px-1">
            <div className="col-span-1">
                <AnalyticalUserCard 
                    label="Personal Total"
                    value={total}
                    subValue="Crecimiento"
                    icon={Users}
                    color="#10b981"
                    chartData={trends}
                />
            </div>
            <div className="col-span-1">
                <AnalyticalUserCard 
                    label="Admins"
                    value={admins}
                    subValue="Control"
                    icon={ShieldAlert}
                    progress={adminPercent}
                    color="#f59e0b"
                />
            </div>
            <div className="col-span-2 md:col-span-1">
                <AnalyticalUserCard 
                    label="Operativos de Turno"
                    value={employees}
                    subValue="Actividad"
                    icon={Activity}
                    progress={employeePercent}
                    color="#3b82f6"
                    chartData={activityTrends}
                />
            </div>
        </div>
    );
});

UserStats.displayName = 'UserStats';
export default UserStats;
