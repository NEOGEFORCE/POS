//go:build tools_legacy
// +build tools_legacy


﻿package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

func main() {
	today := time.Now().Format("2006-01-02")
	fmt.Printf("=== BUSCANDO RASTROS Y ARCHIVOS DEL DÍA DE HOY (%s) ===\n", today)

	var filesFound []string

	rootDirs := []string{
		`C:\Users\jaide\OneDrive\Desktop\POS`,
		`C:\Users\jaide\.gemini\antigravity\brain`,
	}

	for _, dir := range rootDirs {
		_ = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return nil
			}

			if info.ModTime().Format("2006-01-02") == today {
				filesFound = append(filesFound, fmt.Sprintf("%s (modificado: %s)", path, info.ModTime().Format("15:04:05")))
			}
			return nil
		})
	}

	fmt.Printf("Encontrados %d archivos modificados hoy:\n", len(filesFound))
	for i, f := range filesFound {
		if i < 30 {
			fmt.Println(" -", f)
		}
	}
}
