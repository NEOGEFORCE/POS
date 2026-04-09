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
    const [salaryEgresses, setSalaryEgresses] = useState<{ id: string, amount: number, method: 'EFECTIVO' | 'NEQUI' | 'DAVIPLATA' | 'BANCOLOMBIA', description: string }[]>([]);
    const [operationalEgresses, setOperationalEgresses] = useState<{ id: string, amount: number, method: 'EFECTIVO' | 'NEQUI' | 'DAVIPLATA' | 'BANCOLOMBIA', description: string }[]>([]);
    const { toast } = useToast();

    // ... [LÓGICA DE FETCHING OCULTA PARA EL EJEMPLO VISUAL] ...
    const fetchCurrent = async () => { setLoading(true); setTimeout(() => setLoading(false), 800); };
    const fetchHistory = async () => { /* ... */ };
    const saveClosure = async () => { /* ... */ };

    useEffect(() => {
        // Simulación de carga inicial
        setTimeout(() => setLoading(false), 800);
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
    const printData = viewingClosure || currentClosure;

    const effectiveSalariesPaidList = salaryEgresses.filter(e => e.method === 'EFECTIVO').reduce((acc, e) => acc + e.amount, 0);
    const nequiSalaries = salaryEgresses.filter(e => e.method === 'NEQUI').reduce((acc, e) => acc + e.amount, 0);
    const daviSalaries = salaryEgresses.filter(e => e.method === 'DAVIPLATA').reduce((acc, e) => acc + e.amount, 0);
    const bankSalaries = salaryEgresses.filter(e => e.method === 'BANCOLOMBIA').reduce((acc, e) => acc + e.amount, 0);
    const transferSalariesPaidList = nequiSalaries + daviSalaries + bankSalaries;

    const cashExpenses = currentClosure?.expenses?.filter(e => !e.paymentSource || e.paymentSource === 'EFECTIVO').reduce((acc, e) => acc + e.amount, 0) || (currentClosure?.totalExpenses ?? 0);
    const effectiveOperationalExpenses = operationalEgresses.filter(e => e.method === 'EFECTIVO').reduce((acc, e) => acc + e.amount, 0);

    const systemCash = (currentClosure?.openingCash ?? 0) + (currentClosure?.totalCash ?? 0) - cashExpenses - (currentClosure?.totalReturns ?? 0) - effectiveSalariesPaidList - effectiveOperationalExpenses;
    const difference = physicalCash - systemCash;

    return (
        <div className="flex flex-col gap-4 p-2 md:p-4 w-full bg-gray-50 dark:bg-[#09090b] min-h-screen overflow-hidden font-sans select-none transition-colors duration-500 print:hidden">

            {/* HEADER EJECUTIVO (Con soporte claro/oscuro) */}
            <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 px-6 py-4 bg-white/80 dark:bg-zinc-950/60 backdrop-blur-xl rounded-[2rem] border border-gray-200 dark:border-white/10 shadow-lg dark:shadow-2xl shrink-0 transition-colors">
                <div className="space-y-1">
                    <h1 className="text-2xl font-black uppercase tracking-tighter text-gray-900 dark:text-white flex items-center gap-3">
                        <div className="bg-emerald-100 dark:bg-emerald-500/10 p-2 rounded-xl text-emerald-600 dark:text-emerald-500 border border-emerald-200 dark:border-emerald-500/20 shadow-sm"><LayoutDashboard className="h-5 w-5" /></div>
                        CIERRE OPERATIVO
                        <Chip size="sm" variant="flat" className="ml-2 bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 border-none px-1" classNames={{ content: "font-black" }}>V4.2</Chip>
                    </h1>
                </div>
                <div className="flex items-center gap-3">
                    <Button
                        variant="flat"
                        onPress={fetchCurrent}
                        className="bg-gray-100 dark:bg-zinc-900 text-gray-600 dark:text-emerald-500 uppercase tracking-widest text-[10px] font-black hover:bg-gray-200 dark:hover:bg-emerald-500/20 transition-all group border border-gray-200 dark:border-white/5 h-12 px-6 rounded-xl"
                        startContent={<RefreshCw className="h-4 w-4 group-hover:rotate-180 transition-transform duration-500" />}
                    >
                        Sincronizar
                    </Button>
                    <Button
                        color="primary"
                        onPress={() => setConfirmOpen(true)}
                        className="uppercase tracking-widest text-[10px] font-black bg-emerald-500 text-white dark:text-black shadow-lg shadow-emerald-500/30 h-12 px-8 rounded-xl hover:scale-105 transition-transform"
                        startContent={<Save className="h-4 w-4" />}
                    >
                        Finalizar Turno
                    </Button>
                </div>
            </header>

            <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col gap-6 min-h-0 px-1 pb-20">
                {/* KPIs Financieros */}
                <div className="grid gap-4 grid-cols-2 lg:grid-cols-4 shrink-0">
                    {[
                        { label: "Ventas (Efe+Ban)", val: currentClosure?.totalSales || 0, icon: TrendingUp, color: "text-emerald-600 dark:text-emerald-400", border: "border-emerald-200 dark:border-emerald-400/20" },
                        { label: "Devoluciones", val: currentClosure?.totalReturns || 0, icon: RefreshCcw, color: "text-rose-500", border: "border-rose-200 dark:border-rose-500/20" },
                        { label: "Gastos Reg.", val: currentClosure?.totalExpenses || 0, icon: TrendingDown, color: "text-amber-500", border: "border-amber-200 dark:border-amber-500/20" },
                        { label: "Caja (Efectivo)", val: systemCash, icon: DollarSign, color: "text-gray-900 dark:text-white", border: "border-gray-300 dark:border-white/20" },
                    ].map((stat, i) => (
                        <Card key={i} className={`bg-white dark:bg-zinc-950/50 border ${stat.border} shadow-sm transition-colors`} radius="lg">
                            <CardBody className="p-5 flex flex-col justify-between">
                                <div className="flex items-center justify-between mb-3">
                                    <span className="text-[10px] font-black text-gray-500 dark:text-zinc-400 uppercase tracking-widest">{stat.label}</span>
                                    <stat.icon className={`h-4 w-4 ${stat.color} opacity-80`} />
                                </div>
                                <h3 className={`text-2xl sm:text-3xl font-black tabular-nums tracking-tighter ${i === 3 ? 'text-gray-900 dark:text-white' : 'text-gray-800 dark:text-white'}`}>
                                    ${formatCurrency(stat.val)}
                                </h3>
                            </CardBody>
                        </Card>
                    ))}
                </div>

                {/* Panel Operativo Principal */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-0 flex-1">

                    {/* IZQUIERDA: Egresos y Conteo de Billetes (60%) */}
                    <div className="lg:col-span-7 flex flex-col gap-6 min-h-0">
                        <Card className="bg-white/80 dark:bg-zinc-950/60 border border-gray-200 dark:border-white/5 backdrop-blur-xl flex-1 flex flex-col h-full shadow-lg dark:shadow-none transition-colors" radius="lg">
                            <CardBody className="p-6 md:p-8 flex flex-col gap-8 overflow-y-auto custom-scrollbar">

                                {/* SECCIÓN: Nómina y Sueldos */}
                                <div className="space-y-4">
                                    <div className="flex items-center justify-between">
                                        <label className="text-[10px] font-black text-emerald-600 dark:text-emerald-500 uppercase tracking-widest flex items-center gap-2">
                                            <div className="p-1.5 rounded-lg bg-emerald-100 dark:bg-emerald-500/10"><Users className="h-4 w-4" /></div>
                                            Nómina y Sueldos
                                        </label>
                                        <Button isIconOnly size="sm" variant="flat" onPress={addSalaryEgress} className="h-8 w-8 rounded-xl bg-gray-100 dark:bg-zinc-900 text-gray-600 dark:text-emerald-500 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 border border-gray-200 dark:border-white/5 transition-colors">
                                            <Plus className="h-4 w-4" />
                                        </Button>
                                    </div>
                                    {salaryEgresses.length > 0 ? (
                                        <div className="space-y-3">
                                            {salaryEgresses.map((egress) => (
                                                <div key={egress.id} className="p-3 rounded-2xl bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 flex flex-col sm:flex-row items-start sm:items-center gap-3 transition-colors">
                                                    <Button isIconOnly size="sm" variant="light" color="danger" onPress={() => removeSalaryEgress(egress.id)} className="shrink-0 hover:bg-rose-100 dark:hover:bg-rose-500/20">
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                    <Input
                                                        size="sm" variant="faded" placeholder="EMPLEADO..."
                                                        value={egress.description} onValueChange={(val) => updateSalaryEgress(egress.id, { description: val.toUpperCase() })}
                                                        classNames={{ inputWrapper: "bg-white dark:bg-zinc-900 border-gray-200 dark:border-white/5 h-10 rounded-xl", input: "font-bold text-gray-900 dark:text-white" }}
                                                    />
                                                    <Input
                                                        size="sm" variant="faded" startContent={<span className="text-emerald-500 font-black mr-1">$</span>}
                                                        value={egress.amount ? formatCurrency(egress.amount) : ''}
                                                        onChange={(e) => updateSalaryEgress(egress.id, { amount: parseCurrency(e.target.value) })}
                                                        classNames={{ inputWrapper: "bg-white dark:bg-zinc-900 border-gray-200 dark:border-white/5 h-10 rounded-xl sm:w-36 shrink-0", input: "tabular-nums font-black text-gray-900 dark:text-white" }}
                                                    />
                                                    <div className="flex bg-white dark:bg-zinc-900 rounded-xl p-1 border border-gray-200 dark:border-white/5 shrink-0 w-full sm:w-auto h-10 shadow-sm">
                                                        {(['EFECTIVO', 'NEQUI', 'DAVIPLATA'] as const).map((m) => (
                                                            <button
                                                                key={m} onClick={() => updateSalaryEgress(egress.id, { method: m })}
                                                                className={`flex-1 sm:px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${egress.method === m ? 'bg-gray-900 dark:bg-emerald-500 text-white dark:text-black shadow-md' : 'text-gray-500 dark:text-zinc-500 hover:text-gray-900 dark:hover:text-white'}`}
                                                            >
                                                                {m.slice(0, 3)}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <p className="text-xs text-gray-400 dark:text-zinc-600 font-bold text-center py-6 bg-gray-50/50 dark:bg-zinc-900/40 border border-dashed border-gray-200 dark:border-white/10 rounded-[1.5rem] uppercase tracking-widest">Sin sueldos registrados en este turno</p>
                                    )}
                                </div>

                                <div className="h-px bg-gray-200 dark:bg-white/5" />

                                {/* SECCIÓN: Gastos Operativos Manuales */}
                                <div className="space-y-4">
                                    <div className="flex items-center justify-between">
                                        <label className="text-[10px] font-black text-amber-600 dark:text-amber-500 uppercase tracking-widest flex items-center gap-2">
                                            <div className="p-1.5 rounded-lg bg-amber-100 dark:bg-amber-500/10"><TrendingDown className="h-4 w-4" /></div>
                                            Gastos Operativos
                                        </label>
                                        <Button isIconOnly size="sm" variant="flat" onPress={addOperationalEgress} className="h-8 w-8 rounded-xl bg-gray-100 dark:bg-zinc-900 text-gray-600 dark:text-amber-500 hover:bg-amber-100 dark:hover:bg-amber-500/20 border border-gray-200 dark:border-white/5 transition-colors">
                                            <Plus className="h-4 w-4" />
                                        </Button>
                                    </div>
                                    {operationalEgresses.length > 0 ? (
                                        <div className="space-y-3">
                                            {operationalEgresses.map((egress) => (
                                                <div key={egress.id} className="p-3 rounded-2xl bg-gray-50 dark:bg-black/50 border border-gray-200 dark:border-white/10 flex flex-col sm:flex-row items-start sm:items-center gap-3 transition-colors">
                                                    <Button isIconOnly size="sm" variant="light" color="danger" onPress={() => removeOperationalEgress(egress.id)} className="shrink-0 hover:bg-rose-100 dark:hover:bg-rose-500/20">
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                    <Input
                                                        size="sm" variant="faded" placeholder="CONCEPTO..."
                                                        value={egress.description} onValueChange={(val) => updateOperationalEgress(egress.id, { description: val.toUpperCase() })}
                                                        classNames={{ inputWrapper: "bg-white dark:bg-zinc-900 border-gray-200 dark:border-white/5 h-10 rounded-xl", input: "font-bold text-gray-900 dark:text-white" }}
                                                    />
                                                    <Input
                                                        size="sm" variant="faded" startContent={<span className="text-amber-500 font-black mr-1">$</span>}
                                                        value={egress.amount ? formatCurrency(egress.amount) : ''}
                                                        onChange={(e) => updateOperationalEgress(egress.id, { amount: parseCurrency(e.target.value) })}
                                                        classNames={{ inputWrapper: "bg-white dark:bg-zinc-900 border-gray-200 dark:border-white/5 h-10 rounded-xl sm:w-36 shrink-0", input: "tabular-nums font-black text-gray-900 dark:text-white" }}
                                                    />
                                                    <div className="flex bg-white dark:bg-zinc-900 rounded-xl p-1 border border-gray-200 dark:border-white/5 shrink-0 w-full sm:w-auto h-10 shadow-sm">
                                                        {(['EFECTIVO', 'NEQUI', 'DAVIPLATA'] as const).map((m) => (
                                                            <button
                                                                key={m} onClick={() => updateOperationalEgress(egress.id, { method: m })}
                                                                className={`flex-1 sm:px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${egress.method === m ? 'bg-amber-500 text-white shadow-md' : 'text-gray-500 dark:text-zinc-500 hover:text-gray-900 dark:hover:text-white'}`}
                                                            >
                                                                {m.slice(0, 3)}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <p className="text-xs text-gray-400 dark:text-zinc-600 font-bold text-center py-6 bg-gray-50/50 dark:bg-zinc-900/40 border border-dashed border-gray-200 dark:border-white/10 rounded-[1.5rem] uppercase tracking-widest">Sin gastos operativos manuales</p>
                                    )}
                                </div>

                                <div className="h-px bg-gray-200 dark:bg-white/5" />

                                {/* SECCIÓN: Billetes & Monedas (Arqueo Físico) */}
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                    <div className="space-y-4">
                                        <label className="text-[10px] font-black text-gray-900 dark:text-white uppercase tracking-widest flex items-center gap-2">
                                            <div className="p-1.5 rounded-lg bg-gray-200 dark:bg-white/10"><Banknote className="h-4 w-4" /></div>
                                            Efectivo (Billetes)
                                        </label>
                                        <Input
                                            size="lg" variant="faded"
                                            startContent={<span className="text-gray-400 dark:text-zinc-500 font-black text-2xl mr-2">$</span>}
                                            value={physicalBills ? formatCurrency(physicalBills) : ''}
                                            onChange={(e) => setPhysicalBills(parseCurrency(e.target.value))}
                                            placeholder="0"
                                            classNames={{
                                                inputWrapper: "bg-gray-50 dark:bg-black border-gray-300 dark:border-white/10 h-20 rounded-[1.5rem] shadow-inner",
                                                input: "text-4xl font-black tabular-nums text-gray-900 dark:text-white"
                                            }}
                                        />
                                    </div>
                                    <div className="space-y-4">
                                        <label className="text-[10px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest flex items-center gap-2">
                                            <div className="p-1.5 rounded-lg bg-gray-100 dark:bg-white/5"><CoinsIcon className="h-4 w-4" /></div>
                                            Monedas Sueltas
                                        </label>
                                        <div className="grid grid-cols-3 gap-3">
                                            {[{ label: "$1k/500", key: '1000_500' }, { label: "$200", key: '200' }, { label: "$100", key: '100' }].map((coin) => (
                                                <div key={coin.key} className="flex flex-col gap-2 p-3 rounded-2xl bg-gray-50 dark:bg-black border border-gray-200 dark:border-white/10 text-center shadow-sm">
                                                    <label className="text-[9px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest">{coin.label}</label>
                                                    <Input
                                                        size="sm" variant="underlined"
                                                        value={coinsCalculator[coin.key] ? formatCurrency(coinsCalculator[coin.key]) : ''}
                                                        onChange={(e) => setCoinsCalculator(prev => ({ ...prev, [coin.key]: parseCurrency(e.target.value) }))}
                                                        placeholder="0"
                                                        classNames={{ input: "text-center font-black tabular-nums text-gray-900 dark:text-white text-base", inputWrapper: "border-gray-300 dark:border-white/20 pb-1" }}
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
                    <div className="lg:col-span-5 flex flex-col gap-6 min-h-0">
                        {/* Tarjeta de Balance en Vivo */}
                        <Card className={`border-2 shadow-xl transition-all duration-500 ${difference >= 0 ? 'bg-white dark:bg-zinc-950 border-emerald-500/30 dark:shadow-[0_0_50px_-10px_rgba(16,185,129,0.15)]' : 'bg-rose-50 dark:bg-rose-950/20 border-rose-500/50 shadow-[0_0_50px_-10px_rgba(244,63,94,0.15)]'}`} radius="lg">
                            <CardBody className="p-8">
                                <div className="flex justify-between items-start mb-8">
                                    <div>
                                        <p className="text-[10px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest mb-2">ARQUEO FÍSICO</p>
                                        <h2 className={`text-5xl font-black tabular-nums tracking-tighter ${difference >= 0 ? 'text-gray-900 dark:text-white' : 'text-rose-600 dark:text-rose-500'}`}>
                                            ${formatCurrency(physicalCash)}
                                        </h2>
                                    </div>
                                    <div className="text-right border-l border-gray-200 dark:border-white/10 pl-6">
                                        <p className="text-[10px] font-black text-gray-400 dark:text-zinc-600 uppercase tracking-widest mb-2">SISTEMA ESPERA</p>
                                        <p className="text-2xl font-black text-gray-700 dark:text-zinc-300 tabular-nums tracking-tighter">${formatCurrency(systemCash)}</p>
                                    </div>
                                </div>

                                <div className={`p-6 rounded-[1.5rem] flex items-center justify-between border ${difference === 0 ? 'bg-gray-100 dark:bg-zinc-900 border-gray-200 dark:border-white/10 text-gray-900 dark:text-white' : difference > 0 ? 'bg-emerald-100 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20 text-emerald-700 dark:text-emerald-400' : 'bg-white dark:bg-rose-500/10 border-rose-200 dark:border-rose-500/20 text-rose-600 dark:text-rose-500 shadow-sm'}`}>
                                    <div className="flex items-center gap-4">
                                        <div className={`h-12 w-12 rounded-[1rem] flex items-center justify-center shrink-0 ${difference === 0 ? 'bg-gray-200 dark:bg-white/10' : difference > 0 ? 'bg-emerald-200 dark:bg-emerald-500/20' : 'bg-rose-100 dark:bg-rose-500/20'}`}>
                                            {difference === 0 ? <Check className="h-6 w-6" /> : difference > 0 ? <TrendingUp className="h-6 w-6" /> : <TrendingDown className="h-6 w-6" />}
                                        </div>
                                        <div className="flex flex-col">
                                            <span className="text-[10px] font-black uppercase tracking-widest opacity-80">Diferencia</span>
                                            <span className="text-[10px] font-bold uppercase opacity-60">
                                                {difference === 0 ? 'Caja Cuadrada' : difference > 0 ? 'Sobrante en caja' : 'Faltante en caja'}
                                            </span>
                                        </div>
                                    </div>
                                    <span className="text-4xl font-black tabular-nums tracking-tighter">
                                        {difference > 0 ? '+' : ''}{formatCurrency(difference)}
                                    </span>
                                </div>
                            </CardBody>
                        </Card>

                        {/* Auditoría Bancos */}
                        <Card className="bg-white/80 dark:bg-zinc-950/60 border border-gray-200 dark:border-white/5 flex-1 shadow-lg dark:shadow-none transition-colors" radius="lg">
                            <CardBody className="p-6 md:p-8 flex flex-col gap-6">
                                <h4 className="text-[10px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest flex items-center gap-3 shrink-0">
                                    <div className="p-1.5 rounded-lg bg-sky-100 dark:bg-sky-500/10 text-sky-600 dark:text-sky-500"><CardIcon className="h-4 w-4" /></div>
                                    AUDITORÍA DIGITAL (Bancos)
                                </h4>
                                <div className="space-y-3 overflow-y-auto custom-scrollbar pr-2">
                                    {[
                                        { label: "Nequi", val: currentClosure?.totalNequi || 0, d: nequiSalaries },
                                        { label: "Daviplata", val: currentClosure?.totalDaviplata || 0, d: daviSalaries },
                                        { label: "Bancolombia", val: currentClosure?.totalBancolombia || 0, d: bankSalaries },
                                    ].map((b, i) => (
                                        <div key={i} className="flex justify-between items-center p-4 rounded-2xl bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-white/5 transition-colors group hover:border-gray-300 dark:hover:border-white/10">
                                            <div className="flex flex-col">
                                                <span className="text-sm font-black text-gray-900 dark:text-white uppercase tracking-tight">{b.label}</span>
                                                {b.d > 0 && <span className="text-[10px] font-black text-amber-600 dark:text-amber-500 mt-1 bg-amber-100 dark:bg-amber-500/10 px-2 py-0.5 rounded-md inline-block w-max tracking-widest">Pago Sueldos: -${formatCurrency(b.d)}</span>}
                                            </div>
                                            <span className="text-xl font-black text-gray-900 dark:text-white tabular-nums tracking-tighter">${formatCurrency(b.val - b.d)}</span>
                                        </div>
                                    ))}
                                </div>
                            </CardBody>
                        </Card>
                    </div>
                </div>

                {/* DIÁLOGO DE CONFIRMACIÓN PREMIUM (Modal HeroUI) */}
                <Modal
                    isOpen={confirmOpen}
                    onOpenChange={setConfirmOpen}
                    backdrop="blur"
                    size="xl"
                    placement="center"
                    classNames={{
                        base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-[2.5rem] shadow-2xl dark:shadow-[0_0_80px_rgba(0,0,0,0.8)]",
                        header: "border-b border-gray-100 dark:border-white/5 pb-6",
                        footer: "border-t border-gray-100 dark:border-white/5 pt-6 bg-gray-50 dark:bg-transparent rounded-b-[2.5rem]"
                    }}
                >
                    <ModalContent>
                        {(onClose) => (
                            <>
                                <ModalHeader className="flex flex-col gap-1 pt-8 px-10">
                                    <h2 className="text-3xl font-black text-gray-900 dark:text-white uppercase tracking-tighter flex items-center gap-3">
                                        <div className="p-2 rounded-xl bg-gray-100 dark:bg-white/10"><Save className="h-6 w-6" /></div>
                                        Confirmar Cierre
                                    </h2>
                                    <p className="text-xs text-gray-500 dark:text-zinc-500 font-bold uppercase tracking-widest mt-2">
                                        Auditoría final de valores antes de finalizar el turno.
                                    </p>
                                </ModalHeader>
                                <ModalBody className="px-10 py-8 space-y-6">
                                    <div className="grid grid-cols-2 gap-6">
                                        <div className={`p-8 rounded-[2rem] border flex flex-col items-center justify-center text-center shadow-inner ${difference >= 0 ? 'bg-emerald-50 dark:bg-emerald-500/5 border-emerald-200 dark:border-emerald-500/20' : 'bg-rose-50 dark:bg-rose-500/5 border-rose-200 dark:border-rose-500/20'}`}>
                                            <span className="text-[10px] font-black uppercase tracking-widest text-gray-500 dark:text-zinc-400 mb-3">Arqueo Físico</span>
                                            <div className="text-4xl font-black text-gray-900 dark:text-white tabular-nums tracking-tighter">${formatCurrency(physicalCash)}</div>
                                        </div>
                                        <div className={`p-8 rounded-[2rem] border flex flex-col items-center justify-center text-center shadow-sm ${difference === 0 ? 'bg-gray-50 dark:bg-zinc-900 border-gray-200 dark:border-white/10' : difference > 0 ? 'bg-emerald-100 dark:bg-emerald-500/10 border-emerald-300 dark:border-emerald-500/30' : 'bg-rose-100 dark:bg-rose-500/10 border-rose-300 dark:border-rose-500/30'}`}>
                                            <span className="text-[10px] font-black uppercase tracking-widest text-gray-500 dark:text-zinc-400 mb-3">Cuadre Final</span>
                                            <div className={`text-4xl font-black tabular-nums tracking-tighter ${difference === 0 ? 'text-gray-400 dark:text-white/50' : difference > 0 ? 'text-emerald-600 dark:text-emerald-500' : 'text-rose-600 dark:text-rose-500'}`}>
                                                {difference > 0 ? '+' : ''}{formatCurrency(difference)}
                                            </div>
                                            <p className={`text-[9px] font-black uppercase mt-2 tracking-widest ${difference === 0 ? 'text-gray-500 dark:text-zinc-500' : difference > 0 ? 'text-emerald-600 dark:text-emerald-500 animate-pulse' : 'text-rose-600 dark:text-rose-500 animate-pulse'}`}>
                                                {difference === 0 ? 'CAJA CUADRADA' : difference > 0 ? 'SOBRANTE' : 'FALTANTE'}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="p-6 bg-gray-50 dark:bg-zinc-900/50 rounded-[2rem] text-center border border-gray-200 dark:border-white/5">
                                        <span className="text-[10px] font-black text-gray-500 dark:text-zinc-500 uppercase tracking-widest">Balance Esperado en Sistema</span>
                                        <div className="text-2xl font-black text-gray-700 dark:text-zinc-300 tabular-nums mt-1 tracking-tight">
                                            ${formatCurrency(systemCash)}
                                        </div>
                                    </div>
                                </ModalBody>
                                <ModalFooter className="px-10 pb-8 gap-4">
                                    <Button variant="light" color="danger" onPress={onClose} className="font-black uppercase tracking-widest text-[10px] h-14 px-8 rounded-xl">
                                        Revisar de Nuevo
                                    </Button>
                                    <Button color="primary" onPress={saveClosure} className="font-black uppercase tracking-widest text-[10px] bg-emerald-500 hover:bg-emerald-600 text-white dark:text-black shadow-xl shadow-emerald-500/20 h-14 px-12 rounded-xl">
                                        Confirmar y Guardar
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