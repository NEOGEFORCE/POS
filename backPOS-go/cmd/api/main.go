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

	// Initialize Services
	emailService := services.NewEmailService()
	printService := services.NewPrintService()
	auditService := services.NewAuditService(auditRepo)
	productService := services.NewProductService(productRepo, movementRepo)
	saleService := services.NewSaleService(saleRepo, productRepo, clientRepo, movementRepo, printService, creditRepo)
	authService := services.NewAuthService(adminRepo, emailService, auditService)
	categoryService := services.NewCategoryService(categoryRepo)
	supplierService := services.NewSupplierService(supplierRepo)
	dashboardService := services.NewDashboardService(saleRepo, productRepo, clientRepo, expenseRepo, returnRepo, closureRepo, shiftRepo, creditRepo, categoryRepo, movementRepo, adminRepo)
	inventoryService := services.NewInventoryService(productRepo, saleRepo)
	clientService := services.NewClientService(clientRepo, creditRepo)
	expenseService := services.NewExpenseService(expenseRepo, supplierRepo, orderRepo, productRepo)
	adminService := services.NewAdminService(adminRepo)
	returnService := services.NewReturnService(returnRepo, productRepo, saleRepo, movementRepo)
	telegramService := services.NewTelegramService()
	orderService := services.NewPurchaseOrderService(orderRepo)
	expectedOrderService := services.NewExpectedOrderService(expectedOrderRepo)
	sseService := services.NewSSEService()
	sseService.StartHeartbeat()

	// Initialize Handlers
	productHandler := handlers.NewProductHandler(productService, inventoryService, auditService)
	saleHandler := handlers.NewSaleHandler(saleService, auditService, sseService)
	authHandler := handlers.NewAuthHandler(authService)
	categoryHandler := handlers.NewCategoryHandler(categoryService)
	supplierHandler := handlers.NewSupplierHandler(supplierService)
	dashboardHandler := handlers.NewDashboardHandler(dashboardService, telegramService, auditService)
	dashboardReportHandler := handlers.NewDashboardReportHandler(dashboardService, auditService)
	clientHandler := handlers.NewClientHandler(clientService)
	expenseHandler := handlers.NewExpenseHandler(expenseService)
	adminHandler := handlers.NewAdminHandler(adminService, auditService)
	returnHandler := handlers.NewReturnHandler(returnService)
	orderHandler := handlers.NewOrderHandler(inventoryService, orderService, expectedOrderService, telegramService)
	debtHandler := handlers.NewDebtHandler(clientService, saleService)
	notificationHandler := handlers.NewNotificationHandler(telegramService)
	sseHandler := handlers.NewSSEHandler(sseService)

	// Initialize and Start Cron Jobs
	cronManager := jobs.NewCronManager(repositories.DB, telegramService, inventoryService, supplierService, orderService)
	cronManager.Start()

	r := gin.New()
	r.Use(gzip.Gzip(gzip.DefaultCompression))
	r.Use(gin.Recovery())
	r.SetTrustedProxies(nil) // Silence proxy warning

	log.Printf("-----------------------------------------")
	log.Printf("🚀 EXECUTER POS SERVER IS STARTING...")
	log.Printf("-----------------------------------------")

	// CORS Middleware - Strict Origin Policy
	// Only allow specific origins for security
	allowedOrigins := map[string]bool{
		"http://localhost:3000":     true, // Dev frontend
		"http://localhost:9002":     true, // Alternative dev port
		"https://tudominio.com":     true, // Production domain (update as needed)
		"https://app.tudominio.com": true, // Production app subdomain
	}

	// Helper function to check if origin is a local/private IP
	isLocalIP := func(origin string) bool {
		// Allow local network IPs with port 9002 or 3000
		// Patterns: http://192.168.x.x:9002, http://10.x.x.x:9002, etc.
		localPatterns := []string{
			"http://192.168.",
			"http://10.",
			"http://172.16.", "http://172.17.", "http://172.18.", "http://172.19.",
			"http://172.20.", "http://172.21.", "http://172.22.", "http://172.23.",
			"http://172.24.", "http://172.25.", "http://172.26.", "http://172.27.",
			"http://172.28.", "http://172.29.", "http://172.30.", "http://172.31.",
			"http://127.0.0.1:",
		}
		for _, pattern := range localPatterns {
			if strings.HasPrefix(origin, pattern) {
				// Also check it ends with allowed ports
				if strings.Contains(origin, ":9002") || strings.Contains(origin, ":3000") ||
					strings.HasSuffix(origin, ":8080") || origin == pattern+"/" {
					return true
				}
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
		// Content Security Policy (basic)
		c.Writer.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' ws: wss:;")
		c.Next()
	})

	// Servir archivos estáticos (Logos para el Dashboard y Pagos)
	// Se asume que el servidor corre desde la raíz de backPOS-go
	r.Static("/logos", "../FrontPOS-main/public/logos")

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
			// Products Management (Solo Admin)
			productAdmin := protected.Group("/")
			productAdmin.Use(middlewares.RoleMiddleware("admin"))
			{
				// Expenses con vinculación a órdenes (crea egreso + recibe stock)
				productAdmin.POST("/expenses/create-linked", expenseHandler.CreateLinked)

				productAdmin.POST("/products/create-products", productHandler.Create)
				productAdmin.PUT("/products/update-products/:barcode", productHandler.Update)
				productAdmin.DELETE("/products/delete-products/:barcode", productHandler.Delete)
				productAdmin.POST("/products/receive-stock", productHandler.ReceiveStock)
				productAdmin.POST("/products/bulk-receive", productHandler.BulkReceive)
				productAdmin.POST("/products/fix-prices", productHandler.FixPrices)
				productAdmin.PATCH("/products/adjust/:barcode", productHandler.AdjustStock)
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
			protected.DELETE("/sales/delete/:id", saleHandler.Delete)
			protected.PUT("/sales/update-payment/:id", saleHandler.UpdatePayment)

			// Devoluciones
			protected.POST("/returns/create", returnHandler.Create)
			protected.GET("/returns/all", returnHandler.GetAll)

			// Expenses
			// Egresos Financieros (Gestión de Gastos Operativos)
			expenseGroup := protected.Group("/expenses")
			expenseGroup.Use(middlewares.RoleMiddleware("empleado")) // Permite listar y registrar a todos
			{
				expenseGroup.POST("/create", expenseHandler.Create)
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
				dashboard.GET("/overview", middlewares.RoleMiddleware("admin"), dashboardHandler.GetOverview)
				dashboard.GET("/cashier-closure", middlewares.RoleMiddleware("empleado"), dashboardHandler.GetCashierClosure)
				dashboard.POST("/cashier-closure/close", middlewares.RoleMiddleware("empleado"), dashboardHandler.SaveClosure)
				dashboard.POST("/telegram-report-partial", middlewares.RoleMiddleware("empleado"), dashboardHandler.SendPartialReport)
				dashboard.GET("/cashier-history", middlewares.RoleMiddleware("empleado"), dashboardHandler.GetClosuresHistory)
				
				// Analytical Reports
				dashboard.GET("/reports/ranking", middlewares.RoleMiddleware("admin"), dashboardReportHandler.GetRankingReport)
				dashboard.GET("/reports/categories", middlewares.RoleMiddleware("admin"), dashboardReportHandler.GetCategoryReport)
				dashboard.GET("/reports/clients-vip", middlewares.RoleMiddleware("admin"), dashboardReportHandler.GetVIPClientsReport)
				dashboard.GET("/reports/voids", middlewares.RoleMiddleware("admin"), dashboardReportHandler.GetVoidsReport)
				dashboard.GET("/reports/pnl", middlewares.RoleMiddleware("admin"), dashboardReportHandler.GetPnLReport)
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
			}

			// Faltantes (Accessible for all employees to report)
			protected.POST("/missing-items", adminHandler.CreateMissingItem)
			protected.GET("/missing-items", adminHandler.GetAllMissingItems)

			// Orders & Smart Restock
			protected.GET("/inventory/suggested-orders", orderHandler.GetSuggestedOrders)
			protected.GET("/inventory/global-restock", orderHandler.GetGlobalRestockSuggestions) // Radar Global
			protected.POST("/inventory/orders", orderHandler.CreateOrder)
			protected.GET("/inventory/orders", orderHandler.GetAllOrders)
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

	r.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok"})
	})

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
