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

  const [newExpenseDesc, setNewExpenseDesc] = useState('');
  const [newExpenseAmount, setNewExpenseAmount] = useState(0);
  const [newExpenseSource, setNewExpenseSource] = useState('EFECTIVO');
  const [forgottenExpenses, setForgottenExpenses] = useState<any[]>([]);

  useEffect(() => {
    if (closure) {
      setFormData({
        physicalCash: closure.physicalCash || 0,
        expectedCash: closure.expectedCash || (closure.openingCash + closure.totalCash - closure.totalExpenses),
        totalExpenses: closure.totalExpenses || 0,
        totalNequiReal: closure.totalNequiReal || closure.totalNequi || 0,
        totalDaviplataReal: closure.totalDaviplataReal || closure.totalDaviplata || 0,
      });
      setForgottenExpenses([]);
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
      // First, save any forgotten expenses if added
      if (forgottenExpenses.length > 0) {
        for (const exp of forgottenExpenses) {
          const payload = {
            ...exp,
            date: closure.endDate, // Force date to be the closure's endDate
            category: "Otros",
            status: "PAID",
          };
          
          await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/expenses`, {
            method: 'POST',
            headers: { 
              'Authorization': `Bearer ${Cookies.get('org-pos-token')}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
          });
        }
      }

      const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/dashboard/cashier-history/${closure.id}`, {
        method: 'PUT',
        headers: { 
          'Authorization': `Bearer ${Cookies.get('org-pos-token')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          physical_cash: formData.physicalCash,
          expected_cash: formData.expectedCash,
          total_expenses: formData.totalExpenses,
          total_nequi_real: formData.totalNequiReal,
          total_daviplata_real: formData.totalDaviplataReal,
          difference: newDifference
        })
      });
      
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.userMessage || 'Error al actualizar el cierre');
      }
      
      toast({ title: "CIERRE ACTUALIZADO", description: `El cierre #${closure.id} se actualizo correctamente.` });
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
                    <p className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-[0.3em] mt-1 tracking-tight">Ajuste manual de totales</p>
                 </div>
              </div>
            </ModalHeader>
            <ModalBody>
              <div className="space-y-4">
                <Input
                  label="Efectivo Fisico (Arqueo)"
                  type="number"
                  variant="bordered"
                  value={formData.physicalCash.toString()}
                  onChange={(e) => handleChange('physicalCash', e.target.value)}
                  startContent={<span className="text-gray-500 dark:text-zinc-500 text-sm">$</span>}
                />
                <Input
                  label="Efectivo Esperado (Sistema)"
                  type="number"
                  variant="bordered"
                  value={formData.expectedCash.toString()}
                  onChange={(e) => handleChange('expectedCash', e.target.value)}
                  startContent={<span className="text-gray-500 dark:text-zinc-500 text-sm">$</span>}
                />
                <Input
                  label="Total Egresos"
                  type="number"
                  variant="bordered"
                  value={formData.totalExpenses.toString()}
                  onChange={(e) => handleChange('totalExpenses', e.target.value)}
                  startContent={<span className="text-gray-500 dark:text-zinc-500 text-sm">$</span>}
                />
                <Input
                  label="Total Nequi Real"
                  type="number"
                  variant="bordered"
                  value={formData.totalNequiReal.toString()}
                  onChange={(e) => handleChange('totalNequiReal', e.target.value)}
                  startContent={<span className="text-gray-500 dark:text-zinc-500 text-sm">$</span>}
                />
                <Input
                  label="Total Daviplata Real"
                  type="number"
                  variant="bordered"
                  value={formData.totalDaviplataReal.toString()}
                  onChange={(e) => handleChange('totalDaviplataReal', e.target.value)}
                  startContent={<span className="text-gray-500 dark:text-zinc-500 text-sm">$</span>}
                />
                
                <div className="pt-4 border-t border-zinc-200 dark:border-white/5">
                  <div className="flex justify-between items-center bg-zinc-50 dark:bg-[#18181b] p-3 rounded-xl border border-zinc-200 dark:border-white/5">
                    <span className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest">Nueva Diferencia</span>
                    <span className={`text-sm font-bold tabular-nums ${formData.physicalCash - formData.expectedCash === 0 ? 'text-zinc-900 dark:text-zinc-100' : formData.physicalCash - formData.expectedCash < 0 ? 'text-rose-500' : 'text-amber-500'}`}>
                      {formData.physicalCash - formData.expectedCash > 0 ? '+' : ''}{formData.physicalCash - formData.expectedCash}
                    </span>
                  </div>
                </div>

                <div className="pt-4 border-t border-zinc-200 dark:border-white/5 space-y-3">
                  <div>
                    <h4 className="text-xs font-bold text-zinc-900 dark:text-zinc-100 uppercase tracking-widest">Registrar Egreso Olvidado</h4>
                    <p className="text-[10px] text-gray-500 leading-tight mt-1">
                      Si olvidaste registrar un egreso en este turno, se guardará con la fecha de este cierre.
                    </p>
                  </div>
                  
                  <Input
                    label="Descripción"
                    variant="bordered"
                    size="sm"
                    value={newExpenseDesc}
                    onChange={(e) => setNewExpenseDesc(e.target.value.toUpperCase())}
                  />
                  <div className="flex gap-2">
                    <Input
                      label="Valor"
                      type="number"
                      variant="bordered"
                      size="sm"
                      className="flex-1"
                      value={newExpenseAmount.toString()}
                      onChange={(e) => setNewExpenseAmount(parseFloat(e.target.value) || 0)}
                      startContent={<span className="text-gray-500 text-xs">$</span>}
                    />
                    <select 
                      className="bg-transparent border border-zinc-200 dark:border-white/10 rounded-xl px-2 text-xs font-medium text-zinc-900 dark:text-zinc-100 outline-none w-28"
                      value={newExpenseSource}
                      onChange={(e) => setNewExpenseSource(e.target.value)}
                    >
                      <option value="EFECTIVO">EFECTIVO</option>
                      <option value="FONDO">FONDO</option>
                      <option value="NEQUI">NEQUI</option>
                      <option value="DAVIPLATA">DAVIPLATA</option>
                    </select>
                  </div>
                  <Button 
                    size="sm" 
                    variant="flat" 
                    color="secondary"
                    className="w-full font-medium text-[10px] uppercase tracking-widest rounded-xl"
                    onPress={() => {
                      if (!newExpenseDesc || newExpenseAmount <= 0) {
                        toast({ variant: "destructive", title: "DATOS INCOMPLETOS", description: "Ingresa descripción y valor." });
                        return;
                      }
                      const expense = {
                        description: newExpenseDesc,
                        amount: newExpenseAmount,
                        paymentSource: newExpenseSource,
                        cashAmount: newExpenseSource === 'EFECTIVO' ? newExpenseAmount : 0,
                        nequiAmount: newExpenseSource === 'NEQUI' ? newExpenseAmount : 0,
                        daviplataAmount: newExpenseSource === 'DAVIPLATA' ? newExpenseAmount : 0,
                        fondoAmount: newExpenseSource === 'FONDO' ? newExpenseAmount : 0,
                      };
                      setForgottenExpenses(prev => [...prev, expense]);
                      
                      // Auto-sumar al total de egresos (solo si es efectivo o fondo, dependiendo de la lógica, pero por simplicidad al Total Egresos)
                      // En tu lógica, totalExpenses es solo efectivo? Usualmente sí, o globales. Lo sumamos a expectedCash si afecta caja.
                      if (newExpenseSource === 'EFECTIVO') {
                         setFormData(prev => ({ 
                           ...prev, 
                           totalExpenses: prev.totalExpenses + newExpenseAmount,
                           expectedCash: prev.expectedCash - newExpenseAmount 
                         }));
                      } else if (newExpenseSource === 'NEQUI') {
                         setFormData(prev => ({ ...prev, totalNequiReal: prev.totalNequiReal - newExpenseAmount }));
                      } else if (newExpenseSource === 'DAVIPLATA') {
                         setFormData(prev => ({ ...prev, totalDaviplataReal: prev.totalDaviplataReal - newExpenseAmount }));
                      }
                      
                      setNewExpenseDesc('');
                      setNewExpenseAmount(0);
                    }}
                  >
                    + Agregar a la lista
                  </Button>

                  {forgottenExpenses.length > 0 && (
                    <div className="flex flex-col gap-2 mt-2">
                      {forgottenExpenses.map((exp, idx) => (
                        <div key={idx} className="flex justify-between items-center bg-zinc-50 dark:bg-[#18181b] p-2 rounded-lg border border-zinc-200 dark:border-white/5">
                          <div className="flex flex-col">
                            <span className="text-[10px] font-bold text-zinc-900 dark:text-zinc-100">{exp.description}</span>
                            <span className="text-[9px] text-gray-500 font-medium">{exp.paymentSource}</span>
                          </div>
                          <span className="text-xs font-bold text-rose-500">-${exp.amount}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </ModalBody>
            <ModalFooter>
              <Button 
                variant="flat" 
                onPress={onClose}
                className="font-medium text-[10px] uppercase tracking-widest bg-white dark:bg-[#18181b] text-gray-500 dark:text-zinc-500 dark:text-zinc-400 rounded-2xl"
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
