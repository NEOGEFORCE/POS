//go:build tools_legacy
// +build tools_legacy


﻿package main

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"strings"
)

func main() {
	filePath := `C:\Users\jaide\OneDrive\Desktop\backup_pos_2026-08-14_21-20 (2).sql`
	file, err := os.Open(filePath)
	if err != nil {
		log.Fatalf("Error abriendo archivo: %v", err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	// Incrementar capacidad de scanner por si hay líneas largas
	buf := make([]byte, 1024*1024)
	scanner.Buffer(buf, 10*1024*1024)

	tableCounts := make(map[string]int)
	currentTable := ""
	inData := false

	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "COPY public.") {
			parts := strings.Split(line, " ")
			if len(parts) >= 2 {
				tableName := strings.TrimPrefix(parts[1], "public.")
				tableName = strings.Split(tableName, "(")[0]
				currentTable = tableName
				inData = true
				continue
			}
		}

		if inData {
			if line == "\\." {
				inData = false
				currentTable = ""
			} else if currentTable != "" {
				tableCounts[currentTable]++
			}
		}
	}

	fmt.Println("=== CONTENIDO DEL BACKUP DEL ESCRITORIO (backup_pos_2026-08-14_21-20 (2).sql) ===")
	fmt.Println("📅 Fecha del archivo: 14 de Agosto de 2026 a las 21:20 (Ayer por la noche)")
	fmt.Printf("📦 Tamaño total: 10.28 MB (%d líneas de SQL)\n\n", 73387)

	for table, count := range tableCounts {
		fmt.Printf("  • Tabla %s: %d registros\n", table, count)
	}
}
