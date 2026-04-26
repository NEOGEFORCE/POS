"use client";

import { useState } from "react";
import { 
    Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, 
    Button, Input, Textarea, Chip
} from "@heroui/react";
import { PackageSearch, AlertTriangle, Send, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-error";
import Cookies from "js-cookie";

interface MissingItemModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess?: () => void;
}

export default function MissingItemModal({ isOpen, onOpenChange, onSuccess }: MissingItemModalProps) {
    const { toast } = useToast();
    const [loading, setLoading] = useState(false);
    const [productName, setProductName] = useState("");
    const [note, setNote] = useState("");

    const handleSubmit = async () => {
        if (!productName.trim()) {
            toast({
                title: "REQUISITO",
                description: "Debe ingresar el nombre del producto.",
                variant: "destructive",
            });
            return;
        }

        setLoading(true);
        try {
            const token = Cookies.get('org-pos-token');
            await apiFetch("/missing-items", {
                method: "POST",
                body: JSON.stringify({
                    product_name: productName.toUpperCase(),
                    note: note.toUpperCase(),
                }),
                fallbackError: "No se pudo enviar el reporte."
            }, token!);

            toast({
                title: "REPORTE ENVIADO",
                description: "El faltante ha sido registrado para compras.",
                variant: "success",
            });

            setProductName("");
            setNote("");
            onOpenChange(false);
            if (onSuccess) onSuccess();
        } catch (error) {
            toast({
                title: "ERROR",
                description: "No se pudo enviar el reporte.",
                variant: "destructive",
            });
        } finally {
            setLoading(false);
        }
    };

    return (
        <Modal 
            isOpen={isOpen} 
            onOpenChange={onOpenChange}
            placement="center"
            backdrop="opaque"
            classNames={{
                base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-2xl shadow-2xl",
                wrapper: "bg-black/60 backdrop-blur-sm",
                header: "border-b border-gray-100 dark:border-white/10 py-5",
                body: "py-6",
                footer: "border-t border-gray-100 dark:border-white/10 py-5"
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="flex flex-col gap-1">
                            <div className="flex items-center gap-3">
                                <div className="h-10 w-10 bg-rose-500/20 text-rose-500 flex items-center justify-center rounded-xl shadow-lg shadow-rose-500/20">
                                    <PackageSearch size={22} />
                                </div>
                                <div>
                                    <h3 className="text-lg font-black text-zinc-900 dark:text-white uppercase italic tracking-tighter leading-none">
                                        Reportar <span className="text-rose-500">Faltante</span>
                                    </h3>
                                    <p className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest mt-1.5 leading-none">
                                        Notificar al área de compras
                                    </p>
                                </div>
                            </div>
                        </ModalHeader>
                        <ModalBody className="flex flex-col gap-6">
                            <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-2xl flex gap-3">
                                <AlertTriangle className="text-amber-500 shrink-0" size={18} />
                                <p className="text-[10px] font-bold text-amber-400 uppercase leading-relaxed tracking-wide">
                                    Use este formulario para reportar productos que los clientes piden y no están en inventario.
                                </p>
                            </div>

                            <div className="space-y-4">
                                <div className="space-y-1.5">
                                    <label className="text-[10px] font-black text-zinc-400 uppercase tracking-[0.2em] ml-2">Nombre del Producto</label>
                                    <Input
                                        placeholder="EJ: LECHE ALQUERÍA 1L..."
                                        value={productName}
                                        onValueChange={setProductName}
                                        autoFocus
                                        classNames={{
                                            inputWrapper: "h-14 bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-xl shadow-lg group-data-[focus=true]:border-rose-500/50 group-data-[focus=true]:shadow-rose-500/10 transition-all",
                                            input: "text-sm font-black uppercase italic text-zinc-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-600"
                                        }}
                                    />
                                </div>

                                <div className="space-y-1.5">
                                    <label className="text-[10px] font-black text-zinc-400 uppercase tracking-[0.2em] ml-2">Nota Adicional (Opcional)</label>
                                    <Textarea
                                        placeholder="EJ: VARIOS CLIENTES HAN PREGUNTADO..."
                                        value={note}
                                        onValueChange={setNote}
                                        classNames={{
                                            inputWrapper: "bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-xl shadow-lg group-data-[focus=true]:border-rose-500/50 group-data-[focus=true]:shadow-rose-500/10 transition-all min-h-[80px]",
                                            input: "text-sm font-medium uppercase italic text-zinc-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 p-3"
                                        }}
                                    />
                                </div>
                            </div>
                        </ModalBody>
                        <ModalFooter className="gap-3">
                            <Button 
                                variant="flat" 
                                onPress={onClose}
                                className="h-12 flex-1 rounded-xl font-black text-xs uppercase tracking-widest text-gray-400 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-white/5 hover:text-zinc-900 dark:hover:text-white italic transition-all border border-gray-200 dark:border-white/10"
                            >
                                CANCELAR
                            </Button>
                            <Button 
                                isLoading={loading}
                                onPress={handleSubmit}
                                startContent={!loading && <Send size={16} />}
                                className="h-12 flex-[1.5] rounded-xl font-bold text-sm uppercase tracking-wider bg-rose-500 hover:bg-rose-600 text-white shadow-lg shadow-rose-500/30 hover:shadow-rose-500/50 hover:-translate-y-0.5 active:translate-y-0 transition-all"
                            >
                                ENVIAR REPORTE
                            </Button>
                        </ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
}
