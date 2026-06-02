"use client";

import React, { useState, useEffect, useRef } from "react";
import { ScannerOverlay } from "@/components/ScannerOverlay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { AlertTriangle, Trash2, CheckCircle2, Search, Camera } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type ShrinkageReason = "VENCIMIENTO" | "ROTURA" | "CONSUMO_INTERNO" | "HURTO";

interface Product {
  barcode: string;
  productName: string;
  quantity: number;
  salePrice: number;
  purchasePrice: number;
}

interface ShrinkageRecord {
  id: string;
  productName: string;
  barcode: string;
  quantity: number;
  reason: string;
  cost: number;
  time: string;
}

export default function ShrinkagePage() {
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [quantity, setQuantity] = useState<number | "">("");
  const [reason, setReason] = useState<ShrinkageReason>("ROTURA");
  const [notes, setNotes] = useState("");
  const [history, setHistory] = useState<ShrinkageRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [barcodeInput, setBarcodeInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    // Mantener focus en el input para lectura de pistola laser rapida
    if (!isScannerOpen && !selectedProduct && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isScannerOpen, selectedProduct]);

  const handleSearch = async (barcode: string) => {
    if (!barcode) return;
    setLoading(true);
    try {
      const res = await fetch(`http://${window.location.hostname}:8080/api/products/get-products/${barcode}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
      });
      if (!res.ok) throw new Error("Producto no encontrado");
      const data = await res.json();
      setSelectedProduct(data);
      setBarcodeInput("");
    } catch (err) {
      toast({ title: "No encontrado", description: `No existe producto con codigo: ${barcode}`, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    if (!selectedProduct || !quantity || quantity <= 0) return;
    setLoading(true);
    try {
      const payload = {
        barcode: selectedProduct.barcode,
        quantity: Number(quantity),
        reason,
        notes,
      };

      const res = await fetch(`http://${window.location.hostname}:8080/api/inventory/shrinkage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error?.message || "Fallo al registrar merma");
      }

      toast({ title: "EXITO", description: "Merma registrada correctamente" });

      const newRecord: ShrinkageRecord = {
        id: Date.now().toString(),
        productName: selectedProduct.productName,
        barcode: selectedProduct.barcode,
        quantity: Number(quantity),
        reason,
        cost: selectedProduct.purchasePrice * Number(quantity),
        time: new Date().toLocaleTimeString(),
      };
      setHistory([newRecord, ...history]);

      setSelectedProduct(null);
      setQuantity("");
      setNotes("");
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full w-full max-w-[1600px] mx-auto overflow-y-auto custom-scrollbar p-6 space-y-6">
      <div className="shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-red-500 flex items-center gap-2">
            <AlertTriangle className="h-8 w-8" />
            Mermas y Averias
          </h1>
          <p className="text-muted-foreground mt-1">
            Declare perdidas de inventario por vencimiento, dano o consumo interno.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="border-red-900/20 bg-[#18181b] h-fit">
          <CardHeader>
            <CardTitle>Nueva Baja de Inventario</CardTitle>
            <CardDescription>Escanee o busque el producto a dar de baja</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {!selectedProduct ? (
              <div className="flex gap-2">
                <Input
                  ref={inputRef}
                  placeholder="Escanear o ingresar codigo..."
                  value={barcodeInput}
                  onChange={(e) => setBarcodeInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleSearch(barcodeInput);
                    }
                  }}
                  className="flex-1"
                />
                <Button variant="secondary" onClick={() => handleSearch(barcodeInput)} disabled={loading}>
                  <Search className="h-4 w-4" />
                </Button>
                <Button variant="outline" onClick={() => setIsScannerOpen(true)}>
                  <Camera className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div className="bg-red-950/20 p-5 rounded-2xl border border-red-900/30 space-y-5">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="font-semibold text-xl">{selectedProduct.productName}</h3>
                    <p className="text-sm text-muted-foreground font-mono mt-1">Cod: {selectedProduct.barcode}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-muted-foreground mb-1">Stock Actual</p>
                    <span className="font-mono text-2xl font-bold text-primary px-3 py-1 bg-primary/10 rounded-2xl">
                      {selectedProduct.quantity}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Cantidad a dar de baja</label>
                    <Input 
                      type="number" 
                      value={quantity} 
                      onChange={(e) => setQuantity(e.target.value ? Number(e.target.value) : "")}
                      placeholder="0.00"
                      min={0.01}
                      max={selectedProduct.quantity}
                      step="any"
                      className="text-lg font-mono bg-background/50"
                      autoFocus
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Motivo de Baja</label>
                    <Select value={reason} onValueChange={(v: ShrinkageReason) => setReason(v)}>
                      <SelectTrigger className="bg-background/50">
                        <SelectValue placeholder="Seleccione motivo" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="VENCIMIENTO">Vencimiento</SelectItem>
                        <SelectItem value="ROTURA">Rotura / Dano</SelectItem>
                        <SelectItem value="CONSUMO_INTERNO">Consumo Interno</SelectItem>
                        <SelectItem value="HURTO">Hurto</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Notas Adicionales (Opcional)</label>
                  <Input 
                    placeholder="Detalles especificos..." 
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="bg-background/50"
                  />
                </div>

                <div className="flex justify-end gap-3 pt-4 border-t border-border/50">
                  <Button variant="ghost" onClick={() => { setSelectedProduct(null); setQuantity(""); }} disabled={loading}>
                    Cancelar
                  </Button>
                  <Button 
                    variant="destructive" 
                    onClick={handleRegister} 
                    disabled={!quantity || quantity <= 0 || loading || quantity > selectedProduct.quantity}
                    className="gap-2 shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-red-500/20"
                  >
                    <Trash2 className="h-4 w-4" />
                    Registrar Perdida
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-[#18181b] border-border/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Historial de Hoy
              <span className="bg-primary/20 text-primary text-xs px-2 py-1 rounded-2xl font-medium ml-2">
                {history.length}
              </span>
            </CardTitle>
            <CardDescription>Mermas registradas en el turno actual</CardDescription>
          </CardHeader>
          <CardContent>
            {history.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground border-2 border-dashed border-border/30 rounded-2xl">
                <CheckCircle2 className="h-12 w-12 mb-4 opacity-20 text-zinc-900 dark:text-zinc-100" />
                <p className="font-medium">Cero mermas registradas</p>
                <p className="text-sm opacity-70">Inventario sano por ahora.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {history.map((record) => (
                  <div key={record.id} className="flex items-center justify-between p-4 bg-background/60 rounded-2xl border border-border/50 shadow-[0_8px_30px_rgb(0,0,0,0.12)] transition-all hover:bg-background/80">
                    <div className="flex flex-col">
                      <span className="font-semibold">{record.productName}</span>
                      <div className="flex gap-2 items-center text-xs text-muted-foreground mt-1.5">
                        <span className="bg-red-500/10 text-red-500 px-2.5 py-0.5 rounded-2xl font-medium tracking-wide">
                          {record.reason}
                        </span>
                        <span>{record.time}</span>
                      </div>
                    </div>
                    <div className="text-right flex flex-col items-end gap-1">
                      <span className="font-bold text-red-500 bg-red-500/10 px-2 py-0.5 rounded-2xl">
                        -{record.quantity}
                      </span>
                      <span className="text-xs font-medium text-muted-foreground">
                        ${record.cost.toLocaleString('es-CO')}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {isScannerOpen && (
        <ScannerOverlay
          isOpen={isScannerOpen}
          onClose={() => setIsScannerOpen(false)}
          onResult={(code) => {
            setIsScannerOpen(false);
            handleSearch(code);
          }}
          title="Escanear Producto a Dar de Baja"
        />
      )}
    </div>
  );
}



