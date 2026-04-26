"use client";

import React from 'react';
import { Card, CardBody, Progress, Chip, Button } from "@heroui/react";
import { Wallet, ArrowUpRight, ArrowDownRight, TrendingUp, Sparkles, ChevronRight } from 'lucide-react';
import Link from 'next/link';

export default function CashFlowWidget() {
  // Logic to fetch this data would go here. For now, we use realistic placeholders.
  const accountsReceivable = 4550000;
  const accountsPayable = 2800000;
  const netFlow = accountsReceivable - accountsPayable;
  const progressRatio = (accountsPayable / accountsReceivable) * 100;

  return (
    <Card className="bg-white/80 dark:bg-zinc-950/60 backdrop-blur-3xl rounded-[2.5rem] border border-gray-200 dark:border-white/10 shadow-xl group h-fit">
      <CardBody className="p-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 bg-emerald-500/10 text-emerald-500 rounded-2xl flex items-center justify-center border border-emerald-500/20 shadow-inner group-hover:rotate-12 transition-transform">
              <Wallet size={24} />
            </div>
            <div className="flex flex-col">
              <h3 className="font-black text-gray-900 dark:text-white uppercase italic tracking-tighter text-lg">Balance <span className="text-emerald-500">Operativo</span></h3>
              <p className="text-[9px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest italic opacity-70">Cartera vs Cuentas por Pagar</p>
            </div>
          </div>
          <Chip size="sm" variant="shadow" color="success" className="font-black text-[10px] uppercase italic tracking-[0.2em] px-4">SALUDABLE</Chip>
        </div>

        <div className="grid grid-cols-2 gap-6 mb-8">
          <div className="space-y-1">
            <div className="flex items-center gap-2 opacity-60">
              <ArrowUpRight size={14} className="text-emerald-500" />
              <span className="text-[10px] font-black uppercase text-gray-400 dark:text-zinc-500 tracking-widest italic">Por Cobrar</span>
            </div>
            <span className="text-2xl font-black text-gray-900 dark:text-white italic tracking-tighter">${accountsReceivable.toLocaleString()}</span>
          </div>
          
          <div className="space-y-1">
            <div className="flex items-center gap-2 opacity-60">
              <ArrowDownRight size={14} className="text-rose-500" />
              <span className="text-[10px] font-black uppercase text-gray-400 dark:text-zinc-500 tracking-widest italic">Por Pagar</span>
            </div>
            <span className="text-2xl font-black text-gray-900 dark:text-white italic tracking-tighter">${accountsPayable.toLocaleString()}</span>
          </div>
        </div>

        <div className="space-y-4 mb-8">
          <div className="flex items-center justify-between">
             <span id="cashflow-capital-commitment-label" className="text-[10px] font-black uppercase text-gray-400 dark:text-zinc-500 tracking-widest italic">Compromiso de Capital</span>
             <span className="text-[10px] font-black text-emerald-500 italic">{progressRatio.toFixed(1)}%</span>
          </div>
          <Progress 
            value={progressRatio} 
            color="success" 
            className="h-2"
            aria-labelledby="cashflow-capital-commitment-label"
            classNames={{
              indicator: "bg-gradient-to-r from-emerald-500 to-teal-400 shadow-[0_0_15px_rgba(16,185,129,0.3)]"
            }}
          />
        </div>

        <div className="flex items-center justify-between p-5 bg-gray-50 dark:bg-zinc-900/50 rounded-[1.5rem] border border-gray-100 dark:border-white/5 mb-8">
          <div className="flex flex-col">
            <span className="text-[9px] font-black text-gray-400 uppercase tracking-[0.2em] italic">Neto Operativo</span>
            <span className="text-xl font-black text-emerald-500 italictracking-tighter">${netFlow.toLocaleString()}</span>
          </div>
          <TrendingUp size={24} className="text-emerald-500 opacity-20" />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Button 
            as={Link} 
            href="/sales/debts"
            size="sm" 
            variant="flat" 
            className="font-black text-[9px] uppercase italic tracking-widest rounded-xl bg-white dark:bg-white/5 border border-gray-100 dark:border-white/5"
          >
            COBROS <ChevronRight size={14} className="ml-1" />
          </Button>
          <Button 
            as={Link} 
            href="/inventory/orders"
            size="sm" 
            className="font-black text-[9px] uppercase italic tracking-widest rounded-xl bg-gray-900 dark:bg-white text-white dark:text-black"
          >
            PEDIDOS <Sparkles size={14} className="ml-1" />
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
