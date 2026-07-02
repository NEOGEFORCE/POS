"use client";

import React from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button } from "@heroui/react";
import { AlertTriangle, HelpCircle, Info } from 'lucide-react';
import { motion } from 'framer-motion';

interface ConfirmDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => void;
  confirmText?: string;
  cancelText?: string;
  type?: 'danger' | 'warning' | 'info' | 'success';
}

export const ConfirmDialog = ({
  isOpen, onOpenChange, title, description, onConfirm, 
  confirmText = "Confirmar", cancelText = "Cancelar", type = 'warning'
}: ConfirmDialogProps) => {
  const isDanger = type === 'danger';
  
  const getColors = () => {
    switch (type) {
      case 'danger': return { border: 'border-rose-500', text: 'text-rose-500', btn: 'bg-rose-500', shadow: 'shadow-rose-500/20', icon: AlertTriangle };
      case 'warning': return { border: 'border-amber-500', text: 'text-amber-500', btn: 'bg-amber-500', shadow: 'shadow-amber-500/20', icon: AlertTriangle };
      case 'success': return { border: 'border-emerald-500', text: 'text-zinc-100', btn: 'bg-gray-100 dark:bg-zinc-800 border border-black/5 dark:border-white/5', shadow: '', icon: HelpCircle };
      default: return { border: 'border-sky-500', text: 'text-sky-500', btn: 'bg-sky-500', shadow: 'shadow-sky-500/20', icon: Info };
    }
  };

  const colors = getColors();
  const Icon = colors.icon;

  return (
    <Modal 
      isOpen={isOpen} 
      onOpenChange={onOpenChange}
      backdrop="blur"
      classNames={{
        base: `bg-white dark:bg-zinc-950 border-2 ${colors.border} rounded-[2rem] overflow-hidden`,
        header: "border-b border-black/5 dark:border-white/5 bg-[#18181b]",
        footer: "border-t border-black/5 dark:border-white/5 bg-[#18181b]",
        backdrop: "bg-black/60"
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className={`flex items-center gap-3 py-4 ${colors.text} font-medium tracking-tight`}>
              <motion.div
                initial={{ rotate: -8, scale: 0.8, opacity: 0 }}
                animate={{ rotate: 0, scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 400, damping: 14 }}
                className={`p-2 rounded-2xl bg-[#18181b] border ${colors.border}/20`}
              >
                <Icon size={20} />
              </motion.div>
              <span className="tracking-tighter uppercase">{title}</span>
            </ModalHeader>
            <ModalBody className="py-6">
              <p className="text-white font-bold text-sm leading-relaxed">
                {description}
              </p>
              {isDanger && (
                <p className="text-gray-500 dark:text-zinc-500 text-[10px] uppercase font-medium tracking-widest mt-2 tracking-tight">
                  Esta accion es irreversible. Proporcione cautela.
                </p>
              )}
            </ModalBody>
            <ModalFooter className="gap-3">
              <Button 
                variant="light" 
                onPress={onClose} 
                className="font-medium text-gray-500 dark:text-zinc-400 hover:text-white transition-colors"
              >
                {cancelText.toUpperCase()}
              </Button>
              <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                <Button 
                  onPress={() => { onConfirm(); onClose(); }}
                  className={`${colors.btn} text-white font-medium tracking-tight shadow-[0_8px_30px_rgb(0,0,0,0.12)] ${colors.shadow} rounded-2xl px-8`}
                >
                  {confirmText.toUpperCase()}
                </Button>
              </motion.div>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
};
