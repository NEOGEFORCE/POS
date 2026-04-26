"use client";
import React, { useMemo, useState, useRef } from 'react';
import { 
  Chip, Input, User as HeroUser, Button, Tabs, Tab,
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
  Tooltip
} from "@heroui/react";
import { Search, Info, Eye, ShieldAlert, Monitor, Globe, History, ArrowRight } from 'lucide-react';
import { AuditLog } from '@/lib/definitions';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { useVirtualizer } from '@tanstack/react-virtual';

interface AuditTableProps {
  logs: AuditLog[];
}

const getActionColor = (action: string, isCritical?: boolean) => {
    if (isCritical) return "danger";
    const act = action.toUpperCase();
    if (act.includes('CREATE') || act.includes('REGISTER')) return "success";
    if (act.includes('UPDATE') || act.includes('RESET')) return "warning";
    if (act.includes('DELETE') || act.includes('REVOKE') || act.includes('VOID') || act.includes('FAIL')) return "danger";
    return "primary";
};

// COMPONENTE MEMOIZADO: Registros de auditoría inmutables
const AuditRow = React.memo(({ 
    log, 
    style, 
    onInspect 
}: { 
    log: AuditLog, 
    style: React.CSSProperties, 
    onInspect: (l: AuditLog) => void 
}) => {
    return (
        <div
            className={`absolute top-0 left-0 w-full flex items-center px-4 border-b border-default-50 last:border-0 transition-colors ${log.is_critical ? 'bg-rose-500/[0.03] dark:bg-rose-500/[0.07] border-l-4 border-l-rose-500' : 'hover:bg-default-50'}`}
            style={style}
        >
            <div className="w-[180px]">
                <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-black text-default-700">
                        {format(new Date(log.created_at), "dd MMM yyyy", { locale: es }).toUpperCase()}
                    </span>
                    <span className="text-[9px] font-medium text-default-400 italic">
                        {format(new Date(log.created_at), "HH:mm:ss", { locale: es })}
                    </span>
                </div>
            </div>
            <div className="w-[250px]">
                <HeroUser
                    name={log.employee_name || "USUARIO REGISTRADO"}
                    description={log.employee_dni}
                    avatarProps={{
                        size: "sm",
                        className: "bg-gradient-to-tr from-emerald-500 to-teal-400 text-white font-bold"
                    }}
                    classNames={{
                        name: "text-[10px] font-black uppercase tracking-tighter",
                        description: "text-[9px] font-bold text-default-400"
                    }}
                />
            </div>
            <div className="w-[150px]">
                <div className="flex flex-col gap-1.5">
                    <Chip 
                        size="sm" 
                        variant="flat" 
                        color={getActionColor(log.action, log.is_critical)}
                        className="font-black border-1 uppercase text-[8px] h-5 tracking-widest italic"
                    >
                        {log.action}
                    </Chip>
                    <span className="text-[8px] uppercase text-default-400 font-black tracking-widest px-1.5 py-0.5 bg-default-100 rounded-full w-fit">
                        {log.module}
                    </span>
                </div>
            </div>
            <div className="flex-1">
                <div className="flex flex-col gap-1 pr-4">
                    <span className="text-[11px] text-default-800 dark:text-zinc-200 font-bold italic line-clamp-2 leading-tight">
                        {log.human_readable || log.details}
                    </span>
                    {!log.human_readable && (
                        <span className="text-[9px] text-default-400 font-medium uppercase tracking-tighter">
                            {log.details}
                        </span>
                    )}
                </div>
            </div>
            <div className="w-[100px] text-center">
                <Tooltip content="Ver Inspección Técnica">
                    <Button 
                        isIconOnly 
                        size="sm" 
                        variant="light" 
                        className="hover:bg-emerald-500/10 text-default-400 hover:text-emerald-500 active:scale-90"
                        onPress={() => onInspect(log)}
                    >
                        <Eye size={20} strokeWidth={2.5} />
                    </Button>
                </Tooltip>
            </div>
        </div>
    );
});

AuditRow.displayName = 'AuditRow';

export default function AuditTable({ logs }: AuditTableProps) {
  const [filter, setFilter] = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const {isOpen, onOpen, onOpenChange} = useDisclosure();
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);

  const parentRef = useRef<HTMLDivElement>(null);

  const filteredLogs = useMemo(() => {
    let result = logs;

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

  const rowVirtualizer = useVirtualizer({
    count: filteredLogs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 65,
    overscan: 10,
  });

  const handleInspect = (log: AuditLog) => {
    setSelectedLog(log);
    onOpen();
  };

  const renderChangesTable = (changesStr?: string) => {
    if (!changesStr) return <p className="text-tiny text-default-400 italic">No hay detalles técnicos de cambios disponibles.</p>;
    try {
      const changes = JSON.parse(changesStr);
      const before = changes.before || {};
      const after = changes.after || {};
      const keys = Object.keys({...before, ...after}).sort();

      if (keys.length === 0) return <p className="text-tiny text-default-400 italic">No se detectaron cambios en los campos.</p>;

      return (
        <div className="border border-default-100 rounded-lg overflow-hidden bg-default-50/50">
          <table className="w-full text-left text-tiny border-collapse">
            <thead>
              <tr className="bg-default-100/50 border-b border-default-100">
                <th className="px-3 py-2 font-bold text-default-600 uppercase tracking-tighter">Campo</th>
                <th className="px-3 py-2 font-bold text-default-600 uppercase tracking-tighter">Valor Anterior</th>
                <th className="px-3 py-2 font-bold text-default-600 uppercase tracking-tighter">Valor Nuevo</th>
              </tr>
            </thead>
            <tbody>
              {keys.map(key => (
                <tr key={key} className="border-b border-default-100 last:border-0 hover:bg-default-100/20 transition-colors">
                  <td className="px-3 py-2 font-bold text-default-500 uppercase">{key}</td>
                  <td className="px-3 py-2 text-rose-500 font-medium line-through decoration-rose-300/50">
                    {typeof before[key] === 'object' ? JSON.stringify(before[key]) : String(before[key] ?? 'N/A')}
                  </td>
                  <td className="px-3 py-2 text-emerald-600 font-bold flex items-center gap-1">
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
      return <pre className="text-[10px] p-2 bg-zinc-900 text-zinc-300 rounded overflow-x-auto">{changesStr}</pre>;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* FILTROS AVANZADOS */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-white/60 dark:bg-zinc-900/60 backdrop-blur-xl p-4 rounded-2xl border border-default-100 shadow-xl gap-4">
        <div className="flex flex-col gap-3 w-full sm:w-auto">
          <Tabs 
            variant="underlined" 
            color="primary" 
            selectedKey={activeTab}
            onSelectionChange={(key) => setActiveTab(key as string)}
            classNames={{
              tabList: "gap-6 w-full relative rounded-none p-0 border-b border-divider",
              cursor: "w-full bg-emerald-500",
              tab: "max-w-fit px-0 h-10",
              tabContent: "group-data-[selected=true]:text-emerald-500 font-black text-[10px] uppercase tracking-widest italic"
            }}
          >
            <Tab key="all" title="HISTORIAL COMPLETO" />
            <Tab key="critical" title={
              <div className="flex items-center gap-2">
                <ShieldAlert size={14} className="text-rose-500" />
                <span>ALERTAS CRÍTICAS</span>
              </div>
            } />
            <Tab key="SALES" title="VENTAS" />
            <Tab key="INVENTORY" title="INVENTARIO" />
            <Tab key="AUTH" title="ACCESOS" />
          </Tabs>
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto">
          <Input
            isClearable
            className="w-full sm:w-80"
            placeholder="Buscar por DNI, nombre, acción..."
            startContent={<Search size={18} className="text-default-400" />}
            value={filter}
            onValueChange={setFilter}
            size="sm"
            variant="bordered"
          />
          <div className="flex gap-2 items-center text-default-400 italic text-[10px] font-bold uppercase whitespace-nowrap">
            <Info size={14} className="text-emerald-500" />
            {filteredLogs.length} EVENTOS
          </div>
        </div>
      </div>

      {/* TABLA VIRTUALIZADA CON TANSTACK VIRTUAL */}
      <div className="relative border border-default-100 rounded-2xl overflow-hidden bg-white dark:bg-zinc-900 shadow-xl">
        {/* Cabecera Fija */}
        <div className="flex items-center bg-default-100/80 backdrop-blur-md h-12 border-b border-default-100 px-4">
          <div className="w-[180px] font-black italic text-[10px] tracking-widest text-default-600 uppercase">Marca Temporal</div>
          <div className="w-[250px] font-black italic text-[10px] tracking-widest text-default-600 uppercase">Responsable</div>
          <div className="w-[150px] font-black italic text-[10px] tracking-widest text-default-600 uppercase">Acción / Módulo</div>
          <div className="flex-1 font-black italic text-[10px] tracking-widest text-default-600 uppercase">Relato de Evento</div>
          <div className="w-[100px] text-center font-black italic text-[10px] tracking-widest text-default-600 uppercase">Inspección</div>
        </div>

        {/* Contenedor de Scroll Virtual */}
        <div 
          ref={parentRef}
          className="max-h-[700px] min-h-[500px] overflow-auto custom-scrollbar [scrollbar-gutter:stable]"
        >
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const log = filteredLogs[virtualRow.index];
              return (
                <AuditRow 
                    key={virtualRow.key}
                    log={log}
                    style={{
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start}px)`,
                    }}
                    onInspect={handleInspect}
                />
              );
            })}
          </div>
          {filteredLogs.length === 0 && (
            <div className="py-20 text-center text-default-400 italic text-sm">
                Sin eventos registrados bajo estos filtros.
            </div>
          )}
        </div>
      </div>

      {/* MODAL DE INSPECCIÓN PROFUNDA */}
      <Modal 
        isOpen={isOpen} 
        onOpenChange={onOpenChange}
        size="2xl"
        backdrop="blur"
        classNames={{
            base: "bg-white dark:bg-zinc-950 border border-default-100 shadow-2xl rounded-3xl",
            header: "border-b border-default-100 py-6",
            body: "py-6",
            footer: "border-t border-default-100"
        }}
      >
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex flex-col gap-1">
                <div className="flex items-center gap-3">
                    <div className={`h-12 w-12 rounded-2xl flex items-center justify-center text-white shadow-lg ${selectedLog?.is_critical ? 'bg-rose-500 shadow-rose-500/20' : 'bg-emerald-500 shadow-emerald-500/20'}`}>
                        {selectedLog?.is_critical ? <ShieldAlert size={24} /> : <History size={24} />}
                    </div>
                    <div className="flex flex-col">
                        <h3 className="text-sm font-black uppercase tracking-tighter italic">Inspección Forense de Evento</h3>
                        <p className="text-[10px] font-bold text-default-400 uppercase tracking-widest">ID Registro: #{selectedLog?.id}</p>
                    </div>
                </div>
              </ModalHeader>
              <ModalBody className="flex flex-col gap-6">
                <div className="grid grid-cols-2 gap-4">
                    <div className="bg-default-50 p-3 rounded-2xl border border-default-100">
                        <div className="flex items-center gap-2 mb-2 text-default-400">
                            <Globe size={14} />
                            <span className="text-[9px] font-black uppercase tracking-widest">Origen de Conexión</span>
                        </div>
                        <p className="text-xs font-mono font-black text-default-700">{selectedLog?.ip_address}</p>
                    </div>
                    <div className="bg-default-50 p-3 rounded-2xl border border-default-100">
                        <div className="flex items-center gap-2 mb-2 text-default-400">
                            <Monitor size={14} />
                            <span className="text-[9px] font-black uppercase tracking-widest">Dispositivo / User-Agent</span>
                        </div>
                        <Tooltip content={selectedLog?.device || "N/A"}>
                            <p className="text-[10px] font-bold text-default-600 truncate">{selectedLog?.device || "Desconocido"}</p>
                        </Tooltip>
                    </div>
                </div>

                <div className="flex flex-col gap-3">
                    <h4 className="text-[10px] font-black text-emerald-500 uppercase tracking-widest italic flex items-center gap-2">
                        <ArrowRight size={14} /> Trazabilidad de Cambios (Kardex Audit)
                    </h4>
                    {renderChangesTable(selectedLog?.changes)}
                </div>

                <div className="flex flex-col gap-2 p-4 bg-default-50 rounded-2xl border border-default-100">
                    <span className="text-[9px] font-black text-default-400 uppercase tracking-widest">Relato Técnico</span>
                    <p className="text-xs font-medium text-default-600 italic">
                        &quot;{selectedLog?.human_readable || selectedLog?.details}&quot;
                    </p>
                </div>
              </ModalBody>
              <ModalFooter>
                <Button 
                    className="font-black text-[10px] uppercase tracking-widest italic rounded-xl h-10 border border-default-200 bg-white dark:bg-zinc-900"
                    onPress={onClose}
                >
                    Cerrar Informe
                </Button>
                <Button 
                    color="primary"
                    className="font-black text-[10px] uppercase tracking-widest italic rounded-xl h-10 shadow-lg shadow-emerald-500/20"
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
