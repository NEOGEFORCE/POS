"use client";

import { useEffect, useRef, useState, useCallback } from 'react';
import {
    Button, Input, Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
    Spinner, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter
} from "@heroui/react";

import {
    Plus, Trash2, User, Grid, Camera, Search, Scale, Barcode,
    Wifi, WifiOff, Edit2, Package, Zap, AlertTriangle
} from 'lucide-react';

import { motion, AnimatePresence } from 'framer-motion';

import dynamic from 'next/dynamic';

import { formatCurrency, applyRounding, roundSaleLineSubtotal } from "@/lib/utils";
import { useNewSale } from './hooks/useNewSale';
import { useBoldQrTray, type BoldQrPendingItem, type BoldQrTrayApprovedInfo } from './hooks/useBoldQrTray';
import ProductGrid from './components/ProductGrid';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { apiFetch } from '@/lib/api-error';
import { canCaptureHomeKey } from '@/lib/drawer-otp.mjs';
import { buildEncolarPayload, buildIniciarPayload, generateQrClientTxId, BOLD_QR_ALREADY_PAID_SENTINEL, isAlreadyPaidError, isAlreadyPaidResponse } from '@/lib/bold-qr-helpers.mjs';
import { countCartUnits, splitCartTabs } from '@/lib/cart-tabs.mjs';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { playNotificationSound, isSoundMuted } from '@/lib/audio-utils';
import {
    buildVoiceAnnouncement,
    isSpeechSynthesisSupported,
    pickSpanishVoice,
    BOLD_QR_VOICE_PREFERRED_LANG,
} from '@/lib/bold-qr-voice.mjs';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { CheckCircle2 } from 'lucide-react';
import Cookies from 'js-cookie';

// CARGA DINÃƒÂMICA DE COMPONENTES PESADOS
const UniversalPaymentModal = dynamic(() => import('@/components/shared/UniversalPaymentModal'), { ssr: false });
const BoldQrTrayPopover = dynamic(() => import('./components/BoldQrTrayPopover'), { ssr: false });
import { isAdminUser } from '@/lib/auth-helpers.mjs';
const ClientSelectionModal = dynamic(() => import('./components/ClientSelectionModal'), { ssr: false });
const ManualWeightModal = dynamic(() => import('./components/ManualWeightModal'), { ssr: false });
const MissingItemModal = dynamic(() => import('./components/MissingItemModal'), { ssr: false });
const ScannerOverlay = dynamic(() => import('@/components/ScannerOverlay').then(module => module.ScannerOverlay), { ssr: false });
const SplitBillDialog = dynamic(() => import('@/components/SplitBillDialog').then(module => module.SplitBillDialog), { ssr: false });
const EditCartItemModal = dynamic(() => import('./components/EditCartItemModal').then(module => module.EditCartItemModal), { ssr: false });
const ProductSearchModal = dynamic(() => import('./components/ProductSearchModal'), { ssr: false });
const HomeDrawerModal = dynamic(() => import('./components/HomeDrawerModal').then(module => module.HomeDrawerModal), { ssr: false });


export default function NewSalePage() {
    const {
        products, customers, categories,
        currentCart, carts, activeCartKey, cartKeys, cartCustomers,
        selectedCustomer, selectedCustomerDni,
        total, editDeltaTotal, editHasChanges, editMode, isEditMode, filteredProductsGrid, filteredCustomers,
        loading, submitting, searchQuery, setSearchQuery,
        selectedCategory, setSelectedCategory,
        selectedItemId, setSelectedItemId,
        isPaymentDialogOpen, setIsPaymentDialogOpen,
        isClientDialogOpen, setIsClientDialogOpen,
        clientSearch, setClientSearch,
        isScannerOpen, setIsScannerOpen,
        isManualWeightOpen, setIsManualWeightOpen,
        manualWeightProduct, manualWeightValue, setManualWeightValue,
        isSplitDialogOpen, setIsSplitDialogOpen,
        isMissingItemOpen, setIsMissingItemOpen,
        showSuccessScreen, setShowSuccessScreen,
        lastChange, lastReceipt, hiddenScannerRef, returnFocusToScanner,
        scaleWeight, isScaleOnline, isScaleReloading, isOffline, syncQueueCount, syncOfflineQueue,
        scannerBuffer, setScannerBuffer, playBeep, feedbackCode, isFeedbackError,
        handleCartSwitch, handleClientSelect, addNewCart, deleteCart, confirmDeleteCart,
        isDeleteCartConfirmOpen, setIsDeleteCartConfirmOpen,
        updateQuantity, removeFromCart, addToCart, addMiscItem, setCartItemQuantity, updateCartItem,
        handleCodeSubmit, handleScaleSync, handleConfirmSale, confirmManualWeight,
        confirmEnqueuedAndFreeCart,
        setOriginalCustomerDniBeforeSplit, setRemainingItemsAfterSplit, setSplitItemsToPay
    } = useNewSale();

    const [editingCartItem, setEditingCartItem] = useState<any | null>(null);
    const [isProductSearchOpen, setIsProductSearchOpen] = useState(false);
    const [isHomeDrawerModalOpen, setIsHomeDrawerModalOpen] = useState(false);
    const [pendingReturn, setPendingReturn] = useState<any | null>(null);

    useEffect(() => {
        const storedReturn = localStorage.getItem("pos-pending-return");
        if (storedReturn) {
            try {
                setPendingReturn(JSON.parse(storedReturn));
            } catch (e) {
                console.error("Error parsing pending return", e);
            }
        }

        const handleReturnCompleted = () => {
            setPendingReturn(null);
        };
        window.addEventListener('return-completed', handleReturnCompleted);
        return () => window.removeEventListener('return-completed', handleReturnCompleted);
    }, []);

    const cancelPendingReturn = () => {
        localStorage.removeItem("pos-pending-return");
        setPendingReturn(null);
    };

    const { user } = useAuth();
    const { toast } = useToast();

    // =============================================================
    // Flujo asíncrono QR Bold / Bre-B (migración 027)
    //
    // El cajero puede dejar en espera un cobro QR y seguir atendiendo:
    // la bandeja global `useBoldQrTray` escucha por SSE las aprobaciones
    // post-commit emitidas por el backend tras recibir la notificación
    // MacroDroid. Cuando una aprobación llega, mostramos alerta grande
    // + sonido + impresión (ToDo: hook) sin tocar el carrito activo.
    // =============================================================
    const cajaId = useCallback(() => {
        const dni = typeof user?.dni === 'string' ? user.dni.trim() : '';
        if (dni) return dni;
        const id = typeof user?.id === 'string' ? user.id.trim() : '';
        return id || 'CAJA';
    }, [user?.dni, user?.id])();
    const [qrApprovedAlert, setQrApprovedAlert] = useState<BoldQrTrayApprovedInfo | null>(null);
    // Reopen payload canónico: cuando el cajero pulsa "Reabrir QR" en la
    // bandeja global, guardamos exactamente el `ventaTempId` + `monto` del
    // pending y el UPM lo consume UNA sola vez (contrato de un solo uso).
    // El UPM dispara `onBoldQrReopenConsumed` cuando abre el QR; aquí
    // limpiamos el payload a null para que NUNCA se reconsuma al abrir
    // cobros de otra cuenta (bug 2026-10-23).
    const [boldQrReopenPayload, setBoldQrReopenPayload] = useState<{ ventaTempId: string; monto: number } | null>(null);
    // ventaTempId reabierto desde la bandeja: al aprobarse no debe
    // liberar el carrito activo (que es otra venta).
    const reopenedVentaTempIdRef = useRef<string | null>(null);
    // Dedupe duro: cada APPROVED por ventaTempId o saleId se procesa UNA
    // sola vez por sesión del tab (el hook ya tiene su propio dedupe por
    // sessionStorage, pero este Set defensivo protege contra re-renders
    // sincrónicos del callback).
    const notifiedApprovedKeysRef = useRef<Set<string>>(new Set());

    // =============================================================
    // Dedupe compartido entre bandeja (useBoldQrTray) y modal
    // (ModalPagoBoldQR) para la aprobación QR Bold/Bre-B.
    //
    // Flujo APROBADO (migración 027, DispatchAutoSale post-commit):
    // el backend emite el frame `qr_intent_update` con status=APROBADO
    // + saleId + amountCop por DOS canales SSE distintos:
    //
    //   - `/pos/pagos-qr/caja-stream` → `useBoldQrTray` → `handleQrTrayApproved`
    //     (ruta cuando el cajero ya dejó la intención en espera).
    //   - `/pos/pagos-qr/stream?venta_temp_id=...` → `ModalPagoBoldQR` →
    //     `UniversalPaymentModal.handleBoldQrApproved` → `handleBoldQrFinalized`
    //     (ruta cuando el cajero sigue en el modal).
    //
    // Si APROBADO llega por los dos canales simultáneamente, el Set
    // compartido garantiza que la alerta grande, el pitido y el
    // broadcastRevalidate corren EXACTAMENTE UNA vez. La liberación
    // del carrito activo vive sólo en la rama "modal": el cajero
    // sigue en pantalla cuando el frame llega por el stream dedicado.
    // La bandeja NUNCA toca carritos (el cajero puede estar atendiendo
    // a otro cliente en otro carrito).
    // =============================================================
    const normalizeBoldQrKey = useCallback((info: { ventaTempId?: string; saleId?: number }): string => {
        const venta = typeof info.ventaTempId === 'string' ? info.ventaTempId.trim() : '';
        if (venta) return venta;
        if (typeof info.saleId === 'number' && Number.isFinite(info.saleId) && info.saleId > 0) {
            return `sale:${info.saleId}`;
        }
        return '';
    }, []);

    // Ref para romper el orden circular entre los handlers de
    // aprobación (declarados ANTES de `useBoldQrTray`) y el `markPaid`
    // que ese hook expone. Se sincroniza tras montar el hook con un
    // `useEffect` abajo. Los handlers consultan el ref vía
    // `qrMarkPaidRef.current?.(...)` sin generar warning de deps.
    const qrMarkPaidRef = useRef<((info: { ventaTempId: string; saleId?: number; amountCop?: number }) => void) | null>(null);

    // Guard único: aplica a alert + sound + revalidate + cleanup de
    // la preparación. Dedupe fuerte por `ventaTempId` (preferido) o
    // `sale:<saleId>` como fallback. Reusa `notifiedApprovedKeysRef`
    // ya introducido para la bandeja.
    const notifyBoldQrApprovedOnce = useCallback((info: BoldQrTrayApprovedInfo): boolean => {
        const key = normalizeBoldQrKey(info);
        if (!key) return false;
        if (notifiedApprovedKeysRef.current.has(key)) return false;
        notifiedApprovedKeysRef.current.add(key);
        // Alerta grande + sonido: UNA sola vez por intención. El
        // AlertDialog shadcn se renderiza con el shape
        // `BoldQrTrayApprovedInfo`; la ruta modal también la respeta
        // (mismo shape derivado del QREvent del backend).
        setQrApprovedAlert(info);
        // Audio + voz: ambos honran el mute global (`isSoundMuted`).
        // El chime es el fallback cuando el navegador no tiene Web
        // Speech API, o cuando `buildVoiceAnnouncement` descarta la
        // frase por monto inválido (defensa).
        const muted = (() => {
            try { return isSoundMuted(); } catch { return false; }
        })();
        if (!muted) {
            try { playNotificationSound('success'); } catch { /* audio no crítico */ }
            if (isSpeechSynthesisSupported()) {
                const phrase = buildVoiceAnnouncement(info.amountCop);
                if (phrase) {
                    try {
                        const synth = window.speechSynthesis;
                        // Cancelar cualquier anuncio previo para que
                        // el cajero no acumule frases superpuestas si
                        // llegan dos APROBADOS seguidos (poco probable
                        // por el dedupe, pero defensivo).
                        synth.cancel();
                        const utter = new window.SpeechSynthesisUtterance(phrase);
                        utter.lang = BOLD_QR_VOICE_PREFERRED_LANG;
                        const voice = pickSpanishVoice(synth.getVoices());
                        if (voice) utter.voice = voice as SpeechSynthesisVoice;
                        synth.speak(utter);
                    } catch {
                        /* voz no crítica — el chime ya informó al cajero */
                    }
                }
            }
        }
        // Preparación QR: borrar entrada del Map local. El clientTxId
        // ya cumplió su ciclo end-to-end y el backend materializó la
        // venta canónica; retener el snapshot sería basura memoria.
        if (info.ventaTempId) qrPreparationsRef.current.delete(info.ventaTempId);
        return true;
    }, [normalizeBoldQrKey]);

    const handleQrTrayApproved = useCallback((info: BoldQrTrayApprovedInfo) => {
        // Ruta "bandeja global": el backend ya cerró la venta. Sólo
        // emitimos la señal UX; NO tocamos ningún carrito porque el
        // cajero puede estar atendiendo otra factura.
        notifyBoldQrApprovedOnce(info);
        // Marcar pagado en el storage del hook: aunque la bandeja ya
        // hace su propio persist desde el SSE handler, esto blinda el
        // caso en que la ruta "modal" sea quien dispara primero (el
        // ref se sincroniza con `qrMarkPaid` tras `useBoldQrTray`).
        const venta = typeof info.ventaTempId === 'string' ? info.ventaTempId.trim() : '';
        if (venta) {
            qrMarkPaidRef.current?.({
                ventaTempId: venta,
                saleId: info.saleId,
                amountCop: info.amountCop,
            });
        }
    }, [notifyBoldQrApprovedOnce]);

    // Ruta "modal activo": el cajero sigue frente al QR cuando el
    // backend materializa la venta. Delegado del UPM (vía
    // `onBoldQrFinalized`). Comparte el dedupe con la bandeja: si
    // la bandeja llegó primero, el alert/sonido no se repiten; aún
    // así cerramos el UPM y liberamos el carrito actual (acciones
    // únicas de la ruta modal, nunca duplicadas porque el modal
    // hijo dispara `onApproved` una sola vez por sesión).
    const handleBoldQrFinalized = useCallback((info: {
        ventaTempId: string;
        saleId: number;
        amountCop?: number;
        reference?: string;
        approvedAt?: string;
        approvedVia?: string;
    }) => {
        if (!info || typeof info !== 'object') return;
        const saleId = Number.isFinite(info.saleId) && info.saleId > 0 ? Math.floor(info.saleId) : 0;
        if (saleId <= 0) return;
        // Compone el shape que consume el AlertDialog + hook de
        // bandeja (ambos usan BoldQrTrayApprovedInfo). El
        // `cashierName` no viaja en el QREvent del stream dedicado,
        // así que queda undefined; el alert igual se muestra con el
        // monto y la referencia.
        const normalized: BoldQrTrayApprovedInfo = {
            ventaTempId: typeof info.ventaTempId === 'string' ? info.ventaTempId.trim() : '',
            saleId,
            amountCop: typeof info.amountCop === 'number' && Number.isFinite(info.amountCop) && info.amountCop > 0
                ? Math.round(info.amountCop)
                : undefined,
            reference: info.reference,
            approvedAt: info.approvedAt,
            approvedVia: info.approvedVia,
        };
        // Dedupe compartido: alerta + sonido + cleanup prep SÓLO si
        // la bandeja no se adelantó. Si no, estas acciones ya corrieron.
        notifyBoldQrApprovedOnce(normalized);
        // Marcar pagado en la bandeja (persiste en sessionStorage).
        // Esto garantiza que el pending no reaparezca ni se reabra el
        // QR al abrir cobros de otra cuenta (bug 2026-10-23). Usamos
        // el ref para no imponer orden entre esta declaración y
        // `useBoldQrTray` (ver `qrMarkPaidRef`).
        if (normalized.ventaTempId) {
            qrMarkPaidRef.current?.({
                ventaTempId: normalized.ventaTempId,
                saleId: normalized.saleId,
                amountCop: normalized.amountCop,
            });
        }
        // Acciones exclusivas de la ruta modal: cerrar UPM y liberar
        // el carrito activo. Se ejecutan SIEMPRE (fuera del guard
        // de dedupe) porque sólo se disparan desde este callback
        // único — el modal hijo garantiza `onApproved` una vez por
        // sesión (`approvedFiredRef`).
        setBoldQrReopenPayload(null);
        setIsPaymentDialogOpen(false);
        // QR reabierto desde la bandeja: su carrito ya se liberó al
        // encolarlo y vive en el servidor. El carrito activo es OTRA
        // venta que el cajero está registrando: no se toca.
        const wasReopened = !!normalized.ventaTempId && reopenedVentaTempIdRef.current === normalized.ventaTempId;
        reopenedVentaTempIdRef.current = null;
        if (wasReopened) return;
        confirmEnqueuedAndFreeCart();
    }, [notifyBoldQrApprovedOnce, confirmEnqueuedAndFreeCart, setIsPaymentDialogOpen]);

    const { pendings: qrPendings, unassignedPayments: qrUnassigned, latestError: qrTrayError, latestUnassignedError: qrUnassignedError, reconnect: qrTrayReconnect, reloadUnassigned: qrReloadUnassigned, dismissIntent: qrDismissIntent, assignPaymentToIntent: qrAssignPayment, confirmManualIntent: qrConfirmManual, markPaid: qrMarkPaid, isPaid: qrIsPaid } = useBoldQrTray({
        cajaId,
        onApprovedOnce: handleQrTrayApproved,
    });

    // Sincroniza el ref para que los handlers declarados ANTES de
    // `useBoldQrTray` puedan llamar `qrMarkPaid` sin importar el orden.
    useEffect(() => {
        qrMarkPaidRef.current = qrMarkPaid;
    }, [qrMarkPaid]);

    const handleReopenPending = useCallback((item: BoldQrPendingItem) => {
        if (!item.ventaTempId) return;
        // Bug 2026-10-23: si el cobro ya fue pagado (APPROVED SSE,
        // modal finalizado, o detectado como alreadyPaid por el
        // backend), NUNCA reabrir el QR. Avisar al cajero y
        // sacar el pending visualmente de la bandeja. Un segundo
        // click no debe reaparecer el modal viejo con la misma
        // ventaTempId.
        if (qrIsPaid(item.ventaTempId)) {
            toast({
                variant: 'default',
                title: 'YA PAGADO',
                description: 'Este cobro ya fue pagado.',
            });
            qrDismissIntent(item.ventaTempId);
            return;
        }
        // Reusar el ventaTempId + monto EXACTOS del pending. El UPM lee
        // este payload en su useEffect de reapertura y abre el modal hijo
        // con esos valores sin pasar por `handleOpenBoldQr` (que generaría
        // un ventaTempId nuevo). El UPM dispara `onBoldQrReopenConsumed`
        // cuando consume el payload para que lo limpiemos a null y evitar
        // reconsumo accidental.
        reopenedVentaTempIdRef.current = item.ventaTempId;
        setBoldQrReopenPayload({ ventaTempId: item.ventaTempId, monto: Math.round(item.amountCop || 0) });
        setIsPaymentDialogOpen(true);
    }, [qrIsPaid, qrDismissIntent, toast, setIsPaymentDialogOpen]);

    const handleBoldQrReopenConsumed = useCallback(() => {
        // Contrato de un solo uso: el UPM consumió el payload y abrió
        // el QR. Limpiamos inmediatamente para que al cerrar y abrir
        // otra factura, el payload NO se reconsuma.
        setBoldQrReopenPayload(null);
    }, []);

    // =============================================================
    // Snapshot DURABLE del cobro QR al abrir (migración 027)
    //
    // El `UniversalPaymentModal` llama a `prepareBoldQrIntent` ANTES
    // de abrir `ModalPagoBoldQR`. Aquí:
    //   1. Fijamos un `clientTxId` fresco (idempotency key end-to-end).
    //   2. Construimos el snapshot EXACTO del carrito, cliente y
    //      totales que el cliente va a pagar.
    //   3. POSTeamos `/pos/pagos-qr/iniciar` con el snapshot opcional
    //      — el backend crea la intención con los detalles ya grabados
    //      pero SIN marcar `queued_at`.
    //   4. Guardamos la preparación en un `Map` keyed por
    //      `ventaTempId`, para que `handleBoldQrEnqueueRequested` pueda
    //      reusar el mismo `clientTxId` y snapshot cuando el cajero
    //      pulse "DEJAR EN ESPERA Y SEGUIR ATENDIENDO".
    //
    // Si el POST falla, lanzamos: el UPM maneja el error y NO abre el
    // modal QR. El carrito queda intacto; el cajero cambia de método.
    //
    // La bandeja global y la aprobación silenciosa del webhook
    // MacroDroid pueden materializar la venta aunque el cajero nunca
    // llegue a encolar: con el snapshot presente desde `/iniciar`, el
    // backend ya conoce qué venta construir cuando recibe el pago.
    // Esto corrige el `QR_REQUEST_FAILED` observado con el webhook de
    // $300 (que llegaba antes de que el cajero pulsara encolar).
    // =============================================================
    type QrPreparedSnapshot = {
        clientTxId: string;
        monto: number;
        salePayload: {
            details: Array<{
                barcode: string;
                quantity: number;
                unitPrice: number;
                costPrice: number;
                subtotal: number;
            }>;
            totalAmount: number;
            amountPaid: number;
            change: number;
            transferAmount: number;
            transferSource: string;
            paymentMethod: string;
            employeeDni: string;
            clientDni: string;
            clientName: string;
        };
        cashierName: string;
        clientDni: string;
    };
    const qrPreparationsRef = useRef<Map<string, QrPreparedSnapshot>>(new Map());

    const buildQrSalePayloadSnapshot = useCallback((normalizedMonto: number): QrPreparedSnapshot['salePayload'] | null => {
        const items = currentCart;
        if (!items || items.length === 0) return null;
        const details = items.map((it: any) => {
            const quantity = typeof it.cartQuantity === 'number'
                ? it.cartQuantity
                : (typeof it.quantity === 'number' ? it.quantity : Number(it.quantity) || 0);
            const unitPrice = typeof it.salePrice === 'number'
                ? it.salePrice
                : (typeof it.unitPrice === 'number' ? it.unitPrice : Number(it.price) || 0);
            const subtotal = roundSaleLineSubtotal(unitPrice, quantity);
            return {
                barcode: String(it.barcode || ''),
                quantity,
                unitPrice,
                costPrice: typeof it.purchasePrice === 'number' ? it.purchasePrice : Number(it.costPrice) || 0,
                subtotal,
            };
        });
        return {
            details,
            totalAmount: normalizedMonto,
            amountPaid: normalizedMonto,
            change: 0,
            transferAmount: normalizedMonto,
            transferSource: 'BOLD_QR',
            paymentMethod: 'BOLD_QR',
            employeeDni: user?.dni || '',
            clientDni: selectedCustomerDni || '0',
            clientName: selectedCustomer?.name || '',
        };
    }, [currentCart, user, selectedCustomerDni, selectedCustomer]);

    const prepareBoldQrIntent = useCallback(async (amount: number, ventaTempId: string) => {
        if (isEditMode) {
            throw new Error('No se puede preparar un cobro QR en modo edición');
        }
        const trimmedTemp = typeof ventaTempId === 'string' ? ventaTempId.trim() : '';
        if (!trimmedTemp) {
            throw new Error('Falta el identificador temporal de la venta QR');
        }
        const normalizedMonto = typeof amount === 'number' && Number.isFinite(amount) ? Math.round(amount) : 0;
        if (normalizedMonto <= 0) {
            throw new Error('Monto inválido para preparar el cobro QR');
        }
        const salePayload = buildQrSalePayloadSnapshot(normalizedMonto);
        if (!salePayload) {
            throw new Error('El carrito está vacío');
        }
        const clientTxId = generateQrClientTxId();
        const cashierName = user?.name || '';
        const clientDni = selectedCustomerDni || '';
        const payload = buildIniciarPayload({
            caja_id: cajaId,
            monto: normalizedMonto,
            venta_temp_id: trimmedTemp,
            client_tx_id: clientTxId,
            client_dni: clientDni,
            cashier_name: cashierName,
            sale_payload: salePayload,
        });
        if (!payload) {
            throw new Error('Datos inválidos para preparar el cobro QR');
        }
        // POST /iniciar: si el backend responde 2xx, guardamos la
        // preparación. Si cualquier error (red, 4xx, 5xx), lanzamos
        // para que el UPM muestre el toast y NO abra el modal hijo.
        //
        // Caso especial: si el backend responde `alreadyPaid=true` (la
        // intención asociada al ventaTempId ya quedó aprobada en una
        // sesión anterior), NO abrimos el QR. Marcamos el pending como
        // pagado en la bandeja, limpiamos el reopen payload, cerramos
        // el UPM y mostramos un toast informativo. Luego lanzamos el
        // sentinel para que el UPM aborte en silencio sin pintar error.
        const res: { alreadyPaid?: boolean; saleId?: number | string; amountCop?: number; status?: string; streamStatus?: string } = await apiFetch('/pos/pagos-qr/iniciar', {
            method: 'POST',
            body: JSON.stringify(payload),
            fallbackError: 'No se pudo preparar el cobro QR',
            timeoutMs: 10000,
        });
        const alreadyPaid = isAlreadyPaidResponse(res);
        if (alreadyPaid) {
            qrMarkPaid({ ventaTempId: trimmedTemp, saleId: alreadyPaid.saleId, amountCop: alreadyPaid.amountCop });
            qrPreparationsRef.current.delete(trimmedTemp);
            setBoldQrReopenPayload(null);
            toast({
                variant: 'default',
                title: 'YA PAGADO',
                description: alreadyPaid.saleId
                    ? `Este cobro QR ya fue aprobado (venta #${alreadyPaid.saleId}).`
                    : 'Este cobro QR ya fue aprobado en el servidor.',
            });
            setIsPaymentDialogOpen(false);
            throw new Error(BOLD_QR_ALREADY_PAID_SENTINEL);
        }
        qrPreparationsRef.current.set(trimmedTemp, {
            clientTxId,
            monto: normalizedMonto,
            salePayload,
            cashierName,
            clientDni,
        });
    }, [buildQrSalePayloadSnapshot, cajaId, isEditMode, selectedCustomerDni, user, qrMarkPaid, setIsPaymentDialogOpen, toast]);

    const handleBoldQrEnqueueRequested = useCallback(async (ventaTempId: string, monto: number) => {
        if (isEditMode) {
            throw new Error('No se puede dejar en espera un cobro en modo edición');
        }
        const trimmedTemp = typeof ventaTempId === 'string' ? ventaTempId.trim() : '';
        if (!trimmedTemp) {
            throw new Error('Falta el identificador temporal de la venta QR');
        }
        const normalizedMonto = typeof monto === 'number' && Number.isFinite(monto) ? Math.round(monto) : 0;
        if (normalizedMonto <= 0) {
            throw new Error('Monto inválido para dejar en espera');
        }

        // Reusar la preparación durable registrada al abrir el modal
        // (mismo `clientTxId` y snapshot exacto). Si no existe (p. ej.
        // reapertura desde la bandeja global, donde la intención ya
        // vive en el backend), caemos al snapshot actual del carrito
        // como defensa — el backend `/encolar` rechazará idempotentemente
        // si la intención ya está encolada.
        const stored = qrPreparationsRef.current.get(trimmedTemp);
        let clientTxId: string;
        let salePayload: QrPreparedSnapshot['salePayload'];
        let cashierName: string;
        let clientDni: string;
        if (stored) {
            clientTxId = stored.clientTxId;
            salePayload = stored.salePayload;
            cashierName = stored.cashierName;
            clientDni = stored.clientDni;
        } else {
            const fallback = buildQrSalePayloadSnapshot(normalizedMonto);
            if (!fallback) {
                throw new Error('El carrito está vacío');
            }
            clientTxId = generateQrClientTxId();
            salePayload = fallback;
            cashierName = user?.name || '';
            clientDni = selectedCustomerDni || '';
        }

        const payload = buildEncolarPayload({
            ventaTempId: trimmedTemp,
            cajaId,
            monto: normalizedMonto,
            clientTxId,
            cashierName,
            clientDni,
            salePayload,
        });
        if (!payload) {
            throw new Error('Datos inválidos para encolar el cobro QR');
        }
        // POST /encolar debe confirmar ANTES de liberar el carrito activo.
        // Si el backend falla, lanzamos y el modal pintará ERROR sin
        // tocar nada del carrito del cajero.
        //
        // Caso especial: 409 QR_INTENT_ALREADY_PAID. El backend indica
        // que la intención asociada a este ventaTempId ya fue aprobada
        // en una sesión anterior. NO es un error ruidoso: tratamos
        // como finalizado — marcamos pagado en la bandeja, cerramos
        // el UPM y liberamos el carrito activo (idempotente contra la
        // ruta modal/APPROVED). El modal hijo no debe pintar ERROR.
        try {
            await apiFetch('/pos/pagos-qr/encolar', {
                method: 'POST',
                body: JSON.stringify(payload),
                fallbackError: 'No se pudo dejar en espera el cobro QR',
                timeoutMs: 10000,
            });
        } catch (err) {
            if (isAlreadyPaidError(err)) {
                const info = (err && typeof err === 'object' && 'data' in err)
                    ? ((err as { data?: unknown }).data as { saleId?: number; amountCop?: number } | undefined)
                    : undefined;
                const saleId = typeof info?.saleId === 'number' && Number.isFinite(info.saleId) && info.saleId > 0
                    ? Math.floor(info.saleId)
                    : undefined;
                const amountCop = typeof info?.amountCop === 'number' && Number.isFinite(info.amountCop) && info.amountCop > 0
                    ? Math.round(info.amountCop)
                    : undefined;
                qrMarkPaid({ ventaTempId: trimmedTemp, saleId, amountCop });
                qrPreparationsRef.current.delete(trimmedTemp);
                toast({
                    variant: 'default',
                    title: 'YA PAGADO',
                    description: saleId
                        ? `Este cobro QR ya fue aprobado (venta #${saleId}).`
                        : 'Este cobro QR ya fue aprobado en el servidor.',
                });
                setBoldQrReopenPayload(null);
                confirmEnqueuedAndFreeCart();
                setIsPaymentDialogOpen(false);
                return;
            }
            throw err;
        }
        // Éxito: la preparación ya cumplió su rol (quedó vinculada en
        // backend). Limpiamos la entrada del Map local para no retener
        // snapshots obsoletos tras liberar el carrito.
        qrPreparationsRef.current.delete(trimmedTemp);
        toast({ title: 'QR en espera', description: 'Puedes seguir atendiendo. Avisaremos cuando el pago llegue.' });
        // Confirmado el 200: liberamos SÓLO el carrito activo + abrimos
        // uno limpio sin tocar los demás carritos abiertos.
        setBoldQrReopenPayload(null);
        confirmEnqueuedAndFreeCart();
        setIsPaymentDialogOpen(false);
        void qrTrayReconnect();
    }, [buildQrSalePayloadSnapshot, cajaId, confirmEnqueuedAndFreeCart, isEditMode, qrMarkPaid, qrTrayReconnect, selectedCustomerDni, setIsPaymentDialogOpen, toast, user]);

    // Wrapper unificado para abrir el modal de pago. En modo edición con
    // cero deltas (ninguna cantidad tocada) no tiene sentido abrir el
    // cobrador: mostramos SIN CAMBIOS y evitamos el flujo. En modo edición
    // con deltas de neto cero (mezcla de productos por igual valor) SÍ se
    // abre porque hay algo que registrar en el backend.
    const tryOpenPaymentDialog = useCallback(() => {
        if (isEditMode && !editHasChanges) {
            toast({
                variant: "default",
                title: "SIN CAMBIOS",
                description: "No hay diferencias respecto a la factura original."
            });
            return;
        }
        setIsPaymentDialogOpen(true);
    }, [isEditMode, editHasChanges, toast, setIsPaymentDialogOpen]);

    // Verificacion de caja abierta
    useEffect(() => {
        const checkRegister = async () => {
            const token = Cookies.get('org-pos-token');
            if (!token || !user?.dni) return;

        try {
            const data = await apiFetch('/dashboard/cashier-closure', { method: 'GET' }, token);
            if (data && data.activeShiftDni && data.activeShiftDni !== user.dni) {
                toast({
                    variant: "default",
                    title: "CAJA PRINCIPAL EN USO",
                    description: `Te uniste a la caja abierta por ${data.activeShiftName}`
                });
            }
        } catch (error) {
                console.error("Error comprobando estado de la caja:", error);
            }
        };

        checkRegister();
    }, [user?.dni, toast]);

    const searchRef = useRef<HTMLInputElement>(null);
    const lastKeyPressTime = useRef<number>(0);
    const isScanningRef = useRef<boolean>(false);
    const autoSubmitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // --- AUTO-SUBMIT JALTECH POS 2D: Buffer quieto 150ms = codigo completo ---
    // Jaltech omnidireccional completa un EAN-13 en ~130ms (10-15ms entre chars)
    useEffect(() => {
        if (autoSubmitTimer.current) clearTimeout(autoSubmitTimer.current);
        
        // Solo auto-enviar si detectamos que viene de un escaner (isScanningRef)
        // y tiene una longitud razonable para un codigo de barras.
        if (scannerBuffer.length >= 3 && isScanningRef.current) {
            autoSubmitTimer.current = setTimeout(() => {
                handleCodeSubmit(scannerBuffer);
                setScannerBuffer('');
                isScanningRef.current = false;
            }, 150);
        }
        return () => { if (autoSubmitTimer.current) clearTimeout(autoSubmitTimer.current); };
    }, [scannerBuffer, handleCodeSubmit, setScannerBuffer]);

    // --- REFS PARA ESTABILIDAD DE LISTENERS (V9.0) ---
    const scannerBufferRef = useRef(scannerBuffer);
    useEffect(() => { scannerBufferRef.current = scannerBuffer; }, [scannerBuffer]);

    const isModalOpenRef = useRef(false);
    useEffect(() => {
        isModalOpenRef.current = isPaymentDialogOpen || isClientDialogOpen || isScannerOpen || isManualWeightOpen || isSplitDialogOpen || isMissingItemOpen || !!editingCartItem || isProductSearchOpen || isHomeDrawerModalOpen;
    }, [isPaymentDialogOpen, isClientDialogOpen, isScannerOpen, isManualWeightOpen, isSplitDialogOpen, isMissingItemOpen, editingCartItem, isProductSearchOpen, isHomeDrawerModalOpen]);

    const selectedItemIdRef = useRef(selectedItemId);
    useEffect(() => { selectedItemIdRef.current = selectedItemId; }, [selectedItemId]);

    // --- AUTO-SCROLL CARRITO ---
    const cartScrollRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (cartScrollRef.current) {
            cartScrollRef.current.scrollTop = cartScrollRef.current.scrollHeight;
        }
    }, [currentCart.length, selectedItemId]);

    // ATAJOS DE TECLADO ESTABILIZADOS
    useEffect(() => {
        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            const now = performance.now();
            const diff = now - lastKeyPressTime.current;
            lastKeyPressTime.current = now;

            // JALTECH POS 2D Omnidireccional: rafagas de ~10-15ms entre chars
            const isFast = diff < 35;
            if (isFast) isScanningRef.current = true;

            const isSearchFocused = document.activeElement === searchRef.current;
            const isModalOpen = isModalOpenRef.current;

            // --- APERTURA MANUAL DEL CAJÓN (tecla Home) ---
            // La tecla física Home dispara el modal shadcn `HomeDrawerModal`.
            // Admin: audit-first + bridge local. Empleado: challenge OTP.
            // Guardas endurecidas vía helper puro `canCaptureHomeKey`:
            //   - no input/textarea con foco
            //   - ningún modal abierto (incluye éste; el ref evita doble-apertura)
            //   - sin buffer de escáner activo (secuencia Jaltech en curso)
            //   - sin pantalla de éxito ni envíos en progreso
            //   - `e.repeat` filtra autorepeat del SO si el cajero deja la
            //     tecla pulsada por error.
            if (e.key === 'Home') {
                const activeElement = document.activeElement;
                const isInput = activeElement instanceof HTMLInputElement
                    || activeElement instanceof HTMLTextAreaElement
                    || (activeElement instanceof HTMLElement && activeElement.isContentEditable);
                const canOpenDrawerModal = canCaptureHomeKey({
                    isInputFocused: isSearchFocused || isInput,
                    isModalOpen,
                    hasScannerBuffer: scannerBufferRef.current.length > 0,
                    showSuccessScreen,
                    isSubmitting: submitting,
                    isHomeRepeat: e.repeat,
                });
                if (canOpenDrawerModal) {
                    e.preventDefault();
                    setIsHomeDrawerModalOpen(true);
                }
                return;
            }

            // REGLA DE ORO: Pausar motor global en busqueda o modales
            if (isSearchFocused && e.key !== 'Escape' && e.key !== 'Enter') return;
            if (isModalOpen && e.key !== 'Escape') return;

            // --- MOTOR DE CAJA ZERO-FRICTION ---
            if (['-', '+', '*'].includes(e.key) || e.key === 'NumpadAdd') {
                e.preventDefault();

                if (e.key === '-') {
                    if (selectedItemIdRef.current) updateQuantity(selectedItemIdRef.current, -1);
                } else if (e.key === '+' || e.key === 'NumpadAdd') {
                    if (scannerBufferRef.current.length > 0) {
                        addMiscItem(scannerBufferRef.current);
                    } else if (searchQuery.length > 0) {
                        addMiscItem(searchQuery);
                    } else if (selectedItemIdRef.current) {
                        updateQuantity(selectedItemIdRef.current, 1);
                    }
                } else if (e.key === '*') {
                    if (scannerBufferRef.current.length > 0 && selectedItemIdRef.current) {
                        const newQty = parseFloat(scannerBufferRef.current);
                        if (!isNaN(newQty) && newQty > 0) {
                            setCartItemQuantity(selectedItemIdRef.current, newQty);
                            setScannerBuffer('');
                        }
                    }
                }
                return;
            }

            if (e.key === 'Backspace') {
                const activeElement = document.activeElement;
                const isInput = activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement;

                if (scannerBufferRef.current.length > 0) {
                    setScannerBuffer(prev => prev.slice(0, -1));
                    e.preventDefault();
                } else if (!isInput) {
                    // Prevenir que el navegador vaya hacia atras
                    e.preventDefault();
                }
                return;
            }

            if (e.key === 'Enter') {
                if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

                if (showSuccessScreen) {
                    e.preventDefault();
                    setShowSuccessScreen(false);
                    return;
                }
                if (scannerBufferRef.current.length > 0) {
                    e.preventDefault();
                    if (autoSubmitTimer.current) clearTimeout(autoSubmitTimer.current);
                    handleCodeSubmit(scannerBufferRef.current);
                    setScannerBuffer('');
                    isScanningRef.current = false;
                    return;
                }
            }

            if (e.key === ' ' || e.key === '=') {
                e.preventDefault();
                if (currentCart.length > 0 && scannerBufferRef.current.length === 0) {
                    tryOpenPaymentDialog();
                }
                return;
            }

            if (e.key === 'Escape') {
                if (showSuccessScreen) {
                    setShowSuccessScreen(false);
                } else {
                    if (!submitting) setIsPaymentDialogOpen(false);
                    setIsClientDialogOpen(false);
                    setIsScannerOpen(false);
                    setIsManualWeightOpen(false);
                    setIsSplitDialogOpen(false);
                    setIsMissingItemOpen(false);
                    setEditingCartItem(null);
                    setIsProductSearchOpen(false);
                    setIsHomeDrawerModalOpen(false);
                }
                setScannerBuffer('');
                isScanningRef.current = false;
                if (isSearchFocused) searchRef.current?.blur();
                return;
            }

            if (e.key === 'PageUp') {
                e.preventDefault();
                setIsClientDialogOpen(true);
                return;
            }

            if (e.key === 'PageDown') {
                e.preventDefault();
                if (currentCart.length > 0) setIsSplitDialogOpen(true);
                return;
            }

            if (e.key === 'Insert') {
                e.preventDefault();
                setScannerBuffer('');
                setIsProductSearchOpen(true);
                return;
            }

            if (e.key === ' ') {
                e.preventDefault();
                if (scannerBufferRef.current.length > 0) {
                    if (autoSubmitTimer.current) clearTimeout(autoSubmitTimer.current);
                    handleCodeSubmit(scannerBufferRef.current);
                    setScannerBuffer('');
                    isScanningRef.current = false;
                    setTimeout(() => tryOpenPaymentDialog(), 80);
                } else if (currentCart.length > 0) {
                    tryOpenPaymentDialog();
                }
                return;
            }

            const isAlphanumeric = /^[a-zA-Z0-9.\-_/]$/.test(e.key);
            if (isAlphanumeric || isFast) {
                if (isFast || (!isSearchFocused && !isModalOpen)) {
                    if (isAlphanumeric) {
                        setScannerBuffer(prev => prev + e.key);
                        if (!isFast) isScanningRef.current = false;
                    }
                }
            }
        };

        window.addEventListener('keydown', handleGlobalKeyDown);

        const handleGlobalClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
            if (!isInput && !isModalOpenRef.current) {
                if (target.closest('button')) target.closest('button')?.blur();
                setTimeout(returnFocusToScanner, 50);
            }
        };

        window.addEventListener('mousedown', handleGlobalClick);

        return () => {
            window.removeEventListener('keydown', handleGlobalKeyDown);
            window.removeEventListener('mousedown', handleGlobalClick);
        };
    }, [handleCodeSubmit, addMiscItem, updateQuantity, setCartItemQuantity, removeFromCart, currentCart.length, showSuccessScreen, returnFocusToScanner, setIsPaymentDialogOpen, setShowSuccessScreen, setIsClientDialogOpen, setIsScannerOpen, setIsManualWeightOpen, setIsSplitDialogOpen, setIsMissingItemOpen, searchQuery, tryOpenPaymentDialog]);

    if (loading) {
        return (
            <div className="flex h-full w-full items-center justify-center bg-zinc-50 dark:bg-[#09090b]">
                <Spinner size="lg" color="success" />
            </div>
        );
    }

    const subtotal = total / 1.19;
    const iva = total - subtotal;

    return (
        <div className="flex flex-col flex-1 min-h-0 h-full w-full overflow-hidden select-none p-1 gap-1 relative z-10" style={{ backgroundColor: '#09090b' }}>
            {/* INPUT INVISIBLE PARA CAPTURA DE ESCÃƒÂNER FÃƒÂSICO */}
            <input
                ref={hiddenScannerRef}
                type="text"
                autoComplete="off"
                inputMode="none"
                className="absolute opacity-0 pointer-events-none scanner-gate"
                style={{ position: 'absolute', left: '-9999px', top: '0' }}
                tabIndex={-1}
            />

            <div id="pos-main-container" className="flex flex-col gap-1 overflow-y-auto md:overflow-hidden custom-scrollbar relative flex-1 min-h-0 h-full w-full">
                {/* SECCIÃƒâ€œN SUPERIOR: CARRITO + NUMERIC PAD */}
                <div className="flex-[1.6] flex flex-col lg:flex-row gap-1 min-h-0 overflow-y-auto md:overflow-hidden custom-scrollbar">
                    {pendingReturn && (
                        <div className={`border px-4 py-2 flex items-center justify-between text-xs font-bold uppercase tracking-widest animate-in fade-in slide-in-from-top-2 rounded-xl mb-1 ${
                            pendingReturn.originalPaymentMethod && pendingReturn.originalPaymentMethod !== 'EFECTIVO' && pendingReturn.originalPaymentMethod !== 'CAJA'
                            ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                            : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                        }`}>
                            <div className="flex flex-col md:flex-row md:items-center gap-1">
                                <span>DEVOLUCIÓN EN CURSO - Saldo a favor: ${(pendingReturn.totalDev || 0).toLocaleString('es-CO')}</span>
                                {pendingReturn.originalPaymentMethod && pendingReturn.originalPaymentMethod !== 'EFECTIVO' && pendingReturn.originalPaymentMethod !== 'CAJA' && (
                                    <span className="text-[10px] text-amber-500 bg-amber-500/20 px-2 py-0.5 rounded-md font-extrabold tracking-tight">
                                        ⚠️ PAGO EN {pendingReturn.originalPaymentMethod} (DEBE LLEVAR PRODUCTOS, NO HAY CAMBIO EN EFECTIVO)
                                    </span>
                                )}
                            </div>
                            <Button 
                                size="sm" 
                                variant="light" 
                                color="danger" 
                                onPress={cancelPendingReturn}
                                className="h-6 min-w-0 px-2 rounded-md shrink-0"
                            >
                                CANCELAR
                            </Button>
                        </div>
                    )}
                    {/* PANEL IZQUIERDO: CARRITO */}
                    <div className="flex-1 flex flex-col rounded-2xl border border-gray-200 dark:border-white/5 card-base overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.12)] min-h-0">
                        <div className="bg-gray-50 dark:bg-[#18181b]/50 border-b border-gray-200 dark:border-white/5 p-2 shrink-0 flex items-center gap-2 min-w-0">
                            {/* Facturas: una sola fila con scroll horizontal. Nunca
                                se apilan ni empujan las acciones hacia abajo. */}
                            <div className="flex-1 min-w-0 overflow-x-auto overscroll-contain custom-scrollbar">
                                <div className="flex items-center flex-nowrap gap-1.5 w-max pr-1">
                                    {splitCartTabs(cartKeys, activeCartKey).visible.map((key) => {
                                        const isActive = activeCartKey === key;
                                        const custDni = cartCustomers[key] || '0';
                                        const cust = customers.find(c => c.dni === custDni);
                                        const custName = cust && cust.dni !== '0' ? cust.name.split(' ')[0] : '';
                                        return (
                                            <div key={key} className="group relative flex items-center shrink-0">
                                                <Button size="sm" variant="flat" className={`h-8 pl-2.5 pr-7 rounded-2xl font-medium text-[10px] sm:text-[11px] transition-all border ${isActive ? 'bg-emerald-500 text-white border-emerald-400 shadow-[0_8px_30px_rgb(0,0,0,0.12)] ' : 'bg-white dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 border-gray-200 dark:border-white/5 hover:bg-gray-50 dark:hover:bg-zinc-700'}`} onPress={() => handleCartSwitch(key)}>
                                                    <span>{key.replace('Factura ', 'F')}</span>
                                                    {custName && <span className={`ml-1 text-[8px] font-bold truncate max-w-[50px] ${isActive ? 'text-white/80' : 'text-zinc-900 dark:text-zinc-100'}`}>{custName}</span>}
                                                </Button>
                                                {cartKeys.length > 1 ? (
                                                    <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); deleteCart(key); }} className={`absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded transition-all z-20 ${isActive ? 'text-white/60 hover:text-white hover:bg-white/20' : 'text-gray-300 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 opacity-0 group-hover:opacity-100'}`}>
                                                        <Trash2 size={10} />
                                                    </button>
                                                ) : null}
                                            </div>
                                        );
                                    })}
                                    {(() => {
                                        const { overflow } = splitCartTabs(cartKeys, activeCartKey);
                                        if (overflow.length === 0) return null;
                                        return (
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <button
                                                        type="button"
                                                        aria-label={`Ver ${overflow.length} facturas más`}
                                                        className="h-8 shrink-0 rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-zinc-800 px-3 text-[11px] font-bold text-gray-600 dark:text-zinc-300 hover:bg-gray-50 dark:hover:bg-zinc-700"
                                                    >
                                                        +{overflow.length} ▾
                                                    </button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="start" className="w-64 max-h-80 overflow-y-auto overscroll-contain">
                                                    <DropdownMenuLabel className="text-[10px] uppercase tracking-widest">Otras facturas</DropdownMenuLabel>
                                                    <DropdownMenuSeparator />
                                                    {overflow.map((key) => {
                                                        const custDni = cartCustomers[key] || '0';
                                                        const cust = customers.find(c => c.dni === custDni);
                                                        const custName = cust && cust.dni !== '0' ? cust.name : 'Consumidor final';
                                                        const units = countCartUnits(carts[key] || []);
                                                        return (
                                                            <DropdownMenuItem
                                                                key={key}
                                                                onSelect={() => handleCartSwitch(key)}
                                                                className="flex items-center justify-between gap-3 cursor-pointer"
                                                            >
                                                                <span className="flex min-w-0 flex-col">
                                                                    <span className="font-bold text-xs">{key.replace('Factura ', 'F')}</span>
                                                                    <span className="truncate text-[10px] text-zinc-500">{custName}</span>
                                                                </span>
                                                                <span className="shrink-0 text-[10px] font-semibold tabular-nums text-zinc-500">
                                                                    {units} art.
                                                                </span>
                                                            </DropdownMenuItem>
                                                        );
                                                    })}
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        );
                                    })()}
                                    <Button isIconOnly size="sm" variant="light" className="h-8 w-8 min-w-8 rounded-2xl text-zinc-900 dark:text-zinc-100 bg-emerald-50 dark:bg-emerald-500/5 hover:bg-emerald-500 hover:text-white transition-all shrink-0 border border-dashed border-emerald-200 dark:border-emerald-500/20" onPress={addNewCart}>
                                        <Plus size={20} strokeWidth={2.5} />
                                    </Button>
                                </div>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                                {/* Bandeja QR inline: debe vivir en esta barra visible,
                                    junto a Catálogo/Sincro/Cliente. El montaje fixed
                                    anterior quedaba debajo de la cabecera global y el
                                    panel derecho aunque tuviera z-index. */}
                                <BoldQrTrayPopover
                                    pendings={qrPendings}
                                    unassignedPayments={qrUnassigned}
                                    latestError={qrTrayError}
                                    latestUnassignedError={qrUnassignedError}
                                    onReopen={handleReopenPending}
                                    onDismiss={qrDismissIntent}
                                    onReconnect={qrTrayReconnect}
                                    onReloadUnassigned={qrReloadUnassigned}
                                    onAssign={qrAssignPayment}
                                    canConfirmManual={isAdminUser(user)}
                                    onConfirmManual={qrConfirmManual}
                                />

                                {/* CANTIDAD DE PRODUCTOS EN MEMORIA / CACHÉ */}
                                <div className="hidden 2xl:flex items-center gap-1.5 px-2 py-1 rounded-2xl border border-zinc-200 dark:border-white/5 bg-zinc-100 dark:bg-zinc-800/80 text-zinc-900 dark:text-zinc-100 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                                    <Package className="h-3 w-3 text-emerald-500" />
                                    <div className="flex flex-col leading-none text-right">
                                        <span className="text-[7px] font-bold uppercase tracking-widest leading-none text-zinc-400">Catálogo</span>
                                        <span className="text-[9px] font-bold font-mono">{products.length} PRODS</span>
                                    </div>
                                </div>

                                {/* RESILIENCIA DE RED: INDICADOR HFT */}
                                <div 
                                    onClick={() => syncOfflineQueue()}
                                    className={`flex items-center gap-1.5 px-2 py-1 rounded-2xl border shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all cursor-pointer active:scale-95 ${isOffline || syncQueueCount > 0 ? 'bg-rose-50 dark:bg-rose-500/10 border-rose-200 dark:border-rose-500/20 text-rose-600' : 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 dark:bg-white/5 border-emerald-200 dark:border-emerald-500/20 text-zinc-900 dark:text-zinc-100'}`}
                                >
                                    {isOffline ? <WifiOff className="h-3 w-3" /> : <Wifi className="h-3 w-3 animate-pulse" />}
                                    <div className="flex flex-col leading-none text-right">
                                        <span className="text-[7px] font-bold uppercase tracking-widest leading-none">{isOffline ? 'Sin Red' : syncQueueCount > 0 ? 'Pendiente' : 'Sincro'}</span>
                                        <span className="text-[9px] font-medium">{isOffline ? 'OFFLINE' : syncQueueCount > 0 ? `${syncQueueCount} VENTAS` : 'ONLINE'}</span>
                                    </div>
                                </div>

                                <div onClick={handleScaleSync} className={`flex items-center gap-1.5 sm:gap-2 px-1.5 sm:px-2 py-1 rounded-2xl border shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all cursor-pointer active:scale-95 ${isScaleReloading ? 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/20 text-amber-600 animate-pulse' : isScaleOnline ? 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 dark:bg-white/5 border-emerald-200 dark:border-emerald-500/20 text-zinc-900 dark:text-zinc-100 dark:text-zinc-100 hover:bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5' : 'bg-gray-100 dark:bg-zinc-800 border-gray-200 dark:border-white/10 text-zinc-500 dark:text-zinc-400 opacity-50'}`}>
                                    <Scale className={`h-3 w-3 ${isScaleOnline && !isScaleReloading ? 'animate-pulse' : ''}`} />
                                    <div className="flex flex-col leading-none text-right">
                                        <span className="hidden sm:block text-[7px] font-bold uppercase tracking-widest leading-none">{isScaleReloading ? 'Esperando...' : isScaleOnline ? 'Sincronizar' : 'Offline'}</span>
                                        <span className="text-[9px] sm:text-[10px] font-medium tabular-nums">{isScaleReloading ? '---' : isScaleOnline ? `${scaleWeight.toFixed(3)} kg` : '---'}</span>
                                    </div>
                                </div>
                                <Button size="sm" variant="flat" aria-label="Seleccionar cliente (Re Pág)" title="Cliente (Re Pág)" onPress={() => setIsClientDialogOpen(true)} className="h-8 min-w-8 px-2 xl:px-3 rounded-2xl font-bold text-[10px] uppercase bg-sky-50 dark:bg-sky-500/10 text-sky-600 dark:text-sky-500 hover:bg-sky-100 border border-sky-200 dark:border-sky-500/20">
                                    <User size={18} strokeWidth={2.5} className="xl:mr-1" />
                                    <span className="hidden xl:inline tracking-tight">Cliente</span>
                                    <span className="hidden 2xl:inline ml-1 opacity-70">(Re Pág)</span>
                                </Button>
                                <Button size="sm" variant="flat" aria-label="Dividir factura (Av Pág)" title="Dividir (Av Pág)" onPress={() => setIsSplitDialogOpen(true)} isDisabled={currentCart.length === 0} className="h-8 min-w-8 px-2 xl:px-3 rounded-2xl font-bold text-[10px] uppercase bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-500 hover:bg-amber-100 border border-amber-200 dark:border-amber-500/20">
                                    <Grid size={18} strokeWidth={2.5} className="xl:mr-1" />
                                    <span className="hidden xl:inline">Dividir</span>
                                    <span className="hidden 2xl:inline ml-1 opacity-70">(Av Pág)</span>
                                </Button>
                                <Button size="sm" variant="flat" aria-label="Buscar producto (Insert)" title="Buscar producto (Insert)" onPress={() => setIsProductSearchOpen(true)} className="h-8 min-w-8 px-2 xl:px-3 rounded-2xl font-bold text-[10px] uppercase bg-purple-50 dark:bg-purple-500/10 text-purple-600 dark:text-purple-500 hover:bg-purple-100 border border-purple-200 dark:border-purple-500/20">
                                    <Search size={18} strokeWidth={2.5} className="xl:mr-1" />
                                    <span className="hidden xl:inline">Buscar</span>
                                    <span className="hidden 2xl:inline ml-1 opacity-70">(Insert)</span>
                                </Button>
                            </div>
                        </div>

                        <div className="flex-1 overflow-hidden flex flex-col min-h-0 card-base">
                            <div ref={cartScrollRef} className="flex-1 overflow-y-auto custom-scrollbar px-1 [scrollbar-gutter:stable]">
                                <Table
                                    aria-label="Carrito"
                                    isCompact
                                    selectionMode="none"
                                    classNames={{
                                        th: "bg-gray-50 dark:bg-zinc-800/80 text-gray-500 font-bold uppercase text-[8px] sm:text-[9px] tracking-widest sticky top-0 z-10 border-b border-gray-200 h-7 sm:h-8 py-0.5 sm:py-1",
                                        td: "py-0.5 sm:py-1 font-medium border-b border-gray-100 dark:border-white/5",
                                        tr: "hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer transition-colors group"
                                    }}
                                >
                                    <TableHeader>
                                        <TableColumn>
                                            ARTÍCULO
                                            <span
                                                aria-label={`${countCartUnits(currentCart)} artículos en la venta`}
                                                className="ml-2 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold text-emerald-600 dark:text-emerald-400 tabular-nums"
                                            >
                                                {countCartUnits(currentCart)} {countCartUnits(currentCart) === 1 ? 'artículo' : 'artículos'}
                                            </span>
                                        </TableColumn>
                                        <TableColumn align="center">PVP</TableColumn>
                                        <TableColumn align="center">CANT</TableColumn>
                                        <TableColumn align="end">TOTAL</TableColumn>
                                        <TableColumn align="center" width={30}> </TableColumn>
                                    </TableHeader>
                                    <TableBody emptyContent={<div className="py-10 text-gray-400 text-xs font-bold uppercase tracking-widest text-center">Carrito vacío</div>}>
                                        {currentCart.map((item) => (
                                            <TableRow 
                                                key={item.cartItemId} 
                                                onClick={() => setSelectedItemId(item.cartItemId)}
                                                className={selectedItemId === item.cartItemId ? 'bg-zinc-100 dark:bg-zinc-800 border-l-4 border-emerald-500 font-bold' : ''}
                                            >
                                                <TableCell>
                                                    <div className="text-[10px] sm:text-[11px] font-bold text-zinc-900 dark:text-zinc-50 uppercase leading-tight truncate max-w-[100px] sm:max-w-none">{item.productName}</div>
                                                    <div className="text-[8px] sm:text-[9px] text-zinc-500 dark:text-zinc-400 font-mono">{item.barcode}</div>
                                                </TableCell>
                                                <TableCell className="text-center text-gray-600 dark:text-zinc-400 text-[11px] tabular-nums">${formatCurrency(item.salePrice)}</TableCell>
                                                <TableCell className="text-center">
                                                    <span className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-zinc-900 dark:text-zinc-100 font-bold text-[11px] px-2 py-0.5 rounded tabular-nums">
                                                        {item.cartQuantity}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="text-right font-medium text-zinc-900 dark:text-zinc-100 dark:text-zinc-100 text-xs tabular-nums">${formatCurrency(roundSaleLineSubtotal(Number(item.salePrice), item.cartQuantity))}</TableCell>
                                                <TableCell className="text-center p-0">
                                                    <div onClick={(e) => e.stopPropagation()} className="flex items-center justify-center gap-1">
                                                        <Button isIconOnly color="primary" variant="light" size="sm" className="h-6 w-6 min-w-6 hover:bg-emerald-100" onPress={() => setEditingCartItem(item)}>
                                                            <Edit2 size={16} className="text-emerald-500" strokeWidth={2.5} />
                                                        </Button>
                                                        {!item.isPreexisting && (
                                                            <Button isIconOnly color="danger" variant="light" size="sm" className="h-6 w-6 min-w-6 hover:bg-rose-100" onPress={() => { removeFromCart(item.cartItemId); returnFocusToScanner(); }}>
                                                                <Trash2 size={16} className="text-rose-500" strokeWidth={2.5} />
                                                            </Button>
                                                        )}
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </div>
                        </div>

                        <div className="bg-gray-50 dark:bg-[#18181b] p-2 flex items-center justify-between shrink-0 border-t border-gray-200 dark:border-white/5 gap-2">
                            <div className="flex gap-4 px-2">
                                <div className="flex flex-col text-left">
                                    <span className="text-[9px] font-bold text-gray-500 uppercase tracking-widest leading-none">Subtotal</span>
                                    <span className="text-xs font-medium text-gray-700 dark:text-zinc-300 tabular-nums">${formatCurrency(subtotal)}</span>
                                </div>
                                <div className="flex flex-col text-left">
                                    <span className="text-[9px] font-bold text-gray-500 uppercase tracking-widest leading-none">IVA</span>
                                    <span className="text-xs font-medium text-gray-700 dark:text-zinc-300 tabular-nums">${formatCurrency(iva)}</span>
                                </div>
                            </div>
                            <div className="bg-zinc-100 dark:bg-zinc-800 border border-emerald-200 dark:border-emerald-500/20 px-4 py-1.5 rounded-2xl flex items-center gap-3 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                                <div className="flex flex-col text-right">
                                    <p className="text-[9px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-widest leading-none">
                                        {isEditMode ? "TOTAL FACTURA" : "TOTAL"}
                                    </p>
                                    {isEditMode && editHasChanges && (
                                        editDeltaTotal > 0 ? (
                                            <span
                                                className="text-[10px] font-bold text-emerald-500 font-mono mt-0.5"
                                                aria-label={`Cobro adicional al cliente: ${formatCurrency(editDeltaTotal)} pesos`}
                                            >
                                                +${formatCurrency(editDeltaTotal)} adicional
                                            </span>
                                        ) : editDeltaTotal < 0 ? (
                                            <span
                                                className="text-[10px] font-bold text-rose-500 font-mono mt-0.5"
                                                aria-label={`Devolución al cliente: ${formatCurrency(Math.abs(editDeltaTotal))} pesos`}
                                            >
                                                -${formatCurrency(Math.abs(editDeltaTotal))} a devolver
                                            </span>
                                        ) : (
                                            <span
                                                className="text-[10px] font-bold text-sky-500 font-mono mt-0.5"
                                                aria-label="Ajuste sin cobro adicional (mezcla de productos por igual valor)"
                                            >
                                                Ajuste sin cobro
                                            </span>
                                        )
                                    )}
                                </div>
                                <div className="text-2xl font-medium text-zinc-900 dark:text-zinc-50 tabular-nums leading-none tracking-tighter flex overflow-hidden h-7 items-center">
                                    <span className="mr-1">$</span>
                                    <AnimatePresence mode="wait">
                                        <motion.span
                                            key={total}
                                            initial={{ y: 10, opacity: 0 }}
                                            animate={{ y: 0, opacity: 1 }}
                                            exit={{ y: -10, opacity: 0 }}
                                            transition={{ duration: 0.15, ease: "easeOut" }}
                                        >
                                            {formatCurrency(total)}
                                        </motion.span>
                                    </AnimatePresence>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* PANEL DERECHO: TECLADO Y ESCÁNER */}
                    <aside className="w-full lg:w-[280px] xl:w-[300px] flex flex-col shrink-0 min-h-[360px] lg:min-h-0">
                        <div className="flex-1 card-base rounded-2xl p-2.5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex flex-col gap-2 border border-gray-200 dark:border-white/5 overflow-hidden min-h-0">
                            <div className="flex items-center gap-1.5 bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-white/5 px-2 py-1 rounded-xl shadow-inner h-11 shrink-0">
                                <Barcode className="h-4 w-4 text-zinc-900 dark:text-zinc-100 shrink-0" />
                                <div className="relative flex-1 min-w-0 h-8 flex items-center px-1">
                                    <div className="font-mono font-bold text-xs text-gray-900 dark:text-zinc-100 bg-transparent flex-1 truncate">
                                        {scannerBuffer || (feedbackCode ? "" : "ESPERANDO ESCÁNER...")}
                                    </div>
                                    {!scannerBuffer && feedbackCode && (
                                        <div className={`absolute left-0 pointer-events-none font-mono font-bold text-xs tracking-tight ${isFeedbackError ? 'text-rose-400 font-black' : 'text-zinc-900 dark:text-zinc-100/50'} animate-out fade-out duration-1000 fill-mode-forwards`}>
                                            {isFeedbackError ? 'NO EXISTE: ' : 'VISTO: '}{feedbackCode}
                                        </div>
                                    )}
                                </div>
                                <Button aria-label="Abrir cámara para escanear" isIconOnly size="sm" variant="flat" className="h-8 w-8 min-w-8 rounded-lg bg-emerald-100 dark:bg-white/5 text-emerald-600 dark:text-zinc-100 hover:bg-emerald-500 hover:text-white transition-colors" onPress={() => { setIsScannerOpen(true); returnFocusToScanner(); }}>
                                    <Camera className="h-3.5 w-3.5" />
                                </Button>
                                <Button aria-label="Reportar producto no encontrado" isIconOnly size="sm" variant="flat" className="h-8 w-8 min-w-8 rounded-lg bg-rose-100 dark:bg-rose-500/20 text-rose-600 dark:text-rose-500 hover:bg-rose-500 hover:text-white transition-colors" onPress={() => { setIsMissingItemOpen(true); returnFocusToScanner(); }}>
                                    <AlertTriangle className="h-3.5 w-3.5" />
                                </Button>
                            </div>

                            {/* Operaciones separadas del bloque numérico para que
                                ninguna tecla se estire según el alto disponible. */}
                            <div role="group" aria-label="Operaciones rápidas" className="grid grid-cols-4 gap-2 h-12 shrink-0">
                                <Button aria-label="Limpiar entrada" color="danger" variant="flat" className="h-12 min-w-0 rounded-xl font-bold text-xs border border-rose-500/20" onPress={() => { setScannerBuffer(''); returnFocusToScanner(); }}>CE</Button>
                                <Button aria-label="Multiplicar cantidad" variant="flat" className="h-12 min-w-0 rounded-xl font-bold text-lg bg-gray-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 border border-gray-200 dark:border-white/5" onPress={() => { setScannerBuffer(p => p + '*'); returnFocusToScanner(); }}>*</Button>
                                <Button aria-label="Restar una unidad" variant="flat" className="h-12 min-w-0 rounded-xl font-bold text-xl bg-gray-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 border border-gray-200 dark:border-white/5 leading-none" onPress={() => { if (selectedItemId) updateQuantity(selectedItemId, -1); returnFocusToScanner(); }}>−</Button>
                                <Button aria-label="Sumar una unidad" variant="flat" className="h-12 min-w-0 rounded-xl font-bold text-xl bg-gray-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 border border-gray-200 dark:border-white/5 leading-none" onPress={() => {
                                    if (selectedItemId) {
                                        updateQuantity(selectedItemId, 1);
                                    }
                                    returnFocusToScanner();
                                }}>+</Button>
                            </div>

                            <div role="group" aria-label="Teclado numérico de ventas" className="grid grid-cols-3 grid-rows-4 gap-2 flex-1 min-h-0">
                                {['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '.'].map(n => (
                                    <Button
                                        key={n}
                                        aria-label={n === '.' ? 'Punto decimal' : `Número ${n}`}
                                        variant="bordered"
                                        className={`h-full min-h-[44px] min-w-0 rounded-xl text-lg font-bold bg-gray-50 dark:bg-zinc-950 border-gray-200 dark:border-white/5 text-zinc-900 dark:text-zinc-50 hover:border-emerald-500 active:scale-[0.97] ${n === '0' ? 'col-span-2' : ''}`}
                                        onPress={() => { setScannerBuffer(p => p + n); returnFocusToScanner(); }}
                                    >
                                        {n}
                                    </Button>
                                ))}
                            </div>

                            <Button
                                aria-label={scannerBuffer.length > 0 ? "Procesar código ingresado" : "Abrir cobro de la venta"}
                                className="w-full h-14 min-h-14 shrink-0 rounded-xl font-bold text-base tracking-wide text-white bg-emerald-600 hover:bg-emerald-500 dark:bg-emerald-500 dark:hover:bg-emerald-400 shadow-[0_8px_24px_rgb(16,185,129,0.22)] active:scale-[0.98]"
                                onPress={() => {
                                    if (scannerBuffer.length > 0) {
                                        handleCodeSubmit(scannerBuffer);
                                        setScannerBuffer('');
                                    } else if (currentCart.length > 0) {
                                        tryOpenPaymentDialog();
                                    }
                                    returnFocusToScanner();
                                }}
                                isDisabled={currentCart.length === 0 && scannerBuffer.length === 0}
                            >
                                <span className="text-xl leading-none" aria-hidden>=</span>
                                <span>{scannerBuffer.length > 0 ? 'PROCESAR' : 'COBRAR'}</span>
                            </Button>
                        </div>
                    </aside>
                </div>

                {/* SECCIÃƒâ€œN INFERIOR: CATEGORÃƒÂ AS Y PRODUCTOS Ã¢â‚¬â€  flex-1 con altura mÃƒÂ­nima para no colapsar */}
                <div className="flex-1 w-full shrink-0 flex gap-1 card-base rounded-2xl p-1 border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] border-t border-white/10" style={{ minHeight: '320px' }}>
                    <aside className="w-28 shrink-0 flex flex-col gap-1 overflow-y-auto custom-scrollbar pr-1">
                        <Button size="md" className={`justify-start h-10 min-h-[40px] rounded-2xl font-bold text-[11px] px-3 ${selectedCategory === 'all' ? 'bg-emerald-500 text-white shadow-md' : 'bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-400 hover:bg-gray-200'}`} onPress={() => { setSelectedCategory('all'); returnFocusToScanner(); }}>TODOS</Button>
                        {categories.map(cat => (
                            <Button key={cat.id} size="md" className={`justify-start h-10 min-h-[40px] rounded-2xl font-bold text-[11px] uppercase truncate px-3 ${selectedCategory === String(cat.id) ? 'bg-emerald-500 text-white shadow-md' : 'bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-400 hover:bg-gray-200'}`} onPress={() => { setSelectedCategory(String(cat.id)); returnFocusToScanner(); }}>{cat.name}</Button>
                        ))}
                    </aside>

                    <section className="flex-1 flex flex-col overflow-hidden min-h-0 bg-gray-50 dark:bg-zinc-950 rounded-2xl border border-gray-200 dark:border-white/5">
                        <ProductGrid
                            products={filteredProductsGrid}
                            addToCart={(p) => { addToCart(p); }}
                        />
                    </section>
                </div>
            </div>

            {/* MODALES DINÁMICOS */}

            {/* AlertDialog grande (shadcn) cuando un QR pendiente se aprueba
                post-commit. Se muestra una sola vez por ventaTempId/saleId
                (dedupe en useBoldQrTray + Set defensivo en esta pantalla).
                NO explica printing: el backend SaleService materializa la
                venta canónica y emite su tirilla; aquí sólo notificamos. */}
            <AlertDialog
                open={!!qrApprovedAlert}
                onOpenChange={(open) => { if (!open) setQrApprovedAlert(null); }}
            >
                <AlertDialogContent
                    data-testid="bold-qr-approved-dialog"
                    className="border-2 border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 shadow-[0_18px_60px_rgb(16,185,129,0.35)] rounded-2xl sm:max-w-xl"
                >
                    <AlertDialogHeader className="items-center text-center space-y-3">
                        <div
                            aria-hidden
                            className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500 text-white shadow-[0_12px_40px_rgb(16,185,129,0.45)]"
                        >
                            <CheckCircle2 className="h-12 w-12" strokeWidth={2.5} />
                        </div>
                        <AlertDialogTitle className="text-3xl md:text-4xl font-bold uppercase tracking-tight text-emerald-700 dark:text-emerald-300">
                            TRANSFERENCIA RECIBIDA
                        </AlertDialogTitle>
                        <AlertDialogDescription asChild>
                            <div className="flex flex-col items-center gap-1 text-emerald-900 dark:text-emerald-100">
                                <p
                                    data-testid="bold-qr-approved-amount"
                                    className="text-6xl md:text-7xl font-black tabular-nums tracking-tight leading-none"
                                >
                                    ${qrApprovedAlert?.amountCop ? formatCurrency(qrApprovedAlert.amountCop) : ''}
                                </p>
                                {qrApprovedAlert?.cashierName ? (
                                    <p className="text-sm font-semibold uppercase tracking-wider text-emerald-700/80 dark:text-emerald-200/80">
                                        {qrApprovedAlert.cashierName}
                                    </p>
                                ) : null}
                                {qrApprovedAlert?.reference ? (
                                    <p className="text-xs font-mono text-emerald-800/70 dark:text-emerald-200/70">
                                        Ref. {qrApprovedAlert.reference}
                                    </p>
                                ) : null}
                                {qrApprovedAlert?.saleId !== undefined ? (
                                    <p className="text-[11px] font-mono uppercase tracking-wider text-emerald-800/70 dark:text-emerald-200/70">
                                        Venta #{qrApprovedAlert.saleId}
                                    </p>
                                ) : null}
                            </div>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogAction
                            onClick={() => setQrApprovedAlert(null)}
                            className="h-12 w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm uppercase tracking-wide rounded-xl"
                        >
                            Entendido
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <UniversalPaymentModal 
                isOpen={isPaymentDialogOpen}
                onOpenChange={(open) => { if (!open && submitting) return; setIsPaymentDialogOpen(open); }}
                title={
                    isEditMode
                        ? (editMode === 'charge'
                            ? "COBRO ADICIONAL"
                            : editMode === 'refund'
                            ? "DEVOLUCIÓN / AJUSTE"
                            : editMode === 'neutral'
                            ? "AJUSTE SIN COBRO"
                            : "Cobrar Venta")
                        : "Cobrar Venta"
                }
                client={selectedCustomer} 
                totalToPay={
                    isEditMode
                        ? Math.abs(editDeltaTotal)
                        : total
                }
                // En modo edición mantenemos el flujo del modal totalmente
                // aislado del "pendingReturn" (que es para intercambios de
                // devolución de ventas previas). Aquí lo importante es que
                // el cajero elija canal (efectivo/Nequi/Daviplata) para el
                // cobro o el reembolso, y el signo se aplica al enviar.
                pendingReturnAmount={
                    isEditMode ? 0 : (pendingReturn?.totalDev || 0)
                }
                originalPaymentMethod={pendingReturn?.originalPaymentMethod || 'EFECTIVO'}
                flowType={isEditMode && editMode === 'refund' ? 'out' : 'in'}
                showSuccessScreen={showSuccessScreen} 
                submittingPayment={submitting} 
                lastChange={lastChange} 
                lastReceipt={lastReceipt}
                onPay={async (paymentData) => {
                    await handleConfirmSale(paymentData, pendingReturn);
                }} 
                // QR Bold / Bre-B: habilita el método en la grilla. El
                // UniversalPaymentModal gestiona internamente el modal
                // hijo (ModalPagoBoldQR); el padre pre-registra la
                // intención (snapshot durable) via `prepareBoldQrIntent`
                // ANTES de abrir el modal hijo (migración 027). Si el
                // POST /iniciar falla, el UPM muestra toast y NO abre el
                // modal; el carrito queda intacto para que el cajero
                // cambie de método.
                //
                // La aprobación llega por el mismo `onPay` arriba con
                // transferSource='BOLD_QR', así que no hay que tocar
                // `handleConfirmSale`. En modo edición ocultamos el QR
                // porque la ruta de corrección (/sales/update,
                // /sales/add-items) no persiste el canal de origen;
                // mantenemos solo canales explícitos.
                onBoldQrRequested={isEditMode ? undefined : prepareBoldQrIntent}
                onBoldQrEnqueueRequested={isEditMode ? undefined : handleBoldQrEnqueueRequested}
                boldQrReopenPayload={boldQrReopenPayload ?? undefined}
                onBoldQrReopenConsumed={handleBoldQrReopenConsumed}
                onBoldQrFinalized={isEditMode ? undefined : handleBoldQrFinalized}
                onCloseComplete={returnFocusToScanner} 
            />
            <ClientSelectionModal isOpen={isClientDialogOpen} onOpenChange={(open) => { setIsClientDialogOpen(open); if (!open) setTimeout(returnFocusToScanner, 100); }} clientSearch={clientSearch} setClientSearch={setClientSearch} filteredCustomers={filteredCustomers} handleClientSelect={handleClientSelect} selectedClientDni={selectedCustomerDni} />
            <ManualWeightModal isOpen={isManualWeightOpen} onOpenChange={(open) => { setIsManualWeightOpen(open); if (!open) setTimeout(returnFocusToScanner, 100); }} manualWeightProduct={manualWeightProduct} manualWeightValue={manualWeightValue} setManualWeightValue={setManualWeightValue} confirmManualWeight={confirmManualWeight} />
            <ScannerOverlay isOpen={isScannerOpen} onClose={() => setIsScannerOpen(false)} onResult={(res) => { handleCodeSubmit(res); setIsScannerOpen(false); }} title="Escaner POS" />
            <SplitBillDialog
                isOpen={isSplitDialogOpen}
                onClose={() => setIsSplitDialogOpen(false)}
                originalItems={currentCart}
                customers={customers}
                currentCustomerDni={selectedCustomerDni}
                onConfirm={(l, r, targetDni) => {
                    setOriginalCustomerDniBeforeSplit(selectedCustomerDni);
                    setRemainingItemsAfterSplit(l);
                    setSplitItemsToPay(r);
                    handleClientSelect(targetDni);
                    setIsSplitDialogOpen(false);
                    setIsPaymentDialogOpen(true);
                }}
            />
            <MissingItemModal isOpen={isMissingItemOpen} onOpenChange={(open) => { setIsMissingItemOpen(open); if (!open) setTimeout(returnFocusToScanner, 100); }} />

            <EditCartItemModal
                isOpen={!!editingCartItem}
                onOpenChange={(open) => {
                    if (!open) {
                        setEditingCartItem(null);
                        returnFocusToScanner();
                    }
                }}
                item={editingCartItem}
                onSave={(qty, price) => {
                    if (editingCartItem) {
                        updateCartItem(editingCartItem.cartItemId, qty, price);
                    }
                }}
            />

            {/* Modal de Confirmacion de Eliminacion de Factura (V8.5) */}
            <Modal 
                isOpen={isDeleteCartConfirmOpen} 
                onOpenChange={setIsDeleteCartConfirmOpen}
                backdrop="blur"
                classNames={{
                    base: "border-[#f43f5e] border-2 bg-white dark:bg-zinc-950",
                    header: "border-b border-zinc-200 dark:border-white/10",
                    footer: "border-t border-zinc-200 dark:border-white/10",
                }}
            >
                <ModalContent>
                    {(onClose) => (
                        <>
                            <ModalHeader className="flex flex-col gap-1 text-rose-500 font-medium tracking-tight">
                                <div className="flex items-center gap-2">
                                    <AlertTriangle size={24} />
                                    ¿ELIMINAR FACTURA?
                                </div>
                            </ModalHeader>
                            <ModalBody>
                                <p className="text-white font-bold">
                                    Esta factura contiene productos registrados. Si la elimina, se perderán los cambios y esto podría afectar la trazabilidad de su inventario.
                                </p>
                                <p className="text-zinc-500 dark:text-zinc-400 text-xs tracking-tight">
                                    ¿Está seguro de que desea proceder con la eliminación total?
                                </p>
                            </ModalBody>
                            <ModalFooter>
                                <Button variant="light" onPress={onClose} className="font-medium text-white">
                                    CANCELAR
                                </Button>
                                <Button 
                                    color="danger" 
                                    onPress={() => {
                                        confirmDeleteCart();
                                        onClose();
                                    }}
                                    className="font-medium tracking-tight shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-rose-500/20"
                                >
                                    SÍ, ELIMINAR FACTURA
                                </Button>
                            </ModalFooter>
                        </>
                    )}
                </ModalContent>
            </Modal>
            <ProductSearchModal
                isOpen={isProductSearchOpen}
                onOpenChange={(open) => { setIsProductSearchOpen(open); if (!open) setTimeout(returnFocusToScanner, 100); }}
                products={products}
                onSelect={(p) => addToCart(p)}
            />
            <HomeDrawerModal
                isOpen={isHomeDrawerModalOpen}
                onOpenChange={setIsHomeDrawerModalOpen}
                user={user ?? null}
                onCloseComplete={returnFocusToScanner}
            />
        </div>
    );
}


