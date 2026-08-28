//go:build tools_legacy
// +build tools_legacy


﻿package main

import (
	"fmt"
	"os/exec"
)

func main() {
	cmd := exec.Command("powershell", "-Command", "Get-WmiObject Win32_SerialPort | Select-Object DeviceID, Name, Description")
	out, err := cmd.CombinedOutput()
	if err != nil {
		fmt.Println("No se encontraron puertos COM activos en este momento.")
		return
	}
	fmt.Println("=== PUERTOS COM ENCONTRADOS EN ESTE EQUIPO ===")
	fmt.Println(string(out))
}
