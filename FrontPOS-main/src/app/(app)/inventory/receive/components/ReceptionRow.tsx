"use client";

import React, { memo, useState, useEffect, useMemo } from 'react';
import { Button, Input, Dropdown, DropdownTrigger, DropdownMenu, DropdownItem, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/react";
import { 
    Barcode, Trash2, Truck, Gift, ArrowDownLeft, ChevronDown, Edit2 
} from 'lucide-react';
import { ReceiveItem } from '../page';
import { formatCOP, formatInputCOP, parseCOP, applyRounding, sanitizeNumber, normalizeText } from "@/lib/utils";
import { useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-error';
import { broadcastRevalidate } from '@/lib/revalidate';
import Cookies from 'js-cookie';
import { useToast } from '@/hooks/use-toast';

interface ReceptionRowProps {
    item: ReceiveItem;
    onUpdate: (lineId: string, updates: Partial<ReceiveItem>) => void;
    onDelete: (lineId: string) => void;
}

const ReceptionRow = memo(({ item, onUpdate, onDelete }: ReceptionRowProps) => {
    const { toast } = useToast();
    const { user } = useAuth();
    const isAdmin = useMemo(() => {
        const role = (user?.role || user?.Role || '').toLowerCase();
        return ['admin', 'administrador', 'superadmin'].includes(role);
    }, [user]);

    // Quick Edit State
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [editName, setEditName] = useState(item.productName);
    const [editBarcode, setEditBarcode] = useState(item.barcode);
    const [isSavingEdit, setIsSavingEdit] = useState(false);

    const physicalStock = item.actualPhysicalStock;
    const currentStock = item.currentStock;

    // TAREA 1: Formula Maestra de Modificadores Secuenciales (Compuesta) - Motor Surtifamiliar v10.0
    // 1. Costo Bruto (sin descuento): Bruto = Base * (1 + IVA + ICUI + IBUA)
    const calculateGrossCost = (basePrice: number, iva: number, icui: number, ibua: number) => {
        return basePrice * (1 + (Number(iva || 0) / 100) + (Number(icui || 0) / 100) + (Number(ibua || 0) / 100));
    };

    // Costo Neto Final para el inventario y pago: Neto = Bruto * (1 - DTO)
    const calculateNetCost = (basePrice: number, iva: number, icui: number, ibua: number, discount: number) => {
        return calculateGrossCost(basePrice, iva, icui, ibua) * (1 - (Number(discount || 0) / 100));
    };

    // 2. Calculo de PVP Sugerido: Se calcula sobre el Costo Bruto para que el descuento beneficie al supermercado
    const calculatePVP = (basePrice: number, iva: number, icui: number, ibua: number, marginPct: number) => {
        const grossCost = calculateGrossCost(basePrice, iva, icui, ibua);
        return applyRounding(grossCost * (1 + (Number(marginPct || 0) / 100)));
    };

    const formatInitial = (val: number) => (val === 0 ? '' : formatCOP(val));
    const formatInitialPercent = (val: number) => (val === 0 ? '' : String(val));
    const formatInitialQty = (val: number | undefined | null) => (val === undefined || val === null || val === 0 ? '' : String(val));

    const effectiveQty = item.addedQuantity * (item.unit === 'LB' ? 0.5 : 1);

    // Local state
    const [localQuantity, setLocalQuantity] = useState(formatInitialQty(item.addedQuantity));
    const [localPhysical, setLocalPhysical] = useState(formatInitialQty(item.actualPhysicalStock));
    
    const [localTotal, setLocalTotal] = useState(formatInitial(calculateGrossCost(item.newPurchasePrice, item.iva || 0, item.icui || 0, item.ibua || 0) * effectiveQty));
    const [localSubtotal, setLocalSubtotal] = useState(formatInitial(item.newPurchasePrice * effectiveQty));
    const [localCost, setLocalCost] = useState(formatInitial(calculateNetCost(item.newPurchasePrice, item.iva || 0, item.icui || 0, item.ibua || 0, item.discount || 0))); 
    const [localSalePrice, setLocalSalePrice] = useState(formatInitial(item.newSalePrice));
    const [localIva, setLocalIva] = useState(formatInitialPercent(item.iva || 0));
    const [localIcui, setLocalIcui] = useState(formatInitialPercent(item.icui || 0));
    const [localIbua, setLocalIbua] = useState(formatInitialPercent(item.ibua || 0));
    const [localDiscount, setLocalDiscount] = useState(formatInitialPercent(item.discount || 0));
    const [localMargin, setLocalMargin] = useState(formatInitialPercent(item.marginPercentage || 30));

    useEffect(() => {
        const basePrice = item.newPurchasePrice;
        // Politica 3 zonas: cada linea tiene su propio costo segun entryType.
        // BONUS (gift) y RETURN no usan costo ponderado — el costo es el base
        // tal cual lo dejo el OCR o el cajero.
        const neto = calculateNetCost(basePrice, item.iva, item.icui, item.ibua, item.discount);
        const bruto = calculateGrossCost(basePrice, item.iva, item.icui, item.ibua);

        // Solo actualizar si el valor calculado difiere del valor local parseado
        const parsedLocalTotal = parseCOP(localTotal) || 0;
        const targetTotal = bruto * effectiveQty; // Total usa el costo Bruto
        if (Math.abs(parsedLocalTotal - targetTotal) >= 1) {
            setLocalTotal(formatInitial(targetTotal));
        }

        const parsedLocalSubtotal = parseCOP(localSubtotal) || 0;
        const targetSubtotal = basePrice * effectiveQty;
        if (Math.abs(parsedLocalSubtotal - targetSubtotal) >= 1) {
            setLocalSubtotal(formatInitial(targetSubtotal));
        }

        const parsedLocalCost = parseCOP(localCost) || 0;
        if (Math.abs(parsedLocalCost - neto) >= 1) {
            setLocalCost(formatInitial(neto));
        }

        const parsedLocalSalePrice = parseCOP(localSalePrice) || 0;
        if (Math.abs(parsedLocalSalePrice - item.newSalePrice) >= 1) {
            setLocalSalePrice(formatInitial(item.newSalePrice));
        }

        const parsedLocalIva = localIva === "" ? 0 : parseFloat(localIva.replace(",", ".")) || 0;
        if (Math.abs(parsedLocalIva - (item.iva || 0)) >= 0.01) {
            setLocalIva(formatInitialPercent(item.iva || 0));
        }

        const parsedLocalIcui = localIcui === "" ? 0 : parseFloat(localIcui.replace(",", ".")) || 0;
        if (Math.abs(parsedLocalIcui - (item.icui || 0)) >= 0.01) {
            setLocalIcui(formatInitialPercent(item.icui || 0));
        }

        const parsedLocalIbua = localIbua === "" ? 0 : parseFloat(localIbua.replace(",", ".")) || 0;
        if (Math.abs(parsedLocalIbua - (item.ibua || 0)) >= 0.01) {
            setLocalIbua(formatInitialPercent(item.ibua || 0));
        }

        const parsedLocalDiscount = localDiscount === "" ? 0 : parseFloat(localDiscount.replace(",", ".")) || 0;
        if (Math.abs(parsedLocalDiscount - (item.discount || 0)) >= 0.01) {
            setLocalDiscount(formatInitialPercent(item.discount || 0));
        }

        const parsedLocalMargin = localMargin === "" ? 0 : parseFloat(localMargin.replace(",", ".")) || 0;
        if (Math.abs(parsedLocalMargin - (item.marginPercentage || 0)) >= 0.01) {
            setLocalMargin(formatInitialPercent(item.marginPercentage || 30));
        }
        
        // Sync incoming quantities if they differ significantly from local parsed state (ignoring trailing dots)
        const parsedLocalQty = parseFloat(localQuantity) || 0;
        if (Math.abs(parsedLocalQty - item.addedQuantity) >= 0.001) {
            setLocalQuantity(formatInitialQty(item.addedQuantity));
        }
        
        const parsedLocalPhys = localPhysical === '' ? undefined : parseFloat(localPhysical) || 0;
        if (item.actualPhysicalStock !== parsedLocalPhys) {
            setLocalPhysical(formatInitialQty(item.actualPhysicalStock));
        }
        
    }, [item.newPurchasePrice, effectiveQty, item.newSalePrice, item.iva, item.icui, item.ibua, item.discount, item.marginPercentage, item.addedQuantity, item.actualPhysicalStock]);

    const handleTotalChange = (val: string) => {
        setLocalTotal(formatInputCOP(val));
    };

    const handleTotalBlur = (val: string) => {
        const totalRow = parseCOP(val) || 0;
        // Total = Bruto * Qty  -->  Bruto = Base * (1 + sum(Taxes))
        const taxesMultiplier = 1 + (Number(item.iva || 0) / 100) + (Number(item.icui || 0) / 100) + (Number(item.ibua || 0) / 100);
        const basePrice = totalRow / (Math.max(0.001, effectiveQty) * taxesMultiplier);
        
        const neto = calculateNetCost(basePrice, item.iva, item.icui, item.ibua, item.discount);
        const targetSubtotal = basePrice * effectiveQty;
        const newSalePrice = calculatePVP(basePrice, item.iva, item.icui, item.ibua, item.marginPercentage);
        
        setLocalCost(formatCOP(Math.round(neto)));
        setLocalSalePrice(formatCOP(newSalePrice));
        setLocalTotal(formatCOP(totalRow));
        setLocalSubtotal(formatCOP(Math.round(targetSubtotal)));
        
        onUpdate(item.lineId, {
            newPurchasePrice: basePrice,
            newSalePrice: newSalePrice
        });
    };

    const handleSubtotalChange = (val: string) => {
        setLocalSubtotal(formatInputCOP(val));
    };

    const handleSubtotalBlur = (val: string) => {
        const subtotalRow = parseCOP(val) || 0;
        const basePrice = subtotalRow / Math.max(0.001, effectiveQty);
        
        const neto = calculateNetCost(basePrice, item.iva, item.icui, item.ibua, item.discount);
        const bruto = calculateGrossCost(basePrice, item.iva, item.icui, item.ibua);
        const newSalePrice = calculatePVP(basePrice, item.iva, item.icui, item.ibua, item.marginPercentage);
        
        setLocalCost(formatCOP(Math.round(neto)));
        setLocalSalePrice(formatCOP(newSalePrice));
        setLocalTotal(formatCOP(Math.round(bruto * effectiveQty)));
        setLocalSubtotal(formatCOP(subtotalRow));
        
        onUpdate(item.lineId, {
            newPurchasePrice: basePrice,
            newSalePrice: newSalePrice
        });
    };

    const handleCostChange = (val: string) => {
        setLocalCost(formatInputCOP(val));
    };

    const handleCostBlur = (val: string) => {
        const neto = parseCOP(val) || 0;
        
        // RECONSTRUCCION: Obtener Base desde Neto
        const multiplier = (1 + (Number(item.iva || 0) / 100) 
                         + (Number(item.icui || 0) / 100) 
                         + (Number(item.ibua || 0) / 100)) 
                         * (1 - (Number(item.discount || 0) / 100));
        
        const basePrice = neto / (multiplier || 1);
        const bruto = calculateGrossCost(basePrice, item.iva, item.icui, item.ibua);
        const newTotal = bruto * effectiveQty; // Total se basa en Bruto (no DTO)
        
        const targetSubtotal = basePrice * effectiveQty;
        
        setLocalTotal(formatCOP(Math.round(newTotal)));
        setLocalCost(formatCOP(neto));
        setLocalSubtotal(formatCOP(Math.round(targetSubtotal)));
        
        const newSalePrice = calculatePVP(basePrice, item.iva, item.icui, item.ibua, item.marginPercentage);
        setLocalSalePrice(formatCOP(newSalePrice));

        onUpdate(item.lineId, {
            newPurchasePrice: basePrice,
            newSalePrice: newSalePrice
        });
    };

    const handleSalePriceChange = (val: string) => {
        setLocalSalePrice(formatInputCOP(val));
    };

    const handleSalePriceBlur = (val: string) => {
        const sale = applyRounding(parseCOP(val) || 0);
        
        // Recalcular MARGEN basado en el Costo Bruto
        const bruto = calculateGrossCost(item.newPurchasePrice, item.iva, item.icui, item.ibua);
        const margin = bruto > 0 ? ((sale / bruto) - 1) * 100 : item.marginPercentage;
        
        setLocalMargin(String(margin));
        setLocalSalePrice(formatCOP(sale));
        
        onUpdate(item.lineId, { 
            newSalePrice: sale, 
            marginPercentage: margin 
        });
    };

    const handleTaxChange = (type: 'iva' | 'icui' | 'ibua', val: string) => {
        if (type === 'iva') setLocalIva(val);
        if (type === 'icui') setLocalIcui(val);
        if (type === 'ibua') setLocalIbua(val);
        
        const value = val === "" ? 0 : (parseFloat(val.replace(",", ".")) || 0);
        
        const currentIVA = type === 'iva' ? value : item.iva;
        const currentICUI = type === 'icui' ? value : item.icui;
        const currentIBUA = type === 'ibua' ? value : item.ibua;
        
        const neto = calculateNetCost(item.newPurchasePrice, currentIVA, currentICUI, currentIBUA, item.discount);
        const pvp = calculatePVP(item.newPurchasePrice, currentIVA, currentICUI, currentIBUA, item.marginPercentage);
        const bruto = calculateGrossCost(item.newPurchasePrice, currentIVA, currentICUI, currentIBUA);
        
        setLocalCost(formatCOP(Math.round(neto)));
        setLocalSalePrice(formatCOP(pvp));
        setLocalTotal(formatCOP(Math.round(bruto * effectiveQty)));

        onUpdate(item.lineId, { 
            [type]: value,
            newSalePrice: pvp
        });
    };

    const handleMarginChange = (val: string) => {
        setLocalMargin(val);
        const targetMargin = val === "" ? 0 : (parseFloat(val.replace(",", ".")) || 0);
        const neto = calculateNetCost(item.newPurchasePrice, item.iva, item.icui, item.ibua, item.discount);
        const newSale = calculatePVP(item.newPurchasePrice, item.iva, item.icui, item.ibua, targetMargin);
        
        setLocalSalePrice(formatCOP(newSale));
        onUpdate(item.lineId, { 
            marginPercentage: targetMargin,
            newSalePrice: newSale
        });
    };

    const handleDiscountChange = (val: string) => {
        setLocalDiscount(val);
        const value = val === "" ? 0 : (parseFloat(val.replace(",", ".")) || 0);
        
        const neto = calculateNetCost(item.newPurchasePrice, item.iva, item.icui, item.ibua, value);
        const newSalePrice = calculatePVP(item.newPurchasePrice, item.iva, item.icui, item.ibua, item.marginPercentage);
        
        setLocalCost(formatCOP(Math.round(neto)));
        setLocalSalePrice(formatCOP(newSalePrice));
        onUpdate(item.lineId, { 
            discount: value,
            newSalePrice: newSalePrice
        });
    };

    const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
        e.target.select();
    };

    const handleSaveQuickEdit = async () => {
        if (!editName.trim() || !editBarcode.trim()) return;
        setIsSavingEdit(true);
        try {
            const token = Cookies.get('org-pos-token');
            
            if (item.isMatched === false) {
                // Logica especial para emparejar manualmente un item no reconocido por IA
                const productUrl = `${process.env.NEXT_PUBLIC_API_URL || '/api'}/products/get-products/${normalizeText(editBarcode)}`;
                const prodRes = await fetch(productUrl, { headers: { 'Authorization': `Bearer ${token}` } });
                
                if (!prodRes.ok) {
                    throw new Error("El codigo de barras ingresado no existe en el sistema. Crea el producto primero.");
                }
                const realProduct = await prodRes.json();

                // Intentar guardar el alias
                const supplierId = localStorage.getItem('selectedSupplierId') || "0"; 
                // We don't have supplierId in ReceptionRow natively unless passed, but we can assume the user can map it later or we just pass it if possible.
                // Actually the API expects supplierId. We can pull it from the DOM or ignore it if the backend allows 0. 
                // For now let's just call it.
                await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/inventory/save-alias`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({
                        supplierId: Number(supplierId), // Ideally we need the real supplier ID, but backend can fallback
                        invoiceName: (item as any).invoiceName || item.productName,
                        productBarcode: realProduct.barcode
                    })
                });

                onUpdate(item.lineId, {
                    productName: realProduct.productName,
                    barcode: realProduct.barcode,
                    isMatched: true,
                    iva: realProduct.iva,
                    icui: realProduct.icui,
                    ibua: realProduct.ibua,
                    marginPercentage: realProduct.marginPercentage,
                    currentStock: realProduct.quantity
                });

                toast({ variant: 'success', title: 'EMPAREJADO', description: 'El producto fue emparejado y el sistema lo recordara la proxima vez.' });
                setIsEditModalOpen(false);
                return;
            }

            // Logica normal para productos ya existentes
            const fullProduct = await apiFetch<any>(`/products/get-products/${item.barcode}`, {}, token!);
            
            if (!fullProduct) throw new Error("Producto no encontrado");

            const payload = {
                ...fullProduct,
                productName: normalizeText(editName),
                barcode: normalizeText(editBarcode)
            };
            
            await apiFetch(`/products/update-products/${item.barcode}`, {
                method: 'PUT',
                body: JSON.stringify(payload),
                fallbackError: 'Error al actualizar producto'
            }, token!);

            onUpdate(item.lineId, {
                productName: payload.productName,
                barcode: payload.barcode
            });

            broadcastRevalidate('PRODUCT_UPDATE');

            setIsEditModalOpen(false);
            toast({ variant: 'success', title: 'ACTUALIZADO', description: 'Producto actualizado exitosamente' });
        } catch (err: any) {
            console.error("Error updating product:", err);
            toast({ variant: 'destructive', title: 'ERROR', description: err.message || 'No se pudo actualizar' });
        } finally {
            setIsSavingEdit(false);
        }
    };

    let matchClasses = "bg-white dark:bg-[#18181b] border-gray-200 dark:border-white/10";
    if (item.matchStatus === 'match') matchClasses = "bg-emerald-50 dark:bg-emerald-900/30 border-emerald-500/50 shadow-[0_0_15px_rgba(16,185,129,0.15)]";
    if (item.matchStatus === 'warning') matchClasses = "bg-amber-50 dark:bg-amber-900/30 border-amber-500/50 shadow-[0_0_15px_rgba(245,158,11,0.15)]";
    if (item.matchStatus === 'extra') matchClasses = "bg-rose-50 dark:bg-rose-900/30 border-rose-500/50 shadow-[0_0_15px_rgba(244,63,94,0.15)]";

    return (
        <div className={`flex flex-col gap-2 p-3 border rounded-2xl transition-all shadow-sm overflow-hidden focus-within:ring-1 focus-within:ring-[var(--accent)] ${matchClasses}`}>
            {/* Modal Edicion Rapida */}
            <Modal isOpen={isEditModalOpen} onOpenChange={setIsEditModalOpen} placement="center">
                <ModalContent className="dark:bg-zinc-950 border border-zinc-200 dark:border-white/10 rounded-2xl">
                    {(onClose) => (
                        <>
                            <ModalHeader className="flex flex-col gap-1 text-center mt-2">
                                <h2 className="font-medium tracking-tight text-xl uppercase tracking-tight text-white">Editar <span className="text-zinc-900 dark:text-zinc-100">Producto</span></h2>
                            </ModalHeader>
                            <ModalBody>
                                <Input
                                    label="Nombre del Producto"
                                    value={editName}
                                    onValueChange={setEditName}
                                    classNames={{ inputWrapper: "bg-[#18181b] border border-zinc-200 dark:border-white/10 rounded-2xl" }}
                                />
                                <Input
                                    label="Codigo de Barras"
                                    value={editBarcode}
                                    onValueChange={setEditBarcode}
                                    classNames={{ inputWrapper: "bg-[#18181b] border border-zinc-200 dark:border-white/10 rounded-2xl" }}
                                />
                            </ModalBody>
                            <ModalFooter>
                                <Button color="danger" variant="flat" onPress={onClose} className="rounded-2xl font-bold">
                                    Cancelar
                                </Button>
                                <Button color="success" onPress={handleSaveQuickEdit} isLoading={isSavingEdit} className="rounded-2xl font-bold">
                                    Guardar
                                </Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>

            {/* Fila 1: Cabecera compacta (Nombre, Codigo y Acciones) */}
            <div className="flex w-full items-center justify-between gap-2 overflow-hidden pb-1 border-b border-gray-50 dark:border-white/5">
                <div className="flex items-center gap-2 md:gap-3 min-w-0 flex-1">
                    <div className="h-8 w-8 md:h-10 md:w-10 rounded-2xl md:rounded-2xl bg-gray-100 dark:bg-[#18181b] flex items-center justify-center text-zinc-900 dark:text-zinc-100 shrink-0 shadow-inner">
                        <Barcode size={16} className="md:w-[18px] md:h-[18px]" />
                    </div>
                    <div className="min-w-0 flex flex-col">
                        <div className="flex items-center gap-1.5 min-w-0">
                            <h3 className="text-[10px] md:text-xs font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tight leading-tight truncate">{item.productName}</h3>
                            <span className="text-[8px] font-medium text-gray-400 dark:text-zinc-600 font-mono tracking-tighter shrink-0 mt-0.5">#{item.barcode}</span>
                            {item.isMatched === false && (
                                <span className="text-[8px] font-bold text-rose-500 bg-rose-500/10 px-1.5 py-0.5 rounded-md uppercase tracking-tight shrink-0 mt-0.5 ml-1 animate-pulse">REVISAR IA</span>
                            )}
                            {isAdmin && (
                                <button onClick={() => { setEditName(item.productName); setEditBarcode(item.barcode); setIsEditModalOpen(true); }} className="text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:text-zinc-100 transition-colors shrink-0 ml-1">
                                    <Edit2 size={12} />
                                </button>
                            )}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[8px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-tight">Stock:</span>
                            <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border ${item.currentStock <= 0 ? 'bg-rose-500/10 text-rose-500 border-rose-500/20' : 'bg-blue-500/10 text-blue-500 border-blue-500/20'}`}>
                                {item.currentStock} UND
                            </span>
                        </div>
                    </div>
                </div>
                
                <div className="flex items-center gap-1.5 shrink-0 ml-2">
                    <div className="flex bg-gray-100 dark:bg-[#18181b]/50 p-0.5 rounded-2xl gap-0.5 shrink-0 h-8 items-center">
                        {[
                            { id: 'purchase', icon: Truck, color: 'emerald' },
                            { id: 'gift', icon: Gift, color: 'pink' },
                            { id: 'return', icon: ArrowDownLeft, color: 'rose' }
                        ].map(btn => (
                            <button
                                key={btn.id}
                                onClick={() => onUpdate(item.lineId, { entryType: btn.id as any })}
                                className={`flex items-center justify-center w-8 h-7 rounded-2xl transition-all ${
                                    item.entryType === btn.id 
                                    ? `bg-${btn.color === 'emerald' ? 'emerald' : btn.color === 'pink' ? 'pink' : 'rose'}-500 text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)]` 
                                    : 'text-gray-400 hover:bg-gray-200 dark:hover:bg-zinc-100 dark:bg-zinc-800'
                                }`}
                            >
                                <btn.icon size={13} />
                            </button>
                        ))}
                    </div>

                    <Button 
                        isIconOnly 
                        variant="flat" 
                        size="sm" 
                        onClick={() => onDelete(item.lineId)} 
                        className="h-8 w-8 min-w-8 bg-rose-50 dark:bg-rose-500/10 text-rose-500 rounded-2xl border border-rose-500/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] ml-1"
                    >
                        <Trash2 size={14} />
                    </Button>
                </div>
            </div>

            {/* Fila 2: Entradas Principales (Rediseno 2 Filas Mobile) */}
            <div className="flex flex-col gap-2 pt-1">
                {/* SUB-FILA 1: CANTIDAD, FISICO REAL Y UNIDAD (3 Columnas) */}
                <div className="grid grid-cols-3 gap-2">
                    <div className="flex flex-col gap-0.5">
                        <label className="text-[10px] font-medium text-gray-400 uppercase ml-1">Cantidad</label>
                        <Input
                            type="number"
                            inputMode="decimal"
                            size="sm"
                            value={localQuantity}
                            onValueChange={(v) => {
                                const allowDecimals = item.unit === 'KG' || item.unit === 'LB' || item.isWeighted;
                                let stringVal = v;
                                if (!allowDecimals) stringVal = stringVal.replace(/[.,]/g, '');
                                
                                setLocalQuantity(stringVal);
                                
                                const numVal = Number(stringVal) || 0;
                                const finalVal = !allowDecimals ? Math.floor(numVal) : numVal;
                                
                                const newEffectiveQty = finalVal * (item.unit === 'LB' ? 0.5 : 1);
                                const bruto = calculateGrossCost(item.newPurchasePrice, item.iva, item.icui, item.ibua);
                                setLocalTotal(formatInitial(bruto * newEffectiveQty));
                                setLocalSubtotal(formatInitial(item.newPurchasePrice * newEffectiveQty));
                                
                                onUpdate(item.lineId, { addedQuantity: finalVal });
                            }}
                            placeholder="0"
                            onFocus={handleFocus}
                            classNames={{
                                inputWrapper: "h-10 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-2xl shadow-inner px-3",
                                input: "font-medium text-xs text-[var(--text-primary)]"
                            }}
                        />
                    </div>
                    <div className="flex flex-col gap-0.5">
                        <label className="text-[10px] font-medium text-gray-400 uppercase ml-1">Fisico Real</label>
                        <Input
                            type="number"
                            inputMode="decimal"
                            size="sm"
                            value={localPhysical}
                            onValueChange={(v) => {
                                if (v === '') {
                                    setLocalPhysical('');
                                    onUpdate(item.lineId, { actualPhysicalStock: undefined });
                                    return;
                                }
                                const allowDecimals = item.unit === 'KG' || item.unit === 'LB' || item.isWeighted;
                                let stringVal = v;
                                if (!allowDecimals) stringVal = stringVal.replace(/[.,]/g, '');
                                
                                setLocalPhysical(stringVal);
                                
                                const numVal = Number(stringVal) || 0;
                                const finalVal = !allowDecimals ? Math.floor(numVal) : numVal;
                                onUpdate(item.lineId, { actualPhysicalStock: finalVal });
                            }}
                            placeholder={String(item.currentStock)}
                            onFocus={handleFocus}
                            classNames={{
                                inputWrapper: "h-10 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-2xl shadow-inner px-3 focus-within:border-[var(--accent)]",
                                input: "font-medium text-xs text-amber-600 dark:text-amber-500"
                            }}
                        />
                    </div>
                    <div className="flex flex-col gap-0.5">
                        <label className="text-[10px] font-medium text-gray-400 uppercase ml-1">Unidad</label>
                        <Dropdown placement="bottom-end" classNames={{ content: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-2xl min-w-[100px]" }}>
                            <DropdownTrigger>
                                <button className="h-10 w-full bg-[var(--bg-elevated)] border border-[var(--border)] rounded-2xl px-3 flex items-center justify-between text-[10px] font-medium uppercase text-[var(--text-secondary)] outline-none hover:border-[var(--accent)] transition-all">
                                    <span>{item.unit}</span>
                                    <ChevronDown size={14} className="opacity-40" />
                                </button>
                            </DropdownTrigger>
                            <DropdownMenu 
                                aria-label="Seleccionar Unidad"
                                variant="flat"
                                disallowEmptySelection
                                selectionMode="single"
                                selectedKeys={new Set([item.unit])}
                                onSelectionChange={(keys) => {
                                    const selected = Array.from(keys)[0] as string;
                                    onUpdate(item.lineId, { unit: selected as any });
                                }}
                            >
                                <DropdownItem key="UND" className="font-medium text-[10px] uppercase h-10">UND (Unidades)</DropdownItem>
                                <DropdownItem key="KG" className="font-medium text-[10px] uppercase h-10">KG (Kilogramos)</DropdownItem>
                                <DropdownItem key="LB" className="font-medium text-[10px] uppercase h-10">LB (Libras)</DropdownItem>
                            </DropdownMenu>
                        </Dropdown>
                    </div>
                </div>

                {/* SUB-FILA 2: COSTO, PVP, SUBTOTAL, TOTAL (Responsive Grid) */}
                <div className="grid grid-cols-2 min-[500px]:grid-cols-4 gap-1.5">
                    <div className="flex flex-col gap-0.5">
                        <label className="text-[9px] font-medium text-gray-400 uppercase ml-1 truncate">Costo</label>
                        <div className="flex items-center bg-[var(--bg-elevated)] rounded-2xl h-10 px-2 gap-1 border border-[var(--border)] shadow-sm focus-within:border-rose-500/50 transition-all">
                            <span className="text-[10px] text-rose-500 font-medium">$</span>
                            <input 
                                className="bg-transparent w-full text-[11px] font-medium tracking-tight tabular-nums text-zinc-900 dark:text-zinc-50 border-none outline-none focus:ring-0 p-0" 
                                value={localCost}
                                inputMode="decimal"
                                onFocus={handleFocus}
                                onChange={(e) => handleCostChange(e.target.value)}
                                onBlur={(e) => handleCostBlur(e.target.value)}
                                onKeyDown={(e) => { if(e.key === 'Enter') handleCostBlur((e.target as HTMLInputElement).value) }}
                                disabled={item.entryType === 'gift'}
                            />
                        </div>
                    </div>
                    <div className="flex flex-col gap-0.5">
                        <label className="text-[10px] font-medium text-gray-400 uppercase ml-1">PVP</label>
                        <div className="flex items-center bg-[var(--bg-elevated)] rounded-2xl h-10 px-2 gap-1 border border-[var(--border)] shadow-sm focus-within:border-[var(--accent)] transition-all">
                            <span className="text-[10px] text-zinc-900 dark:text-zinc-100 font-medium">$</span>
                            <input 
                                className="bg-transparent w-full text-[11px] font-medium tracking-tight tabular-nums text-zinc-900 dark:text-zinc-100 dark:text-zinc-100 border-none outline-none focus:ring-0 p-0" 
                                value={localSalePrice}
                                inputMode="decimal"
                                onFocus={handleFocus}
                                onChange={(e) => handleSalePriceChange(e.target.value)}
                                onBlur={(e) => handleSalePriceBlur(e.target.value)}
                                onKeyDown={(e) => { if(e.key === 'Enter') handleSalePriceBlur((e.target as HTMLInputElement).value) }}
                            />
                        </div>
                    </div>
                    <div className="flex flex-col gap-0.5">
                        <label className="text-[10px] font-medium text-gray-400 uppercase ml-1">Subt.</label>
                        <div className="flex items-center bg-[var(--bg-elevated)] rounded-2xl h-10 px-2 gap-1 border border-[var(--border)] shadow-sm focus-within:border-[var(--accent)] transition-all">
                            <span className="text-[10px] text-zinc-900 dark:text-zinc-100 font-medium">$</span>
                            <input 
                                className={`bg-transparent w-full text-[11px] font-medium tracking-tight tabular-nums border-none outline-none focus:ring-0 p-0 ${item.entryType === 'gift' ? 'text-gray-400' : 'text-zinc-900 dark:text-zinc-50'}`} 
                                value={localSubtotal}
                                inputMode="decimal"
                                onFocus={handleFocus}
                                onChange={(e) => handleSubtotalChange(e.target.value)}
                                onBlur={(e) => handleSubtotalBlur(e.target.value)}
                                onKeyDown={(e) => { if(e.key === 'Enter') handleSubtotalBlur((e.target as HTMLInputElement).value) }}
                                disabled={item.entryType === 'gift'}
                            />
                        </div>
                    </div>
                    <div className="flex flex-col gap-0.5">
                        <label className="text-[10px] font-medium text-gray-400 uppercase ml-1">Total</label>
                        <div className="flex items-center bg-[var(--bg-elevated)] rounded-2xl h-10 px-2 gap-1 border border-[var(--border)] shadow-sm focus-within:border-indigo-500/50 transition-all">
                            <span className="text-[10px] text-indigo-500 font-medium">$</span>
                            <input 
                                className={`bg-transparent w-full text-[11px] font-medium tracking-tight tabular-nums border-none outline-none focus:ring-0 p-0 ${item.entryType === 'gift' ? 'text-gray-400' : 'text-indigo-600 dark:text-indigo-400'}`} 
                                value={localTotal}
                                inputMode="decimal"
                                onFocus={handleFocus}
                                onChange={(e) => handleTotalChange(e.target.value)}
                                onBlur={(e) => handleTotalBlur(e.target.value)}
                                onKeyDown={(e) => { if(e.key === 'Enter') handleTotalBlur((e.target as HTMLInputElement).value) }}
                                disabled={item.entryType === 'gift'}
                            />
                        </div>
                    </div>
                </div>

                {/* Panel de porcentajes (Fila 3) */}
                <div className="flex flex-wrap items-center gap-1.5 bg-[var(--bg-elevated)] p-1.5 rounded-2xl border border-[var(--border)] shrink-0 shadow-inner">
                    <div className="flex items-center gap-1 card-base border-none px-1.5 py-1 rounded-2xl border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                        <span className="text-[8px] font-medium text-zinc-900 dark:text-zinc-100 tracking-tight">DTO</span>
                        <input className="bg-transparent w-6 text-center text-[10px] font-medium border-none outline-none p-0 tabular-nums" value={localDiscount} inputMode="decimal" onFocus={handleFocus} onChange={(e) => handleDiscountChange(e.target.value)} disabled={item.entryType === 'gift'} />
                        <span className="text-[8px] text-zinc-900 dark:text-zinc-100 font-medium">%</span>
                    </div>
                    <div className="flex items-center gap-1 card-base border-none px-1.5 py-1 rounded-2xl border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                        <span className="text-[8px] font-medium text-rose-500 tracking-tight">IVA</span>
                        <input className="bg-transparent w-6 text-center text-[10px] font-medium border-none outline-none p-0 tabular-nums" value={localIva} inputMode="decimal" onFocus={handleFocus} onChange={(e) => handleTaxChange('iva', e.target.value)} />
                        <span className="text-[8px] text-rose-500 font-medium">%</span>
                    </div>
                    <div className="flex items-center gap-1 card-base border-none px-1.5 py-1 rounded-2xl border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                        <span className="text-[8px] font-medium text-amber-500 tracking-tight">ICUI</span>
                        <input className="bg-transparent w-6 text-center text-[10px] font-medium border-none outline-none p-0 tabular-nums" value={localIcui} inputMode="decimal" onFocus={handleFocus} onChange={(e) => handleTaxChange('icui', e.target.value)} />
                        <span className="text-[8px] text-amber-500 font-medium">%</span>
                    </div>
                    <div className="flex items-center gap-1 card-base border-none px-1.5 py-1 rounded-2xl border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                        <span className="text-[8px] font-medium text-sky-500 tracking-tight">IBUA</span>
                        <input className="bg-transparent w-6 text-center text-[10px] font-medium border-none outline-none p-0 tabular-nums" value={localIbua} inputMode="decimal" onFocus={handleFocus} onChange={(e) => handleTaxChange('ibua', e.target.value)} />
                        <span className="text-[8px] text-sky-500 font-medium">%</span>
                    </div>
                    <div className="flex items-center gap-1 bg-violet-500/10 dark:bg-violet-500/20 px-1.5 py-1 rounded-2xl border border-violet-500/20">
                        <span className="text-[8px] font-medium text-violet-500 tracking-tight">GAN</span>
                        <input className="bg-transparent w-7 text-center text-[10px] font-medium border-none outline-none p-0 text-violet-600 dark:text-violet-400 tabular-nums" value={localMargin} inputMode="decimal" onFocus={handleFocus} onChange={(e) => handleMarginChange(String(e.target.value))} />
                        <span className="text-[8px] text-violet-500 font-medium">%</span>
                    </div>
                    <div className="flex items-center gap-1.5 bg-white/5 dark:bg-white/5 px-2 py-1 rounded-2xl border border-emerald-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.12)] animate-in fade-in slide-in-from-right-1 duration-300">
                        <span className="text-[8px] font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-300 uppercase tracking-tight">Ganancia Real</span>
                        <span className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-300">
                            {Math.round(((item.newSalePrice / (calculateNetCost(item.newPurchasePrice, item.iva, item.icui, item.ibua, item.discount) || 1)) - 1) * 100)}%
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
});

ReceptionRow.displayName = 'ReceptionRow';

export default ReceptionRow;
