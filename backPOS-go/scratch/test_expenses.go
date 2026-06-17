package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"io/ioutil"
)

func main() {
	resp, err := http.Get("http://localhost:8080/api/expenses/list")
	if err != nil {
		fmt.Println("Error:", err)
		return
	}
	defer resp.Body.Close()
	body, _ := ioutil.ReadAll(resp.Body)
	var data []map[string]interface{}
	json.Unmarshal(body, &data)
	for _, d := range data {
		if d["category"] == "Proveedores" {
			fmt.Printf("Expense: %v, Date: %v\n", d["supplier_id"], d["date"])
		}
	}
}
