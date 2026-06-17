package main

import (
	"fmt"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"log"
	"net/http"
	"bytes"
	"io"
	"encoding/json"
)

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	// ========== BUG 1: Test minStock update ==========
	fmt.Println("========== BUG 1: minStock Test ==========")
	
	var barcode, productName string
	var minStock float64
	db.Raw(`SELECT barcode, "productName", "minStock" FROM products WHERE barcode = '7702103833709'`).Row().Scan(&barcode, &productName, &minStock)
	fmt.Printf("BEFORE: barcode=%s name=%s minStock=%.2f\n", barcode, productName, minStock)

	// Login to get a token
	loginBody := map[string]string{"dni": "1000128428", "password": "123"}
	loginJSON, _ := json.Marshal(loginBody)
	loginResp, err := http.Post("http://localhost:3000/api/auth/login", "application/json", bytes.NewBuffer(loginJSON))
	if err != nil {
		fmt.Println("Login error:", err)
		return
	}
	defer loginResp.Body.Close()
	loginData, _ := io.ReadAll(loginResp.Body)
	fmt.Printf("Login response: status=%d body=%s\n", loginResp.StatusCode, string(loginData))
	var loginResult map[string]interface{}
	json.Unmarshal(loginData, &loginResult)
	tokenVal, ok := loginResult["token"]
	if !ok || tokenVal == nil {
		fmt.Println("❌ Login failed, no token received")
		return
	}
	token := tokenVal.(string)
	fmt.Println("Token obtained:", token[:20]+"...")

	// Call UpdateMinStock endpoint
	updateBody := map[string]float64{"minStock": 99}
	updateJSON, _ := json.Marshal(updateBody)
	req, _ := http.NewRequest("PATCH", "http://localhost:3000/api/admin/products/update-min-stock/7702103833709", bytes.NewBuffer(updateJSON))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Println("Update error:", err)
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	fmt.Printf("Update Response: status=%d body=%s\n", resp.StatusCode, string(body))

	// Check after update
	var minStock2 float64
	db.Raw(`SELECT "minStock" FROM products WHERE barcode = '7702103833709'`).Scan(&minStock2)
	fmt.Printf("AFTER: minStock=%.2f\n", minStock2)

	if minStock2 == 99 {
		fmt.Println("✅ BUG 1 FIXED: minStock updated correctly!")
		// Reset it back
		db.Exec(`UPDATE products SET "minStock" = $1 WHERE barcode = $2`, minStock, "7702103833709")
		fmt.Printf("(Reset back to %.2f)\n", minStock)
	} else {
		fmt.Printf("❌ BUG 1 STILL BROKEN: Expected minStock=99, got %.2f\n", minStock2)
	}

	// ========== BUG 2: Test confirmed order ==========
	fmt.Println("\n========== BUG 2: Confirmed Order Test ==========")

	var orderCount int64
	db.Raw(`SELECT COUNT(*) FROM confirmed_orders`).Scan(&orderCount)
	fmt.Printf("Orders BEFORE: %d\n", orderCount)

	// Call confirm endpoint
	confirmBody := map[string]interface{}{
		"supplier_id":        1,
		"expected_date":      "2026-05-27",
		"invoice_ref":        "TEST-001",
		"items": []map[string]interface{}{
			{
				"product_id": "7702103833709",
				"barcode":    "7702103833709",
				"quantity":   5,
				"unit_cost":  1000,
			},
		},
		"estimated_total":    5000,
		"real_invoice_total": 5000,
		"confirmed_by":       "TEST",
	}
	confirmJSON, _ := json.Marshal(confirmBody)
	req2, _ := http.NewRequest("POST", "http://localhost:3000/api/inventory/restock/confirm", bytes.NewBuffer(confirmJSON))
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("Authorization", "Bearer "+token)
	resp2, err := client.Do(req2)
	if err != nil {
		fmt.Println("Confirm order error:", err)
		return
	}
	defer resp2.Body.Close()
	body2, _ := io.ReadAll(resp2.Body)
	fmt.Printf("Confirm Response: status=%d body=%s\n", resp2.StatusCode, string(body2))

	var orderCount2 int64
	db.Raw(`SELECT COUNT(*) FROM confirmed_orders`).Scan(&orderCount2)
	fmt.Printf("Orders AFTER: %d\n", orderCount2)

	if orderCount2 > orderCount {
		fmt.Println("✅ BUG 2 FIXED: Order saved correctly!")
		// Clean up test order
		db.Exec(`DELETE FROM confirmed_order_items WHERE confirmed_order_id = (SELECT id FROM confirmed_orders ORDER BY confirmed_at DESC LIMIT 1)`)
		db.Exec(`DELETE FROM confirmed_orders WHERE id = (SELECT id FROM confirmed_orders ORDER BY confirmed_at DESC LIMIT 1)`)
		fmt.Println("(Test order cleaned up)")
	} else {
		fmt.Println("❌ BUG 2 STILL BROKEN: Order not saved!")
	}
}
