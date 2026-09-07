package services

import (
	"math"
	"strings"
)

// Este archivo contiene lógica PURA para reconciliar el desglose
// Nequi/Daviplata del pago por transferencia de una venta. Vive aparte
// para poder testearlo sin base de datos y sin construir un SaleService.
//
// Contexto del problema (verificado por el dueño):
//   - Cuando el cajero divide el pago entre Nequi y Daviplata, el
//     frontend viejo mandaba los dos montos SUMADOS con
//     transferSource="MIXTO" y sin desglose. La reconstrucción antigua
//     (que solo miraba transferSource) dejaba TransferNequi y
//     TransferDaviplata en 0, y todo terminaba en "otras transferencias"
//     en los cierres.
//   - El frontend nuevo va a mandar transferNequi y transferDaviplata
//     por separado. El backend debe:
//       1) Respetar el desglose si viene explícito.
//       2) Reconstruir desde transferSource como fallback para clientes
//          viejos (pestaña sin recargar, offline queue, etc.).
//       3) Validar coherencia y decidir qué hacer si no cuadra.
//
// Decisión sobre coherencia (cuando desglose + transferAmount no cuadran):
//   NORMALIZAR, nunca RECHAZAR.
//
// Justificación:
//   En un supermercado el cliente ya PAGÓ, está frente al cajero
//   esperando el ticket. Rechazar la venta significa:
//     - Devolver o retener el dinero manualmente (no hay mecanismo).
//     - Sostener una cola de clientes a espaldas del cajero.
//     - Perder la venta si el cliente se va molesto.
//   Guardar un desglose con un pequeño ruido de redondeo es un problema
//   de reporte, no de negocio: se ve en el cierre y se corrige a mano.
//   Perder la venta es un problema de negocio inmediato.
//
// Estrategia de normalización:
//   - Si sum(nequi+daviplata) coincide con transferAmount dentro de
//     una tolerancia de ±5 pesos (misma tolerancia que ya usa
//     BulkReceive para pagos mixtos) → aceptamos tal cual.
//   - Si difieren en más de 5 pesos y AMBOS canales son > 0, el
//     desglose es la verdad granular (es lo que el cajero vio y
//     confirmó), así que ajustamos transferAmount = nequi + daviplata.
//   - Si difieren y sólo UNO de los canales es > 0, el otro es 0
//     por olvido; asumimos transferAmount es el total real y el
//     residual va al canal declarado.
//
// Fallback desde transferSource (cliente viejo, sin desglose):
//   - transferSource contiene "NEQUI" → todo el TransferAmount va a
//     TransferNequi.
//   - transferSource contiene "DAVIPLATA" o "DAVI" → todo va a
//     TransferDaviplata.
//   - Cualquier otro valor (incluido "MIXTO"): NO se asigna canal.
//     Esa venta caerá en "otras transferencias" del cierre exactamente
//     como caía antes; no inventamos un desglose que no vino.

// TransferBreakdownTolerance define cuántos pesos de diferencia se
// aceptan como ruido de redondeo entre transferAmount y (nequi+davi).
// Coincide con la tolerancia ya usada en BulkReceive para pagos mixtos.
const TransferBreakdownTolerance = 5.0

// TransferBreakdown representa el desglose resuelto tras aplicar la
// reconciliación y el fallback por transferSource.
type TransferBreakdown struct {
	TransferAmount    float64 // total unificado (puede ajustarse si el desglose lo pide)
	TransferNequi     float64
	TransferDaviplata float64
	// AdjustedByNormalization es true si la función tuvo que normalizar
	// alguno de los tres valores (útil para loguear una advertencia).
	AdjustedByNormalization bool
	// SourceUsed identifica qué camino se tomó, sólo para observabilidad:
	//   "explicit"   -> vino desglose y era coherente
	//   "normalized" -> vino desglose pero se corrigió
	//   "fallback"   -> se reconstruyó desde transferSource
	//   "none"       -> no hay transferencia
	SourceUsed string
}

// ReconcileTransferBreakdown recibe los valores tal como llegan del
// payload (o de la venta existente cuando venimos de UpdateSalePayment)
// y devuelve un TransferBreakdown listo para persistir.
//
// Reglas (en este orden):
//  1. Si transferAmount <= 0 (con tolerancia de centavos) → sin
//     transferencia, todo a cero, SourceUsed="none".
//  2. Si vino desglose explícito (nequi > 0 o daviplata > 0) → se
//     valida coherencia contra transferAmount y se normaliza según la
//     estrategia descrita arriba.
//  3. Si NO vino desglose y transferSource matchea "NEQUI" o
//     "DAVIPLATA" → fallback: se coloca todo el transferAmount en el
//     canal correspondiente. Este es el camino de compatibilidad para
//     clientes viejos.
//  4. Cualquier otra situación (incluye transferSource="MIXTO" sin
//     desglose, que es exactamente el caso legacy que rompía) → se
//     devuelve el transferAmount pero con desglose 0/0 y
//     SourceUsed="fallback". El comportamiento coincide con la conducta
//     histórica; no se corrige historia (es el requisito del dueño).
//     El frontend nuevo evita este caso mandando el desglose.
func ReconcileTransferBreakdown(transferAmount, transferNequi, transferDaviplata float64, transferSource string) TransferBreakdown {
	// Sanitización básica: valores negativos son bugs del payload, los
	// tratamos como 0 (nunca rechazamos por esto; ver justificación).
	if transferAmount < 0 {
		transferAmount = 0
	}
	if transferNequi < 0 {
		transferNequi = 0
	}
	if transferDaviplata < 0 {
		transferDaviplata = 0
	}

	// Caso 1: sin transferencia.
	if transferAmount < 0.01 && transferNequi < 0.01 && transferDaviplata < 0.01 {
		return TransferBreakdown{SourceUsed: "none"}
	}

	// Si el desglose vino pero transferAmount es 0 (payload malformado),
	// derivamos transferAmount desde el desglose.
	if transferAmount < 0.01 && (transferNequi > 0 || transferDaviplata > 0) {
		return TransferBreakdown{
			TransferAmount:          transferNequi + transferDaviplata,
			TransferNequi:           transferNequi,
			TransferDaviplata:       transferDaviplata,
			AdjustedByNormalization: true,
			SourceUsed:              "normalized",
		}
	}

	// Caso 2: vino desglose explícito.
	if transferNequi > 0 || transferDaviplata > 0 {
		sum := transferNequi + transferDaviplata
		diff := math.Abs(sum - transferAmount)

		// 2a: coherente dentro de la tolerancia → aceptar y snap del
		// residual al canal MAYOR para que la suma quede exacta.
		if diff <= TransferBreakdownTolerance {
			if diff > 0.01 {
				residual := transferAmount - sum
				if transferNequi >= transferDaviplata {
					transferNequi += residual
				} else {
					transferDaviplata += residual
				}
				// Los residuales negativos podrían crear un canal en
				// negativo si el desglose original era 0. Blindamos.
				if transferNequi < 0 {
					transferNequi = 0
				}
				if transferDaviplata < 0 {
					transferDaviplata = 0
				}
			}
			adjusted := diff > 0.01
			return TransferBreakdown{
				TransferAmount:          transferAmount,
				TransferNequi:           roundTransferMoney(transferNequi),
				TransferDaviplata:       roundTransferMoney(transferDaviplata),
				AdjustedByNormalization: adjusted,
				SourceUsed:              pickTransferSource(adjusted, "normalized", "explicit"),
			}
		}

		// 2b: incoherente más allá de la tolerancia. Si ambos canales
		// vienen con valor, la granularidad manda: transferAmount se
		// ajusta al sum. Si solo uno viene, transferAmount es la
		// referencia y el otro canal recibe el residual.
		if transferNequi > 0 && transferDaviplata > 0 {
			return TransferBreakdown{
				TransferAmount:          roundTransferMoney(sum),
				TransferNequi:           roundTransferMoney(transferNequi),
				TransferDaviplata:       roundTransferMoney(transferDaviplata),
				AdjustedByNormalization: true,
				SourceUsed:              "normalized",
			}
		}
		// Sólo uno de los dos: el residual va al canal declarado.
		if transferNequi > 0 {
			return TransferBreakdown{
				TransferAmount:          transferAmount,
				TransferNequi:           roundTransferMoney(transferAmount),
				TransferDaviplata:       0,
				AdjustedByNormalization: true,
				SourceUsed:              "normalized",
			}
		}
		return TransferBreakdown{
			TransferAmount:          transferAmount,
			TransferNequi:           0,
			TransferDaviplata:       roundTransferMoney(transferAmount),
			AdjustedByNormalization: true,
			SourceUsed:              "normalized",
		}
	}

	// Caso 3: fallback por transferSource (cliente viejo sin desglose).
	source := strings.ToUpper(strings.TrimSpace(transferSource))
	switch {
	case strings.Contains(source, "NEQUI"):
		return TransferBreakdown{
			TransferAmount:    transferAmount,
			TransferNequi:     roundTransferMoney(transferAmount),
			TransferDaviplata: 0,
			SourceUsed:        "fallback",
		}
	case strings.Contains(source, "DAVIPLATA") || strings.Contains(source, "DAVI"):
		return TransferBreakdown{
			TransferAmount:    transferAmount,
			TransferNequi:     0,
			TransferDaviplata: roundTransferMoney(transferAmount),
			SourceUsed:        "fallback",
		}
	default:
		// transferSource="MIXTO" u otro: no inventamos desglose.
		// Este es el caso legacy que rompía el cierre; el frontend
		// nuevo lo evita mandando el desglose.
		return TransferBreakdown{
			TransferAmount:    transferAmount,
			TransferNequi:     0,
			TransferDaviplata: 0,
			SourceUsed:        "fallback",
		}
	}
}

// MergeTransferBreakdownWithExisting protege una venta ya guardada de
// perder su desglose cuando llega un payload SIN desglose (frontend
// viejo o pestaña que no se recargó). Se usa en UpdateSalePayment.
//
// Reglas:
//   - Si el payload trae un desglose explícito → gana el payload
//     (reconciliado con la función anterior).
//   - Si el payload NO trae desglose pero SÍ trae transferSource, y ese
//     source es Nequi o Daviplata → se aplica el fallback.
//   - Si el payload NO trae desglose NI un source resoluble, pero la
//     venta existente SÍ tenía desglose → se conserva el existente
//     escalado al nuevo transferAmount si cambió.
//   - Si nada de lo anterior → desglose queda en 0/0, transferAmount
//     conserva su valor.
//
// Se blinda con esto el caso que denunció el dueño: hoy
// UpdateSalePayment machaca a 0 el desglose si el payload no lo trae.
func MergeTransferBreakdownWithExisting(
	payloadTransferAmount, payloadNequi, payloadDaviplata float64,
	payloadTransferSource string,
	existingTransferAmount, existingNequi, existingDaviplata float64,
	existingTransferSource string,
) TransferBreakdown {
	// Si el payload trae desglose o el source es Nequi/Daviplata, la
	// reconciliación normal alcanza — el payload es autoridad.
	upperSource := strings.ToUpper(strings.TrimSpace(payloadTransferSource))
	payloadHasBreakdown := payloadNequi > 0 || payloadDaviplata > 0
	payloadHasSourceHint := strings.Contains(upperSource, "NEQUI") ||
		strings.Contains(upperSource, "DAVIPLATA") ||
		strings.Contains(upperSource, "DAVI")

	if payloadHasBreakdown || payloadHasSourceHint {
		return ReconcileTransferBreakdown(payloadTransferAmount, payloadNequi, payloadDaviplata, payloadTransferSource)
	}

	// Payload sin desglose útil: intentamos preservar el existente.
	if existingNequi > 0 || existingDaviplata > 0 {
		// Si el transferAmount NO cambió, mantenemos exactamente lo
		// que había — no queremos alterar lo cargado.
		if math.Abs(payloadTransferAmount-existingTransferAmount) < 0.01 {
			return TransferBreakdown{
				TransferAmount:    existingTransferAmount,
				TransferNequi:     existingNequi,
				TransferDaviplata: existingDaviplata,
				SourceUsed:        "preserved",
			}
		}
		// Si cambió el total pero no vino desglose, escalamos
		// proporcionalmente para mantener las proporciones que sí
		// registró el cajero. Es mejor que machacar a 0.
		existingSum := existingNequi + existingDaviplata
		if existingSum > 0 && payloadTransferAmount > 0 {
			factor := payloadTransferAmount / existingSum
			return TransferBreakdown{
				TransferAmount:          payloadTransferAmount,
				TransferNequi:           roundTransferMoney(existingNequi * factor),
				TransferDaviplata:       roundTransferMoney(existingDaviplata * factor),
				AdjustedByNormalization: true,
				SourceUsed:              "preserved-scaled",
			}
		}
	}

	// Nada útil: comportamiento por defecto (equivalente al legacy).
	return ReconcileTransferBreakdown(payloadTransferAmount, 0, 0, payloadTransferSource)
}

// AddToTransferBreakdown se usa en AddItemsToSale: dada la venta ya
// registrada, aplica un delta de transferAmount y (opcionalmente) un
// desglose. La existencia de la venta se conserva; el desglose se
// SUMA si el payload lo trae, y NUNCA se machaca a 0 si el payload
// solo trae el total.
func AddToTransferBreakdown(
	existingTransferAmount, existingNequi, existingDaviplata float64,
	deltaTransferAmount, deltaNequi, deltaDaviplata float64,
	deltaTransferSource string,
) TransferBreakdown {
	// Reconciliamos el delta como si fuera una venta aparte para
	// derivar cómo repartirlo.
	deltaResolved := ReconcileTransferBreakdown(deltaTransferAmount, deltaNequi, deltaDaviplata, deltaTransferSource)

	sumBreakdown := existingNequi + existingDaviplata + deltaResolved.TransferNequi + deltaResolved.TransferDaviplata
	totalTransfer := existingTransferAmount + deltaResolved.TransferAmount

	return TransferBreakdown{
		TransferAmount:          roundTransferMoney(totalTransfer),
		TransferNequi:           roundTransferMoney(existingNequi + deltaResolved.TransferNequi),
		TransferDaviplata:       roundTransferMoney(existingDaviplata + deltaResolved.TransferDaviplata),
		AdjustedByNormalization: deltaResolved.AdjustedByNormalization || math.Abs(sumBreakdown-totalTransfer) > TransferBreakdownTolerance,
		SourceUsed:              deltaResolved.SourceUsed,
	}
}

// roundTransferMoney redondea a 2 decimales. Se llama distinto a
// roundMoney (que ya existe en stock_health.go) para evitar colisión.
func roundTransferMoney(v float64) float64 {
	return math.Round(v*100) / 100
}

func pickTransferSource(cond bool, ifTrue, ifFalse string) string {
	if cond {
		return ifTrue
	}
	return ifFalse
}
