"use client";

import React, { useState, useEffect } from 'react';
import { 
  Button, Card, CardBody, Select, SelectItem, Table, TableHeader, 
  TableColumn, TableBody, TableRow, TableCell, Input, Chip,
  Divider, Skeleton
} from "@heroui/react";
import { 
  ShoppingBag, Truck, Calendar, DollarSign, Plus, FileText, 
  Trash2, ChevronRight, Sparkles, Filter, CheckCircle2, AlertCircle
} from 'lucide-react';
import { Supplier } from '@/lib/definitions';
import { useToast } from "@/hooks/use-toast";

export default function SmartOrdersPage() {
  const { toast } = useToast();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selectedSupplier, setSelectedSupplier] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [orderItems, setOrderItems] = useState<any[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  // Fetch suppliers on mount
  useEffect(() => {
    fetchSuppliers();
  }, []);

  const fetchSuppliers = async () => {
    try {
      const res = await fetch('/api/suppliers/all-suppliers');
      const data = await res.json();
      setSuppliers(data);
    } catch (error) {
       toast({ title: "Error", description: "Error al cargar proveedores", variant: "destructive" });
    }
  };

  const loadSuggestions = async (supplierId: string) => {
    if (!supplierId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/inventory/suggested-orders?supplier_id=${supplierId}`);
      const data = await res.json();
      // Auto-fill order items with suggested amounts
      setOrderItems(data.map((item: any) => ({
        ...item,
        quantity: item.suggested || 1,
        unitPrice: item.purchasePrice || 0
      })));
    } catch (error) {
      toast({ title: "Error", description: "Error al cargar sugerencias inteligentes", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleSupplierChange = (id: string) => {
    setSelectedSupplier(id);
    loadSuggestions(id);
  };

  const totalEstimated = orderItems.reduce((acc, item) => acc + (item.quantity * item.unitPrice), 0);

  const handleSaveOrder = async () => {
    if (orderItems.length === 0) {
      toast({ title: "Error", description: "No hay productos en la orden", variant: "destructive" });
      return;
    }
    setIsSaving(true);
    try {
      const res = await fetch('/api/inventory/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId: parseInt(selectedSupplier),
          estimatedCost: totalEstimated,
          status: 'PENDING',
          items: orderItems.map(item => ({
            productBarcode: item.barcode,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            subtotal: item.quantity * item.unitPrice
          }))
        })
      });

      if (res.ok) {
        toast({ title: "Éxito", description: "¡Orden Maestra generada con éxito!" });
      } else {
        toast({ title: "Error", description: "Error al guardar la orden", variant: "destructive" });
      }
    } catch (error) {
      toast({ title: "Error", description: "Error de conexión", variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-8 p-8 max-w-[1600px] mx-auto animate-in fade-in slide-in-from-bottom-4 duration-700">
      {/* HEADER SECTION */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 bg-white/50 dark:bg-zinc-900/50 backdrop-blur-3xl p-8 rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-xl">
        <div className="flex items-center gap-6">
          <div className="h-20 w-20 bg-emerald-500/10 text-emerald-500 flex items-center justify-center rounded-[1.75rem] shadow-inner rotate-3 border border-emerald-500/20">
            <ShoppingBag size={40} />
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-3">
              <span className="h-3 w-3 rounded-full bg-emerald-500 animate-pulse" />
              <h1 className="text-4xl font-black text-gray-900 dark:text-white italic tracking-tighter uppercase leading-none">
                Smart <span className="text-emerald-500 text-5xl">Restock</span>
              </h1>
            </div>
            <p className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-[0.4em] mt-3 italic opacity-70">Generador de Pedidos Inteligente V4.0</p>
          </div>
        </div>

        <div className="flex items-center gap-4 w-full md:w-auto">
          <div className="flex flex-col gap-1 w-full md:w-80">
            <label className="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest ml-4 mb-1">PROVEEDOR / PREVENTISTA</label>
            <Select 
              placeholder="SELECCIONAR MAESTRO"
              selectedKeys={selectedSupplier ? [selectedSupplier] : []}
              onSelectionChange={(keys) => handleSupplierChange(Array.from(keys)[0] as string)}
              classNames={{
                trigger: "h-16 bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 rounded-[1.25rem] shadow-inner transition-all hover:scale-[1.02] active:scale-95",
                value: "font-black text-base uppercase italic text-gray-900 dark:text-white"
              }}
              startContent={<Truck size={20} className="text-emerald-500 mr-2" />}
            >
              {suppliers.map((s) => (
                <SelectItem key={s.id} className="font-bold uppercase italic">{s.name}</SelectItem>
              ))}
            </Select>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* MAIN ORDER TABLE */}
        <Card className="lg:col-span-8 bg-white/80 dark:bg-zinc-950/60 backdrop-blur-3xl rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-2xl overflow-hidden min-h-[600px]">
          <CardBody className="p-0">
            <div className="p-8 border-b border-gray-100 dark:border-white/5 flex items-center justify-between bg-gray-50/50 dark:bg-zinc-900/50">
              <div className="flex items-center gap-3">
                <FileText size={20} className="text-emerald-500" />
                <h3 className="font-black text-gray-900 dark:text-white uppercase italic tracking-tighter text-xl">Detalle del Pedido</h3>
              </div>
              <Chip size="sm" variant="flat" color="success" className="font-black text-[10px] uppercase italic tracking-widest px-4 py-4 rounded-xl border border-emerald-500/20">
                {orderItems.length} PRODUCTOS SUGERIDOS
              </Chip>
            </div>

            <Table 
              aria-label="Order items table"
              className="p-4"
              classNames={{
                th: "bg-gray-50/50 dark:bg-zinc-900/50 h-14 font-black text-[11px] uppercase tracking-widest italic border-b border-gray-100 dark:border-white/5 text-gray-400 dark:text-zinc-500",
                td: "py-6 font-bold text-sm",
                tbody: "divide-y divide-gray-100 dark:divide-white/5"
              }}
              removeWrapper
            >
              <TableHeader>
                <TableColumn width={400}>PRODUCTO / BARCODE</TableColumn>
                <TableColumn>STOCK</TableColumn>
                <TableColumn>REPOSICIÓN</TableColumn>
                <TableColumn>COSTO UNIT.</TableColumn>
                <TableColumn align="end">SUBTOTAL</TableColumn>
              </TableHeader>
              <TableBody emptyContent={loading ? <Skeleton className="h-32 w-full rounded-3xl" /> : "SELECCIONA UN PROVEEDOR PARA GENERAR SUGERENCIAS"}>
                {orderItems.map((item, index) => (
                  <TableRow key={item.barcode} className="hover:bg-gray-50/50 dark:hover:bg-white/5 transition-colors group">
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-black text-gray-900 dark:text-white uppercase italic truncate max-w-[300px]">{item.productName}</span>
                        <span className="text-[10px] text-gray-400 dark:text-zinc-500 font-mono tracking-widest">{item.barcode}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Chip size="sm" variant="dot" color={item.stock <= item.minStock ? "danger" : "warning"} className="font-black text-[10px]">
                          {item.stock}
                        </Chip>
                        <span className="text-[10px] text-gray-400 dark:text-zinc-500 capitalize italic opacity-60">Mín: {item.minStock}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Input 
                          type="number"
                          size="sm"
                          value={item.quantity.toString()}
                          onValueChange={(v) => {
                            const newItems = [...orderItems];
                            newItems[index].quantity = parseFloat(v) || 0;
                            setOrderItems(newItems);
                          }}
                          classNames={{
                            inputWrapper: "w-24 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-xl h-10",
                            input: "font-black text-center"
                          }}
                        />
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 font-black text-emerald-500 italic">
                        <span className="text-xs opacity-50">$</span>
                        {item.unitPrice.toLocaleString()}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-end">
                        <span className="font-black text-gray-900 dark:text-white italic">
                          ${(item.quantity * item.unitPrice).toLocaleString()}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardBody>
        </Card>

        {/* SIDEBAR SUMMARY */}
        <div className="lg:col-span-4 space-y-8">
          <Card className="bg-emerald-500 text-white rounded-[2.5rem] border-none shadow-[0_20px_50px_-10px_rgba(16,185,129,0.3)] overflow-hidden relative group">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.2),transparent)] pointer-events-none" />
            <div className="absolute -top-12 -right-12 h-40 w-40 bg-white/10 blur-3xl rounded-full" />
            
            <CardBody className="p-10 relative z-10">
              <div className="flex items-center justify-between mb-8">
                <div className="h-12 w-12 bg-white/20 backdrop-blur-md rounded-2xl flex items-center justify-center">
                  <DollarSign size={24} />
                </div>
                <div className="px-4 py-2 bg-white/10 backdrop-blur-md rounded-xl border border-white/20">
                  <span className="text-[10px] font-black uppercase tracking-[0.2em] italic">Proyección de Compra</span>
                </div>
              </div>

              <div className="space-y-2">
                <span className="text-[11px] font-black uppercase tracking-[0.3em] opacity-70">COSTO ESTIMADO DEL PEDIDO</span>
                <div className="flex items-baseline gap-2">
                  <h2 className="text-5xl font-black italic tracking-tighter leading-none">${totalEstimated.toLocaleString()}</h2>
                  <span className="text-sm font-black opacity-60">COP</span>
                </div>
              </div>

              <Divider className="my-8 bg-white/20" />

              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 opacity-80">
                    <Calendar size={14} />
                    <span className="text-[10px] font-black uppercase italic tracking-widest text-zinc-100">Entrega Estimada</span>
                  </div>
                  <span className="font-black text-xs uppercase italic tracking-tighter shadow-sm bg-white/10 px-3 py-1 rounded-lg border border-white/10">PENDIENTE</span>
                </div>
                
                <Button 
                  className="w-full h-16 bg-white text-emerald-600 font-black uppercase text-sm tracking-[0.2em] rounded-2xl shadow-xl hover:scale-[1.03] active:scale-95 transition-all group"
                  onPress={handleSaveOrder}
                  isLoading={isSaving}
                  isDisabled={orderItems.length === 0}
                >
                  <Sparkles size={20} className="mr-3 group-hover:rotate-12 transition-transform" />
                  GENERAR ORDEN MAESTRA
                </Button>

                <p className="text-[9px] font-black uppercase text-center opacity-60 italic tracking-widest leading-relaxed">
                  AL GENERAR LA ORDEN SE CREARÁ AUTOMÁTICAMENTE UNA CUENTA POR PAGAR VIRTUAL
                </p>
              </div>
            </CardBody>
          </Card>

          <Card className="bg-white/80 dark:bg-zinc-900/50 backdrop-blur-3xl rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-xl overflow-hidden p-8">
            <div className="flex items-center gap-3 mb-6">
              <AlertCircle size={20} className="text-emerald-500" />
              <h3 className="font-black text-gray-900 dark:text-white uppercase italic tracking-widest text-xs">Configuración Rápida</h3>
            </div>
            
            <div className="space-y-6">
              <div className="p-5 bg-gray-50 dark:bg-zinc-800/50 rounded-[1.5rem] border border-gray-100 dark:border-white/5 space-y-3">
                <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest italic">AGENDA LOGÍSTICA</span>
                <div className="flex justify-between items-center">
                  <span className="font-black text-xs uppercase text-gray-900 dark:text-zinc-300 italic tracking-tighter">Día de Visita</span>
                  <Chip size="sm" className="bg-emerald-500/10 text-emerald-500 font-black border border-emerald-500/20 uppercase italic">PENDIENTE</Chip>
                </div>
              </div>

              <Button 
                variant="flat"
                className="w-full h-14 bg-gray-900 dark:bg-white text-white dark:text-black font-black uppercase text-[10px] tracking-[0.2em] rounded-2xl transition-all"
              >
                EXPORTAR A PDF / WHATSAPP
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
