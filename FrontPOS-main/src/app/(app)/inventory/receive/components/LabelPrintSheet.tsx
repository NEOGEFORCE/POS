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
 *   3. Si window.posBridge?.print existe, delega al bridge local. Si no
 *      hay bridge, o si la llamada rechaza, mostramos un toast
 *      accionable y NO abrimos el diálogo del navegador automáticamente:
 *      la impresión directa no se finge jamás (contrato "modo bridge =
 *      silencioso" del sprint 2026-10). El usuario puede pulsar el botón
 *      explícito "Imprimir con navegador (PDF)" como acción manual
 *      separada si quiere una copia impresa por diálogo.
 */

import { useEffect, useState } from 'react';
import {
    Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
    Button, Input,
} from '@heroui/react';
import { Printer, Minus, Plus, Info, FileText } from 'lucide-react';
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

    /**
     * Dibuja un iframe aislado con `window.print()` para una ETIQUETA
     * suelta cuando el usuario pulsa el botón manual "Imprimir con
     * navegador (PDF)". Se mantiene aquí (no fuera del catch) para que el
     * contrato "modo bridge = silencioso" quede explícito: SIN acción
     * manual, nadie abre el diálogo del navegador.
     */
    const openBrowserPrintDialog = (ticket: { code: string; productName: string; quantity: number }) => {
        if (typeof document === 'undefined') return;
        const iframe = document.createElement('iframe');
        iframe.setAttribute('aria-hidden', 'true');
        iframe.setAttribute('title', 'Impresión de etiquetas (modo navegador)');
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = '0';
        iframe.style.opacity = '0';
        iframe.style.visibility = 'hidden';
        iframe.style.overflow = 'hidden';
        iframe.style.pointerEvents = 'none';
        document.body.appendChild(iframe);
        const doc = iframe.contentWindow?.document;
        if (!doc) {
            try { document.body.removeChild(iframe); } catch { /* ignore */ }
            return;
        }
        // Escapado defensivo: cualquier valor del producto va por este helper
        // antes de llegar al HTML del iframe.
        const esc = (s: string) => String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        const labelHtml = `
            <div class="label">
                <div class="name">${esc(ticket.productName)}</div>
                <div class="code">${esc(ticket.code)}</div>
            </div>
        `;
        const copies = Array.from({ length: Math.max(1, ticket.quantity) }).map(() => labelHtml).join('');
        doc.open();
        doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Etiquetas</title>
<style>
    @page { margin: 4mm; }
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 0; }
    .label { padding: 2mm 1mm; border-bottom: 1px dashed #999; }
    .name { font-size: 10pt; font-weight: 700; }
    .code { font-family: monospace; font-size: 9pt; margin-top: 1mm; }
</style></head><body>${copies}</body></html>`);
        doc.close();
        const fire = () => {
            try {
                iframe.contentWindow?.focus();
                iframe.contentWindow?.print();
            } catch { /* ignore */ }
            finally {
                setTimeout(() => { try { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); } catch { /* ignore */ } }, 1500);
            }
        };
        if (iframe.contentWindow?.document.readyState === 'complete') fire();
        else iframe.onload = fire;
    };

    /**
     * Ensure the label code exists and audit the print job in the backend
     * BEFORE we try any physical/virtual output. Shared by the bridge and
     * the manual-browser flow so both paths register the same lot.
     */
    async function ensureAndAudit(): Promise<{ code: string; created: boolean }> {
        const token = Cookies.get('org-pos-token');
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
        return { code, created: !!ensure?.created };
    }

    const handlePrint = async () => {
        if (!canSubmit || submitting) return;
        setSubmitting(true);
        try {
            const { code } = await ensureAndAudit();

            // Delegación al bridge local. SIN fallback automático al
            // diálogo del navegador: cuando el admin configuró impresión
            // directa, "silencioso" significa que un fallo del bridge
            // produce error accionable, no un diálogo encubierto.
            //
            //   - Enriquecemos el payload del bridge con la configuración
            //     sanitizada de /labels/config (sólo rama connection +
            //     labels) para que el bridge sepa qué impresora y qué
            //     formato usar sin tener que leer LocalStorage por su
            //     cuenta.
            const printingConfig = loadPrintingConfig();
            const bridgePayload = {
                code,
                productName,
                quantity: parsed,
                connection: printingConfig.connection,
                labels: printingConfig.labels,
            };
            const bridge = (globalThis as any)?.window?.posBridge;
            if (bridge && typeof bridge.print === 'function') {
                try {
                    await bridge.print(bridgePayload);
                    toast({
                        variant: 'success',
                        title: 'ETIQUETAS ENVIADAS',
                        description: `${parsed} ${parsed === 1 ? 'etiqueta' : 'etiquetas'} de ${productName}.`,
                    });
                    onClose();
                    return;
                } catch (err: any) {
                    const rawMessage: string = err?.message || 'El bridge local no respondió.';
                    // Si el mensaje viene con prefijo tipo `ERROR_CODE: detalle`
                    // reusamos ese código en el título para que el cajero sepa
                    // qué pasó sin ir al log.
                    const colon = rawMessage.indexOf(':');
                    const code = colon > 0 && colon < 40 ? rawMessage.slice(0, colon) : null;
                    toast({
                        variant: 'destructive',
                        title: code ? `IMPRESIÓN FALLÓ: ${code}` : 'IMPRESIÓN FALLÓ',
                        description:
                            `${rawMessage} El trabajo quedó auditado en /labels. ` +
                            `Usa "Imprimir con navegador (PDF)" si necesitas una copia manual.`,
                        duration: 10000,
                    });
                    return;
                }
            }

            // No hay bridge disponible: nunca abrir el diálogo
            // automáticamente. El cajero decide si usa la acción manual
            // "Imprimir con navegador (PDF)" o si reimprime desde /labels
            // cuando el bridge esté arriba.
            toast({
                variant: 'destructive',
                title: 'SIN BRIDGE LOCAL',
                description:
                    'Esta pantalla no abrirá el diálogo del navegador automáticamente. ' +
                    'El trabajo quedó auditado en /labels. ' +
                    'Pulsa "Imprimir con navegador (PDF)" si necesitas una copia manual.',
                duration: 10000,
            });
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

    /**
     * Acción MANUAL separada: audita el lote y abre el diálogo del
     * navegador (iframe aislado). Nunca se dispara automáticamente desde
     * `handlePrint` — es una ruta independiente, con su propio botón y
     * su propio copy, para que el admin pueda imprimir una copia PDF
     * cuando el bridge no está disponible.
     */
    const handleManualBrowserPrint = async () => {
        if (!canSubmit || submitting) return;
        setSubmitting(true);
        try {
            const { code } = await ensureAndAudit();
            openBrowserPrintDialog({ code, productName, quantity: parsed });
            toast({
                variant: 'default',
                title: 'DIÁLOGO DEL NAVEGADOR ABIERTO',
                description: `${parsed} ${parsed === 1 ? 'etiqueta' : 'etiquetas'} enviadas al diálogo manual.`,
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
                            futuras reimpresiones. <strong>El modo bridge imprime en silencio.</strong>{" "}
                            Si no hay bridge local o la impresión directa falla, el trabajo queda
                            <strong> auditado</strong> en /labels y el aviso te invita a usar la acción
                            manual <em>Imprimir con navegador (PDF)</em> — nunca se abre el diálogo
                            del navegador automáticamente.
                        </span>
                    </div>
                </ModalBody>

                <ModalFooter
                    className="border-t border-gray-200 dark:border-white/10 px-5 py-3 gap-2 flex-wrap"
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
                        variant="flat"
                        color="default"
                        onPress={handleManualBrowserPrint}
                        isDisabled={!canSubmit || submitting}
                        startContent={<FileText size={14} />}
                        className="font-semibold uppercase tracking-wider text-xs"
                        aria-label="Acción manual separada: imprimir con el diálogo del navegador en formato PDF"
                        data-testid="label-sheet-manual-browser-print-btn"
                    >
                        Imprimir con navegador (PDF)
                    </Button>
                    <Button
                        color="primary"
                        onPress={handlePrint}
                        isDisabled={!canSubmit || submitting}
                        isLoading={submitting}
                        className="font-semibold uppercase tracking-wider text-xs bg-sky-500 text-white shadow-md"
                        data-testid="label-sheet-bridge-print-btn"
                    >
                        Imprimir {parsed}
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
}
