"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Badge, Spinner, Avatar } from "@heroui/react";
import {
    ArrowLeft, Search, Plus, Minus, Camera, Truck,
    Trash2, AlertCircle, Package, ShieldCheck, Gift, ArrowDownLeft, X, Barcode, ChevronRight, Loader2, Calculator
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Product, Supplier } from '@/lib/definitions';
import { formatCurrency, parseCurrency, applyRounding } from "@/lib/utils";
import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import Link from 'next/link';
import { ScannerOverlay } from '@/components/ScannerOverlay';

interface ReceiveItem {
    barcode: string;
    productName: string;
    addedQuantity: number;
    newPurchasePrice: number; // Precio Unitario
    newSalePrice: number;
    marginPercentage: number;
    entryType: 'purchase' | 'gift' | 'return';
}

export default function ReceiveInventoryPage() {
    const router = useRouter();
    const { toast } = useToast();
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [notFoundDialogOpen, setNotFoundDialogOpen] = useState(false);
    const [scannedNotFoundCode, setScannedNotFoundCode] = useState('');

    const [products, setProducts] = useState<Product[]>([]);
    const [suppliers, setSuppliers] = useState<Supplier[]>([]);
    const [selectedGlobalSupplier, setSelectedGlobalSupplier] = useState<string>('none');
    const [receiveList, setReceiveList] = useState<ReceiveItem[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [isScannerOpen, setIsScannerOpen] = useState(false);

    const searchRef = useRef<HTMLInputElement>(null);

    const loadData = useCallback(async () => {
        const token = localStorage.getItem('org-pos-token');
        if (!token) { router.push('/login'); return; }
        try {
            const [pRes, sRes] = await Promise.all([
                fetch(`${process.env.NEXT_PUBLIC_API_URL}/products/all-products`, { headers: { 'Authorization': `Bearer ${token}` } }),
                fetch(`${process.env.NEXT_PUBLIC_API_URL}/suppliers/all-suppliers`, { headers: { 'Authorization': `Bearer ${token}` } })
            ]);
            if (pRes.ok) setProducts(await pRes.json());
            if (sRes.ok) setSuppliers(await sRes.json());
        } catch (err) { console.error(err); } finally { setLoading(false); }
    }, [router]);

    useEffect(() => { loadData(); }, [loadData]);

    // --- PESISTENCIA ---
    useEffect(() => {
        const savedList = localStorage.getItem('org-pos-reception-list');
        const savedSupplier = localStorage.getItem('org-pos-reception-supplier');
        if (savedList) {
            try {
                const parsed = JSON.parse(savedList);
                if (Array.isArray(parsed)) setReceiveList(parsed);
            } catch (e) { console.error("Error loading saved reception list", e); }
        }
        if (savedSupplier) setSelectedGlobalSupplier(savedSupplier);
    }, []);

    useEffect(() => {
        if (receiveList.length > 0) {
            localStorage.setItem('org-pos-reception-list', JSON.stringify(receiveList));
        } else {
            localStorage.removeItem('org-pos-reception-list');
        }
    }, [receiveList]);

    useEffect(() => {
        localStorage.setItem('org-pos-reception-supplier', selectedGlobalSupplier);
    }, [selectedGlobalSupplier]);

    // --- SONIDOS ---
    const playScanSound = (type: 'success' | 'error') => {
        try {
            const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);

            if (type === 'success') {
                osc.frequency.setValueAtTime(880, ctx.currentTime);
                gain.gain.setValueAtTime(0.1, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
                osc.start();
                osc.stop(ctx.currentTime + 0.1);
            } else {
                osc.type = 'square';
                osc.frequency.setValueAtTime(150, ctx.currentTime);
                gain.gain.setValueAtTime(0.1, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
                osc.start();
                osc.stop(ctx.currentTime + 0.3);
            }
        } catch (e) {
            console.warn("Audio feedback not supported or blocked", e);
        }
    };

    const filteredProductsSearch = useMemo(() => {
        if (!searchQuery) return [];
        return products.filter(p =>
            p.productName.toLowerCase().includes(searchQuery.toLowerCase()) ||
            p.barcode.includes(searchQuery)
        ).slice(0, 6);
    }, [products, searchQuery]);

    const addToReceive = useCallback((product: Product) => {
        setReceiveList(prev => {
            const existing = prev.find(item => item.barcode === product.barcode);
            if (existing) {
                return prev.map(item => item.barcode === product.barcode
                    ? { ...item, addedQuantity: item.addedQuantity + 1 } : item
                );
            }
            return [{
                barcode: product.barcode,
                productName: product.productName,
                addedQuantity: 1,
                newPurchasePrice: Number(product.purchasePrice),
                newSalePrice: applyRounding(Number(product.salePrice)),
                marginPercentage: product.purchasePrice > 0 ? ((product.salePrice / product.purchasePrice) - 1) * 100 : 30,
                entryType: 'purchase'
            }, ...prev];
        });
        setSearchQuery('');
    }, []);

    const totalOrderValue = useMemo(() => {
        return receiveList.reduce((sum, item) => {
            const cost = item.newPurchasePrice * item.addedQuantity;
            if (item.entryType === 'purchase') return sum + cost;
            if (item.entryType === 'return') return sum - cost;
            return sum;
        }, 0);
    }, [receiveList]);

    const handleConfirmReceive = async () => {
        if (receiveList.length === 0) return;
        setSubmitting(true);
        const token = localStorage.getItem('org-pos-token');
        try {
            const entries = receiveList.map(item => ({
                barcode: item.barcode,
                addedQuantity: item.entryType === 'return' ? -Number(item.addedQuantity) : Number(item.addedQuantity),
                newPurchasePrice: (item.entryType === 'gift') ? 0 : Number(item.newPurchasePrice),
                newSalePrice: Number(item.newSalePrice),
                supplierId: selectedGlobalSupplier !== 'none' ? Number(selectedGlobalSupplier) : undefined
            }));
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/products/bulk-receive`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ entries })
            });
            if (res.ok) {
                toast({ title: "OPERACIÓN EXITOSA" });
                localStorage.removeItem('org-pos-reception-list');
                localStorage.removeItem('org-pos-reception-supplier');
                setReceiveList([]);
                router.push('/products');
            }
        } catch (err) { console.error(err); } finally { setSubmitting(false); }
    };

    if (loading) return <div className="h-screen flex items-center justify-center bg-gray-50 dark:bg-zinc-950 transition-colors duration-500"><Loader2 className="h-10 w-10 animate-spin text-emerald-500" /></div>;

    return (
        <div className="flex flex-col h-screen bg-gray-50 dark:bg-zinc-950 text-white overflow-hidden transition-colors duration-500">
            {/* Header */}
            <header className="px-3 py-1 bg-white dark:bg-zinc-900 border-b border-gray-200 dark:border-white/5 flex justify-between items-center shrink-0 shadow-sm z-30">
                <div className="flex items-center gap-2">
                    <div>
                        <h1 className="text-sm font-black text-gray-900 dark:text-white uppercase tracking-tighter italic leading-none">Carga <span className="text-emerald-500">Maestra</span></h1>
                        <p className="text-[7px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest mt-0.5">Audit Ledger V9.0</p>
                    </div>
                </div>

                <div className="flex items-center gap-4">
                    {submitting && (
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                            <Loader2 size={12} className="animate-spin text-emerald-500" />
                            <span className="text-[8px] font-black text-emerald-500 uppercase">Procesando</span>
                        </div>
                    )}
                    <div className="flex items-center gap-2">
                        <Badge color="success" variant="flat" size="sm" className="font-black h-5 border-none text-[8px]">{receiveList.length} ART</Badge>
                        
                        {receiveList.length > 0 && (
                            <Button isIconOnly variant="flat" color="danger" size="sm" onPress={() => { if(confirm("¿VACIAR TODA LA LISTA?")) { setReceiveList([]); localStorage.removeItem('org-pos-reception-list'); toast({ title: "LISTA VACIADA" }); } }} className="bg-rose-50 dark:bg-rose-500/10 text-rose-500 rounded-lg h-7 w-7 min-w-0">
                                <Trash2 size={12} />
                            </Button>
                        )}

                        <Button size="sm" onPress={() => setIsScannerOpen(true)} className="bg-emerald-500 text-white font-black uppercase text-[9px] h-7 px-3 rounded-lg shadow-sm italic">
                            <Camera size={12} className="mr-1" /> CÁMARA
                        </Button>
                    </div>
                </div>
            </header>

            {/* Listado de Productos - DISEÑO AL RAS CON CALCULADORA */}
            <div className="flex-1 overflow-y-auto p-2 bg-gray-100 dark:bg-zinc-950 custom-scrollbar divide-y divide-white/5">
                {receiveList.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center opacity-20 text-zinc-500">
                        <Package size={80} strokeWidth={0.5} />
                        <p className="text-[10px] font-black uppercase tracking-[0.5em] mt-4 italic">Lista Vacía</p>
                    </div>
                ) : (
                    receiveList.map((item, idx) => (
                        <div key={item.barcode} className="flex flex-col lg:flex-row lg:items-center gap-2 p-2 bg-white dark:bg-black transition-colors min-h-[50px] border-b border-gray-100 dark:border-white/5">
                            {/* Info Base */}
                            <div className="flex-1 min-w-0 flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                    <div className="h-7 w-7 rounded-lg bg-gray-100 dark:bg-zinc-900 flex items-center justify-center text-emerald-500 shrink-0"><Barcode size={14} /></div>
                                    <div className="min-w-0">
                                        <h3 className="text-[11px] font-black text-gray-900 dark:text-white uppercase italic leading-tight truncate">{item.productName}</h3>
                                        <p className="text-[8px] font-black text-gray-400 dark:text-zinc-600 font-mono mt-0.5 tracking-tighter">#{item.barcode}</p>
                                    </div>
                                </div>
                                
                                <Button 
                                    isIconOnly 
                                    variant="flat" 
                                    size="sm" 
                                    onClick={() => setReceiveList(p => p.filter((_, i) => i !== idx))} 
                                    className="h-8 w-8 min-w-8 bg-rose-50 dark:bg-rose-500/10 text-rose-500 rounded-lg hover:bg-rose-500 hover:text-white transition-all border border-rose-500/10 shadow-sm lg:hidden"
                                >
                                    <Trash2 size={14} />
                                </Button>
                            </div>

                            {/* Selector de Protocolo */}
                            <div className="flex bg-gray-100 dark:bg-zinc-900 rounded-lg gap-0.5 p-0.5 shrink-0">
                                {[
                                    { id: 'purchase', icon: Truck, color: 'emerald', label: 'PAGO' },
                                    { id: 'gift', icon: Gift, color: 'pink', label: 'GRATIS' },
                                    { id: 'return', icon: ArrowDownLeft, color: 'rose', label: 'DEVOL.' }
                                ].map(btn => (
                                    <button
                                        key={btn.id}
                                        onClick={() => setReceiveList(p => p.map((it, i) => i === idx ? { ...it, entryType: btn.id as any } : it))}
                                        className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-all ${item.entryType === btn.id ? `bg-${btn.color}-500 text-white shadow-sm` : 'text-gray-400 dark:text-zinc-500'}`}
                                    >
                                        <btn.icon size={10} />
                                        <span className="text-[7px] font-black uppercase">{btn.label}</span>
                                    </button>
                                ))}
                            </div>

                            {/* CALCULADORA DE COSTOS E INPUTS */}
                            <div className="flex items-center justify-between lg:justify-end gap-5 shrink-0">
                                <div className="space-y-0.5">
                                    <span className="text-[7px] font-black text-gray-400 uppercase tracking-widest ml-1">CANTIDAD</span>
                                    <div className="flex items-center bg-gray-100 dark:bg-zinc-900 rounded-lg h-7 px-1 gap-1 border border-gray-200 dark:border-white/5">
                                        <button onClick={() => {
                                            const newQty = Math.max(1, item.addedQuantity - 1);
                                            setReceiveList(p => p.map((it, i) => i === idx ? { ...it, addedQuantity: newQty } : it))
                                        }} className="text-rose-500"><Minus size={12} /></button>
                                        <input type="number" className="bg-transparent w-6 text-center text-[10px] font-black text-gray-900 dark:text-white border-none outline-none focus:ring-0" value={item.addedQuantity}
                                            onChange={(e) => {
                                                const q = Number(e.target.value);
                                                setReceiveList(p => p.map((it, i) => i === idx ? { ...it, addedQuantity: q } : it))
                                            }} />
                                        <button onClick={() => setReceiveList(p => p.map((it, i) => i === idx ? { ...it, addedQuantity: it.addedQuantity + 1 } : it))} className="text-emerald-500"><Plus size={12} /></button>
                                    </div>
                                </div>

                                {/* TOTAL RENGLÓN (Pones cuánto valieron las 12 botellas) */}
                                <div className="space-y-0.5">
                                    <span className="text-[7px] font-black text-indigo-500 uppercase tracking-widest ml-1 flex items-center gap-1"><Calculator size={8} /> TOTAL PRODUCTO</span>
                                    <Input size="sm" variant="flat" className="w-28"
                                        classNames={{ input: "text-sm font-black italic tabular-nums text-indigo-600 dark:text-indigo-400", inputWrapper: "h-9 bg-transparent border-b-2 border-indigo-500/30 rounded-none shadow-none focus-within:border-indigo-500" }}
                                        startContent={<span className="text-[9px] text-indigo-500 font-black">$</span>}
                                        value={String(item.newPurchasePrice * item.addedQuantity)}
                                        isDisabled={item.entryType === 'gift'}
                                        onValueChange={(val) => {
                                            const totalRow = parseFloat(val) || 0;
                                            const costUnd = totalRow / Math.max(1, item.addedQuantity);
                                            setReceiveList(p => p.map((it, i) => i === idx ? {
                                                ...it,
                                                newPurchasePrice: costUnd,
                                                newSalePrice: applyRounding(costUnd * (1 + it.marginPercentage / 100))
                                            } : it));
                                        }}
                                    />
                                </div>

                                <div className="space-y-0.5">
                                    <span className="text-[7px] font-black text-gray-400 uppercase tracking-widest ml-1">COSTO UND</span>
                                    <Input size="sm" variant="flat" className="w-24" classNames={{ input: "text-sm font-black italic tabular-nums text-gray-900 dark:text-white", inputWrapper: "h-9 bg-transparent border-b-2 border-gray-200 dark:border-white/10 rounded-none shadow-none focus-within:border-emerald-500/50" }} startContent={<span className="text-[9px] text-rose-500 font-black">$</span>}
                                        value={String(item.newPurchasePrice)}
                                        isDisabled={item.entryType === 'gift'}
                                        onValueChange={(val) => {
                                            const cost = parseFloat(val) || 0;
                                            setReceiveList(p => p.map((it, i) => i === idx ? { ...it, newPurchasePrice: cost, newSalePrice: applyRounding(cost * (1 + it.marginPercentage / 100)) } : it));
                                        }}
                                    />
                                </div>

                                <div className="space-y-0.5">
                                    <span className="text-[7px] font-black text-emerald-500 uppercase tracking-widest ml-1 italic">PVP SUGERIDO</span>
                                    <Input size="sm" variant="flat" className="w-24" classNames={{ input: "text-sm font-black italic tabular-nums text-emerald-600 dark:text-emerald-500", inputWrapper: "h-9 bg-transparent border-b-2 border-emerald-500/20 rounded-none shadow-none" }} startContent={<span className="text-[9px] text-emerald-500 font-black">$</span>}
                                        value={String(item.newSalePrice)} // Ya viene redondeado por applyRounding en los setters
                                        onValueChange={(val) => {
                                            const sale = applyRounding(parseFloat(val) || 0);
                                            setReceiveList(p => p.map((it, i) => i === idx ? { ...it, newSalePrice: sale, marginPercentage: it.newPurchasePrice > 0 ? ((sale / it.newPurchasePrice) - 1) * 100 : it.marginPercentage } : it));
                                        }}
                                    />
                                </div>

                                <Button 
                                    isIconOnly 
                                    variant="flat" 
                                    size="sm" 
                                    onClick={() => setReceiveList(p => p.filter((_, i) => i !== idx))} 
                                    className="h-8 w-8 min-w-8 bg-rose-50 dark:bg-rose-500/10 text-rose-500 rounded-lg hover:bg-rose-500 hover:text-white transition-all border border-rose-500/10 shadow-sm hidden lg:flex"
                                >
                                    <Trash2 size={14} />
                                </Button>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {/* Footer de Búsqueda y Acción */}
            <div className="p-6 bg-white dark:bg-zinc-900 border-t border-gray-200 dark:border-white/10 space-y-5 z-20 relative">
                {filteredProductsSearch.length > 0 && searchQuery && (
                    <div className="absolute bottom-[100%] left-6 right-6 bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-[2rem] mb-4 overflow-hidden shadow-2xl z-50 animate-in slide-in-from-bottom-2">
                        {filteredProductsSearch.map(p => (
                            <button key={p.barcode} onClick={() => addToReceive(p)} className="w-full p-5 flex justify-between items-center hover:bg-emerald-500 hover:text-white border-b border-gray-50 dark:border-white/5 last:border-none transition-all group">
                                <div className="text-left flex items-center gap-4">
                                    <div className="h-10 w-10 rounded-xl bg-gray-100 dark:bg-zinc-900 flex items-center justify-center dark:text-white"><Package size={18} /></div>
                                    <div><p className="text-sm font-black uppercase italic dark:text-white">{p.productName}</p><p className="text-[10px] font-mono opacity-50 dark:text-zinc-400">#{p.barcode}</p></div>
                                </div>
                                <div className="text-right"><p className="text-sm font-black italic dark:text-white group-hover:text-white">${formatCurrency(Number(p.purchasePrice))}</p></div>
                            </button>
                        ))}
                    </div>
                )}

                <div className="flex flex-col lg:flex-row gap-5 max-w-7xl mx-auto">
                    <div className="flex-1 relative group">
                        <Search className="absolute left-6 top-1/2 -translate-y-1/2 h-6 w-6 text-gray-400 group-focus-within:text-emerald-500 transition-colors" />
                        <Input
                            ref={searchRef}
                            placeholder="ESCRIBA NOMBRE O CÓDIGO PARA AGREGAR..."
                            classNames={{
                                inputWrapper: "h-16 pl-16 pr-8 rounded-[1.2rem] bg-transparent border border-gray-200 dark:border-white/10 shadow-none focus-within:border-emerald-500",
                                input: "font-black text-xl uppercase italic dark:text-white placeholder:text-zinc-300 dark:placeholder:text-zinc-800"
                            }}
                            value={searchQuery}
                            onValueChange={setSearchQuery}
                        />
                    </div>

                    <div className="w-full lg:w-[450px] flex gap-4">
                        <div className="flex-1 bg-gray-100 dark:bg-black rounded-[1.2rem] p-3 border border-gray-200 dark:border-white/5 flex flex-col justify-center shadow-inner">
                            <span className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest mb-1 italic text-center">Inversión Factura</span>
                            <div className="flex items-baseline justify-center gap-1">
                                <span className="text-xs font-black text-emerald-500 italic">$</span>
                                <span className="text-3xl font-black italic text-gray-900 dark:text-white tabular-nums tracking-tighter">{formatCurrency(totalOrderValue)}</span>
                            </div>
                        </div>
                        <Button
                            onPress={handleConfirmReceive}
                            isDisabled={receiveList.length === 0 || submitting}
                            className="h-16 flex-1 rounded-[1.2rem] bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase text-xs tracking-widest shadow-2xl hover:scale-105 active:scale-95 italic transition-all"
                        >
                            SINCRONIZAR <ShieldCheck size={20} className="ml-2" />
                        </Button>
                    </div>
                </div>

                <div className="max-w-7xl mx-auto w-full">
                    <select
                        className="w-full bg-transparent text-gray-400 dark:text-zinc-500 h-10 text-[9px] font-black rounded-lg px-5 border border-gray-200 dark:border-white/10 outline-none uppercase cursor-pointer italic appearance-none"
                        value={selectedGlobalSupplier}
                        onChange={(e) => setSelectedGlobalSupplier(e.target.value)}
                    >
                        <option value="none">➜ SELECCIONAR PROVEEDOR</option>
                        {suppliers.map(s => <option key={s.id} value={s.id}>{s.name.toUpperCase()}</option>)}
                    </select>
                </div>
            </div>

            <ScannerOverlay
                isOpen={isScannerOpen}
                onClose={() => {
                    setIsScannerOpen(false);
                    setScannedNotFoundCode('');
                }}
                errorTitle={scannedNotFoundCode ? "Producto Desconocido" : undefined}
                errorMessage={scannedNotFoundCode ? `Código #${scannedNotFoundCode} no identificado.` : undefined}
                onIgnoreError={() => {
                    setScannedNotFoundCode('');
                    // Al limpiar el código, el overlay desaparece. 
                    // Como el ScannerOverlay ya detuvo la cámara al leer, necesitamos reiniciarla.
                    // Para forzar el reinicio cerramos y abrimos rápido.
                    setIsScannerOpen(false);
                    setTimeout(() => setIsScannerOpen(true), 10);
                }}
                onCreateProduct={() => {
                    router.push(`/products?action=new&barcode=${scannedNotFoundCode}`);
                }}
                onResult={(res) => {
                    const p = products.find(prod => prod.barcode === res);
                    if (p) { 
                        addToReceive(p); 
                        playScanSound('success');
                        if (navigator.vibrate) navigator.vibrate(50); 
                        // Tras éxito, cerramos y abrimos para seguir escaneando (Batch mode)
                        setIsScannerOpen(false);
                        setTimeout(() => setIsScannerOpen(true), 10);
                    }
                    else { 
                        playScanSound('error');
                        setScannedNotFoundCode(res); 
                    }
                }}
                title="ESCÁNER MAESTRO"
            />

        </div>
    );
}