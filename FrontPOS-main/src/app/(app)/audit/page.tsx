"use client";
import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import {
  ShieldCheck, RefreshCw, Download
} from 'lucide-react';
import { Button, Spinner } from "@heroui/react";
import { AuditLog } from '@/lib/definitions';
import AuditTable from './components/AuditTable';
import AuditStats from './components/AuditStats';
import MaintenancePanel from './components/MaintenancePanel';

async function fetchAuditLogs(token: string): Promise<AuditLog[]> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/admin/audit-logs`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error?.message || "Error al obtener logs de auditoría");
  }
  return await res.json();
}

export default function AuditPage() {
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    if (!user?.token) return;
    setLoading(true);
    try {
      const data = await fetchAuditLogs(user.token);
      setLogs(data);
    } catch (err: any) {
      toast({
        title: "Error de Auditoría",
        description: err.message,
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [user]);

  if (authLoading || (loading && logs.length === 0)) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <Spinner size="lg" label="Cargando registros de seguridad..." color="primary" />
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full max-w-[1600px] mx-auto bg-transparent text-gray-900 dark:text-white transition-all duration-500 relative">

      {/* HEADER SECTION: FIXED (TOP) */}
      <div className="shrink-0 px-3 pt-1.5 pb-2 flex flex-col gap-3 border-b border-gray-200/50 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-950/50 backdrop-blur-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-500 h-10 w-10 rounded-xl text-white shadow-lg shadow-emerald-500/20 flex items-center justify-center transform -rotate-3">
              <ShieldCheck size={20} />
            </div>
            <div className="flex flex-col">
              <h1 className="text-[13px] font-black text-gray-900 dark:text-white tracking-tighter uppercase italic leading-none">
                Seguridad & <span className="text-emerald-500">Auditoría</span>
              </h1>
              <p className="text-[8px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.4em] italic mt-1 flex items-center gap-1">
                <RefreshCw size={10} className="text-emerald-500" /> Monitoreo V5.0
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              isIconOnly
              onPress={loadData}
              isLoading={loading}
              className="h-10 w-10 min-w-0 bg-white/80 dark:bg-zinc-900/50 text-gray-400 dark:text-zinc-500 rounded-xl border border-gray-200 dark:border-white/5 shadow-sm active:scale-90"
            >
              {!loading && <RefreshCw size={16} />}
            </Button>
            <Button
              onPress={() => {
                toast({
                  title: "Reporte de Auditoría",
                  description: "Exportación a PDF en desarrollo...",
                  variant: "default"
                });
              }}
              className="h-10 px-4 bg-emerald-500 text-white font-black text-[9px] uppercase tracking-widest italic rounded-xl shadow-lg shadow-emerald-500/20 active:scale-95 transition-all"
            >
              <Download size={14} className="mr-1.5" /> EXPORTAR
            </Button>
          </div>
        </div>
      </div>

      {/* CONTENT SECTION (SCROLLABLE) */}
      <div className="flex-1 min-h-0 flex flex-col gap-3 p-3 bg-gray-100/50 dark:bg-zinc-950/20 animate-in fade-in slide-in-from-bottom-4 duration-700">
        <MaintenancePanel />
        <AuditStats logs={logs} />
        <AuditTable logs={logs} />
      </div>
    </div>

  );
}
