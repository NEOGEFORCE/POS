package services

import (
	"os"
	"strings"
	"testing"
)

// ============================================================================
// GUARDIAN: NINGUNA ETIQUETA IMPRESA PUEDE SALIR DOBLE-CODIFICADA
// ============================================================================
//
// Bug reportado por el dueño el 2026-09-04: en el PDF aparecía
// "PAGO DE N?MINA" con la O acentuada rota.
//
// CAUSA: no era el PDF, era el CODIGO FUENTE. El literal de retorno de
// extractConsolidatedConcept estaba escrito con la tilde doble-codificada
// (los bytes UTF-8 de "Ó" guardados como si fueran latin-1). El traductor de
// gofpdf lo imprimía fielmente tal como estaba escrito.
//
// Es la trampa de codificación que ya está documentada en la memoria del
// proyecto: editar estos archivos con herramientas que leen UTF-8 como ANSI
// corrompe los acentos de forma permanente.
//
// REGLA: los textos que se IMPRIMEN en el PDF van sin tildes, igual que el
// resto del reporte ("Descripcion", "Denominacion", "AUDITORIA"). Las
// comparaciones SI pueden conservar variantes con tildes o mal codificadas,
// porque tienen que reconocer lo que ya está guardado en la base.

// mojibakePrefix es el byte que delata UTF-8 leído como latin-1.
const mojibakePrefix = "\u00c3"

func TestConceptosImpresosNoSalenDobleCodificados(t *testing.T) {
	// Se prueba la función real, no el fuente: lo que importa es lo que sale.
	casos := []struct {
		desc, cat string
	}{
		{"PAGO DE NOMINA", "Nomina"},
		{"NOMINA AGOSTO", ""},
		{"", "NOMINA"},
		{"PAGO DE PROVEEDOR - PLAZA", "Proveedores"},
		{"RECEPCION DE MERCANCIA - BIMBO", "Proveedores"},
		{"CUOTA BANCO", "Otros Gastos"},
		{"ALMUERZO", ""},
	}

	for _, c := range casos {
		got := extractConsolidatedConcept(c.desc, c.cat)
		if strings.Contains(got, mojibakePrefix) {
			t.Errorf("extractConsolidatedConcept(%q, %q) = %q; sale doble-codificado", c.desc, c.cat, got)
		}
	}
}

func TestNominaSeImprimeSinTilde(t *testing.T) {
	// El caso exacto que reportó el dueño.
	got := extractConsolidatedConcept("PAGO DE NOMINA", "Nomina")
	if got != "PAGO DE NOMINA" {
		t.Fatalf("concepto de nomina = %q; want \"PAGO DE NOMINA\"", got)
	}
}

func TestNoQuedanLiteralesImpresosCorruptosEnElConsolidado(t *testing.T) {
	// Guardián estático sobre los RETURN del archivo: un literal devuelto con
	// mojibake termina impreso. Las líneas de comparación (strings.Contains,
	// ==, listas de prefijos) quedan excluidas a propósito.
	b, err := os.ReadFile("export_service_consolidated.go")
	if err != nil {
		t.Fatalf("no se pudo leer el fuente: %v", err)
	}

	for i, line := range strings.Split(string(b), "\n") {
		if !strings.Contains(line, mojibakePrefix) {
			continue
		}
		trimmed := strings.TrimSpace(line)
		// Comentarios: no se imprimen.
		if strings.HasPrefix(trimmed, "//") {
			continue
		}
		// Comparaciones y listas de reconocimiento: deben conservarse.
		if strings.Contains(trimmed, "strings.Contains") ||
			strings.Contains(trimmed, "==") ||
			strings.HasPrefix(trimmed, "\"") {
			continue
		}
		if strings.Contains(trimmed, "return ") {
			t.Errorf("linea %d devuelve un literal doble-codificado y se va a imprimir: %s", i+1, trimmed)
		}
	}
}
