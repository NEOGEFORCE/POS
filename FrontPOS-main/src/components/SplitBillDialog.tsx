"use client"

import { useState, useEffect, useMemo, useRef } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from "@/components/ui/dialog"
import ClientSelectorModal from '@/app/(app)/sales/components/ClientSelectorModal'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table'
import { 
    ChevronRight, 
    ChevronsRight, 
    ChevronLeft, 
    ChevronsLeft, 
    X, 
    Check, 
    User,
    Clock,
    Zap
} from 'lucide-react'
import { Product } from '@/lib/definitions'
import { formatCurrency, applyRounding } from "@/lib/utils"

interface CartItem extends Product {
    cartQuantity: number;
    cartItemId: string;
}

interface SplitBillDialogProps {
    isOpen: boolean;
    onClose: () => void;
    originalItems: CartItem[];
    customers: any[];
    currentCustomerDni: string;
    onConfirm: (leftItems: CartItem[], rightItems: CartItem[], targetCustomerDni: string) => void;
}

export function SplitBillDialog({ isOpen, onClose, originalItems, customers, currentCustomerDni, onConfirm }: SplitBillDialogProps) {
    const [leftItems, setLeftItems] = useState<CartItem[]>([])
    const [rightItems, setRightItems] = useState<CartItem[]>([])
    const [selectedLeft, setSelectedLeft] = useState<string | null>(null)
    const [selectedRight, setSelectedRight] = useState<string | null>(null)
    const [targetCustomer, setTargetCustomer] = useState<{dni: string, name: string} | null>(null)
    const [isClientModalOpen, setIsClientModalOpen] = useState(false)

    const prevIsOpen = useRef(isOpen)

    useEffect(() => {
        if (isOpen && !prevIsOpen.current) {
            setLeftItems([...originalItems])
            setRightItems([])
            setSelectedLeft(originalItems.length > 0 ? originalItems[0].cartItemId : null)
            setSelectedRight(null)
            const initialCustomer = customers.find(c => String(c.dni) === String(currentCustomerDni)) || { dni: String(currentCustomerDni), name: 'Consumidor Final' };
            setTargetCustomer(initialCustomer);
        }
        prevIsOpen.current = isOpen
    }, [isOpen, currentCustomerDni, customers])

    // Auto-select first item when list changes
    useEffect(() => {
        if (leftItems.length > 0 && (!selectedLeft || !leftItems.find(i => i.cartItemId === selectedLeft))) {
            setSelectedLeft(leftItems[0].cartItemId)
        } else if (leftItems.length === 0) {
            setSelectedLeft(null)
        }
    }, [leftItems, selectedLeft])

    useEffect(() => {
        if (rightItems.length > 0 && (!selectedRight || !rightItems.find(i => i.cartItemId === selectedRight))) {
            setSelectedRight(rightItems[0].cartItemId)
        } else if (rightItems.length === 0) {
            setSelectedRight(null)
        }
    }, [rightItems, selectedRight])

    const moveToRight = (cartItemId: string, all: boolean = false) => {
        const index = leftItems.findIndex(i => i.cartItemId === cartItemId)
        if (index === -1) return

        const item = leftItems[index]
        const qtyToMove = all ? item.cartQuantity : 1

        // Update Left
        const newLeft = [...leftItems]
        if (item.cartQuantity <= qtyToMove) {
            newLeft.splice(index, 1)
        } else {
            newLeft[index] = { ...item, cartQuantity: item.cartQuantity - qtyToMove }
        }
        setLeftItems(newLeft)

        // Update Right
        const newRight = [...rightItems]
        const rightIndex = newRight.findIndex(i => i.cartItemId === cartItemId)
        if (rightIndex > -1) {
            newRight[rightIndex] = { ...newRight[rightIndex], cartQuantity: newRight[rightIndex].cartQuantity + qtyToMove }
        } else {
            newRight.push({ ...item, cartQuantity: qtyToMove })
        }
        setRightItems(newRight)
    }

    const moveToLeft = (cartItemId: string, all: boolean = false) => {
        const index = rightItems.findIndex(i => i.cartItemId === cartItemId)
        if (index === -1) return

        const item = rightItems[index]
        const qtyToMove = all ? item.cartQuantity : 1

        // Update Right
        const newRight = [...rightItems]
        if (item.cartQuantity <= qtyToMove) {
            newRight.splice(index, 1)
        } else {
            newRight[index] = { ...item, cartQuantity: item.cartQuantity - qtyToMove }
        }
        setRightItems(newRight)

        // Update Left
        const newLeft = [...leftItems]
        const leftIndex = newLeft.findIndex(i => i.cartItemId === cartItemId)
        if (leftIndex > -1) {
            newLeft[leftIndex] = { ...newLeft[leftIndex], cartQuantity: newLeft[leftIndex].cartQuantity + qtyToMove }
        } else {
            newLeft.push({ ...item, cartQuantity: qtyToMove })
        }
        setLeftItems(newLeft)
    }

    const moveAllToRight = () => {
        setRightItems([...rightItems, ...leftItems.map(li => {
            const existing = rightItems.find(ri => ri.cartItemId === li.cartItemId)
            if (existing) {
                // This shouldn't normally happen if we manage state correctly, but for safety:
                return { ...li, cartQuantity: li.cartQuantity + existing.cartQuantity }
            }
            return li
        })])
        // Simplified move all:
        const combined = [...rightItems]
        leftItems.forEach(li => {
            const idx = combined.findIndex(ri => ri.cartItemId === li.cartItemId)
            if (idx > -1) combined[idx].cartQuantity += li.cartQuantity
            else combined.push({...li})
        })
        setRightItems(combined)
        setLeftItems([])
    }

    const moveAllToLeft = () => {
        const combined = [...leftItems]
        rightItems.forEach(ri => {
            const idx = combined.findIndex(li => li.cartItemId === ri.cartItemId)
            if (idx > -1) combined[idx].cartQuantity += ri.cartQuantity
            else combined.push({...ri})
        })
        setLeftItems(combined)
        setRightItems([])
    }

    const calculateTotal = (items: CartItem[]) => {
        return items.reduce((sum, item) => sum + applyRounding(Number(item.salePrice) * item.cartQuantity), 0)
    }

    const leftTotal = calculateTotal(leftItems)
    const rightTotal = calculateTotal(rightItems)

    return (
        <>
            <Dialog open={isOpen} onOpenChange={(open) => {
            if (!open && isClientModalOpen) return;
            if (!open) onClose();
        }}>
             <DialogContent 
                className="max-w-[95vw] lg:max-w-[90vw] w-full lg:w-[900px] p-0 overflow-hidden bg-white dark:bg-zinc-950 border-gray-200 dark:border-white/5 rounded-3xl shadow-2xl h-[90vh] lg:h-[420px] flex flex-col"
                onPointerDownOutside={(e) => e.preventDefault()}
                onEscapeKeyDown={(e) => e.preventDefault()}
            >
                <DialogHeader className="p-3 bg-gray-50 dark:bg-black border-b border-gray-200 dark:border-white/5 shrink-0">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <div className="h-8 w-8 rounded-xl bg-emerald-500 flex items-center justify-center">
                                <Zap className="h-4 w-4 text-black" />
                            </div>
                            <div>
                                <DialogTitle className="text-sm font-black text-gray-900 dark:text-white italic uppercase tracking-tighter leading-none">Dividir Cuenta</DialogTitle>
                                <DialogDescription className="text-[8px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-widest mt-0.5">V4.0 DENSITY</DialogDescription>
                            </div>
                        </div>
                    </div>
                </DialogHeader>

                <div className="flex flex-col lg:flex-row flex-1 p-2 gap-2 min-h-0 overflow-y-auto lg:overflow-hidden custom-scrollbar">
                    {/* Mesa / Cuenta Original */}
                    <div className="flex-1 flex flex-col bg-gray-50 dark:bg-black rounded-2xl border border-gray-200 dark:border-white/5 overflow-hidden shadow-inner">
                        <div className="p-2 bg-gray-100 dark:bg-zinc-900 border-b border-gray-200 dark:border-white/5 flex items-center justify-between shrink-0">
                            <span className="text-[8px] font-black text-gray-900 dark:text-white uppercase tracking-widest">Cuenta Original</span>
                            <span className="text-[7px] font-black text-emerald-600 dark:text-emerald-500 uppercase bg-emerald-100 dark:bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-200 dark:border-emerald-500/20">Pendiente</span>
                        </div>
                        <ScrollArea className="flex-1">
                            <Table>
                                <TableHeader className="bg-white/80 dark:bg-zinc-950/50 sticky top-0 z-10 backdrop-blur-sm">
                                    <TableRow className="border-b border-gray-200 dark:border-white/5 hover:bg-transparent h-6">
                                        <TableHead className="text-[7px] font-black uppercase text-gray-500 dark:text-zinc-500 h-6 pl-2">Articulo</TableHead>
                                        <TableHead className="text-[7px] font-black uppercase text-gray-500 dark:text-zinc-500 h-6 text-center">Cant</TableHead>
                                        <TableHead className="text-[7px] font-black uppercase text-gray-500 dark:text-zinc-500 h-6 text-right pr-2">Total</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {leftItems.map(item => (
                                        <TableRow 
                                            key={item.cartItemId} 
                                            className={`border-b border-gray-100 dark:border-white/5 transition-all cursor-pointer h-7 ${selectedLeft === item.cartItemId ? 'bg-emerald-100 dark:bg-emerald-500 text-emerald-900 dark:text-black' : 'hover:bg-gray-100 dark:hover:bg-white/5 text-gray-900 dark:text-gray-100'}`}
                                            onClick={() => setSelectedLeft(item.cartItemId)}
                                            onDoubleClick={() => moveToRight(item.cartItemId)}
                                        >
                                            <TableCell className="text-[8px] font-black uppercase tracking-tight py-1 pl-2 max-w-[120px] truncate">{item.productName}</TableCell>
                                            <TableCell className="text-[8px] font-black tabular-nums text-center py-1">x{item.cartQuantity.toFixed(item.isWeighted ? 3 : 0)}</TableCell>
                                            <TableCell className="text-[8px] font-black tabular-nums text-right py-1 pr-2">${formatCurrency(applyRounding(Number(item.salePrice) * item.cartQuantity))}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </ScrollArea>
                        <div className="p-2 bg-gray-100 dark:bg-zinc-950 border-t border-gray-200 dark:border-white/5 shrink-0">
                            <div className="flex justify-between text-[10px] font-black text-gray-900 dark:text-white uppercase italic"><span>Restante</span><span className="text-emerald-600 dark:text-emerald-500">${formatCurrency(leftTotal)}</span></div>
                        </div>
                    </div>

                    {/* Controles Centrales */}
                    <div className="lg:w-10 flex lg:flex-col items-center justify-center gap-2 shrink-0 py-2 lg:py-0">
                        <Button variant="outline" size="icon" className="h-8 w-8 rounded-lg border-gray-200 dark:border-white/10 bg-white dark:bg-zinc-900 text-emerald-600 dark:text-emerald-500 hover:bg-emerald-500 hover:text-white dark:hover:text-black transition-all shadow-sm" onClick={() => selectedLeft && moveToRight(selectedLeft)} disabled={!selectedLeft}>
                            <ChevronRight className="h-4 w-4 lg:rotate-0 rotate-90" />
                        </Button>
                        <Button variant="outline" size="icon" className="h-8 w-8 rounded-lg border-gray-200 dark:border-white/10 bg-white dark:bg-zinc-900 text-emerald-600 dark:text-emerald-500 hover:bg-emerald-500 hover:text-white dark:hover:text-black transition-all shadow-sm" onClick={() => selectedLeft && moveToRight(selectedLeft, true)} disabled={!selectedLeft}>
                            <ChevronsRight className="h-4 w-4 lg:rotate-0 rotate-90" />
                        </Button>
                        <Button variant="outline" size="icon" className="h-8 w-8 rounded-lg border-gray-200 dark:border-white/10 bg-white dark:bg-zinc-900 text-rose-600 dark:text-rose-500 hover:bg-rose-500 hover:text-white transition-all shadow-sm" onClick={() => selectedRight && moveToLeft(selectedRight, true)} disabled={!selectedRight}>
                            <ChevronsLeft className="h-4 w-4 lg:rotate-0 rotate-90" />
                        </Button>
                        <Button variant="outline" size="icon" className="h-8 w-8 rounded-lg border-gray-200 dark:border-white/10 bg-white dark:bg-zinc-900 text-rose-600 dark:text-rose-500 hover:bg-rose-500 hover:text-white transition-all shadow-sm" onClick={() => selectedRight && moveToLeft(selectedRight)} disabled={!selectedRight}>
                            <ChevronLeft className="h-4 w-4 lg:rotate-0 rotate-90" />
                        </Button>
                    </div>

                    {/* Cuenta de Pago (Split) */}
                    <div className="flex-1 flex flex-col bg-gray-50 dark:bg-black rounded-2xl border border-gray-200 dark:border-white/5 overflow-hidden shadow-inner">
                        <div className="p-2 bg-emerald-50 dark:bg-emerald-500/10 border-b border-emerald-100 dark:border-emerald-500/20 flex items-center justify-between shrink-0">
                            <span className="text-[8px] font-black text-emerald-700 dark:text-emerald-500 uppercase tracking-widest">Cobrar Ahora</span>
                            
                            <Button 
                                size="sm" 
                                variant="outline" 
                                className={`h-9 px-3 min-w-0 rounded-xl font-black transition-all duration-300 border shadow-sm ${
                                    targetCustomer?.dni !== currentCustomerDni 
                                        ? 'bg-emerald-500 text-white border-emerald-400 animate-in zoom-in-95 shadow-emerald-500/20' 
                                        : 'bg-white dark:bg-zinc-900 text-emerald-700 dark:text-emerald-400 border-emerald-100 dark:border-emerald-500/10'
                                }`}
                                onClick={() => setIsClientModalOpen(true)}
                            >
                                <User size={14} className="mr-2 shrink-0" />
                                <div className="flex flex-col items-start leading-none gap-1 py-1">
                                    <span className="text-[9px] uppercase tracking-wider truncate max-w-[110px]">
                                        {targetCustomer?.name || 'Consumidor Final'}
                                    </span>
                                    <span className={`text-[7px] font-bold uppercase tracking-widest ${targetCustomer?.dni !== currentCustomerDni ? 'text-emerald-100' : 'text-emerald-600 dark:text-emerald-500'}`}>
                                        DNI: {targetCustomer?.dni || '0'}
                                    </span>
                                </div>
                            </Button>
                        </div>
                        <ScrollArea className="flex-1">
                        <Table>
                                <TableHeader className="bg-white/80 dark:bg-zinc-950/50 sticky top-0 z-10 backdrop-blur-sm">
                                    <TableRow className="border-b border-gray-200 dark:border-white/5 hover:bg-transparent h-6">
                                        <TableHead className="text-[7px] font-black uppercase text-gray-500 dark:text-zinc-500 h-6 pl-2">Articulo</TableHead>
                                        <TableHead className="text-[7px] font-black uppercase text-gray-500 dark:text-zinc-500 h-6 text-center">Cant</TableHead>
                                        <TableHead className="text-[7px] font-black uppercase text-gray-500 dark:text-zinc-500 h-6 text-right pr-2">Total</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {rightItems.map(item => (
                                        <TableRow 
                                            key={item.cartItemId} 
                                            className={`border-b border-gray-100 dark:border-white/5 transition-all cursor-pointer h-7 ${selectedRight === item.cartItemId ? 'bg-emerald-100 dark:bg-emerald-500 text-emerald-900 dark:text-black' : 'hover:bg-gray-100 dark:hover:bg-white/5 text-gray-900 dark:text-gray-100'}`}
                                            onClick={() => setSelectedRight(item.cartItemId)}
                                            onDoubleClick={() => moveToLeft(item.cartItemId)}
                                        >
                                            <TableCell className="text-[8px] font-black uppercase tracking-tight py-1 pl-2 max-w-[120px] truncate">{item.productName}</TableCell>
                                            <TableCell className="text-[8px] font-black tabular-nums text-center py-1">x{item.cartQuantity.toFixed(item.isWeighted ? 3 : 0)}</TableCell>
                                            <TableCell className="text-[8px] font-black tabular-nums text-right py-1 pr-2">${formatCurrency(applyRounding(Number(item.salePrice) * item.cartQuantity))}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </ScrollArea>
                        <div className="p-2 bg-gray-100 dark:bg-zinc-950 border-t border-gray-200 dark:border-white/5 shrink-0">
                            <div className="flex justify-between text-[10px] font-black text-emerald-600 dark:text-emerald-500 uppercase italic"><span>A Cobrar</span><span className="text-gray-900 dark:text-white">${formatCurrency(rightTotal)}</span></div>
                        </div>
                    </div>
                </div>

                <div className="p-3 bg-gray-50 dark:bg-black border-t border-gray-200 dark:border-white/5 flex gap-2 shrink-0">
                    <Button variant="outline" className="flex-1 h-10 rounded-xl border-gray-200 dark:border-white/5 bg-white dark:bg-zinc-900 text-gray-500 dark:text-zinc-500 font-black uppercase text-[8px] tracking-widest hover:bg-rose-50 dark:hover:bg-rose-500/10 hover:border-rose-200 hover:text-rose-600 dark:hover:text-rose-500 shadow-sm transition-all" onClick={onClose}>
                        <ChevronLeft className="h-3 w-3 mr-1" /> VOLVER / CANCELAR
                    </Button>
                    <Button className="flex-[2] h-10 rounded-xl bg-emerald-500 text-white dark:text-black font-black uppercase text-[10px] tracking-widest hover:bg-emerald-600 dark:hover:bg-emerald-400 active:scale-95 disabled:opacity-50 shadow-md transition-all" disabled={rightItems.length === 0} onClick={() => {
                        const customerDni = targetCustomer?.dni || '0';
                        onConfirm(leftItems, rightItems, customerDni);
                    }}>
                        <Check className="h-4 w-4 mr-1 stroke-[3]" /> CONFIRMAR
                    </Button>
                </div>
            </DialogContent>

            </Dialog>

            <ClientSelectorModal 
                isOpen={isClientModalOpen}
                onOpenChange={setIsClientModalOpen}
                customers={customers}
                onSelect={(c) => {
                    console.log('DEBUG: Cliente seleccionado en Split:', c);
                    setTargetCustomer({ dni: String(c.dni), name: c.name });
                }}
                selectedClientDni={targetCustomer?.dni}
            />
        </>
    )
}
