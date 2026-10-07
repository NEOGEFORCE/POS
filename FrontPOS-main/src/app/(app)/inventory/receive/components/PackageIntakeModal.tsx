"use client";

/**
 * PackageIntakeModal
 *
 * Modal mobile-first para registrar la recepción de un producto cuyo
 * código de barras SOLO aparece impreso en el paquete (no en cada
 * unidad individual).
 *
 * Flujo:
 *   1. `handleCodeSubmit` del page padre llama a
 *      GET /inventory/package-barcode/resolve?code=X.
 *   2. Si la respuesta es `exact` → el alias ya existe; abrimos este
 *      modal con `unitsPerPack` pre-llenado. El usuario SOLO ajusta
 *      "paquetes recibidos" y confirma.
 *   3. Si la respuesta es `new` → el código es barcode/alternateCode
 *      conocido pero NO estaba registrado como paquete; abrimos este
 *      modal con `unitsPerPack` vacío y foco en ese campo. El usuario
 *      declara cuántas unidades trae el paquete y confirma.
 *
 * Al confirmar:
 *   • Si el checkbox "guardar alias" está activo → POST
 *     /inventory/package-barcode (idempotente). Si la respuesta es 409
 *     con code=PACKAGE_CODE_BELONGS_TO_OTHER_PRODUCT, mostramos el
 *     mensaje del backend y abortamos.
 *   • Se llama al callback `onConfirm({ product, totalUnits })` con la
 *     cantidad calculada (paquetes × unidades) para que el page padre
 *     agregue al carrito como una entrada regular del producto UNITARIO.
 *     Nunca se toca `IsPack` del producto.
 *
 * Importante:
 *   • El código de paquete vive en una tabla aparte (package_barcode_aliases)
 *     y JAMÁS alimenta el flujo de ventas. Un guardián estático de tests
 *     prohíbe que el modal escriba el package_code hacia catálogos de códigos
 *     escaneables en caja.
 *   • Si el usuario desactiva el checkbox, igualmente se agrega al
 *     carrito pero sin aprender el alias (útil para pruebas o paquetes
 *     ocasionales que no vale la pena recordar).
 */

import { useEffect, useRef, useState } from 'react';
import {
    Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
    Button, Input, Checkbox,
} from '@heroui/react';
import { Package, Minus, Plus, Info } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { apiFetch, ApiError } from '@/lib/api-error';
import Cookies from 'js-cookie';

export interface PackageIntakeProduct {
    barcode: string;
    productName: string;
    quantity?: number;
    salePrice?: number;
    purchasePrice?: number;
    isWeighted?: boolean;
    unit?: string;
    isPack?: boolean;
}

interface PackageIntakeModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** Código del paquete escaneado o escrito. */
    packageCode: string;
    /** Producto resuelto por GET /inventory/package-barcode/resolve. */
    product: PackageIntakeProduct;
    /**
     * Unidades por paquete pre-llenadas si el alias ya existía
     * (match="exact"). null para "match=new" → usuario debe tipearlo.
     */
    initialUnitsPerPack: number | null;
    /** supplierId activo en la pantalla; se persiste con el alias. */
    supplierId: number | null;
    /** Devuelve el totalUnits para que el page padre lo agregue al carrito. */
    onConfirm: (totalUnits: number) => void;
}

export default function PackageIntakeModal({
    isOpen,
    onClose,
    packageCode,
    product,
    initialUnitsPerPack,
    supplierId,
    onConfirm,
}: PackageIntakeModalProps) {
    const { toast } = useToast();
    const [unitsPerPack, setUnitsPerPack] = useState<string>(
        initialUnitsPerPack && initialUnitsPerPack > 0 ? String(initialUnitsPerPack) : ''
    );
    const [packages, setPackages] = useState<string>('1');
    const [saveAlias, setSaveAlias] = useState<boolean>(initialUnitsPerPack === null);
    const [submitting, setSubmitting] = useState<boolean>(false);
    const unitsInputRef = useRef<HTMLInputElement>(null);
    const packagesInputRef = useRef<HTMLInputElement>(null);
    const isExact = initialUnitsPerPack !== null;

    // Reset cuando cambia de código.
    useEffect(() => {
        if (!isOpen) return;
        setUnitsPerPack(initialUnitsPerPack && initialUnitsPerPack > 0 ? String(initialUnitsPerPack) : '');
        setPackages('1');
        setSaveAlias(initialUnitsPerPack === null);
    }, [isOpen, initialUnitsPerPack, packageCode]);

    // Auto-foco: cuando new → al input de unidades; cuando exact → al input de paquetes.
    useEffect(() => {
        if (!isOpen) return;
        const t = window.setTimeout(() => {
            if (isExact) {
                packagesInputRef.current?.focus();
                packagesInputRef.current?.select();
            } else {
                unitsInputRef.current?.focus();
                unitsInputRef.current?.select();
            }
        }, 150);
        return () => window.clearTimeout(t);
    }, [isOpen, isExact]);

    const unitsNum = Math.max(0, Math.floor(Number(unitsPerPack) || 0));
    const packagesNum = Math.max(0, Math.floor(Number(packages) || 0));
    const totalUnits = unitsNum * packagesNum;
    const canSubmit = unitsNum >= 1 && packagesNum >= 1;

    const handleConfirm = async () => {
        if (!canSubmit || submitting) return;
        setSubmitting(true);
        try {
            if (saveAlias) {
                const token = Cookies.get('org-pos-token');
                try {
                    await apiFetch('/inventory/package-barcode', {
                        method: 'POST',
                        body: JSON.stringify({
                            productBarcode: product.barcode,
                            packageCode,
                            unitsPerPack: unitsNum,
                            supplierId: supplierId || undefined,
                        }),
                        fallbackError: 'No se pudo guardar el alias del paquete',
                    }, token);
                } catch (err: any) {
                    // 409: colisión con otro producto. Mostramos el mensaje
                    // del backend y abortamos sin agregar al carrito, para
                    // que el usuario corrija el código.
                    if (err instanceof ApiError && err.status === 409 && err.data?.code === 'PACKAGE_CODE_BELONGS_TO_OTHER_PRODUCT') {
                        toast({
                            variant: 'destructive',
                            title: 'CÓDIGO YA PERTENECE A OTRO PRODUCTO',
                            description: err.data?.message || err.message,
                            duration: 10000,
                        });
                        setSubmitting(false);
                        return;
                    }
                    // Cualquier otro error: avisamos pero igual permitimos
                    // agregar al carrito. El alias se puede re-intentar
                    // después; no bloqueamos la recepción.
                    toast({
                        variant: 'destructive',
                        title: 'No se guardó el alias',
                        description: err.message || 'El carrito se actualiza igual; reintenta el alias después.',
                    });
                }
            }
            onConfirm(totalUnits);
            onClose();
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            placement="center"
            size="md"
            scrollBehavior="inside"
            classNames={{
                // mobile-first: ancho de pantalla y padding seguro inferior
                base: "bg-white dark:bg-[#121214] rounded-2xl mx-2 w-screen max-w-[100vw] sm:max-w-md sm:w-auto",
                wrapper: "items-center justify-center p-2",
            }}
        >
            <ModalContent>
                <ModalHeader className="flex items-center gap-3 border-b border-gray-200 dark:border-white/10 px-5 py-4">
                    <div className="h-10 w-10 rounded-2xl bg-emerald-500 flex items-center justify-center shadow-md">
                        <Package size={18} className="text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 className="text-base font-semibold uppercase tracking-tight text-gray-900 dark:text-white">
                            Código de paquete
                        </h2>
                        <p className="text-[11px] uppercase tracking-widest text-gray-400 mt-0.5 truncate">
                            {packageCode}
                        </p>
                    </div>
                </ModalHeader>

                <ModalBody className="px-5 py-5 space-y-5 min-h-0 min-w-0">
                    {/* Nombre del producto resuelto, grande */}
                    <div>
                        <label className="text-[10px] font-bold uppercase text-gray-400 tracking-widest">
                            Producto resuelto
                        </label>
                        <div className="mt-1 text-lg font-medium text-gray-900 dark:text-white break-words">
                            {product.productName}
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
                            <span className="font-mono uppercase">{product.barcode}</span>
                            {product.isPack && (
                                <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 text-[10px] font-semibold uppercase">
                                    Marcado como pack
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Unidades por paquete */}
                    <div className="space-y-1.5">
                        <label className="text-[10px] font-bold uppercase text-gray-400 tracking-widest ml-1">
                            Unidades por paquete {isExact && <span className="text-emerald-500 normal-case">(aprendido)</span>}
                        </label>
                        <Input
                            ref={unitsInputRef as any}
                            type="number"
                            inputMode="numeric"
                            min={1}
                            step={1}
                            value={unitsPerPack}
                            onValueChange={(v) => setUnitsPerPack(v.replace(/[^\d]/g, ''))}
                            variant="flat"
                            radius="lg"
                            placeholder={isExact ? String(initialUnitsPerPack) : 'Ej. 12'}
                            classNames={{
                                input: "text-center text-xl font-bold text-gray-900 dark:text-white",
                                inputWrapper: "h-14 bg-gray-100 dark:bg-[#1a1a1d] border border-gray-200 dark:border-white/10",
                            }}
                        />
                    </div>

                    {/* Paquetes recibidos con +/- compactos */}
                    <div className="space-y-1.5">
                        <label className="text-[10px] font-bold uppercase text-gray-400 tracking-widest ml-1">
                            Paquetes recibidos
                        </label>
                        <div className="flex items-center gap-2">
                            <Button
                                isIconOnly
                                variant="flat"
                                radius="lg"
                                aria-label="Restar paquete"
                                onClick={() => setPackages(String(Math.max(1, packagesNum - 1)))}
                                className="h-14 w-14 min-w-0 bg-gray-100 dark:bg-[#1a1a1d] border border-gray-200 dark:border-white/10"
                            >
                                <Minus size={16} />
                            </Button>
                            <Input
                                ref={packagesInputRef as any}
                                type="number"
                                inputMode="numeric"
                                min={1}
                                step={1}
                                value={packages}
                                onValueChange={(v) => setPackages(v.replace(/[^\d]/g, ''))}
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
                                aria-label="Sumar paquete"
                                onClick={() => setPackages(String(packagesNum + 1))}
                                className="h-14 w-14 min-w-0 bg-gray-100 dark:bg-[#1a1a1d] border border-gray-200 dark:border-white/10"
                            >
                                <Plus size={16} />
                            </Button>
                        </div>
                    </div>

                    {/* Vista previa del cálculo */}
                    <div className="rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-500/30 px-4 py-3">
                        <div className="text-[10px] font-bold uppercase text-emerald-600 dark:text-emerald-400 tracking-widest">
                            Entrará al stock como
                        </div>
                        <div className="mt-1 text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                            {totalUnits.toLocaleString('es-CO')} unidades
                        </div>
                        <div className="mt-0.5 text-[11px] text-emerald-700/80 dark:text-emerald-200/70">
                            {packagesNum} paquete{packagesNum === 1 ? '' : 's'} × {unitsNum} unidad{unitsNum === 1 ? '' : 'es'}
                        </div>
                    </div>

                    {/* Guardar alias */}
                    <div className="flex items-start gap-3 rounded-2xl bg-gray-50 dark:bg-[#1a1a1d] border border-gray-200 dark:border-white/10 px-4 py-3">
                        <Checkbox
                            isSelected={saveAlias}
                            onValueChange={setSaveAlias}
                            size="md"
                            radius="md"
                            aria-label="Guardar código como alias de recepción"
                        />
                        <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-gray-900 dark:text-white">
                                Recordar este código como alias de recepción
                            </div>
                            <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 flex items-start gap-1">
                                <Info size={12} className="shrink-0 mt-0.5" />
                                <span>
                                    El código del paquete <strong>NO se usará en caja</strong> — solo durante
                                    recepciones. En caja se vende por unidad al precio del producto.
                                </span>
                            </div>
                        </div>
                    </div>
                </ModalBody>

                <ModalFooter
                    // Sticky bottom con padding seguro para iPhone/notch móvil.
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
                        onPress={handleConfirm}
                        isDisabled={!canSubmit || submitting}
                        isLoading={submitting}
                        className="font-semibold uppercase tracking-wider text-xs bg-emerald-500 text-white shadow-md"
                    >
                        Agregar al carrito
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
}
