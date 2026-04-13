"use client";

import { useState, useEffect } from 'react';
import {
    Printer, RefreshCw, TrendingUp, TrendingDown, DollarSign,
    CreditCard as CardIcon, Save, History, ChevronRight,
    Plus, Trash2, Coins as CoinsIcon, Users, LayoutDashboard, RefreshCcw, Banknote, Check
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { CashierClosure } from '@/lib/definitions';
import { formatCurrency, parseCurrency } from "@/lib/utils";

// Importaciones de HeroUI
import {
    Button,
    Card,
    CardBody,
    Input,
    Modal,
    ModalContent,
    ModalHeader,
    ModalBody,
    ModalFooter,
    Spinner,
    Chip
} from "@heroui/react";

export default function CashierClosurePage() {
    const [currentClosure, setCurrentClosure] = useState<CashierClosure | null>(null);
    const [history, setHistory] = useState<CashierClosure[]>([]);
    const [loading, setLoading] = useState(true);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [viewingClosure, setViewingClosure] = useState<any>(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [physicalBills, setPhysicalBills] = useState<number>(0);
    const [coinsCalculator, setCoinsCalculator] = useState<Record<string, number>>({ '1000_500': 0, '200': 0, '100': 0 });
    const [salaryEgresses, setSalaryEgresses] = useState<{ id: string, amount: number, method: 'EFECTIVO' | 'NEQUI' | 'DAVIPLATA', description: string }[]>([]);
    const [operationalEgresses, setOperationalEgresses] = useState<{ id: string, amount: number, method: 'EFECTIVO' | 'NEQUI' | 'DAVIPLATA', description: string }[]>([]);
    const { toast } = useToast();

    // ... [LÓGICA DE FETCHING OCULTA PARA EL EJEMPLO VISUAL] ...
    const fetchCurrent = async () => {
        const token = localStorage.getItem('org-pos-token');
        if (!token) return;
        setLoading(true);
        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/dashboard/cashier-closure`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setCurrentClosure(data);
                // Si hay una base guardada, podrías usarla, pero el sistema la trae del shift activo
            } else {
                toast({ title: "Error", description: "No se pudo obtener el balance actual", variant: "destructive" });
            }
        } catch (error) {
            console.error("Error fetching current closure", error);
            toast({ title: "Error de red", description: "No hay conexión con el servidor", variant: "destructive" });
        } finally {
            setLoading(false);
        }
    };

    const fetchHistory = async () => {
        const token = localStorage.getItem('org-pos-token');
        if (!token) return;
        setHistoryLoading(true);
        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/dashboard/cashier-history`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setHistory(Array.isArray(data) ? data : []);
            }
        } catch (error) {
            console.error("Error fetching history", error);
        } finally {
            setHistoryLoading(false);
        }
    };

    const saveClosure = async () => {
        const token = localStorage.getItem('org-pos-token');
        if (!token) return;

        // Validar que se haya ingresado el conteo físico
        if (physicalCash <= 0 && !confirm("¿Estás seguro de cerrar con saldo físico en $0?")) return;

        try {
            // Preparar el objeto de cierre para el backend
            // El backend espera models.CashierClosure
            const closureData = {
                ...currentClosure,
                physicalCash,
                difference,
                salariesDetail: JSON.stringify(salaryEgresses),
                expensesDetail: JSON.stringify(operationalEgresses),
                // El backend puede recalcular el NetBalance, pero enviamos los detalles de egresos manuales
                totalExpenses: (currentClosure?.totalExpenses || 0) + effectiveOperationalExpenses + effectiveSalariesPaidList
            };

            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/dashboard/cashier-closure`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(closureData)
            });

            if (res.ok) {
                toast({ title: "ÉXITO", description: "Turno finalizado y sincronizado correctamente", variant: "default" });
                setConfirmOpen(false);
                fetchCurrent(); // Reiniciar para el nuevo turno
                fetchHistory();
            } else {
                const err = await res.json();
                toast({ title: "ERROR", description: err.error || "No se pudo guardar el cierre", variant: "destructive" });
            }
        } catch (error) {
            console.error("Error saving closure", error);
            toast({ title: "ERROR CRÍTICO", description: "Fallo de conexión al intentar cerrar turno", variant: "destructive" });
        }
    };

    useEffect(() => {
        fetchCurrent();
        fetchHistory();
    }, []);

    const handlePrint = (closure = currentClosure) => {
        setViewingClosure(closure);
        setTimeout(() => { window.print(); }, 300);
    };

    const filteredHistory = history.filter(h =>
        h.id.toString().includes(searchTerm) ||
        new Date(h.date).toLocaleDateString().includes(searchTerm)
    );

    // ESTADO DE CARGA PREMIUM (Soporte Claro/Oscuro)
    if (loading) return (
        <div className="flex flex-col items-center justify-center h-full min-h-[60vh] gap-4 bg-gray-50 dark:bg-[#09090b] transition-colors duration-500 rounded-[2rem] border border-gray-200 dark:border-white/5 m-2 md:m-4">
            <Spinner color="success" size="lg" />
            <p className="text-[10px] font-black text-gray-500 dark:text-zinc-500 tracking-widest uppercase animate-pulse">Calculando balance actual...</p>
        </div>
    );

    // FUNCIONES DE ESTADO DE EGRESOS
    const addSalaryEgress = () => setSalaryEgresses(prev => [...prev, { id: crypto.randomUUID(), amount: 0, method: 'EFECTIVO', description: 'SUELDO EMPLEADO' }]);
    const removeSalaryEgress = (id: string) => setSalaryEgresses(prev => prev.filter(e => e.id !== id));
    const updateSalaryEgress = (id: string, updates: any) => setSalaryEgresses(prev => prev.map(e => e.id === id ? { ...e, ...updates } : e));
    const addOperationalEgress = () => setOperationalEgresses(prev => [...prev, { id: crypto.randomUUID(), amount: 0, method: 'EFECTIVO', description: '' }]);
    const removeOperationalEgress = (id: string) => setOperationalEgresses(prev => prev.filter(e => e.id !== id));
    const updateOperationalEgress = (id: string, updates: any) => setOperationalEgresses(prev => prev.map(e => e.id === id ? { ...e, ...updates } : e));

    // CÁLCULOS MATEMÁTICOS
    const coinsTotal = Object.values(coinsCalculator).reduce((acc, val) => acc + (val || 0), 0);
    const physicalCash = physicalBills + coinsTotal;

    const effectiveSalariesPaidList = salaryEgresses.filter(e => e.method === 'EFECTIVO').reduce((acc, e) => acc + e.amount, 0);
    const nequiSalaries = salaryEgresses.filter(e => e.method === 'NEQUI').reduce((acc, e) => acc + e.amount, 0);
    const daviSalaries = salaryEgresses.filter(e => e.method === 'DAVIPLATA').reduce((acc, e) => acc + e.amount, 0);

    const cashExpenses = currentClosure?.expenses?.filter(e => !e.paymentSource || e.paymentSource === 'EFECTIVO').reduce((acc, e) => acc + e.amount, 0) || (currentClosure?.totalExpenses ?? 0);
    const effectiveOperationalExpenses = operationalEgresses.filter(e => e.method === 'EFECTIVO').reduce((acc, e) => acc + e.amount, 0);

    const systemCash = (currentClosure?.openingCash ?? 0) + (currentClosure?.totalCash ?? 0) - cashExpenses - (currentClosure?.totalReturns ?? 0) - effectiveSalariesPaidList - effectiveOperationalExpenses;
    const difference = physicalCash - systemCash;

    return (
        <div className="flex flex-col h-screen gap-1 p-1 bg-gray-50 dark:bg-zinc-950 text-gray-900 dark:text-white overflow-hidden select-none transition-colors duration-500">

            {/* HEADER COMPACTO V4.0 */}
            <header className="flex items-center justify-between gap-2 p-2 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 rounded-lg shrink-0 shadow-sm transition-colors">
                <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-md bg-emerald-500 flex items-center justify-center text-white shadow-sm shrink-0">
                        <LayoutDashboard size={16} />
                    </div>
                    <div className="flex flex-col">
                        <h1 className="text-sm font-black uppercase tracking-tighter leading-none italic">CIERRE OPERATIVO</h1>
                        <p className="text-[9px] font-black text-emerald-500 uppercase tracking-widest mt-0.5 opacity-80 italic">AUDITORÍA DE CAJA</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        variant="flat"
                        size="sm"
                        onPress={fetchCurrent}
                        className="bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-emerald-500 uppercase tracking-widest text-[9px] font-black h-8 px-3 rounded-md border-none transition-transform active:scale-95"
                    >
                        <RefreshCw size={14} className="mr-1" /> Sincronizar
                    </Button>
                    <Button
                        color="success"
                        size="sm"
                        onPress={() => setConfirmOpen(true)}
                        className="uppercase tracking-widest text-[9px] font-black bg-emerald-500 text-white shadow-sm h-8 px-4 rounded-md transition-transform active:scale-95 italic"
                    >
                        <Save size={14} className="mr-1" /> FINALIZAR TURNO
                    </Button>
                </div>
            </header>

            <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col gap-1 min-h-0">
                {/* KPIs Financieros - MODO COMPACTO */}
                <div className="grid gap-1 grid-cols-2 lg:grid-cols-4 shrink-0">
                    {[
                        { label: "Ventas (Efe+Ban)", val: currentClosure?.totalSales || 0, icon: TrendingUp, color: "text-emerald-600 dark:text-emerald-400", border: "border-emerald-200 dark:border-emerald-400/20" },
                        { label: "Devoluciones", val: currentClosure?.totalReturns || 0, icon: RefreshCcw, color: "text-rose-500", border: "border-rose-200 dark:border-rose-500/20" },
                        { label: "Gastos Reg.", val: currentClosure?.totalExpenses || 0, icon: TrendingDown, color: "text-amber-500", border: "border-amber-200 dark:border-amber-500/20" },
                        { label: "Caja (Efectivo)", val: systemCash, icon: DollarSign, color: "text-gray-900 dark:text-white", border: "border-gray-300 dark:border-white/20" },
                    ].map((stat, i) => (
                        <Card key={i} className={`bg-white dark:bg-zinc-900 border ${stat.border} shadow-sm transition-colors rounded-lg`} radius="sm">
                            <CardBody className="p-2 flex flex-col justify-between">
                                <div className="flex items-center justify-between mb-0.5">
                                    <span className="text-[8px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest italic">{stat.label}</span>
                                    <stat.icon size={12} className={`${stat.color} opacity-80`} />
                                </div>
                                <h3 className={`text-lg font-black tabular-nums tracking-tighter ${i === 3 ? 'text-emerald-500' : 'text-gray-900 dark:text-white'} italic`}>
                                    ${formatCurrency(stat.val)}
                                </h3>
                            </CardBody>
                        </Card>
                    ))}
                </div>

                {/* Panel Operativo Principal */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-1 min-h-0 flex-1">

                    {/* IZQUIERDA: Egresos y Conteo de Billetes (60%) */}
                    <div className="lg:col-span-7 flex flex-col gap-1 min-h-0">
                        <Card className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 flex-1 flex flex-col h-full shadow-sm transition-colors rounded-lg" radius="sm">
                            <CardBody className="p-2 flex flex-col gap-2 overflow-y-auto custom-scrollbar">

                                {/* SECCIÓN: Nómina y Sueldos */}
                                <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                        <label className="text-[9px] font-black text-emerald-600 dark:text-emerald-500 uppercase tracking-widest flex items-center gap-2">
                                            <Users size={14} />
                                            Nómina y Sueldos
                                        </label>
                                        <Button isIconOnly size="sm" variant="flat" onPress={addSalaryEgress} className="h-7 w-7 rounded-lg bg-gray-100 dark:bg-zinc-900 text-gray-600 dark:text-emerald-500 border border-gray-200 dark:border-white/5 transition-colors">
                                            <Plus size={14} />
                                        </Button>
                                    </div>
                                    {salaryEgresses.length > 0 ? (
                                        <div className="space-y-2">
                                            {salaryEgresses.map((egress) => (
                                                <div key={egress.id} className="p-2 rounded-xl bg-gray-50 dark:bg-black/30 border border-gray-200 dark:border-white/5 flex flex-col sm:flex-row items-start sm:items-center gap-2 transition-colors">
                                                    <Button isIconOnly size="sm" variant="light" color="danger" onPress={() => removeSalaryEgress(egress.id)} className="shrink-0 h-8 w-8 min-w-0">
                                                        <Trash2 size={14} />
                                                    </Button>
                                                    <Input
                                                        size="sm" variant="faded" placeholder="EMPLEADO..."
                                                        value={egress.description} onValueChange={(val) => updateSalaryEgress(egress.id, { description: val.toUpperCase() })}
                                                        classNames={{ inputWrapper: "bg-white dark:bg-zinc-900 border-gray-200 dark:border-white/5 h-8 rounded-lg", input: "font-bold text-[11px]" }}
                                                    />
                                                    <Input
                                                        size="sm" variant="faded" startContent={<span className="text-emerald-500 font-black mr-1 text-[11px]">$</span>}
                                                        value={egress.amount ? formatCurrency(egress.amount) : ''}
                                                        onChange={(e) => updateSalaryEgress(egress.id, { amount: parseCurrency(e.target.value) })}
                                                        classNames={{ inputWrapper: "bg-white dark:bg-zinc-900 border-gray-200 dark:border-white/5 h-8 rounded-lg sm:w-28 shrink-0", input: "tabular-nums font-black text-[11px]" }}
                                                    />
                                                    <div className="flex bg-white dark:bg-zinc-900 rounded-lg p-0.5 border border-gray-200 dark:border-white/5 shrink-0 w-full sm:w-auto h-8 shadow-sm">
                                                        {(['EFECTIVO', 'NEQUI', 'DAVIPLATA'] as const).map((m) => (
                                                            <button
                                                                key={m} onClick={() => updateSalaryEgress(egress.id, { method: m })}
                                                                className={`flex-1 sm:px-2 py-0.5 rounded-md text-[8px] font-black uppercase tracking-widest transition-all ${egress.method === m ? 'bg-emerald-500 text-black shadow-sm' : 'text-gray-500 dark:text-zinc-500'}`}
                                                            >
                                                                {m.slice(0, 3)}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <p className="text-[10px] text-gray-400 dark:text-zinc-600 font-black text-center py-4 bg-gray-50/50 dark:bg-zinc-900/20 border border-dashed border-gray-200 dark:border-white/10 rounded-xl uppercase tracking-widest">Sin sueldos registrados</p>
                                    )}
                                </div>

                                <div className="h-px bg-gray-200 dark:bg-white/5" />

                                {/* SECCIÓN: Gastos Operativos Manuales */}
                                <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                        <label className="text-[9px] font-black text-amber-600 dark:text-amber-500 uppercase tracking-widest flex items-center gap-2">
                                            <TrendingDown size={14} />
                                            Gastos Operativos
                                        </label>
                                        <Button isIconOnly size="sm" variant="flat" onPress={addOperationalEgress} className="h-7 w-7 rounded-lg bg-gray-100 dark:bg-zinc-900 text-gray-600 dark:text-amber-500 border border-gray-200 dark:border-white/5 transition-colors">
                                            <Plus size={14} />
                                        </Button>
                                    </div>
                                    {operationalEgresses.length > 0 ? (
                                        <div className="space-y-2">
                                            {operationalEgresses.map((egress) => (
                                                <div key={egress.id} className="p-2 rounded-xl bg-gray-50 dark:bg-black/30 border border-gray-200 dark:border-white/5 flex flex-col sm:flex-row items-start sm:items-center gap-2 transition-colors">
                                                    <Button isIconOnly size="sm" variant="light" color="danger" onPress={() => removeOperationalEgress(egress.id)} className="shrink-0 h-8 w-8 min-w-0">
                                                        <Trash2 size={14} />
                                                    </Button>
                                                    <Input
                                                        size="sm" variant="faded" placeholder="CONCEPTO..."
                                                        value={egress.description} onValueChange={(val) => updateOperationalEgress(egress.id, { description: val.toUpperCase() })}
                                                        classNames={{ inputWrapper: "bg-white dark:bg-zinc-900 border-gray-200 dark:border-white/5 h-8 rounded-lg", input: "font-bold text-[11px]" }}
                                                    />
                                                    <Input
                                                        size="sm" variant="faded" startContent={<span className="text-amber-500 font-black mr-1 text-[11px]">$</span>}
                                                        value={egress.amount ? formatCurrency(egress.amount) : ''}
                                                        onChange={(e) => updateOperationalEgress(egress.id, { amount: parseCurrency(e.target.value) })}
                                                        classNames={{ inputWrapper: "bg-white dark:bg-zinc-900 border-gray-200 dark:border-white/5 h-8 rounded-lg sm:w-28 shrink-0", input: "tabular-nums font-black text-[11px]" }}
                                                    />
                                                    <div className="flex bg-white dark:bg-zinc-900 rounded-lg p-0.5 border border-gray-200 dark:border-white/5 shrink-0 w-full sm:w-auto h-8 shadow-sm">
                                                        {(['EFECTIVO', 'NEQUI', 'DAVIPLATA'] as const).map((m) => (
                                                            <button
                                                                key={m} onClick={() => updateOperationalEgress(egress.id, { method: m })}
                                                                className={`flex-1 sm:px-2 py-0.5 rounded-md text-[8px] font-black uppercase tracking-widest transition-all ${egress.method === m ? 'bg-amber-500 text-white shadow-sm' : 'text-gray-500 dark:text-zinc-500'}`}
                                                            >
                                                                {m.slice(0, 3)}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <p className="text-[10px] text-gray-400 dark:text-zinc-600 font-black text-center py-4 bg-gray-50/50 dark:bg-zinc-900/20 border border-dashed border-gray-200 dark:border-white/10 rounded-xl uppercase tracking-widest">Sin gastos operativos</p>
                                    )}
                                </div>

                                <div className="h-px bg-gray-200 dark:bg-white/5" />

                                {/* SECCIÓN: Billetes & Monedas (Arqueo Físico) */}
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div className="space-y-2">
                                        <label className="text-[9px] font-black text-gray-900 dark:text-white uppercase tracking-widest flex items-center gap-2">
                                            <Banknote size={14} />
                                            Efectivo (Billetes)
                                        </label>
                                        <Input
                                            size="sm" variant="faded"
                                            startContent={<span className="text-gray-400 dark:text-zinc-500 font-black text-xl mr-1">$</span>}
                                            value={physicalBills ? formatCurrency(physicalBills) : ''}
                                            onChange={(e) => setPhysicalBills(parseCurrency(e.target.value))}
                                            placeholder="0"
                                            classNames={{
                                                inputWrapper: "bg-gray-50 dark:bg-black border-gray-300 dark:border-white/10 h-10 rounded-xl shadow-inner",
                                                input: "text-2xl font-black tabular-nums"
                                            }}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-[9px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest flex items-center gap-2">
                                            <CoinsIcon size={14} />
                                            Monedas
                                        </label>
                                        <div className="grid grid-cols-3 gap-2">
                                            {[{ label: "$1k/500", key: '1000_500' }, { label: "$200", key: '200' }, { label: "$100", key: '100' }].map((coin) => (
                                                <div key={coin.key} className="flex flex-col gap-1 p-1.5 rounded-xl bg-gray-50 dark:bg-black border border-gray-200 dark:border-white/10 text-center shadow-sm">
                                                    <label className="text-[8px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest truncate">{coin.label}</label>
                                                    <Input
                                                        size="sm" variant="underlined"
                                                        value={coinsCalculator[coin.key] ? formatCurrency(coinsCalculator[coin.key]) : ''}
                                                        onChange={(e) => setCoinsCalculator(prev => ({ ...prev, [coin.key]: parseCurrency(e.target.value) }))}
                                                        placeholder="0"
                                                        classNames={{ input: "text-center font-black tabular-nums text-[11px]", inputWrapper: "border-gray-300 dark:border-white/20 h-6 min-h-0 py-0" }}
                                                    />
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </CardBody>
                        </Card>
                    </div>

                    {/* DERECHA: Auditoría en Vivo (40%) */}
                    <div className="lg:col-span-5 flex flex-col gap-1 min-h-0">
                        {/* Tarjeta de Balance en Vivo */}
                        <Card className={`border shadow-sm transition-all duration-500 rounded-lg ${difference >= 0 ? 'bg-white dark:bg-zinc-900 border-emerald-500/20' : 'bg-rose-50 dark:bg-rose-950/10 border-rose-500/30'}`} radius="sm">
                            <CardBody className="p-3">
                                <div className="flex justify-between items-start mb-2">
                                    <div>
                                        <p className="text-[8px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest mb-0.5 italic">ARQUEO FÍSICO</p>
                                        <h2 className={`text-2xl font-black tabular-nums tracking-tighter ${difference >= 0 ? 'text-gray-900 dark:text-white' : 'text-rose-500'} italic`}>
                                            ${formatCurrency(physicalCash)}
                                        </h2>
                                    </div>
                                    <div className="text-right border-l border-gray-200 dark:border-white/10 pl-3">
                                        <p className="text-[8px] font-black text-gray-400 dark:text-zinc-600 uppercase tracking-widest mb-0.5 italic">ESPERADO</p>
                                        <p className="text-lg font-black text-gray-700 dark:text-zinc-300 tabular-nums tracking-tighter italic">${formatCurrency(systemCash)}</p>
                                    </div>
                                </div>

                                <div className={`p-2 rounded-lg flex items-center justify-between border transition-all ${difference === 0 ? 'bg-gray-100 dark:bg-zinc-800 border-gray-200 dark:border-white/10 text-gray-900 dark:text-white' : difference > 0 ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500' : 'bg-rose-500/10 border-rose-500/20 text-rose-500 shadow-sm'}`}>
                                    <div className="flex items-center gap-2">
                                        <div className={`h-7 w-7 rounded-md flex items-center justify-center shrink-0 ${difference === 0 ? 'bg-gray-200 dark:bg-white/10 text-gray-400' : difference > 0 ? 'bg-emerald-500 text-white' : 'bg-rose-500 text-white'}`}>
                                            {difference === 0 ? <Check size={14} /> : difference > 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                                        </div>
                                        <div className="flex flex-col">
                                            <span className="text-[8px] font-black uppercase tracking-widest opacity-80 italic">Diferencia</span>
                                            <span className="text-[7px] font-black uppercase opacity-60 italic">
                                                {difference === 0 ? 'CUADRADA' : difference > 0 ? 'SOBRANTE' : 'FALTANTE'}
                                            </span>
                                        </div>
                                    </div>
                                    <span className="text-lg font-black tabular-nums tracking-tighter italic">
                                        {difference > 0 ? '+' : ''}{formatCurrency(difference)}
                                    </span>
                                </div>
                            </CardBody>
                        </Card>

                        {/* Auditoría Bancos */}
                        <Card className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/5 flex-1 shadow-sm transition-colors rounded-lg" radius="sm">
                            <CardBody className="p-3 flex flex-col gap-2">
                                <h4 className="text-[8px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest flex items-center gap-2 shrink-0 italic">
                                    <CardIcon size={12} className="text-sky-500" />
                                    DIGITAL (BANCOS)
                                </h4>
                                <div className="space-y-1 overflow-y-auto custom-scrollbar pr-1">
                                    {[
                                        { label: "Nequi", val: currentClosure?.totalNequi || 0, d: nequiSalaries },
                                        { label: "Daviplata", val: currentClosure?.totalDaviplata || 0, d: daviSalaries },
                                    ].map((b, i) => (
                                        <div key={i} className="flex justify-between items-center p-2 rounded-lg bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/5 transition-colors group hover:border-emerald-500/30">
                                            <div className="flex flex-col">
                                                <span className="text-[10px] font-black text-gray-900 dark:text-white uppercase truncate italic">{b.label}</span>
                                                {b.d > 0 && <span className="text-[7px] font-black text-amber-500 mt-0.5 bg-amber-500/10 px-1.5 py-0.5 rounded-md inline-block w-max tracking-widest">-${formatCurrency(b.d)}</span>}
                                            </div>
                                            <span className="text-sm font-black text-gray-900 dark:text-white tabular-nums tracking-tighter italic">${formatCurrency(b.val - b.d)}</span>
                                        </div>
                                    ))}
                                </div>
                            </CardBody>
                        </Card>
                    </div>
                </div>

                {/* DIÁLOGO DE CONFIRMACIÓN - TAMBIÉN COMPACTADO */}
                <Modal
                    isOpen={confirmOpen}
                    onOpenChange={setConfirmOpen}
                    backdrop="blur"
                    size="lg"
                    placement="center"
                    classNames={{
                        base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-3xl shadow-2xl",
                        header: "border-b border-gray-100 dark:border-white/5 pb-4",
                        footer: "border-t border-gray-100 dark:border-white/5 pt-4 bg-gray-50 dark:bg-transparent rounded-b-3xl"
                    }}
                >
                    <ModalContent>
                        {(onClose) => (
                            <>
                                <ModalHeader className="flex flex-col gap-1 pt-6 px-8">
                                    <h2 className="text-xl font-black text-gray-900 dark:text-white uppercase tracking-tighter flex items-center gap-2">
                                        <Save size={20} />
                                        Confirmar Cierre
                                    </h2>
                                </ModalHeader>
                                <ModalBody className="px-8 py-4 space-y-4">
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className={`p-4 rounded-2xl border flex flex-col items-center shadow-inner ${difference >= 0 ? 'bg-emerald-50 dark:bg-emerald-500/5 border-emerald-200 dark:border-emerald-500/20' : 'bg-rose-50 dark:bg-rose-500/5 border-rose-200 dark:border-rose-500/20'}`}>
                                            <span className="text-[9px] font-black uppercase text-gray-500 mb-1">Auditado</span>
                                            <div className="text-2xl font-black text-gray-900 dark:text-white tabular-nums">${formatCurrency(physicalCash)}</div>
                                        </div>
                                        <div className={`p-4 rounded-2xl border flex flex-col items-center shadow-sm ${difference === 0 ? 'bg-gray-50 dark:bg-zinc-900 border-gray-200' : 'bg-emerald-100 dark:bg-emerald-500/10 border-emerald-300'}`}>
                                            <span className="text-[9px] font-black uppercase text-gray-500 mb-1">Diferencia</span>
                                            <div className={`text-2xl font-black tabular-nums ${difference >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                                                {difference > 0 ? '+' : ''}{formatCurrency(difference)}
                                            </div>
                                        </div>
                                    </div>
                                </ModalBody>
                                <ModalFooter className="px-8 pb-6 gap-3">
                                    <Button variant="light" color="danger" size="sm" onPress={onClose} className="font-black uppercase tracking-widest text-[9px] h-10 px-4 rounded-xl">
                                        REVISAR
                                    </Button>
                                    <Button color="primary" size="sm" onPress={saveClosure} className="font-black uppercase tracking-widest text-[9px] bg-emerald-500 text-white dark:text-black h-10 px-8 rounded-xl shadow-lg shadow-emerald-500/20">
                                        Confirmar
                                    </Button>
                                </ModalFooter>
                            </>
                        )}
                    </ModalContent>
                </Modal>

            </div>
        </div>
    );
}