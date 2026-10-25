"use client";

import { useCallback, useMemo, useRef, useState } from 'react';
import Cookies from 'js-cookie';
import { Sale } from '@/lib/definitions';
import { useToast } from '@/hooks/use-toast';
import { ApiError, apiFetch, extractApiError } from '@/lib/api-error';
import UniversalPaymentModal from '@/components/shared/UniversalPaymentModal';
import { broadcastRevalidate } from '@/lib/revalidate';
import { API_URL } from '@/lib/constants';
import { useAuth } from '@/lib/auth';
import {
    initialPaidAmountsFromSale,
    resolvePaymentCorrectionEndpoint,
    validateEmployeeCorrectionPayload,
} from '@/lib/payment-correction.mjs';
import {
    BOLD_QR_ALREADY_PAID_SENTINEL,
    buildEncolarPayload,
    buildIniciarPayload,
    buildQrSaleSnapshotPayload,
    generateQrClientTxId,
    isAlreadyPaidResponse,
    type EncolarSalePayload,
} from '@/lib/bold-qr-helpers.mjs';

type QrBreakdown = { cash: number; nequi: number; daviplata: number; credit: number; totalCart: number };
type QrPreparation = { clientTxId: string; monto: number; salePayload: EncolarSalePayload; clientDni: string };

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

    // =================================================================
    // QR Bold en la corrección de pago (sólo admin).
    //
    // El cobro QR se abre con `editSaleId` = id de esta venta: al
    // aprobarse (webhook o asignación manual desde la bandeja global) el
    // backend REEMPLAZA el desglose de ESTA venta, no crea otra. Los
    // productos no cambian: el snapshot reutiliza los detalles guardados.
    // Si el cajero ya puso parte en efectivo/Nequi/etc. en el modal, esa
    // parte viaja en el desglose y el QR cubre sólo el resto.
    // =================================================================
    const qrPreparationsRef = useRef<Map<string, QrPreparation>>(new Map());
    const canUseQr = endpoint?.actor === 'admin';
    const editSaleId = sale ? Number.parseInt(String(sale.id), 10) : NaN;
    const cajaId = (typeof user?.dni === 'string' && user.dni.trim()) || 'CAJA';

    const buildSnapshot = useCallback((qrAmount: number, breakdown: QrBreakdown) => {
        if (!sale || !Array.isArray(sale.details) || sale.details.length === 0) return null;
        const details = sale.details.map((d) => ({
            barcode: String(d.barcode || ''),
            quantity: Number(d.quantity) || 0,
            unitPrice: Number(d.unitPrice) || 0,
            subtotal: Number(d.subtotal) || 0,
        }));
        return buildQrSaleSnapshotPayload({
            details,
            qrAmount,
            breakdown: { ...breakdown, totalCart: Math.round(Number(sale.total) || breakdown.totalCart) },
            employeeDni: user?.dni || '',
            clientDni: sale.client?.dni || '0',
            clientName: sale.client?.name || '',
            editSaleId: Number.isFinite(editSaleId) ? editSaleId : undefined,
        });
    }, [sale, user, editSaleId]);

    const prepareBoldQrIntent = useCallback(async (amount: number, ventaTempId: string, breakdown: QrBreakdown) => {
        const temp = typeof ventaTempId === 'string' ? ventaTempId.trim() : '';
        const monto = Math.round(Number(amount) || 0);
        if (!temp || monto <= 0) throw new Error('Monto inválido para el cobro QR');
        const salePayload = buildSnapshot(monto, {
            cash: Math.max(0, Math.round(breakdown?.cash || 0)),
            nequi: Math.max(0, Math.round(breakdown?.nequi || 0)),
            daviplata: Math.max(0, Math.round(breakdown?.daviplata || 0)),
            credit: Math.max(0, Math.round(breakdown?.credit || 0)),
            totalCart: Math.max(monto, Math.round(breakdown?.totalCart || 0)),
        });
        if (!salePayload) throw new Error('La venta no tiene productos para cobrar por QR');
        const clientTxId = generateQrClientTxId();
        const clientDni = sale?.client?.dni || '';
        const payload = buildIniciarPayload({
            caja_id: cajaId,
            monto,
            venta_temp_id: temp,
            client_tx_id: clientTxId,
            client_dni: clientDni,
            cashier_name: user?.name || '',
            sale_payload: salePayload,
        });
        if (!payload) throw new Error('Datos inválidos para preparar el cobro QR');
        const res = await apiFetch('/pos/pagos-qr/iniciar', {
            method: 'POST',
            body: JSON.stringify(payload),
            fallbackError: 'No se pudo preparar el cobro QR',
            timeoutMs: 10000,
        });
        if (isAlreadyPaidResponse(res)) {
            toast({ title: 'YA PAGADO', description: 'Este cobro QR ya fue aprobado.' });
            onOpenChange(false);
            throw new Error(BOLD_QR_ALREADY_PAID_SENTINEL);
        }
        qrPreparationsRef.current.set(temp, { clientTxId, monto, salePayload, clientDni });
    }, [buildSnapshot, cajaId, sale, user, toast, onOpenChange]);

    // "Dejar en espera": útil para enlazar un pago ya recibido desde la
    // bandeja global (Pagos por asignar → Asignar) sin tener el modal abierto.
    const handleBoldQrEnqueueRequested = useCallback(async (ventaTempId: string, monto: number) => {
        const temp = typeof ventaTempId === 'string' ? ventaTempId.trim() : '';
        const stored = qrPreparationsRef.current.get(temp);
        if (!temp || !stored) throw new Error('Vuelve a abrir el cobro QR antes de dejarlo en espera');
        const payload = buildEncolarPayload({
            ventaTempId: temp,
            cajaId,
            monto: Math.round(Number(monto) || stored.monto),
            clientTxId: stored.clientTxId,
            cashierName: user?.name || '',
            clientDni: stored.clientDni,
            salePayload: stored.salePayload,
            editSaleId: Number.isFinite(editSaleId) ? editSaleId : undefined,
        });
        if (!payload) throw new Error('Datos inválidos para dejar en espera el cobro QR');
        await apiFetch('/pos/pagos-qr/encolar', {
            method: 'POST',
            body: JSON.stringify(payload),
            fallbackError: 'No se pudo dejar en espera el cobro QR',
            timeoutMs: 10000,
        });
        toast({
            title: 'COBRO QR EN ESPERA',
            description: `Cuando el pago se apruebe o lo asignes en "Pagos por asignar", se actualizará la venta #${sale?.id}.`,
        });
        onOpenChange(false);
    }, [cajaId, editSaleId, sale, user, toast, onOpenChange]);

    const handleBoldQrFinalized = useCallback((info: { saleId: number }) => {
        broadcastRevalidate('SALE_MADE');
        toast({ title: 'VENTA ACTUALIZADA', description: `El pago por QR Bold quedó registrado en la venta #${info?.saleId || sale?.id}.` });
        setLastChange(0);
        setShowSuccessScreen(true);
        onSuccess(0);
    }, [sale, toast, onSuccess]);

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
            onBoldQrRequested={canUseQr ? prepareBoldQrIntent : undefined}
            onBoldQrEnqueueRequested={canUseQr ? handleBoldQrEnqueueRequested : undefined}
            onBoldQrFinalized={canUseQr ? handleBoldQrFinalized : undefined}
            onClientSelectorOpen={onClientSelectorOpen}
            onCloseComplete={() => {
                if (showSuccessScreen) window.location.reload();
            }}
        />
    );
}
