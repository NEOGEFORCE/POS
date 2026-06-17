package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func main() {
	jwtSecret := []byte("pos_secret_key_2024")

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"dni":   "1000128428",
		"role":  "SUPERADMIN",
		"name":  "SEBASTIAN",
		"exp":   time.Now().Add(time.Hour * 24).Unix(),
	})

	tokenString, err := token.SignedString(jwtSecret)
	if err != nil {
		fmt.Println("Error signing token:", err)
		return
	}

	payload := map[string]interface{}{
		"barcode":          "TEST12345",
		"productName":      "LUCKY ALASKA X10 TEST",
		"quantity":         10,
		"isWeighted":       false,
		"purchasePrice":    7083,
		"salePrice":        8500,
		"minStock":         10,
		"marginPercentage": 20,
		"categoryId":       1,
		"isActive":         true,
	}
	bodyData, _ := json.Marshal(payload)

	req, _ := http.NewRequest("POST", "http://192.168.1.6:3000/api/products/create-products", bytes.NewBuffer(bodyData))
	req.Header.Set("Authorization", "Bearer "+tokenString)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Println("Error requesting:", err)
		return
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	fmt.Println("Status:", resp.StatusCode)
	fmt.Println("Response:", string(respBody))
}
