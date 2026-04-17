"use client";

import React, { useState } from 'react';
import {
    Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
    Button, Input, Checkbox, CheckboxGroup, RadioGroup, Radio,
    Card, CardBody, Divider
} from "@heroui/react";
import { 
    FileText, ShieldCheck, Mail, Calendar, 
    FileSpreadsheet, Zap, Database, Clock, 
    ShoppingCart, Wallet, Package, TrendingUp 
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

    const handleGenerate = () => {
        const payload = { reportName, dataSources, deliveryEmail, saveToCloud, dateFrom, dateTo };
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

    return (
        <Modal 
            isOpen={isOpen} 
            onOpenChange={onOpenChange}
            size="3xl"
            backdrop="blur"
            classNames={{
                base: "bg-white/80 dark:bg-zinc-950/90 backdrop-blur-3xl border border-gray-200 dark:border-white/10 rounded-[2.5rem] shadow-2xl",
                header: "border-b border-gray-100 dark:border-white/5 p-8",
                body: "p-8",
                footer: "border-t border-gray-100 dark:border-white/5 p-8"
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

                        <ModalBody className="gap-8">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                {/* SECCIÓN IZQUIERDA: IDENTIDAD Y CATEGORÍA */}
                                <div className="space-y-6">
                                    <div className="space-y-2">
                                        <label className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest ml-1">Nombre del Archivo</label>
                                        <Input 
                                            value={reportName}
                                            onValueChange={setReportName}
                                            size="lg"
                                            classNames={{
                                                inputWrapper: "bg-gray-100 dark:bg-white/5 border-2 border-transparent focus-within:!border-emerald-500/50 rounded-2xl h-14",
                                                input: "font-black text-sm uppercase italic"
                                            }}
                                            startContent={<FileText size={18} className="text-emerald-500 mr-2" />}
                                        />
                                    </div>

                                    <div className="space-y-3">
                                        <label className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest ml-1">Rango de Fechas</label>
                                        <div className="grid grid-cols-2 gap-3">
                                            <Input 
                                                type="date"
                                                value={dateFrom}
                                                onValueChange={setDateFrom}
                                                classNames={{
                                                    inputWrapper: "bg-gray-100 dark:bg-white/5 border-2 border-transparent focus-within:!border-emerald-500/50 rounded-2xl h-12",
                                                    input: "font-black text-[10px] text-gray-700 dark:text-zinc-300 uppercase tracking-widest"
                                                }}
                                                startContent={<Calendar size={14} className="text-gray-400 mr-1" />}
                                            />
                                            <Input 
                                                type="date"
                                                value={dateTo}
                                                onValueChange={setDateTo}
                                                classNames={{
                                                    inputWrapper: "bg-gray-100 dark:bg-white/5 border-2 border-transparent focus-within:!border-emerald-500/50 rounded-2xl h-12",
                                                    input: "font-black text-[10px] text-gray-700 dark:text-zinc-300 uppercase tracking-widest"
                                                }}
                                                startContent={<Calendar size={14} className="text-gray-400 mr-1" />}
                                            />
                                        </div>
                                    </div>

                                    <div className="space-y-3">
                                        <label className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest ml-1">Seleccionar Fuente de Datos</label>
                                        <div className="grid grid-cols-2 gap-3">
                                            {CATEGORIES.map((cat) => (
                                                <Card 
                                                    key={cat.id}
                                                    isPressable
                                                    onPress={() => setCategory(cat.id)}
                                                    className={`border-2 transition-all rounded-2xl ${category === cat.id ? 'border-emerald-500 bg-emerald-500/5' : 'border-transparent bg-gray-50 dark:bg-zinc-900 hover:bg-gray-100 dark:hover:bg-zinc-800'}`}
                                                >
                                                    <CardBody className="p-4 flex flex-row items-center gap-3">
                                                        <div className={`p-2 rounded-lg ${cat.bg} ${cat.color}`}><cat.icon size={16} /></div>
                                                        <span className="text-[10px] font-black uppercase tracking-tight italic">{cat.name}</span>
                                                    </CardBody>
                                                </Card>
                                            ))}
                                        </div>
                                    </div>
                                </div>

                                {/* SECCIÓN DERECHA: FORMATO Y SEGURIDAD */}
                                <div className="space-y-6">
                                    <div className="bg-gray-50/50 dark:bg-zinc-900/50 p-6 rounded-[2rem] border border-gray-100 dark:border-white/5 space-y-4">
                                        <label className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest flex items-center gap-2">
                                            <ShieldCheck size={14} className="text-emerald-500" /> Criterios de Exportación
                                        </label>
                                        
                                        <RadioGroup 
                                            value={format} 
                                            onValueChange={setFormat}
                                            orientation="horizontal"
                                            classNames={{ wrapper: "gap-4" }}
                                        >
                                            <Radio value="PDF" classNames={{ label: "text-[10px] font-black uppercase italic" }}>Documento PDF</Radio>
                                            <Radio value="EXCEL" classNames={{ label: "text-[10px] font-black uppercase italic" }}>Excel Sheet</Radio>
                                            <Radio value="CSV" classNames={{ label: "text-[10px] font-black uppercase italic" }}>CSV Tabular</Radio>
                                        </RadioGroup>

                                        <Divider className="my-2 opacity-10" />

                                        <CheckboxGroup 
                                            value={dataSources}
                                            onValueChange={setDataSources}
                                            classNames={{ wrapper: "gap-2" }}
                                        >
                                            <Checkbox value="details" classNames={{ label: "text-[10px] font-bold uppercase tracking-tighter" }}>Incluir Listado Detallado</Checkbox>
                                            <Checkbox value="logs" classNames={{ label: "text-[10px] font-bold uppercase tracking-tighter" }}>Anexar Logs de Auditoría</Checkbox>
                                            <Checkbox value="api" classNames={{ label: "text-[10px] font-bold uppercase tracking-tighter" }}>Consolidar Uso de API</Checkbox>
                                        </CheckboxGroup>
                                    </div>

                                    <div className="space-y-2">
                                        <label className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest ml-1">Enviar Copia a Email (Opcional)</label>
                                        <Input 
                                            value={deliveryEmail}
                                            onValueChange={setDeliveryEmail}
                                            placeholder="CORREO@DESTINO.COM"
                                            classNames={{
                                                inputWrapper: "bg-gray-100 dark:bg-white/5 border-2 border-transparent focus-within:!border-emerald-500/50 rounded-2xl h-12",
                                                input: "font-black text-[11px] uppercase"
                                            }}
                                            startContent={<Mail size={16} className="text-gray-400 mr-2" />}
                                        />
                                    </div>
                                    
                                    <Checkbox 
                                        isSelected={saveToCloud}
                                        onValueChange={setSaveToCloud}
                                        classNames={{ label: "text-[10px] font-black uppercase text-emerald-500 italic tracking-widest" }}
                                    >
                                        Auto-Archivar en Cloud Manager
                                    </Checkbox>
                                </div>
                            </div>
                        </ModalBody>

                        <ModalFooter className="justify-between items-center">
                            <div className="flex items-center gap-2 opacity-50">
                                <Clock size={12} />
                                <span className="text-[9px] font-bold uppercase italic tracking-[0.2em]">Estimado: {format === 'PDF' ? '3s' : 'Procesando...'}</span>
                            </div>
                            <div className="flex gap-3">
                                <Button variant="light" className="font-black text-[10px] uppercase tracking-widest italic rounded-xl px-8" onPress={onClose}>Cancelar</Button>
                                <Button 
                                    className="bg-emerald-500 text-white font-black text-[10px] uppercase tracking-widest italic rounded-2xl px-12 h-14 shadow-xl shadow-emerald-500/20"
                                    onPress={handleGenerate}
                                >
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
