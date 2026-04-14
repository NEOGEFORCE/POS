"use client";

import {
    Modal, ModalContent, ModalHeader, ModalBody, Button, Input
} from "@heroui/react";
import { Search, User } from "lucide-react";
import { Customer } from "@/lib/definitions";

interface ClientSelectionModalProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    clientSearch: string;
    setClientSearch: (val: string) => void;
    filteredCustomers: Customer[];
    handleClientSelect: (dni: string) => void;
}

export default function ClientSelectionModal({
    isOpen,
    onOpenChange,
    clientSearch,
    setClientSearch,
    filteredCustomers,
    handleClientSelect
}: ClientSelectionModalProps) {
    return (
        <Modal 
            isOpen={isOpen} 
            onOpenChange={onOpenChange} 
            backdrop="blur" 
            classNames={{ 
                base: "bg-white dark:bg-zinc-950 rounded-xl border border-gray-200 dark:border-white/10" 
            }}
        >
            <ModalContent>
                {(onClose) => (
                    <>
                        <ModalHeader className="text-gray-900 dark:text-white font-black uppercase text-base p-4 border-b border-gray-100 dark:border-white/5">
                            Seleccionar Cliente
                        </ModalHeader>
                        <ModalBody className="p-4">
                            <Input 
                                autoFocus 
                                placeholder="BUSCAR..." 
                                value={clientSearch} 
                                onValueChange={setClientSearch} 
                                size="sm" 
                                startContent={<Search className="h-3 w-3 text-gray-400" />} 
                                classNames={{ 
                                    inputWrapper: "bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-white/10" 
                                }} 
                            />
                            <div className="max-h-60 overflow-y-auto mt-2 space-y-1 custom-scrollbar pr-2">
                                <Button 
                                    variant="flat" 
                                    className="w-full justify-start h-10 bg-sky-50 dark:bg-sky-500/10 text-gray-900 dark:text-white font-bold rounded-lg text-xs" 
                                    onPress={() => { handleClientSelect('0'); onClose(); }}
                                >
                                    <User className="h-4 w-4 mr-2 text-sky-500" /> Consumidor Final
                                </Button>
                                {filteredCustomers.map(c => (
                                    <Button 
                                        key={c.dni} 
                                        variant="flat" 
                                        className="w-full justify-start h-10 bg-gray-50 dark:bg-zinc-900 text-gray-900 dark:text-white font-bold rounded-lg text-xs hover:bg-gray-100 dark:hover:bg-white/5" 
                                        onPress={() => { handleClientSelect(c.dni); onClose(); }}
                                    >
                                        <User className="h-4 w-4 mr-2 text-gray-400 dark:text-zinc-500" /> {c.name}
                                    </Button>
                                ))}
                            </div>
                        </ModalBody>
                    </>
                )}
            </ModalContent>
        </Modal>
    );
}
