"use client";
import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { 
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Chip, Input, User as HeroUser, Button, Tabs, Tab,
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
  Tooltip
} from "@heroui/react";
import { 
  Search, Info, Eye, ShieldAlert, Monitor, Globe, History, ArrowRight,
  ChevronLeft, ChevronRight
} from 'lucide-react';
import { AuditLog } from '@/lib/definitions';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { EmptyState } from '@/components/ui/EmptyState';
import { formatTime } from '@/lib/utils';

interface AuditTableProps {
  logs: AuditLog[];
}

const COLUMNS = [
    { name: "MARCA TEMPORAL", uid: "timestamp", align: "start" },
    { name: "RESPONSABLE", uid: "employee", align: "start" },
    { name: "ACCION / MODULO", uid: "action", align: "start" },
    { name: "RELATO DE EVENTO", uid: "details", align: "start" },
    { name: "INSPECCION", uid: "inspect", align: "center" },
];

const getActionColor = (action: string, isCritical?: boolean) => {
    if (isCritical) return "danger";
    const act = action.toUpperCase();
    if (act.includes('CREATE') || act.includes('REGISTER')) return "success";
    if (act.includes('UPDATE') || act.includes('RESET')) return "warning";
    if (act.includes('DELETE') || act.includes('REVOKE') || act.includes('VOID') || act.includes('FAIL')) return "danger";
    return "primary";
};

export default function AuditTable({ logs }: AuditTableProps) {
  const [filter, setFilter] = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const {isOpen, onOpen, onOpenChange} = useDisclosure();
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);
  
  // PAGINACION
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
      const mql = window.matchMedia("(max-width: 768px)");
      const onChange = () => setIsMobile(mql.matches);
      mql.addEventListener("change", onChange);
      setIsMobile(mql.matches);
      return () => mql.removeEventListener("change", onChange);
  }, []);

  const filteredLogs = useMemo(() => {
    let result = [...logs].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    if (activeTab === "critical") {
      result = result.filter(log => log.is_critical);
    } else if (activeTab !== "all") {
      result = result.filter(log => log.module === activeTab);
    }

    if (filter) {
      const q = filter.toLowerCase();
      result = result.filter(log => 
        log.employee_dni.toLowerCase().includes(q) ||
        log.employee_name?.toLowerCase().includes(q) ||
        log.action.toLowerCase().includes(q) ||
        log.human_readable?.toLowerCase().includes(q) ||
        log.details.toLowerCase().includes(q)
      );
    }

    return result;
  }, [logs, filter, activeTab]);

  const totalPages = Math.ceil(filteredLogs.length / rowsPerPage);
  const items = useMemo(() => {
    const start = (page - 1) * rowsPerPage;
    const end = start + rowsPerPage;
    return filteredLogs.slice(start, end);
  }, [page, filteredLogs, rowsPerPage]);

  const handleInspect = (log: AuditLog) => {
    setSelectedLog(log);
    onOpen();
  };

  const renderCell = useCallback((log: AuditLog, columnKey: React.Key) => {
    switch (columnKey) {
        case "timestamp":
            return (
                <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-medium text-gray-700 dark:text-zinc-300">
                        {format(new Date(log.created_at), "dd MMM yyyy", { locale: es }).toUpperCase()}
                    </span>
                    <span className="text-[9px] font-medium text-gray-400 tracking-tight">
                        {formatTime(log.created_at)}
                    </span>
                </div>
            );
        case "employee":
            return (
                <HeroUser
                    name={log.employee_name || "USUARIO REGISTRADO"}
                    description={log.employee_dni}
                    avatarProps={{
                        size: "sm",
                        className: "bg-gradient-to-tr from-emerald-500 to-teal-400 text-white font-bold"
                    }}
                    classNames={{
                        name: "text-[10px] font-medium uppercase tracking-tighter",
                        description: "text-[9px] font-bold text-gray-400"
                    }}
                />
            );
        case "action":
            return (
                <div className="flex flex-col gap-1">
                    <Chip 
                        size="sm" 
                        variant="flat" 
                        color={getActionColor(log.action, log.is_critical)}
                        className="font-medium border-1 uppercase text-[8px] h-5 tracking-widest tracking-tight"
                    >
                        {log.action}
                    </Chip>
                    <span className="text-[8px] uppercase text-gray-400 font-medium tracking-widest px-1.5 py-0.5 bg-gray-100 dark:bg-zinc-800 rounded-2xl w-fit">
                        {log.module}
                    </span>
                </div>
            );
        case "details":
            return (
                <div className="flex flex-col gap-1 pr-4 max-w-[400px]">
                    <span className="text-[11px] text-zinc-800 dark:text-zinc-200 font-bold tracking-tight line-clamp-2 leading-tight">
                        {log.human_readable || log.details}
                    </span>
                    {!log.human_readable && (
                        <span className="text-[9px] text-gray-400 font-medium uppercase tracking-tighter truncate">
                            {log.details}
                        </span>
                    )}
                </div>
            );
        case "inspect":
            return (
                <Tooltip content="Ver Inspeccion Tecnica">
                    <Button 
                        isIconOnly 
                        size="sm" 
                        variant="flat" 
                        className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 text-zinc-900 dark:text-zinc-100 rounded-2xl hover:bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 hover:text-white transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-90"
                        onPress={() => handleInspect(log)}
                    >
                        <Eye size={18} strokeWidth={2.5} />
                    </Button>
                </Tooltip>
            );
        default:
            return null;
    }
  }, []);

  const renderChangesTable = (changesStr?: string) => {
    if (!changesStr) return <p className="text-tiny text-default-400 tracking-tight">No hay detalles tecnicos de cambios disponibles.</p>;
    try {
      const changes = JSON.parse(changesStr);
      const before = changes.before || {};
      const after = changes.after || {};
      const keys = Object.keys({...before, ...after}).sort();

      if (keys.length === 0) return <p className="text-tiny text-default-400 tracking-tight">No se detectaron cambios en los campos.</p>;

      return (
        <div className="border border-default-100 dark:border-white/5 rounded-2xl overflow-hidden bg-default-50/50 dark:bg-[#18181b]/50">
          <table className="w-full text-left text-tiny border-collapse">
            <thead>
              <tr className="bg-default-100/50 dark:bg-[#18181b] border-b border-default-100 dark:border-white/5">
                <th className="px-3 py-2 font-bold text-default-600 dark:text-zinc-400 uppercase tracking-tighter">Campo</th>
                <th className="px-3 py-2 font-bold text-default-600 dark:text-zinc-400 uppercase tracking-tighter">Valor Anterior</th>
                <th className="px-3 py-2 font-bold text-default-600 dark:text-zinc-400 uppercase tracking-tighter">Valor Nuevo</th>
              </tr>
            </thead>
            <tbody>
              {keys.map(key => (
                <tr key={key} className="border-b border-default-100 dark:border-white/5 last:border-0 hover:bg-default-100/20 transition-colors">
                  <td className="px-3 py-2 font-bold text-default-500 dark:text-zinc-500 uppercase">{key}</td>
                  <td className="px-3 py-2 text-rose-500 font-medium line-through decoration-rose-300/50">
                    {typeof before[key] === 'object' ? JSON.stringify(before[key]) : String(before[key] ?? 'N/A')}
                  </td>
                  <td className="px-3 py-2 text-zinc-900 dark:text-zinc-100 dark:text-zinc-300 font-bold flex items-center gap-1">
                    <ArrowRight size={10} className="text-default-300" />
                    {typeof after[key] === 'object' ? JSON.stringify(after[key]) : String(after[key] ?? 'N/A')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    } catch {
      return <pre className="text-[10px] p-2 bg-[#18181b] text-zinc-300 rounded overflow-auto overscroll-contain">{changesStr}</pre>;
    }
  };

  return (
    <div className="flex-1 min-h-0 h-full w-full flex flex-col gap-4">
      {/* FILTROS AVANZADOS */}
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center card-base border-none p-4 rounded-2xl border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] gap-4 shrink-0 transition-colors">
        <div className="flex flex-col gap-3 w-full lg:w-auto">
          <Tabs 
            variant="underlined" 
            color="primary" 
            selectedKey={activeTab}
            onSelectionChange={(key) => { setActiveTab(key as string); setPage(1); }}
            classNames={{
              tabList: "gap-6 w-full relative rounded-none p-0 border-b border-divider dark:border-white/5",
              cursor: "w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5",
              tab: "max-w-fit px-0 h-10",
              tabContent: "group-data-[selected=true]:text-zinc-900 dark:text-zinc-100 font-medium text-[10px] uppercase tracking-widest tracking-tight"
            }}
          >
            <Tab key="all" title="HISTORIAL COMPLETO" />
            <Tab key="critical" title={
              <div className="flex items-center gap-2">
                <ShieldAlert size={14} className="text-rose-500" />
                <span>ALERTAS CRITICAS</span>
              </div>
            } />
            <Tab key="SALES" title="VENTAS" />
            <Tab key="INVENTORY" title="INVENTARIO" />
            <Tab key="AUTH" title="ACCESOS" />
          </Tabs>
        </div>

        <div className="flex items-center gap-3 w-full lg:w-auto">
          <Input
            isClearable
            className="w-full lg:w-80"
            placeholder="Buscar por DNI, nombre, accion..."
            startContent={<Search size={18} className="text-gray-400" />}
            value={filter}
            onValueChange={(val) => { setFilter(val); setPage(1); }}
            size="sm"
            variant="bordered"
            classNames={{
                inputWrapper: "border-gray-200 dark:border-white/10 bg-white dark:bg-zinc-950"
            }}
          />
          <div className="flex gap-2 items-center text-gray-400 tracking-tight text-[10px] font-medium uppercase whitespace-nowrap">
            <Info size={14} className="text-zinc-900 dark:text-zinc-100" />
            {filteredLogs.length} EVENTOS
          </div>
        </div>
      </div>

      {/* CONTENEDOR DE TABLA / CARDS */}
      <div className="bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/5 rounded-2xl overflow-hidden flex flex-col shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-colors relative">
        {!isMobile ? (
            <div className="overflow-auto overscroll-contain custom-scrollbar w-full flex-1 min-h-0 h-full">
                <Table
                    isCompact
                    removeWrapper
                    isHeaderSticky
                    aria-label="Registro Maestro de Auditoria"
                    classNames={{
                        base: "min-w-[900px]",
                        th: "bg-gray-50 dark:bg-zinc-950 text-zinc-500 dark:text-zinc-400 font-medium uppercase text-[9px] tracking-widest h-10 py-1 border-b border-gray-200 dark:border-white/5 sticky top-0 z-10 px-4",
                        td: "py-2 border-b border-gray-100 dark:border-white/5 px-4",
                        tr: "hover:bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 transition-colors border-l-4 border-transparent hover:border-emerald-500 active:bg-white/5 cursor-default group"
                    }}
                >
                    <TableHeader columns={COLUMNS}>
                        {(column) => (
                            <TableColumn key={column.uid} align={column.align as any}>
                                {column.name}
                            </TableColumn>
                        )}
                    </TableHeader>
                    <TableBody 
                        items={items}
                        emptyContent={
                            <EmptyState 
                                title="Sin registros de auditoria"
                                description="No se han encontrado eventos bajo los criterios actuales. Intenta ajustar los filtros de busqueda."
                                icon={<History size={48} className="text-gray-300" />}
                            />
                        }
                    >
                        {(item) => (
                            <TableRow key={item.id} className={item.is_critical ? "bg-rose-500/5 border-l-rose-500 hover:bg-rose-500/10" : ""}>
                                {(columnKey) => <TableCell>{renderCell(item, columnKey)}</TableCell>}
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
            </div>
        ) : (
            <div className="overflow-y-auto scroll-smooth custom-scrollbar p-3 flex flex-col gap-3 bg-gray-50/50 dark:bg-[#18181b] flex-1 min-h-0 h-full">
                {items.length > 0 ? (
                    items.map((log) => (
                        <div key={log.id} className={`relative p-4 rounded-2xl border border-gray-200 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] card-base border-none flex flex-col gap-3 transition-all ${log.is_critical ? 'border-rose-500/40 bg-rose-500/5 shadow-rose-500/5' : 'hover:border-emerald-500/30'}`}>
                            {log.is_critical && <div className="absolute top-3 left-0 w-1 h-12 bg-rose-500 rounded-r-full" />}
                            <div className="flex justify-between items-start">
                                <HeroUser
                                    name={log.employee_name}
                                    description={log.employee_dni}
                                    avatarProps={{ size: "sm" }}
                                    classNames={{ name: "text-[10px] font-medium uppercase", description: "text-[8px] font-bold" }}
                                />
                                <div className="flex flex-col items-end">
                                    <span className="text-[8px] font-medium text-gray-400 uppercase">{formatTime(log.created_at)}</span>
                                    <span className="text-[8px] font-bold text-zinc-900 dark:text-zinc-100 uppercase">{format(new Date(log.created_at), "dd/MM/yy")}</span>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <Chip size="sm" variant="flat" color={getActionColor(log.action, log.is_critical)} className="font-medium uppercase text-[8px] h-5 tracking-tighter tracking-tight">{log.action}</Chip>
                                <span className="text-[8px] font-medium text-gray-400 uppercase tracking-widest px-2 py-0.5 bg-gray-100 dark:bg-zinc-800 rounded-2xl">{log.module}</span>
                            </div>
                            <p className="text-[11px] font-bold tracking-tight text-gray-700 dark:text-zinc-300 leading-tight border-t border-gray-100 dark:border-white/5 pt-2">
                                {log.human_readable || log.details}
                            </p>
                            <Button size="sm" variant="flat" className="w-full mt-1 bg-white/5 text-emerald-600 font-medium text-[9px] uppercase tracking-tight h-8" onPress={() => handleInspect(log)}>
                                Ver Detalles Tecnicos <Eye size={12} className="ml-1" />
                            </Button>
                        </div>
                    ))
                ) : (
                    <EmptyState title="Sin resultados" description="No hay eventos en este dispositivo." />
                )}
            </div>
        )}

        {/* PAGINACION ESTILO PREMIUM */}
        {filteredLogs.length > rowsPerPage && (
            <div className="shrink-0 px-3 py-2 flex items-center justify-between gap-2 border-t border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-zinc-950 z-40 shadow-[0_-4px_15px_rgba(0,0,0,0.1)]">
                <div className="flex items-center gap-2 font-medium">
                    <Button
                        isIconOnly
                        size="sm"
                        variant="flat"
                        onPress={() => setPage(Math.max(1, page - 1))}
                        isDisabled={page === 1}
                        className="h-8 w-8 min-w-0 card-base border-none text-zinc-900 dark:text-zinc-50 rounded-2xl border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-90 transition-transform"
                    >
                        <ChevronLeft size={18} />
                    </Button>

                    <div className="flex flex-col items-start px-1 leading-none">
                        <span className="text-[7px] text-zinc-500 dark:text-zinc-400 uppercase font-medium tracking-tighter">EVENTOS</span>
                        <p className="text-[10px] text-zinc-900 dark:text-zinc-50 uppercase tracking-widest flex items-center gap-1">
                            <span className="tracking-tight font-medium text-zinc-900 dark:text-zinc-100">{(page - 1) * rowsPerPage + 1}-{Math.min(page * rowsPerPage, filteredLogs.length)}</span>
                            <span className="opacity-20 text-[8px]">DE</span>
                            <span className="tracking-tight font-medium">{filteredLogs.length}</span>
                        </p>
                    </div>

                    <Button
                        isIconOnly
                        size="sm"
                        variant="flat"
                        onPress={() => setPage(Math.min(totalPages, page + 1))}
                        isDisabled={page === totalPages || totalPages === 0}
                        className="h-8 w-8 min-w-0 card-base border-none text-zinc-900 dark:text-zinc-50 rounded-2xl border border-gray-200 dark:border-white/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] active:scale-90 transition-transform"
                    >
                        <ChevronRight size={18} />
                    </Button>
                </div>

                <div className="flex items-center gap-2">
                    <select
                        value={rowsPerPage}
                        onChange={(e) => { setRowsPerPage(Number(e.target.value)); setPage(1); }}
                        className="h-8 card-base border-none text-zinc-900 dark:text-zinc-50 text-[10px] font-medium uppercase tracking-widest px-2 outline-none rounded-2xl border border-gray-200 dark:border-white/10 cursor-pointer shadow-[0_8px_30px_rgb(0,0,0,0.12)] appearance-none pr-6"
                    >
                        {[25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                </div>
            </div>
        )}
      </div>

      {/* MODAL DE INSPECCION PROFUNDA */}
      <Modal 
        isOpen={isOpen} 
        onOpenChange={onOpenChange}
        size="2xl"
        backdrop="blur"
        scrollBehavior="inside"
        classNames={{
            base: "bg-white dark:bg-zinc-950 border border-default-100 dark:border-white/10 shadow-[0_8px_30px_rgb(0,0,0,0.12)] rounded-2xl",
            header: "border-b border-default-100 dark:border-white/10 py-6",
            body: "py-6 custom-scrollbar",
            footer: "border-t border-default-100 dark:border-white/10"
        }}
      >
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex flex-col gap-1">
                <div className="flex items-center gap-3">
                    <div className={`h-12 w-12 rounded-2xl flex items-center justify-center text-white shadow-[0_8px_30px_rgb(0,0,0,0.12)] ${selectedLog?.is_critical ? 'bg-rose-500 shadow-rose-500/20' : 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-white/5 '}`}>
                        {selectedLog?.is_critical ? <ShieldAlert size={24} /> : <History size={24} />}
                    </div>
                    <div className="flex flex-col">
                        <h3 className="text-sm font-medium uppercase tracking-tighter tracking-tight">Inspeccion Forense de Evento</h3>
                        <p className="text-[10px] font-bold text-default-400 uppercase tracking-widest">ID Registro: #{selectedLog?.id}</p>
                    </div>
                </div>
              </ModalHeader>
              <ModalBody className="flex flex-col gap-6">
                <div className="grid grid-cols-2 gap-4">
                    <div className="bg-default-50 dark:bg-[#18181b]/50 p-3 rounded-2xl border border-default-100 dark:border-white/5">
                        <div className="flex items-center gap-2 mb-2 text-default-400">
                            <Globe size={14} />
                            <span className="text-[9px] font-medium uppercase tracking-widest">Origen de Conexion</span>
                        </div>
                        <p className="text-xs font-mono font-medium text-default-700 dark:text-zinc-300">{selectedLog?.ip_address}</p>
                    </div>
                    <div className="bg-default-50 dark:bg-[#18181b]/50 p-3 rounded-2xl border border-default-100 dark:border-white/5">
                        <div className="flex items-center gap-2 mb-2 text-default-400">
                            <Monitor size={14} />
                            <span className="text-[9px] font-medium uppercase tracking-widest">Dispositivo / User-Agent</span>
                        </div>
                        <Tooltip content={selectedLog?.device || "N/A"}>
                            <p className="text-[10px] font-bold text-default-600 dark:text-zinc-400 truncate">{selectedLog?.device || "Desconocido"}</p>
                        </Tooltip>
                    </div>
                </div>

                <div className="flex flex-col gap-3">
                    <h4 className="text-[10px] font-medium text-zinc-900 dark:text-zinc-100 uppercase tracking-widest tracking-tight flex items-center gap-2">
                        <ArrowRight size={14} /> Trazabilidad de Cambios (Kardex Audit)
                    </h4>
                    {renderChangesTable(selectedLog?.changes)}
                </div>

                <div className="flex flex-col gap-2 p-4 bg-default-50 dark:bg-[#18181b]/50 rounded-2xl border border-default-100 dark:border-white/5">
                    <span className="text-[9px] font-medium text-default-400 uppercase tracking-widest">Relato Tecnico</span>
                    <p className="text-xs font-medium text-default-600 dark:text-zinc-400 tracking-tight">
                        &quot;{selectedLog?.human_readable || selectedLog?.details}&quot;
                    </p>
                </div>
              </ModalBody>
              <ModalFooter>
                <Button 
                    className="font-medium text-[10px] uppercase tracking-widest tracking-tight rounded-2xl h-10 border border-default-200 dark:border-white/10 card-base border-none"
                    onPress={onClose}
                >
                    Cerrar Informe
                </Button>
                <Button 
                    color="primary"
                    className="font-medium text-[10px] uppercase tracking-widest tracking-tight rounded-2xl h-10 shadow-[0_8px_30px_rgb(0,0,0,0.12)]"
                    onPress={() => window.print()}
                >
                    Imprimir Evidencia
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}



