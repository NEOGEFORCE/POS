"use client"
import { useState, useEffect } from "react"
import { Undo2, Receipt, Scan, Banknote, CreditCard, ShoppingCart, Scale, Check, Plus, Trash, History, AlertTriangle, PackageX, Barcode, ArrowLeft } from "lucide-react"
import Cookies from "js-cookie"
import { apiFetch } from "@/lib/api-error"
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button } from "@heroui/react"

interface Sale {
  id: number
  total: number
  paymentMethod: string
  date: string
  employee?: { name: string }
}

interface SaleItem {
  barcode: string
  productName: string
  quantity: number
  unitPrice: number
}

interface ReturnItem {
  barcode: string
  productName: string
  unitPrice: number
  maxQty: number
  qty: number
}

interface ReplacementItem {
  barcode: string
  productName: string
  price: number
}

export default function DevolucionesPage() {
  const [tab, setTab] = useState<"factura" | "ciego">("factura")
  const [screen, setScreen] = useState<"busqueda" | "devolucion" | "confirmado">("busqueda")
  const [facturaInput, setFacturaInput] = useState("")
  const [recentSales, setRecentSales] = useState<Sale[]>([])
  const [currentSale, setCurrentSale] = useState<Sale | null>(null)
  const [returnItems, setReturnItems] = useState<ReturnItem[]>([])
  const [replacements, setReplacements] = useState<ReplacementItem[]>([])
  const [replacementInput, setReplacementInput] = useState("")
  const [productResults, setProductResults] = useState<{barcode: string, productName: string, salePrice: number}[]>([])
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [ciegoInput, setCiegoInput] = useState("")
  const [ciegoResults, setCiegoResults] = useState<{barcode: string, productName: string, salePrice: number}[]>([])
  const [loading, setLoading] = useState(false)
  const [confirmData, setConfirmData] = useState<any>(null)
  
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false)
  const [chargeMethod, setChargeMethod] = useState("EFECTIVO")
  const token = Cookies.get("org-pos-token") || ""

  const fmt = (n: number) => "$" + Math.round(n).toLocaleString("es-CO")

  useEffect(() => {
    let url = "/sales/list?pageSize=10"
    if (dateFrom) {
      url += `&from=${encodeURIComponent(dateFrom + ":00")}`
    }
    if (dateTo) {
      url += `&to=${encodeURIComponent(dateTo + ":59")}`
    }
    apiFetch<{items: Sale[]}>(url, {}, token)
      .then(data => setRecentSales(data?.items || []))
      .catch(() => {})
  }, [dateFrom, dateTo, token])

  useEffect(() => {
    if (ciegoInput.length < 2) {
      setCiegoResults([])
      return
    }
    const timeout = setTimeout(async () => {
      try {
         const data = await apiFetch<{items: any[]}>(`/products/paginated?q=${encodeURIComponent(ciegoInput)}&page=1&pageSize=5`, {}, token)
         setCiegoResults(data.items || [])
      } catch (e) {}
    }, 300)
    return () => clearTimeout(timeout)
  }, [ciegoInput, token])

  useEffect(() => {
    if (replacementInput.length < 2) {
      setProductResults([])
      return
    }
    const timeout = setTimeout(async () => {
      try {
         const data = await apiFetch<{items: any[]}>(`/products/paginated?q=${encodeURIComponent(replacementInput)}&page=1&pageSize=5`, {}, token)
         setProductResults(data.items || [])
      } catch (e) {}
    }, 300)
    return () => clearTimeout(timeout)
  }, [replacementInput, token])

  const totalDev = returnItems.reduce((s, i) => s + i.qty * i.unitPrice, 0)
  const totalLleva = replacements.reduce((s, r) => s + r.price, 0)
  const saldo = totalDev - totalLleva

  const buscarFactura = async (ref?: string) => {
    const id = ref || facturaInput.trim()
    if (!id) return
    setLoading(true)
    try {
      const data = await apiFetch<{ sale: Sale; items: SaleItem[] }>(
        `/sales/returns/invoice/${id}`, {}, token
      )
      setCurrentSale(data.sale)
      setReturnItems(data.items.map(i => ({ ...i, maxQty: i.quantity, qty: 0 })))
      setReplacements([])
      setScreen("devolucion")
    } catch {
      alert("Factura no encontrada")
    } finally {
      setLoading(false)
    }
  }

  const buscarCiego = async (barcode: string) => {
    if (!barcode.trim()) return
    setLoading(true)
    try {
      const data = await apiFetch<{ sale: Sale; item: SaleItem }>(
        `/sales/returns/blind?barcode=${barcode}`, {}, token
      )
      setCurrentSale(data.sale)
      setReturnItems([{ ...data.item, maxQty: data.item.quantity, qty: 0 }])
      setReplacements([])
      setScreen("devolucion")
    } catch (e: any) {
      alert(e.message || "Producto no encontrado en ventas recientes")
    } finally {
      setLoading(false)
    }
  }

  const cambiarQty = (idx: number, delta: number) => {
    setReturnItems(prev => prev.map((item, i) => {
      if (i !== idx) return item
      return { ...item, qty: Math.max(0, Math.min(item.maxQty, item.qty + delta)) }
    }))
  }

  const agregarReemplazo = async (barcode: string) => {
    if (!barcode.trim()) return
    try {
      const data = await apiFetch<{ barcode: string; productName: string; salePrice: number }>(
        `/products/barcode/${barcode}`, {}, token
      )
      setReplacements(prev => [...prev, {
        barcode: data.barcode,
        productName: data.productName,
        price: data.salePrice
      }])
      setReplacementInput("")
      setProductResults([])
    } catch {
      alert("Producto no encontrado")
    }
  }

  const procesarDevolucion = async () => {
    const isTransferencia = currentSale?.paymentMethod?.toLowerCase().includes("transfer") ||
      currentSale?.paymentMethod?.toLowerCase().includes("nequi") ||
      currentSale?.paymentMethod?.toLowerCase().includes("daviplata") ||
      currentSale?.paymentMethod?.toLowerCase().includes("credito") ||
      currentSale?.paymentMethod?.toLowerCase().includes("fiado")

    if (isTransferencia && saldo > 0) {
      alert("Este pago no fue en efectivo → el cliente debe llevarse productos por un valor igual o mayor. No se puede entregar dinero de la caja.")
      return
    }
    
    setIsPaymentModalOpen(true)
  }

  const confirmarDevolucion = async () => {
    setIsPaymentModalOpen(false)
    const tipo = saldo >= 0 ? "REFUND" : "EXCHANGE"
    setLoading(true)
    try {
      await apiFetch("/sales/returns", {
        method: "POST",
        body: JSON.stringify({
          invoiceRef: currentSale?.id,
          returnedItems: returnItems.filter(i => i.qty > 0).map(i => ({ barcode: i.barcode, qty: i.qty })),
          replacementItems: replacements.map(r => ({ barcode: r.barcode, qty: 1 })),
          type: tipo,
          refundAmount: saldo > 0 ? saldo : 0,
          chargeAmount: saldo < 0 ? Math.abs(saldo) : 0,
          chargeMethod: saldo < 0 ? chargeMethod : "EFECTIVO",
        })
      }, token)

      const devueltos = returnItems.filter(i => i.qty > 0)
        .map(i => `· ${i.productName} × ${i.qty} → vuelve al stock`).join("\n")
      const llevados = replacements.length
        ? "\n" + replacements.map(r => `· ${r.productName} → sale del stock`).join("\n") : ""
      const cierre = saldo > 0
        ? `\n✓ Reembolso en efectivo: ${fmt(saldo)} descontado de caja`
        : saldo < 0 ? `\n✓ Cobro adicional al cliente: ${fmt(Math.abs(saldo))}`
        : "\n✓ Sin movimiento de dinero"

      setConfirmData({
        title: tipo === "REFUND" ? "Reembolso procesado" : "Cambio procesado",
        sub: "Inventario actualizado · Caja ajustada · " + tipo,
        detail: devueltos + llevados + cierre,
        tipo
      })
      setScreen("confirmado")
    } catch (e: any) {
      alert(e.message || "Error al procesar la devolución")
    } finally {
      setLoading(false)
    }
  }

  const nuevaDevolucion = () => {
    setReturnItems([])
    setReplacements([])
    setCurrentSale(null)
    setFacturaInput("")
    setScreen("busqueda")
    setTab("factura")
  }

  const isTransferencia = currentSale?.paymentMethod?.toLowerCase().includes("transfer") ||
    currentSale?.paymentMethod?.toLowerCase().includes("nequi") ||
    currentSale?.paymentMethod?.toLowerCase().includes("daviplata")

  return (
    <div className="p-6 max-w-4xl mx-auto">

      {/* PANTALLA BÚSQUEDA */}
      {screen === "busqueda" && (
        <div>
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                <Undo2 className="w-5 h-5 text-amber-700 dark:text-amber-400" />
              </div>
              <div>
                <h1 className="text-lg font-medium">Centro de devoluciones</h1>
                <p className="text-sm text-muted-foreground">Reembolsos y cambios de inventario</p>
              </div>
            </div>
            <button className="flex items-center gap-2 px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted/50">
              <History className="w-4 h-4" /> Historial
            </button>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 p-1 bg-elevated rounded-full w-fit mb-5">
            <button onClick={() => setTab("factura")}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm transition-all ${tab === "factura" ? "bg-emerald-600 text-white shadow-md font-medium" : "text-muted-foreground hover:text-primary"}`}>
              <Receipt className="w-3.5 h-3.5" /> Con factura
            </button>
            <button onClick={() => setTab("ciego")}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm transition-all ${tab === "ciego" ? "bg-emerald-600 text-white shadow-md font-medium" : "text-muted-foreground hover:text-primary"}`}>
              <Scan className="w-3.5 h-3.5" /> Sin factura
            </button>
          </div>

          {tab === "factura" && (
            <div>
              <div className="flex items-center gap-3 px-4 py-3 bg-card shadow-sm border border-border rounded-xl mb-4 focus-within:border-emerald-500/50 focus-within:ring-2 focus-within:ring-emerald-500/20 transition-all">
                <Receipt className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                <input value={facturaInput} onChange={e => setFacturaInput(e.target.value.toUpperCase())}
                  onKeyDown={e => e.key === "Enter" && buscarFactura()}
                  placeholder="Número de factura o escanea el código…"
                  className="flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground" />
                <button onClick={() => buscarFactura()}
                  disabled={loading}
                  className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 transition-colors text-white text-sm font-medium rounded-lg">
                  {loading ? "..." : "Buscar"}
                </button>
              </div>

              <div className="flex flex-col gap-2 mb-3">
                <p className="text-sm font-medium text-muted-foreground">Últimas transacciones</p>
                  <div className="flex gap-2 items-center">
                    <input 
                      type="datetime-local" 
                      value={dateFrom}
                      onChange={e => setDateFrom(e.target.value)}
                      className="bg-card text-xs px-2 py-1.5 rounded-lg border border-border outline-none focus:border-emerald-500/50 flex-1"
                    />
                    <span className="text-muted-foreground text-xs font-medium">a</span>
                    <input 
                      type="datetime-local" 
                      value={dateTo}
                      onChange={e => setDateTo(e.target.value)}
                      className="bg-card text-xs px-2 py-1.5 rounded-lg border border-border outline-none focus:border-emerald-500/50 flex-1"
                    />
                  </div>
                </div>
                <div className="border border-border rounded-xl overflow-hidden">
                <div className="grid grid-cols-4 gap-3 px-4 py-2 text-xs text-muted-foreground uppercase tracking-wide border-b border-border">
                  <span>Factura</span><span>Hora</span><span className="text-right">Total</span><span className="text-right">Método</span>
                </div>
                {recentSales.map(sale => (
                  <div key={sale.id} onClick={() => buscarFactura(String(sale.id))}
                    className="grid grid-cols-4 gap-3 items-center px-4 py-3 border-b border-border last:border-0 cursor-pointer hover:bg-muted/50 transition-colors">
                    <p className="text-sm font-medium">#{sale.id}</p>
                    <p className="text-sm text-muted-foreground">
                      {sale.date ? new Date(sale.date).toLocaleString("es-CO", { hour: "2-digit", minute: "2-digit" }) : ""}
                    </p>
                    <p className="text-sm font-medium text-right">{fmt(sale.total || 0)}</p>
                    <div className="flex justify-end">
                      <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border ${
                        sale.paymentMethod?.toLowerCase().includes("transfer") || sale.paymentMethod?.toLowerCase().includes("nequi")
                          ? "bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-400"
                          : "bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400"
                      }`}>
                        {sale.paymentMethod?.toLowerCase().includes("transfer") || sale.paymentMethod?.toLowerCase().includes("nequi")
                          ? <CreditCard className="w-3 h-3" />
                          : <Banknote className="w-3 h-3" />}
                        {sale.paymentMethod}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "ciego" && (
            <div>
              <div className="flex items-start gap-3 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl mb-4">
                <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
                  El sistema buscará en las últimas 100 ventas para verificar si el producto fue comprado, cómo se pagó y cuántas unidades son válidas para devolver.
                </p>
              </div>
              <div className="relative">
                <div className="flex items-center gap-3 px-4 py-3 bg-card shadow-sm border border-border rounded-xl focus-within:border-emerald-500/50 focus-within:ring-2 focus-within:ring-emerald-500/20 transition-all">
                  <Barcode className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                  <input value={ciegoInput} onChange={e => setCiegoInput(e.target.value.toUpperCase())}
                    onKeyDown={e => { if (e.key === "Enter") buscarCiego(ciegoInput) }}
                    placeholder="Escanea o busca producto por nombre…"
                    className="flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground" />
                  <button onClick={() => buscarCiego(ciegoInput)} className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 transition-colors text-white text-sm font-medium rounded-lg">
                    Buscar
                  </button>
                </div>
                {ciegoResults.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border shadow-lg rounded-lg overflow-hidden z-10">
                    {ciegoResults.map((pr, i) => (
                      <div key={i} onClick={() => { setCiegoInput(pr.barcode); buscarCiego(pr.barcode); setCiegoResults([]) }}
                        className="px-4 py-3 border-b border-border last:border-0 hover:bg-elevated cursor-pointer transition-colors flex justify-between items-center">
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">{pr.productName}</span>
                          <span className="text-xs text-muted-foreground">{pr.barcode}</span>
                        </div>
                        <span className="text-sm font-medium text-emerald-500">{fmt(pr.salePrice)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* PANTALLA DEVOLUCIÓN ACTIVA */}
      {screen === "devolucion" && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <button onClick={() => setScreen("busqueda")} className="p-2 rounded-lg hover:bg-muted/50">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="text-base font-medium">Factura #{currentSale?.id}</p>
                <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border ${
                  isTransferencia
                    ? "bg-blue-50 dark:bg-blue-900/20 border-blue-200 text-blue-700 dark:text-blue-400"
                    : "bg-elevated border-border text-muted-foreground"
                }`}>
                  {isTransferencia ? <CreditCard className="w-3 h-3" /> : <Banknote className="w-3 h-3" />}
                  {currentSale?.paymentMethod}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {currentSale?.employee?.name} · {fmt(currentSale?.total || 0)}
              </p>
            </div>
          </div>

          {isTransferencia && (
            <div className="flex items-start gap-3 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl mb-4">
              <AlertTriangle className="w-4 h-4 text-blue-700 dark:text-blue-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-blue-700 dark:text-blue-400">
                Pago original con transferencia — el cliente debe llevarse otro producto. No se permite reembolso en efectivo.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 mb-4">
            {/* Columna devuelve */}
            <div className="border border-green-200 dark:border-green-800 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Undo2 className="w-4 h-4 text-green-700 dark:text-green-400" />
                  <p className="text-sm font-medium text-green-700 dark:text-green-400">El cliente devuelve</p>
                </div>
                <p className="text-sm font-medium text-green-700 dark:text-green-400">{fmt(totalDev)}</p>
              </div>
              {returnItems.map((item, i) => (
                <div key={i} className="flex items-center gap-2 py-2.5 border-b border-border last:border-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.productName}</p>
                    <p className="text-xs text-muted-foreground">{fmt(item.unitPrice)} · compró {item.maxQty}</p>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button onClick={() => cambiarQty(i, -1)}
                      className="w-7 h-7 rounded-md border border-border bg-elevated flex items-center justify-center text-base hover:bg-border">−</button>
                    <span className="w-6 text-center text-sm font-medium">{item.qty}</span>
                    <button onClick={() => cambiarQty(i, 1)}
                      className="w-7 h-7 rounded-md border border-border bg-elevated flex items-center justify-center text-base hover:bg-border">+</button>
                  </div>
                </div>
              ))}
            </div>

            {/* Columna se lleva */}
            <div className="border border-blue-200 dark:border-blue-800 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <ShoppingCart className="w-4 h-4 text-blue-700 dark:text-blue-400" />
                  <p className="text-sm font-medium text-blue-700 dark:text-blue-400">Se lleva</p>
                </div>
                <p className="text-sm font-medium text-blue-700 dark:text-blue-400">{fmt(totalLleva)}</p>
              </div>
              <div className="relative">
                  <div className="flex items-center gap-2 px-3 py-2 bg-card border border-border rounded-lg mb-3 focus-within:border-emerald-500/50 transition-all">
                    <Barcode className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <input value={replacementInput} onChange={e => setReplacementInput(e.target.value.toUpperCase())}
                      onKeyDown={e => { if (e.key === "Enter") agregarReemplazo(replacementInput) }}
                      placeholder="Escanear o buscar producto de reemplazo…"
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
                  </div>
                  {productResults.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border shadow-lg rounded-lg overflow-hidden z-10">
                      {productResults.map((pr, i) => (
                        <div key={i} onClick={() => agregarReemplazo(pr.barcode)}
                          className="px-3 py-2 border-b border-border last:border-0 hover:bg-elevated cursor-pointer transition-colors flex justify-between items-center">
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">{pr.productName}</span>
                            <span className="text-xs text-muted-foreground">{pr.barcode}</span>
                          </div>
                          <span className="text-sm font-medium text-emerald-500">{fmt(pr.salePrice)}</span>
                        </div>
                      ))}
                    </div>
                  )}
              </div>
              {replacements.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground text-sm">
                  <PackageX className="w-6 h-6 mx-auto mb-2 opacity-50" />
                  Si quiere otro producto<br />escanéalo aquí
                </div>
              ) : (
                replacements.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 py-2.5 border-b border-border last:border-0">
                    <div className="flex-1">
                      <p className="text-sm font-medium">{r.productName}</p>
                      <p className="text-xs text-muted-foreground">{fmt(r.price)}</p>
                    </div>
                    <button onClick={() => setReplacements(prev => prev.filter((_, j) => j !== i))}
                      className="p-1 rounded hover:bg-muted/50 text-red-500">
                      <Trash className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Barra de saldo */}
          {totalDev > 0 && (
            <div className={`flex items-center justify-between p-4 rounded-xl mb-4 border ${
              saldo > 0 ? "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800"
              : saldo < 0 ? "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800"
              : "bg-elevated border-border"
            }`}>
              <div className="flex items-center gap-3">
                {saldo > 0 ? <Banknote className={`w-6 h-6 text-green-700 dark:text-green-400`} />
                  : saldo < 0 ? <CreditCard className="w-6 h-6 text-red-700 dark:text-red-400" />
                  : <Check className="w-6 h-6 text-muted-foreground" />}
                <div>
                  <p className={`text-sm font-medium ${saldo > 0 ? "text-green-700 dark:text-green-400" : saldo < 0 ? "text-red-700 dark:text-red-400" : ""}`}>
                    {saldo > 0 ? "Entrégarle al cliente" : saldo < 0 ? "El cliente paga la diferencia" : "Cambio exacto — sin cobro ni reembolso"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {saldo > 0 ? "Se descuenta de caja · REEMBOLSO" : saldo < 0 ? "Abre el modal de pago · CAMBIO" : "CAMBIO sin diferencia"}
                  </p>
                </div>
              </div>
              <p className={`text-2xl font-medium ${saldo > 0 ? "text-green-700 dark:text-green-400" : saldo < 0 ? "text-red-700 dark:text-red-400" : ""}`}>
                {saldo !== 0 ? fmt(Math.abs(saldo)) : "$0"}
              </p>
            </div>
          )}

          {totalDev > 0 && (
            <button onClick={procesarDevolucion} disabled={loading}
              className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl text-white font-medium text-sm ${
                saldo > 0 ? "bg-green-700 hover:bg-green-800"
                : saldo < 0 ? "bg-blue-700 hover:bg-blue-800"
                : "bg-emerald-600 hover:bg-emerald-700"
              }`}>
              <Check className="w-4 h-4" />
              {loading ? "Procesando..." : saldo > 0 ? `Confirmar reembolso de ${fmt(saldo)}`
                : saldo < 0 ? `Cobrar ${fmt(Math.abs(saldo))} al cliente`
                : "Confirmar cambio exacto"}
            </button>
          )}
        </div>
      )}

      {/* PANTALLA CONFIRMADO */}
      {screen === "confirmado" && confirmData && (
        <div className="text-center py-8">
          <div className={`w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4 ${
            confirmData.tipo === "REFUND" ? "bg-green-100 dark:bg-green-900/30" : "bg-blue-100 dark:bg-blue-900/30"
          }`}>
            <Check className={`w-7 h-7 ${confirmData.tipo === "REFUND" ? "text-green-700 dark:text-green-400" : "text-blue-700 dark:text-blue-400"}`} />
          </div>
          <h2 className="text-lg font-medium">{confirmData.title}</h2>
          <p className="text-sm text-muted-foreground mt-1">{confirmData.sub}</p>
          <div className="bg-elevated rounded-xl p-4 mt-4 text-left">
            <p className="text-sm font-medium mb-2">Resumen</p>
            <pre className="text-xs text-muted-foreground whitespace-pre-wrap leading-loose font-sans">{confirmData.detail}</pre>
          </div>
          <div className="flex gap-3 justify-center mt-5">
            <button className="flex items-center gap-2 px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted/50">
              <History className="w-4 h-4" /> Ver historial
            </button>
            <button onClick={nuevaDevolucion}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 transition-colors text-white rounded-lg font-medium">
              <Plus className="w-4 h-4" /> Nueva devolución
            </button>
          </div>
        </div>
      )}

      {/* MODAL DE PAGO */}
      <Modal isOpen={isPaymentModalOpen} onClose={() => setIsPaymentModalOpen(false)} size="md" placement="center">
        <ModalContent className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/10 shadow-2xl">
          <ModalHeader className="border-b border-gray-100 dark:border-white/5 pb-4">
            <div className="flex flex-col gap-1">
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">Confirmar Devolución</h2>
              <p className="text-sm font-medium text-gray-500">
                {saldo > 0 ? "Reembolso o Saldo a Favor" : saldo < 0 ? "Cobro Adicional" : "Cambio Exacto"}
              </p>
            </div>
          </ModalHeader>
          <ModalBody className="py-6">
            <div className="flex flex-col gap-6">
              <div className="bg-gray-50 dark:bg-zinc-800/50 rounded-2xl p-4 flex flex-col items-center justify-center border border-gray-100 dark:border-white/5">
                <span className="text-sm font-bold tracking-widest text-gray-400 uppercase mb-1">
                  {saldo > 0 ? "A ENTREGAR AL CLIENTE" : saldo < 0 ? "TOTAL A COBRAR" : "SALDO"}
                </span>
                <span className={`text-4xl font-black tabular-nums tracking-tighter ${saldo > 0 ? "text-amber-500" : saldo < 0 ? "text-emerald-500" : "text-gray-900 dark:text-white"}`}>
                  {saldo !== 0 ? fmt(Math.abs(saldo)) : "$0"}
                </span>
              </div>

              {saldo < 0 && (
                <div className="flex flex-col gap-3">
                  <label className="text-xs font-bold uppercase tracking-wider text-gray-500">
                    Método de Pago del Excedente
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setChargeMethod("EFECTIVO")}
                      className={`flex flex-col items-center justify-center p-3 rounded-xl border-2 transition-all ${
                        chargeMethod === "EFECTIVO"
                          ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                          : "border-gray-200 dark:border-white/5 text-gray-500 hover:border-emerald-500/50"
                      }`}
                    >
                      <Banknote className="w-6 h-6 mb-2" />
                      <span className="text-xs font-bold tracking-tight">EFECTIVO</span>
                    </button>
                    
                    <button
                      onClick={() => setChargeMethod("TRANSFERENCIA")}
                      className={`flex flex-col items-center justify-center p-3 rounded-xl border-2 transition-all ${
                        chargeMethod === "TRANSFERENCIA"
                          ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                          : "border-gray-200 dark:border-white/5 text-gray-500 hover:border-emerald-500/50"
                      }`}
                    >
                      <CreditCard className="w-6 h-6 mb-2" />
                      <span className="text-xs font-bold tracking-tight">BANCOLOMBIA</span>
                    </button>

                    <button
                      onClick={() => setChargeMethod("NEQUI")}
                      className={`flex flex-col items-center justify-center p-3 rounded-xl border-2 transition-all ${
                        chargeMethod === "NEQUI"
                          ? "border-purple-500 bg-purple-50 dark:bg-purple-500/10 text-purple-700 dark:text-purple-400"
                          : "border-gray-200 dark:border-white/5 text-gray-500 hover:border-purple-500/50"
                      }`}
                    >
                      <ShoppingCart className="w-6 h-6 mb-2" />
                      <span className="text-xs font-bold tracking-tight">NEQUI</span>
                    </button>

                    <button
                      onClick={() => setChargeMethod("DAVIPLATA")}
                      className={`flex flex-col items-center justify-center p-3 rounded-xl border-2 transition-all ${
                        chargeMethod === "DAVIPLATA"
                          ? "border-red-500 bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400"
                          : "border-gray-200 dark:border-white/5 text-gray-500 hover:border-red-500/50"
                      }`}
                    >
                      <CreditCard className="w-6 h-6 mb-2" />
                      <span className="text-xs font-bold tracking-tight">DAVIPLATA</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </ModalBody>
          <ModalFooter className="border-t border-gray-100 dark:border-white/5 pt-4">
            <Button
              className="w-full bg-emerald-500 hover:bg-emerald-600 text-white font-bold h-12 rounded-xl text-sm"
              onPress={confirmarDevolucion}
            >
              Confirmar Transacción
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

    </div>
  )
}
