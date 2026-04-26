"use client";
import { Card, CardBody } from "@heroui/react";
import { ShieldAlert, Activity, Users, Globe, Fingerprint, Zap } from 'lucide-react';
import { AuditLog } from '@/lib/definitions';

interface AuditStatsProps {
  logs: AuditLog[];
}

export default function AuditStats({ logs }: AuditStatsProps) {
  const totalLogs = logs.length;
  const uniqueUsers = new Set(logs.map(l => l.employee_dni)).size;
  const criticalActions = logs.filter(l => l.is_critical).length;
  const modules = new Set(logs.map(l => l.module)).size;

  const stats = [
    {
      title: "Logs Totales",
      value: totalLogs,
      icon: <Activity size={18} />,
      color: "emerald",
      description: "Eventos registrados"
    },
    {
      title: "Acciones Críticas",
      value: criticalActions,
      icon: <ShieldAlert size={18} />,
      color: "rose",
      description: "Alertas de seguridad",
      isPulse: criticalActions > 0
    },
    {
      title: "Responsables",
      value: uniqueUsers,
      icon: <Fingerprint size={18} />,
      color: "blue",
      description: "Huellas digitales únicas"
    },
    {
      title: "Alcance",
      value: `${modules} Módulos`,
      icon: <Zap size={18} />,
      color: "amber",
      description: "Áreas bajo monitoreo"
    }
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-2">
      {stats.map((stat, i) => (
        <Card 
            key={i} 
            className="border border-white/5 bg-white/40 dark:bg-zinc-900/40 backdrop-blur-xl shadow-xl overflow-hidden group"
        >
          <CardBody className="p-3 relative">
            {stat.isPulse && (
                <div className="absolute top-2 right-2 flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
                </div>
            )}
            
            <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-xl bg-${stat.color}-500/10 text-${stat.color}-500 border border-${stat.color}-500/20 group-hover:scale-110 transition-transform duration-500`}>
                    {stat.icon}
                </div>
                <div className="flex flex-col">
                    <p className="text-[8px] font-black uppercase tracking-[0.2em] text-default-400 italic">
                        {stat.title}
                    </p>
                    <div className="flex items-baseline gap-1">
                        <h4 className="text-xl font-black italic tracking-tighter text-default-800 dark:text-zinc-100 leading-none">
                            {stat.value}
                        </h4>
                    </div>
                </div>
            </div>
            
            <div className="mt-2 pt-2 border-t border-default-100 flex items-center justify-between">
                <span className="text-[8px] font-bold text-default-400 uppercase tracking-wider">{stat.description}</span>
                <div className={`h-1 w-8 rounded-full bg-${stat.color}-500/20`}></div>
            </div>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
