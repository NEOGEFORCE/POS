"use client"
import UniversalPaymentModal from "@/components/shared/UniversalPaymentModal"
import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Undo2, Receipt, Scan, Banknote, CreditCard, ShoppingCart, Scale, Check, Plus, Trash, History, AlertTriangle, PackageX, Barcode, ArrowLeft, ArrowRight, Search, Zap, X, ChevronLeft } from "lucide-react"
import Cookies from "js-cookie"
import { apiFetch } from "@/lib/api-error"
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Card, CardBody, Input, Table, TableHeader, TableBody, TableColumn, TableRow, TableCell } from "@heroui/react"

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
  const [isHistoryOpen, setIsHistoryOpen] = useState(false)
  const [historyItems, setHistoryItems] = useState<any[]>([])
  const [isHistoryLoading, setIsHistoryLoading] = useState(false)
  const router = useRouter()
  const [userRole, setUserRole] = useState("")

  useEffect(() => {
    const uc = Cookies.get("org-pos-user")
    if (uc) {
      try { setUserRole(JSON.parse(uc).role) } catch(e){}
    }
  }, [])

  const openHistory = async () => {
    setIsHistoryOpen(true)
    setIsHistoryLoading(true)
    try {
      const token = Cookies.get("org-pos-token") || ""
      const data = await apiFetch<any[]>("/returns/all", {}, token)
      setHistoryItems(data || [])
    } catch (e) {
      console.error("Error fetching history:", e)
    } finally {
      setIsHistoryLoading(false)
    }
  }

  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const confirmDelete = (id: number) => {
    setDeleteConfirmId(id)
    setDeleteError(null)
  }

  const executeDelete = async () => {
    if (deleteConfirmId === null) return;
    const id = deleteConfirmId;
    setIsHistoryLoading(true)
    try {
      const token = Cookies.get("org-pos-token") || ""
      await apiFetch(`/returns/${id}`, { method: "DELETE" }, token)
      setDeleteConfirmId(null)
      await openHistory()
    } catch (e: any) {
      setDeleteError(e.message || "Error desconocido al anular devolución")
      setIsHistoryLoading(false)
    }
  }
  const [facturaInput, setFacturaInput] = useState("")
  const [recentSales, setRecentSales] = useState<Sale[]>([])
  const [currentSale, setCurrentSale] = useState<Sale | null>(null)
  const [returnItems, setReturnItems] = useState<ReturnItem[]>([])
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



  const totalDev = returnItems.reduce((s, i) => s + i.qty * i.unitPrice, 0)

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
    } catch (e: any) {
      console.error(e);
      alert(e.message || "Factura no encontrada");
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



  const procesarDevolucion = async () => {
    const isTransferencia = currentSale && currentSale.paymentMethod !== "EFECTIVO" && currentSale.paymentMethod !== "CAJA"
    if (isTransferencia && totalDev > 0) {
      alert("Este pago no fue en efectivo. El cliente no puede recibir dinero de la caja. Utilice 'Ir a Ventas para Cambio'.")
      return
    }
    confirmarDevolucion()
  }

  const irAVentasParaCambio = () => {
    const items = returnItems.filter(i => i.qty > 0)
    if (items.length === 0) return
    localStorage.setItem("pos-pending-return", JSON.stringify({
      saleId: currentSale?.id || 0,
      totalDev: totalDev,
      items: items
    }))
    router.push("/sales/new")
  }

  const confirmarDevolucion = async () => {
    setIsPaymentModalOpen(false)
    const tipo = "REFUND"
    setLoading(true)
    try {
      const payload = {
        invoiceRef: Number(currentSale?.id || 0),
        type: tipo,
        refundAmount: totalDev,
        chargeAmount: 0,
        returnedItems: returnItems.filter(i => i.qty > 0).map(i => ({ barcode: i.barcode, qty: Number(i.qty) })),
        replacementItems: [],
        chargeMethod: ""
      }
      const data = await apiFetch<any>("/sales/returns", {
        method: "POST",
        body: JSON.stringify(payload)
      }, token)

      setConfirmData({
        title: "Reembolso procesado",
        sub: "El dinero fue descontado de caja",
        detail: `ID: ${data.id}\nFactura origen: ${currentSale?.id}\nValor devuelto: ${fmt(data.totalReturned)}`,
        tipo: data.type
      })
      setScreen("confirmado")
    } catch (e: any) {
      alert("Error procesando: " + e.message)
    } finally {
      setLoading(false)
    }
  }

  const nuevaDevolucion = () => {
    setScreen("busqueda")
    setFacturaInput("")
    setCiegoInput("")
    setCurrentSale(null)
    setReturnItems([])
    setConfirmData(null)
  }

  const isTransferencia = currentSale && currentSale.paymentMethod !== "EFECTIVO" && currentSale.paymentMethod !== "CAJA"
  const refundBloqueado = isTransferencia && totalDev > 0

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-6 w-full animate-in fade-in duration-500">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-zinc-900 dark:bg-white text-white dark:text-black rounded-2xl flex items-center justify-center shadow-lg">
            <Undo2 size={24} strokeWidth={2.5} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white tracking-tight leading-tight">Gestión de Devoluciones</h1>
            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Procesa reembolsos y cambios de productos</p>
          </div>
        </div>
        <Button 
          variant="flat" 
          onPress={openHistory}
          className="bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/20 text-gray-700 dark:text-white font-semibold rounded-xl px-5 h-12"
        >
          <History className="w-5 h-5 mr-2" /> Historial
        </Button>
      </div>

      {screen === "busqueda" && (
        <div className="grid grid-cols-1 md:grid-cols-12 gap-8">
          <div className="md:col-span-8 flex flex-col gap-6">
            <div className="flex gap-2 bg-gray-100 dark:bg-[#18181b] p-1.5 rounded-2xl border border-gray-200 dark:border-white/5 w-fit">
              <button onClick={() => setTab("factura")} className={`px-6 py-2.5 rounded-xl text-sm font-semibold transition-all ${tab === "factura" ? "bg-white dark:bg-zinc-800 text-gray-900 dark:text-white shadow-sm" : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}>Por Factura</button>
              <button onClick={() => setTab("ciego")} className={`px-6 py-2.5 rounded-xl text-sm font-semibold transition-all ${tab === "ciego" ? "bg-white dark:bg-zinc-800 text-gray-900 dark:text-white shadow-sm" : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}>Búsqueda Ciega</button>
            </div>

            {tab === "factura" && (
              <Card className="bg-white dark:bg-[#18181b] border border-gray-200 dark:border-white/5 shadow-sm rounded-3xl overflow-hidden">
                <CardBody className="p-8">
                  <div className="flex flex-col gap-2 mb-6">
                    <h2 className="text-xl font-bold text-gray-900 dark:text-white">Buscar Factura</h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400">Ingresa el ID de la factura original para procesar la devolución</p>
                  </div>
                  <div className="flex gap-3 relative">
                    <Input
                      autoFocus
                      placeholder="Ej. 12345..."
                      value={facturaInput}
                      onChange={e => setFacturaInput(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") buscarFactura() }}
                      size="lg"
                      startContent={<Search className="text-gray-400 w-5 h-5" />}
                      classNames={{ inputWrapper: "bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-2xl h-14" }}
                    />
                    <Button 
                      className="bg-zinc-900 dark:bg-white text-white dark:text-black font-semibold h-14 px-8 rounded-2xl" 
                      onPress={() => buscarFactura()} 
                      isLoading={loading}
                    >
                      BUSCAR
                    </Button>
                  </div>
                </CardBody>
              </Card>
            )}

            {tab === "ciego" && (
              <Card className="bg-white dark:bg-[#18181b] border border-gray-200 dark:border-white/5 shadow-sm rounded-3xl overflow-hidden">
                <CardBody className="p-8">
                  <div className="flex flex-col gap-2 mb-6">
                    <h2 className="text-xl font-bold text-gray-900 dark:text-white">Búsqueda Ciega</h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400">Escanea el código de barras para encontrar la factura automáticamente</p>
                  </div>
                  <div className="relative">
                    <Input
                      autoFocus
                      placeholder="Escanear producto a devolver..."
                      value={ciegoInput}
                      onChange={e => setCiegoInput(e.target.value.toUpperCase())}
                      size="lg"
                      startContent={<Barcode className="text-gray-400 w-5 h-5" />}
                      classNames={{ inputWrapper: "bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-2xl h-14" }}
                    />
                    {ciegoResults.length > 0 && (
                      <div className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/10 shadow-xl rounded-2xl overflow-hidden z-20">
                        {ciegoResults.map((pr, i) => (
                          <div key={i} onClick={() => buscarCiego(pr.barcode)}
                            className="px-4 py-3 border-b border-gray-100 dark:border-white/5 last:border-0 hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer transition-colors flex justify-between items-center group">
                            <div className="flex flex-col">
                              <span className="text-sm font-semibold text-gray-900 dark:text-white group-hover:text-rose-500 transition-colors">{pr.productName}</span>
                              <span className="text-xs text-gray-500">{pr.barcode}</span>
                            </div>
                            <Button size="sm" className="bg-rose-500 text-white font-medium rounded-xl">Seleccionar</Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </CardBody>
              </Card>
            )}
          </div>

          <div className="md:col-span-4">
            <Card className="bg-white dark:bg-[#18181b] border border-gray-200 dark:border-white/5 shadow-sm rounded-3xl h-full flex flex-col">
              <CardBody className="p-6 flex flex-col h-[400px]">
                <div className="flex items-center gap-2 mb-4">
                  <History className="w-5 h-5 text-gray-400" />
                  <h3 className="font-semibold text-gray-900 dark:text-white">Ventas Recientes</h3>
                </div>
                <div className="flex-1 overflow-y-auto pr-2 space-y-3">
                  {recentSales.map((sale) => (
                    <div key={sale.id} onClick={() => buscarFactura(sale.id.toString())}
                      className="p-4 rounded-2xl border border-gray-100 dark:border-white/5 bg-gray-50 dark:bg-zinc-900/50 hover:bg-gray-100 dark:hover:bg-zinc-800 cursor-pointer transition-all flex justify-between items-center group">
                      <div>
                        <p className="text-sm font-bold text-gray-900 dark:text-white">Fac. #{sale.id}</p>
                        <p className="text-[10px] uppercase tracking-wider text-gray-500 mt-0.5">{new Date(sale.date).toLocaleTimeString([], {hour: "2-digit", minute:"2-digit"})}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold text-emerald-600 dark:text-emerald-500">{fmt(sale.total)}</p>
                        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">{sale.paymentMethod}</p>
                      </div>
                    </div>
                  ))}
                  {recentSales.length === 0 && (
                    <div className="h-full flex flex-col items-center justify-center text-gray-400 opacity-60">
                      <Receipt className="w-8 h-8 mb-2" />
                      <p className="text-sm">Sin ventas recientes</p>
                    </div>
                  )}
                </div>
              </CardBody>
            </Card>
          </div>
        </div>
      )}
      {screen === "devolucion" && currentSale && (
        <div className="flex flex-col gap-6 w-full max-w-4xl mx-auto">
          <div className="bg-[#111113] rounded-3xl border border-white/10 overflow-hidden flex flex-col min-h-[500px] shadow-2xl relative">
            {/* HEADER */}
            <div className="flex items-center justify-between p-4 border-b border-white/5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-white">
                  <Undo2 size={18} />
                </div>
                <div>
                  <h3 className="font-bold text-white uppercase tracking-widest text-sm">Devolución / Cambio</h3>
                  <p className="text-[10px] text-zinc-400 font-medium uppercase tracking-widest">Factura #{currentSale?.id} • {currentSale?.paymentMethod}</p>
                </div>
              </div>
              <Button isIconOnly variant="light" onPress={nuevaDevolucion} className="text-zinc-400 hover:text-white">
                <X size={20} />
              </Button>
            </div>

            {/* CONTENT */}
            <div className="flex flex-1 overflow-hidden p-4 gap-4">
              
              {/* LEFT PANEL: DEVUELVE */}
              <div className="flex-1 flex flex-col bg-[#18181b] rounded-2xl border border-white/5 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-white/5">
                  <span className="text-[10px] font-bold text-zinc-300 uppercase tracking-widest">Productos que Devuelven</span>
                </div>
                <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
                  <Table removeWrapper aria-label="Productos a devolver" classNames={{
                    th: "bg-transparent text-[10px] uppercase tracking-widest text-zinc-500 font-bold border-b border-white/5",
                    td: "text-zinc-300 border-b border-white/5 text-sm",
                    tr: "hover:bg-white/5 transition-colors"
                  }}>
                    <TableHeader>
                      <TableColumn>ARTICULO</TableColumn>
                      <TableColumn className="text-center w-24">CANT</TableColumn>
                      <TableColumn className="text-right">TOTAL</TableColumn>
                    </TableHeader>
                    <TableBody>
                      {returnItems.map((item, idx) => (
                        <TableRow key={idx}>
                          <TableCell>
                            <div className="flex flex-col">
                              <span className="font-semibold">{item.productName}</span>
                              <span className="text-[10px] text-zinc-500">Max: {item.maxQty} • {fmt(item.unitPrice)}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-center gap-2 bg-black/40 rounded-lg p-1 border border-white/5">
                              <Button isIconOnly size="sm" variant="light" onPress={() => cambiarQty(idx, -1)} disabled={item.qty === 0} className="w-6 h-6 min-w-0 rounded-md text-zinc-400">
                                <span className="font-bold">-</span>
                              </Button>
                              <span className="w-4 text-center text-xs font-bold">{item.qty}</span>
                              <Button isIconOnly size="sm" variant="light" onPress={() => cambiarQty(idx, 1)} disabled={item.qty === item.maxQty} className="w-6 h-6 min-w-0 rounded-md text-zinc-400">
                                <span className="font-bold">+</span>
                              </Button>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-bold text-rose-400">
                            {fmt(item.qty * item.unitPrice)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <div className="px-4 py-3 bg-black/40 border-t border-white/5 flex justify-between items-center">
                  <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">A Favor Cliente</span>
                  <span className="text-lg font-bold text-rose-400">{fmt(totalDev)}</span>
                </div>
              </div>

            </div>

            {/* ACTION FOOTER */}
            <div className="p-4 border-t border-white/10 bg-black/20 flex items-center justify-between gap-4">
              <Button
                variant="flat"
                onPress={nuevaDevolucion}
                className="w-1/4 bg-white/5 text-zinc-400 hover:bg-white/10 font-bold uppercase tracking-widest text-[10px] h-12 rounded-xl"
              >
                <ChevronLeft size={16} className="mr-2" />
                Volver
              </Button>

              <div className="flex-1 flex flex-col items-center">
                {refundBloqueado && (
                  <span className="text-[10px] font-bold uppercase tracking-widest text-rose-500 animate-pulse">
                    ⚠️ Reembolso bloqueado (Pago fue {currentSale?.paymentMethod})
                  </span>
                )}
              </div>

              <div className="flex gap-2 w-1/2">
                <Button
                  onPress={procesarDevolucion}
                  isDisabled={loading || refundBloqueado || totalDev === 0}
                  className={`flex-1 h-12 rounded-xl font-bold text-[10px] tracking-widest uppercase transition-all ${
                    refundBloqueado || totalDev === 0
                      ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                      : "bg-rose-500/20 text-rose-400 hover:bg-rose-500/30 border border-rose-500/30"
                  }`}
                >
                  <Banknote size={16} className="mr-2" />
                  {loading ? "Procesando..." : "Devolver Dinero"}
                </Button>
                
                <Button
                  onPress={irAVentasParaCambio}
                  isDisabled={loading || totalDev === 0}
                  className={`flex-1 h-12 rounded-xl text-black font-bold text-[10px] tracking-widest uppercase transition-all ${
                    totalDev === 0
                      ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                      : "bg-emerald-500 hover:bg-emerald-400"
                  }`}
                >
                  <ShoppingCart size={16} className="mr-2" />
                  Ir a Ventas para Cambio
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PANTALLA CONFIRMADO */}
      {screen === "confirmado" && confirmData && (
        <div className="flex items-center justify-center min-h-[50vh] animate-in zoom-in-95 duration-500">
          <Card className="w-full max-w-md bg-white dark:bg-[#18181b] border border-gray-200 dark:border-white/5 shadow-2xl rounded-[2rem] overflow-hidden">
            <CardBody className="p-8 text-center flex flex-col items-center">
              <div className={`w-20 h-20 rounded-3xl flex items-center justify-center mb-6 shadow-xl -rotate-3 scale-110 border-4 border-white/50 dark:border-black/20 ${
                confirmData.tipo === "REFUND" ? "bg-emerald-500 text-white" : "bg-blue-500 text-white"
              }`}>
                <Check size={40} strokeWidth={4} />
              </div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">{confirmData.title}</h2>
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-6">{confirmData.sub}</p>
              
              <div className="w-full bg-gray-50 dark:bg-zinc-900/50 rounded-2xl p-5 text-left border border-gray-200 dark:border-white/5 mb-8">
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">Resumen de Operación</p>
                <pre className="text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-pre-wrap font-sans leading-relaxed">{confirmData.detail}</pre>
              </div>

              <div className="grid grid-cols-2 gap-3 w-full">
                <Button variant="bordered" onPress={openHistory} className="border-2 border-gray-200 dark:border-white/10 font-bold h-12 rounded-xl text-gray-700 dark:text-gray-300">
                  Historial
                </Button>
                <Button color="primary" onPress={nuevaDevolucion} className="bg-zinc-900 dark:bg-white text-white dark:text-black font-bold h-12 rounded-xl">
                  Nueva Operación
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      <UniversalPaymentModal
        isOpen={isPaymentModalOpen}
        onOpenChange={setIsPaymentModalOpen}
        title="Confirmar Devolución"
        client={null}
        totalToPay={totalDev}
        showSuccessScreen={false}
        submittingPayment={loading}
        lastChange={0}
        onPay={async (data) => {
          let chMethod = "EFECTIVO"
          if (data.transfer > 0 && data.transferSource) chMethod = data.transferSource
          else if (data.transfer > 0) chMethod = "TRANSFERENCIA"
          setChargeMethod(chMethod)
          await confirmarDevolucion()
        }}
        isRefund={true}
      />

      {/* MODAL DE HISTORIAL */}
      <Modal isOpen={isHistoryOpen} onOpenChange={setIsHistoryOpen} size="3xl" backdrop="blur" classNames={{ base: "bg-white dark:bg-[#18181b] border border-gray-200 dark:border-white/10 rounded-[2rem]", header: "border-b border-gray-100 dark:border-white/5", footer: "border-t border-gray-100 dark:border-white/5" }}>
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex flex-col gap-1 font-bold text-xl px-8 pt-8 pb-4 text-gray-900 dark:text-white">
                Registro de Devoluciones
                <p className="text-xs font-medium text-gray-500 tracking-normal mt-1">Historial de reembolsos y cambios realizados en el sistema</p>
              </ModalHeader>
              <ModalBody className="p-8 max-h-[60vh] overflow-y-auto">
                {isHistoryLoading ? (
                  <div className="flex flex-col items-center justify-center py-12">
                    <div className="w-10 h-10 border-4 border-gray-200 border-t-emerald-500 rounded-full animate-spin mb-4"></div>
                    <p className="text-sm font-medium text-gray-500">Cargando registros...</p>
                  </div>
                ) : historyItems.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-gray-400">
                    <History size={48} className="mb-4 opacity-20" />
                    <p className="text-sm font-medium">No se encontraron devoluciones.</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-4">
                    {historyItems.map((item, idx) => {
                      const returnedDetails = item.details?.filter((d: any) => !d.isExchange) || [];
                      const exchangeDetails = item.details?.filter((d: any) => d.isExchange) || [];
                      
                      const returnedCount = returnedDetails.reduce((sum: number, d: any) => sum + d.quantity, 0);
                      const exchangeCount = exchangeDetails.reduce((sum: number, d: any) => sum + d.quantity, 0);

                      const dateObj = new Date(item.date);
                      const dateStr = dateObj.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
                      const timeStr = dateObj.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

                      return (
                        <div key={idx} className="p-5 border border-gray-200 dark:border-white/5 rounded-2xl bg-gray-50 dark:bg-zinc-900/30 hover:bg-gray-100 dark:hover:bg-zinc-800/50 transition-colors">
                          <div className="flex flex-col sm:flex-row justify-between sm:items-center mb-4 gap-2">
                            <div className="flex items-center gap-3">
                              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${item.returnType === 'REFUND' ? 'bg-rose-100 text-rose-600 dark:bg-rose-500/20 dark:text-rose-400' : 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400'}`}>
                                {item.returnType === 'REFUND' ? <Undo2 size={16} /> : <ShoppingCart size={16} />}
                              </div>
                              <span className="font-bold text-gray-900 dark:text-white">OP #{item.id}</span>
                              <span className="text-xs font-semibold text-gray-500 bg-white dark:bg-zinc-900 px-2 py-1 rounded-md border border-gray-200 dark:border-white/5 shadow-sm">
                                Fac. #{item.saleId || "N/A"}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              {(userRole?.toUpperCase() === "ADMIN" || userRole?.toUpperCase() === "SUPERADMIN") && (
                                <button 
                                  onClick={() => deleteReturn(item.id)}
                                  className="text-white bg-rose-500 hover:bg-rose-600 p-1.5 rounded-lg shadow-sm transition-colors"
                                  title="Anular Devolución"
                                >
                                  <Trash size={16} />
                                </button>
                              )}
                              <span className="text-xs font-bold text-gray-600 dark:text-gray-300 bg-white dark:bg-zinc-900 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-white/5">
                                {dateStr}
                              </span>
                              <span className="text-xs font-bold text-gray-500 bg-gray-100 dark:bg-black/40 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-white/5">
                                {timeStr}
                              </span>
                            </div>
                          </div>
                          
                          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                            <div className="col-span-2 bg-white dark:bg-zinc-900 p-3 rounded-xl border border-gray-100 dark:border-white/5">
                              <p className="text-[10px] font-bold uppercase text-gray-400 tracking-widest mb-2">Productos Devueltos ({returnedCount})</p>
                              <div className="flex flex-col gap-1 max-h-20 overflow-y-auto custom-scrollbar pr-1">
                                {returnedDetails.length > 0 ? returnedDetails.map((d: any, i: number) => (
                                  <div key={i} className="flex justify-between items-center text-xs">
                                    <span className="text-gray-700 dark:text-gray-300 truncate pr-2 flex-1">• {d.product?.productName || d.barcode}</span>
                                    <span className="font-bold text-gray-900 dark:text-white bg-gray-100 dark:bg-white/5 px-1.5 py-0.5 rounded-md">x{d.quantity}</span>
                                  </div>
                                )) : <span className="text-xs text-gray-500 italic">No se registró mercancía</span>}
                              </div>
                            </div>
                            
                            <div className="bg-white dark:bg-zinc-900 p-3 rounded-xl border border-gray-100 dark:border-white/5 flex flex-col justify-between">
                              <p className="text-[10px] font-bold uppercase text-gray-400 tracking-widest mb-1">Valor Reembolsado</p>
                              <p className="font-black text-rose-600 dark:text-rose-400 text-lg">${item.totalReturned?.toLocaleString() || "0"}</p>
                            </div>
                            <div className="bg-white dark:bg-zinc-900 p-3 rounded-xl border border-gray-100 dark:border-white/5 flex flex-col justify-between">
                              <p className="text-[10px] font-bold uppercase text-gray-400 tracking-widest mb-1">Motivo / Notas</p>
                              <p className="font-semibold text-gray-700 dark:text-gray-300 text-xs leading-snug line-clamp-3" title={item.reason}>{item.reason || "Sin observaciones registradas."}</p>
                            </div>
                          </div>
                          
                          {exchangeCount > 0 && (
                            <div className="mt-3 px-3 py-2 bg-emerald-50 dark:bg-emerald-500/5 border border-emerald-100 dark:border-emerald-500/10 rounded-xl">
                              <p className="text-[10px] font-bold uppercase text-emerald-600 dark:text-emerald-500 tracking-widest mb-1">Reemplazos Entregados ({exchangeCount})</p>
                              <p className="text-xs text-emerald-700 dark:text-emerald-400 truncate">
                                {exchangeDetails.map((d: any) => `${d.quantity}x ${d.product?.productName || d.barcode}`).join(', ')}
                              </p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </ModalBody>
              <ModalFooter className="px-8 pb-8">
                <Button className="bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white font-bold px-8" onPress={onClose}>
                  Cerrar Historial
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      <Modal isOpen={deleteConfirmId !== null} onClose={() => setDeleteConfirmId(null)} placement="center" backdrop="blur" classNames={{base: "bg-white dark:bg-zinc-950 border border-gray-200 dark:border-white/10 shadow-2xl"}}>
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1 pb-0 pt-6 px-6">
            <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <AlertTriangle className="text-rose-500" size={24} />
              ¿Anular Devolución?
            </h2>
          </ModalHeader>
          <ModalBody className="py-4 px-6">
            <p className="text-gray-600 dark:text-gray-400">
              Estás a punto de anular la devolución <strong className="text-gray-900 dark:text-white">OP #{deleteConfirmId}</strong>.
              Esto revertirá todos los movimientos de inventario y registrará la anulación en el Kárdex.
            </p>
            {deleteError && (
              <div className="mt-2 p-3 bg-rose-50 dark:bg-rose-500/10 border border-rose-100 dark:border-rose-500/20 rounded-xl flex items-center gap-2">
                <Zap className="text-rose-500 shrink-0" size={16} />
                <p className="text-xs font-semibold text-rose-600 dark:text-rose-400">{deleteError}</p>
              </div>
            )}
          </ModalBody>
          <ModalFooter className="px-6 pb-6 pt-2">
            <Button variant="light" className="font-bold text-gray-500" onPress={() => setDeleteConfirmId(null)} isDisabled={isHistoryLoading}>
              Cancelar
            </Button>
            <Button color="danger" className="font-bold bg-rose-500 text-white" onPress={executeDelete} isLoading={isHistoryLoading}>
              Sí, Anular Definitivamente
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

    </div>
  )
}
