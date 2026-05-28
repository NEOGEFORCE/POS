package main

import (
	"fmt"
	"os"
	"os/exec"
)

func main() {
	cmd := exec.Command("S:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe", "-h", "192.168.1.6", "-p", "5432", "-U", "postgres", "-F", "c", "-f", "test.sql", "sistemapos")
	cmd.Env = append(os.Environ(), "PGPASSWORD=123")
	out, err := cmd.CombinedOutput()
	fmt.Printf("Err: %v\nOut: %s\n", err, string(out))
}
