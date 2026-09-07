package handlers

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestParseSuggestionQueryParamsUnassigned(t *testing.T) {
	params, err := parseSuggestionQueryParams(url.Values{
		"unassigned_only": {"true"},
		"include_all":     {"true"},
		"search":          {" arroz "},
	})
	if err != nil {
		t.Fatalf("parseSuggestionQueryParams() error = %v", err)
	}
	if !params.UnassignedOnly || !params.IncludeAll || params.SupplierID != nil {
		t.Fatalf("params inesperados: %+v", params)
	}
	if params.Search != " arroz " {
		t.Fatalf("Search = %q; el repositorio debe encargarse del trim", params.Search)
	}
}

func TestParseSuggestionQueryParamsRechazaProveedorConUnassigned(t *testing.T) {
	_, err := parseSuggestionQueryParams(url.Values{
		"unassigned_only": {"true"},
		"supplier_id":     {"42"},
	})
	if !errors.Is(err, errConflictingSuggestionFilters) {
		t.Fatalf("error = %v, want conflicto de filtros", err)
	}
}

func TestParseSuggestionQueryParamsRechazaBooleanoInvalido(t *testing.T) {
	_, err := parseSuggestionQueryParams(url.Values{"unassigned_only": {"quizá"}})
	if err == nil {
		t.Fatal("se esperaba error para unassigned_only inválido")
	}
}

func TestGetSuggestionsV2ConflictoResponde400(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler := &RestockV2Handler{}
	router.GET("/restock", handler.GetSuggestionsV2)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/restock?unassigned_only=true&supplier_id=8", nil)
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", recorder.Code, recorder.Body.String())
	}
}
