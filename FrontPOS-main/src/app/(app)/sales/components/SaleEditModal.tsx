"use client";

import {
    Modal, ModalContent, Button
} from "@heroui/react";
import { 
    Banknote, Wallet, History as HistoryIcon, User, Zap, ChevronDown, Check as CheckIcon 
} from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import Cookies from 'js-cookie';
import { Sale } from '@/lib/definitions';
import { useToast } from '@/hooks/use-toast';
import { extractApiError } from '@/lib/api-error';
import UniversalPaymentModal from '@/components/shared/UniversalPaymentModal';
import dynamic from 'next/dynamic';

interface SaleEditModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    sale: Sale | null;
    customers: any[];
    onClientSelectorOpen: () => void;
    onSuccess: (change: number) => void;
}

export default function SaleEditModal({ 
    isOpen, 
    onOpenChange, 
    sale, 
    customers, 
    onClientSelectorOpen,
    onSuccess 
}: SaleEditModalProps) {
    const { toast } = useToast();
    const [isUpdating, setIsUpdating] = useState(false);
    const [showSuccessScreen, setShowSuccessScreen] = useState(false);
    const [lastChange, setLastChange] = useState(0);

    const initialPaidAmounts = sale ? {
        cash: sale.cashAmount || 0,
        transfer: sale.transferAmount || 0,
        transferSource: sale.transferSource || 'NEQUI',
        credit: sale.creditAmount || 0
    } : undefined;

    const handleSaveEdit = async (data: {
        cash: number;
        transfer: number;
        transferSource: string;
        credit: number;
        totalPaid: number;
        change: number;
    }) => {
        if (!sale) return;
        setIsUpdating(true);
        const { cash, transfer, transferSource, credit, totalPaid, change } = data;
        
        try {
            const payload = {
                clientDni: sale.client?.dni || '0',
                paymentMethod: credit > 0 ? "FIADO" : (cash > 0 && transfer > 0 ? "MIXTO" : transfer > 0 ? "TRANSFERENCIA" : "EFECTIVO"),
                cashAmount: cash,
                transferAmount: transfer,
                transferSource: transferSource,
                creditAmount: credit,
                amountPaid: totalPaid,
                change: change
            };

            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api'}/sales/update-payment/${sale.id}`, {
                method: 'PUT',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${Cookies.get('org-pos-token')}` 
                },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const errorMsg = await extractApiError(res, "Error al actualizar pago");
                throw new Error(errorMsg);
            }
            
            setLastChange(change);
            setShowSuccessScreen(true);
            toast({ title: "✓ Actualizado", description: "El método de pago ha sido corregido." });
            onSuccess(change);
        } catch (err: any) {
            toast({ variant: "destructive", title: "Error", description: err.message || "Error al actualizar pago" });
        } finally {
            setIsUpdating(false);
        }
    };

    if (!sale) return null;

    const selectedCustomer = sale.client || { name: 'Consumidor Final' };

    return (
        <UniversalPaymentModal 
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title="Corregir Pago"
            client={sale.client}
            totalToPay={sale.total}
            initialPaidAmounts={initialPaidAmounts}
            showSuccessScreen={showSuccessScreen}
            submittingPayment={isUpdating}
            lastChange={lastChange}
            onPay={handleSaveEdit}
            onCloseComplete={() => {
                if (showSuccessScreen) window.location.reload();
            }}
        />
    );
}
