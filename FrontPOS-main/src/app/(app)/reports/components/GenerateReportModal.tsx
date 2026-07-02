"use client";

import React, { useState } from 'react';
import {
    Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
    Button, Input, Card, CardBody
} from "@heroui/react";
import { 
    FileText, ShieldCheck, Mail, Calendar, 
    FileSpreadsheet, Zap, Database, Clock, 
    ShoppingCart, Wallet, Package, TrendingUp,
    Target, Tag, Send, Cloud, Check, FileDigit,
    Users, AlertTriangle, RefreshCw, Percent, Receipt, Search
} from 'lucide-react';
import { useToast } from "@/hooks/use-toast";
import { PremiumDateInput } from "@/components/ui/premium-date-input";

interface GenerateReportModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    onGenerate: (type: string, options: any) => void;
}

const CATEGORIES = [
    { id: 'box-closure', name: 'CUADRE CAJA', icon: Wallet, color: 'text-zinc-900 dark:text-zinc-100', bg: 'bg-black/5 dark:bg-white/5' },
    { id: 'cuadre-real', name: 'CUADRE REAL (Fisico)', icon: Wallet, color: 'text-emerald-500', bg: 'bg-emerald-500/10' },
    { id: 'payments', name: 'VENTAS & PAGOS', icon: ShoppingCart, color: 'text-blue-500', bg: 'bg-blue-500/10' },
    { id: 'inventory', name: 'INVENTARIO', icon: Package, color: 'text-amber-500', bg: 'bg-amber-500/10' },
    { id: 'pnl', name: 'FINANZAS / PNL', icon: TrendingUp, color: 'text-violet-500', bg: 'bg-violet-500/10' },
    { id: 'profitability', name: 'RENTABILIDAD (17% Target)', icon: Percent, color: 'text-emerald-600', bg: 'bg-emerald-600/10' },
    { id: 'shrinkage', name: 'MERMAS Y AVERIAS', icon: AlertTriangle, color: 'text-rose-500', bg: 'bg-rose-500/10' },
    { id: 'rotation', name: 'ROTACION INVENTARIO', icon: RefreshCw, color: 'text-cyan-500', bg: 'bg-cyan-500/10' },
    { id: 'cashflow', name: 'FLUJO DE CAJA (RESUMEN)', icon: Database, color: 'text-emerald-500', bg: 'bg-emerald-500/10' },
    { id: 'cashflow-detailed', name: 'FLUJO DE CAJA - DESGLOSADO', icon: Wallet, color: 'text-emerald-400', bg: 'bg-emerald-400/10' },
    { id: 'ranking', name: 'RANKING PRODUCTOS', icon: Target, color: 'text-rose-500', bg: 'bg-rose-500/10' },
    { id: 'savings', name: 'AHORROS & COSTOS', icon: Tag, color: 'text-teal-500', bg: 'bg-teal-500/10' },
    { id: 'vault-audit', name: 'ARQUEO GENERAL BOVEDA', icon: Database, color: 'text-amber-600', bg: 'bg-amber-600/10' },
    { id: 'global-credit', name: 'CARTERA GLOBAL (FIADOS)', icon: Users, color: 'text-rose-600', bg: 'bg-rose-600/10' },
    { id: 'voids-audit', name: 'AUDITORIA DE ANULACIONES', icon: ShieldCheck, color: 'text-blue-600', bg: 'bg-blue-600/10' },
    { id: 'expenses', name: 'REPORTE DE EGRESOS', icon: Receipt, color: 'text-rose-500', bg: 'bg-rose-500/10' },
];

export default function GenerateReportModal({ isOpen, onOpenChange, onGenerate }: GenerateReportModalProps) {
    const { toast } = useToast();
    const [reportName, setReportName] = useState(`REPORTE_SISTEMA_${new Date().toISOString().split('T')[0]}`);
    const [category, setCategory] = useState('box-closure');
    const [format, setFormat] = useState('PDF');
    const [dateFrom, setDateFrom] = useState(() => {
        const d = new Date();
        d.setDate(1);
        return d.toISOString().split('T')[0];
    });
    const [dateTo, setDateTo] = useState(`${new Date().toISOString().split('T')[0]}`);
    const [dataSources, setDataSources] = useState(["details", "logs"]);
    const [deliveryEmail, setDeliveryEmail] = useState("");
    const [saveToCloud, setSaveToCloud] = useState(true);
    const [sendToTelegram, setSendToTelegram] = useState(true);
    const [concept, setConcept] = useState("");

    // Actualizar nombre del reporte automaticamente cuando cambie la categoria
    React.useEffect(() => {
        const cat = CATEGORIES.find(c => c.id === category);
        if (cat) {
            const dateStr = new Date().toISOString().split('T')[0];
            setReportName(`REPORTE_${cat.name.replace(/ /g, '_')}_${dateStr}`);
        }
    }, [category]);

    const handleGenerate = () => {
        const payload = { reportName, dataSources, deliveryEmail, saveToCloud, sendToTelegram, dateFrom, dateTo, format, concept };
        onGenerate(category, payload);
        onOpenChange(false);
    };

    // Toggle checkbox handler
    const toggleDataSource = (value: string) => {
        setDataSources(prev => 
            prev.includes(value) 
                ? prev.filter(v => v !== value)
                : [...prev, value]
        );
    };

    return (
        <Modal 
            isOpen={isOpen} 
            onOpenChange={onOpenChange}
            size="4xl"
            backdrop="blur"
            scrollBehavior="inside"
            classNames={{
                base: "card-base border-none dark:bg-zinc-950/90  border border-gray-200 dark:border-white/10 rounded-[2.5rem] shadow-[0_8px_30px_rgb(0,0,0,0.12)] max-h-[95vh] sm:max-h-none w-[95vw] sm:w-auto",
                header: "border-b border-gray-100 dark:border-white/5 p-4 md:p-8",
                body: "p-4 md:p-8 overflow-y-auto custom-scrollbar",
                footer: "border-t border-gray-100 dark:border-white/5 p-4 md:p-8"
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="flex flex-col gap-1">
                            <h2 className="text-2xl font-medium text-zinc-900 dark:text-zinc-50 tracking-tight tracking-tighter uppercase leading-none flex items-center gap-3">
                                <span className="p-2.5 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 rounded-2xl text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)]"><Zap size={20} /></span>
                                Generador <span className="text-zinc-900 dark:text-zinc-100">Maestro</span>
                            </h2>
                            <p className="text-[10px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-[0.3em] mt-2 tracking-tight">Configuracion de Salida de Datos V4.0</p>
                        </ModalHeader>

                        <ModalBody className="gap-4 md:gap-8">
                            {/* CATEGORIAS A FILA COMPLETA — 3 columnas en desktop */}
                            <div className="space-y-3">
                                <label className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest ml-1">Seleccionar Fuente de Datos</label>
                                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                                    {CATEGORIES.map((cat) => (
                                        <button
                                            key={cat.id}
                                            onClick={() => setCategory(cat.id)}
                                            className={`p-3 rounded-2xl border-2 transition-all flex items-start gap-2.5 text-left min-h-[64px] ${
                                                category === cat.id
                                                    ? 'bg-emerald-500/[0.06] border-emerald-500/50 shadow-[0_0_15px_rgba(16,185,129,0.15)]'
                                                    : 'bg-white dark:bg-zinc-950/50 border-zinc-200 dark:border-white/5 hover:border-zinc-300 dark:hover:border-black/5 dark:border-white/10'
                                            }`}
                                        >
                                            <div className={`p-1.5 rounded-lg shrink-0 ${cat.bg} ${cat.color}`}>
                                                <cat.icon size={14} />
                                            </div>
                                            <span className={`text-[10px] font-medium uppercase tracking-tight leading-tight pt-0.5 ${category === cat.id ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-400'}`}>
                                                {cat.name}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-8">
                                {/* SECCION IZQUIERDA: IDENTIDAD */}
                                <div className="space-y-6">
                                    {/* Nombre del Archivo */}
                                    <div className="space-y-2">
                                        <label className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest ml-1">Nombre del Archivo</label>
                                        <Input 
                                            value={reportName}
                                            onValueChange={setReportName}
                                            size="lg"
                                            classNames={{
                                                inputWrapper: "bg-gray-100 dark:bg-zinc-950/80 border-2 border-transparent focus-within:!border-emerald-500/50 rounded-2xl h-14",
                                                input: "font-medium text-sm uppercase tracking-tight text-zinc-900 dark:text-zinc-50"
                                            }}
                                            startContent={<FileText size={18} className="text-zinc-900 dark:text-zinc-100 mr-2" />}
                                        />
                                    </div>

                                    {/* Rango de Fechas */}
                                    <div className="space-y-3">
                                        <label className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest ml-1">Rango de Fechas</label>
                                        <div className="grid grid-cols-2 gap-3">
                                            <PremiumDateInput
                                                value={dateFrom}
                                                onChange={setDateFrom}
                                                accent="emerald"
                                                size="md"
                                                hint="Desde"
                                            />
                                            <PremiumDateInput
                                                value={dateTo}
                                                onChange={setDateTo}
                                                accent="emerald"
                                                size="md"
                                                hint="Hasta"
                                            />
                                        </div>
                                    </div>

                                    {/* Campo opcional de Concepto para Egresos */}
                                    {category === 'expenses' && (
                                        <div className="space-y-2 mt-2">
                                            <label className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest ml-1">Buscar por Concepto (Opcional)</label>
                                            <Input 
                                                placeholder="Ej. Almuerzo"
                                                value={concept}
                                                onValueChange={setConcept}
                                                size="sm"
                                                classNames={{
                                                    inputWrapper: "bg-gray-100 dark:bg-zinc-950/80 border-2 border-transparent focus-within:!border-emerald-500/50 rounded-2xl h-12",
                                                    input: "font-medium text-[11px] uppercase tracking-tight text-zinc-900 dark:text-zinc-50"
                                                }}
                                                startContent={<Search size={16} className="text-zinc-900 dark:text-zinc-100 mr-2" />}
                                            />
                                        </div>
                                    )}
                                </div>

                                {/* SECCION DERECHA: FORMATO Y SEGURIDAD */}
                                <div className="space-y-6">
                                    {/* Criterios de Exportacion - Panel ADN Inventario */}
                                    <div className="bg-gray-100 dark:bg-zinc-950/80 border border-gray-200 dark:border-white/5 rounded-2xl p-6 space-y-5">
                                        <label className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-widest flex items-center gap-2">
                                            <ShieldCheck size={14} className="text-zinc-900 dark:text-zinc-100" /> Criterios de Exportacion
                                        </label>
                                        
                                        {/* Radios Custom con Peer */}
                                        <div className="space-y-3">
                                            <label className="text-[10px] font-bold text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">Formato de Salida</label>
                                            <div className="flex flex-wrap gap-3">
                                                {['PDF', 'EXCEL', 'CSV'].map((fmt) => (
                                                    <label key={fmt} className="flex items-center gap-3 cursor-pointer group">
                                                        <input
                                                            type="radio"
                                                            name="format"
                                                            value={fmt}
                                                            checked={format === fmt}
                                                            onChange={(e) => setFormat(e.target.value)}
                                                            className="peer sr-only"
                                                        />
                                                        <div className="w-5 h-5 rounded-2xl border border-zinc-700 bg-[#18181b] peer-checked:bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 peer-checked:border-emerald-500 flex items-center justify-center transition-all">
                                                            <div className="w-2 h-2 rounded-2xl bg-white opacity-0 peer-checked:opacity-100" />
                                                        </div>
                                                        <span className="text-sm text-gray-600 dark:text-zinc-400 font-medium peer-checked:text-zinc-900 dark:text-zinc-100 dark:peer-checked:text-white transition-colors">
                                                            {fmt === 'PDF' ? 'Documento PDF' : fmt === 'EXCEL' ? 'Excel Sheet' : 'CSV Tabular'}
                                                        </span>
                                                    </label>
                                                ))}
                                            </div>
                                        </div>

                                        {/* Divisor sutil */}
                                        <div className="border-b border-zinc-200 dark:border-white/5" />

                                        {/* Checkboxes Custom con Peer */}
                                        <div className="space-y-3">
                                            <label className="text-[10px] font-bold text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">Opciones de Contenido</label>
                                            <div className="space-y-2">
                                                {[
                                                    { id: 'details', label: 'Incluir Listado Detallado' },
                                                    { id: 'logs', label: 'Anexar Logs de Auditoria' },
                                                    { id: 'api', label: 'Consolidar Uso de API' }
                                                ].map((opt) => (
                                                    <label key={opt.id} className="flex items-center gap-3 cursor-pointer group">
                                                        <input
                                                            type="checkbox"
                                                            checked={dataSources.includes(opt.id)}
                                                            onChange={() => toggleDataSource(opt.id)}
                                                            className="peer sr-only"
                                                        />
                                                        <div className="w-5 h-5 rounded border border-zinc-700 bg-[#18181b] peer-checked:bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 peer-checked:border-emerald-500 flex items-center justify-center transition-all">
                                                            <Check size={12} className="text-white opacity-0 peer-checked:opacity-100" />
                                                        </div>
                                                        <span className="text-sm text-gray-600 dark:text-zinc-400 font-medium peer-checked:text-zinc-900 dark:text-zinc-100 dark:peer-checked:text-white transition-colors">
                                                            {opt.label}
                                                        </span>
                                                    </label>
                                                ))}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Email Input */}
                                    <div className="space-y-2">
                                        <label className="text-[9px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 uppercase tracking-widest ml-1">Enviar Copia a Email (Opcional)</label>
                                        <Input 
                                            value={deliveryEmail}
                                            onValueChange={setDeliveryEmail}
                                            placeholder="CORREO@DESTINO.COM"
                                            classNames={{
                                                inputWrapper: "bg-gray-100 dark:bg-zinc-950/80 border-2 border-transparent focus-within:!border-emerald-500/50 rounded-2xl h-12",
                                                input: "font-medium text-[11px] uppercase text-zinc-900 dark:text-zinc-50"
                                            }}
                                            startContent={<Mail size={16} className="text-gray-400 mr-2" />}
                                        />
                                    </div>
                                    
                                    {/* Checkboxes Cloud y Telegram - Estilo Toggle Moderno */}
                                    <div className="space-y-3">
                                        {/* Cloud Manager */}
                                        <label className="flex items-center gap-3 cursor-pointer group">
                                            <input
                                                type="checkbox"
                                                checked={saveToCloud}
                                                onChange={(e) => setSaveToCloud(e.target.checked)}
                                                className="peer sr-only"
                                            />
                                            <div className="w-5 h-5 rounded border border-zinc-700 bg-[#18181b] peer-checked:bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 peer-checked:border-emerald-500 flex items-center justify-center transition-all">
                                                <Cloud size={12} className="text-white opacity-0 peer-checked:opacity-100" />
                                            </div>
                                            <span className="text-sm text-gray-500 dark:text-zinc-500 dark:text-zinc-400 font-medium peer-checked:text-gray-600 dark:text-zinc-300 transition-colors flex items-center gap-2">
                                                Auto-Archivar en Cloud Manager
                                            </span>
                                        </label>

                                        {/* Telegram */}
                                        <label className="flex items-center gap-3 cursor-pointer group">
                                            <input
                                                type="checkbox"
                                                checked={sendToTelegram}
                                                onChange={(e) => setSendToTelegram(e.target.checked)}
                                                className="peer sr-only"
                                            />
                                            <div className="w-5 h-5 rounded border border-zinc-700 bg-[#18181b] peer-checked:bg-blue-500 peer-checked:border-blue-500 flex items-center justify-center transition-all">
                                                <Send size={12} className="text-white opacity-0 peer-checked:opacity-100" />
                                            </div>
                                            <span className="text-sm text-gray-500 dark:text-zinc-500 dark:text-zinc-400 font-medium peer-checked:text-blue-400 transition-colors flex items-center gap-2">
                                                Notificar y Enviar PDF via Telegram
                                            </span>
                                        </label>
                                    </div>
                                </div>
                            </div>
                        </ModalBody>

                        <ModalFooter className="flex-col sm:flex-row justify-between items-stretch sm:items-center gap-4">
                            <div className="flex items-center gap-2 opacity-50 justify-center sm:justify-start">
                                <Clock size={12} />
                                <span className="text-[9px] font-bold uppercase tracking-tight tracking-[0.2em] text-gray-500 dark:text-zinc-500">Estimado: {format === 'PDF' ? '3s' : 'Procesando...'}</span>
                            </div>
                            <div className="flex flex-col sm:flex-row gap-3">
                                <Button 
                                    variant="light" 
                                    className="font-medium text-[10px] uppercase tracking-widest tracking-tight rounded-2xl px-8 text-gray-500 dark:text-zinc-500 dark:text-zinc-400 hover:text-white h-12 sm:h-auto" 
                                    onPress={onClose}
                                >
                                    Cancelar
                                </Button>
                                <Button 
                                    className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 hover:bg-zinc-50 dark:hover:bg-white/5 bg-white dark:bg-transparent border border-zinc-200 dark:border-white/5 text-white font-bold text-sm uppercase tracking-wider rounded-2xl px-8 py-3 shadow-[0_0_15px_rgba(16,185,129,0.3)] hover:shadow-[0_0_25px_rgba(16,185,129,0.5)] transition-all flex items-center gap-2 h-14 sm:h-auto"
                                    onPress={handleGenerate}
                                >
                                    <FileDigit size={16} />
                                    Generar Reporte Maestro
                                </Button>
                            </div>
                        </ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
}
