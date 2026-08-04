"use client";

import React, { useState, useMemo } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, ScrollShadow, Chip, Input
} from "@heroui/react";
import {
  HandCoins, Activity, Banknote, Wallet, Building2,
  CreditCard as CardIcon, ChevronRight, Info, X
} from 'lucide-react';
import { Expense } from '@/lib/definitions';
import { ExpensePaymentModal } from './ExpensePaymentModal';

interface PendingDebtsModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  debts: Expense[];
  onSettle: (id: string, paymentData: any, amount: number) => Promise<void>;
  isAdmin?: boolean;
  onForceClose?: (id: string) => Promise<void>;
}

const PendingDebtsModal = ({ isOpen, onOpenChange, debts, onSettle, isAdmin, onForceClose }: PendingDebtsModalProps) => {
  const [currentDebtId, setCurrentDebtId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [currentDebtAmount, setCurrentDebtAmount] = useState(0);

  const handleSettleClick = async (paymentData: any) => {
    if (!currentDebtId) return;
    setIsProcessing(true);
    
    const totalAmountPaid = paymentData.cash + paymentData.nequi + paymentData.daviplata + paymentData.fondo;
    
    try {
      await onSettle(currentDebtId, paymentData, totalAmountPaid);
      setIsPaymentModalOpen(false);
    } catch (e) {
      console.error(e);
    } finally {
      setIsProcessing(false);
    }
  };

  const groupedDebts = useMemo(() => {
    const groups: Record<string, Expense[]> = {};
    debts.forEach(debt => {
      const creditor = debt.lenderName || debt.supplier?.name || "OTROS ACREEDORES";
      if (!groups[creditor]) groups[creditor] = [];
      groups[creditor].push(debt);
    });
    return groups;
  }, [debts]);

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="2xl"
      scrollBehavior="inside"
      placement="center"
      hideCloseButton
      classNames={{
        base: "bg-white dark:bg-zinc-950 rounded-[2.5rem] border border-gray-100 dark:border-white/5 translate-y-4",
        header: "border-b border-gray-50 dark:border-white/5 p-4 px-6",
        footer: "border-t border-gray-50 dark:border-white/5 p-4 bg-gray-50/50 dark:bg-[#18181b]/30",
        body: "px-6 py-3"
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <button
              onClick={onClose}
              className="absolute top-8 right-8 p-3 text-gray-400 hover:text-rose-500 hover:bg-rose-500/10 rounded-2xl transition-all z-50 group active:scale-90"
            >
              <X size={24} className="group-hover:rotate-90 transition-transform duration-500" />
            </button>
            <ModalHeader className="flex flex-col gap-1">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-2xl bg-amber-500 flex items-center justify-center text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-amber-500/20 transform -rotate-3">
                  <HandCoins size={24} />
                </div>
                <div className="flex flex-col">
                  <h2 className="text-xl font-medium uppercase tracking-tight tracking-tight leading-tight">
                    CENTRO DE <span className="text-amber-500">PAGOS</span>
                  </h2>
                  <p className="text-[10px] font-medium text-gray-400 uppercase tracking-[0.2em]">Liquidacion de Deudas Activas</p>
                </div>
              </div>
            </ModalHeader>
            <ModalBody>
              {debts.length === 0 ? (
                <div className="py-20 flex flex-col items-center justify-center text-center opacity-40">
                  <div className="h-20 w-20 rounded-2xl bg-black/5 dark:bg-white/5 flex items-center justify-center text-zinc-900 dark:text-zinc-100 mb-4 border-2 border-dashed border-emerald-500/30">
                    <Activity size={32} />
                  </div>
                  <h3 className="text-sm font-medium uppercase tracking-widest text-zinc-900 dark:text-zinc-50">Todo al dia</h3>
                  <p className="text-[10px] font-bold uppercase tracking-tight text-gray-500 mt-1">No hay deudas pendientes registradas.</p>
                </div>
              ) : (
                <ScrollShadow className="max-h-[60vh] space-y-6 pr-2">
                  {Object.entries(groupedDebts).map(([creditor, creditorDebts]) => (
                    <div key={creditor} className="flex flex-col gap-3">
                      <h3 className="text-sm font-bold text-amber-500 uppercase tracking-widest border-b border-amber-500/20 pb-1">
                        {creditor}
                      </h3>
                      {creditorDebts.map((debt) => {
                        const currentDebtAmountValue = debt.remainingAmount > 0 ? debt.remainingAmount : Number(debt.amount);
                        const isSettling = currentDebtId === String(debt.id);

                        return (
                          <div
                            key={debt.id}
                            className={`group relative overflow-hidden transition-all duration-500 ${isSettling
                                ? 'bg-amber-50 dark:bg-amber-500/5 ring-2 ring-amber-500/50'
                                : 'bg-gray-50/50 dark:bg-[#18181b]/40 hover:bg-white dark:hover:bg-[#18181b] border border-gray-100 dark:border-white/5'
                              } rounded-2xl p-5`}
                          >
                            <div className="flex justify-between items-start gap-4">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <Chip size="sm" variant="flat" className="bg-amber-500/10 text-amber-500 text-[8px] font-medium uppercase h-5 tracking-tight border-none">
                                    DEUDA ACTIVA
                                  </Chip>
                                  <span className="text-[8px] font-medium text-gray-300 dark:text-zinc-600 uppercase tracking-widest">#{String(debt.id).slice(-6).toUpperCase()}</span>
                                </div>
                                <h4 className="text-[13px] font-medium text-zinc-900 dark:text-zinc-50 uppercase leading-tight truncate">
                                  {debt.description}
                                </h4>
                              </div>
                              <div className="text-right flex flex-col items-end">
                                <span className="text-[9px] font-medium text-rose-500 uppercase tracking-tight tracking-widest leading-none mb-1">Pendiente</span>
                                <span className="text-2xl font-medium text-zinc-900 dark:text-zinc-50 tabular-nums leading-none tracking-tighter tracking-tight">
                                  ${currentDebtAmountValue.toLocaleString()}
                                </span>
                              </div>
                            </div>

                            {/* AREA DE ACCION / EXPANSION */}
                            <div className="mt-5 border-t border-gray-200/50 dark:border-white/5 pt-4">
                                <div className="flex gap-2">
                                  <Button
                                    className="flex-1 h-12 bg-[#18181b] dark:bg-white text-white dark:text-black rounded-2xl font-medium uppercase tracking-widest tracking-tight text-[11px] shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all hover:scale-[1.01] active:scale-98 flex items-center justify-center gap-2 group"
                                    onPress={() => { 
                                      setCurrentDebtId(String(debt.id)); 
                                      setCurrentDebtAmount(currentDebtAmountValue);
                                      setIsPaymentModalOpen(true); 
                                    }}
                                  >
                                    <HandCoins size={16} className="group-hover:rotate-12 transition-transform" />
                                    Abonar
                                    <ChevronRight size={14} className="group-hover:translate-x-1 transition-transform" />
                                  </Button>
                                  {isAdmin && onForceClose && (
                                    <Button
                                      className="h-12 w-12 min-w-12 bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white rounded-2xl transition-all shadow-none shrink-0"
                                      onPress={async () => {
                                        if (confirm(`¿Estás seguro de forzar el cierre (Condonar) de la deuda #${debt.id} sin generar un comprobante de egreso?`)) {
                                          setIsProcessing(true);
                                          await onForceClose(String(debt.id));
                                          setIsProcessing(false);
                                        }
                                      }}
                                      isLoading={isProcessing && currentDebtId === String(debt.id)}
                                      title="Condonar / Quitar sin Egreso"
                                    >
                                      <X size={18} />
                                    </Button>
                                  )}
                                </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </ScrollShadow>
              )}
            </ModalBody>
            <ModalFooter className="flex justify-between items-center">
              <div className="flex flex-col">
                <span className="text-[10px] font-medium text-gray-400 uppercase tracking-widest">Total por pagar</span>
                <span className="text-xl font-medium text-rose-500 tabular-nums leading-none">
                  ${debts.reduce((acc, d) => acc + (d.remainingAmount > 0 ? d.remainingAmount : Number(d.amount)), 0).toLocaleString()}
                </span>
              </div>
              <Button
                variant="flat"
                className="bg-gray-200/50 dark:bg-[#18181b] text-zinc-900 dark:text-zinc-50 font-medium uppercase text-[10px] rounded-2xl px-8"
                onPress={onClose}
              >
                Cerrar Centro
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>

      <ExpensePaymentModal
        isOpen={isPaymentModalOpen}
        onOpenChange={setIsPaymentModalOpen}
        title="Liquidar Deuda"
        totalToPay={currentDebtAmount}
        onPay={handleSettleClick}
      />
    </Modal>
  );
};

export default PendingDebtsModal;
