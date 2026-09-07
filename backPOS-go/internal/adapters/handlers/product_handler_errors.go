package handlers

import (
	"errors"

	"backPOS-go/internal/core/domain/models"
)

// historicalMarkerReservedResponse detecta si err (o alguna causa envuelta con
// %w) es *models.HistoricalMarkerReservedError. Si lo es, devuelve el
// contrato HTTP 409 estructurado que consume el frontend:
//
//   - status = 409 (conflicto)
//   - code   = HISTORICAL_MARKER_RESERVED
//   - message = texto breve para toast/alerta (no instructivo)
//   - metadata = objeto con realBarcode, markerBarcode y markerName
//
// El mensaje NO revela comandos administrativos ni rutas internas; el
// frontend arma su copy a partir de los campos de metadata y ofrece la
// fusión sólo tras confirmación explícita del administrador. Si el error no
// coincide, devuelve ok=false y el llamador debe seguir su ruta normal.
//
// Se extrae en función independiente para que el handler quede fino y la
// lógica de mapeo sea probable sin base de datos ni Gin instanciados.
func historicalMarkerReservedResponse(err error) (status int, apiErr APIError, ok bool) {
	if err == nil {
		return 0, APIError{}, false
	}
	var marker *models.HistoricalMarkerReservedError
	if !errors.As(err, &marker) || marker == nil {
		return 0, APIError{}, false
	}
	return 409, APIError{
		Code:    ErrHistoricalMarkerReserved,
		Message: "Código de barras reservado por un marcador histórico",
		Metadata: map[string]string{
			"realBarcode":   marker.RealBarcode,
			"markerBarcode": marker.MarkerBarcode,
			"markerName":    marker.MarkerName,
		},
	}, true
}
