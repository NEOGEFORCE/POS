"use client";

import { useState } from 'react';
import { Button, Input, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/react";
import { Database, Download, AlertTriangle, Trash2, Send } from "lucide-react";
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
  const [isTelegramLoading, setIsTelegramLoading] = useState(false);
  const [isNormalizeLoading, setIsNormalizeLoading] = useState(false);
  const [purgeConfirmation, setPurgeConfirmation] = useState("");

  const handleBackup = async () => {
    if (!user?.token) return;
    setIsBackupLoading(true);
    try {
      const response = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/admin/backup`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${user.token}` },
      });
      
      if (!response.ok) throw new Error("Fallo la generacion del respaldo");
      
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

  const handleTelegramBackup = async () => {
    if (!user?.token) return;
    setIsTelegramLoading(true);
    try {
      await apiFetch(`/admin/backup/telegram`, {
        method: 'POST',
      }, user.token);
      
      toast({
        title: "Respaldo Enviado",
        description: "El archivo se ha enviado exitosamente a Telegram.",
      });
    } catch (error: any) {
      toast({
        title: "Fallo en Envio",
        description: error.message || "Error al conectar con el servidor",
        variant: "destructive"
      });
    } finally {
      setIsTelegramLoading(false);
    }
  };

  const handlePurge = async () => {
    if (!user?.token || !purgeDate) return;
    
    if (purgeConfirmation !== "ELIMINAR") {
      toast({ title: "Seguridad Requerida", description: "Debe escribir ELIMINAR para proceder.", variant: "destructive" });
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
        description: `Se han eliminado ${result.records_deleted} registros historicos.`,
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
  
  const handleNormalizeNames = async () => {
    if (!user?.token) return;
    setIsNormalizeLoading(true);
    try {
      const result = await apiFetch(`/products/maintenance/clean-names`, {
        method: 'POST',
      }, user.token);
      
      toast({
        title: "Normalizacion Exitosa",
        description: `${result.updatedCount} productos actualizados (tildes eliminadas).`,
      });
    } catch (error: any) {
      toast({
        title: "Fallo en Normalizacion",
        description: error.message || "Fallo en el servidor",
        variant: "destructive"
      });
    } finally {
      setIsNormalizeLoading(false);
    }
  };

  return (
    <>
      <div className="bg-white dark:bg-zinc-950 p-4 rounded-2xl border border-gray-200 dark:border-white/5 flex flex-col md:flex-row items-center justify-between gap-4 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-500 rounded-2xl">
            <Database size={24} />
          </div>
          <div>
            <h3 className="text-sm font-medium uppercase text-zinc-900 dark:text-zinc-50">Mantenimiento de BD</h3>
            <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-400 uppercase tracking-wider">Gestion de Respaldos y Limpieza Historica</p>
          </div>
        </div>
        
        <div className="flex items-center gap-2 w-full md:w-auto">
          <Button
            color="primary"
            variant="flat"
            onPress={handleBackup}
            isLoading={isBackupLoading}
            className="flex-1 md:flex-none font-medium text-[10px] uppercase tracking-widest"
          >
            <Download size={16} className="mr-1" />
            Descargar
          </Button>

          <Button
            color="secondary"
            variant="flat"
            onPress={handleTelegramBackup}
            isLoading={isTelegramLoading}
            className="flex-1 md:flex-none font-medium text-[10px] uppercase tracking-widest"
          >
            <Send size={16} className="mr-1" />
            Enviar a Telegram
          </Button>
          
          <Button
            color="warning"
            variant="flat"
            onPress={handleNormalizeNames}
            isLoading={isNormalizeLoading}
            className="flex-1 md:flex-none font-medium text-[10px] uppercase tracking-widest"
          >
            <AlertTriangle size={16} className="mr-1" />
            Normalizar Nombres
          </Button>

          <Button
            color="danger"
            variant="flat"
            onPress={() => setIsPurgeModalOpen(true)}
            className="flex-1 md:flex-none font-medium text-[10px] uppercase tracking-widest"
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
                  <span className="uppercase font-medium text-sm">Peligro: Purga de Datos</span>
                </div>
              </ModalHeader>
              <ModalBody>
                <p className="text-xs text-gray-600 dark:text-gray-300">
                  Esta accion eliminara de forma <b>permanente e irreversible</b> todas las ventas, movimientos de stock, egresos y logs de auditoria <b>anteriores</b> a la fecha seleccionada.
                </p>
                <p className="text-xs font-bold text-danger">
                  Es extremadamente recomendable realizar un Respaldo Total antes de proceder.
                </p>
                
                <div className="mt-4">
                  <Input 
                    type="date" 
                    value={purgeDate}
                    onChange={(e) => setPurgeDate(e.target.value)}
                    variant="bordered"
                    className="mb-4"
                  />

                  <label className="text-[10px] font-medium uppercase text-rose-500 mb-2 block">Confirmacion Critica</label>
                  <p className="text-[9px] text-gray-500 mb-2 uppercase tracking-tight">Escriba <span className="font-medium text-rose-500">ELIMINAR</span> para desbloquear la accion:</p>
                  <Input 
                    placeholder="Escriba aqui..."
                    value={purgeConfirmation}
                    onChange={(e) => setPurgeConfirmation(e.target.value.toUpperCase())}
                    variant="bordered"
                    color={purgeConfirmation === "ELIMINAR" ? "danger" : "default"}
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
                  isDisabled={!purgeDate || purgeConfirmation !== "ELIMINAR"}
                  className="font-medium text-[10px] uppercase tracking-widest shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/20"
                >
                  Confirmar Purga Irreversible
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </>
  );
}


