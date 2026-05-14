"use client";

import React, { useState, useEffect } from 'react';
import {
  Button, Card, CardBody, Table, TableHeader, TableColumn, TableBody,
  TableRow, TableCell, Input, Chip, Divider,
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  useDisclosure, Dropdown, DropdownTrigger, DropdownMenu, DropdownItem
} from "@heroui/react";
import {
  Search, Landmark, Calendar, Users, ArrowUpRight,
  AlertTriangle, MoreVertical, Receipt, DollarSign,
  Sparkles, CreditCard, FileText, Info, TrendingDown,
  Clock, Package, MapPin
} from 'lucide-react';
import { useToast } from "@/hooks/use-toast";

export default function DebtsControlPage() {
  const { toast } = useToast();
  const [debts, setDebts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  const [selectedDebt, setSelectedDebt] = useState<any>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("EFECTIVO");
  const { isOpen: isStatementOpen, onOpen: onStatementOpen, onOpenChange: onStatementOpenChange } = useDisclosure();
  const [statementData, setStatementData] = useState<any>(null);
  const [loadingStatement, setLoadingStatement] = useState(false);

  useEffect(() => {
    fetchDebts();
  }, []);

  const fetchDebts = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/sales/debts');
      const data = await res.json();
      setDebts(Array.isArray(data) ? data : []);
    } catch (error) {
      toast({ title: "Error", description: "Error al cargar cartera", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handlePayment = async () => {
    if (!paymentAmount || parseFloat(paymentAmount) <= 0) {
      toast({ title: "Error", description: "Ingresa un monto válido", variant: "destructive" });
      return;
    }

    try {
      const res = await fetch(`/api/sales/debts/${selectedDebt.id}/pay`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: parseFloat(paymentAmount),
          method: paymentMethod
        })
      });

      if (res.ok) {
        toast({ title: "Éxito", description: "¡Abono registrado con éxito!" });
        onOpenChange();
        fetchDebts();
      } else {
        toast({ title: "Error", description: "Error al registrar el pago", variant: "destructive" });
      }
    } catch (error) {
      toast({ title: "Error", description: "Error de conexión", variant: "destructive" });
    }
  };

  const totalCarpet = debts.reduce((acc, d) => acc + (d.debtPending || 0), 0);

  const filteredDebts = debts.filter(d =>
    d.client?.name.toLowerCase().includes(search.toLowerCase()) ||
    d.client?.dni.includes(search)
  );

  const fetchStatement = async (dni: string) => {
    setLoadingStatement(true);
    onStatementOpen();
    try {
      const res = await fetch(`/api/clients/${dni}/statement`);
      const data = await res.json();
      setStatementData(data);
    } catch (error) {
      toast({ title: "Error", description: "No se pudo obtener el estado de cuenta", variant: "destructive" });
    } finally {
      setLoadingStatement(false);
    }
  };

  return (
    <div className="flex flex-col gap-8 p-8 max-w-[1600px] mx-auto animate-in fade-in slide-in-from-bottom-4 duration-700">
      {/* HEADER SECTION */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 bg-white/50 dark:bg-zinc-900/50 backdrop-blur-3xl p-8 rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-xl">
        <div className="flex items-center gap-6">
          <div className="h-20 w-20 bg-amber-500/10 text-amber-500 flex items-center justify-center rounded-[1.75rem] shadow-inner -rotate-3 border border-amber-500/20">
            <Landmark size={40} />
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-3">
              <span className="h-3 w-3 rounded-full bg-amber-500 animate-bounce" />
              <h1 className="text-4xl font-black text-gray-900 dark:text-white italic tracking-tighter uppercase leading-none">
                Control de <span className="text-amber-500 text-5xl">Cartera</span>
              </h1>
            </div>
            <p className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.4em] mt-3 italic opacity-70">Auditoría de Fiados y Cuentas por Cobrar</p>
          </div>
        </div>

        <div className="flex items-center gap-8">
          <div className="hidden md:flex flex-col items-end">
            <span className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic opacity-60 mb-1">CAPITAL EN LA CALLE</span>
            <div className="flex items-baseline gap-2">
              <h2 className="text-4xl font-black text-gray-900 dark:text-white italic tracking-tighter">${totalCarpet.toLocaleString()}</h2>
              <span className="text-xs font-black text-amber-500 uppercase">GLO</span>
            </div>
          </div>
          <div className="h-14 w-[1px] bg-gray-200 dark:bg-white/10 hidden md:block" />
          <Input
            placeholder="BUSCAR CLIENTE O DOCUMENTO..."
            value={search}
            onValueChange={setSearch}
            startContent={<Search size={18} className="text-gray-400" />}
            className="w-full md:w-80"
            classNames={{
              inputWrapper: "h-16 bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-[1.25rem] shadow-inner shadow-gray-100/50 dark:shadow-none transition-all focus-within:!border-amber-500/50",
              input: "font-black text-xs uppercase italic"
            }}
          />
        </div>
      </div>

      {/* TABLE SECTION */}
      <Card className="bg-white/80 dark:bg-zinc-950/60 backdrop-blur-3xl rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-2xl overflow-hidden min-h-[600px]">
        <CardBody className="p-0">
          <Table
            aria-label="Debts table"
            className="p-8"
            classNames={{
              th: "bg-gray-50/50 dark:bg-zinc-900/50 h-16 font-black text-[11px] uppercase tracking-widest italic border-b border-gray-100 dark:border-white/5 text-gray-400 dark:text-zinc-500",
              td: "py-7 font-bold text-sm",
              tbody: "divide-y divide-gray-100 dark:divide-white/5"
            }}
            removeWrapper
          >
            <TableHeader>
              <TableColumn width={400}>CLIENTE / TITULAR</TableColumn>
              <TableColumn>EXPEDICIÓN</TableColumn>
              <TableColumn>VALOR FACTURA</TableColumn>
              <TableColumn>SALDO PENDIENTE</TableColumn>
              <TableColumn>ESTADO</TableColumn>
              <TableColumn align="center">ACCIONES</TableColumn>
            </TableHeader>
            <TableBody emptyContent={loading ? "ANALIZANDO CARTERA..." : "NO SE ENCONTRARON DEUDAS ACTIVAS"}>
              {filteredDebts.map((debt) => (
                <TableRow key={debt.id} className="hover:bg-gray-50/50 dark:hover:bg-white/5 transition-all group">
                  <TableCell>
                    <div className="flex items-center gap-4">
                      <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-gray-100 to-gray-200 dark:from-zinc-800 dark:to-zinc-900 flex items-center justify-center border border-gray-200 dark:border-white/5 group-hover:rotate-6 transition-transform shadow-sm">
                        <Users size={20} className="text-amber-500" />
                      </div>
                      <div className="flex flex-col">
                        <span className="font-black text-gray-900 dark:text-white uppercase italic tracking-tight">{debt.client?.name}</span>
                        <span className="text-[10px] text-gray-400 dark:text-zinc-500 uppercase font-black tracking-widest opacity-60">DNI: {debt.client?.dni}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2 text-gray-400 dark:text-zinc-500 font-mono text-xs">
                      <Calendar size={14} />
                      {new Date(debt.date).toLocaleDateString()}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="font-bold text-gray-400 dark:text-zinc-600 tracking-tighter">${debt.total.toLocaleString()}</span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-black text-amber-500 text-lg italic tracking-tighter">${debt.debtPending.toLocaleString()}</span>
                      <div className="h-1.5 w-24 bg-gray-100 dark:bg-white/5 rounded-full mt-1 overflow-hidden">
                        <div
                          className="h-full bg-amber-500 rounded-full shadow-[0_0_10px_rgba(245,158,11,0.5)]"
                          style={{ width: `${(debt.debtPending / debt.total) * 100}%` }}
                        />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Chip size="sm" variant="flat" color="warning" className="font-black text-[10px] uppercase italic tracking-widest px-4 rounded-xl border border-amber-500/10">
                      EN COBRO
                    </Chip>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        size="sm"
                        className="bg-amber-500 text-white font-black text-[9px] uppercase italic tracking-widest px-4 rounded-xl shadow-lg shadow-amber-500/20 hover:scale-110 active:scale-95 transition-all"
                        onPress={() => {
                          setSelectedDebt(debt);
                          setPaymentAmount(debt.debtPending.toString());
                          onOpen();
                        }}
                      >
                        ABONAR <ArrowUpRight size={14} className="ml-1" />
                      </Button>
                      <Dropdown backdrop="blur">
                        <DropdownTrigger>
                          <Button isIconOnly size="sm" variant="light" className="rounded-xl text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
                            <MoreVertical size={18} />
                          </Button>
                        </DropdownTrigger>
                        <DropdownMenu aria-label="Acciones de deuda" className="font-black uppercase italic text-[10px]">
                          <DropdownItem key="statement" startContent={<FileText size={16} className="text-blue-500" />} onPress={() => fetchStatement(debt.client.dni)}>Ver Estado de Cuenta</DropdownItem>
                          <DropdownItem key="history" startContent={<Receipt size={16} />}>Ver Factura Original</DropdownItem>
                          <DropdownItem key="sms" startContent={<AlertTriangle size={16} />} className="text-amber-500">Recordatorio SMS</DropdownItem>
                        </DropdownMenu>
                      </Dropdown>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardBody>
      </Card>

      {/* PAYMENT MODAL */}
      <Modal
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        backdrop="blur"
        size="md"
        classNames={{
          base: "bg-white/95 dark:bg-zinc-950/95 backdrop-blur-3xl rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-2xl mx-4",
          header: "p-8 border-b border-gray-100 dark:border-white/5",
          body: "p-8",
          footer: "p-8 bg-gray-50/50 dark:bg-zinc-900/50 rounded-b-[2.5rem]"
        }}
      >
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex flex-col">
                <div className="flex items-center gap-4">
                  <div className="h-12 w-12 bg-amber-500/10 text-amber-500 rounded-2xl flex items-center justify-center border border-amber-500/20 shadow-inner">
                    <CreditCard size={24} />
                  </div>
                  <div>
                    <h3 className="text-2xl font-black text-gray-900 dark:text-white uppercase italic tracking-tighter">Liquidación <span className="text-amber-500">Cartera</span></h3>
                    <p className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic">Registrar Ingreso de Dinero</p>
                  </div>
                </div>
              </ModalHeader>
              <ModalBody className="gap-8">
                <div className="bg-amber-500/5 dark:bg-amber-500/10 p-6 rounded-[2rem] border border-amber-500/10 flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest opacity-70">Deuda Actual</span>
                    <span className="text-2xl font-black text-amber-500 italic tracking-tighter">${selectedDebt?.debtPending.toLocaleString()}</span>
                  </div>
                  <Chip size="sm" variant="shadow" color="warning" className="font-black text-[10px] italic">ESTADO: MORA</Chip>
                </div>

                <div className="space-y-6">
                  <div className="space-y-3">
                    <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest ml-1 italic">MONTO DEL ABONO</label>
                    <Input
                      type="number"
                      placeholder="0"
                      value={paymentAmount}
                      onValueChange={setPaymentAmount}
                      startContent={<DollarSign size={20} className="text-amber-500" />}
                      classNames={{
                        inputWrapper: "h-16 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-2xl shadow-inner transition-all focus-within:!border-amber-500",
                        input: "font-black text-2xl text-gray-900 dark:text-white italic tracking-tight"
                      }}
                    />
                  </div>

                  <div className="space-y-3">
                    <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest ml-1 italic">MÉTODO DE PAGO</label>
                    <div className="grid grid-cols-2 gap-3">
                      {["EFECTIVO", "NEQUI", "DAVIPLATA", "OTRO"].map(m => (
                        <Button
                          key={m}
                          variant={paymentMethod === m ? "solid" : "flat"}
                          className={`h-14 font-black uppercase italic text-[10px] tracking-widest rounded-2xl ${paymentMethod === m ? 'bg-amber-500 text-white shadow-lg' : 'bg-gray-50 dark:bg-zinc-900 text-gray-400 opacity-60'}`}
                          onPress={() => setPaymentMethod(m)}
                        >
                          {m}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              </ModalBody>
              <ModalFooter>
                <Button className="w-full h-16 bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase text-sm tracking-[0.25em] rounded-2xl shadow-xl hover:scale-[1.03] active:scale-95 transition-all italic group" onPress={handlePayment}>
                  <Sparkles size={20} className="mr-3 group-hover:rotate-12 transition-transform" />
                  CONFIRMAR RECAUDO
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
      {/* STATEMENT MODAL */}
      <Modal 
        isOpen={isStatementOpen} 
        onOpenChange={onStatementOpenChange} 
        size="3xl" 
        scrollBehavior="inside"
        classNames={{
          base: "bg-white dark:bg-zinc-950 rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-2xl",
          header: "p-8 border-b border-gray-100 dark:border-white/5",
          body: "p-0", // Lo manejamos interno
          footer: "p-6 bg-gray-50 dark:bg-zinc-900/50"
        }}
      >
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex flex-col gap-1">
                <div className="flex items-center gap-4">
                  <div className="h-14 w-14 bg-blue-500/10 text-blue-500 rounded-2xl flex items-center justify-center border border-blue-500/20 shadow-inner rotate-3">
                    <FileText size={28} />
                  </div>
                  <div>
                    <h3 className="text-3xl font-black text-gray-900 dark:text-white uppercase italic tracking-tighter">Estado de <span className="text-blue-500">Cuenta</span></h3>
                    <p className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.4em] italic flex items-center gap-2">
                      <Clock size={10} className="text-blue-500" /> Historial de Ciclo Activo
                    </p>
                  </div>
                </div>
              </ModalHeader>
              <ModalBody>
                {loadingStatement ? (
                  <div className="p-20 flex flex-col items-center justify-center gap-4">
                    <div className="h-12 w-12 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin" />
                    <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest italic">Generando reporte de ciclo...</span>
                  </div>
                ) : statementData ? (
                  <div className="flex flex-col">
                    {/* RESUMEN CABECERA */}
                    <div className="grid grid-cols-3 gap-1 p-8 bg-gradient-to-br from-blue-500/[0.02] to-transparent">
                      <div className="flex flex-col gap-1">
                        <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest italic">Titular</span>
                        <span className="text-sm font-black uppercase italic text-gray-900 dark:text-white">{statementData.client?.name}</span>
                        <span className="text-[10px] font-mono text-gray-400">{statementData.client?.dni}</span>
                      </div>
                      <div className="flex flex-col gap-1 items-center border-x border-gray-100 dark:border-white/5">
                        <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest italic">Abonos Realizados</span>
                        <span className="text-xl font-black text-emerald-500 italic tracking-tighter">
                          ${(statementData.payments?.reduce((acc: any, p: any) => acc + p.totalPaid, 0) || 0).toLocaleString()}
                        </span>
                      </div>
                      <div className="flex flex-col gap-1 items-end">
                        <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest italic">Saldo a la Fecha</span>
                        <span className="text-2xl font-black text-blue-500 italic tracking-tighter">
                          ${(statementData.client?.currentCredit || 0).toLocaleString()}
                        </span>
                      </div>
                    </div>

                    <Divider className="opacity-50" />

                    {/* LÍNEA DE TIEMPO DEL CICLO */}
                    <div className="p-8 space-y-8">
                      <h4 className="text-[11px] font-black text-gray-900 dark:text-white uppercase italic tracking-[0.3em] flex items-center gap-2">
                         <TrendingDown size={14} className="text-blue-500" /> Movimientos del Ciclo
                      </h4>
                      
                      <div className="relative space-y-6 before:absolute before:left-[19px] before:top-2 before:bottom-2 before:w-[2px] before:bg-gray-100 dark:before:bg-white/5">
                        {/* UNIFICAR VENTAS Y PAGOS CRONOLÓGICAMENTE */}
                        {[
                          ...(statementData.pending?.map((s: any) => ({ ...s, type: 'SALE' })) || []),
                          ...(statementData.payments?.map((p: any) => ({ ...p, type: 'PAYMENT', date: p.paymentDate })) || [])
                        ].sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime()).map((item: any, idx: number) => (
                          <div key={idx} className="relative pl-12 group">
                            {/* PUNTO DE LA LÍNEA */}
                            <div className={`absolute left-0 top-1.5 h-10 w-10 rounded-xl flex items-center justify-center border-2 transition-all ${
                              item.type === 'SALE' 
                                ? 'bg-white dark:bg-zinc-900 border-blue-500/20 text-blue-500 group-hover:scale-110 shadow-lg shadow-blue-500/10' 
                                : 'bg-emerald-500 border-emerald-500 text-white shadow-lg shadow-emerald-500/20'
                            }`}>
                              {item.type === 'SALE' ? <Package size={18} /> : <DollarSign size={18} />}
                            </div>

                            <div className="flex flex-col gap-2">
                              <div className="flex items-center justify-between">
                                <div className="flex flex-col">
                                  <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{new Date(item.date).toLocaleString()}</span>
                                  <span className={`text-sm font-black uppercase italic tracking-tight ${item.type === 'SALE' ? 'text-gray-900 dark:text-white' : 'text-emerald-500'}`}>
                                    {item.type === 'SALE' ? `Compra a Crédito #${item.id}` : `Abono a Cartera - ${item.transferSource || 'EFECTIVO'}`}
                                  </span>
                                </div>
                                <span className={`text-lg font-black italic tracking-tighter ${item.type === 'SALE' ? 'text-gray-900 dark:text-white' : 'text-emerald-500'}`}>
                                  {item.type === 'SALE' ? `+$${item.total.toLocaleString()}` : `-$${item.totalPaid.toLocaleString()}`}
                                </span>
                              </div>

                              {/* SI ES VENTA, MOSTRAR PRODUCTOS */}
                              {item.type === 'SALE' && (
                                <div className="bg-gray-50 dark:bg-zinc-900/50 rounded-2xl p-4 mt-1 border border-gray-100 dark:border-white/5">
                                  <div className="grid grid-cols-1 gap-2">
                                    {item.details?.map((d: any, dIdx: number) => (
                                      <div key={dIdx} className="flex items-center justify-between text-[10px] font-bold text-gray-500 dark:text-zinc-400">
                                        <div className="flex items-center gap-2">
                                          <span className="h-1.5 w-1.5 rounded-full bg-blue-500/40" />
                                          <span className="uppercase tracking-tight">{d.product?.name || 'PRODUCTO'}</span>
                                          <span className="text-[8px] px-1.5 py-0.5 bg-gray-200 dark:bg-zinc-800 rounded-md text-gray-400 font-mono">x{d.quantity}</span>
                                        </div>
                                        <span className="font-mono">${d.subtotal.toLocaleString()}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
              </ModalBody>
              <ModalFooter>
                <Button className="bg-blue-500 text-white font-black uppercase italic text-xs tracking-widest h-12 rounded-xl shadow-lg shadow-blue-500/20" onPress={() => window.print()}>
                  Imprimir Comprobante
                </Button>
                <Button variant="flat" className="font-black uppercase italic text-xs tracking-widest h-12 rounded-xl" onPress={onClose}>
                  Cerrar
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}
