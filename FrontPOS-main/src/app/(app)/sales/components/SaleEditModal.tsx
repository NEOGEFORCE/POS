"use client";

import { useMemo, useState } from 'react';
import Cookies from 'js-cookie';
import { Sale } from '@/lib/definitions';
import { useToast } from '@/hooks/use-toast';
import { ApiError, extractApiError } from '@/lib/api-error';
import UniversalPaymentModal from '@/components/shared/UniversalPaymentModal';
import { broadcastRevalidate } from '@/lib/revalidate';
import { API_URL } from '@/lib/constants';
import { useAuth } from '@/lib/auth';
import {
    initialPaidAmountsFromSale,
    resolvePaymentCorrectionEndpoint,
    validateEmployeeCorrectionPayload,
} from '@/lib/payment-correction.mjs';

interface SaleEditModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    sale: Sale | null;
    customers: any[];
    onClientSelectorOpen: () => void;
    onSuccess: (change: number) => void;
}

/**
 * Corrección del canal de pago de una venta ya registrada.
 *
 * - ADMIN: usa `PUT /sales/update-payment/:id`. Puede mover a/desde FIADO,
 *   cambiar cliente, etc. (comportamiento legacy).
 * - EMPLEADO del mismo turno: usa `POST /sales/correct-payment-channel/:id`.
 *   Sólo redistribuye entre efectivo + canales de transferencia; no puede
 *   cambiar el total ni tocar fiado. Las acotaciones viven en
 *   `src/lib/payment-correction.mjs` y las aplica también el backend.
 *
 * NO uses POST para eludir seguridad: ambos endpoints son protegidos por
 * middleware distinto. El cambio de verbo es semántico; la autoridad final
 * sigue siendo el backend que valida actor, turno, devoluciones y fiado.
 */
export default function SaleEditModal({
    isOpen,
    onOpenChange,
    sale,
    onClientSelectorOpen,
    onSuccess
}: SaleEditModalProps) {
    const { toast } = useToast();
    const { user } = useAuth();
    const [isUpdating, setIsUpdating] = useState(false);
    const [showSuccessScreen, setShowSuccessScreen] = useState(false);
    const [lastChange, setLastChange] = useState(0);

    // El modal se queda con los datos de la venta ACTUAL para evitar
    // redigitar los montos. Antes se forzaba a cero y el empleado tenía que
    // escribir todo de nuevo.
    const initialPaidAmounts = useMemo(() => sale ? initialPaidAmountsFromSale(sale) : undefined, [sale]);

    // Decide el endpoint según el rol del usuario. Si no hay elegibilidad
    // (empleado no autorizado), el padre nunca abre este modal (SalesTable
    // oculta el botón), pero defendemos con un fallback explícito.
    const endpoint = useMemo(() => {
        if (!sale || !user) return null;
        // shiftOpen=true: la UI confía en que el padre no abra el modal con
        // el turno cerrado; el backend valida y devolverá 403 en todo caso.
        return resolvePaymentCorrectionEndpoint(sale, user, { shiftOpen: true });
    }, [sale, user]);

    const handleSaveEdit = async (data: {
        cash: number;
        transfer: number;
        transferSource: string;
        transferNequi?: number;
        transferDaviplata?: number;
        credit: number;
        totalPaid: number;
        change: number;
    }) => {
        if (!sale || !endpoint) return;
        setIsUpdating(true);
        const {
            cash,
            transfer,
            transferSource,
            transferNequi = 0,
            transferDaviplata = 0,
            credit,
            totalPaid,
            change,
        } = data;

        try {
            // El backend recomputa `paymentMethod` desde los montos (ver
            // `deriveSalePaymentMethod` en sale_service_update.go). Igual
            // enviamos un string consistente para que, si el payload se audita
            // antes de persistir, aparezca ya con el desglose correcto en
            // lugar del literal generico "MIXTO".
            const methodParts: string[] = [];
            if (cash > 0) methodParts.push("EFECTIVO");
            if (transferNequi > 0) methodParts.push("NEQUI");
            if (transferDaviplata > 0) methodParts.push("DAVIPLATA");
            const otherTransfer = transfer - transferNequi - transferDaviplata;
            if (otherTransfer > 0.5) {
                const rawSrc = (transferSource || "").toUpperCase().trim();
                const forbidden = new Set(["", "MIXTO", "NEQUI", "DAVIPLATA"]);
                methodParts.push(forbidden.has(rawSrc) ? "TRANSFERENCIA" : rawSrc);
            }
            if (credit > 0) methodParts.push("FIADO");
            const paymentMethod = methodParts.length === 0
                ? "EFECTIVO"
                : methodParts.join(" + ");

            const payload = {
                clientDni: sale.client?.dni || '0',
                paymentMethod: paymentMethod,
                cashAmount: cash,
                transferAmount: transfer,
                transferSource: transferSource,
                // El desglose Nequi/Daviplata debe viajar también al corregir el
                // método de pago. Sin esto, una venta 100% Nequi se convertía en
                // "otras transferencias" al editarla.
                transferNequi: transferNequi,
                transferDaviplata: transferDaviplata,
                creditAmount: credit,
                amountPaid: totalPaid,
                change: change
            };

            // Pre-chequeo de empleado antes de salir a red. Son las mismas
            // validaciones que impone el backend; evitan un round-trip 409.
            if (endpoint.actor === "employee") {
                const check = validateEmployeeCorrectionPayload(payload, sale);
                if (!check.ok) {
                    toast({
                        variant: "destructive",
                        title: "NO SE PUEDE CORREGIR",
                        description: check.error === "credit-not-allowed"
                            ? "Como empleado no puedes mover montos a/desde FIADO."
                            : check.error === "total-mismatch"
                                ? "La suma de canales debe mantener el mismo total."
                                : check.error === "transfer-breakdown-exceeds-total"
                                    ? "El desglose Nequi+Daviplata no puede superar el total de transferencia."
                                    : check.error === "negative-amount"
                                        ? "Las magnitudes no pueden ser negativas."
                                        : "El payload no cumple las reglas del empleado.",
                    });
                    setIsUpdating(false);
                    return;
                }
            }

            const res = await fetch(`${API_URL}${endpoint.path}`, {
                method: endpoint.method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${Cookies.get('org-pos-token')}`
                },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                // Mensajes claros según status: 403 = sin permiso, 409 =
                // regla violada (devoluciones, turno cerrado, etc.).
                const errorMsg = await extractApiError(res, "Error al actualizar pago");
                if (res.status === 403) {
                    throw new ApiError(
                        `No tienes permiso para corregir esta venta. ${errorMsg}`,
                        403,
                    );
                }
                if (res.status === 409) {
                    throw new ApiError(
                        `No se puede corregir: ${errorMsg}`,
                        409,
                    );
                }
                throw new ApiError(errorMsg, res.status);
            }

            setLastChange(change);
            setShowSuccessScreen(true);
            broadcastRevalidate('SALE_MADE');
            toast({ title: "✓ Actualizado", description: "El metodo de pago ha sido corregido." });
            onSuccess(change);
        } catch (err: any) {
            toast({
                variant: "destructive",
                title: err instanceof ApiError && err.status === 403 ? "Sin permiso" : "Error",
                description: err.message || "Error al actualizar pago",
            });
        } finally {
            setIsUpdating(false);
        }
    };

    if (!sale) return null;
    // Si el usuario no tiene autorización no renderizamos el modal: la tabla
    // ya ocultó el botón, pero esta guarda defensiva evita que un atajo de
    // teclado lo dispare para un rol sin permiso.
    if (!endpoint) return null;

    return (
        <UniversalPaymentModal
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title="Corregir Pago"
            client={sale.client || null}
            totalToPay={sale.total}
            initialPaidAmounts={initialPaidAmounts}
            // El empleado NO puede dejar la venta en fiado: ocultamos el tab.
            showCreditTab={endpoint.actor === "admin"}
            showSuccessScreen={showSuccessScreen}
            submittingPayment={isUpdating}
            lastChange={lastChange}
            onPay={handleSaveEdit}
            onClientSelectorOpen={onClientSelectorOpen}
            onCloseComplete={() => {
                if (showSuccessScreen) window.location.reload();
            }}
        />
    );
}
