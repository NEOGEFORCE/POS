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
    <div className="p-4 sm:p-6 max-w-[1600px] mx-auto space-y-6">
      {/* HEADER */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3 tracking-tight">
            <ShieldCheck size={32} className="text-primary" />
            Auditoría del Sistema
          </h1>
          <p className="text-default-500 text-sm mt-1">
            Monitoreo en tiempo real de acciones administrativas y eventos de seguridad.
          </p>
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          <Button 
            variant="flat" 
            onPress={loadData}
            isLoading={loading}
            startContent={!loading && <RefreshCw size={18} />}
          >
            Refrescar
          </Button>
          <Button 
            color="primary"
            variant="shadow"
            startContent={<Download size={18} />}
            onPress={() => {
              toast({
                title: "Reporte de Auditoría",
                description: "Exportación a PDF en desarrollo...",
                variant: "default"
              });
            }}
          >
            Exportar Logs
          </Button>
        </div>
      </div>

      <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
        {/* STATS */}
        <AuditStats logs={logs} />

        {/* TABLE */}
        <AuditTable logs={logs} />
      </div>
    </div>
  );
}
