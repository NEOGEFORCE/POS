package handlers

import (
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// =============================================================================
// B5 — Autorización de la bandeja/stream GLOBAL de QR
// =============================================================================
//
// `scope=all` en /pendientes y /caja-stream es la bandeja global para que
// admin/superadmin vean los QR en espera desde cualquier pantalla. Debe
// rechazarse para el rol empleado (403). Si falta sesión, 401.

func TestPosQrHandler_Pendientes_ScopeAll_SinSesion_401(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodGet, "/api/pos/pagos-qr/pendientes?scope=all", "")
	h.Pendientes(c)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión debe 401, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestPosQrHandler_Pendientes_ScopeAll_RolEmpleado_403(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodGet, "/api/pos/pagos-qr/pendientes?scope=all", "")
	c.Set("userDni", "EMP-1")
	c.Set("role", "empleado")
	h.Pendientes(c)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("empleado con scope=all debe 403, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "ERR_FORBIDDEN") {
		t.Fatalf("respuesta debe incluir code ERR_FORBIDDEN; body=%s", rec.Body.String())
	}
}

func TestPosQrHandler_Pendientes_ScopeAll_EmployeeAlias_403(t *testing.T) {
	// Alias "employee" se normaliza a empleado en el middleware, pero en
	// actorIsAdmin se compara literal con "empleado". Un token con role
	// "employee" también debe ser rechazado para scope=all.
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodGet, "/api/pos/pagos-qr/pendientes?scope=all", "")
	c.Set("userDni", "EMP-1")
	c.Set("role", "employee")
	h.Pendientes(c)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("employee con scope=all debe 403, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestPosQrHandler_Pendientes_ScopeCaja_SinCajaID_400(t *testing.T) {
	// Modo sin scope: cuando no viene caja_id, 400.
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodGet, "/api/pos/pagos-qr/pendientes", "")
	c.Set("userDni", "EMP-1")
	c.Set("role", "empleado")
	h.Pendientes(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("sin caja_id y sin scope=all debe 400, got %d", rec.Code)
	}
}

// CajaStream es un SSE; para el modo scope=all sin rol admin, la
// autorización se verifica antes de hacer upgrade a stream, así que
// podemos chequear el 403 con el mismo patrón de ResponseRecorder.

func TestPosQrHandler_CajaStream_ScopeAll_SinSesion_401(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodGet, "/api/pos/pagos-qr/caja-stream?scope=all", "")
	h.CajaStream(c)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión debe 401, got %d", rec.Code)
	}
}

func TestPosQrHandler_CajaStream_ScopeAll_RolEmpleado_403(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodGet, "/api/pos/pagos-qr/caja-stream?scope=all", "")
	c.Set("userDni", "EMP-1")
	c.Set("role", "empleado")
	h.CajaStream(c)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("empleado con scope=all debe 403, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

// Verifica que `role` admin y superadmin pasen el gate de autorización.
// No podemos ejercitar el handler completo sin un servicio real (requiere
// BD/stub), así que probamos directamente la función de autorización
// `actorIsAdmin`, que es la misma que usa el handler.

func TestActorIsAdmin_AceptaAdminSuperadminAdministrador(t *testing.T) {
	cases := map[string]bool{
		"admin":         true,
		"ADMIN":         true,
		"administrador": true,
		"superadmin":    true,
		"SUPERADMIN":    true,
		"empleado":      false,
		"employee":      false,
		"":              false,
	}
	for role, want := range cases {
		c, _ := gin.CreateTestContext(nil)
		c.Set("role", role)
		got := actorIsAdmin(c)
		if got != want {
			t.Errorf("actorIsAdmin(role=%q) = %v; want %v", role, got, want)
		}
	}
}

func TestActorIsAdmin_SinRoleEnContexto_FalseFailClosed(t *testing.T) {
	c, _ := gin.CreateTestContext(nil)
	// No seteamos role.
	if actorIsAdmin(c) {
		t.Fatal("sin role en contexto, actorIsAdmin debe devolver false (fail-closed)")
	}
}

// Garantía de contrato: `scope` se compara en minúsculas para que
// SCOPE=ALL también funcione. (Chequeado por igual con empleado -> 403.)
func TestPosQrHandler_Pendientes_ScopeAll_CaseInsensitive(t *testing.T) {
	h := &PosQrHandler{}
	// scope=ALL en mayúsculas, con empleado, debe 403 (no 400 por caja_id
	// faltante). Prueba que el handler normaliza antes de ramificar.
	c, rec := newQrTestContext(http.MethodGet, "/api/pos/pagos-qr/pendientes?scope=ALL", "")
	c.Set("userDni", "EMP-1")
	c.Set("role", "empleado")
	h.Pendientes(c)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("scope=ALL (case-insensitive) con empleado debe 403, got %d", rec.Code)
	}
}

// Asegura que, si gin.Context no trae role, actorIsAdmin devuelve false y
// scope=all responde 403 (fail-closed).
func TestPosQrHandler_Pendientes_ScopeAll_SinRole_403(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodGet, "/api/pos/pagos-qr/pendientes?scope=all", "")
	c.Set("userDni", "X")
	// no seteamos role
	h.Pendientes(c)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("sin role, scope=all debe 403; got %d", rec.Code)
	}
}
