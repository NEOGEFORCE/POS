package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// TestNormalizePageSize_Bordes fija el contrato del tope: recortar, nunca
// rechazar. Un 400 por pedir demasiadas filas rompería pantallas que hoy
// funcionan; servir 200 en vez de 999999 no rompe nada.
func TestNormalizePageSize_Bordes(t *testing.T) {
	cases := []struct {
		name     string
		pageSize int
		def      int
		want     int
	}{
		{"cero cae al default", 0, 50, 50},
		{"negativo cae al default", -1, 50, 50},
		{"muy negativo cae al default", -999999, 10, 10},
		{"valor normal se respeta", 25, 50, 25},
		{"justo en el tope se respeta", MaxPageSize, 50, MaxPageSize},
		{"uno por encima se recorta", MaxPageSize + 1, 50, MaxPageSize},
		{"numero enorme se recorta", 999999, 50, MaxPageSize},
		{"int grande se recorta", 1 << 30, 10, MaxPageSize},
		{"default invalido cae al tope", 0, 0, MaxPageSize},
		{"default por encima del tope se recorta", 0, 100000, MaxPageSize},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := NormalizePageSize(tc.pageSize, tc.def); got != tc.want {
				t.Errorf("NormalizePageSize(%d, %d) = %d; want %d",
					tc.pageSize, tc.def, got, tc.want)
			}
		})
	}
}

func TestNormalizePage_Bordes(t *testing.T) {
	cases := []struct{ in, want int }{
		{0, 1}, {-1, 1}, {-500, 1}, {1, 1}, {7, 7},
	}
	for _, tc := range cases {
		if got := NormalizePage(tc.in); got != tc.want {
			t.Errorf("NormalizePage(%d) = %d; want %d", tc.in, got, tc.want)
		}
	}
}

func ctxWithQuery(rawQuery string) *gin.Context {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodGet, "/x?"+rawQuery, nil)
	return c
}

// TestQueryPageSize_EntradaBasura cubre el borde que el usuario pidió explícito:
// texto no numérico. strconv.Atoi devuelve 0 y el 0 cae al default, así que
// ?pageSize=muchos NO deja el tamaño en cero (que sería una página vacía) ni
// desactiva el tope.
func TestQueryPageSize_EntradaBasura(t *testing.T) {
	cases := []struct {
		query string
		def   int
		want  int
	}{
		{"pageSize=abc", 50, 50},
		{"pageSize=", 50, 50},
		{"", 50, 50},
		{"pageSize=10.5", 50, 50},
		{"pageSize=1e9", 50, 50},
		{"pageSize=0", 50, 50},
		{"pageSize=-20", 50, 50},
		{"pageSize=999999", 50, MaxPageSize},
		{"pageSize=99999999999999999999", 50, MaxPageSize}, // desborda int64: Atoi devuelve ErrRange y el máximo
		{"pageSize=30", 50, 30},
	}
	for _, tc := range cases {
		t.Run(tc.query, func(t *testing.T) {
			got := QueryPageSize(ctxWithQuery(tc.query), "pageSize", tc.def)
			if got != tc.want {
				t.Errorf("QueryPageSize(%q) = %d; want %d", tc.query, got, tc.want)
			}
			if got > MaxPageSize {
				t.Errorf("QueryPageSize(%q) = %d superó el tope %d", tc.query, got, MaxPageSize)
			}
			if got <= 0 {
				t.Errorf("QueryPageSize(%q) = %d; una página nunca puede ser vacía", tc.query, got)
			}
		})
	}
}

func TestQueryOffset_NegativoSeColapsaACero(t *testing.T) {
	cases := []struct {
		query string
		want  int
	}{
		{"offset=-5", 0},
		{"offset=abc", 0},
		{"", 0},
		{"offset=0", 0},
		{"offset=120", 120},
	}
	for _, tc := range cases {
		if got := QueryOffset(ctxWithQuery(tc.query), "offset"); got != tc.want {
			t.Errorf("QueryOffset(%q) = %d; want %d", tc.query, got, tc.want)
		}
	}
}

// TestMaxPageSize_EsFuenteUnica documenta por qué el tope vive en una constante:
// si alguien vuelve a escribir el número a mano en un handler, este test no lo
// detecta, pero sí queda fijado el valor acordado para que el cambio sea
// consciente y deliberado.
func TestMaxPageSize_ValorAcordado(t *testing.T) {
	if MaxPageSize != 200 {
		t.Errorf("MaxPageSize cambió a %d; el tope acordado con el dueño es 200", MaxPageSize)
	}
}
