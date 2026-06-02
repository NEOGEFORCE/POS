"use client";
import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import {
  ShieldCheck, RefreshCw, Download
} from 'lucide-react';
import { Button, Spinner } from "@heroui/react";
import dynamic from 'next/dynamic';
import { broadcastRevalidate, setupSyncListener } from '@/lib/revalidate';
import { AuditLog } from '@/lib/definitions';

const AuditTable = dynamic(() => import('./components/AuditTable'), { ssr: false });
const AuditStats = dynamic(() => import('./components/AuditStats'), { ssr: false });
const MaintenancePanel = dynamic(() => import('./components/MaintenancePanel'), { ssr: false });

async function fetchAuditLogs(token: string): Promise<AuditLog[]> {
  const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/admin/audit-logs`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error?.message || "Error al obtener logs de auditoria");
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
        title: "Error de Auditoria",
        description: err.message,
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();

    // SINCRONIZACION ZERO-F5: Auditoria en tiempo real
    const cleanup = setupSyncListener((event) => {
        if (event === 'PRODUCT_UPDATE' || event === 'SALE_MADE' || event === 'EXPENSE_UPDATE' || event === 'DASHBOARD_UPDATE') {
            loadData();
        }
    });
    return cleanup;
  }, [user]);

  if (authLoading || (loading && logs.length === 0)) {
    return (
      <div className="flex-1 h-full w-full items-center justify-center">
        <Spinner size="lg" label="Cargando registros de seguridad..." color="primary" />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full w-full max-w-[1600px] mx-auto overflow-y-auto md:overflow-hidden bg-transparent text-zinc-900 dark:text-zinc-50 transition-all duration-500 relative">

      {/* HEADER SECTION: FIXED (TOP) */}
      <div className="shrink-0 px-3 pt-1.5 pb-2 flex flex-col gap-3 border-b border-gray-200/50 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-950/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 h-10 w-10 rounded-2xl text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex items-center justify-center transform -rotate-3">
              <ShieldCheck size={20} />
            </div>
            <div className="flex flex-col">
              <h1 className="text-[13px] font-medium text-zinc-900 dark:text-zinc-50 tracking-tighter uppercase tracking-tight leading-none">
                Seguridad & <span className="text-zinc-900 dark:text-zinc-100">Auditoria</span>
              </h1>
              <p className="text-[8px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.4em] tracking-tight mt-1 flex items-center gap-1">
                <RefreshCw size={10} className="text-zinc-900 dark:text-zinc-100" /> Monitoreo V5.0
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              isIconOnly
              onPress={loadData}
              isLoading={loading}
              className="h-10 w-10 min-w-0 card-base border-none text-zinc-500 dark:text-zinc-400 rounded-2xl border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-90"
            >
              {!loading && <RefreshCw size={16} />}
            </Button>
            <Button
              onPress={() => {
                toast({
                  title: "Reporte de Auditoria",
                  description: "Exportacion a PDF en desarrollo...",
                  variant: "default"
                });
              }}
              className="h-10 px-4 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-white font-medium text-[9px] uppercase tracking-widest tracking-tight rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-95 transition-all"
            >
              <Download size={14} className="mr-1.5" /> EXPORTAR
            </Button>
          </div>
        </div>
      </div>

      {/* CONTENT SECTION (SCROLLABLE) */}
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto md:overflow-hidden custom-scrollbar gap-3 p-3 bg-gray-100/50 dark:bg-zinc-950/20 animate-in fade-in slide-in-from-bottom-4 duration-700">
        <MaintenancePanel />
        <AuditStats logs={logs} />
        <AuditTable logs={logs} />
      </div>
    </div>

  );
}




