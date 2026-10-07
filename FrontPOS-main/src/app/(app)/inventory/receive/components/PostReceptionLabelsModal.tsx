"use client";

/**
 * PostReceptionLabelsModal
 *
 * Modal que aparece ÚNICAMENTE después de que la recepción
 * (`POST /products/bulk-receive`) respondió OK. Ofrece imprimir
 * etiquetas unitarias para las líneas que acaban de entrar en stock.
 *
 * Contrato explícito (ver tests/label-reprint-contract.test.mjs):
 *   1. El carrito DRAFT (receiveList) NUNCA debe exponer el botón
 *      Printer. Hacerlo auditaría trabajos de impresión en
 *      label_print_jobs antes de que la recepción exista en BD.
 *   2. Cada entrada aquí tiene `syncedReceptionId` (generado
 *      client-side) y se usa como `meta.receptionRef` cuando
 *      el `LabelPrintSheet` audita el trabajo. Así siempre podemos
 *      cruzar un print job con la recepción que lo originó.
 *   3. "Finalizar" cierra el modal sin imprimir — totalmente opcional.
 *      El stock YA se descontó/aumentó por el bulk-receive previo.
 */

import {
    Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
    Button,
} from '@heroui/react';
import { Printer, Package, Check } from 'lucide-react';
import type { ReceiveItem } from '../page';

interface PostReceptionLabelsModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** Líneas que acaban de sincronizarse. Todas deben traer syncedReceptionId. */
    lines: ReceiveItem[];
    /**
     * Callback para abrir el `LabelPrintSheet` real sobre una línea.
     * El padre inyecta la hoja; este modal sólo expone la UI mobile-first.
     */
    onPrintLabels: (line: ReceiveItem) => void;
}

export default function PostReceptionLabelsModal({
    isOpen,
    onClose,
    lines,
    onPrintLabels,
}: PostReceptionLabelsModalProps) {
    // Un receptionRef por recepción. Si la implementación cambiara en el
    // futuro, el label sólo renderiza el primero: no es parte del contrato
    // público del modal, pero sí sirve para auditoría visual.
    const receptionRef = lines[0]?.syncedReceptionId;

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            placement="center"
            size="md"
            scrollBehavior="inside"
            classNames={{
                // Mobile-first: ancho completo en móvil, max-w controlado en >sm.
                base: "bg-white dark:bg-[#121214] rounded-2xl mx-2 w-screen max-w-[100vw] sm:max-w-md sm:w-auto",
                wrapper: "items-center justify-center p-2",
            }}
        >
            <ModalContent>
                <ModalHeader className="flex items-center gap-3 border-b border-gray-200 dark:border-white/10 px-5 py-4">
                    <div className="h-10 w-10 rounded-2xl bg-emerald-500 flex items-center justify-center shadow-md">
                        <Check size={18} className="text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 className="text-base font-semibold uppercase tracking-tight text-gray-900 dark:text-white">
                            Recepción confirmada
                        </h2>
                        <p className="text-[11px] uppercase tracking-widest text-gray-400 mt-0.5 truncate">
                            {receptionRef || 'LOTE'} · {lines.length} línea{lines.length === 1 ? '' : 's'}
                        </p>
                    </div>
                </ModalHeader>

                <ModalBody className="px-5 py-4 space-y-3 min-h-0 min-w-0">
                    <div className="rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-500/30 px-4 py-3 text-[12px] text-emerald-700 dark:text-emerald-200">
                        <strong>Stock actualizado.</strong> ¿Deseas imprimir etiquetas unitarias para
                        las unidades que llegaron sin código? La impresión es opcional: el
                        inventario YA quedó sincronizado.
                    </div>

                    <div className="flex flex-col gap-2 pt-1">
                        {lines.map((line) => (
                            <div
                                key={line.lineId}
                                className="flex items-center gap-3 rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-[#18181b] px-3 py-2.5"
                            >
                                <div className="h-9 w-9 rounded-2xl bg-white dark:bg-zinc-900 flex items-center justify-center text-gray-500 shrink-0 shadow-inner">
                                    <Package size={16} />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="text-[11px] font-medium text-gray-900 dark:text-white uppercase tracking-tight truncate">
                                        {line.productName}
                                    </div>
                                    <div className="text-[10px] text-gray-400 font-mono truncate">
                                        #{line.barcode} · {line.addedQuantity} {line.unit}
                                    </div>
                                </div>
                                <Button
                                    size="sm"
                                    isIconOnly
                                    variant="flat"
                                    aria-label={`Imprimir etiquetas para ${line.productName}`}
                                    title="Imprimir etiquetas unitarias"
                                    onClick={() => onPrintLabels(line)}
                                    className="h-9 w-9 min-w-9 rounded-2xl bg-sky-50 dark:bg-sky-500/10 text-sky-500 border border-sky-500/10 shrink-0"
                                >
                                    <Printer size={14} />
                                </Button>
                            </div>
                        ))}
                    </div>
                </ModalBody>

                <ModalFooter
                    className="border-t border-gray-200 dark:border-white/10 px-5 py-3 gap-2"
                    style={{ paddingBottom: `max(0.75rem, env(safe-area-inset-bottom))` }}
                >
                    <Button
                        variant="light"
                        onPress={onClose}
                        className="font-medium uppercase tracking-wider text-xs text-gray-500 dark:text-gray-400"
                    >
                        Finalizar
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
}
