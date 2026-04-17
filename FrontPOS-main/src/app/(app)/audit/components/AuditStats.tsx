"use client";
import { Card, CardBody } from "@heroui/react";
import { ShieldAlert, Activity, Users, Globe } from 'lucide-react';
import { AuditLog } from '@/lib/definitions';

interface AuditStatsProps {
  logs: AuditLog[];
}

export default function AuditStats({ logs }: AuditStatsProps) {
  const totalLogs = logs.length;
  const uniqueUsers = new Set(logs.map(l => l.employee_dni)).size;
  const criticalActions = logs.filter(l => 
    l.action.toUpperCase().includes('DELETE') || 
    l.action.toUpperCase().includes('RESET') ||
    l.action.toUpperCase().includes('FAIL')
  ).length;
  
  const modules = new Set(logs.map(l => l.module)).size;

  const stats = [
    {
      title: "Logs Totales",
      value: totalLogs,
      icon: <Activity className="text-blue-500" size={24} />,
      description: "Actividad registrada"
    },
    {
      title: "Acciones Críticas",
      value: criticalActions,
      icon: <ShieldAlert className="text-amber-500" size={24} />,
      description: "Alertas de seguridad"
    },
    {
      title: "Usuarios Activos",
      value: uniqueUsers,
      icon: <Users className="text-purple-500" size={24} />,
      description: "Operadores en sistema"
    },
    {
      title: "Módulos",
      value: modules,
      icon: <Globe className="text-teal-500" size={24} />,
      description: "Áreas monitoreadas"
    }
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      {stats.map((stat, i) => (
        <Card key={i} className="border-none shadow-sm bg-background/60 backdrop-blur-md">
          <CardBody className="flex flex-row items-center p-4 gap-4">
            <div className="p-3 bg-default-100 rounded-xl">
              {stat.icon}
            </div>
            <div>
              <p className="text-tiny uppercase font-bold text-default-500">{stat.title}</p>
              <h4 className="text-2xl font-bold">{stat.value}</h4>
              <p className="text-tiny text-default-400">{stat.description}</p>
            </div>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
