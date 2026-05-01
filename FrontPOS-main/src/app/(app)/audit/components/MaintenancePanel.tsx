"use client";

import { useState } from 'react';
import { Button, Input, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/react";
import { Database, Download, AlertTriangle, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api-error";

export default function MaintenancePanel() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [isBackupLoading, setIsBackupLoading] = useState(false);
  const [isPurgeModalOpen, setIsPurgeModalOpen] = useState(false);
  const [purgeDate, setPurgeDate] = useState("");
  const [isPurgeLoading, setIsPurgeLoading] = useState(false);

  const handleBackup = async () => {
    if (!user?.token) return;
    setIsBackupLoading(true);
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/admin/backup`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${user.token}` },
      });
      
      if (!response.ok) throw new Error("Falló la generación del respaldo");
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pos_backup_${new Date().toISOString().split('T')[0]}.sql`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      
      toast({
        title: "Backup Exitoso",
        description: "El archivo SQL se ha descargado correctamente.",
      });
    } catch (error: any) {
      toast({
        title: "Error en Backup",
        description: error.message || "Error desconocido",
        variant: "destructive"
      });
    } finally {
      setIsBackupLoading(false);
    }
  };

  const handlePurge = async () => {
    if (!user?.token || !purgeDate) return;
    
    // Doble confirmación por seguridad
    const confirm1 = window.confirm(`¿Estás SEGURO de eliminar todos los registros anteriores a ${purgeDate}?`);
    if (!confirm1) return;
    const confirm2 = prompt(`Escribe "ELIMINAR" para proceder con la purga irreversible.`);
    if (confirm2 !== "ELIMINAR") {
      toast({ title: "Purga cancelada", description: "La palabra de seguridad no coincide." });
      return;
    }

    setIsPurgeLoading(true);
    try {
      const result = await apiFetch(`/admin/purge`, {
        method: 'POST',
        body: JSON.stringify({ date: purgeDate })
      }, user.token);
      
      toast({
        title: "Limpieza Completada",
        description: `Se han eliminado ${result.records_deleted} registros históricos.`,
      });
      setIsPurgeModalOpen(false);
      setPurgeDate("");
    } catch (error: any) {
      toast({
        title: "Fallo en Purga",
        description: error.message || "Fallo en el servidor",
        variant: "destructive"
      });
    } finally {
      setIsPurgeLoading(false);
    }
  };

  return (
    <>
      <div className="bg-white dark:bg-zinc-950 p-4 rounded-2xl border border-gray-200 dark:border-white/5 flex flex-col md:flex-row items-center justify-between gap-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-500 rounded-xl">
            <Database size={24} />
          </div>
          <div>
            <h3 className="text-sm font-black uppercase text-gray-900 dark:text-white">Mantenimiento de BD</h3>
            <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-400 uppercase tracking-wider">Gestión de Respaldos y Limpieza Histórica</p>
          </div>
        </div>
        
        <div className="flex items-center gap-2 w-full md:w-auto">
          <Button
            color="primary"
            variant="flat"
            onPress={handleBackup}
            isLoading={isBackupLoading}
            className="flex-1 md:flex-none font-black text-[10px] uppercase tracking-widest"
          >
            <Download size={16} className="mr-1" />
            Descargar Respaldo
          </Button>
          
          <Button
            color="danger"
            variant="flat"
            onPress={() => setIsPurgeModalOpen(true)}
            className="flex-1 md:flex-none font-black text-[10px] uppercase tracking-widest"
          >
            <Trash2 size={16} className="mr-1" />
            Limpiar Historial
          </Button>
        </div>
      </div>

      <Modal isOpen={isPurgeModalOpen} onOpenChange={setIsPurgeModalOpen}>
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex flex-col gap-1 text-danger">
                <div className="flex items-center gap-2">
                  <AlertTriangle size={20} />
                  <span className="uppercase font-black text-sm">Peligro: Purga de Datos</span>
                </div>
              </ModalHeader>
              <ModalBody>
                <p className="text-xs text-gray-600 dark:text-gray-300">
                  Esta acción eliminará de forma <b>permanente e irreversible</b> todas las ventas, movimientos de stock, egresos y logs de auditoría <b>anteriores</b> a la fecha seleccionada.
                </p>
                <p className="text-xs font-bold text-danger">
                  Es extremadamente recomendable realizar un Respaldo Total antes de proceder.
                </p>
                
                <div className="mt-4">
                  <label className="text-[10px] font-black uppercase text-gray-500 mb-2 block">Fecha de Corte (Eliminar todo lo ANTERIOR a esta fecha)</label>
                  <Input 
                    type="date" 
                    value={purgeDate}
                    onChange={(e) => setPurgeDate(e.target.value)}
                    variant="bordered"
                  />
                </div>
              </ModalBody>
              <ModalFooter>
                <Button variant="light" onPress={onClose} className="font-bold text-[10px] uppercase">
                  Cancelar
                </Button>
                <Button 
                  color="danger" 
                  onPress={handlePurge} 
                  isLoading={isPurgeLoading}
                  isDisabled={!purgeDate}
                  className="font-black text-[10px] uppercase tracking-widest"
                >
                  Confirmar Purga
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </>
  );
}
