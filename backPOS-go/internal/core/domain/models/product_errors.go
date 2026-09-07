package models

import "fmt"

// HistoricalMarkerReservedError se emite cuando una operación de actualización
// de producto intenta tomar un código de barras que hoy está reservado por un
// producto marcador '[HISTORICO] ...' creado por
// paquete_produccion\corregir_referencias.ps1 para tapar FKs huérfanas.
//
// El marcador es invisible en el catálogo (isActive=false) pero ocupa el
// código, así que el operador no puede desbloquearlo desde la UI. La
// liberación exige una decisión operativa: un administrador debe ejecutar la
// fusión POST /admin/products/merge-historical, tras una confirmación
// explícita, para consolidar el historial del marcador con un producto real
// y liberar el barcode.
//
// Se define en la capa core (dominio) para que los adaptadores de repositorio
// puedan devolverla y los handlers puedan reconocerla con errors.As sin
// depender uno de otro. El error es un value object: sus campos identifican
// el conflicto sin filtrar internals del algoritmo ni SQL.
type HistoricalMarkerReservedError struct {
	// RealBarcode es el código de barras ACTUAL del producto real que el
	// operador está editando (el `barcode` de la URL PUT
	// /products/update-products/:barcode). Es el origen de la fusión: sus
	// ventas, referencias y auditoría se conservarán tras consolidar con
	// el marcador '[HISTORICO]'.
	RealBarcode string
	// MarkerBarcode es el código de barras destino que el operador ingresó
	// en el formulario y que hoy está retenido por el producto marcador
	// '[HISTORICO]'. Tras la fusión, este código pasa a apuntar al producto
	// real.
	//
	// Invariante: RealBarcode != MarkerBarcode. Si el UPDATE detecta que el
	// destino coincide con el barcode actual (targetBarcode == barcode), no
	// hay colisión y no se emite este error. Además, el endpoint admin
	// POST /admin/products/merge-historical rechaza la fusión cuando ambos
	// valores coinciden con "no pueden ser iguales", y el helper del
	// frontend buildMergeRequest retorna null en ese caso. Los tests
	// TestHistoricalMarkerErrorSemantics y TestHistoricalMarkerReservedJSONContract
	// pinean esta invariante para evitar que la rama isHistoricalMarker
	// asigne targetBarcode a los dos campos (el bug original).
	MarkerBarcode string
	// MarkerName es el productName del marcador (empieza con
	// "[HISTORICO] ..."). Sirve para que el frontend explique al operador
	// qué producto histórico está reteniendo el código.
	MarkerName string
}

// Error implementa la interfaz error. El mensaje es breve y estable: no
// incluye instrucciones internas ni comandos administrativos porque esos
// datos viajan como metadata estructurada del handler, no dentro del texto.
func (e *HistoricalMarkerReservedError) Error() string {
	if e == nil {
		return "código reservado por marcador histórico"
	}
	return fmt.Sprintf(
		"el código de barras %s está reservado por un marcador histórico (%s)",
		e.MarkerBarcode, e.MarkerName,
	)
}
