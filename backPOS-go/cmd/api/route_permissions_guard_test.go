package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// Decisión del dueño (2026-09-05): "todo lo que sea borrar o editar o eliminar
// dejalo solo para administrador o superadmin".
//
// Este guardián es estático: lee main.go y verifica que cada ruta DELETE, PUT o
// PATCH quede detrás de RoleMiddleware("admin"). RoleMiddleware acepta admin y
// superadmin, así que con "admin" alcanza para cubrir ambos.
//
// Existe porque el problema real no fue una ruta mal escrita sino una TRAMPA
// VISUAL: varias rutas estaban escritas dentro del bloque comentado como
// "Products Administration (Solo Admin)" pero registradas sobre productManage,
// que es el grupo de empleados. Leyendo el archivo parecían protegidas. Un test
// que compara el grupo real y no el comentario es lo único que detecta eso.

// Grupos que ya aplican RoleMiddleware("admin") en su declaración.
var adminRouterGroups = map[string]bool{
	"productAdmin":        true,
	"categoryAdmin":       true,
	"supplierAdmin":       true,
	"clientAdmin":         true,
	"returnsAdmin":        true,
	"expenseAdminActions": true,
	"adminGroup":          true,
}

// Excepciones deliberadas: rutas que usan un verbo de escritura pero REGISTRAN
// actividad nueva en vez de modificar o borrar algo ya existente.
//
// /sales/debts/:id/pay recibe el abono de un cliente en el mostrador. Es el
// equivalente de clients/pay-credit, que es POST y está permitido a empleados a
// propósito. Restringirlo dejaría al cajero sin poder recibir plata, que es lo
// contrario de lo que se busca proteger.
var nonAdminWriteRoutes = map[string]bool{
	"/sales/debts/:id/pay": true,
}

var writeRouteRE = regexp.MustCompile(`(\w+)\.(DELETE|PUT|PATCH)\("([^"]*)"(.*)$`)

func TestRutasDestructivasSoloAdmin(t *testing.T) {
	data, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("no se pudo leer main.go: %v", err)
	}

	var revisadas int
	for i, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "//") {
			continue
		}
		m := writeRouteRE.FindStringSubmatch(trimmed)
		if m == nil {
			continue
		}
		grupo, verbo, ruta, resto := m[1], m[2], m[3], m[4]
		revisadas++

		if nonAdminWriteRoutes[ruta] {
			continue
		}
		// Protegida por el grupo, o por un middleware puesto en la propia ruta.
		if adminRouterGroups[grupo] || strings.Contains(resto, `RoleMiddleware("admin")`) {
			continue
		}
		t.Errorf(
			"main.go:%d %s %s se registra sobre %q sin RoleMiddleware(\"admin\").\n"+
				"Borrar o editar es exclusivo de admin/superadmin. Movela a un grupo admin, "+
				"agregale el middleware en la ruta, o declarala como excepcion en nonAdminWriteRoutes "+
				"explicando por que registra actividad nueva en vez de modificar datos.",
			i+1, verbo, ruta, grupo,
		)
	}

	if revisadas < 20 {
		t.Fatalf("solo se encontraron %d rutas de escritura; el guardian probablemente dejo de leer main.go correctamente", revisadas)
	}
}

// Verifica que mark-received esté protegido en TODOS sus verbos. El handler está
// registrado en PUT y en POST; proteger uno solo dejaría el otro como puerta
// trasera para el mismo efecto.
func TestMarkReceivedProtegidoEnAmbosVerbos(t *testing.T) {
	data, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("no se pudo leer main.go: %v", err)
	}

	var encontrados int
	for i, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "//") || !strings.Contains(trimmed, "mark-received") {
			continue
		}
		encontrados++
		if !strings.HasPrefix(trimmed, "productAdmin.") && !strings.Contains(trimmed, `RoleMiddleware("admin")`) {
			t.Errorf("main.go:%d mark-received registrado sin restriccion de admin: %s", i+1, trimmed)
		}
	}
	if encontrados < 2 {
		t.Fatalf("se esperaban al menos 2 registros de mark-received (PUT y POST), se encontraron %d", encontrados)
	}
}
