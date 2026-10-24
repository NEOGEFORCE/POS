"use client";

import { useEffect, useState, useMemo, useCallback, memo } from 'react';
import dynamic from 'next/dynamic';
import { Button, Input, Spinner, Autocomplete, AutocompleteItem } from "@heroui/react";
import {
  TrendingDown, Search, PlusCircle, RefreshCw, Sparkles, Truck, Calendar
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Expense, Supplier } from '@/lib/definitions';
import Cookies from 'js-cookie';
import { apiFetch, ApiError } from '@/lib/api-error';
import { selectLiveDebts } from '@/lib/payables.mjs';
import {
  liveLoanAvailable,
  normalizeLoanListResponse,
  normalizeLoanPayExpenseResponse,
  type LoanRecord,
} from '@/lib/loans.mjs';
import { useAuth } from '@/lib/auth';
import { broadcastRevalidate, setupSyncListener } from '@/lib/revalidate';
import { ConfirmDialog } from '@/components/ConfirmDialog';

// Dinamicos para optimizacion de carga y HMR
const ExpenseStats = dynamic(() => import('./components/ExpenseStats'), { ssr: false });
const ExpenseTable = dynamic(() => import('./components/ExpenseTable'), { ssr: false });
const ExpenseFormModal = dynamic(() => import('./components/ExpenseFormModal'), { ssr: false });
const DeleteExpenseModal = dynamic(() => import('./components/DeleteExpenseModal'), { ssr: false });
// NOTA: El Centro de Pagos / "Cuentas por pagar" ya no vive aquí. Se trasladó
// a /loans como pestaña visible junto a los préstamos (son flujos de deuda
// hermanos). Ver `src/app/(app)/loans/components/` para el panel inline.
// En /expenses sólo quedan los egresos ya pagados y la creación de nuevas
// salidas; `selectLiveDebts` se mantiene para OCULTAR las deudas vivas de la
// tabla principal (no se cuentan dos veces).

const ExpenseHeader = memo(({ 
  filter, 
  supplierFilter, 
  suppliers, 
  onSearch, 
  onSelectSupplier, 
  onAdd, 
  onReload, 
  isLoading, 
  onApplyFilters,
  datePreset,
  onDatePresetChange,
  customFrom,
  customTo,
  onCustomFromChange,
  onCustomToChange,
}: {
  filter: string,
  supplierFilter: string,
  suppliers: Supplier[],
  onSearch: (v: string) => void,
  onSelectSupplier: (name: string) => void,
  onAdd: () => void,
  onReload: () => void,
  isLoading: boolean,
  onApplyFilters: () => void,
  datePreset: 'all' | 'today' | 'yesterday' | 'this_month' | 'last_month' | 'custom',
  onDatePresetChange: (preset: 'all' | 'today' | 'yesterday' | 'this_month' | 'last_month' | 'custom') => void,
  customFrom: string,
  customTo: string,
  onCustomFromChange: (v: string) => void,
  onCustomToChange: (v: string) => void,
}) => (
  <header className="flex flex-col gap-2.5 transition-all">
    <div className="flex flex-wrap items-center justify-between gap-3 px-1">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-2xl bg-rose-500 flex items-center justify-center text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/20 shrink-0 transition-transform active:scale-95 transform -rotate-3">
          <TrendingDown size={20} />
        </div>
        <div className="flex flex-col">
          <h1 className="text-[13px] font-medium uppercase tracking-tighter leading-none tracking-tight">
            CONTROL DE <span className="text-rose-500">EGRESOS</span>
          </h1>
          <p className="text-[8px] font-medium text-gray-400 dark:text-zinc-600 uppercase tracking-[0.4em] mt-1">Audit Ledger V4.5</p>
        </div>
      </div>

      {/* SELECTOR DE FECHA + BOTONES DE ACCION (CARGAR / NUEVA SALIDA) */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 bg-gray-100 dark:bg-zinc-950 p-1 rounded-2xl border border-gray-200 dark:border-white/5">
          <div className="flex items-center gap-1.5 px-2 text-rose-500">
            <Calendar size={14} />
            <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500 hidden xl:inline">Período:</span>
          </div>
          {[
            { id: 'all', label: 'Todos' },
            { id: 'today', label: 'Hoy' },
            { id: 'yesterday', label: 'Ayer' },
            { id: 'this_month', label: 'Este Mes' },
            { id: 'last_month', label: 'Mes Pasado' },
            { id: 'custom', label: 'Personalizado' },
          ].map(preset => (
            <Button
              key={preset.id}
              size="sm"
              variant={datePreset === preset.id ? "solid" : "light"}
              color={datePreset === preset.id ? "danger" : "default"}
              onPress={() => onDatePresetChange(preset.id as any)}
              className={`h-7 px-2.5 text-[9px] font-bold uppercase tracking-wider rounded-xl transition-all ${
                datePreset === preset.id
                  ? 'shadow-sm bg-rose-500 text-white font-bold'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
              }`}
            >
              {preset.label}
            </Button>
          ))}
        </div>

        <Button
          isIconOnly
          size="sm"
          onPress={onReload}
          isLoading={isLoading}
          title="Cargar / Sincronizar"
          className="h-10 w-10 card-base border-none dark:bg-[#18181b]/80 text-rose-500 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-gray-200 dark:border-white/5 active:scale-95 transition-all shrink-0"
        >
          <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
        </Button>

        <Button
          size="sm"
          onPress={onAdd}
          className="h-10 bg-rose-500 text-white font-medium uppercase text-[9px] px-4 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/20 tracking-tight transition-all active:scale-95 shrink-0"
        >
          <PlusCircle size={16} />
          <span className="ml-2 tracking-widest">NUEVA SALIDA</span>
        </Button>
      </div>
    </div>

    {/* Si se selecciona Personalizado, mostrar inputs desde/hasta */}
    {datePreset === 'custom' && (
      <div className="flex items-center gap-3 px-3 py-2 bg-gray-100 dark:bg-zinc-950/80 rounded-2xl border border-gray-200 dark:border-white/5 self-end animate-in fade-in duration-200">
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-bold uppercase text-zinc-500">Desde:</span>
          <Input
            type="date"
            size="sm"
            value={customFrom}
            onChange={(e) => onCustomFromChange(e.target.value)}
            className="w-36 text-xs font-mono"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-bold uppercase text-zinc-500">Hasta:</span>
          <Input
            type="date"
            size="sm"
            value={customTo}
            onChange={(e) => onCustomToChange(e.target.value)}
            className="w-36 text-xs font-mono"
          />
        </div>
      </div>
    )}

    <div className="flex flex-col sm:flex-row gap-2">
      <Input
        size="sm"
        placeholder="FILTRAR POR CONCEPTO (ej. ALMUERZO, TRANSPORTE)..."
        value={filter}
        onValueChange={onSearch}
        classNames={{
          inputWrapper: "h-11 px-4 rounded-2xl bg-black/5 dark:bg-[#18181b] border border-gray-200 dark:border-white/5 focus-within:!border-rose-500/30 transition-all w-full shadow-inner",
          input: "font-medium text-[11px] uppercase text-zinc-900 dark:text-zinc-50 placeholder:text-gray-400 dark:placeholder:text-zinc-600 bg-transparent tracking-widest"
        }}
        startContent={<Search size={14} className="text-rose-500 mr-1" />}
      />
      <Autocomplete
        size="sm"
        placeholder="SELECCIONAR PROVEEDOR..."
        defaultItems={suppliers}
        selectedKey={supplierFilter || null}
        onSelectionChange={(key) => onSelectSupplier(key ? String(key) : '')}
        allowsCustomValue
        onInputChange={(v) => onSelectSupplier(v.toUpperCase())}
        classNames={{
          base: "w-full",
        }}
        inputProps={{
          classNames: {
            inputWrapper: "h-11 px-4 rounded-2xl bg-black/5 dark:bg-[#18181b] border border-gray-200 dark:border-white/5 focus-within:!border-rose-500/30 transition-all w-full shadow-inner",
            input: "font-medium text-[11px] uppercase text-zinc-900 dark:text-zinc-50 placeholder:text-gray-400 dark:placeholder:text-zinc-600 bg-transparent tracking-widest"
          }
        }}
        startContent={<Truck size={14} className="text-rose-500 mr-1 shrink-0" />}
      >
        {(s) => (
          <AutocompleteItem key={s.name} textValue={s.name} className="text-[11px] font-medium uppercase">
            {s.name}
          </AutocompleteItem>
        )}
      </Autocomplete>
      <Button
        onPress={onApplyFilters}
        className="h-11 bg-gray-50 dark:bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 font-medium uppercase text-[10px] rounded-2xl px-6 shrink-0"
      >
        Buscar (Servidor)
      </Button>
    </div>
  </header>
));
ExpenseHeader.displayName = 'ExpenseHeader';
ExpenseHeader.displayName = 'ExpenseHeader';

async function fetchExpenses(token: string, concept: string = '', supplier: string = ''): Promise<Expense[]> {
  const query = new URLSearchParams();
  if (concept) query.append('concept', concept);
  if (supplier) query.append('supplier', supplier);
  const url = `/expenses/list${query.toString() ? '?' + query.toString() : ''}`;
  
  const data = await apiFetch(url, {
    method: 'GET',
    fallbackError: 'FALLO AL CARGAR EGRESOS'
  }, token);
  return Array.isArray(data) ? data : [];
}

export default function ExpensesPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const isAdmin = useMemo(() => {
    const role = user?.role?.toLowerCase() || user?.Role?.toLowerCase() || '';
    return role === 'admin' || role === 'administrador' || role === 'superadmin';
  }, [user]);

  const [loading, setLoading] = useState(true);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [filter, setFilter] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');

  // Modales
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  
  const [duplicateAlertOpen, setDuplicateAlertOpen] = useState(false);
  const [pendingExpenseData, setPendingExpenseData] = useState<any>(null);

  // Estados de Datos
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);

  // Préstamos activos para el modal de pago. Sólo se cargan si el usuario
  // es admin — un empleado no puede pagar un egreso con la plata de un
  // préstamo (el backend lo restringe también vía `loansAdmin`).
  const [loans, setLoans] = useState<LoanRecord[]>([]);

  const loadLoansForPayment = useCallback(async () => {
    if (!isAdmin) return;
    const token = Cookies.get('org-pos-token');
    if (!token) return;
    try {
      const raw = await apiFetch<unknown>('/loans', {
        method: 'GET',
        fallbackError: 'No se pudo cargar la lista de préstamos',
      }, token);
      const { loans: normalized } = normalizeLoanListResponse(raw);
      setLoans(normalized);
    } catch {
      // Silencioso: si no hay préstamos cargados, el modal muestra el
      // mensaje "No hay préstamos activos" sin romper el flujo del egreso.
    }
  }, [isAdmin]);

  // Cargar préstamos al abrir el modal (crear o editar). Un fetch único
  // por apertura: el POS no cambia préstamos muy seguido.
  useEffect(() => {
    if ((addDialogOpen || editDialogOpen) && isAdmin) {
      void loadLoansForPayment();
    }
  }, [addDialogOpen, editDialogOpen, isAdmin, loadLoansForPayment]);

  // Mantener la lista fresca cuando algún otro componente dispare
  // EXPENSE_UPDATE (p. ej. tras pagar una cuota de préstamo en /loans).
  useEffect(() => {
    const cleanup = setupSyncListener((event) => {
      if (event === 'EXPENSE_UPDATE') void loadLoansForPayment();
    });
    return cleanup;
  }, [loadLoansForPayment]);

  const loanOption = useMemo(() => {
    if (!isAdmin) return undefined;
    const activeLoans = loans
      .filter((l) => {
        const status = String(l?.status || '').toUpperCase();
        return status === 'ACTIVE' || status === 'DEFAULTED';
      })
      .map((l) => ({
        id: l.id!,
        lenderName: l.lenderName || 'Sin acreedor',
        available: liveLoanAvailable(l),
      }))
      .filter((l) => l.available > 0);
    return { enabled: true as const, loans: activeLoans };
  }, [isAdmin, loans]);

  const loadExpenses = useCallback(async () => {
    setLoading(true);
    const token = Cookies.get('org-pos-token');
    if (!token) { setLoading(false); return; }
    try {
      const data = await fetchExpenses(token, filter, supplierFilter);
      setExpenses(data);
    } catch {
      toast({ variant: "destructive", title: "Error Auditoria", description: "No se pudo sincronizar el historial de egresos." });
    } finally {
      setLoading(false);
    }
  }, [toast, filter, supplierFilter]);

  useEffect(() => { 
    loadExpenses(); 
    
    // Escuchar actualizaciones de egresos (Incluso si ocurren en otra pestaña o proceso)
    const cleanup = setupSyncListener((event) => {
      if (event === 'EXPENSE_UPDATE' || event === 'DASHBOARD_UPDATE') {
        loadExpenses();
      }
    });
    return cleanup;
  }, []);

  // Cargar lista de proveedores para alimentar el dropdown del filtro
  useEffect(() => {
    const loadSuppliers = async () => {
      const token = Cookies.get('org-pos-token');
      if (!token) return;
      try {
        const data = await apiFetch('/suppliers/all-suppliers', {
          method: 'GET',
          fallbackError: 'No se pudo cargar la lista de proveedores',
        }, token);
        if (Array.isArray(data)) {
          setSuppliers(data);
        }
      } catch {
        // No bloqueante: el filtro permite valor libre con allowsCustomValue
      }
    };
    loadSuppliers();
  }, []);

  // Estado para selector de fecha de egresos
  const [datePreset, setDatePreset] = useState<'all' | 'today' | 'yesterday' | 'this_month' | 'last_month' | 'custom'>('this_month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const dateRangeBounds = useMemo(() => {
    const now = new Date();
    let start = new Date(0);
    let end = new Date(2099, 11, 31, 23, 59, 59);

    if (datePreset === 'today') {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    } else if (datePreset === 'yesterday') {
      const y = new Date(now);
      y.setDate(now.getDate() - 1);
      start = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 0, 0, 0);
      end = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59, 59);
    } else if (datePreset === 'this_month') {
      start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    } else if (datePreset === 'last_month') {
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0);
      end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    } else if (datePreset === 'custom') {
      if (customFrom) {
        const [y, m, d] = customFrom.split('-').map(Number);
        start = new Date(y, m - 1, d, 0, 0, 0);
      }
      if (customTo) {
        const [y, m, d] = customTo.split('-').map(Number);
        end = new Date(y, m - 1, d, 23, 59, 59);
      }
    }
    return { start, end };
  }, [datePreset, customFrom, customTo]);

  const stats = useMemo(() => {
    const periodExpenses = expenses.filter(e => {
      if (datePreset === 'all') return true;
      const d = new Date(e.date);
      return d >= dateRangeBounds.start && d <= dateRangeBounds.end;
    });

    const totalMonth = periodExpenses
      .filter(e => (e.status === 'PAID' || !e.status) && e.paymentSource?.toUpperCase() !== 'PRESTAMO' && e.paymentSource?.toUpperCase() !== 'PREST.')
      .reduce((acc, e) => acc + Number(e.amount) + Number(e.taxAmount || 0), 0);

    const bySource = periodExpenses
      .filter(e => (e.status === 'PAID' || !e.status) && e.paymentSource?.toUpperCase() !== 'PRESTAMO' && e.paymentSource?.toUpperCase() !== 'PREST.')
      .reduce((acc: any, e) => {
        const source = e.paymentSource || 'EFECTIVO';
        acc[source] = (acc[source] || 0) + Number(e.amount) + Number(e.taxAmount || 0);
        return acc;
      }, {});
    const topSource = Object.entries(bySource).sort((a: any, b: any) => b[1] - a[1])[0]?.[0] || 'EFECTIVO';

    // Las deudas vivas se SIGUEN calculando con el helper compartido para
    // ocultarlas de la tabla principal (no se cuentan dos veces: la tabla
    // de /expenses muestra lo PAGADO; las deudas se abonan en /loans ‣
    // "Cuentas por pagar"). El guardián `tests/payables.test.mjs` exige
    // que esta pantalla siga importando @/lib/payables.mjs.
    const pendingExpenses = selectLiveDebts(expenses);

    return { totalMonth, topSource, count: periodExpenses.length, pendingExpenses };
  }, [expenses, datePreset, dateRangeBounds]);

  const filteredExpenses = useMemo(() => {
    const pendingIds = new Set(stats.pendingExpenses.map(e => e.id));
    return expenses.filter(e => {
      // Ocultar de la tabla principal lo que ya se muestra en el modal de
      // deudas, para no contar visualmente dos veces la misma factura.
      // Se compara contra el MISMO conjunto que alimenta "Cuentas por Pagar"
      // (no sólo status==='PENDING'), así los préstamos con estado vacío
      // tampoco aparecen duplicados.
      if (pendingIds.has(e.id)) return false;
      const status = (e.status || '').trim().toUpperCase();
      if (status === 'SETTLED') return false;

      if (datePreset !== 'all') {
        const d = new Date(e.date);
        if (d < dateRangeBounds.start || d > dateRangeBounds.end) return false;
      }
      
      return true;
    }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [expenses, datePreset, dateRangeBounds, stats.pendingExpenses]);

  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);

  const paginatedExpenses = useMemo(() => {
    return filteredExpenses.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  }, [filteredExpenses, currentPage, pageSize]);

  const totalPages = Math.ceil(filteredExpenses.length / pageSize || 1);

  // Reset pagination when filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [filter]);

  // Handlers
  const handleSaveExpense = async (data: any) => {
    const token = Cookies.get('org-pos-token');
    if (!token || !data?.description || !data?.amount || !data?.category) {
      toast({ variant: "destructive", title: "CAMPOS INCOMPLETOS", description: "La categoria, concepto y monto son obligatorios." });
      return;
    }

    if (addDialogOpen && data.category === 'Proveedores' && data.supplierId) {
      const today = new Date().toISOString().split('T')[0];
      const isDuplicate = expenses.some(e => {
        if (!e.supplier?.id) return false;
        const eDate = new Date(e.date).toISOString().split('T')[0];
        return e.supplier.id === Number(data.supplierId) && eDate === today;
      });

      if (isDuplicate) {
        setPendingExpenseData(data);
        setDuplicateAlertOpen(true);
        return;
      }
    }

    await proceedWithSave(data, token);
  };

  const proceedWithSave = async (data: any, token: string) => {
    try {
      // --- Rama préstamo: NO crea un egreso normal. El endpoint del backend
      // (POST /loans/:id/pay-expense) crea el `expense` dentro de la misma
      // transacción con `paymentSource='PRESTAMO'` y canales = 0. El
      // frontend sólo manda loanId + metadata; nunca fabrica el canal.
      if (addDialogOpen && data.loanId != null && data.loanId !== '') {
        const expenseAmount = Math.abs(parseFloat(String(data.amount)) || 0);
        if (expenseAmount <= 0) {
          toast({ variant: 'destructive', title: 'MONTO INVÁLIDO', description: 'EL MONTO DEBE SER MAYOR A CERO' });
          return;
        }
        const supplierId = data.category === 'Proveedores' && data.supplierId ? Number(data.supplierId) : undefined;
        const body: Record<string, unknown> = {
          amount: expenseAmount,
          description: String(data.description || '').toUpperCase(),
          category: data.category || 'Otros Gastos',
          purpose: String(data.description || '').toUpperCase(),
        };
        if (supplierId) body.supplierId = supplierId;

        try {
          const raw = await apiFetch<unknown>(
            `/loans/${encodeURIComponent(String(data.loanId))}/pay-expense`,
            {
              method: 'POST',
              body: JSON.stringify(body),
              fallbackError: 'FALLO AL PAGAR CON EL PRÉSTAMO',
            },
            token,
          );
          normalizeLoanPayExpenseResponse(raw);
          const chosenLoan = loans.find((l) => String(l.id) === String(data.loanId));
          const lenderName = chosenLoan?.lenderName || 'préstamo';
          toast({
            variant: 'success',
            title: 'PAGADO CON PRÉSTAMO',
            description: `Pagado con el préstamo de ${lenderName}; no afecta la caja.`,
          });
          setAddDialogOpen(false);
          setEditDialogOpen(false);
          localStorage.removeItem('expense-form-draft');
          setEditingExpense(null);
          loadExpenses();
          void loadLoansForPayment();
          broadcastRevalidate('EXPENSE_UPDATE');
        } catch (err: any) {
          if (err instanceof ApiError) {
            const code = err.data?.error?.code || err.data?.code;
            if (code === 'LOAN_NOT_FOUND') {
              toast({ variant: 'destructive', title: 'PRÉSTAMO NO EXISTE', description: 'Recarga la lista de préstamos.' });
            } else if (code === 'LOAN_NOT_ACTIVE') {
              toast({ variant: 'destructive', title: 'PRÉSTAMO INACTIVO', description: 'Sólo préstamos ACTIVOS o EN MORA.' });
            } else if (code === 'LOAN_PRINCIPAL_EXCEEDED') {
              toast({ variant: 'destructive', title: 'EXCEDE EL PRÉSTAMO', description: 'El monto supera el disponible del préstamo.' });
            } else {
              toast({ variant: 'destructive', title: 'ERROR AL PAGAR', description: err.message || 'Fallo al pagar con el préstamo.' });
            }
          } else {
            toast({ variant: 'destructive', title: 'ERROR AL PAGAR', description: err?.message || 'Fallo al pagar con el préstamo.' });
          }
          // Retornar una promesa rechazada evita que el catch exterior duplique
          // el toast y permite que ExpensePaymentModal NO muestre éxito falso.
          return Promise.reject(err);
        }
        return;
      }

      const currentDate = new Date().toISOString();

      // Si hay linkedOrderId y es creacion, usar endpoint especial vinculado
      const isLinkedOrder = addDialogOpen && data.linkedOrderId;

      const path = addDialogOpen
        ? (isLinkedOrder ? '/expenses/create-linked' : '/expenses/create')
        : `/expenses/update/${editingExpense?.id}`;

      const method = addDialogOpen ? 'POST' : 'PUT';

      // Preparar payload base
      const isPending = data.status === 'PENDING' || data.paymentSource === 'PRESTAMO';
      const expenseAmount = Math.abs(parseFloat(String(data.amount)) || 0);

      const payload: any = {
        description: data.description.toUpperCase(),
        amount: expenseAmount,
        taxAmount: data.taxAmount || 0,
        cashAmount: isPending ? 0 : (data.cashAmount || 0),
        nequiAmount: isPending ? 0 : (data.nequiAmount || 0),
        daviplataAmount: isPending ? 0 : (data.daviplataAmount || 0),
        fondoAmount: isPending ? 0 : (data.fondoAmount || 0),
        coinsAmount: isPending ? 0 : (data.coinsAmount || 0),
        // Bold QR / Bre-B — se envía como campo top-level para que, en
        // cuanto el backend persista la columna física `bold_qr_amount`
        // (migración 028 fuera de alcance), el canal cuadre al centavo.
        // Mientras tanto el agregador legacy del dashboard lo cuenta por
        // el string `paymentSource='BOLD_QR'` (o el token `BOLD_QR: $N`
        // dentro de un string compuesto).
        boldQrAmount: isPending ? 0 : (data.boldQrAmount || 0),
        paidAmount: isPending ? 0 : expenseAmount,
        remainingAmount: isPending ? expenseAmount : 0,
        date: addDialogOpen ? currentDate : (editingExpense?.date || currentDate),
        paymentSource: data.paymentSource || (isPending ? 'PRESTAMO' : 'EFECTIVO'),
        category: data.category,
        lenderName: data.paymentSource === 'PRESTAMO' ? data.lenderName : null,
        status: isPending ? 'PENDING' : 'PAID',
        supplierId: data.category === 'Proveedores' && data.supplierId ? Number(data.supplierId) : null,
        newSupplierName: data.category === 'Proveedores' && !data.supplierId ? data.newSupplierName : null
      };

      // Si es orden vinculada, incluir el ID
      if (isLinkedOrder) {
        payload.linkedOrderId = Number(data.linkedOrderId);
      }

      const result = await apiFetch(path, {
        method,
        body: JSON.stringify(payload),
        fallbackError: 'FALLO AL REGISTRAR MOVIMIENTO'
      }, token!);

      // Mensaje de exito especifico para orden vinculada
      if (isLinkedOrder && result?.message) {
        toast({
          variant: "success",
          title: "EXITO",
          description: `${result.message}. Stock actualizado automaticamente.`,
        });
      } else {
        toast({
          variant: "success",
          title: "EXITO",
          description: "MOVIMIENTO REGISTRADO CORRECTAMENTE",
        });
      }

      setAddDialogOpen(false);
      setEditDialogOpen(false);
      localStorage.removeItem('expense-form-draft'); // Limpieza estricta tras exito
      setEditingExpense(null);
      loadExpenses();
      broadcastRevalidate('EXPENSE_UPDATE');
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "ERROR AL GUARDAR",
        description: err.message || "Fallo al procesar el egreso."
      });
    }
  };

  const handleDeleteExpense = async () => {
    if (!deletingId) return;
    const token = Cookies.get('org-pos-token');
    try {
      const response = await apiFetch<{ result?: { loanReversed?: boolean; restoredAmount?: number; releasedPrincipal?: number } }>(`/expenses/delete/${deletingId}`, {
        method: 'DELETE',
        fallbackError: 'FALLO AL ELIMINAR EGRESO'
      }, token!);
      const loanReversed = response?.result?.loanReversed === true;
      toast({
        variant: "success",
        title: loanReversed ? "PAGO CON PRÉSTAMO REVERSADO" : "ÉXITO",
        description: loanReversed
          ? "La deuda volvió a Cuentas por pagar y el principal quedó disponible otra vez."
          : "REGISTRO ELIMINADO",
      });
      setDeleteDialogOpen(false);
      setDeletingId(null);
      await loadExpenses();
      void loadLoansForPayment();
      broadcastRevalidate('EXPENSE_UPDATE');
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "FALLO AL ANULAR",
        description: err.message || 'FALLO AL ELIMINAR EGRESO',
        className: "bg-rose-500 text-white border-none"
      });
    }
  };

  // Los handlers de settle/forceClose se trasladaron a /loans junto con el
  // Centro de Pagos. El abono y la condonación comparten los mismos
  // endpoints del backend (PATCH /expenses/settle/:id y PUT /expenses/:id)
  // y la misma fuente de datos (`GET /expenses/list` filtrada con
  // `selectLiveDebts`); el cambio es sólo UI (dónde se dispara) para
  // tener un único lugar donde cerrar deudas en el POS.

  if (loading) return <div className="flex-1 h-full w-full flex items-center justify-center bg-zinc-50 dark:bg-[#09090b]"><Spinner color="danger" size="lg" /></div>;

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full w-full max-w-[1600px] mx-auto overflow-hidden bg-transparent text-zinc-900 dark:text-zinc-50 transition-all duration-500 relative">

      {/* HEADER SECTION: FIXED (TOP) */}
      <div className="shrink-0 px-3 pt-1.5 pb-2 flex flex-col gap-3 md:gap-4 border-b border-gray-200/50 dark:border-white/5 bg-gray-50/50 dark:bg-zinc-950/50">
        <ExpenseHeader
          filter={filter}
          supplierFilter={supplierFilter}
          suppliers={suppliers}
          onSearch={(v) => setFilter(v.toUpperCase())}
          onSelectSupplier={(v) => setSupplierFilter(v.toUpperCase())}
          onAdd={() => setAddDialogOpen(true)}
          onReload={() => { setFilter(''); setSupplierFilter(''); setDatePreset('this_month'); loadExpenses(); }}
          onApplyFilters={loadExpenses}
          isLoading={loading}
          datePreset={datePreset}
          onDatePresetChange={setDatePreset}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFromChange={setCustomFrom}
          onCustomToChange={setCustomTo}
        />

        <ExpenseStats
          totalMonth={stats.totalMonth}
          topSource={stats.topSource}
          count={stats.count}
        />
      </div>

      {/* CONTENT SECTION (INTERNAL SCROLLABLE) */}
      <div className="px-1 md:px-2 py-1 flex flex-col flex-1 min-h-0">
        <ExpenseTable
          expenses={paginatedExpenses}
          isAdmin={isAdmin}
          onEdit={(e) => { setEditingExpense({ ...e }); setEditDialogOpen(true); }}
          onDelete={(id) => { setDeletingId(id); setDeleteDialogOpen(true); }}
          currentPage={currentPage}
          totalPages={totalPages}
          pageSize={pageSize}
          totalRecords={filteredExpenses.length}
          onPageChange={setCurrentPage}
          onPageSizeChange={(size) => { setPageSize(size); setCurrentPage(1); }}
        />
      </div>


      {/* Modals Orchestration */}
      <ExpenseFormModal
        isOpen={addDialogOpen || editDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setAddDialogOpen(false);
            setEditDialogOpen(false);
            setEditingExpense(null);
          }
        }}
        initialExpense={editingExpense || undefined}
        onSave={handleSaveExpense}
        isAdmin={isAdmin}
        loanOption={addDialogOpen ? loanOption : undefined}
      />

      <ConfirmDialog
        isOpen={duplicateAlertOpen}
        onOpenChange={setDuplicateAlertOpen}
        title="Ã¢Å¡Â Ã¯Â¸Â ALERTA: POSIBLE PAGO DUPLICADO"
        description="Ya se realizo un pago a este proveedor el dia de hoy. Ã‚Â¿Esta seguro de que desea registrar otro pago?"
        onConfirm={() => {
          setDuplicateAlertOpen(false);
          const token = Cookies.get('org-pos-token');
          if (token && pendingExpenseData) {
            proceedWithSave(pendingExpenseData, token);
          }
        }}
        confirmText="Confirmar Pago"
        type="danger"
      />

      <DeleteExpenseModal
        isOpen={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteExpense}
        isLoanFunded={expenses.some((e) =>
          String(e.id) === String(deletingId) &&
          ["PRESTAMO", "PREST."].includes(String(e.paymentSource || "").trim().toUpperCase()),
        )}
      />

    </div>
  );


}
