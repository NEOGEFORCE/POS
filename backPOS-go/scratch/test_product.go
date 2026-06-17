package main

import (
	"encoding/json"
	"fmt"
	"backPOS-go/internal/core/domain/models"
)

func main() {
	p := models.Product{}
	b, _ := json.Marshal(p)
	fmt.Println(string(b))
}
