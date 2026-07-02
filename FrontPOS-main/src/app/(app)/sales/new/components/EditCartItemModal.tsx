"use client";

import React, { useState, useEffect } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Input } from "@heroui/react";
import { Edit2 } from "lucide-react";

interface EditCartItemModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    item: any | null;
    onSave: (quantity: number, price: number) => void;
}

export function EditCartItemModal({ isOpen, onOpenChange, item, onSave }: EditCartItemModalProps) {
    const [quantity, setQuantity] = useState<string>("");
    const [price, setPrice] = useState<string>("");

    useEffect(() => {
        if (isOpen && item) {
            setQuantity(String(item.cartQuantity));
            setPrice(String(item.salePrice));
        }
    }, [isOpen, item]);

    const handleSave = () => {
        const parsedQty = parseFloat(quantity);
        const parsedPrice = parseFloat(price);
        
        if (!isNaN(parsedQty) && parsedQty > 0 && !isNaN(parsedPrice) && parsedPrice >= 0) {
            onSave(parsedQty, parsedPrice);
            onOpenChange(false);
        }
    };

    return (
        <Modal 
            isOpen={isOpen} 
            onOpenChange={onOpenChange}
            placement="center"
            classNames={{
                base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-3xl",
                header: "border-b border-gray-100 dark:border-white/5",
                footer: "border-t border-gray-100 dark:border-white/5",
                closeButton: "hover:bg-gray-100 dark:hover:bg-black/5 dark:bg-white/10 active:bg-gray-200 transition-colors"
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="flex items-center gap-3">
                            <div className="h-10 w-10 bg-emerald-100 dark:bg-emerald-500/10 text-emerald-600 rounded-2xl flex items-center justify-center">
                                <Edit2 size={20} />
                            </div>
                            <div className="flex flex-col">
                                <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-50 tracking-tight leading-none">Editar Item</h2>
                                <p className="text-[11px] font-medium text-gray-500 dark:text-zinc-500 dark:text-zinc-400 mt-1 uppercase tracking-wider">{item?.productName}</p>
                            </div>
                        </ModalHeader>
                        <ModalBody className="py-6">
                            <div className="flex flex-col gap-4">
                                <Input
                                    label="Precio Unitario"
                                    type="number"
                                    value={price}
                                    onValueChange={setPrice}
                                    startContent={<span className="text-gray-500 dark:text-zinc-500 font-bold">$</span>}
                                    classNames={{
                                        inputWrapper: "bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-white/10 shadow-inner rounded-2xl h-14",
                                        label: "font-bold text-zinc-600 dark:text-zinc-400",
                                        input: "font-bold text-lg tabular-nums"
                                    }}
                                />
                                <Input
                                    label="Cantidad"
                                    type="number"
                                    step="any"
                                    value={quantity}
                                    onValueChange={setQuantity}
                                    classNames={{
                                        inputWrapper: "bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-white/10 shadow-inner rounded-2xl h-14",
                                        label: "font-bold text-zinc-600 dark:text-zinc-400",
                                        input: "font-bold text-lg tabular-nums"
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            handleSave();
                                        }
                                    }}
                                />
                            </div>
                        </ModalBody>
                        <ModalFooter>
                            <Button 
                                variant="light" 
                                onPress={onClose}
                                className="font-bold rounded-2xl"
                            >
                                Cancelar
                            </Button>
                            <Button 
                                color="primary" 
                                onPress={handleSave}
                                className="font-bold rounded-2xl shadow-[0_8px_30px_rgb(16,185,129,0.3)] bg-emerald-500 text-white"
                            >
                                Guardar Cambios
                            </Button>
                        </ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
}
