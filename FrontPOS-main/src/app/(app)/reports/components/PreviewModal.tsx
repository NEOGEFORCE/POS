"use client";

import { 
  Modal, ModalContent, ModalHeader, ModalBody, 
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Card, CardBody, Chip
} from "@heroui/react";
import React from 'react';
import { FileSearch, TrendingUp, PieChart, Wallet, ShoppingBag, ArrowUpRight, ArrowDownRight, Tag } from "lucide-react";
import { formatCurrency, formatDateTime } from "@/lib/utils";

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
    // Caso para Alerta de Stock (Bajo del mínimo) con semáforo dinámico
    if (isLowStock) {
        return {
            columns: [
                { key: 'barcode', label: 'BARCODE' },
                { key: 'name', label: 'PRODUCTO' },
                { key: 'stock', label: 'EXISTENCIAS' },
                { key: 'threshold', label: 'UMBRAL CRÍTICO' },
                { key: 'status', label: 'ESTADO' },
            ],
            rows: data.lowStockProducts.map((item: any, i: number) => {
                const isCritical = item.status === 'CRITICAL' || item.status === 'CRÍTICO';
                const isWarning = item.status === 'WARNING' || item.status === 'ADVERTENCIA';
                return {
                    id: i,
                    barcode: item.barcode,
                    name: item.name,
                    stock: (
                        <span className={`font-medium ${isCritical ? 'text-rose-500' : 'text-amber-500'}`}>
                            {item.stock}
                        </span>
                    ),
                    threshold: item.threshold || '-',
                    status: (
                        <Chip size="sm" variant="flat"
                            className={isCritical
                                ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400'
                                : 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400'}
                            classNames={{ content: "text-[9px] font-medium uppercase tracking-widest" }}
                        >
                            {isCritical ? 'CRÍTICO' : 'BAJO'}
                        </Chip>
                    )
                };
            })
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
                date: formatDateTime(item.date),
                type: (
                   <Chip 
                     size="sm" 
                     variant="flat" 
                     color={item.type === 'IN' ? 'success' : 'danger'}
                     className="font-medium uppercase text-[8px]"
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
    <Card className="border-none bg-gray-50 dark:bg-[#18181b] shadow-inner" radius="lg">
      <CardBody className="p-4 flex flex-row items-center gap-4">
        <div className={`p-3 rounded-2xl ${color} bg-opacity-10 text-${color.split('-')[1]}-500 shadow-[0_8px_30px_rgb(0,0,0,0.12)]`}>
          <Icon size={20} />
        </div>
        <div>
          <p className="text-[9px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-widest leading-none mb-1">{label}</p>
          <p className="text-lg font-medium text-zinc-900 dark:text-zinc-50 tracking-tighter tracking-tight">
            {typeof value === 'number' ? `$${formatCurrency(value)}` : value}
          </p>
          {subValue && (
            <p className="text-[8px] font-bold text-zinc-900 dark:text-zinc-100 uppercase tracking-tight">{subValue}</p>
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
        base: "bg-white/95 dark:bg-zinc-950/95  border border-white/20 rounded-[2.5rem] shadow-[0_8px_30px_rgb(0,0,0,0.12)]",
        header: "border-b border-gray-100 dark:border-white/5 pb-6",
        body: "py-6",
      }}
    >
      <ModalContent>
        {() => (
          <>
            <ModalHeader className="flex flex-col gap-1">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-2xl bg-white/5 text-zinc-900 dark:text-zinc-100 shadow-inner">
                  <FileSearch size={24} />
                </div>
                <div>
                  <h2 className="text-xl md:text-2xl font-medium text-zinc-900 dark:text-zinc-50 uppercase tracking-tighter tracking-tight">
                    Vista <span className="text-zinc-900 dark:text-zinc-100">Previa Ejecutiva</span>
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
                    color="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5" 
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

              <div className="rounded-2xl border border-gray-100 dark:border-white/5 overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
                <Table 
                    aria-label="Preview Table"
                    removeWrapper
                    classNames={{
                        th: "bg-gray-100/50 dark:bg-[#18181b] text-[10px] font-medium uppercase tracking-widest text-zinc-500 dark:text-zinc-400 py-5 tracking-tight",
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

