"use client";
import React, { useMemo, useState } from 'react';
import { 
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Chip, Input, User as HeroUser
} from "@heroui/react";
import { Search, Info } from 'lucide-react';
import { AuditLog } from '@/lib/definitions';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

interface AuditTableProps {
  logs: AuditLog[];
}

export default function AuditTable({ logs }: AuditTableProps) {
  const [filter, setFilter] = useState("");

  const filteredLogs = useMemo(() => {
    return logs.filter(log => 
      log.employee_dni.toLowerCase().includes(filter.toLowerCase()) ||
      log.action.toLowerCase().includes(filter.toLowerCase()) ||
      log.module.toLowerCase().includes(filter.toLowerCase()) ||
      log.details.toLowerCase().includes(filter.toLowerCase())
    );
  }, [logs, filter]);

  const getActionColor = (action: string) => {
    const act = action.toUpperCase();
    if (act.includes('CREATE') || act.includes('REGISTER')) return "success";
    if (act.includes('UPDATE') || act.includes('RESET')) return "warning";
    if (act.includes('DELETE') || act.includes('REVOKE') || act.includes('FAIL')) return "danger";
    return "primary";
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between items-center bg-background/60 backdrop-blur-md p-4 rounded-xl border border-default-100 shadow-sm">
        <Input
          isClearable
          className="w-full sm:max-w-[44%]"
          placeholder="Buscar por DNI, Acción, Módulo o Detalle..."
          startContent={<Search size={18} className="text-default-400" />}
          value={filter}
          onValueChange={setFilter}
        />
        <div className="flex gap-2 items-center text-default-400 italic text-tiny">
          <Info size={14} />
          {filteredLogs.length} registros encontrados
        </div>
      </div>

      <Table 
        aria-label="Registros de Auditoría"
        className="shadow-sm"
        isHeaderSticky
        classNames={{
          wrapper: "max-h-[600px] border border-default-100",
          th: "bg-default-100/50 text-default-600",
        }}
      >
        <TableHeader>
          <TableColumn width={200}>FECHA Y HORA</TableColumn>
          <TableColumn>USUARIO (DNI)</TableColumn>
          <TableColumn>ACCIÓN</TableColumn>
          <TableColumn>MÓDULO</TableColumn>
          <TableColumn>IP</TableColumn>
          <TableColumn>DETALLES</TableColumn>
        </TableHeader>
        <TableBody 
          items={filteredLogs}
          emptyContent="No se encontraron registros de auditoría."
        >
          {(log) => (
            <TableRow key={log.id}>
              <TableCell>
                <span className="text-tiny font-medium">
                  {format(new Date(log.created_at), "dd MMM yyyy, HH:mm:ss", { locale: es })}
                </span>
              </TableCell>
              <TableCell>
                <HeroUser
                  name={log.employee_dni}
                  description="Responsable"
                  avatarProps={{
                    size: "sm",
                    className: "bg-default-200"
                  }}
                />
              </TableCell>
              <TableCell>
                <Chip 
                  size="sm" 
                  variant="flat" 
                  color={getActionColor(log.action)}
                  className="font-bold border-1 uppercase text-[10px]"
                >
                  {log.action}
                </Chip>
              </TableCell>
              <TableCell>
                <span className="text-tiny uppercase text-default-500 font-bold bg-default-100 px-2 py-1 rounded">
                  {log.module}
                </span>
              </TableCell>
              <TableCell>
                <code className="text-[10px] text-default-400 bg-default-50 px-1 rounded">
                  {log.ip_address}
                </code>
              </TableCell>
              <TableCell>
                <span className="text-tiny text-default-600 truncate max-w-[250px] block">
                  {log.details}
                </span>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
