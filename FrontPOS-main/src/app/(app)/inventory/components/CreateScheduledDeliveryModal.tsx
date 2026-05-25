"use client";

import React, { useState } from 'react';
import { 
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, 
  Button, Input, Autocomplete, AutocompleteItem 
} from "@heroui/react";
import { Truck, DollarSign, Calendar, Save, Building2 } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api-error';
import { useToast } from '@/hooks/use-toast';

interface CreateScheduledDeliveryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function CreateScheduledDeliveryModal({ isOpen, onClose, onSuccess }: CreateScheduledDeliveryModalProps) {
  const { toast } = useToast();
  const { data: suppliers, isLoading: loadingSuppliers } = useApi<any[]>('/suppliers/all-suppliers');
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    supplierId: '',
    supplierName: '',
    expectedDate: new Date().toISOString().split('T')[0],
    totalEstimated: '',
  });

  const handleSave = async () => {
    if (!formData.supplierName) {
      toast({ variant: 'destructive', title: 'CAMPOS FALTANTES', description: "Seleccione un proveedor" });
      return;
    }

    setIsSubmitting(true);
    try {
      await apiFetch('/orders/expected', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: parseInt(formData.supplierId) || 0,
          supplierName: formData.supplierName,
          expectedDate: formData.expectedDate,
          totalEstimated: parseFloat(formData.totalEstimated) || 0,
          itemCount: 0 
        })
      });

      toast({ variant: 'success', title: 'ÉXITO', description: "Entrega programada registrada" });
      onSuccess();
      onClose();
      // Reset form
      setFormData({
        supplierId: '',
        supplierName: '',
        expectedDate: new Date().toISOString().split('T')[0],
        totalEstimated: '',
      });
    } catch (error) {
      console.error("Error creating delivery:", error);
      toast({ variant: 'destructive', title: 'ERROR', description: "Error al registrar la entrega" });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal 
      isOpen={isOpen} 
      onClose={onClose}
      backdrop="blur"
      size="md"
      classNames={{
        base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)]",
        header: "border-b border-gray-100 dark:border-white/5",
        footer: "border-t border-gray-100 dark:border-white/5"
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-2xl bg-amber-500 text-white flex items-center justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-amber-500/20">
                <Truck size={20} />
              </div>
              <div className="flex flex-col">
                <h3 className="text-lg font-medium uppercase tracking-tight tracking-tighter text-zinc-900 dark:text-zinc-50">Programar <span className="text-amber-500">Entrega</span></h3>
                <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Nueva Preventa Logística</p>
              </div>
            </ModalHeader>
            <ModalBody className="py-6 flex flex-col gap-5">
              
              {/* PROVEEDOR */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest ml-1">Proveedor / Marca</label>
                <Autocomplete
                  placeholder="Buscar proveedor..."
                  variant="flat"
                  startContent={<Building2 size={16} className="text-gray-400" />}
                  isLoading={loadingSuppliers}
                  defaultItems={suppliers || []}
                  onSelectionChange={(key) => {
                    const s = suppliers?.find(sup => String(sup.id) === String(key));
                    if (s) {
                      setFormData({ ...formData, supplierId: String(s.id), supplierName: s.name });
                    }
                  }}
                  className="max-w-full"
                  classNames={{
                    base: "h-12",
                    listboxWrapper: "max-h-[300px]",
                  }}
                >
                  {(item) => (
                    <AutocompleteItem key={item.id} textValue={item.name}>
                      <div className="flex flex-col">
                        <span className="text-sm font-bold">{item.name}</span>
                        <span className="text-xs text-gray-500">{item.contactName}</span>
                      </div>
                    </AutocompleteItem>
                  )}
                </Autocomplete>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* VALOR ESTIMADO */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest ml-1">Valor Estimado</label>
                  <Input
                    type="text"
                    inputMode="decimal"
                    placeholder="Monto aproximado"
                    variant="flat"
                    startContent={<DollarSign size={16} className="text-zinc-900 dark:text-zinc-100" />}
                    value={formData.totalEstimated}
                    onValueChange={(v) => setFormData({ ...formData, totalEstimated: v })}
                    classNames={{
                        inputWrapper: "h-12 bg-gray-50 dark:bg-[#18181b] border border-transparent focus-within:border-emerald-500 transition-all",
                        input: "font-medium text-zinc-900 dark:text-zinc-100 text-sm"
                    }}
                  />
                </div>

                {/* FECHA DE ENTREGA */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest ml-1">Fecha Programada</label>
                  <Input
                    type="date"
                    variant="flat"
                    startContent={<Calendar size={16} className="text-amber-500" />}
                    value={formData.expectedDate}
                    onChange={(e) => setFormData({ ...formData, expectedDate: e.target.value })}
                    classNames={{
                        inputWrapper: "h-12 bg-gray-50 dark:bg-[#18181b] border border-transparent focus-within:border-amber-500 transition-all",
                        input: "font-medium text-sm uppercase"
                    }}
                  />
                </div>
              </div>

              {/* ESTADO INFO */}
              <div className="p-3 bg-amber-500/5 border border-amber-500/10 rounded-2xl flex items-center gap-3">
                <div className="h-2 w-2 rounded-2xl bg-amber-500 animate-pulse" />
                <p className="text-[10px] font-medium text-amber-600 dark:text-amber-500 uppercase tracking-wider tracking-tight">
                  Estado Inicial: <span className="underline">EN CAMINO</span>
                </p>
              </div>

            </ModalBody>
            <ModalFooter>
              <Button 
                variant="light" 
                onPress={onClose} 
                className="font-medium text-[10px] uppercase tracking-widest text-gray-500 hover:text-gray-900 h-10"
              >
                Cancelar
              </Button>
              <Button 
                className="bg-[#18181b] dark:bg-white text-white dark:text-zinc-950 font-medium text-[10px] uppercase tracking-widest shadow-[0_8px_30px_rgb(0,0,0,0.12)] h-10 px-6"
                startContent={<Save size={16} />}
                isLoading={isSubmitting}
                onPress={handleSave}
              >
                Guardar Entrega
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
