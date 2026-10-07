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
	"loansAdmin":          true,
}

// Excepciones deliberadas: rutas que usan un verbo de escritura pero REGISTRAN
// actividad nueva en vez de modificar o borrar algo ya existente.
//
// /sales/debts/:id/pay recibe el abono de un cliente en el mostrador. Es el
// equivalente de clients/pay-credit, que es POST y está permitido a empleados a
// propósito. Restringirlo dejaría al cajero sin poder recibir plata, que es lo
// contrario de lo que se busca proteger.
//
// /labels/print-jobs/:id/status cierra el ciclo del print job (queued →
// printed/failed/cancelled). Es "actividad operativa" del flujo de
// impresión; el bridge local lo invoca al terminar el pulso ESC/POS o
// la impresión del navegador cae a este patch. Restringirlo a admin
// rompería el autoreporte del bridge en caja (fix 2026-10-04).
var nonAdminWriteRoutes = map[string]bool{
	"/sales/debts/:id/pay":   true,
	"/print-jobs/:id/status": true,
}

// nonAdminMutationExceptions son endpoints POST que SI mutan una venta existente
// pero fueron autorizados conscientemente para empleados con reglas de negocio
// mucho mas estrechas. Cada uno queda documentado aqui para que la excepcion
// sea visible y auditable.
//
// /sales/correct-payment-channel/:id (septiembre 2026): el cajero puede
// corregir un error de medio de pago en una venta propia, dentro de su turno
// activo. El servicio bloquea cambios de total, cliente, productos, FIADO y
// ventas con devoluciones; registra auditoria critica con before/after.
// Es un camino auditado, no una puerta trasera a /sales/update-payment/:id
// (que sigue siendo admin-only). Ver sale_service_correct_payment.go.
//
// /sales/add-items/:id (2026-09): el cajero puede sumar o restar items en
// una venta propia. Reglas acotadas en sale_edit_plan.go.
var nonAdminMutationExceptions = map[string]bool{
	"/sales/correct-payment-channel/:id": true,
	"/sales/add-items/:id":               true,
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

// /sales/update-payment/:id tiene que seguir siendo admin-only: altera el
// cuadre de caja. Guardian explicito para que un refactor no lo baje al grupo
// de empleados por descuido.
func TestUpdatePaymentAdminOnly(t *testing.T) {
	data, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("no se pudo leer main.go: %v", err)
	}
	var encontrados int
	for i, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "//") || !strings.Contains(trimmed, "/sales/update-payment") {
			continue
		}
		encontrados++
		if !strings.Contains(trimmed, `RoleMiddleware("admin")`) {
			t.Errorf("main.go:%d /sales/update-payment debe ser admin-only: %s", i+1, trimmed)
		}
	}
	if encontrados == 0 {
		t.Fatal("no se encontro el registro de /sales/update-payment en main.go")
	}
}

// Documenta explicitamente que /sales/correct-payment-channel/:id es una
// excepcion deliberada: POST que modifica una venta existente pero esta
// autorizado para empleados con reglas acotadas (venta del mismo cajero
// dentro del turno activo, sin devoluciones, sin fiado). La prueba falla si
// la ruta no se registra o si no esta protegida por RoleMiddleware.
func TestCorrectPaymentChannelExcepcionDocumentada(t *testing.T) {
	data, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("no se pudo leer main.go: %v", err)
	}
	var encontrados int
	for i, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "//") || !strings.Contains(trimmed, "/sales/correct-payment-channel") {
			continue
		}
		encontrados++
		// Debe exigir sesion autenticada (empleado o admin acepta ambos).
		if !strings.Contains(trimmed, "RoleMiddleware") {
			t.Errorf("main.go:%d /sales/correct-payment-channel debe exigir sesion autenticada via RoleMiddleware: %s",
				i+1, trimmed)
		}
	}
	if encontrados == 0 {
		t.Fatal("no se encontro el registro de /sales/correct-payment-channel en main.go")
	}
	if !nonAdminMutationExceptions["/sales/correct-payment-channel/:id"] {
		t.Fatal("la ruta debe aparecer en nonAdminMutationExceptions para que la excepcion quede documentada")
	}
}
