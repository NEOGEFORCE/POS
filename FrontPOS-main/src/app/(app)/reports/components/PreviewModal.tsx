"use client";

import { 
  Modal, ModalContent, ModalHeader, ModalBody, 
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Card, CardBody
} from "@heroui/react";
import React from 'react';
import { FileSearch, TrendingUp, PieChart, Wallet, ShoppingBag, ArrowUpRight, ArrowDownRight, Tag } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

interface PreviewModalProps {
  isOpen: boolean;
  onOpenChange: () => void;
  title: string;
  data: any;
}

export default function PreviewModal({ isOpen, onOpenChange, title, data }: PreviewModalProps) {
  if (!data) return null;

  const isPnL = data.totalRevenue !== undefined;
  const isKardex = Array.isArray(data) && data.length > 0 && data[0].barcode !== undefined && data[0].type !== undefined;
  const isLowStock = data.lowStockProducts !== undefined;

  // Normalizar datos para la tabla basado en el tipo de reporte
  const getTableContent = () => {
    // Caso para Alerta de Stock (Bajo del mínimo)
    if (isLowStock) {
        return {
            columns: [
                { key: 'barcode', label: 'BARCODE' },
                { key: 'name', label: 'PRODUCTO' },
                { key: 'stock', label: 'EXISTENCIAS' },
                { key: 'minStock', label: 'MÍNIMO ALERTA' },
            ],
            rows: data.lowStockProducts.map((item: any, i: number) => ({
                id: i,
                ...item,
                stock: (
                    <span className="text-rose-500 font-black">{item.stock}</span>
                )
            }))
        };
    }

    // Caso para Kárdex (Movimientos)
    if (isKardex) {
        return {
            columns: [
                { key: 'date', label: 'FECHA' },
                { key: 'name', label: 'PRODUCTO' },
                { key: 'quantity', label: 'CANT.' },
                { key: 'type', label: 'TIPO' },
                { key: 'reason', label: 'MOTIVO' },
                { key: 'employee', label: 'RESPONSABLE' },
                { key: 'ref', label: 'REF' },
            ],
            rows: data.map((item: any, i: number) => ({
                id: i,
                ...item,
                date: new Date(item.date).toLocaleString(),
                type: (
                   <Chip 
                     size="sm" 
                     variant="flat" 
                     color={item.type === 'IN' ? 'success' : 'danger'}
                     className="font-black uppercase text-[8px]"
                   >
                     {item.type}
                   </Chip>
                )
            }))
        };
    }

    if (Array.isArray(data)) {
      if (data.length === 0) return { columns: [], rows: [] };
      
      const keys = Object.keys(data[0]);
      return {
        columns: keys.map(k => ({ key: k, label: k.toUpperCase().replace(/_/g, ' ') })),
        rows: data.map((item, i) => ({ ...item, id: i }))
      };
    }

    // Caso especial para dashboard overview (payments)
    if (data.salesByPayment) {
        const rows = Object.entries(data.salesByPayment).map(([method, amount], i) => ({
            id: i,
            method,
            amount: `$${formatCurrency(amount as number)}`
        }));
        return {
            columns: [
                { key: 'method', label: 'MÉTODO' },
                { key: 'amount', label: 'TOTAL' }
            ],
            rows
        };
    }

    // Caso para cierre de caja
    if (data.totalSales !== undefined && !isPnL) {
        const rows = [
            { id: 1, label: 'Ventas Totales', value: `$${formatCurrency(data.totalSales)}` },
            { id: 2, label: 'Efectivo en Caja', value: `$${formatCurrency(data.totalCash)}` },
            { id: 3, label: 'Gastos', value: `$${formatCurrency(data.totalExpenses)}` },
            { id: 4, label: 'Devoluciones', value: `$${formatCurrency(data.totalReturns)}` },
            { id: 5, label: 'Balance Neto', value: `$${formatCurrency(data.netBalance)}` },
        ];
        return {
            columns: [
                { key: 'label', label: 'CONCEPTO' },
                { key: 'value', label: 'VALOR' }
            ],
            rows
        };
    }

    return { columns: [], rows: [] };
  };

  const { columns, rows } = getTableContent();

  const KPICard = ({ label, value, icon: Icon, color, subValue }: any) => (
    <Card className="border-none bg-gray-50 dark:bg-white/5 shadow-inner" radius="lg">
      <CardBody className="p-4 flex flex-row items-center gap-4">
        <div className={`p-3 rounded-2xl ${color} bg-opacity-10 text-${color.split('-')[1]}-500 shadow-sm`}>
          <Icon size={20} />
        </div>
        <div>
          <p className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest leading-none mb-1">{label}</p>
          <p className="text-lg font-black text-gray-900 dark:text-white tracking-tighter italic">
            {typeof value === 'number' ? `$${formatCurrency(value)}` : value}
          </p>
          {subValue && (
            <p className="text-[8px] font-bold text-emerald-500 uppercase italic">{subValue}</p>
          )}
        </div>
      </CardBody>
    </Card>
  );

  return (
    <Modal 
      isOpen={isOpen} 
      onOpenChange={onOpenChange} 
      size="5xl" 
      scrollBehavior="inside"
      backdrop="blur"
      classNames={{
        base: "bg-white/95 dark:bg-zinc-950/95 backdrop-blur-2xl border border-white/20 rounded-[2.5rem] shadow-2xl",
        header: "border-b border-gray-100 dark:border-white/5 pb-6",
        body: "py-6",
      }}
    >
      <ModalContent>
        {() => (
          <>
            <ModalHeader className="flex flex-col gap-1">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-2xl bg-emerald-500/10 text-emerald-500 shadow-inner">
                  <FileSearch size={24} />
                </div>
                <div>
                  <h2 className="text-xl md:text-2xl font-black text-gray-900 dark:text-white uppercase tracking-tighter italic">
                    Vista <span className="text-emerald-500">Previa Ejecutiva</span>
                  </h2>
                  <p className="text-[10px] font-bold text-gray-500 dark:text-zinc-500 uppercase tracking-[0.2em]">{title}</p>
                </div>
              </div>
            </ModalHeader>
            <ModalBody className="gap-6">
              {/* Seccin de KPIs para Reportes Administrativos (PnL) */}
              {isPnL && (
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <KPICard 
                    label="Ingresos Totales" 
                    value={data.totalRevenue} 
                    icon={TrendingUp} 
                    color="bg-emerald-500" 
                    subValue={`${data.totalRevenue > 0 ? '+100%' : '0%'} vs Ventas`}
                  />
                  <KPICard 
                    label="Costo de Ventas" 
                    value={data.totalCogs} 
                    icon={ShoppingBag} 
                    color="bg-amber-500" 
                  />
                  <KPICard 
                    label="Egresos/Gastos" 
                    value={data.totalExpenses} 
                    icon={Wallet} 
                    color="bg-rose-500" 
                  />
                  <KPICard 
                    label="Rentabilidad Neta" 
                    value={data.netProfit} 
                    icon={PieChart} 
                    color="bg-sky-500" 
                    subValue={`Margen: ${data.marginPercentage.toFixed(2)}%`}
                  />
                </div>
              )}

              <div className="rounded-3xl border border-gray-100 dark:border-white/5 overflow-hidden shadow-sm">
                <Table 
                    aria-label="Preview Table"
                    removeWrapper
                    classNames={{
                        th: "bg-gray-100/50 dark:bg-white/5 text-[10px] font-black uppercase tracking-widest text-gray-400 dark:text-zinc-500 py-5 italic",
                        td: "py-4 text-sm font-bold border-b border-gray-50 dark:border-white/5 dark:text-zinc-300",
                    }}
                >
                    <TableHeader columns={columns}>
                    {(column) => (
                        <TableColumn key={column.key}>{column.label}</TableColumn>
                    )}
                    </TableHeader>
                    <TableBody items={rows} emptyContent={"No hay datos para mostrar"}>
                    {(item: any) => (
                        <TableRow key={item.id}>
                        {(columnKey) => (
                            <TableCell>
                                {columnKey.toString().toLowerCase().includes('total') || columnKey.toString().toLowerCase().includes('subtotal') || columnKey.toString().toLowerCase().includes('amount') || columnKey.toString().toLowerCase().includes('price')
                                    ? `$${formatCurrency(item[columnKey as string])}` 
                                    : item[columnKey as string]}
                            </TableCell>
                        )}
                        </TableRow>
                    )}
                    </TableBody>
                </Table>
              </div>
            </ModalBody>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

const Chip = ({ children, color, className }: any) => {
    const colors: any = {
        success: "bg-emerald-500/10 text-emerald-500",
        danger: "bg-rose-500/10 text-rose-500",
    };
    return (
        <span className={`px-2 py-1 rounded-full ${colors[color]} ${className}`}>
            {children}
        </span>
    );
};
