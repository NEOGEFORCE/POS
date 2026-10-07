"use client";

/**
 * LabelPrintSheet
 *
 * Hoja compacta para imprimir etiquetas unitarias asociadas a un producto
 * del carrito de recepción. Se abre desde ReceptionRow (botón Printer).
 *
 * Contrato operativo (lo que valida el test estático):
 *   1. SOLO se abre DESPUÉS de que la recepción se confirmó (POST al
 *      endpoint de recepción). Si falla la impresión o el bridge local,
 *      la recepción YA está guardada en stock y el usuario puede
 *      reimprimir desde /labels sin perder nada.
 *   2. Al confirmar imprime N etiquetas usando el flujo existente
 *      POST /labels/codes (idempotente) → POST /labels/print-jobs.
 *      Reimpresión usa el MISMO `code` del producto; nunca duplica.
 *   3. Si window.posBridge?.print existe, delega al bridge local; si no,
 *      cae a window.print() como fallback audible. El POST a
 *      /labels/print-jobs queda auditado independientemente.
 */

import { useEffect, useState } from 'react';
import {
    Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
    Button, Input,
} from '@heroui/react';
import { Printer, Minus, Plus, Info } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { apiFetch } from '@/lib/api-error';
import Cookies from 'js-cookie';
import { loadPrintingConfig } from '@/lib/printing-config.mjs';

interface LabelPrintSheetProps {
    isOpen: boolean;
    onClose: () => void;
    productBarcode: string;
    productName: string;
    /** Cantidad por defecto (típicamente lineItem.addedQuantity). */
    defaultCount: number;
    /** Referencia opcional a la recepción (ej. receptionRef, lineId). */
    receptionRef?: string;
}

export default function LabelPrintSheet({
    isOpen,
    onClose,
    productBarcode,
    productName,
    defaultCount,
    receptionRef,
}: LabelPrintSheetProps) {
    const { toast } = useToast();
    const [count, setCount] = useState<string>(String(Math.max(1, Math.floor(defaultCount || 1))));
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (!isOpen) return;
        setCount(String(Math.max(1, Math.floor(defaultCount || 1))));
    }, [isOpen, defaultCount]);

    const parsed = Math.max(0, Math.floor(Number(count) || 0));
    const canSubmit = parsed >= 1;

    const handlePrint = async () => {
        if (!canSubmit || submitting) return;
        setSubmitting(true);
        try {
            const token = Cookies.get('org-pos-token');
            // 1. Asegurar el code persistente del producto (idempotente).
            const ensure = await apiFetch<{ code: { code: string }; created: boolean }>(
                '/labels/codes',
                {
                    method: 'POST',
                    body: JSON.stringify({ productBarcode }),
                    fallbackError: 'No se pudo generar el código de etiqueta',
                },
                token,
            );
            const code = ensure?.code?.code;
            if (!code) {
                throw new Error('El servidor no devolvió un code válido');
            }

            // 2. Auditar el trabajo de impresión. Usamos trigger="new" en
            //    primera impresión; si el code ya existía, el flujo sigue
            //    pero el frontend NO cambia el trigger: new/reprint queda
            //    determinado por el histórico de /labels/codes/search.
            const payloadMeta: Record<string, any> = { productBarcode, source: 'receive' };
            if (receptionRef) payloadMeta.receptionRef = receptionRef;
            await apiFetch(
                '/labels/print-jobs',
                {
                    method: 'POST',
                    body: JSON.stringify({
                        triggerSource: ensure?.created ? 'new' : 'reprint',
                        items: [{ code, quantity: parsed }],
                        meta: payloadMeta,
                    }),
                    fallbackError: 'No se pudo auditar el trabajo de impresión',
                },
                token,
            );

            // 3. Enviar al bridge local si existe; si no, fallback a
            //    window.print() para que al menos el navegador muestre
            //    el diálogo. Si el bridge arroja, caemos al mismo
            //    diálogo con un toast de advertencia: la auditoria ya
            //    quedó registrada y el stock NO se revierte.
            //    Enriquecemos el payload del bridge con la configuración
            //    sanitizada de /labels/config (sólo rama connection + labels)
            //    para que el bridge sepa qué impresora y qué formato usar
            //    sin tener que leer LocalStorage por su cuenta.
            const printingConfig = loadPrintingConfig();
            const bridgePayload = {
                code,
                productName,
                quantity: parsed,
                connection: printingConfig.connection,
                labels: printingConfig.labels,
            };
            const bridge = (globalThis as any)?.window?.posBridge;
            let bridgeFailed = false;
            if (bridge && typeof bridge.print === 'function') {
                try {
                    await bridge.print(bridgePayload);
                } catch (err: any) {
                    bridgeFailed = true;
                    toast({
                        variant: 'destructive',
                        title: 'BRIDGE LOCAL FALLÓ',
                        description: `${err?.message || 'El bridge local no respondió.'} — abriendo diálogo del navegador. El trabajo ya está auditado en /labels.`,
                    });
                }
            }
            if ((bridgeFailed || !bridge || typeof bridge.print !== 'function') && typeof window !== 'undefined' && typeof window.print === 'function') {
                // Fallback: diálogo del navegador. Audible aunque no haya hardware.
                window.print();
            }

            toast({
                variant: 'success',
                title: 'ETIQUETAS ENVIADAS',
                description: `${parsed} ${parsed === 1 ? 'etiqueta' : 'etiquetas'} de ${productName}.`,
            });
            onClose();
        } catch (err: any) {
            toast({
                variant: 'destructive',
                title: 'NO SE PUDO IMPRIMIR',
                description: err?.message || 'Fallo desconocido. La recepción ya está guardada; reintenta desde /labels.',
                duration: 10000,
            });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            placement="center"
            size="sm"
            classNames={{
                base: "bg-white dark:bg-[#121214] rounded-2xl mx-2 w-screen max-w-[100vw] sm:max-w-sm sm:w-auto",
                wrapper: "items-center justify-center p-2",
            }}
        >
            <ModalContent>
                <ModalHeader className="flex items-center gap-3 border-b border-gray-200 dark:border-white/10 px-5 py-4">
                    <div className="h-10 w-10 rounded-2xl bg-sky-500 flex items-center justify-center shadow-md">
                        <Printer size={18} className="text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 className="text-base font-semibold uppercase tracking-tight text-gray-900 dark:text-white">
                            Imprimir etiquetas
                        </h2>
                        <p className="text-[11px] text-gray-400 mt-0.5 truncate">
                            {productName}
                        </p>
                    </div>
                </ModalHeader>

                <ModalBody className="px-5 py-5 space-y-4 min-h-0 min-w-0">
                    <div className="space-y-1.5">
                        <label className="text-[10px] font-bold uppercase text-gray-400 tracking-widest ml-1">
                            Cantidad de etiquetas
                        </label>
                        <div className="flex items-center gap-2">
                            <Button
                                isIconOnly
                                variant="flat"
                                radius="lg"
                                aria-label="Restar etiqueta"
                                onClick={() => setCount(String(Math.max(1, parsed - 1)))}
                                className="h-14 w-14 min-w-0 bg-gray-100 dark:bg-[#1a1a1d] border border-gray-200 dark:border-white/10"
                            >
                                <Minus size={16} />
                            </Button>
                            <Input
                                type="number"
                                inputMode="numeric"
                                min={1}
                                step={1}
                                value={count}
                                onValueChange={(v) => setCount(v.replace(/[^\d]/g, ''))}
                                variant="flat"
                                radius="lg"
                                classNames={{
                                    input: "text-center text-xl font-bold text-gray-900 dark:text-white",
                                    inputWrapper: "h-14 bg-gray-100 dark:bg-[#1a1a1d] border border-gray-200 dark:border-white/10",
                                }}
                            />
                            <Button
                                isIconOnly
                                variant="flat"
                                radius="lg"
                                aria-label="Sumar etiqueta"
                                onClick={() => setCount(String(parsed + 1))}
                                className="h-14 w-14 min-w-0 bg-gray-100 dark:bg-[#1a1a1d] border border-gray-200 dark:border-white/10"
                            >
                                <Plus size={16} />
                            </Button>
                        </div>
                    </div>

                    <div className="rounded-2xl bg-sky-50 dark:bg-sky-900/20 border border-sky-500/30 px-4 py-3 text-[12px] text-sky-700 dark:text-sky-200 flex items-start gap-2">
                        <Info size={14} className="shrink-0 mt-0.5" />
                        <span>
                            Se usará el <strong>mismo código persistente</strong> del producto en
                            futuras reimpresiones. Si no hay bridge local de impresora, se abre el
                            diálogo del navegador y el trabajo queda <strong>auditado</strong> en
                            /labels.
                        </span>
                    </div>
                </ModalBody>

                <ModalFooter
                    className="border-t border-gray-200 dark:border-white/10 px-5 py-3 gap-2"
                    style={{ paddingBottom: `max(0.75rem, env(safe-area-inset-bottom))` }}
                >
                    <Button
                        variant="light"
                        onPress={onClose}
                        isDisabled={submitting}
                        className="font-medium uppercase tracking-wider text-xs text-gray-500 dark:text-gray-400"
                    >
                        Cancelar
                    </Button>
                    <Button
                        color="primary"
                        onPress={handlePrint}
                        isDisabled={!canSubmit || submitting}
                        isLoading={submitting}
                        className="font-semibold uppercase tracking-wider text-xs bg-sky-500 text-white shadow-md"
                    >
                        Imprimir {parsed}
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
}
