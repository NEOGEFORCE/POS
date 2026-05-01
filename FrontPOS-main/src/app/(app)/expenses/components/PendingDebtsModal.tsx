"use client";

import React, { useState } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Button, ScrollShadow, Chip
} from "@heroui/react";
import {
  HandCoins, Activity, Banknote, Wallet, Building2,
  CreditCard as CardIcon, ChevronRight, Info, X
} from 'lucide-react';
import { Expense } from '@/lib/definitions';

interface PendingDebtsModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  debts: Expense[];
  onSettle: (id: string, paymentSource: string) => Promise<void>;
}

const PendingDebtsModal = ({ isOpen, onOpenChange, debts, onSettle }: PendingDebtsModalProps) => {
  const [settlingId, setSettlingId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleSettleClick = async (id: string, source: string) => {
    setIsProcessing(true);
    try {
      await onSettle(id, source);
      setSettlingId(null);
    } finally {
      setIsProcessing(false);
    }
  };

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
        footer: "border-t border-gray-50 dark:border-white/5 p-4 bg-gray-50/50 dark:bg-zinc-900/30",
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
                <div className="h-12 w-12 rounded-2xl bg-amber-500 flex items-center justify-center text-white shadow-xl shadow-amber-500/20 transform -rotate-3">
                  <HandCoins size={24} />
                </div>
                <div className="flex flex-col">
                  <h2 className="text-xl font-black uppercase tracking-tight italic leading-tight">
                    CENTRO DE <span className="text-amber-500">PAGOS</span>
                  </h2>
                  <p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em]">Liquidación de Deudas Activas</p>
                </div>
              </div>
            </ModalHeader>
            <ModalBody>
              {debts.length === 0 ? (
                <div className="py-20 flex flex-col items-center justify-center text-center opacity-40">
                  <div className="h-20 w-20 rounded-full bg-emerald-500/10 flex items-center justify-center text-emerald-500 mb-4 border-2 border-dashed border-emerald-500/30">
                    <Activity size={32} />
                  </div>
                  <h3 className="text-sm font-black uppercase tracking-widest text-gray-900 dark:text-white">Todo al día</h3>
                  <p className="text-[10px] font-bold uppercase tracking-tight text-gray-500 mt-1">No hay deudas pendientes registradas.</p>
                </div>
              ) : (
                <ScrollShadow className="max-h-[60vh] space-y-4 pr-2">
                  {debts.map((debt) => (
                    <div
                      key={debt.id}
                      className={`group relative overflow-hidden transition-all duration-500 ${settlingId === debt.id
                          ? 'bg-amber-50 dark:bg-amber-500/5 ring-2 ring-amber-500/50'
                          : 'bg-gray-50/50 dark:bg-zinc-900/40 hover:bg-white dark:hover:bg-zinc-900 border border-gray-100 dark:border-white/5'
                        } rounded-3xl p-5`}
                    >
                      <div className="flex justify-between items-start gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <Chip size="sm" variant="flat" className="bg-amber-500/10 text-amber-500 text-[8px] font-black uppercase h-5 italic border-none">
                              DEUDA ACTIVA
                            </Chip>
                            <span className="text-[8px] font-black text-gray-300 dark:text-zinc-600 uppercase tracking-widest">#{String(debt.id).slice(-6).toUpperCase()}</span>
                          </div>
                          <h4 className="text-[13px] font-black text-gray-900 dark:text-white uppercase leading-tight truncate">
                            {debt.description}
                          </h4>
                          <div className="flex items-center gap-2 mt-2">
                            <div className="flex items-center gap-1 bg-white dark:bg-zinc-950 px-2 py-0.5 rounded-lg border border-gray-100 dark:border-white/5 shadow-sm">
                              <Info size={10} className="text-amber-500" />
                              <span className="text-[9px] font-black text-gray-500 dark:text-zinc-400 uppercase italic">Acreedor: {debt.lenderName}</span>
                            </div>
                          </div>
                        </div>
                        <div className="text-right flex flex-col items-end">
                          <span className="text-[9px] font-black text-rose-500 uppercase italic tracking-widest leading-none mb-1">Pendiente</span>
                          <span className="text-2xl font-black text-gray-900 dark:text-white tabular-nums leading-none tracking-tighter italic">
                            ${Number(debt.amount).toLocaleString()}
                          </span>
                        </div>
                      </div>

                      {/* AREA DE ACCION / EXPANSION */}
                      <div className="mt-5 border-t border-gray-200/50 dark:border-white/5 pt-4">
                        {settlingId === debt.id ? (
                          <div className="animate-in slide-in-from-bottom-4 fade-in duration-500">
                            <p className="text-[9px] font-black text-amber-600 dark:text-amber-400 uppercase tracking-widest text-center mb-4">¿Con qué canal deseas saldar esta deuda?</p>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                              {[
                                { id: 'EFECTIVO', label: 'Caja', icon: <Banknote size={16} />, color: 'emerald' },
                                { id: 'NEQUI', label: 'Nequi', icon: <Wallet size={16} />, color: 'pink' },
                                { id: 'DAVIPLATA', label: 'Davi', icon: <Building2 size={16} />, color: 'rose' },
                                { id: 'FONDO', label: 'Fondo', icon: <Building2 size={16} />, color: 'blue' }
                              ].map((source) => (
                                <Button
                                  key={source.id}
                                  isLoading={isProcessing}
                                  className={`h-16 rounded-2xl border border-transparent transition-all hover:scale-[1.02] active:scale-95 flex flex-col items-center justify-center gap-1 bg-white dark:bg-zinc-950 shadow-sm hover:border-${source.color}-500 group`}
                                  onPress={() => handleSettleClick(debt.id, source.id)}
                                >
                                  <div className={`text-${source.color}-500 group-hover:scale-110 transition-transform`}>{source.icon}</div>
                                  <span className="text-[9px] font-black uppercase italic tracking-tighter">{source.label}</span>
                                </Button>
                              ))}
                            </div>
                            <Button
                              variant="light"
                              size="sm"
                              fullWidth
                              className="mt-4 text-[9px] font-black uppercase text-gray-400"
                              onPress={() => setSettlingId(null)}
                            >
                              Cancelar
                            </Button>
                          </div>
                        ) : (
                          <Button
                            className="w-full h-12 bg-zinc-900 dark:bg-white text-white dark:text-black rounded-2xl font-black uppercase tracking-widest italic text-[11px] shadow-xl transition-all hover:scale-[1.01] active:scale-98 flex items-center justify-center gap-2 group"
                            onPress={() => setSettlingId(debt.id)}
                          >
                            <HandCoins size={16} className="group-hover:rotate-12 transition-transform" />
                            Saldar Deuda Total
                            <ChevronRight size={14} className="group-hover:translate-x-1 transition-transform" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </ScrollShadow>
              )}
            </ModalBody>
            <ModalFooter className="flex justify-between items-center">
              <div className="flex flex-col">
                <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Total por pagar</span>
                <span className="text-xl font-black text-rose-500 tabular-nums leading-none">
                  ${debts.reduce((acc, d) => acc + Number(d.amount), 0).toLocaleString()}
                </span>
              </div>
              <Button
                variant="flat"
                className="bg-gray-200/50 dark:bg-white/5 text-gray-900 dark:text-white font-black uppercase text-[10px] rounded-2xl px-8"
                onPress={onClose}
              >
                Cerrar Centro
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
};

export default PendingDebtsModal;
