package main

import (
	"fmt"
	"net/http"
	"io/ioutil"
	"time"
)

func main() {
	start := time.Now()
	resp, err := http.Get("http://localhost:3000/api/auth/check-setup")
	if err != nil {
		fmt.Println("Error:", err)
		return
	}
	defer resp.Body.Close()
	
	body, _ := ioutil.ReadAll(resp.Body)
	fmt.Printf("Status: %d, Time: %v, Body Length: %d\n", resp.StatusCode, time.Since(start), len(body))
}
