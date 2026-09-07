package repositories

// Este archivo lista todas las razones y tipos de movimiento que puede
// generar una recepción a través de BulkReceive. La lista se usa para
// REVERTIR una recepción cuando se edita o se elimina.
//
// Historial:
//   - Antes del fix, la reversión filtraba solo `reason = 'RECEPTION'`.
//     Eso dejaba fuera bonificaciones, el efecto sobre el producto base
//     de las pacas y los ajustes físicos, causando duplicación de stock
//     al editar una recepción con pacas o bonos.
//   - Este archivo centraliza la lista para poder testearla como lógica
//     pura, y para que cualquier futura razón nueva emitida por
//     BulkReceive tenga un solo lugar que actualizar.
//
// Fuente: derivada directamente de internal/adapters/repositories/
// postgres_product_inventory.go, función BulkReceive. Los comentarios en
// cada constante indican dónde exactamente se crea el movimiento.

// ReceptionMovementReasons enumera los valores de `reason` que BulkReceive
// puede escribir en stock_movements para una recepción.
//
// NOTA sobre los ajustes físicos: BulkReceive crea movimientos con
// Type=ADJUSTMENT_UP/DOWN y con `reason` en TEXTO LIBRE en español
// ("Ajuste en Recepción", "Ajuste por faltante en físico durante
// recepción (Auditoría)", "Ajuste en Recepción (base de paca)"). Por eso
// los ajustes NO se identifican por reason sino por type; ver
// ReceptionAdjustmentTypes más abajo.
var ReceptionMovementReasons = []string{
	// Movimiento del producto que se recibe. Rama isEgreso.
	// (postgres_product_inventory.go ~ línea 553-563, movementReason por defecto)
	"RECEPTION",

	// Bonificación / regalo del proveedor. Suma stock del producto,
	// no genera egreso.
	// (postgres_product_inventory.go ~ línea 547, cuando entry.LineType == "BONUS")
	"RECEPTION_BONUS",

	// Efecto sobre el PRODUCTO BASE cuando se recibió una paca.
	// Ej: recibí 5 pacas de 24 => se suman 120 unidades al base.
	// ANTES tenía reference_id = "PACKB-<timestamp>" (distinto al
	// receptionID) y por eso al editar no se encontraba; hoy comparte
	// el mismo receptionID que el resto de movimientos de la recepción.
	// (postgres_product_inventory.go ~ línea 421-436)
	"PACK_RECEPTION_BULK",

	// Recepción "sin egreso" (isEgreso == false): sólo se usa para
	// actualizar precios sin mover stock. La cantidad del movimiento
	// es 0, así que revertirlo es un no-op de stock, pero conviene
	// borrarlo para que la edición no deje huellas fantasma en el
	// kárdex.
	// (postgres_product_inventory.go ~ línea 431 y 551)
	"PRICE_UPDATE_NO_STOCK",
}

// ReceptionAdjustmentTypes enumera los TIPOS de movimiento que produce
// un ajuste físico durante la recepción. Se filtra por Type porque el
// campo Reason en estos movimientos es texto libre en español.
//
//   - ADJUSTMENT_UP: cuando el físico digitado es MAYOR que el teórico
//     (sobra mercancía). Se emite tanto sobre el producto del entry
//     como, si es paca, sobre el producto BASE (línea agregada por
//     el fix; ver baseAdjMovement en postgres_product_inventory.go).
//   - ADJUSTMENT_DOWN: cuando el físico es MENOR (falta mercancía).
//     Mismo comportamiento simétrico.
//
// (postgres_product_inventory.go ~ línea 285-303 para el ajuste sobre
// el entry, y la sección de pack para el ajuste sobre el base.)
var ReceptionAdjustmentTypes = []string{
	"ADJUSTMENT_UP",
	"ADJUSTMENT_DOWN",
}

// IsReceptionReversibleMovement devuelve true si el movimiento fue
// generado por BulkReceive y por tanto debe revertirse cuando se edita
// o elimina la recepción.
//
// Se toma como entrada el reason y el type; con eso alcanza para
// discriminar los cinco casos (RECEPTION, RECEPTION_BONUS,
// PACK_RECEPTION_BULK, PRICE_UPDATE_NO_STOCK, ADJUSTMENT_UP/DOWN).
//
// Esta función es pura y testeable sin base de datos.
func IsReceptionReversibleMovement(reason, movementType string) bool {
	for _, r := range ReceptionMovementReasons {
		if reason == r {
			return true
		}
	}
	for _, t := range ReceptionAdjustmentTypes {
		if movementType == t {
			return true
		}
	}
	return false
}
