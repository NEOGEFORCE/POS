"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, AlertCircle, TrendingUp, Package, Calendar, Loader2, ArrowRight, ShoppingCart } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { apiFetch } from "@/lib/api-error";
import Cookies from "js-cookie";

interface RestockStats {
  criticalItems: number;
  warnings: number;
  suppliersToday: number;
  estimatedValue: number;
}

export default function SmartRestockPage() {
  const [stats, setStats] = useState<RestockStats>({
    criticalItems: 0,
    warnings: 0,
    suppliersToday: 0,
    estimatedValue: 0
  });
  const [isLoading, setIsLoading] = useState(true);
  const [showCriticalAlert, setShowCriticalAlert] = useState(true);
  const [suggestions, setSuggestions] = useState<any[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      try {
        const token = Cookies.get("org-pos-token");
        const data = await apiFetch<any[]>("/inventory/restock/suggestions", {}, token || "");
        
        setSuggestions(data || []);
        
        let criticals = 0;
        let warnings = 0;
        let estimated = 0;
        
        (data || []).forEach(item => {
          if (item.Stock <= item.MinShelfStock) criticals++;
          else if (item.Stock <= item.MinStock) warnings++;
          estimated += (item.SuggestedQty || 0) * (item.AvgPurchasePrice || 0);
        });

        setStats({
          criticalItems: criticals,
          warnings: warnings,
          suppliersToday: 0, // Should be fetched from visits if available
          estimatedValue: estimated
        });
      } catch (err) {
        console.error("Error fetching restock data", err);
      } finally {
        setIsLoading(false);
      }
    };
    fetchData();
  }, []);

  const todayStr = new Intl.DateTimeFormat("es-CO", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      {/* HEADER */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between space-y-2 md:space-y-0">
        <div>
          <h2 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
            Smart Restock
          </h2>
          <p className="text-muted-foreground capitalize">{todayStr}</p>
        </div>
        <div className="flex items-center space-x-2">
          <Button variant="outline" className="gap-2">
            <AlertTriangle className="h-4 w-4" />
            Alertas
            {stats.criticalItems > 0 && (
              <Badge variant="destructive" className="ml-1 px-1.5 min-w-[20px]">
                {stats.criticalItems}
              </Badge>
            )}
          </Button>
          <Button className="gap-2 bg-indigo-600 hover:bg-indigo-700">
            <ShoppingCart className="h-4 w-4" />
            Lista de Compra
          </Button>
        </div>
      </div>

      {/* CRITICAL ALERT BANNER */}
      {showCriticalAlert && stats.criticalItems > 0 && (
        <Alert variant="destructive" className="border-red-500/50 bg-red-50/50 dark:bg-red-950/20 relative">
          <AlertCircle className="h-5 w-5 text-red-600" />
          <AlertTitle className="text-red-800 dark:text-red-400 font-semibold flex items-center gap-2">
            ¡Acción Requerida!
          </AlertTitle>
          <AlertDescription className="text-red-700 dark:text-red-300">
            Tienes {stats.criticalItems} productos críticos que se agotarán antes de la próxima visita de proveedor. Revisa la pestaña "Críticos".
          </AlertDescription>
          <Button 
            variant="ghost" 
            size="sm" 
            className="absolute top-2 right-2 h-6 w-6 p-0 hover:bg-red-100 dark:hover:bg-red-900/50" 
            onClick={() => setShowCriticalAlert(false)}
          >
            ×
          </Button>
        </Alert>
      )}

      {/* KPI CARDS */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Estado Crítico</CardTitle>
            <AlertCircle className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{stats.criticalItems}</div>
            <p className="text-xs text-muted-foreground mt-1 text-red-500/80">
              Stock 0 o próximo a 0
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Advertencias</CardTitle>
            <AlertTriangle className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600">{stats.warnings}</div>
            <p className="text-xs text-muted-foreground mt-1 text-amber-500/80">
              Bajo el mínimo de estante
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Proveedores Hoy</CardTitle>
            <Calendar className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{stats.suppliersToday}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Visitas programadas
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow border-indigo-200 dark:border-indigo-800 bg-indigo-50/30 dark:bg-indigo-950/20">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-indigo-700 dark:text-indigo-400">Inversión Sugerida</CardTitle>
            <TrendingUp className="h-4 w-4 text-indigo-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-indigo-700 dark:text-indigo-400">
              ${stats.estimatedValue.toLocaleString("es-CO")}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              WAC × Cantidades
            </p>
          </CardContent>
        </Card>
      </div>

      {/* TABS */}
      <Tabs defaultValue="suppliers" className="space-y-4">
        <TabsList className="bg-muted/50 p-1">
          <TabsTrigger value="suppliers" className="data-[state=active]:bg-white dark:data-[state=active]:bg-zinc-900 data-[state=active]:shadow-sm">
            Por Proveedor
          </TabsTrigger>
          <TabsTrigger value="purchase_list" className="data-[state=active]:bg-white dark:data-[state=active]:bg-zinc-900 data-[state=active]:shadow-sm">
            Lista de Compra
          </TabsTrigger>
          <TabsTrigger value="critical" className="data-[state=active]:bg-red-50 dark:data-[state=active]:bg-red-900/20 data-[state=active]:text-red-600 dark:data-[state=active]:text-red-400">
            Críticos & Alertas
          </TabsTrigger>
        </TabsList>

        <TabsContent value="suppliers" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Proveedores Sugeridos</CardTitle>
              <CardDescription>
                Basado en ventas proyectadas y stock mínimo requerido.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex h-32 items-center justify-center">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Mock Supplier Card */}
                  <div className="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden">
                    <div className="bg-muted/50 px-6 py-4 flex items-center justify-between border-b">
                      <div className="flex items-center gap-4">
                        <div className="h-10 w-10 rounded-full bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center text-blue-600 dark:text-blue-400 font-bold">
                          DP
                        </div>
                        <div>
                          <h3 className="font-semibold text-lg">Distribuidora Principal</h3>
                          <p className="text-sm text-muted-foreground">Próxima visita: Mañana, 8:00 AM</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-medium">Total Sugerido</p>
                        <p className="text-xl font-bold text-indigo-600 dark:text-indigo-400">$350,000</p>
                      </div>
                    </div>
                    <div className="p-6">
                      <div className="space-y-4">
                        {/* Mock Items */}
                        <div className="flex items-center justify-between">
                          <div className="flex-1">
                            <p className="font-medium">Coca Cola 1.5L</p>
                            <p className="text-sm text-muted-foreground">Stock actual: 2 • Min: 10</p>
                          </div>
                          <div className="flex items-center gap-4">
                            <div className="text-right mr-4">
                              <p className="text-sm text-muted-foreground">Sugerido</p>
                              <p className="font-semibold">24 UND</p>
                            </div>
                            <Button size="sm" variant="outline" className="gap-2">
                              <ShoppingCart className="h-4 w-4" />
                              Añadir
                            </Button>
                          </div>
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="flex-1">
                            <p className="font-medium">Gatorade Frutos Rojos</p>
                            <p className="text-sm text-muted-foreground">Stock actual: 0 • Min: 5</p>
                          </div>
                          <div className="flex items-center gap-4">
                            <div className="text-right mr-4">
                              <p className="text-sm text-muted-foreground">Sugerido</p>
                              <p className="font-semibold">12 UND</p>
                            </div>
                            <Button size="sm" variant="outline" className="gap-2">
                              <ShoppingCart className="h-4 w-4" />
                              Añadir
                            </Button>
                          </div>
                        </div>
                      </div>
                      <div className="mt-6 pt-4 border-t flex justify-end gap-2">
                        <Button variant="outline">Añadir Todo</Button>
                        <Button className="bg-indigo-600 hover:bg-indigo-700">Confirmar y Añadir a Lista</Button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="purchase_list" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Lista de Compra Activa</CardTitle>
                <CardDescription>
                  Revisa los productos añadidos antes de confirmar los pedidos por proveedor.
                </CardDescription>
              </div>
              <Button className="bg-green-600 hover:bg-green-700 gap-2">
                <ArrowRight className="h-4 w-4" />
                Compartir por WhatsApp
              </Button>
            </CardHeader>
            <CardContent>
              <div className="text-center p-8 text-muted-foreground border-2 border-dashed rounded-lg bg-zinc-50 dark:bg-zinc-900/50">
                <ShoppingCart className="h-10 w-10 mx-auto text-zinc-300 mb-3" />
                <p>No hay productos en la lista de compra.</p>
                <Button variant="outline" className="mt-4" onClick={() => {
                  const tabsList = document.querySelector('[value="suppliers"]') as HTMLButtonElement;
                  if(tabsList) tabsList.click();
                }}>
                  Ir a Proveedores Sugeridos
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="critical">
          <Card className="border-red-200 dark:border-red-900/50">
            <CardHeader className="bg-red-50/50 dark:bg-red-950/20 border-b border-red-100 dark:border-red-900/50">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
                <div>
                  <CardTitle className="text-red-600 dark:text-red-400">Atención Inmediata</CardTitle>
                  <CardDescription className="text-red-600/80 dark:text-red-400/80">
                    Estos productos requieren compra urgente fuera de itinerario regular.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-6">
              {isLoading ? (
                <div className="flex h-32 items-center justify-center">
                  <Loader2 className="h-8 w-8 animate-spin text-red-500" />
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 rounded-lg border border-red-100 dark:border-red-900/30 bg-white dark:bg-zinc-950">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-bold text-lg">Doritos Mega Queso 200g</p>
                        <Badge variant="destructive">Agotado</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground mt-1">
                        Stock actual: <span className="font-bold text-red-600">0</span> • Min: 15
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">Proveedor: Frito Lay (Visita en 4 días)</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right mr-4">
                        <p className="text-sm text-muted-foreground">Sugerido Urgente</p>
                        <p className="font-bold text-red-600">30 UND</p>
                      </div>
                      <Button size="sm" variant="outline" className="gap-2 border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700">
                        <ShoppingCart className="h-4 w-4" />
                        Añadir a Lista Especial
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
