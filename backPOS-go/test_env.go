package main

import (
	"fmt"
	"os"

	"github.com/joho/godotenv"
)

func main() {
	godotenv.Load(".env")
	fmt.Println([]byte(os.Getenv("PG_DUMP_PATH")))
	fmt.Println(os.Getenv("PG_DUMP_PATH"))
}
