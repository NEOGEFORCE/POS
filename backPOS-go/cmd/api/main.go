package main

import (
	"log"
	"os"
	"strings"

	"backPOS-go/internal/adapters/handlers"
	"backPOS-go/internal/adapters/jobs"
	"backPOS-go/internal/adapters/middlewares"
	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/services"

	"net/http"
	"path/filepath"

	"github.com/gin-contrib/gzip"
	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
)

func main() {
	err := godotenv.Load()
	if err != nil {
		log.Println("No .env file found, relying on environment variables")
	}

	// Set Gin to release mode to avoid verbose route logging
	gin.SetMode(gin.ReleaseMode)

	// Connect to Database
	repositories.ConnectDB()

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

	// Initialize Services
	emailService := services.NewEmailService()
	printService := services.NewPrintService()
	auditService := services.NewAuditService(auditRepo)
	expectedOrderService := services.NewExpectedOrderService(expectedOrderRepo)
	telegramService := services.NewTelegramService()
	productService := services.NewProductService(productRepo, movementRepo, expectedOrderService, telegramService)
	restockService := services.NewRestockService(restockRepo)

	saleService := services.NewSaleService(saleRepo, productRepo, clientRepo, movementRepo, printService, creditRepo, telegramService)
	authService := services.NewAuthService(adminRepo, emailService, auditService)
	categoryService := services.NewCategoryService(categoryRepo)
	supplierService := services.NewSupplierService(supplierRepo)
	dashboardService := services.NewDashboardService(saleRepo, productRepo, clientRepo, expenseRepo, returnRepo, closureRepo, shiftRepo, creditRepo, categoryRepo, movementRepo, adminRepo, reportRepo)
	inventoryService := services.NewInventoryService(productRepo, saleRepo)
	clientService := services.NewClientService(clientRepo, creditRepo)
	expenseService := services.NewExpenseService(expenseRepo, supplierRepo, orderRepo, productRepo, expectedOrderService)
	adminService := services.NewAdminService(adminRepo)
	returnService := services.NewReturnService(returnRepo, productRepo, saleRepo, movementRepo)
	orderService := services.NewPurchaseOrderService(orderRepo)
	reportService := services.NewReportService(reportRepo)

	// Initialize Handlers
	productHandler := handlers.NewProductHandler(productService, inventoryService, auditService, authService)
	restockHandler := handlers.NewRestockHandler(restockService, inventoryService, telegramService)
	saleHandler := handlers.NewSaleHandler(saleService, auditService)
	authHandler := handlers.NewAuthHandler(authService)
	categoryHandler := handlers.NewCategoryHandler(categoryService, auditService)
	supplierHandler := handlers.NewSupplierHandler(supplierService, auditService)
	dashboardHandler := handlers.NewDashboardHandler(dashboardService, telegramService, auditService)
	dashboardReportHandler := handlers.NewDashboardReportHandler(dashboardService, auditService)
	clientHandler := handlers.NewClientHandler(clientService, saleRepo, auditService)
	expenseHandler := handlers.NewExpenseHandler(expenseService, auditService)
	adminHandler := handlers.NewAdminHandler(adminService, auditService, telegramService)
	returnHandler := handlers.NewReturnHandler(returnService, auditService)
	orderHandler := handlers.NewOrderHandler(inventoryService, orderService, expectedOrderService, telegramService, auditService, restockService, expenseService)
	debtHandler := handlers.NewDebtHandler(clientService, saleService, auditService)
	notificationHandler := handlers.NewNotificationHandler(telegramService)
	reportHandler := handlers.NewReportHandler(reportService)
	sseHandler := handlers.NewSSEHandler()

	// Initialize and Start Cron Jobs
	cronManager := jobs.NewCronManager(repositories.DB, telegramService, inventoryService, supplierService, orderService, expectedOrderService)
	cronManager.Start()

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
	r.Use(gzip.Gzip(gzip.DefaultCompression))
	r.Use(gin.Recovery())
	r.SetTrustedProxies(nil) // Silence proxy warning

	log.Printf("-----------------------------------------")
	log.Printf("🚀 POS PRO - SERVER STARTUP")
	log.Printf("-----------------------------------------")
	log.Printf("📡 RED: IP ESTATICA REQUERIDA (Resiliencia POS)")
	log.Printf("🔗 ACCESO: http://%s:8080 (O su IP Local)", os.Getenv("SERVER_IP"))
	log.Printf("🛠️  MODO: RESILIENCIA OFFLINE ACTIVADA")
	log.Printf("-----------------------------------------")

	// CORS Middleware - Strict Origin Policy
	// Only allow specific origins for security
	allowedOrigins := map[string]bool{
		"http://localhost:3000":     true,
		"http://127.0.0.1:3000":     true,
		"http://192.168.1.6:3000":   true,
		"http://192.168.1.21:3000":  true,
	}

	isLocalIP := func(origin string) bool {
		if origin == "" {
			return true
		}
		// Permitir localhost y 127.0.0.1 en cualquier puerto
		if strings.Contains(origin, "localhost") || strings.Contains(origin, "127.0.0.1") {
			return true
		}
		// Permitir rangos de IP privados comunes (192.168.x.x, 10.x.x.x, 172.x.x.x)
		localPatterns := []string{
			"http://192.168.",
			"http://10.",
			"http://172.",
		}
		for _, pattern := range localPatterns {
			if strings.HasPrefix(origin, pattern) {
				return true
			}
		}
		return false
	}

	r.Use(func(c *gin.Context) {
		origin := c.Request.Header.Get("Origin")

		// Check if origin is allowed
		isAllowed := allowedOrigins[origin]

		// Allow local network IPs for mobile/remote access
		if !isAllowed && isLocalIP(origin) {
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
		c.Writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
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
		// HSTS (HTTPS Strict Transport Security) - only in production
		if gin.Mode() == gin.ReleaseMode {
			c.Writer.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload")
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

	// Add a simple request logger for visibility in a professional way
	r.Use(func(c *gin.Context) {
		c.Next()
		// Only log important info or errors if needed, or leave it to standard logger
	})

	// API Routes
	api := r.Group("/api")
	{
		// Auth
		api.POST("/auth/login", authHandler.Login)
		api.POST("/auth/forgot-password", authHandler.ForgotPassword)
		api.POST("/auth/reset-password", authHandler.ResetPassword)
		api.GET("/auth/check-setup", authHandler.CheckSetup)
		api.POST("/auth/setup", authHandler.Setup)

		// Protected Routes
		protected := api.Group("/")
		protected.Use(middlewares.AuthMiddleware())
		protected.Use(middlewares.RateLimitMiddleware(100, 10)) // 100 tokens max, 10 tokens/sec refill
		{
			// Products Management (Empleados y Admin)
			productManage := protected.Group("/")
			productManage.Use(middlewares.RoleMiddleware("empleado"))
			{
				productManage.POST("/products/create-products", productHandler.Create)
				productManage.POST("/products/import-csv", productHandler.ImportCSV)
				productManage.GET("/products/export-csv", productHandler.ExportCSV)
				productManage.PUT("/products/update-products/:barcode", productHandler.Update)
				productManage.PATCH("/products/adjust/:barcode", productHandler.AdjustStock)
				productManage.POST("/products/open-bulk/:barcode", productHandler.OpenBulk)
				productManage.PATCH("/products/update-min-stock/:barcode", productHandler.UpdateMinStock)
			}

			// Products Administration (Solo Admin)
			productAdmin := protected.Group("/")
			productAdmin.Use(middlewares.RoleMiddleware("admin"))
			{
				// Expenses con vinculación a órdenes (crea egreso + recibe stock)
				productAdmin.POST("/expenses/create-linked", expenseHandler.CreateLinked)

				productAdmin.DELETE("/products/delete-products/:barcode", productHandler.Delete)
				productAdmin.POST("/products/receive-stock", productHandler.ReceiveStock)
				productAdmin.POST("/products/bulk-receive", productHandler.BulkReceive)
				productAdmin.POST("/products/fix-prices", productHandler.FixPrices)
				productAdmin.DELETE("/inventory/receive/:ref", productHandler.DeleteReception)
				productAdmin.PATCH("/inventory/receive/:ref", productHandler.EditReception)
				productAdmin.GET("/receptions/:id", productHandler.GetReception)
				productAdmin.POST("/inventory/scan-invoice", productHandler.ScanInvoice)
				productAdmin.POST("/inventory/save-alias", productHandler.SaveAlias)
				productAdmin.POST("/products/maintenance/clean-names", productHandler.SanitizeAllNames)

				// Smart Restock API
				productAdmin.GET("/inventory/restock/suggestions", restockHandler.GetSuggestions)
				productAdmin.GET("/inventory/restock/critical", restockHandler.GetCritical)
				productAdmin.GET("/inventory/restock/purchase-list", restockHandler.GetPurchaseList)
				productAdmin.POST("/inventory/restock/purchase-list", restockHandler.AddToPurchaseList)
				productAdmin.DELETE("/inventory/restock/purchase-list/:id", restockHandler.RemoveFromPurchaseList)
				productAdmin.POST("/inventory/restock/confirm", restockHandler.ConfirmOrder)

				// Carga Maestra API
				productAdmin.GET("/inventory/receive/pending", restockHandler.GetPendingOrders)
				productAdmin.GET("/inventory/receive/pending/:id", restockHandler.GetPendingOrder)
				productAdmin.GET("/inventory/receive/history", restockHandler.GetOrdersHistory)

				// Report History
				productAdmin.GET("/reports/history", reportHandler.GetHistory)
				productAdmin.POST("/reports/history", reportHandler.RecordReport)
				productAdmin.DELETE("/reports/history/:id", reportHandler.DeleteReport)
				productAdmin.GET("/reports/stats", reportHandler.GetStats)
			}

			// Products Read-Only (Empleados y Admin)
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
			protected.PUT("/sales/update-payment/:id", saleHandler.UpdatePayment)
			protected.POST("/sales/add-items/:id", saleHandler.AddItems)

			// Devoluciones
			protected.POST("/returns/create", returnHandler.Create)
			protected.GET("/returns/all", returnHandler.GetAll)
			protected.GET("/sales/returns/invoice/:ref", returnHandler.GetByInvoice)
			protected.GET("/sales/returns/blind", returnHandler.GetBlind)
			protected.POST("/sales/returns", returnHandler.ProcessReturn)

			// Expenses
			// Egresos Financieros (Gestión de Gastos Operativos)
			expenseGroup := protected.Group("/expenses")
			expenseGroup.Use(middlewares.RoleMiddleware("empleado")) // Permite listar y registrar a todos
			{
				expenseGroup.POST("/create", expenseHandler.Create)
				expenseGroup.PATCH("/settle/:id", expenseHandler.Settle)
				expenseGroup.GET("/list", expenseHandler.GetAll)

				// Acciones Administrativas (Restricción TOTAL para empleados)
				expenseAdminActions := expenseGroup.Group("/")
				expenseAdminActions.Use(middlewares.RoleMiddleware("admin"))
				{
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
				dashboard.GET("/reports/vault-audit", middlewares.RoleMiddleware("admin"), dashboardHandler.GetVaultAudit)
				dashboard.GET("/reports/global-debt", middlewares.RoleMiddleware("admin"), dashboardHandler.GetGlobalDebt)
			}

			// Admin
			adminGroup := protected.Group("/admin")
			adminGroup.Use(middlewares.RoleMiddleware("admin"))
			{
				adminGroup.GET("/users", adminHandler.GetAllEmployees)
				adminGroup.GET("/user/:dni", adminHandler.GetEmployee)
				adminGroup.POST("/register-user", adminHandler.CreateEmployee)
				adminGroup.PUT("/user/:dni", adminHandler.UpdateEmployee)
				adminGroup.DELETE("/user/:dni", adminHandler.DeleteEmployee)
				adminGroup.PATCH("/force-reset-password/:dni", adminHandler.ResetEmployeePassword)
				adminGroup.GET("/audit-logs", adminHandler.GetAuditLogs)
				adminGroup.PUT("/missing-items/status", adminHandler.UpdateMissingItemStatus)
				
				// Mantenimiento de BD (V7.0)
				adminGroup.GET("/backup", adminHandler.GenerateDatabaseBackup)
				adminGroup.POST("/backup/telegram", adminHandler.SendBackupToTelegram)
				adminGroup.POST("/purge", adminHandler.PurgeOldData)
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
			protected.POST("/inventory/shrinkage", productHandler.RegisterShrinkage)
			protected.PATCH("/inventory/products/:barcode/unlink-supplier", productHandler.UnlinkSupplier)
			protected.POST("/telegram/send-delivery-summary", orderHandler.SendDeliverySummaryToTelegram)
			protected.GET("/inventory/savings-opportunities", productHandler.GetSavingsOpportunities)

			// Expected Orders (Preventa/Pedidos Esperados)
			protected.POST("/orders/expected", orderHandler.CreateExpectedOrder)
			protected.GET("/orders/expected-today", orderHandler.GetExpectedOrdersToday)

			// Debts & Accounts Receivable
			protected.GET("/sales/debts", debtHandler.GetPendingDebts)
			protected.PUT("/sales/debts/:id/pay", debtHandler.RegisterPayment)

			// Notifications (Telegram Integration)
			protected.POST("/notifications/telegram", notificationHandler.SendTelegramPDF)
			protected.GET("/notifications/health", notificationHandler.HealthCheck)

			// REAL-TIME EVENT STREAM (Ultra-Instinto)
			protected.GET("/sse", sseHandler.Stream)
		}
	}

	healthHandler := handlers.NewHealthHandler(repositories.DB)
	r.GET("/health", healthHandler.Check)

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}

	log.Printf("✅ API Routes initialized successfully.")
	log.Printf("📡 Professional Service live on port: %s", port)
	log.Printf("-----------------------------------------")

	err = r.Run(":" + port)
	if err != nil {
		log.Fatalf("🔥 Falla fatal al arrancar el servidor: %v", err)
	}
}
func spaFallbackMiddleware(publicPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		path := c.Request.URL.Path

		// 1. Si la ruta tiene extensión (ej: .js, .css, .png), intentamos servirla
		if filepath.Ext(path) != "" {
			fullPath := filepath.Join(publicPath, path)
			if _, err := os.Stat(fullPath); err == nil {
				c.File(fullPath)
				c.Abort()
				return
			}
			c.AbortWithStatus(404)
			return
		}

		// 2. Intentar servir el archivo .html (Next.js static export)
		htmlPath := filepath.Join(publicPath, path+".html")
		if _, err := os.Stat(htmlPath); err == nil {
			c.Status(http.StatusOK)
			c.File(htmlPath)
			c.Abort()
			return
		}

		// 3. Fallback a index.html
		indexFile := filepath.Join(publicPath, "index.html")
		if _, err := os.Stat(indexFile); err == nil {
			c.Status(http.StatusOK)
			c.File(indexFile)
			c.Abort()
			return
		}

		c.AbortWithStatus(404)
	}
}
