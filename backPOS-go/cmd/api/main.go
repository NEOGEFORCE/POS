package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"backPOS-go/internal/adapters/handlers"
	"backPOS-go/internal/adapters/jobs"
	"backPOS-go/internal/adapters/middlewares"
	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/services"
	"backPOS-go/internal/infrastructure/sse"
	"backPOS-go/migrations"

	"github.com/gin-contrib/gzip"
	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
)

func main() {
	// OPTIMIZACIÓN TIER 1: GARBAGE COLLECTOR
	// Cambiamos la frecuencia de limpieza del 100% (default) al 200%.
	// Esto sacrifica un poco más de RAM a cambio de ganar extrema fluidez de CPU (menos micro-cortes).
	debug.SetGCPercent(200)

	err := godotenv.Load()
	if err != nil {
		log.Println("No .env file found, relying on environment variables")
	}

	// Set Gin to release mode to avoid verbose route logging
	gin.SetMode(gin.ReleaseMode)

	// Connect to Database. El arranque normal no crea ni modifica el esquema.
	repositories.ConnectDB()

	schemaCtx, cancelSchemaCheck := context.WithTimeout(context.Background(), 15*time.Second)
	if err := migrations.VerifyCurrent(schemaCtx, repositories.DB); err != nil {
		cancelSchemaCheck()
		log.Fatalf("Database schema is not ready: %v", err)
	}
	cancelSchemaCheck()

	// Initialize Repositories
	productRepo := repositories.NewPostgresProductRepository(repositories.DB)
	saleRepo := repositories.NewPostgresSaleRepository(repositories.DB)
	adminRepo := repositories.NewPostgresAdminRepository(repositories.DB)
	categoryRepo := repositories.NewPostgresCategoryRepository(repositories.DB)
	supplierRepo := repositories.NewPostgresSupplierRepository(repositories.DB)
	clientRepo := repositories.NewPostgresClientRepository(repositories.DB)
	expenseRepo := repositories.NewPostgresExpenseRepository(repositories.DB)
	returnRepo := repositories.NewGormReturnRepository(repositories.DB)
	closureRepo := repositories.NewClosureRepository(repositories.DB)
	shiftRepo := repositories.NewActiveShiftRepository(repositories.DB)
	creditRepo := repositories.NewPostgresCreditPaymentRepository(repositories.DB)
	movementRepo := repositories.NewPostgresStockMovementRepository(repositories.DB)
	auditRepo := repositories.NewAuditRepository(repositories.DB)
	orderRepo := repositories.NewPostgresPurchaseOrderRepository(repositories.DB)
	expectedOrderRepo := repositories.NewPostgresExpectedOrderRepository(repositories.DB)
	reportRepo := repositories.NewPostgresReportRepository(repositories.DB)
	restockRepo := repositories.NewPostgresRestockRepository(repositories.DB)
	restockMetricsRepo := repositories.NewRestockMetricsRepository(repositories.DB)
	// Label/cash-drawer repository: usa las tablas creadas por la migración
	// 016. Se expone a los handlers correspondientes; mantener fuera de
	// schemaModels() para no romper el checksum de la migración 002.
	labelRepo := repositories.NewLabelRepository(repositories.DB)
	// Package barcode alias repository: usa la tabla de la migración 017.
	// Mantener fuera de schemaModels() por la misma razón que label_repo.
	packageAliasRepo := repositories.NewPackageBarcodeAliasRepository(repositories.DB)
	// Loans repository: usa las tablas creadas por la migración 019.
	// Mantener fuera de schemaModels() por la misma razón que label_repo.
	loanRepo := repositories.NewPostgresLoanRepository(repositories.DB)
	// Internal barcode repository: emite y consume reservas del namespace
	// POSINT- (migración 024). Fuera de schemaModels() para preservar el
	// checksum de la 002, igual que labelRepo y packageAliasRepo.
	internalBarcodeRepo := repositories.NewInternalBarcodeRepository(repositories.DB)
	// Cash drawer OTP repository: challenges para apertura manual del
	// cajón desde la tecla Home de /sales/new (migración 025). Fuera de
	// schemaModels() por la misma razón.
	cashDrawerOTPRepo := repositories.NewCashDrawerOTPRepository(repositories.DB)
	// QR Bold / Bre-B repository: intenciones y eventos del cobro con
	// QR estático "0 %" (migración 026). Fuera de schemaModels() por la
	// misma razón que labelRepo y cashDrawerOTPRepo.
	posQrRepo := repositories.NewQrPaymentRepository(repositories.DB)

	// Initialize Services
	emailService := services.NewEmailService()
	printService := services.NewPrintService()
	auditService := services.NewAuditService(auditRepo)
	expectedOrderService := services.NewExpectedOrderService(expectedOrderRepo)
	telegramService := services.NewTelegramService()
	productService := services.NewProductService(productRepo, movementRepo, expectedOrderService, telegramService)
	restockService := services.NewRestockService(restockRepo, supplierRepo)
	restockNightlyService := services.NewRestockNightlyService(restockMetricsRepo)

	saleService := services.NewSaleService(saleRepo, productRepo, clientRepo, movementRepo, printService, creditRepo, telegramService)
	authService := services.NewAuthService(adminRepo, emailService, auditService)
	categoryService := services.NewCategoryService(categoryRepo)
	supplierService := services.NewSupplierService(supplierRepo)
	dashboardService := services.NewDashboardService(saleRepo, productRepo, clientRepo, expenseRepo, returnRepo, closureRepo, shiftRepo, creditRepo, categoryRepo, movementRepo, adminRepo, reportRepo)
	inventoryService := services.NewInventoryService(productRepo, saleRepo)
	clientService := services.NewClientService(clientRepo, creditRepo)
	expenseService := services.NewExpenseService(expenseRepo, supplierRepo, orderRepo, productRepo, expectedOrderService, restockRepo)
	adminService := services.NewAdminService(adminRepo)
	returnService := services.NewReturnService(returnRepo, productRepo, saleRepo, movementRepo)
	orderService := services.NewPurchaseOrderService(orderRepo, supplierRepo)
	reportService := services.NewReportService(reportRepo)
	// Loans service: orquesta migración 019 (préstamos / cuotas / usos).
	// Depende de expenseRepo para que el pago de cuota cree su Expense
	// normal (status='PAID') sin tocar la lógica legacy de PRESTAMO.
	loanService := services.NewLoanService(loanRepo, expenseRepo, auditService)

	// Hub SSE dedicado al flujo QR Bold/Bre-B (migración 026): entrega
	// eventos por venta_temp_id, aislado del SSEService global.
	posQrHub := sse.NewQRHub()
	// Servicio QR Bold/Bre-B: orquesta Initiate/Stream/ConfirmManual/
	// Cancel + webhooks oficial y bridge, verificando HMAC-SHA256 y
	// token BOLD_BRIDGE_TOKEN en tiempo constante. El materializador
	// asíncrono (migración 027) se activa via WithSaleService más
	// abajo, una vez que saleService ya está construido.
	posQrService := services.NewQrPaymentService(posQrRepo, posQrHub, auditService)
	// Flujo asíncrono QR (migración 027): inyectar SaleService ya
	// construido para que el materializador use el flujo canónico de
	// venta/stock. Sin este wiring, intenciones APROBADAS no cierran
	// venta automáticamente y quedan como legacy sincrónico.
	posQrService.WithSaleService(saleService)
	// Sweeper de finalización: cada 20 s busca intenciones APROBADAS
	// cuya materialización no está cerrada y las despacha. Idempotente
	// contra reconexiones y reinicios del binario (CreateSale es
	// idempotente por ClientTxId).
	go func() {
		sweeperCtx := context.Background()
		posQrService.StartFinalizationSweeper(sweeperCtx)
	}()
	// Recuperación de PENDIENTES al arranque: la BD es autoridad; la
	// memoria sólo cachea. Si falla (BD aún sin migración 026) seguimos
	// adelante sin bloquear el startup — las rutas devolverán 500/404
	// hasta que la ventana de migración se aplique.
	go func() {
		warmCtx, cancelWarm := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancelWarm()
		if _, err := posQrService.WarmupFromDB(warmCtx); err != nil {
			log.Printf("[qr-pagos] warmup falló (ok si migración 026 aún no aplicada): %v", err)
		}
	}()

	// ExportService: PDF/Excel/CSV + nuevos reportes (rentabilidad, mermas, rotaci\u00f3n, cuadre real)
	exportService := services.NewExportService(repositories.DB, dashboardService)

	// Initialize Handlers
	productHandler := handlers.NewProductHandler(productService, inventoryService, auditService, authService).
		WithInternalBarcodeRepo(internalBarcodeRepo)
	restockHandler := handlers.NewRestockHandler(restockService, inventoryService, telegramService, restockMetricsRepo)
	restockV2Handler := handlers.NewRestockV2Handler(restockMetricsRepo, restockNightlyService)
	saleHandler := handlers.NewSaleHandler(saleService, auditService, shiftRepo)
	authHandler := handlers.NewAuthHandler(authService)
	categoryHandler := handlers.NewCategoryHandler(categoryService, auditService)
	supplierHandler := handlers.NewSupplierHandler(supplierService, auditService)
	dashboardHandler := handlers.NewDashboardHandler(dashboardService, telegramService, auditService, authService, repositories.DB)
	dashboardReportHandler := handlers.NewDashboardReportHandler(dashboardService, auditService)
	dashboardExportHandler := handlers.NewDashboardExportHandler(repositories.DB, exportService, dashboardService, telegramService, auditService)
	clientHandler := handlers.NewClientHandler(clientService, saleRepo, auditService)
	expenseHandler := handlers.NewExpenseHandler(expenseService, auditService)
	adminHandler := handlers.NewAdminHandler(adminService, auditService, telegramService)
	returnHandler := handlers.NewReturnHandler(returnService, auditService)
	orderHandler := handlers.NewOrderHandler(inventoryService, orderService, expectedOrderService, telegramService, auditService, restockService, expenseService)
	debtHandler := handlers.NewDebtHandler(clientService, saleService, auditService)
	notificationHandler := handlers.NewNotificationHandler(telegramService)
	reportHandler := handlers.NewReportHandler(reportService)
	sseHandler := handlers.NewSSEHandler()
	// Módulo de etiquetas + cajón de dinero (migración 016).
	labelHandler := handlers.NewLabelHandler(labelRepo)
	// Módulo de alias de código de paquete en recepción (migración 017).
	packageAliasHandler := handlers.NewPackageBarcodeAliasHandler(packageAliasRepo)
	// Módulo avanzado de préstamos (migración 019): dashboard, create,
	// pay-installment y control de gastos.
	loanHandler := handlers.NewLoanHandler(loanService)
	// Módulo de códigos internos POSINT- (migración 024). El handler
	// expone /api/labels/internal-codes/reserve y /:code. El CONSUMO
	// atómico vive dentro de productHandler.Create a través del repo.
	internalBarcodeHandler := handlers.NewInternalBarcodeHandler(internalBarcodeRepo)
	// Módulo OTP del cajón (migración 025). El servicio inyecta Telegram
	// como OTPTelegramSender para envío síncrono SIN encolar; el handler
	// atiende /api/cash-drawer/otp/{request,confirm}.
	cashDrawerOTPService := services.NewCashDrawerOTPService(cashDrawerOTPRepo, telegramService)
	cashDrawerOTPHandler := handlers.NewCashDrawerOTPHandler(cashDrawerOTPService)

	// Módulo de cobro QR Bold/Bre-B (migración 026). El handler atiende
	// 5 rutas POS (dentro del grupo protected) y 2 webhooks públicos
	// (fuera de protected). El SSE va por el hub dedicado posQrHub, NO
	// por el singleton global, para no filtrar eventos entre cajas.
	posQrHandler := handlers.NewPosQrHandler(posQrService, posQrRepo, posQrHub)

	// Initialize and Start Cron Jobs (orquestador durable sobre PostgreSQL)
	cronManager := jobs.NewCronManager(repositories.DB, telegramService, inventoryService, supplierService, orderService, expectedOrderService, restockService, restockNightlyService)
	orchestratorCtx, cancelOrchestratorBoot := context.WithTimeout(context.Background(), 30*time.Second)
	if err := cronManager.Start(orchestratorCtx); err != nil {
		cancelOrchestratorBoot()
		log.Fatalf("No se pudo iniciar el orquestador de jobs: %v", err)
	}
	cancelOrchestratorBoot()

	jobHandler := handlers.NewJobHandler(cronManager.Orchestrator(), auditService)

	// MEGA-SPRINT: Iniciar el bot de Telegram (Modo Escucha)
	aiBotService := services.NewAIBotService(saleRepo, productRepo, expenseRepo, restockRepo, telegramService, repositories.DB)
	telegramService.StartListener(inventoryService, saleRepo, dashboardService, productService, aiBotService)

	// Mantenimiento: Blindaje de datos existentes (Limpieza de tildes)
	go func() {
		log.Println("🧹 Iniciando limpieza de tildes en datos existentes...")
		if count, err := productService.SanitizeAllNames(); err == nil && count > 0 {
			log.Printf("✅ Limpieza automática completada: %d productos actualizados.", count)
		}
	}()

	r := gin.New()
	// NOTA: Gzip se aplica selectivamente (NO en SSE para evitar buffering).
	// Dos rutas emiten SSE: /api/sse (singleton global) y
	// /api/pos/pagos-qr/stream (hub dedicado por venta_temp_id).
	r.Use(func(c *gin.Context) {
		p := c.Request.URL.Path
		if p == "/api/sse" || p == "/api/pos/pagos-qr/stream" || p == "/api/pos/pagos-qr/caja-stream" {
			c.Next()
			return
		}
		gzip.Gzip(gzip.BestSpeed)(c)
	})
	r.Use(gin.Recovery())
	r.SetTrustedProxies(nil) // Silence proxy warning

	log.Printf("-----------------------------------------")
	log.Printf("🚀 POS PRO - SERVER STARTUP")
	log.Printf("-----------------------------------------")
	log.Printf("📡 RED: IP ESTATICA REQUERIDA (Resiliencia POS)")
	log.Printf("🔗 ACCESO: http://%s:%s (O su IP Local)", os.Getenv("SERVER_IP"), func() string {
		p := os.Getenv("PORT")
		if p == "" {
			p = "3000"
		}
		return p
	}())
	log.Printf("🛠️  MODO: RESILIENCIA OFFLINE ACTIVADA")
	log.Printf("-----------------------------------------")

	// CORS Middleware - Strict Origin Policy
	// Only allow specific origins for security
	allowedOrigins := map[string]bool{
		"http://localhost:3000":    true,
		"http://localhost:9002":    true,
		"http://127.0.0.1:3000":    true,
		"http://127.0.0.1:9002":    true,
		"http://192.168.1.6:3000":  true,
		"http://192.168.1.6:9002":  true,
		"https://192.168.1.6:9002": true,
		"http://192.168.1.21:3000": true,
		"http://192.168.1.21:9002": true,
	}

	r.Use(func(c *gin.Context) {
		origin := c.Request.Header.Get("Origin")

		// Check if origin is allowed
		isAllowed := allowedOrigins[origin]

		// Allow local network IPs for mobile/remote access
		if !isAllowed && middlewares.IsPrivateOrigin(origin) {
			isAllowed = true
		}

		// For development: if no origin header (same-origin requests), allow
		if origin == "" {
			isAllowed = true
		}

		if !isAllowed && origin != "" {
			// Log rejected origins for monitoring
			log.Printf("[CORS] Rejected request from unauthorized origin: %s", origin)
			c.AbortWithStatusJSON(403, gin.H{
				"error":  "Origin not allowed",
				"origin": origin,
			})
			return
		}

		// Set CORS headers for allowed origins
		if origin != "" {
			c.Writer.Header().Set("Access-Control-Allow-Origin", origin)
		}
		c.Writer.Header().Set("Access-Control-Allow-Credentials", "true")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, accept, origin, Cache-Control, X-Requested-With")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		c.Writer.Header().Set("Access-Control-Max-Age", "86400") // 24 hours cache for preflight

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}

		c.Next()
	})

	// Security Headers Middleware
	r.Use(func(c *gin.Context) {
		// Prevent clickjacking
		c.Writer.Header().Set("X-Frame-Options", "DENY")
		// Prevent MIME type sniffing
		c.Writer.Header().Set("X-Content-Type-Options", "nosniff")
		// XSS Protection
		c.Writer.Header().Set("X-XSS-Protection", "1; mode=block")
		// Referrer Policy
		c.Writer.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		// HSTS sólo tiene sentido cuando la solicitud realmente llegó por TLS.
		if c.Request.TLS != nil {
			c.Writer.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		// Content Security Policy (relaxed for local network and multiple ports)
		c.Writer.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src * ws: wss:;")
		c.Next()
	})

	// Servir archivos estáticos (Logos para el Dashboard y Pagos)
	// Se asume que el servidor corre desde la raíz (ej: backPOS-go o desde donde se ejecute NSSM)
	r.Static("/logos", "./out/logos")

	// Configuración de SPA Fallback
	publicPath := "./out"
	r.NoRoute(spaFallbackMiddleware(publicPath))

	// El healthcheck se construye antes del árbol de rutas porque se monta en
	// tres puntos: /health y /api/health (públicos, mínimos) y
	// /api/admin/health/details (completo, sólo admin).
	healthHandler := handlers.NewHealthHandler(repositories.DB)
	r.GET("/health", healthHandler.Check)

	// Add a simple request logger for visibility in a professional way
	r.Use(func(c *gin.Context) {
		c.Next()
		// Only log important info or errors if needed, or leave it to standard logger
	})

	// API Routes
	api := r.Group("/api")
	{
		// Healthcheck público: sólo status general y estado de la base.
		// Se registra bajo /api porque es la URL que consulta el
		// procedimiento de despliegue (desplegar_a_produccion.ps1). Antes esa
		// URL no existía y "pasaba" el chequeo sólo porque el fallback de SPA
		// devolvía index.html con 200: el deploy creía verificar salud y en
		// realidad verificaba que el servidor sirviera HTML.
		api.GET("/health", healthHandler.Check)

		// Check de instalación no valida credenciales y se consulta en cada carga.
		api.GET("/auth/check-setup", authHandler.CheckSetup)

		// Endpoints que procesan credenciales: bucket aislado por IP
		// (5 solicitudes iniciales, 5 por minuto).
		auth := api.Group("/auth")
		auth.Use(middlewares.RateLimitMiddleware(5, 5.0/60.0))
		auth.POST("/login", authHandler.Login)
		auth.POST("/forgot-password", authHandler.ForgotPassword)
		auth.POST("/reset-password", authHandler.ResetPassword)
		auth.POST("/setup", authHandler.Setup)
		// Autorización server-side de FALTANTES en cierre de caja.
		// Fix P0 (2026-10-04): reemplaza al re-login client-side del modal
		// y emite un JWT corto que SaveClosure verifica para no confiar en
		// `authorizedBy` como string libre.
		auth.POST("/verify-admin", authHandler.VerifyAdmin)

		// ================================================================
		// WEBHOOKS PÚBLICOS - QR Bold / Bre-B (migración 026)
		// ================================================================
		// Rutas PÚBLICAS, autenticadas criptográficamente:
		//   - /webhooks/bold recibe el callback oficial Bold firmado
		//     por HMAC-SHA256 con BOLD_SECRET_KEY (header
		//     X-Bold-Signature). Si la variable no está configurada,
		//     falla cerrado con 401 y loguea WARN una sola vez.
		//   - /webhooks/bold-notificacion recibe del puente MacroDroid
		//     por LAN con BOLD_BRIDGE_TOKEN en X-Bridge-Token (preferido),
		//     X-Bold-Bridge-Token o token JSON legacy.
		//
		// Rate limiter específico más estricto que el grupo auth
		// (20 tokens máx, ~20/60 tokens/sec ≈ 1 token cada 3s), apto
		// para ráfagas moderadas de reintentos de Bold y suficiente
		// para bloquear el abuso.
		webhooks := api.Group("/webhooks")
		webhooks.Use(middlewares.RateLimitMiddleware(20, 20.0/60.0))
		{
			webhooks.POST("/bold", posQrHandler.WebhookOficial)
			webhooks.POST("/bold-notificacion", posQrHandler.WebhookBridge)
		}

		// Protected Routes
		protected := api.Group("/")
		protected.Use(middlewares.AuthMiddleware())
		protected.Use(middlewares.RateLimitMiddleware(100, 10)) // 100 tokens max, 10 tokens/sec refill
		{
			// Products Management (Empleados y Admin)
			// Sólo altas y consultas. Toda edición, ajuste o borrado vive en
			// productAdmin: el dueño decidió que modificar o eliminar datos es
			// exclusivo de admin/superadmin.
			productManage := protected.Group("/")
			productManage.Use(middlewares.RoleMiddleware("empleado"))
			{
				productManage.POST("/products/create-products", productHandler.Create)
				productManage.POST("/products/import-csv", productHandler.ImportCSV)
				productManage.GET("/products/export-csv", productHandler.ExportCSV)
				productManage.GET("/products/stats", productHandler.GetStats)
				productManage.POST("/products/open-bulk/:barcode", productHandler.OpenBulk)
			}

			// Products Administration (Solo Admin)
			productAdmin := protected.Group("/")
			productAdmin.Use(middlewares.RoleMiddleware("admin"))
			{
				// Expenses con vinculación a órdenes (crea egreso + recibe stock)
				productAdmin.POST("/expenses/create-linked", expenseHandler.CreateLinked)

				// Edición y ajuste de productos: sólo admin/superadmin.
				// OJO: la pantalla de recepción usa update-products para
				// actualizar precios, así que recibir mercancía editando
				// precios requiere sesión de admin.
				productAdmin.PUT("/products/update-products/:barcode", productHandler.Update)
				productAdmin.PATCH("/products/adjust/:barcode", productHandler.AdjustStock)
				productAdmin.PATCH("/products/update-min-stock/:barcode", productHandler.UpdateMinStock)

				productAdmin.DELETE("/products/delete-products/:barcode", productHandler.Delete)
				productManage.POST("/products/receive-stock", productHandler.ReceiveStock)
				productManage.POST("/products/bulk-receive", productHandler.BulkReceive)
				productAdmin.POST("/products/fix-prices", productHandler.FixPrices)
				productAdmin.DELETE("/inventory/receive/:ref", productHandler.DeleteReception)
				productAdmin.PATCH("/inventory/receive/:ref", productHandler.EditReception)
				productAdmin.GET("/receptions/:id", productHandler.GetReception)
				productAdmin.POST("/inventory/scan-invoice", productHandler.ScanInvoice)
				productAdmin.POST("/inventory/save-alias", productHandler.SaveAlias)
				productAdmin.POST("/products/maintenance/clean-names", productHandler.SanitizeAllNames)

				// Orquestador de jobs: estado, historial y control manual.
				// Sólo admin: expone errores internos y permite disparar el
				// respaldo de la base.
				productAdmin.GET("/admin/jobs", jobHandler.List)
				productAdmin.GET("/admin/jobs/:key/history", jobHandler.History)
				productAdmin.POST("/admin/jobs/:key/run", jobHandler.RunNow)
				productAdmin.PATCH("/admin/jobs/:key/enabled", jobHandler.SetEnabled)

				// Smart Restock API v2 (Demanda Real y Pre-cálculo)
				productManage.GET("/restock/suggestions-v2", restockV2Handler.GetSuggestionsV2)
				productAdmin.POST("/admin/run-nightly-restock", restockV2Handler.TriggerManualCalculation)

				// Smart Restock API
				productManage.GET("/inventory/restock/suggestions", restockHandler.GetSuggestions)
				productManage.GET("/inventory/restock/critical", restockHandler.GetCritical)
				productManage.GET("/inventory/restock/purchase-list", restockHandler.GetPurchaseList)
				productManage.POST("/inventory/restock/purchase-list", restockHandler.AddToPurchaseList)
				productAdmin.DELETE("/inventory/restock/purchase-list/:id", restockHandler.RemoveFromPurchaseList)
				productManage.POST("/inventory/restock/confirm", restockHandler.ConfirmOrder)

				// Carga Maestra API
				productManage.GET("/inventory/receive/pending", restockHandler.GetPendingOrders)
				// Cancelar un pedido y marcarlo como recibido cambian datos ya
				// registrados: sólo admin. mark-received se registra en PUT y
				// POST con el mismo handler, así que ambos verbos deben quedar
				// restringidos o el POST sería una puerta trasera.
				productAdmin.DELETE("/inventory/receive/pending/:id", restockHandler.CancelPendingOrder)
				productAdmin.PUT("/inventory/receive/pending/:id/mark-received", restockHandler.MarkOrderAsReceived)
				productAdmin.POST("/inventory/receive/pending/:id/mark-received", restockHandler.MarkOrderAsReceived)
				productManage.GET("/inventory/receive/pending/:id", restockHandler.GetPendingOrder)
				productManage.GET("/inventory/receive/history", restockHandler.GetOrdersHistory)

				// Report History
				productAdmin.GET("/reports/history", reportHandler.GetHistory)
				productAdmin.POST("/reports/history", reportHandler.RecordReport)
				productAdmin.DELETE("/reports/history/:id", reportHandler.DeleteReport)
				productAdmin.GET("/reports/stats", reportHandler.GetStats)
			}

			// Products Read-Only (Empleados y Admin)
			protected.POST("/telegram/ticket", dashboardExportHandler.SendTicketToTelegram)
			protected.GET("/products/get-products/:barcode", productHandler.GetByBarcode)
			protected.GET("/products/all-products", productHandler.GetAll)
			protected.GET("/products/paginated", productHandler.GetAllPaginated)
			protected.GET("/products/inventory", productHandler.GetInventory)
			protected.GET("/products/compare-prices/:barcode", productHandler.GetPriceComparison)

			// Categories (Administración Taxonómica)
			categoryGroup := protected.Group("/categories")
			{
				categoryGroup.GET("/all-categories", categoryHandler.GetAll)
				categoryGroup.GET("/get-categories/:id", categoryHandler.GetByID)
				categoryGroup.POST("/create-categories", categoryHandler.Create) // Empleados pueden crear

				// Acciones de Gestión (Solo Admin/Superadmin)
				categoryAdmin := categoryGroup.Group("/")
				categoryAdmin.Use(middlewares.RoleMiddleware("admin"))
				{
					categoryAdmin.PUT("/update-categories/:id", categoryHandler.Update)
					categoryAdmin.PATCH("/update-categories/:id/margin", categoryHandler.UpdateMargin)
					categoryAdmin.DELETE("/delete-categories/:id", categoryHandler.Delete)
				}
			}

			// Suppliers (Directorio Maestro)
			supplierGroup := protected.Group("/suppliers")
			{
				supplierGroup.GET("/all-suppliers", supplierHandler.GetAll)
				supplierGroup.GET("/get-suppliers/:id", supplierHandler.GetByID)
				supplierGroup.POST("/create-suppliers", supplierHandler.Create) // Empleados pueden crear

				// Acciones de Gestión (Solo Admin/Superadmin)
				supplierAdmin := supplierGroup.Group("/")
				supplierAdmin.Use(middlewares.RoleMiddleware("admin"))
				{
					supplierAdmin.PUT("/update-suppliers/:id", supplierHandler.Update)
					supplierAdmin.DELETE("/delete-suppliers/:id", supplierHandler.Delete)
				}
			}

			// Clients (Gestión de Cartera y Directorio)
			clientGroup := protected.Group("/clients")
			{
				clientGroup.GET("/all-clients", clientHandler.GetAll)
				clientGroup.GET("/get-client/:dni", clientHandler.GetByDNI)
				clientGroup.POST("/create-client", clientHandler.Create) // Empleados pueden crear
				clientGroup.POST("/pay-credit", clientHandler.PayCredit) // Empleados pueden recibir abonos
				clientGroup.GET("/get-statement/:dni", clientHandler.GetStatement)

				// Acciones de Gestión (Solo Admin/Superadmin)
				clientAdmin := clientGroup.Group("/")
				clientAdmin.Use(middlewares.RoleMiddleware("admin"))
				{
					// Borrar o cambiar el medio de pago de un abono ya
					// registrado mueve plata en la cartera: estaban fuera de
					// este bloque y las alcanzaba cualquier sesión.
					clientAdmin.DELETE("/delete-credit-payment/:id", clientHandler.DeleteCreditPayment)
					clientAdmin.PUT("/update-credit-payment/:id", clientHandler.UpdateCreditPaymentMethod)

					clientAdmin.PUT("/update-client/:dni", clientHandler.Update)
					clientAdmin.DELETE("/delete-client/:dni", clientHandler.Delete)
				}
			}

			// Sales
			protected.POST("/sales/register", saleHandler.Create)
			protected.GET("/sales/list", saleHandler.GetAll)
			protected.GET("/sales/history", saleHandler.GetAll)
			protected.GET("/sales/history/:id", saleHandler.GetByID)
			protected.DELETE("/sales/delete/:id", middlewares.RoleMiddleware("admin"), saleHandler.Delete)
			protected.PUT("/sales/update/:id", middlewares.RoleMiddleware("admin"), saleHandler.Update)
			// Cambiar el medio de pago de una venta ya registrada altera el
			// cuadre de caja: sólo admin.
			protected.PUT("/sales/update-payment/:id", middlewares.RoleMiddleware("admin"), saleHandler.UpdatePayment)
			// Correccion acotada del medio de pago (empleado):
			// SOLO redistribuye el mismo total entre efectivo y canales de
			// transferencia; no permite cambiar total, cliente, productos ni
			// mover plata hacia/desde FIADO. La elegibilidad real
			// (venta del mismo cajero, turno activo, sin devoluciones ni
			// abonos) se valida DENTRO del servicio, no aqui — este endpoint
			// solo garantiza que el requester esta autenticado como empleado.
			//
			// Documentado como excepcion en la guia de rutas y en los tests
			// de ruta: no es una puerta trasera a UpdatePayment, es un
			// camino auditado y mucho mas estrecho.
			protected.POST("/sales/correct-payment-channel/:id", middlewares.RoleMiddleware("empleado"), saleHandler.CorrectPaymentChannel)
			protected.POST("/sales/add-items/:id", middlewares.RoleMiddleware("empleado"), saleHandler.AddItems)

			// Devoluciones: consultas para empleados; mutaciones financieras sólo admin.
			returnsRead := protected.Group("/")
			returnsRead.Use(middlewares.RoleMiddleware("empleado"))
			{
				returnsRead.GET("/returns/all", returnHandler.GetAll)
				returnsRead.GET("/sales/returns/invoice/:ref", returnHandler.GetByInvoice)
				returnsRead.GET("/sales/returns/blind", returnHandler.GetBlind)
			}
			returnsAdmin := protected.Group("/")
			returnsAdmin.Use(middlewares.RoleMiddleware("admin"))
			{
				returnsAdmin.POST("/returns/create", returnHandler.Create)
				returnsAdmin.POST("/sales/returns", returnHandler.ProcessReturn)
				returnsAdmin.DELETE("/returns/:id", returnHandler.Delete)
			}

			// Expenses
			// Egresos Financieros (Gestión de Gastos Operativos)
			expenseGroup := protected.Group("/expenses")
			expenseGroup.Use(middlewares.RoleMiddleware("empleado")) // Permite listar y registrar a todos
			{
				expenseGroup.POST("/create", expenseHandler.Create)
				expenseGroup.GET("/list", expenseHandler.GetAll)
				expenseGroup.GET("/paginated", expenseHandler.GetPaginated)

				// Acciones Administrativas (Restricción TOTAL para empleados)
				expenseAdminActions := expenseGroup.Group("/")
				expenseAdminActions.Use(middlewares.RoleMiddleware("admin"))
				{
					// Saldar una deuda la marca como pagada, y el Centro de
					// Pagos permite condonarla sin registrar salida de plata.
					// Eso no puede quedar en manos de un empleado.
					expenseAdminActions.PATCH("/settle/:id", expenseHandler.Settle)

					expenseAdminActions.DELETE("/delete/:id", expenseHandler.Delete)
					expenseAdminActions.PUT("/update/:id", expenseHandler.Update)
				}
			}

			// Dashboard
			dashboard := protected.Group("/dashboard")
			{
				dashboard.GET("/overview", middlewares.RoleMiddleware("empleado"), dashboardHandler.GetOverview)
				dashboard.POST("/adjust-initial-balance", middlewares.RoleMiddleware("admin"), dashboardHandler.AdjustInitialBalance)
				dashboard.GET("/cashier-closure", middlewares.RoleMiddleware("empleado"), dashboardHandler.GetCashierClosure)
				dashboard.POST("/cashier-closure/close", middlewares.RoleMiddleware("empleado"), dashboardHandler.SaveClosure)
				dashboard.POST("/telegram-report-partial", middlewares.RoleMiddleware("empleado"), dashboardHandler.SendPartialReport)
				dashboard.GET("/cashier-history", middlewares.RoleMiddleware("empleado"), dashboardHandler.GetClosuresHistory)
				dashboard.DELETE("/cashier-history/:id", middlewares.RoleMiddleware("admin"), dashboardHandler.DeleteClosure)
				dashboard.PUT("/cashier-history/:id", middlewares.RoleMiddleware("admin"), dashboardHandler.UpdateClosure)
				dashboard.GET("/detailed-report", middlewares.RoleMiddleware("empleado"), dashboardHandler.GetDetailedReport)

				// Analytical Reports
				dashboard.GET("/reports/ranking", middlewares.RoleMiddleware("admin"), dashboardReportHandler.GetRankingReport)
				dashboard.GET("/reports/categories", middlewares.RoleMiddleware("admin"), dashboardReportHandler.GetCategoryReport)
				dashboard.GET("/reports/clients-vip", middlewares.RoleMiddleware("admin"), dashboardReportHandler.GetVIPClientsReport)
				dashboard.GET("/reports/voids", middlewares.RoleMiddleware("admin"), dashboardReportHandler.GetVoidsReport)
				dashboard.GET("/reports/pnl", middlewares.RoleMiddleware("admin"), dashboardReportHandler.GetPnLReport)
				dashboard.GET("/reports/cashflow", middlewares.RoleMiddleware("admin"), dashboardReportHandler.GetCashFlowReport)
				dashboard.GET("/reports/movements", middlewares.RoleMiddleware("admin"), dashboardReportHandler.GetInventoryMovements)
				// Historial de recepciones agrupado (una tarjeta por RECP-xxx)
				// con nombre de proveedor ya resuelto. Lectura; alineado al
				// mismo gate admin que /reports/movements. Si se decide
				// bajarlo a 'empleado' en el futuro, no requiere cambios de
				// servicio ni DTO.
				dashboard.GET("/receptions-history", middlewares.RoleMiddleware("admin"), dashboardReportHandler.GetReceptionsHistory)
				dashboard.GET("/reports/vault-audit", middlewares.RoleMiddleware("admin"), dashboardHandler.GetVaultAudit)
				dashboard.GET("/reports/global-debt", middlewares.RoleMiddleware("admin"), dashboardHandler.GetGlobalDebt)

				// EXPORT UNIFICADO: PDF/Excel/CSV + Telegram opcional
				dashboard.GET("/reports/export", middlewares.RoleMiddleware("admin"), dashboardExportHandler.ExportReport)
				// Cuadre Real (B\u00e1lance F\u00edsico = Efectivo + Transferencias - Egresos)
				dashboard.GET("/reports/cuadre-real", middlewares.RoleMiddleware("admin"), dashboardExportHandler.GetCuadreRealRange)
				dashboard.GET("/reports/cuadre-real-day", middlewares.RoleMiddleware("admin"), dashboardExportHandler.GetCuadreRealDay)

				// Reportes estrat\u00e9gicos nuevos (JSON)
				dashboard.GET("/reports/profitability", middlewares.RoleMiddleware("admin"), dashboardExportHandler.GetProfitability)
				dashboard.GET("/reports/shrinkage", middlewares.RoleMiddleware("admin"), dashboardExportHandler.GetShrinkage)
				dashboard.GET("/reports/rotation", middlewares.RoleMiddleware("admin"), dashboardExportHandler.GetRotation)

				// Detalle ampliado de un cierre (ventas + egresos + c\u00e1lculo cuadre real)
				dashboard.GET("/cashier-history/:id/full-detail", middlewares.RoleMiddleware("empleado"), dashboardExportHandler.GetClosureFullDetail)
			}

			// Admin
			adminGroup := protected.Group("/admin")
			adminGroup.Use(middlewares.RoleMiddleware("admin"))
			{
				// Diagnóstico completo: hostname, versión de Go, sistema
				// operativo, memoria y goroutines. Antes vivía en el /health
				// público.
				adminGroup.GET("/health/details", healthHandler.CheckDetailed)
				adminGroup.GET("/users", adminHandler.GetAllEmployees)
				adminGroup.GET("/user/:dni", adminHandler.GetEmployee)
				adminGroup.POST("/register-user", adminHandler.CreateEmployee)
				adminGroup.PUT("/user/:dni", adminHandler.UpdateEmployee)
				adminGroup.DELETE("/user/:dni", adminHandler.DeleteEmployee)
				adminGroup.PATCH("/force-reset-password/:dni", adminHandler.ResetEmployeePassword)
				adminGroup.GET("/audit-logs", adminHandler.GetAuditLogs)
				adminGroup.PUT("/missing-items/status", adminHandler.UpdateMissingItemStatus)
				adminGroup.PATCH("/suppliers/:id/schedule", supplierHandler.PatchSchedule)

				// Mantenimiento de BD (V7.0)
				adminGroup.GET("/backup", adminHandler.GenerateDatabaseBackup)
				adminGroup.POST("/backup/telegram", adminHandler.SendBackupToTelegram)
				adminGroup.POST("/purge", adminHandler.PurgeOldData)

				// Arreglo 5(b): fusión de marcadores '[HISTORICO]' creados
				// por corregir_referencias.ps1. Sólo admin.
				adminGroup.POST("/products/merge-historical", productHandler.MergeHistoricalMarker)
			}

			// Faltantes (Accessible for all employees to report)
			protected.POST("/missing-items", adminHandler.CreateMissingItem)
			protected.GET("/missing-items", adminHandler.GetAllMissingItems)

			// Orders & Smart Restock
			protected.GET("/inventory/suggested-orders", orderHandler.GetSuggestedOrders)
			protected.GET("/inventory/global-restock", orderHandler.GetGlobalRestockSuggestions) // Radar Global
			protected.POST("/inventory/orders", orderHandler.CreateOrder)
			protected.GET("/inventory/orders", orderHandler.GetAllOrders)
			protected.GET("/inventory/orders/:id/items", orderHandler.GetOrderItems)
			protected.POST("/inventory/orders/dismiss", orderHandler.DismissOrder)
			protected.POST("/inventory/shrinkage", middlewares.RoleMiddleware("admin"), productHandler.RegisterShrinkage)
			// Vincular o desvincular el proveedor de un producto edita el
			// catálogo maestro y cambia los pedidos sugeridos: sólo admin.
			protected.PATCH("/inventory/products/:barcode/unlink-supplier", middlewares.RoleMiddleware("admin"), productHandler.UnlinkSupplier)
			protected.PATCH("/inventory/products/:barcode/link-supplier", middlewares.RoleMiddleware("admin"), productHandler.LinkSupplier)
			protected.POST("/telegram/send-delivery-summary", orderHandler.SendDeliverySummaryToTelegram)
			protected.GET("/inventory/savings-opportunities", productHandler.GetSavingsOpportunities)

			// Expected Orders (Preventa/Pedidos Esperados)
			protected.POST("/orders/expected", orderHandler.CreateExpectedOrder)
			protected.GET("/orders/expected-today", orderHandler.GetExpectedOrdersToday)

			// Debts & Accounts Receivable
			protected.GET("/sales/debts", debtHandler.GetPendingDebts)
			protected.PUT("/sales/debts/:id/pay", debtHandler.RegisterPayment)

			// Notifications (Telegram Integration)
			protected.POST("/notifications/telegram", middlewares.RoleMiddleware("admin"), notificationHandler.SendTelegramPDF)
			protected.POST("/notifications/telegram/text", middlewares.RoleMiddleware("admin"), notificationHandler.SendTelegramMessage)
			protected.GET("/notifications/health", notificationHandler.HealthCheck)
			// Envio de la imagen del recibo generada por el frontend (Canvas 2D
			// con la misma fuente que la impresora termica). Mantiene el
			// endpoint de texto `/telegram/ticket` para compatibilidad / fallback.
			protected.POST("/telegram/ticket-image", notificationHandler.SendTicketImageToTelegram)

			// REAL-TIME EVENT STREAM (Ultra-Instinto)
			protected.GET("/sse", sseHandler.Stream)

			// ================================================================
			// LABELS + CASH DRAWER (migración 016)
			// ================================================================
			// Las plantillas y perfiles de impresora son admin-only; la
			// consulta de códigos y la impresión están permitidas a
			// empleados; la apertura del cajón aplica la regla de negocio
			// "sin venta → requiere admin" dentro del handler.
			labels := protected.Group("/labels")
			{
				labels.GET("/sizes", labelHandler.ListSizes)
				labels.GET("/printers", labelHandler.ListPrinters)
				labels.GET("/codes/search", labelHandler.SearchCodes)
				labels.GET("/codes/resolve", labelHandler.ResolveCode)
				labels.POST("/codes", labelHandler.EnsureCode)
				labels.POST("/print-jobs", labelHandler.RecordPrint)
				// Cerrar el ciclo del print job (queued → printed|failed|
				// cancelled). Antes el status quedaba perpetuamente en
				// queued porque MarkPrintJob no estaba expuesto.
				// Fix 2026-10-04.
				labels.PATCH("/print-jobs/:id/status", labelHandler.MarkPrintJobStatus)

				// Códigos internos POSINT- (migración 024). Empleado+admin:
				// cualquier operador puede pedir una reserva desde el modal.
				// El CONSUMO ocurre al crear el producto (ver
				// productHandler.Create → InternalBarcodeRepository).
				labels.POST("/internal-codes/reserve", internalBarcodeHandler.Reserve)
				labels.GET("/internal-codes/:code", internalBarcodeHandler.GetByCode)

				labelsAdmin := labels.Group("/")
				labelsAdmin.Use(middlewares.RoleMiddleware("admin"))
				{
					labelsAdmin.POST("/sizes", labelHandler.UpsertSize)
					labelsAdmin.POST("/printers", labelHandler.UpsertPrinter)
					// Anular un código de etiqueta es destructivo:
					// solo admin. Idempotente. Fix 2026-10-04.
					labelsAdmin.POST("/codes/:code/void", labelHandler.VoidCode)
				}
			}
			// Cash drawer open: regla "sin venta → requiere admin" se
			// resuelve DENTRO del handler para que la respuesta sea 403
			// con code=CASH_DRAWER_REQUIRES_SALE_OR_ADMIN y no 401 genérico.
			protected.POST("/cash-drawer/open", labelHandler.OpenCashDrawer)

			// ================================================================
			// CASH DRAWER OTP (migración 025)
			// ================================================================
			// Flujo para apertura manual del cajón desde la tecla Home de
			// /sales/new cuando el actor NO es admin: pide OTP → Telegram
			// manda OTP → actor lo teclea → confirmación valida y audita.
			//
			// Rate limiter específico, más estricto que el grupo protegido
			// general: 5 tokens máx y 1 token cada 12s (5/60 tokens/sec),
			// alineado con el rate limiter de /auth. Suficiente para un
			// uso humano (una apertura cada varios minutos) y bloquea
			// bruteforce.
			cashDrawerOTP := protected.Group("/cash-drawer/otp")
			cashDrawerOTP.Use(middlewares.RateLimitMiddleware(5, 5.0/60.0))
			{
				cashDrawerOTP.POST("/request", cashDrawerOTPHandler.Request)
				cashDrawerOTP.POST("/confirm", cashDrawerOTPHandler.Confirm)
			}

			// ================================================================
			// POS QR BOLD / BRE-B (migración 026)
			// ================================================================
			// Rutas protegidas del flujo de cobro QR con QR estático "0 %":
			//   - POST /iniciar: crea intención PENDIENTE (TTL 5 min).
			//   - GET  /stream: SSE por venta_temp_id (Authorization:
			//     Bearer; NUNCA token en query — así lo pidió el dueño).
			//   - GET  /estado: snapshot JSON para reconexión.
			//   - POST /confirmar-manual: aprueba manual con DNI del
			//     contexto (nunca del body). Audita en audit_logs.
			//   - POST /cancelar: transita a CANCELADA.
			//
			// Rate limiter específico más estricto que el grupo general:
			// Limitador propio del grupo QR, por IP: 120 tokens de ráfaga y
			// 2 tokens/s (120/min). Antes era 20/min, y el propio POS lo
			// agotaba: el polling de la bandeja, las reconexiones SSE de
			// caja-stream y stream, y abrir y cerrar varios QR seguidos
			// devolvían 429 en /iniciar ("Demasiadas solicitudes") en
			// operación normal. Sigue por debajo del grupo protegido
			// (100 + 10/s) y todas las rutas exigen sesión y rol.
			posQr := protected.Group("/pos/pagos-qr")
			posQr.Use(middlewares.RateLimitMiddleware(120, 2))
			posQr.Use(middlewares.RoleMiddleware("empleado"))
			{
				posQr.POST("/iniciar", posQrHandler.Iniciar)
				posQr.GET("/estado", posQrHandler.Estado)
				posQr.GET("/stream", posQrHandler.Stream)
				posQr.POST("/cancelar", posQrHandler.Cancelar)
				// Flujo asíncrono (migración 027).
				posQr.POST("/encolar", posQrHandler.Encolar)
				posQr.GET("/pendientes", posQrHandler.Pendientes)
				posQr.GET("/caja-stream", posQrHandler.CajaStream)
				// Bandeja de conciliación manual (SMS reenviado desde
				// Automate que entró AMBIGUOUS/UNMATCHED).
				posQr.GET("/pagos-sin-asignar", posQrHandler.PagosSinAsignar)
				posQr.POST("/asignar", posQrHandler.Asignar)
			}
			// Confirmación manual: queda SÓLO para admin. Antes era de
			// uso del cajero; con el flujo asíncrono de la 027 el
			// cajero jamás necesita confirmar manualmente — el
			// servidor cierra la venta cuando el webhook llega. La ruta
			// se conserva como herramienta de emergencia operativa
			// auditada (BD guarda manual_confirmed_by_dni del admin).
			posQrAdmin := protected.Group("/pos/pagos-qr")
			posQrAdmin.Use(middlewares.RateLimitMiddleware(20, 20.0/60.0))
			posQrAdmin.Use(middlewares.RoleMiddleware("admin"))
			{
				posQrAdmin.POST("/confirmar-manual", posQrHandler.ConfirmarManual)
			}

			// ================================================================
			// PACKAGE BARCODE ALIAS (migración 017)
			// ================================================================
			// Alias de código de barras del PAQUETE: productos cuyo código
			// solo viene impreso en el empaque, no en cada unidad. Nunca
			// alimenta buildProductLookup de ventas; solo recepción.
			//
			// Permisos:
			//   - GET resolve: empleado+admin (consulta de solo lectura).
			//   - POST crear/actualizar: empleado+admin (parte del flujo de
			//     recepción, que ya es accesible a empleados vía
			//     /products/bulk-receive).
			//   - POST seen: empleado+admin (telemetría ligera).
			protected.GET("/inventory/package-barcode/resolve", packageAliasHandler.Resolve)
			protected.POST("/inventory/package-barcode", packageAliasHandler.Ensure)
			protected.POST("/inventory/package-barcode/seen", packageAliasHandler.MarkSeen)

			// ================================================================
			// LOANS — Módulo avanzado de préstamos (migración 019)
			// ================================================================
			// Las lecturas (list, detail, preview) están abiertas a empleado +
			// admin. Las mutaciones financieras (crear, pagar cuota, registrar
			// uso del principal, cancelar) son admin-only: mueven plata y
			// afectan "Cuentas por Pagar".
			loans := protected.Group("/loans")
			{
				loans.GET("", loanHandler.List)
				loans.GET("/:id", loanHandler.GetByID)
				// Preview NO persiste: lo exponemos a empleado para que la UI
				// pinte el cronograma antes de que el admin confirme.
				loans.POST("/preview", loanHandler.Preview)

				loansAdmin := loans.Group("/")
				loansAdmin.Use(middlewares.RoleMiddleware("admin"))
				{
					loansAdmin.POST("", loanHandler.Create)
					loansAdmin.PUT("/:id", loanHandler.Update)
					loansAdmin.POST("/:id/installments/:number/pay", loanHandler.Pay)
					loansAdmin.POST("/:id/expenses", loanHandler.RegisterExpense)
					// Pagar un egreso/deuda con la plata del préstamo. No sale
					// de ningún canal de la tienda (regla del dueño); sólo
					// descuenta del disponible del préstamo via loan_expenses.
					loansAdmin.POST("/:id/pay-expense", loanHandler.PayExpense)
					// Repara pagos eliminados antes de la traza 022. El repo sólo
					// actúa si hay una única deuda original coincidente.
					loansAdmin.POST("/:id/expenses/:usageId/reverse-orphan", loanHandler.ReverseOrphanedExpense)
					loansAdmin.DELETE("/:id", loanHandler.Delete)
				}
			}
		}
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}

	log.Printf("✅ API Routes initialized successfully.")
	log.Printf("📡 Professional Service live on port: %s", port)
	log.Printf("-----------------------------------------")

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		// WriteTimeout permanece en cero: /api/sse mantiene respuestas abiertas.
		WriteTimeout:   0,
		IdleTimeout:    2 * time.Minute,
		MaxHeaderBytes: 1 << 20,
	}

	signalContext, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	serverErrors := make(chan error, 1)
	go func() {
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case serveErr := <-serverErrors:
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			log.Fatalf("🔥 Falla fatal al arrancar el servidor: %v", serveErr)
		}
		return
	case <-signalContext.Done():
		log.Printf("🛑 Señal de cierre recibida; esperando solicitudes activas...")
	}

	shutdownContext, cancelShutdown := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelShutdown()
	if err := server.Shutdown(shutdownContext); err != nil {
		log.Printf("⚠️ Cierre HTTP excedió el tiempo límite: %v", err)
		if closeErr := server.Close(); closeErr != nil {
			log.Printf("⚠️ Error forzando el cierre HTTP: %v", closeErr)
		}
	}
	if err := cronManager.Stop(shutdownContext); err != nil {
		log.Printf("⚠️ Cierre de tareas programadas incompleto: %v", err)
	}
	telegramService.Stop()
	if sqlDB, err := repositories.DB.DB(); err == nil {
		if err := sqlDB.Close(); err != nil {
			log.Printf("⚠️ Error cerrando PostgreSQL: %v", err)
		}
	}
	log.Printf("✅ Servicio detenido de forma ordenada")
}

// resolveWithinRoot une root con el path pedido y garantiza que el resultado
// quede DENTRO de root.
//
// Dos defensas encadenadas:
//
//  1. La ruta pedida se normaliza como ruta absoluta ("/..." ) y se limpia con
//     path.Clean, que colapsa los ".." SIN poder subir por encima de "/". Así
//     "/../../.env" se convierte en "/.env" y termina buscándose dentro de la
//     carpeta servida (donde no existe) en vez de dos niveles más arriba.
//  2. Se verifica explícitamente que la ruta resultante siga bajo la raíz. Es
//     redundante con (1) en el caso común y es justamente lo que se quiere: si
//     alguna forma de entrada exótica sortea la normalización, esto la detiene.
//
// Sin nada de esto, el middleware de SPA hacía filepath.Join con la ruta cruda
// del cliente y era una primitiva de lectura arbitraria del disco del servidor.
//
// Devuelve ("", false) si la ruta escapa o no se puede resolver.
func resolveWithinRoot(root, requestPath string) (string, bool) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", false
	}

	// Los separadores de Windows en la URL también cuentan como separadores al
	// llegar al sistema de archivos.
	normalized := strings.ReplaceAll(requestPath, "\\", "/")
	if !strings.HasPrefix(normalized, "/") {
		normalized = "/" + normalized
	}
	cleaned := path.Clean(normalized)

	candidate := filepath.Join(absRoot, filepath.FromSlash(cleaned))
	absCandidate, err := filepath.Abs(candidate)
	if err != nil {
		return "", false
	}

	// La comparación lleva el separador pegado para que una carpeta hermana como
	// "out-privado" no pase por ser prefijo textual de "out".
	if absCandidate != absRoot && !strings.HasPrefix(absCandidate, absRoot+string(os.PathSeparator)) {
		return "", false
	}
	return absCandidate, true
}

// isNextRSCFetch reporta si la petición HTTP viene del router interno de
// Next.js (prefetch, streaming de React Server Components, etc.) y NO es una
// navegación de documento del navegador.
//
// Si el cliente envía cualquiera de las señales RSC conocidas, se considera
// fetch interno y hay que servirle el payload `.txt` real. Si en cambio llega
// con `Sec-Fetch-Dest: document` o un `Accept: text/html` limpio, se trata de
// un usuario que pegó la URL con `.txt` en la barra de direcciones y conviene
// redirigirlo a la ruta sin extensión para que la SPA tome el control.
func isNextRSCFetch(r *http.Request) bool {
	if strings.EqualFold(r.Header.Get("RSC"), "1") {
		return true
	}
	if r.Header.Get("Next-Router-State-Tree") != "" {
		return true
	}
	if r.Header.Get("Next-Router-Prefetch") != "" {
		return true
	}
	if dest := r.Header.Get("Sec-Fetch-Dest"); dest != "" && !strings.EqualFold(dest, "document") {
		return true
	}
	return false
}

// isDocumentNavigationForTxt decide si una GET/HEAD a un `.txt` debe tratarse
// como navegación de documento (y por tanto redirigirse). Hereda de
// isNextRSCFetch el short-circuit RSC.
func isDocumentNavigationForTxt(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	if isNextRSCFetch(r) {
		return false
	}
	if strings.EqualFold(r.Header.Get("Sec-Fetch-Dest"), "document") {
		return true
	}
	// Sin Sec-Fetch-Dest (navegador viejo, curl, telegram preview): nos
	// apoyamos en el Accept. Los fetch internos de Next piden
	// `text/x-component`; una navegación real pide `text/html` en primera
	// posición.
	accept := r.Header.Get("Accept")
	return strings.Contains(strings.ToLower(accept), "text/html")
}

func spaFallbackMiddleware(publicPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		path := c.Request.URL.Path

		// 0. Una ruta de API que llegó hasta acá NO existe (o el verbo es el
		// equivocado). Devolver index.html con 200 hacía que cualquier
		// diagnóstico arrancara mintiendo: el cliente veía éxito y un cuerpo
		// HTML donde esperaba JSON.
		if strings.HasPrefix(path, "/api/") || path == "/api" {
			c.AbortWithStatusJSON(http.StatusNotFound, gin.H{
				"success": false,
				"message": "Ruta de API no encontrada",
				"error": gin.H{
					"code":    "ERR_NOT_FOUND",
					"message": "Ruta de API no encontrada",
				},
			})
			return
		}

		// 0.5 Payloads `.txt` de Next: cuando un humano navega directamente a
		// `/dashboard.txt` (document request, Accept text/html) el navegador
		// muestra texto plano o pide descargarlo. Redirigimos TEMPORARIAMENTE a
		// la ruta sin extensión para que la SPA tome el control. Los fetch
		// internos del router (RSC, prefetch) deben seguir recibiendo el
		// archivo real.
		if strings.HasSuffix(path, ".txt") && isDocumentNavigationForTxt(c.Request) {
			target := strings.TrimSuffix(path, ".txt")
			if target == "" {
				target = "/"
			}
			if raw := c.Request.URL.RawQuery; raw != "" {
				target += "?" + raw
			}
			c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
			c.Header("Pragma", "no-cache")
			c.Header("Expires", "0")
			c.Redirect(http.StatusTemporaryRedirect, target)
			c.Abort()
			return
		}

		// 1. Si la ruta tiene extensión (ej: .js, .css, .png), intentamos servirla
		if filepath.Ext(path) != "" {
			fullPath, ok := resolveWithinRoot(publicPath, path)
			if !ok {
				c.AbortWithStatus(http.StatusNotFound)
				return
			}
			if info, err := os.Stat(fullPath); err == nil && !info.IsDir() {
				// Cacheo a largo plazo para assets estaticos generados por Next.js
				if filepath.Ext(path) == ".js" || filepath.Ext(path) == ".css" {
					c.Header("Cache-Control", "public, max-age=31536000, immutable")
				}
				c.File(fullPath)
				c.Abort()
				return
			}
			c.AbortWithStatus(http.StatusNotFound)
			return
		}

		// Prevenir el cacheo de los archivos HTML generados estáticamente para evitar "Application error" por chunks obsoletos
		c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
		c.Header("Pragma", "no-cache")
		c.Header("Expires", "0")

		// 2. Intentar servir el archivo .html (Next.js static export)
		if htmlPath, ok := resolveWithinRoot(publicPath, path+".html"); ok {
			if info, err := os.Stat(htmlPath); err == nil && !info.IsDir() {
				c.Status(http.StatusOK)
				c.File(htmlPath)
				c.Abort()
				return
			}
		}

		// 3. Fallback a index.html
		indexFile := filepath.Join(publicPath, "index.html")
		if _, err := os.Stat(indexFile); err == nil {
			c.Status(http.StatusOK)
			c.File(indexFile)
			c.Abort()
			return
		}

		c.AbortWithStatus(http.StatusNotFound)
	}
}
