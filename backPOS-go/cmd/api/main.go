package main

import (
	"log"
	"os"

	"backPOS-go/internal/adapters/handlers"
	"backPOS-go/internal/adapters/jobs"
	"backPOS-go/internal/adapters/middlewares"
	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/services"
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

	// Initialize Services
	emailService := services.NewEmailService()
	printService := services.NewPrintService()
	auditService := services.NewAuditService(auditRepo)
	productService := services.NewProductService(productRepo, movementRepo)
	saleService := services.NewSaleService(saleRepo, productRepo, clientRepo, movementRepo, printService)
	authService := services.NewAuthService(adminRepo, emailService, auditService)
	categoryService := services.NewCategoryService(categoryRepo)
	supplierService := services.NewSupplierService(supplierRepo)
	dashboardService := services.NewDashboardService(saleRepo, productRepo, clientRepo, expenseRepo, returnRepo, closureRepo, shiftRepo, creditRepo, categoryRepo, movementRepo, adminRepo)
	inventoryService := services.NewInventoryService(productRepo, saleRepo)
	clientService := services.NewClientService(clientRepo, creditRepo)
	expenseService := services.NewExpenseService(expenseRepo, supplierRepo)
	adminService := services.NewAdminService(adminRepo)
	returnService := services.NewReturnService(returnRepo, productRepo, saleRepo)
	telegramService := services.NewTelegramService()
	orderService := services.NewPurchaseOrderService(orderRepo)

	// Initialize Handlers
	productHandler := handlers.NewProductHandler(productService, inventoryService)
	saleHandler := handlers.NewSaleHandler(saleService)
	authHandler := handlers.NewAuthHandler(authService)
	categoryHandler := handlers.NewCategoryHandler(categoryService)
	supplierHandler := handlers.NewSupplierHandler(supplierService)
	dashboardHandler := handlers.NewDashboardHandler(dashboardService)
	clientHandler := handlers.NewClientHandler(clientService)
	expenseHandler := handlers.NewExpenseHandler(expenseService)
	adminHandler := handlers.NewAdminHandler(adminService, auditService)
	returnHandler := handlers.NewReturnHandler(returnService)
	orderHandler := handlers.NewOrderHandler(inventoryService, orderService)
	debtHandler := handlers.NewDebtHandler(clientService, saleService)

	// Initialize and Start Cron Jobs
	cronManager := jobs.NewCronManager(telegramService, inventoryService, supplierService, orderService)
	cronManager.Start()

	r := gin.New()
	r.Use(gin.Recovery())
	r.SetTrustedProxies(nil) // Silence proxy warning

	log.Printf("-----------------------------------------")
	log.Printf("🚀 EXECUTER POS SERVER IS STARTING...")
	log.Printf("-----------------------------------------")

	// CORS Middleware
	r.Use(func(c *gin.Context) {
		origin := c.Request.Header.Get("Origin")
		if origin == "" {
			origin = "*"
		}
		c.Writer.Header().Set("Access-Control-Allow-Origin", origin)
		c.Writer.Header().Set("Access-Control-Allow-Credentials", "true")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, accept, origin, Cache-Control, X-Requested-With")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS, GET, PUT, DELETE")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}

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
			// Products
			protected.POST("/products/create-products", productHandler.Create)
			protected.GET("/products/get-products/:barcode", productHandler.GetByBarcode)
			protected.GET("/products/all-products", productHandler.GetAll)
			protected.GET("/products/paginated", productHandler.GetAllPaginated)
			protected.PUT("/products/update-products/:barcode", productHandler.Update)
			protected.DELETE("/products/delete-products/:barcode", productHandler.Delete)
			protected.POST("/products/receive-stock", productHandler.ReceiveStock)
			protected.POST("/products/bulk-receive", productHandler.BulkReceive)
			protected.POST("/products/fix-prices", productHandler.FixPrices)
			protected.PATCH("/products/adjust/:barcode", productHandler.AdjustStock)
			protected.GET("/products/inventory", productHandler.GetInventory)

			// Categories
			protected.POST("/categories/create-categories", categoryHandler.Create)
			protected.GET("/categories/get-categories/:id", categoryHandler.GetByID)
			protected.GET("/categories/all-categories", categoryHandler.GetAll)
			protected.PUT("/categories/update-categories/:id", categoryHandler.Update)
			protected.DELETE("/categories/delete-categories/:id", categoryHandler.Delete)

			// Suppliers
			protected.POST("/suppliers/create-suppliers", supplierHandler.Create)
			protected.GET("/suppliers/get-suppliers/:id", supplierHandler.GetByID)
			protected.GET("/suppliers/all-suppliers", supplierHandler.GetAll)
			protected.PUT("/suppliers/update-suppliers/:id", supplierHandler.Update)
			protected.DELETE("/suppliers/delete-suppliers/:id", supplierHandler.Delete)

			// Clients
			protected.POST("/clients/create-client", clientHandler.Create)
			protected.GET("/clients/get-client/:dni", clientHandler.GetByDNI)
			protected.GET("/clients/all-clients", clientHandler.GetAll)
			protected.PUT("/clients/update-client/:dni", clientHandler.Update)
			protected.DELETE("/clients/delete-client/:dni", clientHandler.Delete)
			protected.POST("/clients/pay-credit", clientHandler.PayCredit)

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
			expenseGroup := protected.Group("/expenses")
			expenseGroup.Use(middlewares.RoleMiddleware("admin"))
			{
				expenseGroup.POST("/create", expenseHandler.Create)
				expenseGroup.GET("/list", expenseHandler.GetAll)
				expenseGroup.DELETE("/delete/:id", expenseHandler.Delete)
				expenseGroup.PUT("/update/:id", expenseHandler.Update)
				// detail and update can be added to handler if needed
			}

			// Dashboard
			protected.GET("/dashboard/overview", middlewares.RoleMiddleware("admin"), dashboardHandler.GetOverview)
			protected.GET("/dashboard/cashier-closure", middlewares.RoleMiddleware("empleado"), dashboardHandler.GetCashierClosure)
			protected.POST("/dashboard/cashier-closure", middlewares.RoleMiddleware("empleado"), dashboardHandler.SaveClosure)
			protected.GET("/dashboard/cashier-history", middlewares.RoleMiddleware("empleado"), dashboardHandler.GetClosuresHistory)
			protected.GET("/dashboard/reports/ranking", middlewares.RoleMiddleware("admin"), dashboardHandler.GetRankingReport)
			protected.GET("/dashboard/reports/categories", middlewares.RoleMiddleware("admin"), dashboardHandler.GetCategoryReport)
			protected.GET("/dashboard/reports/clients-vip", middlewares.RoleMiddleware("admin"), dashboardHandler.GetVIPClientsReport)
			protected.GET("/dashboard/reports/voids", middlewares.RoleMiddleware("admin"), dashboardHandler.GetVoidsReport)
			protected.GET("/dashboard/reports/pnl", middlewares.RoleMiddleware("admin"), dashboardHandler.GetPnLReport)
			protected.GET("/dashboard/reports/movements", middlewares.RoleMiddleware("admin"), dashboardHandler.GetInventoryMovements)

			// Admin
			adminGroup := protected.Group("/admin")
			adminGroup.Use(middlewares.RoleMiddleware("admin"))
			{
				adminGroup.GET("/users", adminHandler.GetAllEmployees)
				adminGroup.GET("/user/:dni", adminHandler.GetEmployee)
				adminGroup.POST("/register-user", adminHandler.CreateEmployee)
				adminGroup.PUT("/user/:dni", adminHandler.UpdateEmployee)
				adminGroup.DELETE("/user/:dni", adminHandler.DeleteEmployee)
				adminGroup.POST("/reset-password/:dni", adminHandler.ResetEmployeePassword)
				adminGroup.GET("/audit-logs", adminHandler.GetAuditLogs)
				adminGroup.PUT("/missing-items/status", adminHandler.UpdateMissingItemStatus)
			}

			// Faltantes (Accessible for all employees to report)
			protected.POST("/missing-items", adminHandler.CreateMissingItem)
			protected.GET("/missing-items", adminHandler.GetAllMissingItems)

			// Orders & Smart Restock
			protected.GET("/inventory/suggested-orders", orderHandler.GetSuggestedOrders)
			protected.POST("/inventory/orders", orderHandler.CreateOrder)
			protected.GET("/inventory/orders", orderHandler.GetAllOrders)

			// Debts & Accounts Receivable
			protected.GET("/sales/debts", debtHandler.GetPendingDebts)
			protected.PUT("/sales/debts/:id/pay", debtHandler.RegisterPayment)
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

	r.Run(":" + port)
}
