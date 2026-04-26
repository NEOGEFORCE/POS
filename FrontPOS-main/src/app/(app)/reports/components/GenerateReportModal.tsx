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
    Users
} from 'lucide-react';
import { useToast } from "@/hooks/use-toast";

interface GenerateReportModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    onGenerate: (type: string, options: any) => void;
}

const CATEGORIES = [
    { id: 'box-closure', name: 'CUADRE CAJA', icon: Wallet, color: 'text-emerald-500', bg: 'bg-emerald-500/10' },
    { id: 'payments', name: 'VENTAS & PAGOS', icon: ShoppingCart, color: 'text-blue-500', bg: 'bg-blue-500/10' },
    { id: 'inventory', name: 'INVENTARIO', icon: Package, color: 'text-amber-500', bg: 'bg-amber-500/10' },
    { id: 'pnl', name: 'FINANZAS / PNL', icon: TrendingUp, color: 'text-violet-500', bg: 'bg-violet-500/10' },
    { id: 'ranking', name: 'RANKING PRODUCTOS', icon: Target, color: 'text-rose-500', bg: 'bg-rose-500/10' },
    { id: 'savings', name: 'AHORROS & COSTOS', icon: Tag, color: 'text-teal-500', bg: 'bg-teal-500/10' },
    { id: 'vault-audit', name: 'ARQUEO GENERAL BÓVEDA', icon: Database, color: 'text-amber-600', bg: 'bg-amber-600/10' },
    { id: 'global-credit', name: 'CARTERA GLOBAL (FIADOS)', icon: Users, color: 'text-rose-600', bg: 'bg-rose-600/10' },
    { id: 'voids-audit', name: 'AUDITORÍA DE ANULACIONES', icon: ShieldCheck, color: 'text-blue-600', bg: 'bg-blue-600/10' },
];

export default function GenerateReportModal({ isOpen, onOpenChange, onGenerate }: GenerateReportModalProps) {
    const { toast } = useToast();
    const [reportName, setReportName] = useState(`REPORTE_SISTEMA_${new Date().toISOString().split('T')[0]}`);
    const [category, setCategory] = useState('box-closure');
    const [format, setFormat] = useState('PDF');
    const [dateFrom, setDateFrom] = useState(`${new Date().toISOString().split('T')[0]}`);
    const [dateTo, setDateTo] = useState(`${new Date().toISOString().split('T')[0]}`);
    const [dataSources, setDataSources] = useState(["details", "logs"]);
    const [deliveryEmail, setDeliveryEmail] = useState("");
    const [saveToCloud, setSaveToCloud] = useState(true);
    const [sendToTelegram, setSendToTelegram] = useState(true);

    // Actualizar nombre del reporte automáticamente cuando cambie la categoría
    React.useEffect(() => {
        const cat = CATEGORIES.find(c => c.id === category);
        if (cat) {
            const dateStr = new Date().toISOString().split('T')[0];
            setReportName(`REPORTE_${cat.name.replace(/ /g, '_')}_${dateStr}`);
        }
    }, [category]);

    const handleGenerate = () => {
        const payload = { reportName, dataSources, deliveryEmail, saveToCloud, sendToTelegram, dateFrom, dateTo };
        if (format !== 'PDF') {
            toast({
                title: "FORMATO EN DESARROLLO",
                description: `La exportación a ${format} estará disponible en la V4.2. Usando PDF por defecto.`,
                variant: "default"
            });
            onGenerate(category, payload);
        } else {
            onGenerate(category, payload);
        }
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
            size="3xl"
            backdrop="blur"
            scrollBehavior="inside"
            classNames={{
                base: "bg-white/80 dark:bg-zinc-950/90 backdrop-blur-3xl border border-gray-200 dark:border-white/10 rounded-[2.5rem] shadow-2xl max-h-[95vh] sm:max-h-none w-[95vw] sm:w-auto",
                header: "border-b border-gray-100 dark:border-white/5 p-4 md:p-8",
                body: "p-4 md:p-8 overflow-y-auto custom-scrollbar",
                footer: "border-t border-gray-100 dark:border-white/5 p-4 md:p-8"
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="flex flex-col gap-1">
                            <h2 className="text-2xl font-black text-gray-900 dark:text-white italic tracking-tighter uppercase leading-none flex items-center gap-3">
                                <span className="p-2.5 bg-emerald-500 rounded-xl text-white shadow-lg shadow-emerald-500/20"><Zap size={20} /></span>
                                Generador <span className="text-emerald-500">Maestro</span>
                            </h2>
                            <p className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.3em] mt-2 italic">Configuración de Salida de Datos V4.0</p>
                        </ModalHeader>

                        <ModalBody className="gap-4 md:gap-8">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-8">
                                {/* SECCIÓN IZQUIERDA: IDENTIDAD Y CATEGORÍA */}
                                <div className="space-y-6">
                                    {/* Nombre del Archivo */}
                                    <div className="space-y-2">
                                        <label className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest ml-1">Nombre del Archivo</label>
                                        <Input 
                                            value={reportName}
                                            onValueChange={setReportName}
                                            size="lg"
                                            classNames={{
                                                inputWrapper: "bg-gray-100 dark:bg-zinc-950/80 border-2 border-transparent focus-within:!border-emerald-500/50 rounded-2xl h-14",
                                                input: "font-black text-sm uppercase italic text-gray-900 dark:text-white"
                                            }}
                                            startContent={<FileText size={18} className="text-emerald-500 mr-2" />}
                                        />
                                    </div>

                                    {/* Rango de Fechas */}
                                    <div className="space-y-3">
                                        <label className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest ml-1">Rango de Fechas</label>
                                        <div className="grid grid-cols-2 gap-3">
                                            <Input 
                                                type="date"
                                                value={dateFrom}
                                                onValueChange={setDateFrom}
                                                classNames={{
                                                    inputWrapper: "bg-gray-100 dark:bg-zinc-950/80 border-2 border-transparent focus-within:!border-emerald-500/50 rounded-2xl h-12",
                                                    input: "font-black text-[10px] text-gray-900 dark:text-white uppercase tracking-widest"
                                                }}
                                                startContent={<Calendar size={14} className="text-gray-400 mr-1" />}
                                            />
                                            <Input 
                                                type="date"
                                                value={dateTo}
                                                onValueChange={setDateTo}
                                                classNames={{
                                                    inputWrapper: "bg-gray-100 dark:bg-zinc-950/80 border-2 border-transparent focus-within:!border-emerald-500/50 rounded-2xl h-12",
                                                    input: "font-black text-[10px] text-gray-900 dark:text-white uppercase tracking-widest"
                                                }}
                                                startContent={<Calendar size={14} className="text-gray-400 mr-1" />}
                                            />
                                        </div>
                                    </div>

                                    {/* Seleccionar Fuente de Datos - Toggle Cards ADN Inventario */}
                                    <div className="space-y-3">
                                        <label className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest ml-1">Seleccionar Fuente de Datos</label>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pr-2">
                                            {CATEGORIES.map((cat) => (
                                                <button
                                                    key={cat.id}
                                                    onClick={() => setCategory(cat.id)}
                                                    className={`p-3 sm:p-4 rounded-2xl border-2 transition-all flex items-center gap-3 text-left ${
                                                        category === cat.id 
                                                            ? 'bg-emerald-500/10 border-emerald-500/50' 
                                                            : 'bg-zinc-950/50 border-white/5 hover:border-white/10'
                                                    }`}
                                                >
                                                    <div className={`p-2 rounded-lg ${cat.bg} ${cat.color}`}>
                                                        <cat.icon size={16} />
                                                    </div>
                                                    <span className={`text-[10px] font-black uppercase tracking-tight italic ${category === cat.id ? 'text-emerald-400' : 'text-zinc-400'}`}>
                                                        {cat.name}
                                                    </span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>

                                {/* SECCIÓN DERECHA: FORMATO Y SEGURIDAD */}
                                <div className="space-y-6">
                                    {/* Criterios de Exportación - Panel ADN Inventario */}
                                    <div className="bg-gray-100 dark:bg-zinc-950/80 border border-gray-200 dark:border-white/5 rounded-2xl p-6 space-y-5">
                                        <label className="text-[9px] font-black text-zinc-500 uppercase tracking-widest flex items-center gap-2">
                                            <ShieldCheck size={14} className="text-emerald-500" /> Criterios de Exportación
                                        </label>
                                        
                                        {/* Radios Custom con Peer */}
                                        <div className="space-y-3">
                                            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Formato de Salida</label>
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
                                                        <div className="w-5 h-5 rounded-full border border-zinc-700 bg-zinc-900 peer-checked:bg-emerald-500 peer-checked:border-emerald-500 flex items-center justify-center transition-all">
                                                            <div className="w-2 h-2 rounded-full bg-white opacity-0 peer-checked:opacity-100" />
                                                        </div>
                                                        <span className="text-sm text-gray-600 dark:text-zinc-400 font-medium peer-checked:text-emerald-500 dark:peer-checked:text-white transition-colors">
                                                            {fmt === 'PDF' ? 'Documento PDF' : fmt === 'EXCEL' ? 'Excel Sheet' : 'CSV Tabular'}
                                                        </span>
                                                    </label>
                                                ))}
                                            </div>
                                        </div>

                                        {/* Divisor sutil */}
                                        <div className="border-b border-white/5" />

                                        {/* Checkboxes Custom con Peer */}
                                        <div className="space-y-3">
                                            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Opciones de Contenido</label>
                                            <div className="space-y-2">
                                                {[
                                                    { id: 'details', label: 'Incluir Listado Detallado' },
                                                    { id: 'logs', label: 'Anexar Logs de Auditoría' },
                                                    { id: 'api', label: 'Consolidar Uso de API' }
                                                ].map((opt) => (
                                                    <label key={opt.id} className="flex items-center gap-3 cursor-pointer group">
                                                        <input
                                                            type="checkbox"
                                                            checked={dataSources.includes(opt.id)}
                                                            onChange={() => toggleDataSource(opt.id)}
                                                            className="peer sr-only"
                                                        />
                                                        <div className="w-5 h-5 rounded border border-zinc-700 bg-zinc-900 peer-checked:bg-emerald-500 peer-checked:border-emerald-500 flex items-center justify-center transition-all">
                                                            <Check size={12} className="text-white opacity-0 peer-checked:opacity-100" />
                                                        </div>
                                                        <span className="text-sm text-gray-600 dark:text-zinc-400 font-medium peer-checked:text-emerald-500 dark:peer-checked:text-white transition-colors">
                                                            {opt.label}
                                                        </span>
                                                    </label>
                                                ))}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Email Input */}
                                    <div className="space-y-2">
                                        <label className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest ml-1">Enviar Copia a Email (Opcional)</label>
                                        <Input 
                                            value={deliveryEmail}
                                            onValueChange={setDeliveryEmail}
                                            placeholder="CORREO@DESTINO.COM"
                                            classNames={{
                                                inputWrapper: "bg-gray-100 dark:bg-zinc-950/80 border-2 border-transparent focus-within:!border-emerald-500/50 rounded-2xl h-12",
                                                input: "font-black text-[11px] uppercase text-gray-900 dark:text-white"
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
                                            <div className="w-5 h-5 rounded border border-zinc-700 bg-zinc-900 peer-checked:bg-emerald-500 peer-checked:border-emerald-500 flex items-center justify-center transition-all">
                                                <Cloud size={12} className="text-white opacity-0 peer-checked:opacity-100" />
                                            </div>
                                            <span className="text-sm text-zinc-400 font-medium peer-checked:text-emerald-400 transition-colors flex items-center gap-2">
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
                                            <div className="w-5 h-5 rounded border border-zinc-700 bg-zinc-900 peer-checked:bg-blue-500 peer-checked:border-blue-500 flex items-center justify-center transition-all">
                                                <Send size={12} className="text-white opacity-0 peer-checked:opacity-100" />
                                            </div>
                                            <span className="text-sm text-zinc-400 font-medium peer-checked:text-blue-400 transition-colors flex items-center gap-2">
                                                Notificar y Enviar PDF vía Telegram
                                            </span>
                                        </label>
                                    </div>
                                </div>
                            </div>
                        </ModalBody>

                        <ModalFooter className="flex-col sm:flex-row justify-between items-stretch sm:items-center gap-4">
                            <div className="flex items-center gap-2 opacity-50 justify-center sm:justify-start">
                                <Clock size={12} />
                                <span className="text-[9px] font-bold uppercase italic tracking-[0.2em] text-zinc-500">Estimado: {format === 'PDF' ? '3s' : 'Procesando...'}</span>
                            </div>
                            <div className="flex flex-col sm:flex-row gap-3">
                                <Button 
                                    variant="light" 
                                    className="font-black text-[10px] uppercase tracking-widest italic rounded-xl px-8 text-zinc-400 hover:text-white h-12 sm:h-auto" 
                                    onPress={onClose}
                                >
                                    Cancelar
                                </Button>
                                <Button 
                                    className="bg-emerald-500 hover:bg-emerald-600 text-white font-bold text-sm uppercase tracking-wider rounded-xl px-8 py-3 shadow-[0_0_15px_rgba(16,185,129,0.3)] hover:shadow-[0_0_25px_rgba(16,185,129,0.5)] transition-all flex items-center gap-2 h-14 sm:h-auto"
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
