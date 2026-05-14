"use client";

import React, { useState } from 'react';
import {
    Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
    Button, Textarea, Spinner
} from "@heroui/react";
import { AlertTriangle, Trash2 } from 'lucide-react';
import { Sale } from '@/lib/definitions';
import { useToast } from '@/hooks/use-toast';
import Cookies from 'js-cookie';

interface SaleDeleteModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    sale: Sale | null;
    onSuccess: () => void;
}

export default function SaleDeleteModal({ isOpen, onOpenChange, sale, onSuccess }: SaleDeleteModalProps) {
    const { toast } = useToast();
    const [reason, setReason] = useState('');
    const [isDeleting, setIsDeleting] = useState(false);

    const handleDelete = async () => {
        if (!sale) return;
        if (!reason.trim()) {
            toast({
                title: "JUSTIFICACIÓN REQUERIDA",
                description: "Debes explicar por qué estás anulando esta venta.",
                variant: "destructive"
            });
            return;
        }

        setIsDeleting(true);
        try {
            const token = Cookies.get('org-pos-token');
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/sales/delete/${sale.id}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ reason: reason.toUpperCase() })
            });

            if (response.status === 401) {
                Cookies.remove('org-pos-token');
                Cookies.remove('org-pos-user');
                window.location.href = '/login?expired=true';
                return;
            }

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Error al anular venta');
            }

            toast({
                title: "VENTA ANULADA",
                description: "La venta ha sido eliminada y el stock restaurado.",
                className: "bg-emerald-500 text-white border-none font-bold"
            });
            
            const { broadcastRevalidate } = await import('@/lib/revalidate');
            broadcastRevalidate('SALE_MADE'); // Refrescar stock y finanzas globalmente

            setReason('');
            onSuccess();
            onOpenChange(false);
        } catch (error: any) {
            toast({
                title: "ERROR",
                description: error.message,
                variant: "destructive"
            });
        } finally {
            setIsDeleting(false);
        }
    };

    return (
        <Modal 
            isOpen={isOpen} 
            onOpenChange={onOpenChange}
            backdrop="blur"
            classNames={{
                base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-2xl",
                header: "border-b border-gray-100 dark:border-white/5",
                footer: "border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-900/30"
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="flex flex-col gap-1">
                            <div className="flex items-center gap-2 text-rose-500">
                                <AlertTriangle size={20} />
                                <h2 className="text-sm font-black uppercase tracking-tighter italic">Confirmar Anulación Crítica</h2>
                            </div>
                        </ModalHeader>
                        <ModalBody className="py-6">
                            <div className="bg-rose-500/5 border border-rose-500/20 rounded-xl p-4 mb-4">
                                <p className="text-[11px] font-bold text-rose-600 dark:text-rose-400 uppercase tracking-widest leading-relaxed">
                                    Esta acción es permanente. Al anular la venta <span className="font-black text-rose-700 dark:text-rose-300">#{sale?.id}</span>:
                                </p>
                                <ul className="mt-2 space-y-1">
                                    <li className="text-[10px] font-black text-rose-500/80 uppercase flex items-center gap-2">
                                        <div className="h-1 w-1 bg-rose-500 rounded-full" /> Se restaurará el stock automáticamente
                                    </li>
                                    <li className="text-[10px] font-black text-rose-500/80 uppercase flex items-center gap-2">
                                        <div className="h-1 w-1 bg-rose-500 rounded-full" /> Se revertirá la deuda del cliente
                                    </li>
                                    <li className="text-[10px] font-black text-rose-500/80 uppercase flex items-center gap-2">
                                        <div className="h-1 w-1 bg-rose-500 rounded-full" /> Se notificará a gerencia vía Telegram
                                    </li>
                                </ul>
                            </div>

                            <div className="space-y-4">
                                <div className="flex justify-between items-center bg-gray-50 dark:bg-zinc-900/50 p-3 rounded-lg border border-gray-100 dark:border-white/5">
                                    <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest italic">Monto a Revertir:</span>
                                    <span className="text-sm font-black text-zinc-900 dark:text-white tabular-nums italic">
                                        ${sale?.total.toLocaleString()}
                                    </span>
                                </div>

                                <Textarea
                                    label="JUSTIFICACIÓN DE LA ANULACIÓN"
                                    placeholder="EJ: ERROR EN REGISTRO DE MONTO / PRODUCTO EQUIVOCADO..."
                                    variant="bordered"
                                    value={reason}
                                    onValueChange={setReason}
                                    classNames={{
                                        label: "text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] italic mb-2",
                                        input: "text-xs font-bold uppercase placeholder:text-gray-300 dark:placeholder:text-zinc-700",
                                        inputWrapper: "border-gray-200 dark:border-white/10 hover:border-rose-500/50 focus-within:border-rose-500 transition-all duration-300 rounded-xl"
                                    }}
                                />
                            </div>
                        </ModalBody>
                        <ModalFooter>
                            <Button 
                                variant="light" 
                                onPress={onClose}
                                className="text-[10px] font-black uppercase tracking-widest text-gray-400 dark:text-zinc-500"
                            >
                                Cancelar
                            </Button>
                            <Button 
                                color="danger"
                                onPress={handleDelete}
                                isLoading={isDeleting}
                                className="bg-rose-500 text-white font-black uppercase tracking-widest text-[10px] h-10 px-6 rounded-xl shadow-lg shadow-rose-500/20 active:scale-95 transition-all"
                                startContent={!isDeleting && <Trash2 size={16} />}
                            >
                                {isDeleting ? 'PROCESANDO...' : 'ANULAR VENTA'}
                            </Button>
                        </ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
}
