package services

import (
	"math"
	"testing"
)

// Los tests siguientes documentan cada decisión del reconciliador:
// tolerancia, fallback por source, protección del desglose existente.
// Falla el build si alguien cambia el comportamiento sin actualizarlos.

func floatClose(a, b float64) bool {
	return math.Abs(a-b) < 0.01
}

// ==========================================================
// ReconcileTransferBreakdown
// ==========================================================

func TestReconcileNoHayTransferenciaDevuelveNone(t *testing.T) {
	got := ReconcileTransferBreakdown(0, 0, 0, "")
	if got.SourceUsed != "none" {
		t.Errorf("sin transferencia debe reportar 'none', got %q", got.SourceUsed)
	}
	if got.TransferAmount != 0 || got.TransferNequi != 0 || got.TransferDaviplata != 0 {
		t.Errorf("todo debe ser 0, got %+v", got)
	}
}

func TestReconcileDesgloseExplicitoCoherenteSeMantiene(t *testing.T) {
	// El caso feliz: frontend nuevo manda todo bien.
	got := ReconcileTransferBreakdown(50000, 30000, 20000, "MIXTO")
	if !floatClose(got.TransferAmount, 50000) {
		t.Errorf("transferAmount = %v, want 50000", got.TransferAmount)
	}
	if !floatClose(got.TransferNequi, 30000) {
		t.Errorf("nequi = %v, want 30000", got.TransferNequi)
	}
	if !floatClose(got.TransferDaviplata, 20000) {
		t.Errorf("daviplata = %v, want 20000", got.TransferDaviplata)
	}
	if got.SourceUsed != "explicit" {
		t.Errorf("SourceUsed = %q, want 'explicit'", got.SourceUsed)
	}
	if got.AdjustedByNormalization {
		t.Error("no debía normalizar, los valores ya cuadraban")
	}
}

func TestReconcileToleranciaDeRedondeoAjustaCanalMayor(t *testing.T) {
	// El cajero tecleó 30000 + 19997, el total del bono venía 50000.
	// Diferencia = 3, dentro de tolerancia (5). Se ajusta el canal
	// MAYOR con el residual para que la suma quede exacta.
	got := ReconcileTransferBreakdown(50000, 30000, 19997, "MIXTO")
	if !floatClose(got.TransferAmount, 50000) {
		t.Errorf("transferAmount debía conservarse, got %v", got.TransferAmount)
	}
	// 30000 es mayor, recibe el residual +3.
	if !floatClose(got.TransferNequi, 30003) {
		t.Errorf("nequi = %v, want 30003 (recibe el residual)", got.TransferNequi)
	}
	if !floatClose(got.TransferDaviplata, 19997) {
		t.Errorf("daviplata = %v, want 19997 intacto", got.TransferDaviplata)
	}
	if !floatClose(got.TransferNequi+got.TransferDaviplata, got.TransferAmount) {
		t.Errorf("nequi+davi (%v) no cuadra con transferAmount (%v)", got.TransferNequi+got.TransferDaviplata, got.TransferAmount)
	}
	if !got.AdjustedByNormalization {
		t.Error("debió reportar AdjustedByNormalization=true")
	}
}

func TestReconcileNoRechazaAunConDiscrepanciaGrande(t *testing.T) {
	// Escenario feo: el cajero se equivocó y digitó 30000+15000=45000
	// pero el transferAmount es 50000. Diferencia=5000. NO se rechaza
	// (justificación: cliente ya pagó, cola atrás).
	got := ReconcileTransferBreakdown(50000, 30000, 15000, "MIXTO")

	// Como ambos canales tienen valor, la granularidad manda:
	// transferAmount se ajusta a 45000.
	if !floatClose(got.TransferAmount, 45000) {
		t.Errorf("transferAmount debía ajustarse a la suma del desglose, got %v", got.TransferAmount)
	}
	if !floatClose(got.TransferNequi, 30000) || !floatClose(got.TransferDaviplata, 15000) {
		t.Errorf("desglose = %v/%v, want 30000/15000 intacto", got.TransferNequi, got.TransferDaviplata)
	}
	if !got.AdjustedByNormalization {
		t.Error("normalizó, debe reportarlo")
	}
}

func TestReconcileFallbackFrontendViejoSoloNequi(t *testing.T) {
	// El cliente viejo manda transferSource="NEQUI" sin desglose.
	got := ReconcileTransferBreakdown(30000, 0, 0, "NEQUI")
	if !floatClose(got.TransferNequi, 30000) {
		t.Errorf("nequi = %v, want 30000", got.TransferNequi)
	}
	if got.TransferDaviplata != 0 {
		t.Errorf("daviplata debe ser 0, got %v", got.TransferDaviplata)
	}
	if got.SourceUsed != "fallback" {
		t.Errorf("SourceUsed = %q, want 'fallback'", got.SourceUsed)
	}
}

func TestReconcileFallbackFrontendViejoSoloDaviplata(t *testing.T) {
	got := ReconcileTransferBreakdown(25000, 0, 0, "DAVIPLATA")
	if !floatClose(got.TransferDaviplata, 25000) {
		t.Errorf("daviplata = %v, want 25000", got.TransferDaviplata)
	}
	if got.TransferNequi != 0 {
		t.Errorf("nequi debe ser 0, got %v", got.TransferNequi)
	}
}

func TestReconcileFallbackMIXTOSinDesgloseNoInventa(t *testing.T) {
	// Este ES el caso legacy que rompía. Con MIXTO y sin desglose,
	// NO inventamos un split. El cierre lo suma a "otras
	// transferencias" como antes; no se corrige historia.
	got := ReconcileTransferBreakdown(50000, 0, 0, "MIXTO")
	if got.TransferNequi != 0 || got.TransferDaviplata != 0 {
		t.Errorf("no debemos inventar desglose para MIXTO legacy, got %+v", got)
	}
	if !floatClose(got.TransferAmount, 50000) {
		t.Errorf("transferAmount = %v, want 50000", got.TransferAmount)
	}
}

func TestReconcileSoloUnCanalConAmountDistintoAjustaAlCanalDeclarado(t *testing.T) {
	// Sólo nequi=1000 pero transferAmount=5000 (payload raro).
	// Al haber un solo canal declarado, transferAmount es la
	// referencia y todo el residual va al canal.
	got := ReconcileTransferBreakdown(5000, 1000, 0, "")
	if !floatClose(got.TransferNequi, 5000) {
		t.Errorf("nequi = %v, want 5000 (canal declarado se queda con todo)", got.TransferNequi)
	}
	if got.TransferDaviplata != 0 {
		t.Errorf("daviplata debe ser 0, got %v", got.TransferDaviplata)
	}
	if !got.AdjustedByNormalization {
		t.Error("debió reportar normalización")
	}
}

func TestReconcileNegativosSeSanean(t *testing.T) {
	got := ReconcileTransferBreakdown(-100, -50, -20, "")
	if got.TransferAmount != 0 || got.TransferNequi != 0 || got.TransferDaviplata != 0 {
		t.Errorf("valores negativos deben sanearse a 0, got %+v", got)
	}
}

func TestReconcileTransferAmountCeroPeroDesgloseValidoDerivaTotal(t *testing.T) {
	// Payload malformado: total 0 pero canales positivos.
	got := ReconcileTransferBreakdown(0, 30000, 20000, "MIXTO")
	if !floatClose(got.TransferAmount, 50000) {
		t.Errorf("total debe derivarse del desglose, got %v", got.TransferAmount)
	}
	if !floatClose(got.TransferNequi, 30000) || !floatClose(got.TransferDaviplata, 20000) {
		t.Errorf("desglose = %v/%v, want 30000/20000", got.TransferNequi, got.TransferDaviplata)
	}
}

// ==========================================================
// MergeTransferBreakdownWithExisting (protege UpdateSalePayment)
// ==========================================================

func TestMergePayloadTraeDesglosePayloadGana(t *testing.T) {
	// La venta tenía 30k Nequi + 20k Davi. Editan y mandan 25k+25k.
	got := MergeTransferBreakdownWithExisting(
		50000, 25000, 25000, "MIXTO",
		50000, 30000, 20000, "MIXTO",
	)
	if !floatClose(got.TransferNequi, 25000) || !floatClose(got.TransferDaviplata, 25000) {
		t.Errorf("payload debía ganar, got %+v", got)
	}
}

func TestMergePayloadSinDesglosePreservaElExistente(t *testing.T) {
	// Este es el bug que denunció el dueño: payload sin desglose
	// no debe machacar el desglose ya guardado.
	got := MergeTransferBreakdownWithExisting(
		50000, 0, 0, "MIXTO",
		50000, 30000, 20000, "MIXTO",
	)
	if !floatClose(got.TransferNequi, 30000) {
		t.Errorf("nequi debía conservarse, got %v", got.TransferNequi)
	}
	if !floatClose(got.TransferDaviplata, 20000) {
		t.Errorf("daviplata debía conservarse, got %v", got.TransferDaviplata)
	}
	if got.SourceUsed != "preserved" {
		t.Errorf("SourceUsed = %q, want 'preserved'", got.SourceUsed)
	}
}

func TestMergePayloadCambiaTotalYNoTraeDesgloseSeEscalaProporcionalmente(t *testing.T) {
	// La venta tenía 30/20 (60%/40%) y ahora total pasa a 100k
	// sin que el payload traiga desglose. Escalamos.
	got := MergeTransferBreakdownWithExisting(
		100000, 0, 0, "",
		50000, 30000, 20000, "MIXTO",
	)
	if !floatClose(got.TransferAmount, 100000) {
		t.Errorf("total = %v, want 100000", got.TransferAmount)
	}
	if !floatClose(got.TransferNequi, 60000) {
		t.Errorf("nequi = %v, want 60000 (60%% de 100k)", got.TransferNequi)
	}
	if !floatClose(got.TransferDaviplata, 40000) {
		t.Errorf("daviplata = %v, want 40000 (40%% de 100k)", got.TransferDaviplata)
	}
	if got.SourceUsed != "preserved-scaled" {
		t.Errorf("SourceUsed = %q, want 'preserved-scaled'", got.SourceUsed)
	}
}

func TestMergePayloadTraeSourceNequiAplicaFallback(t *testing.T) {
	// Sin desglose pero source claro: aplica fallback sin preservar
	// (porque el payload es explícito sobre a qué canal va).
	got := MergeTransferBreakdownWithExisting(
		30000, 0, 0, "NEQUI",
		50000, 30000, 20000, "MIXTO",
	)
	if !floatClose(got.TransferNequi, 30000) {
		t.Errorf("nequi = %v, want 30000", got.TransferNequi)
	}
	if got.TransferDaviplata != 0 {
		t.Errorf("daviplata = %v, want 0 (el payload dice NEQUI puro)", got.TransferDaviplata)
	}
}

// ==========================================================
// AddToTransferBreakdown (protege AddItemsToSale)
// ==========================================================

func TestAddSumaAlDesgloseExistenteConDeltaExplicito(t *testing.T) {
	// La venta tenía 30k Nequi + 20k Davi = 50k. Se añaden ítems
	// pagados 10k Nequi + 5k Davi.
	got := AddToTransferBreakdown(50000, 30000, 20000, 15000, 10000, 5000, "MIXTO")
	if !floatClose(got.TransferAmount, 65000) {
		t.Errorf("total = %v, want 65000", got.TransferAmount)
	}
	if !floatClose(got.TransferNequi, 40000) {
		t.Errorf("nequi = %v, want 40000 (30k + 10k)", got.TransferNequi)
	}
	if !floatClose(got.TransferDaviplata, 25000) {
		t.Errorf("daviplata = %v, want 25000 (20k + 5k)", got.TransferDaviplata)
	}
}

func TestAddDeltaSinDesgloseNoDestruyeElExistente(t *testing.T) {
	// Se añaden ítems con transferSource="NEQUI" sin desglose
	// explícito → el delta va a Nequi por fallback; el existente
	// se conserva.
	got := AddToTransferBreakdown(50000, 30000, 20000, 10000, 0, 0, "NEQUI")
	if !floatClose(got.TransferAmount, 60000) {
		t.Errorf("total = %v, want 60000", got.TransferAmount)
	}
	if !floatClose(got.TransferNequi, 40000) {
		t.Errorf("nequi = %v, want 40000 (30k + 10k por fallback)", got.TransferNequi)
	}
	if !floatClose(got.TransferDaviplata, 20000) {
		t.Errorf("daviplata debía conservarse en 20000, got %v", got.TransferDaviplata)
	}
}

func TestAddDeltaMIXTOSinDesgloseNoContaminaElExistente(t *testing.T) {
	// El delta es MIXTO sin desglose (legacy). Su desglose queda 0/0,
	// pero el desglose ya guardado NO se toca.
	got := AddToTransferBreakdown(50000, 30000, 20000, 10000, 0, 0, "MIXTO")
	if !floatClose(got.TransferAmount, 60000) {
		t.Errorf("total = %v, want 60000", got.TransferAmount)
	}
	if !floatClose(got.TransferNequi, 30000) {
		t.Errorf("nequi debía conservarse, got %v", got.TransferNequi)
	}
	if !floatClose(got.TransferDaviplata, 20000) {
		t.Errorf("daviplata debía conservarse, got %v", got.TransferDaviplata)
	}
}
