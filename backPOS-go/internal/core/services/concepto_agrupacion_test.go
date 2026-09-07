package services

import "testing"

// ============================================================================
// AGRUPACION DE CONCEPTOS EN EL CONSOLIDADO
// ============================================================================
//
// Pedidos del dueño el 2026-09-05, mirando el reporte real de agosto:
//
//  1. "en servicios pagados, yo pongo que servicio se paga, pon los servicios
//     desglosados" -> antes TODO caía en un solo "PAGO DE SERVICIOS" de
//     $1.766.214 y se perdía el detalle que el propio dueño escribe.
//  2. "los almuerzos o almuerzo ponlos unidos porque es lo mismo" -> salían
//     "OTROS GASTOS (ALMUERZOS AGOSTO 16-31)" y
//     "OTROS GASTOS (ALMUERZO (20,21,24,25,26,27))" como filas distintas.
//  3. "arriendo solo que salga sin alquileres" -> decía "ARRIENDO Y ALQUILERES".

func TestConcepto_ServiciosSeDesglosanPorTipo(t *testing.T) {
	casos := []struct {
		desc, cat, want string
	}{
		{"PAGO DE LUZ", "Servicios", "SERVICIO - LUZ"},
		{"RECIBO ENERGIA AGOSTO", "", "SERVICIO - LUZ"},
		{"PAGO AGUA", "Servicios", "SERVICIO - AGUA"},
		{"ACUEDUCTO AGOSTO", "", "SERVICIO - AGUA"},
		{"PAGO INTERNET", "Servicios", "SERVICIO - INTERNET"},
		{"FIBRA CLARO", "", "SERVICIO - INTERNET"},
		{"PAGO DE GAS", "Servicios", "SERVICIO - GAS"},
		{"RECARGA CELULAR", "", "SERVICIO - TELEFONO"},
		{"PAGO BASURA", "", "SERVICIO - BASURAS"},
	}
	for _, c := range casos {
		if got := extractConsolidatedConcept(c.desc, c.cat); got != c.want {
			t.Errorf("extractConsolidatedConcept(%q, %q) = %q; want %q", c.desc, c.cat, got, c.want)
		}
	}
}

func TestConcepto_ServicioSinDetallarNoSeMezclaConLosIdentificados(t *testing.T) {
	// Un servicio que no dice cuál es NO puede caer en la fila de luz ni de
	// agua: se agrupa aparte para que se note que falta detallarlo.
	got := extractConsolidatedConcept("PAGO DE SERVICIOS", "Servicios")
	if got != "SERVICIO - SIN DETALLAR" {
		t.Fatalf("concepto = %q; want \"SERVICIO - SIN DETALLAR\"", got)
	}
	// Y no debe robarse los que sí están identificados.
	if extractConsolidatedConcept("PAGO DE SERVICIOS - LUZ", "Servicios") != "SERVICIO - LUZ" {
		t.Error("un servicio identificado no debe caer en SIN DETALLAR")
	}
}

func TestConcepto_TodosLosAlmuerzosVanAUnaSolaFila(t *testing.T) {
	// LOS DOS CASOS REALES del reporte de agosto del dueño.
	casos := []string{
		"ALMUERZOS AGOSTO 16-31",
		"ALMUERZO (20,21,24,25,26,27)",
		"ALMUERZO",
		"ALMUERZOS",
		"almuerzos del personal",
		"28/08 - ALMUERZO",
	}
	for _, d := range casos {
		if got := extractConsolidatedConcept(d, ""); got != "ALMUERZOS" {
			t.Errorf("extractConsolidatedConcept(%q) = %q; want \"ALMUERZOS\" (todos son el mismo gasto)", d, got)
		}
	}
}

func TestConcepto_ArriendoSaleSinAlquileres(t *testing.T) {
	for _, d := range []string{"ARRIENDO", "PAGO DE ARRIENDO", "ARRIENDO LOCAL", "ALQUILER"} {
		got := extractConsolidatedConcept(d, "")
		if got != "ARRIENDO" {
			t.Errorf("extractConsolidatedConcept(%q) = %q; want \"ARRIENDO\"", d, got)
		}
	}
}

func TestConcepto_LoQueYaFuncionabaNoSeRompio(t *testing.T) {
	// Nomina, proveedores y banco deben seguir agrupando igual: estos cambios
	// eran sólo para servicios, almuerzos y arriendo.
	casos := []struct {
		desc, cat, want string
	}{
		{"PAGO DE NOMINA", "Nomina", "PAGO DE NOMINA"},
		{"CUOTA BANCO", "", "CUOTA BANCO / OBLIGACIONES"},
		{"PAGO DE PROVEEDOR - PLAZA", "Proveedores", "PAGO PROVEEDOR - PLAZA"},
		{"RECEPCION DE MERCANCIA - BIMBO", "Proveedores", "PAGO PROVEEDOR - BIMBO"},
		{"CANDADO", "", "OTROS GASTOS (CANDADO)"},
	}
	for _, c := range casos {
		if got := extractConsolidatedConcept(c.desc, c.cat); got != c.want {
			t.Errorf("extractConsolidatedConcept(%q, %q) = %q; want %q", c.desc, c.cat, got, c.want)
		}
	}
}

func TestConcepto_ElArriendoNoSeConfundeConServicio(t *testing.T) {
	// "ARRIENDO" se evalua ANTES que los servicios; si se invirtiera el orden,
	// un texto como "ARRIENDO Y SERVICIOS" caeria en la fila equivocada.
	if got := extractConsolidatedConcept("ARRIENDO Y SERVICIOS DEL LOCAL", ""); got != "ARRIENDO" {
		t.Fatalf("concepto = %q; want \"ARRIENDO\" (el arriendo manda sobre servicios)", got)
	}
}
