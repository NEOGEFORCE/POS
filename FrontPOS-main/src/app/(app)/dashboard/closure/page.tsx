"use client";

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { 
    DollarSign, 
    Calculator, 
    AlertTriangle, 
    CheckCircle2, 
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
    ChevronUp,
    ReceiptText,
    Trash2,
    Pen
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
import { formatCurrency, parseCOP, sanitizeNumber, formatTime, formatShortDateTime, formatDateTime } from '@/lib/utils';
import { apiFetch } from '@/lib/api-error';
import { useToast } from "@/hooks/use-toast";
import Cookies from 'js-cookie';
import { useAuth } from '@/lib/auth';
import { useSearchParams, useRouter } from 'next/navigation';
import ExpenseFormModal from '@/app/(app)/expenses/components/ExpenseFormModal';
import { broadcastRevalidate, setupSyncListener } from '@/lib/revalidate';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { RollingDigits } from '@/components/charts/RollingDigits';

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
    cashBreakdown?: string;
    coins1000: number;
    coins500: number;
    coins200: number;
    coins100: number;
}

export default function CashierClosurePage() {
    const { user, logout } = useAuth();
    const isAdmin = useMemo(() => {
        const role = (user?.role || user?.Role || '').toLowerCase();
        return ['admin', 'administrador', 'superadmin'].includes(role);
    }, [user]);
    const [currentClosure, setCurrentClosure] = useState<CashierClosure | null>(null);
    const [loading, setLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);

    // MODO EDICION: si llegamos con ?edit=:id desde el reporte de cierres,
    // cargamos el cierre historico y permitimos corregir sus valores.
    const searchParams = useSearchParams();
    const router = useRouter();
    const editId = searchParams?.get('edit') || null;
    const isEditMode = !!editId;
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
    const [isRealExpenseModalOpen, setIsRealExpenseModalOpen] = useState(false);
    const [isExpensesOpen, setIsExpensesOpen] = useState(false);

    // --- ESTADO CONFIRMACION EGRESOS ---
    const [isDeleteExpenseConfirmOpen, setIsDeleteExpenseConfirmOpen] = useState(false);
    const [expenseToDelete, setExpenseToDelete] = useState<number | null>(null);
    const [expenseToEdit, setExpenseToEdit] = useState<any>(null);

    const handleAdminVerify = async () => {
        setIsVerifying(true);
        setAuthError('');
        try {
            const response = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: adminUser, password: adminPass }),
            });

            if (!response.ok) throw new Error('Credenciales invalidas');

            const data = await response.json();
            const role = data.user.role?.toUpperCase();

            if (role === 'ADMIN' || role === 'SUPERADMIN') {
                setIsAuthorized(true);
                setAdminAuthorizer(data.user.name || data.user.username);
                toast({ title: 'AUTORIZACION CONCEDIDA', description: `Verificado por ${data.user.name}`, variant: 'default' });
            } else {
                throw new Error('El usuario no tiene permisos de administrador');
            }
        } catch (error: any) {
            setAuthError(error.message);
            toast({ title: 'ERROR DE AUTORIZACION', description: error.message, variant: 'destructive' });
        } finally {
            setIsVerifying(false);
        }
    };

    const { toast } = useToast();

    // Formulario interactivo derecho
    const [actualCashInput, setActualCashInput] = useState(() => {
        if (typeof window !== 'undefined') return localStorage.getItem('pos_closure_actual') || '';
        return '';
    });
    const [closingNote, setClosingNote] = useState(() => {
        if (typeof window !== 'undefined') return localStorage.getItem('pos_closure_note') || '';
        return '';
    });
    const [customStartDate, setCustomStartDate] = useState<string>('');
    const [customEndDate, setCustomEndDate] = useState<string>('');

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
        const defaultCoins = { '500/1000': '', '200': '', '100': '' };
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('pos_closure_coins');
            return saved ? JSON.parse(saved) : defaultCoins;
        }
        return defaultCoins;
    });

    // Persistence: Save to localStorage on change
    const [detailedReport, setDetailedReport] = useState<any>(null);
    const [isFetchingDetailed, setIsFetchingDetailed] = useState(false);
    const { isOpen: isDetailedOpen, onOpen: onDetailedOpen, onOpenChange: onDetailedOpenChange } = useDisclosure();

    const handleFetchDetailedReport = async () => {
        setIsFetchingDetailed(true);
        try {
            const token = Cookies.get('org-pos-token');
            const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/dashboard/detailed-report`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setDetailedReport(data);
                onDetailedOpen();
            } else {
                toast({ variant: "destructive", title: "ERROR", description: "No se pudo obtener el reporte detallado" });
            }
        } catch (error) {
            console.error("Error fetching detailed report:", error);
            toast({ variant: "destructive", title: "ERROR", description: "Fallo de conexion al servidor" });
        } finally {
            setIsFetchingDetailed(false);
        }
    };

    useEffect(() => {
        localStorage.setItem('pos_closure_bills', JSON.stringify(bills));
    }, [bills]);

    useEffect(() => {
        localStorage.setItem('pos_closure_coins', JSON.stringify(coins));
    }, [coins]);

    useEffect(() => {
        localStorage.setItem('pos_closure_actual', actualCashInput);
    }, [actualCashInput]);

    useEffect(() => {
        localStorage.setItem('pos_closure_note', closingNote);
    }, [closingNote]);



    const fetchCurrent = async () => {
        const token = Cookies.get('org-pos-token');
        if (!token) return;

        setLoading(true);
        try {
            // MODO EDICION: cargar cierre historico desde su detalle ampliado
            if (isEditMode && editId) {
                let c: any = null;

                // Intento principal: endpoint nuevo /full-detail (incluye ventas y egresos del turno)
                try {
                    const data = await apiFetch(`/dashboard/cashier-history/${editId}/full-detail`, { method: 'GET' }, token);
                    c = data?.closure || data;
                } catch (errFull) {
                    // Fallback: backend antiguo sin esa ruta. Cargamos toda la lista
                    // y filtramos el id en el cliente para no bloquear la edicion.
                    try {
                        const list = await apiFetch('/dashboard/cashier-history', { method: 'GET' }, token);
                        if (Array.isArray(list)) {
                            c = list.find((x: any) => String(x?.id) === String(editId)) || null;
                        }
                    } catch (errList) {
                        console.error('Fallback de carga de cierre fallo:', errList);
                    }
                }

                if (c) {
                    // Inferir valores legacy: cierres antiguos pueden tener
                    // totalCash/openingCash/expectedCash en 0 aunque physicalCash
                    // y totalSales si existan. Cuando un cierre ya esta cerrado,
                    // el "esperado" debe ser el "real" (ya cuadro en su dia).
                    const enriched: any = { ...c };
                    if (!enriched.expectedCash || enriched.expectedCash === 0) {
                        enriched.expectedCash = enriched.physicalCash || 0;
                    }
                    if (!enriched.totalCash || enriched.totalCash === 0) {
                        // Aproximacion: lo que entro en efectivo = lo fisico + egresos en efectivo - apertura
                        const cashOut = (enriched.totalExpenses || 0);
                        enriched.totalCash = Math.max(
                            0,
                            (enriched.physicalCash || 0) + cashOut - (enriched.openingCash || 0),
                        );
                    }

                    setCurrentClosure(enriched);

                    console.info('[ClosureEdit] Cierre cargado:', {
                        id: enriched.id,
                        physicalCash: enriched.physicalCash,
                        expectedCash: enriched.expectedCash,
                        totalCash: enriched.totalCash,
                        totalSales: enriched.totalSales,
                        totalExpenses: enriched.totalExpenses,
                    });

                    // Precargar arqueo fisico
                    if (enriched.physicalCash !== undefined) {
                        setActualCashInput(String(Math.round(enriched.physicalCash || 0)));
                    }

                    if (enriched.startDate) {
                        const sd = new Date(enriched.startDate);
                        sd.setMinutes(sd.getMinutes() - sd.getTimezoneOffset());
                        setCustomStartDate(sd.toISOString().slice(0, 16));
                    }
                    if (enriched.endDate) {
                        const ed = new Date(enriched.endDate);
                        ed.setMinutes(ed.getMinutes() - ed.getTimezoneOffset());
                        setCustomEndDate(ed.toISOString().slice(0, 16));
                    } else if (enriched.date) {
                        const ed = new Date(enriched.date);
                        ed.setMinutes(ed.getMinutes() - ed.getTimezoneOffset());
                        setCustomEndDate(ed.toISOString().slice(0, 16));
                    }

                    // Si existe el desglose exacto (nueva funcionalidad)
                    if (enriched.cashBreakdown) {
                        try {
                            const breakdown = JSON.parse(enriched.cashBreakdown);
                            if (breakdown.bills) setBills(breakdown.bills);
                            if (breakdown.coins) setCoins(breakdown.coins);
                        } catch (e) {
                            console.error("Error al parsear cashBreakdown:", e);
                        }
                    } else {
                        // Precargar grilla de monedas conocidas (legacy)
                        setCoins({
                            '500/1000': enriched.coins1000 ? String(enriched.coins1000) : '',
                            '200':      enriched.coins200  ? String(enriched.coins200)  : '',
                            '100':      enriched.coins100  ? String(enriched.coins100)  : '',
                        });
                    }

                    // Precargar nota / responsable visible
                    if (enriched.authorizedBy) {
                        setClosingNote(`Editando cierre #${enriched.id} — autorizado originalmente por ${enriched.authorizedBy}`);
                    } else {
                        setClosingNote(`Editando cierre #${enriched.id} — corrige los valores y guarda los cambios.`);
                    }

                    toast({
                        title: `EDITANDO CIERRE #${enriched.id}`,
                        description: 'Datos cargados del cierre historico. Corrige y guarda.',
                        variant: 'default'
                    });
                } else {
                    toast({
                        title: 'NO SE PUDO CARGAR EL CIERRE',
                        description: `El cierre #${editId} no se encontro. Verifica que el backend este actualizado.`,
                        variant: 'destructive',
                    });
                }
                return;
            }

            // MODO NORMAL: cargar el cierre EN VIVO del turno actual
            const data = await apiFetch('/dashboard/cashier-closure', { method: 'GET' }, token);
            setCurrentClosure(data);
        } catch (err: any) {
            console.error("Error al cargar cierre:", err);
            toast({ 
                variant: "destructive", 
                title: "Error de Auditoria", 
                description: err.message || "No se pudieron cargar los datos de la caja." 
            });
            setLoading(false);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchCurrent();
        const cleanup = setupSyncListener((event) => {
            if (event === 'CLOSURE_MADE' || event === 'EXPENSE_UPDATE' || event === 'DASHBOARD_UPDATE') {
                fetchCurrent();
            }
        });
        return cleanup;
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
        // y si la grilla tiene algun valor.
        if (hasUsedGrid) {
            const sumStr = sum.toString();
            if (actualCashInput !== sumStr) {
                setActualCashInput(sumStr);
            }
        }
    }, [bills, coins]);

    // Calculos dinamicos basados en la base de datos
    const efectivoEnCaja = (currentClosure?.totalCash ?? 0) + 
                          (currentClosure?.totalCreditCollected ?? 0) + 
                          (currentClosure?.openingCash ?? 0);

    const calculateCashFromExpense = (e: any) => {
        if (e.cashAmount !== undefined && e.cashAmount !== null && Number(e.cashAmount) > 0) {
            return Number(e.cashAmount);
        }
        const ps = String(e.paymentSource).toUpperCase();
        if (ps === 'EFECTIVO' || ps === 'CASH' || ps === 'CAJA') {
            return Number(e.amount) || 0;
        }
        if (ps.includes('CAJA:') || ps.includes('EFECTIVO:')) {
            const match = ps.match(/(?:CAJA|EFECTIVO):\s*\$?([\d,.]+)/);
            if (match && match[1]) {
                return Number(match[1].replace(/[^\d]/g, ''));
            }
        }
        return 0;
    };

    const dbCashExpensesPure = (currentClosure?.expenses || [])
        .filter((e: any) => String(e.category).toUpperCase() !== 'DEVOLUCIONES')
        .reduce((sum: number, e: any) => sum + calculateCashFromExpense(e), 0);

    const dbCashExpensesReturns = (currentClosure?.expenses || [])
        .filter((e: any) => String(e.category).toUpperCase() === 'DEVOLUCIONES')
        .reduce((sum: number, e: any) => sum + calculateCashFromExpense(e), 0);

    // 3. EGRESOS EN EFECTIVO (Solo lo que sale de la caja fisica)
    const totalEgresosEfectivo = dbCashExpensesPure;

    // Variables de apoyo para la UI
    const totalDevoluciones = dbCashExpensesReturns > 0 ? dbCashExpensesReturns : (currentClosure?.totalReturns ?? 0);
    const devolucionesCount = currentClosure?.returnsCount ?? 0;

    // 4. EFECTIVO ESPERADO (Entradas - Salidas)
    const theoreticalBalance = efectivoEnCaja - totalEgresosEfectivo - totalDevoluciones;
    const expectedCash = currentClosure?.expectedCash ?? Math.max(0, theoreticalBalance);
    
    const actualCash = parseFloat(actualCashInput) || 0;
    
    // Diferencia real: Dinero en mano - Dinero que deberia haber
    const difference = actualCash - expectedCash;

    const getStatus = () => {
        if (!actualCashInput && expectedCash > 0) return 'PENDING';
        if (difference === 0) return 'BALANCED';
        if (difference < 0) return 'SHORTAGE';
        return 'SURPLUS';
    };

    const status = getStatus();

    const handleCloseRegister = async () => {
        // En modo edicion no exigimos reautorizacion (el admin ya entro a /reports y edito)
        // Si hay faltante y NO esta autorizado Y NO es admin, abrir modal de admin
        if (!isEditMode && status === 'SHORTAGE' && !isAuthorized && !isAdmin) {
            setShowAuthModal(true);
            return;
        }


        // Nota: Ya no es obligatorio justificar porque el sistema requiere autorizacion administrativa directa.


        setIsSubmitting(true);
        const token = Cookies.get('org-pos-token');
        if (!token) return;

        const totalSalidasEfectivo = totalEgresosEfectivo;

        const totalBills = Object.entries(bills).reduce((acc, [val, qty]) => acc + (parseInt(val) * (parseInt(qty) || 0)), 0);
        const cCombined = parseInt(coins['500/1000'] || '0');
        const c200 = parseInt(coins['200'] || '0');
        const c100 = parseInt(coins['100'] || '0');

        const totalEgresosTotales = (currentClosure?.expenses || [])
            .filter((e: any) => String(e.status).toUpperCase() !== 'PENDING')
            .reduce((sum: number, e: any) => sum + Number(e.amount || 0) + Number(e.taxAmount || 0), 0);

        const closureData = {
            ...currentClosure,
            physicalCash: actualCash,
            difference: difference,
            closedByDni: user?.dni || 'S.N.',
            closedByName: user?.name || 'SOPORTE',
            authorizedBy: isAdmin ? (user?.name || 'ADMIN') : adminAuthorizer,

            totalExpenses: totalEgresosTotales,
            cashBills: totalBills,
            cashBreakdown: JSON.stringify({ bills, coins }),
            coins1000: cCombined,
            coins500: 0,
            coins200: c200,
            coins100: c100,
            expenses: [
                ...(currentClosure?.expenses || [])
            ]
        };

        try {
            // MODO EDICION: actualizar cierre historico con PUT
            if (isEditMode && editId) {
                // GORM Updates con map[string]interface{} usa los keys literalmente
                // como nombres de columna. Estos nombres deben coincidir con la BD:
                //   - physical_cash, total_nequi_real, total_daviplata_real son
                //     columnas explicitas declaradas con gorm:"column:..."
                //   - total_expenses, expected_cash, cash_bills, authorized_by son
                //     conversiones automaticas snake_case de TotalExpenses, etc.
                //   - coins100/200/1000 NO llevan underscore (GORM no separa entre
                //     letra y numero consecutivos)
                const updatePayload: any = {
                    physical_cash: actualCash,
                    expected_cash: currentClosure?.expectedCash || 0,
                    total_expenses: totalSalidasEfectivo,
                    total_nequi_real: currentClosure?.totalNequi || 0,
                    total_daviplata_real: currentClosure?.totalDaviplata || 0,
                    difference: difference,
                    coins100: c100,
                    coins200: c200,
                    coins1000: cCombined,
                    cash_bills: totalBills,
                    authorized_by: closureData.authorizedBy,
                    start_date: customStartDate ? customStartDate : undefined,
                    end_date: customEndDate ? customEndDate : undefined,
                    date: customEndDate ? customEndDate : undefined,
                };

                const res = await fetch(
                    `${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/dashboard/cashier-history/${editId}`,
                    {
                        method: 'PUT',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(updatePayload),
                    }
                );

                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    throw new Error(errData.userMessage || 'Error al actualizar el cierre');
                }

                toast({
                    title: `CIERRE #${editId} ACTUALIZADO`,
                    description: 'Los cambios se guardaron correctamente.',
                    variant: 'default',
                });

                broadcastRevalidate('CLOSURE_MADE');

                // Volver al historial de cierres en /reports
                setTimeout(() => router.push('/reports'), 1500);
                return;
            }

            // MODO NORMAL: cerrar caja (crear cierre nuevo)
            await apiFetch('/dashboard/cashier-closure/close', {
                method: 'POST',
                body: JSON.stringify(closureData),
                fallbackError: 'Error al procesar el cierre'
            }, token);

            toast({ title: "Caja Cerrada", description: "El cierre de caja ha sido exitoso. Sesion finalizada para cambio de turno.", variant: "default" });
            
            // LIMPIEZA AUTOMATICA TRAS EXITO
            confirmReset(); 

            // MEGA-SPRINT: Expulsion forzosa tras cierre de caja
            setTimeout(() => {
                logout();
            }, 2000); // Dar 2 segundos para leer el mensaje de exito
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
        const cCombined = parseInt(coins['500/1000'] || '0');
        const c200 = parseInt(coins['200'] || '0');
        const c100 = parseInt(coins['100'] || '0');

        const totalEgresosTotales = (currentClosure?.expenses || [])
            .filter((e: any) => String(e.status).toUpperCase() !== 'PENDING')
            .reduce((sum: number, e: any) => sum + Number(e.amount || 0) + Number(e.taxAmount || 0), 0);

        const closureData = {
            ...currentClosure,
            physicalCash: actualCash,
            difference: difference,
            closedByDni: user?.dni || 'S.N.',
            closedByName: user?.name || 'SOPORTE',
            totalExpenses: totalEgresosTotales,
            notes: closingNote,
            cashBills: totalBills,
            cashBreakdown: JSON.stringify({ bills, coins }),
            coins1000: cCombined,
            coins500: 0,
            coins200: c200,
            coins100: c100,
            expenses: [
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
        '100000': { label: '100k', color: 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 border-emerald-200 text-zinc-900 dark:text-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 dark:border-emerald-500/20 dark:text-zinc-300', iconColor: 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5' },
        '50000': { label: '50k', color: 'bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-500/5 dark:border-rose-500/20 dark:text-rose-400', iconColor: 'bg-rose-500' },
        '20000': { label: '20k', color: 'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-500/5 dark:border-amber-500/20 dark:text-amber-400', iconColor: 'bg-amber-500' },
        '10000': { label: '10k', color: 'bg-red-50 border-red-200 text-red-700 dark:bg-red-500/5 dark:border-red-500/20 dark:text-red-400', iconColor: 'bg-red-500' },
        '5000': { label: '5k', color: 'bg-blue-50 border-blue-200 text-blue-700 dark:bg-blue-500/5 dark:border-blue-500/20 dark:text-blue-400', iconColor: 'bg-blue-500' },
        '2000': { label: '2k', color: 'bg-cyan-50 border-cyan-200 text-cyan-700 dark:bg-cyan-500/5 dark:border-cyan-500/20 dark:text-cyan-400', iconColor: 'bg-cyan-500' },
    };

    const coinConfigs = {
        '500/1000': { label: '500/1000', color: 'bg-gray-100 border-gray-200 text-gray-700 dark:bg-[#18181b] dark:border-zinc-500 dark:text-zinc-300' },
        '200': { label: '200', color: 'bg-gray-100 border-gray-200 text-gray-700 dark:bg-[#18181b] dark:border-zinc-600 dark:text-zinc-400' },
        '100': { label: '100', color: 'bg-gray-100 border-gray-200 text-gray-700 dark:bg-[#18181b] dark:border-zinc-700 dark:text-zinc-500' },
    };

    const resetCalculator = () => {
        onResetOpen();
    };

    const confirmReset = () => {
        setBills({ '100000': '', '50000': '', '20000': '', '10000': '', '5000': '', '2000': '' });
        setCoins({ '500/1000': '', '200': '', '100': '' });
        setActualCashInput('');
        localStorage.removeItem('pos_closure_bills');
        localStorage.removeItem('pos_closure_coins');
        localStorage.removeItem('pos_closure_actual');
        localStorage.removeItem('pos_closure_salary');
        localStorage.removeItem('pos_closure_operational');
        localStorage.removeItem('pos_closure_note');
    };

    const handleSaveRealExpense = async (data: any) => {
        const token = Cookies.get('org-pos-token');
        if (!token) return;

        try {
            const payload = {
                description: data.description.toUpperCase(),
                amount: Math.abs(parseFloat(String(data.amount)) || 0),
                date: expenseToEdit ? expenseToEdit.date : new Date().toISOString(),
                paymentSource: data.paymentSource || 'EFECTIVO',
                category: data.category,
                status: data.status || 'PAID',
                supplierId: data.category === 'Proveedores' && data.supplierId ? Number(data.supplierId) : null,
            };

            if (expenseToEdit) {
                await apiFetch(`/expenses/update/${expenseToEdit.id}`, {
                    method: 'PUT',
                    body: JSON.stringify(payload),
                    fallbackError: 'FALLO AL ACTUALIZAR EGRESO'
                }, token);
                toast({ variant: "success", title: "ÉXITO", description: "EGRESO ACTUALIZADO EN LA BASE DE DATOS" });
            } else {
                await apiFetch('/expenses/create', {
                    method: 'POST',
                    body: JSON.stringify(payload),
                    fallbackError: 'FALLO AL REGISTRAR EGRESO'
                }, token);
                toast({ variant: "success", title: "ÉXITO", description: "EGRESO REGISTRADO EN LA BASE DE DATOS" });
            }

            const { broadcastRevalidate } = await import('@/lib/revalidate');
            broadcastRevalidate('EXPENSE_UPDATE');
            setIsRealExpenseModalOpen(false);
            setExpenseToEdit(null);
            fetchCurrent(); // Refrescar auditoria para ver el nuevo gasto
        } catch (err: any) {
            toast({ variant: "destructive", title: "ERROR", description: err.message });
        }
    };

    const handleDeleteDBExpense = async (id: number) => {
        setExpenseToDelete(id);
        setIsDeleteExpenseConfirmOpen(true);
    };

    const handleEditDBExpense = (exp: any) => {
        setExpenseToEdit(exp);
        setIsRealExpenseModalOpen(true);
    };

    const confirmDeleteExpense = async () => {
        if (!expenseToDelete) return;
        const token = Cookies.get('org-pos-token');
        if (!token) return;

        try {
            await apiFetch(`/expenses/delete/${expenseToDelete}`, {
                method: 'DELETE',
                fallbackError: 'FALLO AL ELIMINAR EGRESO'
            }, token);

            toast({ variant: "success", title: "EGRESO ELIMINADO", description: "SE HA REMOVIDO EL REGISTRO DE LA BASE DE DATOS" });
            broadcastRevalidate('EXPENSE_UPDATE');
            fetchCurrent();
        } catch (err: any) {
            toast({ variant: "destructive", title: "ERROR", description: err.message });
        } finally {
            setExpenseToDelete(null);
        }
    };




    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 bg-gray-50 dark:bg-zinc-950 text-zinc-900 dark:text-white rounded-[2rem] border border-black/5 dark:border-white/5 m-2 md:m-4">
                <Skeleton className="h-12 w-12 rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
                <p className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-100 uppercase tracking-widest animate-pulse">Sincronizando Auditoria...</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col w-full bg-gray-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50 p-1 md:p-3 pt-0 md:pt-0 gap-3 md:gap-4 pb-10">


            {/* BANNER DE MODO EDICION */}
            {isEditMode && (
                <div className="bg-blue-500/10 border border-blue-500/30 rounded-2xl px-4 py-3 flex items-center justify-between gap-4 mx-2">
                    <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded-2xl bg-blue-500/20 text-blue-500 flex items-center justify-center shrink-0">
                            <RefreshCw size={16} />
                        </div>
                        <div className="flex flex-col">
                            <span className="text-[11px] font-bold text-blue-500 uppercase tracking-tighter">Modo Edicion — Cierre #{editId}</span>
                            <span className="text-[9px] font-medium text-blue-500/80 uppercase tracking-widest">Estas corrigiendo un cierre historico. Al guardar se actualizara el registro.</span>
                        </div>
                    </div>
                    <Button
                        size="sm"
                        variant="flat"
                        onPress={() => router.push('/reports')}
                        className="bg-blue-500/10 text-blue-500 font-medium uppercase text-[9px] tracking-widest rounded-xl"
                        startContent={<ArrowLeft size={12} />}
                    >
                        Volver
                    </Button>
                </div>
            )}


            {/* HEADER COMPACTO */}
            <div className="flex items-center justify-between shrink-0 px-2">
                <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 flex items-center justify-center shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                        <Calculator className="text-zinc-950" size={24} />
                    </div>
                    <div>
                        <h1 className="text-lg font-medium uppercase tracking-tighter">Cierre de Caja</h1>
                        <p className="text-[10px] text-gray-500 dark:text-zinc-500 font-bold uppercase tracking-widest flex items-center gap-2">
                            {currentClosure ? (
                                <>
                                    <span className="text-zinc-900 dark:text-zinc-100 dark:text-zinc-100 flex items-center gap-1">
                                        <TrendingUp size={10} /> INICIO: {formatShortDateTime(currentClosure.startDate)}
                                    </span>
                                    <span className="text-gray-300 dark:text-zinc-700">|</span>
                                    <span className="text-rose-700 dark:text-rose-500 flex items-center gap-1">
                                        <TrendingDown size={10} /> CIERRE: {formatShortDateTime(currentClosure.endDate)}
                                    </span>
                                </>
                            ) : 'Auditoria en Tiempo Real'}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Button 
                        variant="flat"
                        onPress={fetchCurrent}
                        className="bg-zinc-100 dark:bg-zinc-800 text-white font-medium text-[10px] uppercase tracking-widest px-3 md:px-4 min-w-0"
                        startContent={<RefreshCw size={14} className={loading ? 'animate-spin' : ''} />}
                    >
                        <span className="hidden md:inline">Sincronizar Datos</span>
                    </Button>

                </div>

            </div>

            {/* CONTENEDOR PRINCIPAL */}
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-3 md:gap-4 flex-1 lg:min-h-0 lg:overflow-hidden px-1">
                {/* BLOQUE IZQUIERDO: AUDITORIA Y EGRESOS */}
                <div className="flex-1 flex flex-col lg:min-h-0 gap-4 lg:overflow-y-auto scrollbar-hide">
                    
                    {/* 1. BALANCE TICKET (SIEMPRE VISIBLE) */}
                    <section className="shrink-0 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 rounded-2xl border border-gray-200 dark:border-emerald-500/10 p-4 md:p-8 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                        <div className="flex flex-col items-center justify-center relative z-10">
                            <span className="text-[10px] font-bold text-gray-500 dark:text-zinc-400 uppercase tracking-wider mb-2">
                                {theoreticalBalance < 0 ? 'Deficit de Operacion (Ventas < Gastos)' : 'Efectivo Final Esperado'}
                            </span>
                            <span className={`text-5xl md:text-7xl font-medium tabular-nums tracking-tighter drop-shadow-[0_8px_30px_rgb(0,0,0,0.12)] ${theoreticalBalance < 0 ? 'text-rose-500' : 'text-zinc-900 dark:text-zinc-50'}`}>
                                $<RollingDigits value={Math.round(expectedCash || 0)} format={(n) => formatCurrency(n)} duration={1.6} />
                            </span>
                        </div>
                        <div className="flex flex-col gap-1 md:gap-2 mt-6 max-w-md mx-auto">
                            <div className="flex items-center justify-between py-1 border-b border-gray-200 dark:border-emerald-500/10">
                                <span className="text-[9px] font-bold text-gray-600 dark:text-zinc-500 uppercase tracking-widest">Entradas Efectivo</span>
                                <span className="text-md font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-100">+<RollingDigits value={Math.round(efectivoEnCaja || 0)} format={(n) => formatCurrency(n)} duration={1.4} /></span>
                            </div>
                            <div className="flex items-center justify-between py-1 border-b border-gray-200 dark:border-emerald-500/10">
                                <span className="text-[9px] font-bold text-rose-700 dark:text-rose-500/60 uppercase tracking-widest">Salidas Egresos</span>
                                <span className="text-md font-medium text-rose-700 dark:text-rose-500">-<RollingDigits value={Math.round(totalEgresosEfectivo || 0)} format={(n) => formatCurrency(n)} duration={1.4} /></span>
                            </div>
                            <div className="flex items-center justify-between py-1 border-b border-gray-200 dark:border-emerald-500/10">
                                <span className="text-[9px] font-bold text-rose-700 dark:text-rose-500/60 uppercase tracking-widest">Salidas Devoluciones</span>
                                <span className="text-md font-medium text-rose-700 dark:text-rose-500">-<RollingDigits value={Math.round(totalDevoluciones || 0)} format={(n) => formatCurrency(n)} duration={1.4} /></span>
                            </div>
                        </div>
                    </section>

                    {/* 2. EGRESOS DEL TURNO (SIEMPRE VISIBLE PARA PERMITIR CUADRE) */}
                    <section className="card-base border-none/40 border border-gray-200 dark:border-white/5 rounded-2xl p-4 md:p-6 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                        <div className="flex items-center justify-between border-b border-gray-200 dark:border-white/5 pb-2 mb-4">
                            <div 
                                className="flex items-center gap-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-zinc-800 p-2 -ml-2 rounded-lg transition-colors select-none"
                                onClick={() => setIsExpensesOpen(!isExpensesOpen)}
                            >
                                <TrendingDown size={14} className="text-rose-700 dark:text-rose-500" />
                                <h3 className="text-[10px] font-bold text-gray-800 dark:text-zinc-400 uppercase tracking-wider">Registrar Egresos de Hoy</h3>
                                {isExpensesOpen ? <ChevronUp size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
                            </div>
                            <div className="flex flex-wrap gap-2">
                                <Button 
                                    size="sm" 
                                    variant="solid" 
                                    onPress={() => setIsRealExpenseModalOpen(true)}
                                    className="h-10 text-[10px] font-medium uppercase tracking-widest bg-rose-600 text-white rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/20 px-6 transition-all active:scale-95"
                                    startContent={<ReceiptText size={16} />}
                                >
                                    REGISTRAR EGRESO GENERAL
                                </Button>
                            </div>
                        </div>

                        {isExpensesOpen && (
                            <div className="space-y-3">
                                {/* HISTORIAL DE EGRESOS YA GUARDADOS */}
                                {currentClosure?.expenses?.map((exp, idx) => (
                                    <div key={idx} className="flex items-center justify-between p-3 rounded-2xl bg-gray-50 dark:bg-white/[0.02] border border-gray-200 dark:border-white/5">
                                        <div className="flex flex-col">
                                            <span className="text-[9px] font-medium text-gray-400 uppercase">{exp.category}</span>
                                            <span className="text-xs font-bold text-zinc-900 dark:text-zinc-50 uppercase">{exp.description}</span>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <div className="text-right">
                                                <span className="text-sm font-medium text-rose-700 dark:text-rose-500">-${formatCurrency(exp.amount)}</span>
                                                <div className="text-[9px] text-gray-500 dark:text-zinc-600 font-bold uppercase">{exp.paymentSource}</div>
                                            </div>
                                            {isAdmin && (
                                                <div className="flex items-center gap-1">
                                                    <Button 
                                                        isIconOnly 
                                                        size="sm" 
                                                        variant="light" 
                                                        onPress={() => handleEditDBExpense(exp)}
                                                        className="text-blue-500 hover:bg-blue-500/10 rounded-2xl"
                                                    >
                                                        <Pen size={14} />
                                                    </Button>
                                                    <Button 
                                                        isIconOnly 
                                                        size="sm" 
                                                        variant="light" 
                                                        onPress={() => handleDeleteDBExpense(exp.id)}
                                                        className="text-rose-500 hover:bg-rose-500/10 rounded-2xl"
                                                    >
                                                        <Trash2 size={14} />
                                                    </Button>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>

                    {/* 3. AUDITORIA DETALLADA (SOLO ADMIN) */}
                    {isAdmin ? (
                        <div className="space-y-6 animate-in fade-in slide-in-from-top-4 duration-500">
                            {/* INGRESOS DIGITALES */}
                            <section className="space-y-2">
                                <div className="flex items-center gap-2 border-b border-gray-200 dark:border-white/5 pb-1">
                                    <CreditCard size={12} className="text-blue-700 dark:text-blue-500" />
                                    <h3 className="text-[9px] font-bold text-gray-800 dark:text-zinc-400 uppercase tracking-wider">Digitales</h3>
                                </div>
                                <div className="grid grid-cols-3 gap-2">
                                    <div className="p-4 rounded-2xl bg-blue-50 dark:bg-blue-500/5 border border-blue-200 dark:border-blue-500/10 flex flex-col gap-1 items-center text-center">
                                        <span className="text-[9px] font-medium text-blue-700 dark:text-blue-400 uppercase">Nequi</span>
                                        <span className="text-lg font-medium text-blue-800 dark:text-white">$<RollingDigits value={Math.round(currentClosure?.totalNequi ?? 0)} format={(n) => formatCurrency(n)} duration={1.4} /></span>
                                    </div>
                                    <div className="p-4 rounded-2xl bg-purple-50 dark:bg-purple-500/5 border border-purple-200 dark:border-purple-500/10 flex flex-col gap-1 items-center text-center">
                                        <span className="text-[9px] font-medium text-purple-700 dark:text-purple-400 uppercase">Daviplata</span>
                                        <span className="text-lg font-medium text-purple-800 dark:text-white">$<RollingDigits value={Math.round(currentClosure?.totalDaviplata ?? 0)} format={(n) => formatCurrency(n)} duration={1.4} /></span>
                                    </div>
                                    <div className="p-4 rounded-2xl bg-gray-100 dark:bg-zinc-500/5 border border-gray-200 dark:border-zinc-500/10 flex flex-col gap-1 items-center text-center">
                                        <span className="text-[9px] font-medium text-gray-600 dark:text-zinc-500 uppercase">Otros</span>
                                        <span className="text-lg font-medium text-zinc-900 dark:text-zinc-50">$<RollingDigits value={Math.round((currentClosure?.totalBancolombia ?? 0) + (currentClosure?.totalOtherTransfer ?? 0))} format={(n) => formatCurrency(n)} duration={1.4} /></span>
                                    </div>
                                </div>
                            </section>

                            {/* FIADOS Y ABONOS */}
                            <section className="space-y-4">
                                <div className="flex items-center gap-2 border-b border-gray-200 dark:border-white/5 pb-2">
                                    <Briefcase size={14} className="text-gray-500 dark:text-zinc-500" />
                                    <h3 className="text-[10px] font-bold text-gray-800 dark:text-zinc-400 uppercase tracking-wider">Creditos y Abonos</h3>
                                </div>
                                <div className="card-base border-none/40 border border-gray-200 dark:border-white/10 rounded-2xl p-4 md:p-6">
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                        <div className="space-y-2">
                                            <span className="text-[10px] font-bold text-blue-700 dark:text-blue-400 uppercase tracking-wider">Fiados Emitidos (${formatCurrency(currentClosure?.totalCreditIssued ?? 0)})</span>
                                            <div className="space-y-1">
                                                {currentClosure?.creditsIssued?.map((sale, idx) => (
                                                    <div key={idx} className="flex items-center justify-between text-[10px] py-2 border-b border-gray-200 dark:border-white/5">
                                                        <div className="flex flex-col">
                                                            <span className="text-gray-500 dark:text-zinc-500 font-bold uppercase truncate max-w-[120px]">{sale.client?.name || 'Cliente'}</span>
                                                            {sale.client && <span className="text-gray-400 dark:text-zinc-600 font-medium uppercase tracking-widest text-[8px]">Deuda Actual: ${formatCurrency(sale.client.currentCredit)}</span>}
                                                        </div>
                                                        <div className="flex flex-col items-end">
                                                            <span className="text-[8px] font-bold uppercase text-blue-700/60 dark:text-blue-400/60 tracking-widest">Fiado Hoy</span>
                                                            <span className="text-blue-700 dark:text-blue-400 font-medium">${formatCurrency(sale.creditAmount)}</span>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                        <div className="space-y-2">
                                            <span className="text-[10px] font-bold text-zinc-900 dark:text-zinc-100 dark:text-zinc-300 uppercase tracking-wider">Abonos Recibidos (${formatCurrency(currentClosure?.totalCreditCollected ?? 0)})</span>
                                            <div className="space-y-1">
                                                {currentClosure?.creditPayments?.map((p, idx) => (
                                                    <div key={idx} className="flex items-center justify-between text-[10px] py-2 border-b border-gray-200 dark:border-white/5">
                                                        <div className="flex flex-col">
                                                            <span className="text-gray-500 dark:text-zinc-500 font-bold uppercase truncate max-w-[120px]">{p.client?.name || 'Cliente'}</span>
                                                            {p.client && <span className="text-gray-400 dark:text-zinc-600 font-medium uppercase tracking-widest text-[8px]">Deuda Actual: ${formatCurrency(p.client.currentCredit)}</span>}
                                                        </div>
                                                        <div className="flex flex-col items-end">
                                                            <span className="text-[8px] font-bold uppercase text-gray-500 dark:text-zinc-500/60 dark:text-zinc-400/60 tracking-widest">Abono Hoy</span>
                                                            <span className="text-zinc-900 dark:text-zinc-100 dark:text-zinc-300 font-medium">${formatCurrency(p.totalPaid)}</span>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </section>
                        </div>
                    ) : (
                        <div className="p-6 card-base border-none/40 border border-gray-200 dark:border-white/5 rounded-2xl text-center">
                            <Lock size={20} className="mx-auto text-gray-500 dark:text-zinc-500 dark:text-zinc-400 mb-2" />
                            <p className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest">Auditoria de Ventas restringida a Administradores</p>
                        </div>
                    )}
                </div>

                {/* BLOQUE DERECHO: INTERACCION CAJERO (SCROLLABLE) */}
                <div className="bg-white border border-gray-200 dark:bg-[#18181b]/60 dark:border-white/5 rounded-2xl p-5 md:p-6 flex flex-col gap-4 shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.12)] relative overflow-hidden">
                    
                    <div className="flex-1 flex flex-col gap-6">
                        {isEditMode && (
                            <div className="flex flex-col gap-2 bg-blue-500/5 p-4 rounded-2xl border border-blue-500/20">
                                <span className="text-[10px] font-bold text-blue-500 uppercase tracking-widest">Periodo del Cierre (Inicio - Fin)</span>
                                <div className="grid grid-cols-2 gap-2">
                                    <Input
                                        type="datetime-local"
                                        variant="bordered"
                                        value={customStartDate}
                                        onValueChange={setCustomStartDate}
                                        classNames={{
                                            inputWrapper: "h-10 border-blue-500/30",
                                            input: "text-zinc-900 dark:text-zinc-100 uppercase text-xs"
                                        }}
                                    />
                                    <Input
                                        type="datetime-local"
                                        variant="bordered"
                                        value={customEndDate}
                                        onValueChange={setCustomEndDate}
                                        classNames={{
                                            inputWrapper: "h-10 border-blue-500/30",
                                            input: "text-zinc-900 dark:text-zinc-100 uppercase text-xs"
                                        }}
                                    />
                                </div>
                                <span className="text-[9px] text-blue-500/70 font-medium tracking-tight">
                                    Modifica estas fechas/horas para que el sistema recalcule las ventas y egresos de este turno.
                                </span>
                            </div>
                        )}
                        <div className="flex flex-col gap-4">
                            <div className="flex items-center gap-2 px-1">
                                <div className="h-4 w-1 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 rounded-2xl" />
                                <h4 className="text-[10px] font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-[0.2em]">Conteo de Efectivo</h4>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                {Object.entries(billConfigs).map(([val, config]) => (
                                    <div key={val} className={`flex items-center gap-2 p-2 rounded-2xl border transition-all duration-300 ${config.color}`}>
                                        <div className={`h-6 w-6 rounded-2xl ${config.iconColor} flex items-center justify-center text-[10px] font-medium text-zinc-950 shrink-0`}>
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
                                                input: "font-medium text-right text-xs text-zinc-900 dark:text-zinc-50 pr-1"
                                            }}
                                        />
                                    </div>
                                ))}
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                                {Object.entries(coinConfigs).map(([val, config]) => (
                                    <div key={val} className={`flex flex-col gap-1 p-2 rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-zinc-950/40 shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-none`}>
                                        <span className="text-[8px] font-bold text-gray-600 dark:text-zinc-500 uppercase text-center">{config.label}</span>
                                        <Input
                                            type="text"
                                            placeholder="0"
                                            variant="underlined"
                                            value={coins[val as keyof typeof coins] ? formatCurrency(sanitizeNumber(coins[val as keyof typeof coins]).toString()) : ''}
                                            onValueChange={(v) => setCoins({ ...coins, [val]: sanitizeNumber(v).toString() })}
                                            classNames={{
                                                inputWrapper: "h-7 bg-transparent border-none p-0 min-h-unit-0",
                                                input: "font-medium text-right text-xs text-gray-900 dark:text-zinc-300 pr-1"
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
                                    <div className="h-4 w-1 bg-amber-500 rounded-2xl" />
                                    <h4 className="text-[10px] font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-[0.2em]">Total Manual</h4>
                                </div>
                                <Button 
                                    size="sm" 
                                    variant="bordered" 
                                    onPress={resetCalculator} 
                                    className="font-medium text-[9px] uppercase tracking-[0.2em] px-4 h-9 border-rose-500/30 text-rose-500 hover:bg-rose-500 hover:text-white transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/5 rounded-2xl"
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
                                    input: "text-3xl font-medium text-center text-zinc-900 dark:text-zinc-50 font-mono",
                                    inputWrapper: "bg-gray-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 border-2 border-gray-200 dark:border-emerald-500/30 h-20 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.12)]"
                                }}
                            />
                        </div>
                    </div>

                    {/* FOOTER DE ACCION */}
                    <div className="shrink-0 pt-2 flex flex-col gap-3 border-t border-black/5 dark:border-white/5">
                        <div className={`flex items-center justify-between p-4 rounded-2xl border transition-all duration-500 ${
                            status === 'BALANCED' ? 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 border-emerald-200 text-zinc-900 dark:text-zinc-100 dark:bg-white/5 dark:border-emerald-500/20 dark:text-zinc-100' :
                            status === 'SHORTAGE' ? 'bg-rose-100 border-rose-300 text-rose-800 dark:bg-rose-500/10 dark:border-rose-500/20 dark:text-rose-500' :
                            'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 border-emerald-300 text-zinc-900 dark:text-zinc-100 dark:bg-white/5 dark:border-emerald-500/20 dark:text-zinc-100'
                        }`}>
                            <div className="flex flex-col">
                                <span className="text-[10px] font-medium uppercase tracking-[0.2em] opacity-60">Situacion de Caja</span>
                                <span className="text-sm font-medium uppercase flex items-center gap-2">
                                    {status === 'PENDING' ? 'ESPERANDO CONTEO' : 
                                     status === 'BALANCED' ? 'CAJA CUADRADA' : 
                                     status === 'SHORTAGE' ? 'FALTANTE' : 'SOBRANTE'}
                                </span>
                            </div>
                            <span className="text-xl font-medium font-mono">${formatCurrency(Math.abs(difference))}</span>
                        </div>

                        {isAuthorized && adminAuthorizer && (
                            <div className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 dark:bg-white/5 border border-emerald-200 dark:border-emerald-500/30 p-3 rounded-2xl flex items-center gap-3">
                                <ShieldCheck className="text-zinc-900 dark:text-zinc-100 dark:text-zinc-100" size={16} />
                                <span className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-100 uppercase tracking-tighter">Autorizado por: {adminAuthorizer}</span>
                            </div>
                        )}

                        <div className="flex gap-2">
                            <Button
                                onPress={handleSendPartial}
                                isLoading={isSendingPartial}
                                variant="bordered"
                                className="h-16 rounded-2xl border-gray-200 dark:border-white/10 font-medium text-gray-400 dark:text-zinc-400 uppercase tracking-widest text-[10px] hover:bg-gray-50 dark:hover:bg-[#18181b]"
                            >
                                <Send size={14} className="mr-1" />
                                Parcial (SMS)
                            </Button>
                            <Button
                                onPress={handleFetchDetailedReport}
                                isLoading={isFetchingDetailed}
                                variant="bordered"
                                className="h-16 rounded-2xl border-gray-200 dark:border-white/10 font-medium text-gray-400 dark:text-zinc-400 uppercase tracking-widest text-[10px] hover:bg-gray-50 dark:hover:bg-[#18181b]"
                            >
                                <ReceiptText size={14} className="mr-1" />
                                Detallado
                            </Button>
                            <Button
                                onPress={handleCloseRegister}
                                isDisabled={status === 'PENDING' || isSubmitting}
                                className={`flex-1 h-16 rounded-2xl font-medium text-xl uppercase tracking-widest tracking-tight shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all ${
                                    isEditMode ? 'bg-blue-600 hover:bg-blue-500 shadow-blue-500/30' :
                                    (status === 'SHORTAGE' && !isAuthorized && !isAdmin) ? 'bg-rose-600 hover:bg-rose-500' : 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 hover:bg-zinc-50 dark:hover:bg-white/5 bg-white dark:bg-transparent border border-zinc-200 dark:border-white/5'
                                } text-white`}
                            >
                                {isSubmitting ? 'PROCESANDO...' :
                                 isEditMode ? `GUARDAR CAMBIOS #${editId}` :
                                 (status === 'SHORTAGE' && !isAuthorized && !isAdmin) ? 'AUTORIZAR' : 'CERRAR CAJA'}
                            </Button>

                        </div>
                    </div>
                </div>
            </div>

            {/* MODAL DE AUTORIZACION (DISEÑO ULTRA-PREMIUM) */}
            <Modal 
                isOpen={showAuthModal} 
                onOpenChange={setShowAuthModal} 
                backdrop="blur" 
                placement="center"
                classNames={{
                    base: "card-base border-none/60  border border-black/10 dark:border-white/10 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-black/40 max-w-md mx-4",
                    header: "border-none pt-8 px-8",
                    body: "py-2 px-8",
                    footer: "border-none pb-8 px-8 gap-4",
                    closeButton: "hover:bg-black/5 dark:hover:bg-[#18181b] active:bg-black/10 dark:active:bg-zinc-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-500 dark:text-zinc-400 transition-colors right-4 top-4"
                }}
            >
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader>
                                <div className="flex items-center gap-6">
                                    <div className="h-14 w-14 rounded-2xl bg-rose-50 dark:bg-rose-500/10 flex items-center justify-center border border-rose-600/20 dark:border-rose-500/20 shadow-[0_0_20px_rgba(225,29,72,0.1)]">
                                        <Lock size={28} className="text-rose-600 dark:text-rose-500 drop-shadow-[0_0_8px_rgba(225,29,72,0.5)]" />
                                    </div>
                                    <div>
                                        <span className="text-rose-600 dark:text-rose-500 text-[10px] font-medium uppercase tracking-[0.3em] block mb-1">SEGURIDAD</span>
                                        <h2 className="text-xl font-medium text-zinc-900 dark:text-white uppercase tracking-wider leading-none">AUTORIZAR</h2>
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
                                            label: "text-gray-500 dark:text-zinc-500 font-bold text-[10px] tracking-widest", 
                                            inputWrapper: "border-black/10 dark:border-white/10 bg-black/5 dark:bg-[#18181b] rounded-2xl h-14",
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
                                            label: "text-gray-500 dark:text-zinc-500 font-bold text-[10px] tracking-widest", 
                                            inputWrapper: "border-black/10 dark:border-white/10 bg-black/5 dark:bg-[#18181b] rounded-2xl h-14",
                                            input: "font-bold text-zinc-900 dark:text-white"
                                        }} 
                                    />
                                    {authError && (
                                        <div className="bg-rose-50 dark:bg-rose-500/10 border border-rose-600/20 dark:border-rose-500/20 p-2 rounded-2xl">
                                            <p className="text-[10px] text-rose-600 dark:text-rose-500 font-bold uppercase text-center tracking-widest">{authError}</p>
                                        </div>
                                    )}
                                </div>
                            </ModalBody>
                            <ModalFooter>
                                <Button 
                                    onPress={handleAdminVerify} 
                                    isLoading={isVerifying} 
                                    className="w-full bg-rose-600 hover:bg-rose-500 text-white font-medium text-xs uppercase tracking-[0.2em] h-14 rounded-2xl transition-all duration-300 shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/20 active:scale-95 mt-2"
                                >
                                    VERIFICAR CREDENCIALES
                                </Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>

            {/* MODAL DE CONFIRMACION DE REINICIO (DISEÑO ULTRA-PREMIUM) */}
            <Modal 
                isOpen={isResetOpen} 
                onOpenChange={onResetOpenChange}
                backdrop="blur"
                placement="center"
                hideCloseButton={false}
                classNames={{
                    base: "bg-[#18181b]/60  border border-zinc-200 dark:border-white/10 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-black/40 max-w-md mx-4",
                    header: "border-none pt-8 px-8",
                    body: "py-2 px-8",
                    footer: "border-none pb-8 px-8 gap-4",
                    closeButton: "hover:bg-[#18181b] active:bg-zinc-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-500 dark:text-zinc-400 transition-colors right-4 top-4"
                }}

            >
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader>
                                <div className="flex items-center gap-6">
                                    <div className="h-14 w-14 rounded-2xl bg-rose-500/10 flex items-center justify-center border border-rose-500/20 shadow-[0_0_20px_rgba(225,29,72,0.1)]">
                                        <AlertTriangle size={28} className="text-rose-500 drop-shadow-[0_0_8px_rgba(225,29,72,0.5)]" />
                                    </div>
                                    <h2 className="text-xl font-medium text-white uppercase tracking-wider">¿BORRAR CONTEO?</h2>
                                </div>
                            </ModalHeader>
                            <ModalBody>
                                <div className="space-y-4">
                                    <p className="text-[11px] font-bold text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest leading-relaxed">
                                        ESTAS A PUNTO DE BORRAR TODOS LOS BILLETES Y MONEDAS QUE HAS INGRESADO. 
                                        <span className="block mt-2 text-rose-500/80">ESTA ACCION NO SE PUEDE DESHACER.</span>
                                    </p>
                                </div>
                            </ModalBody>
                            <ModalFooter className="justify-end">
                                <Button 
                                    variant="light" 
                                    onPress={onClose}
                                    className="font-medium text-xs uppercase tracking-widest text-gray-500 dark:text-zinc-500 hover:text-white transition-all px-6 h-12"
                                >
                                    CANCELAR
                                </Button>
                                <Button 
                                    onPress={() => { confirmReset(); onClose(); }}
                                    className="bg-rose-600 hover:bg-rose-500 text-white font-medium text-xs uppercase tracking-[0.1em] px-10 h-12 rounded-2xl transition-all duration-300 shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/20 active:scale-95"
                                >
                                    SI, BORRAR TODO
                                </Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>

            <ExpenseFormModal 
                isOpen={isRealExpenseModalOpen}
                onClose={() => {
                    setIsRealExpenseModalOpen(false);
                    setExpenseToEdit(null);
                }}
                isEdit={!!expenseToEdit}
                initialExpense={expenseToEdit}
                onSave={handleSaveRealExpense}
            />

            <ConfirmDialog 
                isOpen={isDeleteExpenseConfirmOpen}
                onOpenChange={setIsDeleteExpenseConfirmOpen}
                title="Eliminar Egreso"
                description="¿ESTAS SEGURO DE ELIMINAR ESTE EGRESO DE LA BASE DE DATOS? ESTA ACCION NO SE PUEDE DESHACER."
                onConfirm={confirmDeleteExpense}
                type="danger"
                confirmText="SI, ELIMINAR"
            />

            {/* MODAL REPORTE DETALLADO (TICKET TERMICO) */}
            <Modal 
                isOpen={isDetailedOpen} 
                onOpenChange={onDetailedOpenChange}
                size="md"
                scrollBehavior="inside"
                backdrop="blur"
            >
                <ModalContent className="card-base border-none">
                    {(onClose) => (
                        <>
                            <ModalHeader className="flex flex-col gap-1">
                                <span className="text-xl font-medium tracking-tight uppercase tracking-tighter text-zinc-900 dark:text-white">Reporte Detallado de Turno</span>
                                <span className="text-[10px] text-gray-500 dark:text-zinc-500 uppercase font-medium">Control de Auditoria Interna</span>
                            </ModalHeader>
                            <ModalBody>
                                <div className="bg-white p-6 rounded-2xl border-2 border-dashed border-zinc-200 font-mono text-zinc-900">
                                    <div className="text-center mb-6 space-y-1">
                                        <h2 className="text-lg font-medium uppercase tracking-tight">POS PRO</h2>
                                        <p className="text-[10px] uppercase font-medium text-gray-500 dark:text-zinc-500">Comprobante de Movimientos</p>
                                        <div className="h-px bg-zinc-200 my-2" />
                                        <p className="text-[9px] uppercase">Cajero: {detailedReport?.employee || '---'}</p>
                                        <p className="text-[9px] uppercase">Inicio: {detailedReport?.startTime ? formatDateTime(detailedReport.startTime) : '---'}</p>
                                        <p className="text-[9px] uppercase">Corte: {detailedReport?.endTime ? formatDateTime(detailedReport.endTime) : '---'}</p>
                                    </div>

                                    <div className="space-y-3">
                                        <div className="grid grid-cols-4 text-[9px] font-medium uppercase border-b border-zinc-200 pb-2">
                                            <div className="col-span-1">HORA</div>
                                            <div className="col-span-1">TIPO</div>
                                            <div className="col-span-1">METODO</div>
                                            <div className="col-span-1 text-right">TOTAL</div>
                                        </div>

                                        {(detailedReport?.movements || []).map((m: any, i: number) => (
                                            <div key={i} className="grid grid-cols-4 text-[10px] leading-tight mb-2">
                                                <div className="col-span-1 text-gray-500 dark:text-zinc-500 font-medium tracking-tight">
                                                    {formatTime(m.time)}
                                                </div>
                                                <div className="col-span-1 font-medium">
                                                    <span className={m.type === 'VENTA' ? 'text-zinc-900 dark:text-zinc-100' : m.type === 'GASTO' ? 'text-rose-600' : 'text-blue-600'}>
                                                        {m.type}
                                                    </span>
                                                </div>
                                                <div className="col-span-1 text-[9px] text-gray-500 dark:text-zinc-500 dark:text-zinc-400 font-medium">
                                                    {m.method}
                                                </div>
                                                <div className={`col-span-1 text-right font-medium ${m.type === 'GASTO' ? 'text-rose-600' : 'text-zinc-900'}`}>
                                                    {m.type === 'GASTO' ? '-' : ''}${formatCurrency(m.amount)}
                                                </div>
                                                {m.description && (
                                                    <div className="col-span-4 text-[8px] text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-tight">
                                                        {m.description}
                                                    </div>
                                                )}
                                            </div>
                                        ))}

                                        <div className="h-px bg-zinc-200 my-4 border-dashed border-t" />
                                        
                                        <div className="space-y-1">
                                            <p className="text-[10px] font-medium uppercase tracking-tight text-gray-500 dark:text-zinc-500 dark:text-zinc-400">Balance por Metodo:</p>
                                            {Object.entries(detailedReport?.totals || {}).map(([method, total]) => (
                                                <div key={method} className="flex justify-between text-[11px] font-medium uppercase">
                                                    <span>{method}</span>
                                                    <span className={(total as number) < 0 ? 'text-rose-600' : ''}>
                                                        ${formatCurrency(total as number)}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="mt-8 text-center border-t border-zinc-200 pt-4 opacity-50">
                                        <p className="text-[8px] font-medium uppercase tracking-widest">--- FIN DEL REPORTE ---</p>
                                    </div>
                                </div>
                            </ModalBody>
                            <ModalFooter>
                                <Button variant="flat" onPress={onClose} className="font-medium uppercase tracking-tight text-[10px]">Cerrar</Button>
                                <Button 
                                    color="primary" 
                                    className="font-medium uppercase tracking-tight text-[10px]"
                                    onPress={() => window.print()}
                                >
                                    Imprimir Ticket
                                </Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>
        </div>
    );
}



