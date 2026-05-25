"use client";

import React, { useState, useEffect } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, Input
} from "@heroui/react";
import { Edit, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import Cookies from 'js-cookie';

interface EditClosureModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  closure: any; // We use any to avoid importing the whole interface if not exported, but we can type it roughly
  onSuccess: () => void;
}

export default function EditClosureModal({ isOpen, onOpenChange, closure, onSuccess }: EditClosureModalProps) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    physicalCash: 0,
    expectedCash: 0,
    totalExpenses: 0,
    totalNequiReal: 0,
    totalDaviplataReal: 0,
  });

  useEffect(() => {
    if (closure) {
      setFormData({
        physicalCash: closure.physicalCash || 0,
        expectedCash: closure.expectedCash || (closure.openingCash + closure.totalCash - closure.totalExpenses),
        totalExpenses: closure.totalExpenses || 0,
        totalNequiReal: closure.totalNequiReal || closure.totalNequi || 0,
        totalDaviplataReal: closure.totalDaviplataReal || closure.totalDaviplata || 0,
      });
    }
  }, [closure]);

  const handleChange = (field: string, value: string) => {
    const numValue = parseFloat(value) || 0;
    setFormData(prev => ({ ...prev, [field]: numValue }));
  };

  const handleSave = async () => {
    if (!closure) return;
    setIsLoading(true);
    
    // Calculate new difference
    const newDifference = formData.physicalCash - formData.expectedCash;

    try {
      const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/dashboard/cashier-history/${closure.id}`, {
        method: 'PUT',
        headers: { 
          'Authorization': `Bearer ${Cookies.get('org-pos-token')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          physical_cash: formData.physicalCash,
          expected_cash: formData.expectedCash,
          totalExpenses: formData.totalExpenses,
          total_nequi_real: formData.totalNequiReal,
          total_daviplata_real: formData.totalDaviplataReal,
          difference: newDifference
        })
      });
      
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.userMessage || 'Error al actualizar el cierre');
      }
      
      toast({ title: "CIERRE ACTUALIZADO", description: `El cierre #${closure.id} se actualizó correctamente.` });
      onSuccess();
      onOpenChange(false);
    } catch (error: any) {
      console.error('Error updating closure:', error);
      toast({ variant: "destructive", title: "ERROR AL ACTUALIZAR", description: error.message });
    } finally {
      setIsLoading(false);
    }
  };

  if (!closure) return null;

  return (
    <Modal 
      isOpen={isOpen} 
      onOpenChange={onOpenChange}
      size="md"
      classNames={{
        base: "bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-white/10 rounded-[2.5rem]",
        header: "border-b border-zinc-200 dark:border-white/5 p-6 pb-4",
        body: "p-6",
        footer: "border-t border-zinc-200 dark:border-white/5 p-6",
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                 <div className="h-10 w-10 text-white bg-blue-500 rounded-2xl flex items-center justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-blue-500/30">
                    <Edit size={20} />
                 </div>
                 <div className="flex flex-col">
                    <h3 className="text-xl font-medium text-zinc-900 dark:text-zinc-100 tracking-tight uppercase tracking-tighter leading-none">
                      Editar <span className="text-blue-500">Cierre #{closure.id}</span>
                    </h3>
                    <p className="text-[9px] font-medium text-zinc-500 uppercase tracking-[0.3em] mt-1 tracking-tight">Ajuste manual de totales</p>
                 </div>
              </div>
            </ModalHeader>
            <ModalBody>
              <div className="space-y-4">
                <Input
                  label="Efectivo Físico (Arqueo)"
                  type="number"
                  variant="bordered"
                  value={formData.physicalCash.toString()}
                  onChange={(e) => handleChange('physicalCash', e.target.value)}
                  startContent={<span className="text-zinc-500 text-sm">$</span>}
                />
                <Input
                  label="Efectivo Esperado (Sistema)"
                  type="number"
                  variant="bordered"
                  value={formData.expectedCash.toString()}
                  onChange={(e) => handleChange('expectedCash', e.target.value)}
                  startContent={<span className="text-zinc-500 text-sm">$</span>}
                />
                <Input
                  label="Total Egresos"
                  type="number"
                  variant="bordered"
                  value={formData.totalExpenses.toString()}
                  onChange={(e) => handleChange('totalExpenses', e.target.value)}
                  startContent={<span className="text-zinc-500 text-sm">$</span>}
                />
                <Input
                  label="Total Nequi Real"
                  type="number"
                  variant="bordered"
                  value={formData.totalNequiReal.toString()}
                  onChange={(e) => handleChange('totalNequiReal', e.target.value)}
                  startContent={<span className="text-zinc-500 text-sm">$</span>}
                />
                <Input
                  label="Total Daviplata Real"
                  type="number"
                  variant="bordered"
                  value={formData.totalDaviplataReal.toString()}
                  onChange={(e) => handleChange('totalDaviplataReal', e.target.value)}
                  startContent={<span className="text-zinc-500 text-sm">$</span>}
                />
                
                <div className="pt-4 border-t border-zinc-200 dark:border-white/5">
                  <div className="flex justify-between items-center bg-zinc-50 dark:bg-[#18181b] p-3 rounded-xl border border-zinc-200 dark:border-white/5">
                    <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-widest">Nueva Diferencia</span>
                    <span className={`text-sm font-bold tabular-nums ${formData.physicalCash - formData.expectedCash === 0 ? 'text-zinc-900 dark:text-zinc-100' : formData.physicalCash - formData.expectedCash < 0 ? 'text-rose-500' : 'text-amber-500'}`}>
                      {formData.physicalCash - formData.expectedCash > 0 ? '+' : ''}{formData.physicalCash - formData.expectedCash}
                    </span>
                  </div>
                </div>
              </div>
            </ModalBody>
            <ModalFooter>
              <Button 
                variant="flat" 
                onPress={onClose}
                className="font-medium text-[10px] uppercase tracking-widest bg-white dark:bg-[#18181b] text-zinc-500 dark:text-zinc-400 rounded-2xl"
              >
                Cancelar
              </Button>
              <Button 
                color="primary"
                onPress={handleSave}
                isLoading={isLoading}
                className="font-medium text-[10px] uppercase tracking-widest rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-blue-500/20"
                startContent={!isLoading ? <Save size={14} /> : undefined}
              >
                {isLoading ? 'Guardando...' : 'Guardar Cambios'}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
