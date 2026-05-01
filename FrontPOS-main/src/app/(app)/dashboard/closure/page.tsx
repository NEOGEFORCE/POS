"use client";

import React, { useState, useEffect } from 'react';
import { 
    DollarSign, 
    Calculator, 
    ArrowRightCircle, 
    AlertTriangle, 
    CheckCircle2, 
    XCircle, 
    ShieldAlert, 
    Send,
    RefreshCw,
    History,
    ArrowLeft,
    TrendingDown,
    TrendingUp,
    Briefcase,
    ShieldCheck,
    CreditCard,
    Lock,
    ChevronDown,
    ChevronUp
} from 'lucide-react';

import { 
    Button, 
    Input, 
    Textarea, 
    Card, 
    CardBody, 
    Skeleton,
    Modal,
    ModalContent,
    ModalHeader,
    ModalBody,
    ModalFooter,
    useDisclosure
} from "@heroui/react";
import { formatCurrency, parseCOP, sanitizeNumber } from '@/lib/utils';
import { apiFetch } from '@/lib/api-error';
import { useToast } from "@/hooks/use-toast";
import Cookies from 'js-cookie';
import { useAuth } from '@/lib/auth';

interface CashierClosure {
    id: string;
    expectedCash: number;
    totalSales: number;
    totalCash: number;
    totalCreditIssued: number;
    totalCreditCollected: number;
    totalExpenses: number;
    totalReturns: number;
    returnsCount: number;
    netBalance: number;
    status: string;
    expenses: any[];
    creditsIssued: any[];
    creditPayments: any[];
    createdAt: string;
    totalNequi: number;
    totalDaviplata: number;
    totalBancolombia: number;
    totalOtherTransfer: number;
    openingCash: number;
    startDate: string;
    endDate: string;
    physicalCash: number;
    difference: number;
    closedByName: string;
    closedByDni: string;
    authorizedBy?: string;
    cashBills: number;
    coins500_1000: number;
    coins200: number;
    coins100: number;
}

export default function CashierClosurePage() {
    const { user, logout } = useAuth();
    const isAdmin = user?.role?.toUpperCase() === 'ADMIN' || user?.role?.toUpperCase() === 'SUPERADMIN';
    const [currentClosure, setCurrentClosure] = useState<CashierClosure | null>(null);
    const [loading, setLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isSendingPartial, setIsSendingPartial] = useState(false);
    const [adminUser, setAdminUser] = useState('');
    const [adminPass, setAdminPass] = useState('');
    const [isAuthorized, setIsAuthorized] = useState(false);
    const { isOpen, onOpen, onOpenChange } = useDisclosure();
    const { isOpen: isResetOpen, onOpen: onResetOpen, onOpenChange: onResetOpenChange } = useDisclosure();
    const [isVerifying, setIsVerifying] = useState(false);
    const [adminAuthorizer, setAdminAuthorizer] = useState('');
    const [authError, setAuthError] = useState('');
    const [showAuthModal, setShowAuthModal] = useState(false);
    const [showDetailedAudit, setShowDetailedAudit] = useState(false);


    const handleAdminVerify = async () => {
        setIsVerifying(true);
        setAuthError('');
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: adminUser, password: adminPass }),
            });

            if (!response.ok) throw new Error('Credenciales inválidas');

            const data = await response.json();
            const role = data.user.role?.toUpperCase();

            if (role === 'ADMIN' || role === 'SUPERADMIN') {
                setIsAuthorized(true);
                setAdminAuthorizer(data.user.name || data.user.username);
                toast({ title: 'AUTORIZACIÓN CONCEDIDA', description: `Verificado por ${data.user.name}`, variant: 'default' });
            } else {
                throw new Error('El usuario no tiene permisos de administrador');
            }
        } catch (error: any) {
            setAuthError(error.message);
            toast({ title: 'ERROR DE AUTORIZACIÓN', description: error.message, variant: 'destructive' });
        } finally {
            setIsVerifying(false);
        }
    };

    const { toast } = useToast();

    // Egresos manuales
    const [salaryEgresses, setSalaryEgresses] = useState<{ id: string, amount: number, method: 'EFECTIVO' | 'FONDO' | 'NEQUI' | 'DAVIPLATA', description: string }[]>([]);
    const [operationalEgresses, setOperationalEgresses] = useState<{ id: string, amount: number, method: 'EFECTIVO' | 'FONDO' | 'NEQUI' | 'DAVIPLATA', description: string }[]>([]);

    // Formulario interactivo derecho
    const [actualCashInput, setActualCashInput] = useState(() => {
        if (typeof window !== 'undefined') return localStorage.getItem('pos_closure_actual') || '';
        return '';
    });
    const [closingNote, setClosingNote] = useState('');

    // Estado del calculador de billetes
    const [bills, setBills] = useState<Record<string, string>>(() => {
        const defaultBills = { '100000': '', '50000': '', '20000': '', '10000': '', '5000': '', '2000': '' };
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('pos_closure_bills');
            return saved ? JSON.parse(saved) : defaultBills;
        }
        return defaultBills;
    });
    const [coins, setCoins] = useState<Record<string, string>>(() => {
        const defaultCoins = { '500_1000': '', '200': '', '100': '' };
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('pos_closure_coins');
            return saved ? JSON.parse(saved) : defaultCoins;
        }
        return defaultCoins;
    });

    // Persistence: Save to localStorage on change
    useEffect(() => {
        localStorage.setItem('pos_closure_bills', JSON.stringify(bills));
    }, [bills]);

    useEffect(() => {
        localStorage.setItem('pos_closure_coins', JSON.stringify(coins));
    }, [coins]);

    useEffect(() => {
        localStorage.setItem('pos_closure_actual', actualCashInput);
    }, [actualCashInput]);



    const fetchCurrent = async () => {
        const token = Cookies.get('org-pos-token');
        if (!token) return;

        setLoading(true);
        try {
            const data = await apiFetch('/dashboard/cashier-closure', { method: 'GET' }, token);
            setCurrentClosure(data);
        } catch (error: any) {
            toast({ title: "Error", description: error.message, variant: "destructive" });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchCurrent();
    }, []);

    // Actualizar actualCashInput cuando el calculador cambie
    useEffect(() => {
        let sum = 0;
        Object.entries(bills).forEach(([val, qty]) => {
            const numericQty = parseInt(sanitizeNumber(qty).toString()) || 0;
            sum += parseInt(val) * numericQty;
        });
        Object.values(coins).forEach(val => {
            sum += parseInt(sanitizeNumber(val || '0').toString()) || 0;
        });

        const hasUsedGrid = Object.values(bills).some(v => v !== '') || Object.values(coins).some(v => v !== '');
        
        // Solo actualizamos si el total de la grilla es distinto al input actual
        // y si la grilla tiene algún valor.
        if (hasUsedGrid) {
            const sumStr = sum.toString();
            if (actualCashInput !== sumStr) {
                setActualCashInput(sumStr);
            }
        }
    }, [bills, coins]);

    const handleAddEgress = (type: 'salary' | 'operational') => {
        const newEgress = { id: crypto.randomUUID(), amount: 0, method: 'EFECTIVO' as any, description: '' };
        if (type === 'salary') setSalaryEgresses([...salaryEgresses, newEgress]);
        else setOperationalEgresses([...operationalEgresses, newEgress]);
    };

    const handleRemoveEgress = (type: 'salary' | 'operational', id: string) => {
        if (type === 'salary') setSalaryEgresses(salaryEgresses.filter(e => e.id !== id));
        else setOperationalEgresses(operationalEgresses.filter(e => e.id !== id));
    };

    const updateEgress = (type: 'salary' | 'operational', id: string, field: string, value: any) => {
        if (type === 'salary') {
            setSalaryEgresses(salaryEgresses.map(e => e.id === id ? { ...e, [field]: value } : e));
        } else {
            setOperationalEgresses(operationalEgresses.map(e => e.id === id ? { ...e, [field]: value } : e));
        }
    };

    // Cálculos del sistema
    const effectiveSalariesPaidList = salaryEgresses.filter(e => e.method === 'EFECTIVO').reduce((acc, e) => acc + e.amount, 0);
    const effectiveOperationalExpenses = operationalEgresses.filter(e => e.method === 'EFECTIVO').reduce((acc, e) => acc + e.amount, 0);

    // Salidas registradas en BD (Solo Efectivo para el cálculo del descuadre)
    const dbCashExpenses = currentClosure?.expenses?.filter(e => !e.paymentSource || e.paymentSource === 'EFECTIVO').reduce((acc, e) => acc + e.amount, 0) ?? 0;
    
    // Otros egresos registrados en BD (Transferencias, etc - Informativo)
    const dbNonCashExpenses = (currentClosure?.totalExpenses ?? 0) - dbCashExpenses;
    
    // Total de salidas que afectan el EFECTIVO (Gastos de BD + Gastos Manuales)
    // NOTA: No restamos Devoluciones aquí porque el backend ya las descuenta de currentClosure.totalCash
    const salidasTotalesEfectivo = dbCashExpenses + effectiveSalariesPaidList + effectiveOperationalExpenses;

    const totalCashIn = currentClosure?.totalCash ?? 0;

    const expensesByChannel = {
        EFECTIVO: (currentClosure?.expenses?.filter(e => e.paymentSource === 'EFECTIVO' || !e.paymentSource).reduce((acc, e) => acc + e.amount, 0) ?? 0) + 
                  salaryEgresses.filter(e => e.method === 'EFECTIVO').reduce((acc, e) => acc + e.amount, 0) +
                  operationalEgresses.filter(e => e.method === 'EFECTIVO').reduce((acc, e) => acc + e.amount, 0),
        NEQUI: (currentClosure?.expenses?.filter(e => e.paymentSource === 'NEQUI').reduce((acc, e) => acc + e.amount, 0) ?? 0) +
               salaryEgresses.filter(e => e.method === 'NEQUI').reduce((acc, e) => acc + e.amount, 0) +
               operationalEgresses.filter(e => e.method === 'NEQUI').reduce((acc, e) => acc + e.amount, 0),
        DAVIPLATA: (currentClosure?.expenses?.filter(e => e.paymentSource === 'DAVIPLATA').reduce((acc, e) => acc + e.amount, 0) ?? 0) +
                   salaryEgresses.filter(e => e.method === 'DAVIPLATA').reduce((acc, e) => acc + e.amount, 0) +
                   operationalEgresses.filter(e => e.method === 'DAVIPLATA').reduce((acc, e) => acc + e.amount, 0),
        FONDO: (currentClosure?.expenses?.filter(e => e.paymentSource === 'FONDO').reduce((acc, e) => acc + e.amount, 0) ?? 0) +
               salaryEgresses.filter(e => e.method === 'FONDO').reduce((acc, e) => acc + e.amount, 0) +
               operationalEgresses.filter(e => e.method === 'FONDO').reduce((acc, e) => acc + e.amount, 0),
    };
    
    // 1. VENTAS BRUTO (Total del turno)
    const totalVentasBruto = currentClosure?.totalSales ?? 0;

    // 2. EFECTIVO EN CAJA (Entradas Brutas)
    const abonosEfectivo = currentClosure?.creditPayments?.reduce((acc, p) => acc + (p.amountCash || 0), 0) ?? 0;
    const ventasEfectivo = (currentClosure?.totalCash ?? 0) - abonosEfectivo;
    const efectivoEnCaja = (currentClosure?.totalCash ?? 0); 

    // 3. EGRESOS EN EFECTIVO (Solo lo que sale de la caja fsica)
    const totalEgresosEfectivo = dbCashExpenses + effectiveSalariesPaidList + effectiveOperationalExpenses;

    // 4. EFECTIVO ESPERADO (Entradas - Salidas)
    const expectedCash = efectivoEnCaja - totalEgresosEfectivo;
    
    // Variables de apoyo para la UI
    const totalDevoluciones = currentClosure?.totalReturns ?? 0;
    const devolucionesCount = currentClosure?.returnsCount ?? 0;
    
    const actualCash = parseFloat(actualCashInput) || 0;
    
    // Si el esperado es negativo (ej: -100), significa que falt plata para cubrir gastos.
    // El cajero "debe" esa plata. Por tanto, el objetivo es llegar a 0 o cubrir la deuda.
    // Si tiene 0, le faltan 100 para estar "balanceado" con los egresos.
    const difference = expectedCash < 0 
        ? actualCash + expectedCash // Si actual es 0 y esperado -100, diff es -100 (Falta)
        : actualCash - expectedCash;

    const getStatus = () => {
        // Si el esperado es negativo, ya hay un faltante operativo por defecto.
        // Solo mostramos PENDING si el esperado es positivo y el usuario no ha escrito nada.
        if (!actualCashInput && expectedCash >= 0) return 'PENDING';
        
        if (difference === 0) return 'BALANCED';
        if (difference < 0) return 'SHORTAGE';
        return 'SURPLUS';
    };

    const status = getStatus();

    const handleCloseRegister = async () => {
        // Si hay faltante y NO está autorizado Y NO es admin, abrir modal de admin
        if (status === 'SHORTAGE' && !isAuthorized && !isAdmin) {
            setShowAuthModal(true);
            return;
        }


        // Nota: Ya no es obligatorio justificar porque el sistema requiere autorización administrativa directa.


        setIsSubmitting(true);
        const token = Cookies.get('org-pos-token');
        if (!token) return;

        const totalSalidasEfectivo = totalEgresosEfectivo;

        const totalBills = Object.entries(bills).reduce((acc, [val, qty]) => acc + (parseInt(val) * (parseInt(qty) || 0)), 0);
        const c500 = parseInt(coins['500_1000'] || '0');
        const c200 = parseInt(coins['200'] || '0');
        const c100 = parseInt(coins['100'] || '0');

        const closureData = {
            ...currentClosure,
            physicalCash: actualCash,
            difference: difference,
            closedByDni: user?.dni || 'S.N.',
            closedByName: user?.name || 'SOPORTE',
            authorizedBy: isAdmin ? (user?.name || 'ADMIN') : adminAuthorizer,

            totalExpenses: totalSalidasEfectivo,
            cashBills: totalBills,
            coins500_1000: c500,
            coins200: c200,
            coins100: c100,
            expenses: [
                ...salaryEgresses.map(e => ({
                    description: e.description || 'PAGO NÓMINA',
                    category: 'Nómina',
                    amount: e.amount,
                    paymentSource: e.method
                })),
                ...operationalEgresses.map(e => ({
                    description: e.description || 'GASTO OPERATIVO',
                    category: 'Operativo',
                    amount: e.amount,
                    paymentSource: e.method
                })),
                ...(currentClosure?.expenses || [])
            ]
        };

        try {
            await apiFetch('/dashboard/cashier-closure/close', {
                method: 'POST',
                body: JSON.stringify(closureData),
                fallbackError: 'Error al procesar el cierre'
            }, token);

            toast({ title: "Caja Cerrada", description: "El cierre de caja se ha procesado correctamente.", variant: "default" });
            setShowAuthModal(false);
            fetchCurrent();
            resetCalculator();
        } catch (error: any) {
            toast({ title: "FALLO DE CIERRE", description: error.message, variant: "destructive" });
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleSendPartial = async () => {
        const token = Cookies.get('org-pos-token');
        if (!token) return;

        setIsSendingPartial(true);
        const totalBills = Object.entries(bills).reduce((acc, [val, qty]) => acc + (parseInt(val) * (parseInt(qty) || 0)), 0);
        const c500 = parseInt(coins['500_1000'] || '0');
        const c200 = parseInt(coins['200'] || '0');
        const c100 = parseInt(coins['100'] || '0');

        const closureData = {
            ...currentClosure,
            physicalCash: actualCash,
            difference: difference,
            closedByDni: user?.dni || 'S.N.',
            closedByName: user?.name || 'SOPORTE',
            totalExpenses: totalEgresosEfectivo, // Solo efectivo para el balance en Telegram
            notes: closingNote,
            cashBills: totalBills,
            coins500_1000: c500,
            coins200: c200,
            coins100: c100,
            expenses: [
                ...salaryEgresses.map(e => ({
                    description: e.description || 'PAGO NÓMINA',
                    category: 'Nómina',
                    amount: e.amount,
                    paymentSource: e.method
                })),
                ...operationalEgresses.map(e => ({
                    description: e.description || 'GASTO OPERATIVO',
                    category: 'Operativo',
                    amount: e.amount,
                    paymentSource: e.method
                })),
                ...(currentClosure?.expenses || [])
            ]
        };

        try {
            await apiFetch('/dashboard/telegram-report-partial', {
                method: 'POST',
                body: JSON.stringify(closureData),
                fallbackError: 'No se pudo enviar el reporte parcial'
            }, token);

            toast({ title: "REPORTE ENVIADO", description: "El reporte parcial ha sido enviado a Telegram correctamente.", variant: "default" });
        } catch (error: any) {
            toast({ title: "FALLO AL ENVIAR", description: error.message, variant: "destructive" });
        } finally {
            setIsSendingPartial(false);
        }
    };

    const billConfigs = {
        '100000': { label: '100k', color: 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-500/5 dark:border-emerald-500/20 dark:text-emerald-400', iconColor: 'bg-emerald-500' },
        '50000': { label: '50k', color: 'bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-500/5 dark:border-rose-500/20 dark:text-rose-400', iconColor: 'bg-rose-500' },
        '20000': { label: '20k', color: 'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-500/5 dark:border-amber-500/20 dark:text-amber-400', iconColor: 'bg-amber-500' },
        '10000': { label: '10k', color: 'bg-red-50 border-red-200 text-red-700 dark:bg-red-500/5 dark:border-red-500/20 dark:text-red-400', iconColor: 'bg-red-500' },
        '5000': { label: '5k', color: 'bg-blue-50 border-blue-200 text-blue-700 dark:bg-blue-500/5 dark:border-blue-500/20 dark:text-blue-400', iconColor: 'bg-blue-500' },
        '2000': { label: '2k', color: 'bg-cyan-50 border-cyan-200 text-cyan-700 dark:bg-cyan-500/5 dark:border-cyan-500/20 dark:text-cyan-400', iconColor: 'bg-cyan-500' },
    };

    const coinConfigs = {
        '500_1000': { label: '500 / 1000', color: 'bg-gray-100 border-gray-200 text-gray-700 dark:bg-zinc-900 dark:border-zinc-500 dark:text-zinc-300' },
        '200': { label: '200', color: 'bg-gray-100 border-gray-200 text-gray-700 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-400' },
        '100': { label: '100', color: 'bg-gray-100 border-gray-200 text-gray-700 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-500' },
    };

    const resetCalculator = () => {
        onResetOpen();
    };

    const confirmReset = () => {
        setBills({ '100000': '', '50000': '', '20000': '', '10000': '', '5000': '', '2000': '' });
        setCoins({ '500_1000': '', '200': '', '100': '' });
        setActualCashInput('');
        localStorage.removeItem('pos_closure_bills');
        localStorage.removeItem('pos_closure_coins');
        localStorage.removeItem('pos_closure_actual');
    };



    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 bg-gray-50 dark:bg-zinc-950 text-zinc-900 dark:text-white rounded-[2rem] border border-black/5 dark:border-white/5 m-2 md:m-4">
                <Skeleton className="h-12 w-12 rounded-full bg-zinc-200 dark:bg-zinc-800" />
                <p className="text-[10px] font-black text-emerald-600 dark:text-emerald-500 uppercase tracking-widest animate-pulse">Sincronizando Auditoría...</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col w-full bg-gray-50 dark:bg-zinc-950 text-gray-900 dark:text-white p-1 md:p-3 pt-0 md:pt-0 gap-3 md:gap-4 pb-10">


            
            {/* HEADER COMPACTO */}
            <div className="flex items-center justify-between shrink-0 px-2">
                <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-xl bg-emerald-500 flex items-center justify-center shadow-lg shadow-emerald-500/20">
                        <Calculator className="text-zinc-950" size={24} />
                    </div>
                    <div>
                        <h1 className="text-lg font-black uppercase tracking-tighter">Cierre de Caja</h1>
                        <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest flex items-center gap-2">
                            {currentClosure ? (
                                <>
                                    <span className="text-emerald-700 dark:text-emerald-500 flex items-center gap-1">
                                        <TrendingUp size={10} /> INICIO: {new Date(currentClosure.startDate).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                    <span className="text-gray-300 dark:text-zinc-700">|</span>
                                    <span className="text-rose-700 dark:text-rose-500 flex items-center gap-1">
                                        <TrendingDown size={10} /> CIERRE: {new Date(currentClosure.endDate).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                </>
                            ) : 'Auditoría en Tiempo Real'}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Button 
                        variant="flat"
                        onPress={fetchCurrent}
                        className="bg-zinc-800 text-white font-black text-[10px] uppercase tracking-widest px-3 md:px-4 min-w-0"
                        startContent={<RefreshCw size={14} className={loading ? 'animate-spin' : ''} />}
                    >
                        <span className="hidden md:inline">Sincronizar Datos</span>
                    </Button>

                </div>

            </div>

            {/* CONTENEDOR PRINCIPAL */}
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-3 md:gap-4 flex-1 lg:min-h-0 lg:overflow-hidden px-1">

                
                {/* BLOQUE IZQUIERDO: AUDITORÍA FINANCIERA COMPLETA */}
                {isAdmin ? (
                <div className="flex-1 flex flex-col lg:min-h-0 bg-white border border-gray-200 dark:bg-zinc-900/40 dark:border-white/5 rounded-3xl overflow-hidden shadow-sm dark:shadow-2xl">
                    <div className="flex-1 lg:overflow-y-auto p-4 md:p-5 space-y-4 md:space-y-6 scrollbar-hide">

                        
                        {/* BLOQUE 1: MATEMÁTICA FÍSICA (TICKET PRINCIPAL) */}
                        <section className="shrink-0 bg-gray-100 dark:bg-emerald-500/5 rounded-3xl border border-gray-200 dark:border-emerald-500/10 p-4 md:p-8 relative overflow-hidden">
                            <div className="flex items-center gap-4 mb-6 opacity-80">
                                <h2 className="text-[10px] font-bold uppercase tracking-wider text-gray-800 dark:text-zinc-400">Balance de Caja</h2>
                            </div>
                            <div className="flex flex-col gap-1 md:gap-2 relative z-10">
                                <div className="flex items-center justify-between py-1 border-b border-gray-200 dark:border-emerald-500/10">
                                    <span className="text-[10px] font-bold text-gray-600 dark:text-zinc-500 uppercase tracking-widest">Entradas Efectivo (Ventas+Abonos)</span>
                                    <span className="text-lg font-black text-emerald-700 dark:text-emerald-500">+{formatCurrency(efectivoEnCaja)}</span>
                                </div>
                                <div className="flex items-center justify-between py-1 border-b border-gray-200 dark:border-emerald-500/10">
                                    <span className="text-[10px] font-bold text-rose-700 dark:text-rose-500/60 uppercase tracking-widest">Salidas Efectivo (Gastos+Nomina)</span>
                                    <span className="text-lg font-black text-rose-700 dark:text-rose-500">-{formatCurrency(totalEgresosEfectivo)}</span>
                                </div>
                            </div>
                            <div className="mt-8 flex flex-col items-center justify-center relative z-10">
                                <span className="text-[10px] font-bold text-gray-500 dark:text-zinc-400 uppercase tracking-wider mb-2">Efectivo Final Esperado</span>
                                <span className="text-5xl md:text-7xl font-black text-gray-900 dark:text-white tabular-nums tracking-tighter drop-shadow-sm">
                                    ${formatCurrency(expectedCash)}
                                </span>
                            </div>
                        </section>

                        {/* BOTÓN VER MÁS PARA MÓVIL */}
                        <div className="lg:hidden px-2 pb-2">
                            <Button
                                fullWidth
                                variant="flat"
                                onPress={() => setShowDetailedAudit(!showDetailedAudit)}
                                className="h-14 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] border border-white/5 bg-white/[0.03] text-zinc-400"
                                endContent={showDetailedAudit ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                            >
                                {showDetailedAudit ? 'OCULTAR AUDITORÍA' : 'VER AUDITORÍA DETALLADA'}
                            </Button>
                        </div>

                        {/* BLOQUES COLAPSABLES EN MÓVIL / SIEMPRE VISIBLES EN DESKTOP */}
                        <div className={`${showDetailedAudit ? 'block' : 'hidden lg:block'} space-y-8 animate-in fade-in slide-in-from-top-4 duration-500`}>
                            {/* BLOQUE 2: EGRESOS DETALLADOS (TODO EXPUESTO) */}
                            <section className="space-y-4">

                            <div className="flex items-center gap-2 border-b border-gray-200 dark:border-white/5 pb-2">
                                <TrendingDown size={14} className="text-rose-700 dark:text-rose-500" />
                                <h3 className="text-[10px] font-bold text-gray-800 dark:text-zinc-400 uppercase tracking-wider">Desglose de Egresos</h3>
                            </div>
                            <div className="grid grid-cols-1 gap-2">
                                {currentClosure?.expenses?.map((exp, idx) => (
                                    <div key={idx} className="flex items-center justify-between p-3 rounded-2xl bg-gray-50 dark:bg-white/[0.02] border border-gray-200 dark:border-white/5">
                                        <div className="flex flex-col">
                                            <span className="text-[10px] font-black text-rose-700 dark:text-rose-500/60 uppercase">{exp.category}</span>
                                            <span className="text-xs font-bold text-gray-900 dark:text-white uppercase">{exp.description}</span>
                                        </div>
                                        <div className="text-right">
                                            <span className="text-sm font-black text-gray-900 dark:text-white">${formatCurrency(exp.amount)}</span>
                                            <div className="text-[9px] text-gray-500 dark:text-zinc-600 font-bold uppercase">{exp.paymentSource}</div>
                                        </div>
                                    </div>
                                ))}
                                {totalDevoluciones > 0 && (
                                    <div className="flex items-center justify-between p-3 rounded-2xl bg-rose-50 dark:bg-rose-500/5 border border-rose-200 dark:border-rose-500/10">
                                        <div className="flex flex-col">
                                            <span className="text-[10px] font-black text-rose-700 dark:text-rose-500/60 uppercase">Devoluciones</span>
                                            <span className="text-xs font-bold text-gray-900 dark:text-white">{devolucionesCount} Operaciones</span>
                                        </div>
                                        <span className="text-sm font-black text-rose-700 dark:text-white">-${formatCurrency(totalDevoluciones)}</span>
                                    </div>
                                )}
                                {[...salaryEgresses, ...operationalEgresses].map((e) => (
                                    <div key={e.id} className="flex items-center justify-between p-3 rounded-2xl border border-dashed border-rose-500/20 bg-rose-50 dark:bg-rose-500/5">
                                        <div className="flex flex-col">
                                            <span className="text-[10px] font-black text-rose-600 dark:text-rose-500 uppercase">NUEVO EGRESO</span>
                                            <span className="text-xs font-bold text-zinc-900 dark:text-white uppercase italic">{e.description || 'Sin descripción'}</span>
                                        </div>
                                        <div className="text-right">
                                            <span className="text-sm font-black text-rose-700 dark:text-rose-400">-${formatCurrency(e.amount)}</span>
                                            <div className="text-[9px] text-gray-500 dark:text-zinc-600 font-bold uppercase">{e.method}</div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>

                        {/* BLOQUE 3: INGRESOS DIGITALES (ULTRA-COMPACTO) */}
                        <section className="space-y-2">
                            <div className="flex items-center gap-2 border-b border-gray-200 dark:border-white/5 pb-1">
                                <CreditCard size={12} className="text-blue-700 dark:text-blue-500" />
                                <h3 className="text-[9px] font-bold text-gray-800 dark:text-zinc-400 uppercase tracking-wider">Digitales</h3>
                            </div>
                             <div className="grid grid-cols-3 gap-2">
                                <div className="p-4 rounded-3xl bg-blue-50 dark:bg-blue-500/5 border border-blue-200 dark:border-blue-500/10 flex flex-col gap-1 items-center text-center">
                                    <span className="text-[9px] font-black text-blue-700 dark:text-blue-400 uppercase">Nequi</span>
                                    <span className="text-lg font-black text-blue-800 dark:text-white">${formatCurrency(currentClosure?.totalNequi ?? 0)}</span>
                                </div>
                                <div className="p-4 rounded-3xl bg-purple-50 dark:bg-purple-500/5 border border-purple-200 dark:border-purple-500/10 flex flex-col gap-1 items-center text-center">
                                    <span className="text-[9px] font-black text-purple-700 dark:text-purple-400 uppercase">Daviplata</span>
                                    <span className="text-lg font-black text-purple-800 dark:text-white">${formatCurrency(currentClosure?.totalDaviplata ?? 0)}</span>
                                </div>
                                <div className="p-4 rounded-3xl bg-gray-100 dark:bg-zinc-500/5 border border-gray-200 dark:border-zinc-500/10 flex flex-col gap-1 items-center text-center">
                                    <span className="text-[9px] font-black text-gray-600 dark:text-zinc-500 uppercase">Otros</span>
                                    <span className="text-lg font-black text-gray-900 dark:text-white">${formatCurrency((currentClosure?.totalBancolombia ?? 0) + (currentClosure?.totalOtherTransfer ?? 0))}</span>
                                </div>
                            </div>
                        </section>

                        {/* BLOQUE 4: FIADOS Y ABONOS */}
                        <section className="space-y-4">
                            <div className="flex items-center gap-2 border-b border-gray-200 dark:border-white/5 pb-2">
                                <Briefcase size={14} className="text-gray-500 dark:text-zinc-500" />
                                <h3 className="text-[10px] font-bold text-gray-800 dark:text-zinc-400 uppercase tracking-wider">Créditos y Abonos</h3>
                            </div>
                            <div className="bg-gray-50 dark:bg-zinc-900/40 border border-gray-200 dark:border-white/10 rounded-2xl p-4 md:p-6 shadow-sm dark:shadow-none">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div className="space-y-2">
                                        <span className="text-[10px] font-bold text-blue-700 dark:text-blue-400 uppercase tracking-wider">Fiados Emitidos (${formatCurrency(currentClosure?.totalCreditIssued ?? 0)})</span>
                                        <div className="space-y-1">
                                            {currentClosure?.creditsIssued?.map((sale, idx) => (
                                                <div key={idx} className="flex items-center justify-between text-[10px] py-2 border-b border-gray-200 dark:border-white/5">
                                                    <span className="text-gray-500 dark:text-zinc-500 font-bold uppercase truncate max-w-[120px]">{sale.client?.name || 'Cliente'}</span>
                                                    <span className="text-blue-700 dark:text-blue-400 font-black">${formatCurrency(sale.creditAmount)}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider">Abonos Recibidos (${formatCurrency(currentClosure?.totalCreditCollected ?? 0)})</span>
                                        <div className="space-y-1">
                                            {currentClosure?.creditPayments?.map((p, idx) => (
                                                <div key={idx} className="flex items-center justify-between text-[10px] py-2 border-b border-gray-200 dark:border-white/5">
                                                    <span className="text-gray-500 dark:text-zinc-500 font-bold uppercase truncate max-w-[120px]">{p.client?.name || 'Cliente'}</span>
                                                    <span className="text-emerald-700 dark:text-emerald-400 font-black">${formatCurrency(p.totalPaid)}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </section>
                    </div>
                </div>
            </div>

                ) : (
                <div className="flex-1 flex flex-col items-center justify-center bg-white border border-gray-200 dark:bg-zinc-900/40 dark:border-white/5 rounded-3xl shadow-sm dark:shadow-2xl text-center p-8">
                    <div className="flex flex-col items-center gap-2 mb-12">
                        <span className="text-sm font-black text-emerald-700 dark:text-emerald-500/80 uppercase tracking-[0.4em]">Efectivo Esperado en Caja</span>
                        <span className="text-7xl font-black text-gray-900 dark:text-white tracking-tighter drop-shadow-sm">
                            ${formatCurrency(expectedCash)}
                        </span>
                        <p className="text-xs font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest mt-2">
                            Ingresa tu conteo físico para cuadrar
                        </p>
                    </div>

                    <div className="h-16 w-16 rounded-full bg-gray-100 dark:bg-zinc-800/50 flex items-center justify-center mb-4">
                        <Lock size={24} className="text-gray-400 dark:text-zinc-600" />
                    </div>
                    <h2 className="text-lg font-black text-gray-900 dark:text-white uppercase tracking-tighter mb-2">Desglose Restringido</h2>
                    <p className="text-xs font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-widest max-w-sm">
                        El detalle de auditoría (ventas, egresos, digitales) es visible únicamente para administradores.
                    </p>
                </div>
                )}

                {/* BLOQUE DERECHO: INTERACCIÓN CAJERO (SCROLLABLE) */}
                <div className="bg-white border border-gray-200 dark:bg-zinc-900/60 dark:border-white/5 rounded-2xl p-5 md:p-6 flex flex-col gap-4 shadow-sm dark:shadow-2xl relative overflow-hidden">
                    
                    <div className="flex-1 flex flex-col gap-6">
                        <div className="flex flex-col gap-4">
                            <div className="flex items-center gap-2 px-1">
                                <div className="h-4 w-1 bg-emerald-500 rounded-full" />
                                <h4 className="text-[10px] font-black text-gray-900 dark:text-white uppercase tracking-[0.2em]">Conteo de Efectivo</h4>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                {Object.entries(billConfigs).map(([val, config]) => (
                                    <div key={val} className={`flex items-center gap-2 p-2 rounded-xl border transition-all duration-300 ${config.color}`}>
                                        <div className={`h-6 w-6 rounded-lg ${config.iconColor} flex items-center justify-center text-[10px] font-black text-zinc-950 shrink-0`}>
                                            {config.label}
                                        </div>
                                        <Input
                                            type="text"
                                            placeholder="0"
                                            variant="underlined"
                                            value={bills[val as keyof typeof bills] ? formatCurrency(sanitizeNumber(bills[val as keyof typeof bills]).toString()) : ''}
                                            onValueChange={(v) => setBills({ ...bills, [val]: sanitizeNumber(v).toString() })}
                                            classNames={{
                                                inputWrapper: "h-7 bg-transparent border-none p-0 min-h-unit-0",
                                                input: "font-black text-right text-xs text-gray-900 dark:text-white pr-1"
                                            }}
                                        />
                                    </div>
                                ))}
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                                {Object.entries(coinConfigs).map(([val, config]) => (
                                    <div key={val} className={`flex flex-col gap-1 p-2 rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-zinc-950/40 shadow-sm dark:shadow-none`}>
                                        <span className="text-[8px] font-bold text-gray-600 dark:text-zinc-500 uppercase text-center">{config.label}</span>
                                        <Input
                                            type="text"
                                            placeholder="0"
                                            variant="underlined"
                                            value={coins[val as keyof typeof coins] ? formatCurrency(sanitizeNumber(coins[val as keyof typeof coins]).toString()) : ''}
                                            onValueChange={(v) => setCoins({ ...coins, [val]: sanitizeNumber(v).toString() })}
                                            classNames={{
                                                inputWrapper: "h-7 bg-transparent border-none p-0 min-h-unit-0",
                                                input: "font-black text-right text-xs text-gray-900 dark:text-zinc-300 pr-1"
                                            }}
                                        />
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* 2. ENTRADA MANUAL */}
                        <div className="flex flex-col gap-4">
                            <div className="flex items-center justify-between px-1">
                                <div className="flex items-center gap-2">
                                    <div className="h-4 w-1 bg-amber-500 rounded-full" />
                                    <h4 className="text-[10px] font-black text-gray-900 dark:text-white uppercase tracking-[0.2em]">Total Manual</h4>
                                </div>
                                <Button 
                                    size="sm" 
                                    variant="bordered" 
                                    onPress={resetCalculator} 
                                    className="font-black text-[9px] uppercase tracking-[0.2em] px-4 h-9 border-rose-500/30 text-rose-500 hover:bg-rose-500 hover:text-white transition-all shadow-lg shadow-rose-500/5 rounded-xl"
                                    startContent={<History size={12} />}
                                >
                                    BORRAR CONTEO
                                </Button>


                            </div>
                            <Input
                                type="text"
                                placeholder="$ 0"
                                value={actualCashInput ? `$ ${formatCurrency(actualCashInput)}` : ''}
                                onValueChange={(v) => setActualCashInput(sanitizeNumber(v).toString())}
                                classNames={{
                                    input: "text-3xl font-black text-center text-gray-900 dark:text-white font-mono",
                                    inputWrapper: "bg-gray-100 dark:bg-emerald-950/10 border-2 border-gray-200 dark:border-emerald-500/30 h-20 rounded-2xl shadow-sm dark:shadow-xl"
                                }}
                            />
                        </div>
                    </div>

                    {/* FOOTER DE ACCIÓN */}
                    <div className="shrink-0 pt-2 flex flex-col gap-3 border-t border-black/5 dark:border-white/5">
                        <div className={`flex items-center justify-between p-4 rounded-2xl border transition-all duration-500 ${
                            status === 'BALANCED' ? 'bg-yellow-50 border-yellow-200 text-yellow-800 dark:bg-yellow-500/10 dark:border-yellow-500/20 dark:text-yellow-500' :
                            status === 'SHORTAGE' ? 'bg-rose-100 border-rose-300 text-rose-800 dark:bg-rose-500/10 dark:border-rose-500/20 dark:text-rose-500' :
                            'bg-blue-100 border-blue-300 text-blue-800 dark:bg-blue-500/10 dark:border-blue-500/20 dark:text-blue-500'
                        }`}>
                            <div className="flex flex-col">
                                <span className="text-[10px] font-black uppercase tracking-[0.2em] opacity-60">Diferencia</span>
                                <span className="text-sm font-black uppercase flex items-center gap-2">
                                    {status === 'PENDING' ? 'ESPERANDO CONTEO' : 
                                     status === 'BALANCED' ? 'CAJA CUADRADA' : 
                                     status === 'SHORTAGE' ? 'FALTANTE' : 'SOBRANTE'}
                                </span>
                            </div>
                            <span className="text-xl font-black font-mono">${formatCurrency(Math.abs(difference))}</span>
                        </div>

                        {isAuthorized && adminAuthorizer && (
                            <div className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 p-3 rounded-xl flex items-center gap-3">
                                <ShieldCheck className="text-emerald-700 dark:text-emerald-500" size={16} />
                                <span className="text-[10px] font-black text-emerald-700 dark:text-emerald-500 uppercase tracking-tighter">Autorizado por: {adminAuthorizer}</span>
                            </div>
                        )}

                        <div className="flex gap-2">
                            <Button
                                onPress={handleSendPartial}
                                isLoading={isSendingPartial}
                                variant="bordered"
                                className="h-16 rounded-2xl border-gray-200 dark:border-white/10 font-black text-gray-400 dark:text-zinc-400 uppercase tracking-widest text-[10px] hover:bg-gray-50 dark:hover:bg-white/5"
                            >
                                <Send size={14} className="mr-1" />
                                Reporte Parcial
                            </Button>
                            <Button
                                onPress={handleCloseRegister}
                                isDisabled={status === 'PENDING' || isSubmitting}
                                className={`flex-1 h-16 rounded-2xl font-black text-xl uppercase tracking-widest italic shadow-2xl transition-all ${
                                    (status === 'SHORTAGE' && !isAuthorized && !isAdmin) ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500'
                                } text-white`}
                            >
                                {isSubmitting ? 'PROCESANDO...' : (status === 'SHORTAGE' && !isAuthorized && !isAdmin) ? 'AUTORIZAR' : 'CERRAR CAJA'}
                            </Button>

                        </div>
                    </div>
                </div>
            </div>

            {/* MODAL DE AUTORIZACIÓN (DISEÑO ULTRA-PREMIUM) */}
            <Modal 
                isOpen={showAuthModal} 
                onOpenChange={setShowAuthModal} 
                backdrop="blur" 
                placement="center"
                classNames={{
                    base: "bg-white dark:bg-zinc-900/60 backdrop-blur-xl border border-black/10 dark:border-white/10 rounded-3xl shadow-2xl shadow-black/40 max-w-md mx-4",
                    header: "border-none pt-8 px-8",
                    body: "py-2 px-8",
                    footer: "border-none pb-8 px-8 gap-4",
                    closeButton: "hover:bg-black/5 dark:hover:bg-white/5 active:bg-black/10 dark:active:bg-white/10 text-zinc-400 transition-colors right-4 top-4"
                }}
            >
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader>
                                <div className="flex items-center gap-6">
                                    <div className="h-14 w-14 rounded-full bg-rose-50 dark:bg-rose-500/10 flex items-center justify-center border border-rose-600/20 dark:border-rose-500/20 shadow-[0_0_20px_rgba(225,29,72,0.1)]">
                                        <Lock size={28} className="text-rose-600 dark:text-rose-500 drop-shadow-[0_0_8px_rgba(225,29,72,0.5)]" />
                                    </div>
                                    <div>
                                        <span className="text-rose-600 dark:text-rose-500 text-[10px] font-black uppercase tracking-[0.3em] block mb-1">SEGURIDAD</span>
                                        <h2 className="text-xl font-black text-zinc-900 dark:text-white uppercase tracking-wider leading-none">AUTORIZAR</h2>
                                    </div>
                                </div>
                            </ModalHeader>
                            <ModalBody>
                                <div className="flex flex-col gap-4 pt-2">
                                    <Input 
                                        label="USUARIO ADMIN" 
                                        value={adminUser} 
                                        onValueChange={setAdminUser} 
                                        variant="bordered" 
                                        classNames={{ 
                                            label: "text-zinc-500 font-bold text-[10px] tracking-widest", 
                                            inputWrapper: "border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 rounded-xl h-14",
                                            input: "font-bold text-zinc-900 dark:text-white"
                                        }} 
                                    />
                                    <Input 
                                        label="CONTRASEÑA" 
                                        type="password" 
                                        value={adminPass} 
                                        onValueChange={setAdminPass} 
                                        variant="bordered" 
                                        classNames={{ 
                                            label: "text-zinc-500 font-bold text-[10px] tracking-widest", 
                                            inputWrapper: "border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 rounded-xl h-14",
                                            input: "font-bold text-zinc-900 dark:text-white"
                                        }} 
                                    />
                                    {authError && (
                                        <div className="bg-rose-50 dark:bg-rose-500/10 border border-rose-600/20 dark:border-rose-500/20 p-2 rounded-lg">
                                            <p className="text-[10px] text-rose-600 dark:text-rose-500 font-bold uppercase text-center tracking-widest">{authError}</p>
                                        </div>
                                    )}
                                </div>
                            </ModalBody>
                            <ModalFooter>
                                <Button 
                                    onPress={handleAdminVerify} 
                                    isLoading={isVerifying} 
                                    className="w-full bg-rose-600 hover:bg-rose-500 text-white font-black text-xs uppercase tracking-[0.2em] h-14 rounded-xl transition-all duration-300 shadow-lg shadow-rose-500/20 active:scale-95 mt-2"
                                >
                                    VERIFICAR CREDENCIALES
                                </Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>

            {/* MODAL DE CONFIRMACIÓN DE REINICIO (DISEÑO ULTRA-PREMIUM) */}
            <Modal 
                isOpen={isResetOpen} 
                onOpenChange={onResetOpenChange}
                backdrop="blur"
                placement="center"
                hideCloseButton={false}

                classNames={{
                    base: "bg-zinc-900/60 backdrop-blur-xl border border-white/10 rounded-3xl shadow-2xl shadow-black/40 max-w-md mx-4",
                    header: "border-none pt-8 px-8",
                    body: "py-2 px-8",
                    footer: "border-none pb-8 px-8 gap-4",
                    closeButton: "hover:bg-white/5 active:bg-white/10 text-zinc-400 transition-colors right-4 top-4"
                }}

            >
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader>
                                <div className="flex items-center gap-6">
                                    <div className="h-14 w-14 rounded-full bg-rose-500/10 flex items-center justify-center border border-rose-500/20 shadow-[0_0_20px_rgba(225,29,72,0.1)]">
                                        <AlertTriangle size={28} className="text-rose-500 drop-shadow-[0_0_8px_rgba(225,29,72,0.5)]" />
                                    </div>
                                    <h2 className="text-xl font-black text-white uppercase tracking-wider">¿BORRAR CONTEO?</h2>
                                </div>
                            </ModalHeader>
                            <ModalBody>
                                <div className="space-y-4">
                                    <p className="text-[11px] font-bold text-zinc-400 uppercase tracking-widest leading-relaxed">
                                        ESTÁS A PUNTO DE BORRAR TODOS LOS BILLETES Y MONEDAS QUE HAS INGRESADO. 
                                        <span className="block mt-2 text-rose-500/80">ESTA ACCIÓN NO SE PUEDE DESHACER.</span>
                                    </p>
                                </div>
                            </ModalBody>
                            <ModalFooter className="justify-end">
                                <Button 
                                    variant="light" 
                                    onPress={onClose}
                                    className="font-black text-xs uppercase tracking-widest text-zinc-500 hover:text-white transition-all px-6 h-12"
                                >
                                    CANCELAR
                                </Button>
                                <Button 
                                    onPress={() => { confirmReset(); onClose(); }}
                                    className="bg-rose-600 hover:bg-rose-500 text-white font-black text-xs uppercase tracking-[0.1em] px-10 h-12 rounded-xl transition-all duration-300 shadow-lg shadow-rose-500/20 active:scale-95"
                                >
                                    SÍ, BORRAR TODO
                                </Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>
        </div>
    );
}

