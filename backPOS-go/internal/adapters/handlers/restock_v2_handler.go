package handlers

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/services"
	"github.com/gin-gonic/gin"
)

type RestockV2Handler struct {
	metricsRepo *repositories.RestockMetricsRepository
	nightlySvc  *services.RestockNightlyService
}

func NewRestockV2Handler(
	mr *repositories.RestockMetricsRepository,
	ns *services.RestockNightlyService,
) *RestockV2Handler {
	return &RestockV2Handler{metricsRepo: mr, nightlySvc: ns}
}

// GetSuggestionsV2 responde /api/restock/suggestions-v2.
//
// Query params (Fase 1, agosto 2026):
//
//	supplier_id  int|opcional  filtra por proveedor. 0 o vacio = sin filtro.
//	search       string|opc.   filtra por nombre o barcode (server-side, ILIKE).
//	include_all     bool|opc. default false. Si false, solo devuelve las
//	                filas accionables (RED, YELLOW o suggestedOrderQty>0).
//	                Si true, devuelve tambien VERDE/UNSET sin pedido.
//	unassigned_only bool|opc. filtra huérfanos vivos; no se combina con
//	                supplier_id.
//
// El orden final es autoritativo (banda / pedido / cobertura / demanda /
// nombre) y se aplica en el repositorio; el handler no ordena de nuevo.
var errConflictingSuggestionFilters = errors.New("unassigned_only no se puede combinar con supplier_id")

func parseSuggestionQueryParams(query url.Values) (repositories.SuggestionQueryParams, error) {
	params := repositories.SuggestionQueryParams{Search: query.Get("search")}

	if value := query.Get("supplier_id"); value != "" && value != "0" {
		parsed, err := strconv.ParseUint(value, 10, 32)
		if err != nil || parsed == 0 {
			return params, errors.New("supplier_id inválido")
		}
		id := uint(parsed)
		params.SupplierID = &id
	}

	for key, target := range map[string]*bool{
		"include_all":     &params.IncludeAll,
		"unassigned_only": &params.UnassignedOnly,
	} {
		if value := query.Get(key); value != "" {
			parsed, err := strconv.ParseBool(value)
			if err != nil {
				return params, errors.New(key + " inválido")
			}
			*target = parsed
		}
	}

	if params.UnassignedOnly && params.SupplierID != nil {
		return params, errConflictingSuggestionFilters
	}
	return params, nil
}

func (h *RestockV2Handler) GetSuggestionsV2(c *gin.Context) {
	params, err := parseSuggestionQueryParams(c.Request.URL.Query())
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	suggestions, err := h.metricsRepo.GetSuggestions(c.Request.Context(), params)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudieron cargar las sugerencias"})
		return
	}
	c.JSON(http.StatusOK, suggestions)
}

func (h *RestockV2Handler) TriggerManualCalculation(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Minute)
	defer cancel()

	if err := h.nightlySvc.RunNightlyMetricsCalculation(ctx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falló el cálculo de restock"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Cálculo nocturno de restock completado"})
}
