package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestMain(m *testing.M) {
	gin.SetMode(gin.TestMode)
	os.Exit(m.Run())
}

// preparaRaizServida arma una carpeta pública con un index.html y un asset, y
// deja un archivo SECRETO fuera de ella para comprobar que el middleware no lo
// pueda alcanzar por travesía de rutas.
func preparaRaizServida(t *testing.T) (publicPath, secretoPath string) {
	t.Helper()
	base := t.TempDir()

	publicPath = filepath.Join(base, "out")
	if err := os.MkdirAll(filepath.Join(publicPath, "_next"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	escribir := func(p, contenido string) {
		if err := os.WriteFile(p, []byte(contenido), 0o600); err != nil {
			t.Fatalf("write %s: %v", p, err)
		}
	}
	escribir(filepath.Join(publicPath, "index.html"), "<html>SPA</html>")
	escribir(filepath.Join(publicPath, "dashboard.html"), "<html>DASHBOARD</html>")
	escribir(filepath.Join(publicPath, "_next", "app.js"), "console.log(1)")

	// Fuera de la raíz servida: el equivalente de un .env o una clave privada.
	secretoPath = filepath.Join(base, "secreto.txt")
	escribir(secretoPath, "DB_PASSWORD=no-debe-salir")

	// Y un hermano cuyo nombre EMPIEZA con el de la raíz: "out-privado" es
	// prefijo textual de "out", así que una comparación ingenua de strings lo
	// dejaría pasar.
	if err := os.MkdirAll(base+string(os.PathSeparator)+"out-privado", 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	escribir(filepath.Join(base, "out-privado", "clave.txt"), "clave-privada")

	return publicPath, secretoPath
}

func routerConFallback(publicPath string) *gin.Engine {
	r := gin.New()
	r.NoRoute(spaFallbackMiddleware(publicPath))
	return r
}

func pedir(r *gin.Engine, method, target string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, target, nil)
	r.ServeHTTP(rec, req)
	return rec
}

// TestSpaFallback_TxtDocumentoRedirigeASinExtension documenta el contrato
// nuevo: cuando el navegador aterriza directamente en un payload .txt de Next
// (pegaron la URL en la barra, el link vino por chat, etc.), redirigimos a la
// misma ruta sin extensión con 307 + no-cache, para que la SPA tome control.
func TestSpaFallback_TxtDocumentoRedirigeASinExtension(t *testing.T) {
	publicPath, _ := preparaRaizServida(t)
	// Dejar también el archivo .txt en disco para asegurarnos de que el
	// redirect NO depende de que no exista: el archivo real existe, pero una
	// navegación de documento no debe recibirlo.
	if err := os.WriteFile(filepath.Join(publicPath, "dashboard.txt"), []byte("RSC_PAYLOAD_REAL"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	r := routerConFallback(publicPath)

	casos := []struct {
		name    string
		headers map[string]string
	}{
		{
			name: "Sec-Fetch-Dest=document",
			headers: map[string]string{
				"Sec-Fetch-Dest": "document",
			},
		},
		{
			name: "Accept text/html sin RSC",
			headers: map[string]string{
				"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			},
		},
		{
			name: "document aunque haya Accept raro",
			headers: map[string]string{
				"Sec-Fetch-Dest": "document",
				"Accept":         "*/*",
			},
		},
	}
	for _, caso := range casos {
		t.Run(caso.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/dashboard.txt", nil)
			for k, v := range caso.headers {
				req.Header.Set(k, v)
			}
			r.ServeHTTP(rec, req)

			if rec.Code != http.StatusTemporaryRedirect {
				t.Fatalf("status = %d; want %d", rec.Code, http.StatusTemporaryRedirect)
			}
			if loc := rec.Header().Get("Location"); loc != "/dashboard" {
				t.Errorf("Location = %q; want %q", loc, "/dashboard")
			}
			if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "no-cache") {
				t.Errorf("Cache-Control = %q; se esperaba no-cache", cc)
			}
			if strings.Contains(rec.Body.String(), "RSC_PAYLOAD_REAL") {
				t.Errorf("una navegación de documento no debe recibir el payload real: %s", rec.Body.String())
			}
		})
	}
}

// TestSpaFallback_TxtRscInternoSirveArchivoReal: los fetch del router de Next
// (prefetch, streaming RSC) deben recibir el `.txt` real tal como está en disco
// para que la hidratación funcione.
func TestSpaFallback_TxtRscInternoSirveArchivoReal(t *testing.T) {
	publicPath, _ := preparaRaizServida(t)
	if err := os.WriteFile(filepath.Join(publicPath, "dashboard.txt"), []byte("RSC_PAYLOAD_REAL"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	r := routerConFallback(publicPath)

	casos := []struct {
		name    string
		headers map[string]string
	}{
		{
			name:    "header RSC: 1",
			headers: map[string]string{"RSC": "1"},
		},
		{
			name:    "Next-Router-State-Tree",
			headers: map[string]string{"Next-Router-State-Tree": "[\"\",{}]"},
		},
		{
			name:    "Next-Router-Prefetch",
			headers: map[string]string{"Next-Router-Prefetch": "1"},
		},
		{
			name:    "Sec-Fetch-Dest=empty",
			headers: map[string]string{"Sec-Fetch-Dest": "empty"},
		},
		{
			name: "RSC gana sobre Sec-Fetch-Dest=document",
			headers: map[string]string{
				"RSC":            "1",
				"Sec-Fetch-Dest": "document",
			},
		},
	}
	for _, caso := range casos {
		t.Run(caso.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/dashboard.txt", nil)
			for k, v := range caso.headers {
				req.Header.Set(k, v)
			}
			r.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d; want 200 (fetch interno recibe el .txt real)", rec.Code)
			}
			if rec.Header().Get("Location") != "" {
				t.Errorf("Location no debe estar presente: %q", rec.Header().Get("Location"))
			}
			if !strings.Contains(rec.Body.String(), "RSC_PAYLOAD_REAL") {
				t.Errorf("se esperaba el payload real; got %q", rec.Body.String())
			}
		})
	}
}

// TestSpaFallback_TxtDocumentoPreservaQuery asegura que la query string sobrevive
// al redirect y mantiene el formato original percent-encoded.
func TestSpaFallback_TxtDocumentoPreservaQuery(t *testing.T) {
	publicPath, _ := preparaRaizServida(t)
	r := routerConFallback(publicPath)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/sales/new.txt?focus=cart&term=hola%20mundo", nil)
	req.Header.Set("Sec-Fetch-Dest", "document")
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusTemporaryRedirect {
		t.Fatalf("status = %d; want %d", rec.Code, http.StatusTemporaryRedirect)
	}
	want := "/sales/new?focus=cart&term=hola%20mundo"
	if loc := rec.Header().Get("Location"); loc != want {
		t.Errorf("Location = %q; want %q", loc, want)
	}
}

// TestSpaFallback_TxtNoAfectaOtrosAssets asegura que los assets no .txt no son
// redirigidos ni tocados por la nueva lógica.
func TestSpaFallback_TxtNoAfectaOtrosAssets(t *testing.T) {
	publicPath, _ := preparaRaizServida(t)
	r := routerConFallback(publicPath)

	t.Run("js con Sec-Fetch-Dest=document no redirige", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/_next/app.js", nil)
		req.Header.Set("Sec-Fetch-Dest", "document")
		req.Header.Set("Accept", "text/html")
		r.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d; want 200", rec.Code)
		}
		if rec.Header().Get("Location") != "" {
			t.Errorf("Location no debe fijarse para un asset no .txt")
		}
		if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
			t.Errorf("Cache-Control = %q; se esperaba cacheo inmutable", cc)
		}
	})

	t.Run("ruta sin extensión sigue cayendo en SPA", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/dashboard", nil)
		req.Header.Set("Sec-Fetch-Dest", "document")
		req.Header.Set("Accept", "text/html")
		r.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d; want 200 (SPA sigue sirviendo el HTML)", rec.Code)
		}
		if rec.Header().Get("Location") != "" {
			t.Errorf("no debe redirigir una ruta ya sin .txt: %q", rec.Header().Get("Location"))
		}
	})

	t.Run("txt sin señales rsc ni documento → sirve asset", func(t *testing.T) {
		// Un cliente curl que no manda ningún header de intención: por diseño,
		// como no afirma ser documento, lo tratamos como fetch (sin redirect).
		if err := os.WriteFile(filepath.Join(publicPath, "robots.txt"), []byte("User-Agent: *"), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		rec := pedir(r, http.MethodGet, "/robots.txt")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d; want 200", rec.Code)
		}
		if rec.Header().Get("Location") != "" {
			t.Errorf("no debe redirigir sin señales de documento")
		}
		if !strings.Contains(rec.Body.String(), "User-Agent") {
			t.Errorf("se esperaba el contenido real del robots.txt")
		}
	})
}

// TestSpaFallback_NoEscapaDeLaCarpetaServida es el guardián de la travesía de
// rutas. filepath.Join limpia los ".." ANTES de unir, así que sin verificación
// de contención el middleware servía cualquier archivo del disco del servidor.
func TestSpaFallback_NoEscapaDeLaCarpetaServida(t *testing.T) {
	publicPath, secretoPath := preparaRaizServida(t)
	r := routerConFallback(publicPath)

	secreto, err := os.ReadFile(secretoPath)
	if err != nil {
		t.Fatalf("no se pudo leer el archivo señuelo: %v", err)
	}

	ataques := []string{
		"/../secreto.txt",
		"/../../secreto.txt",
		"/..%2fsecreto.txt",
		"/_next/../../secreto.txt",
		"/%2e%2e/secreto.txt",
		"/..\\secreto.txt",
		"/../out-privado/clave.txt",
	}

	for _, target := range ataques {
		t.Run(target, func(t *testing.T) {
			rec := pedir(r, http.MethodGet, target)
			cuerpo := rec.Body.String()

			if strings.Contains(cuerpo, string(secreto)) {
				t.Fatalf("%s filtró el archivo de fuera de la raíz: %s", target, cuerpo)
			}
			if strings.Contains(cuerpo, "clave-privada") {
				t.Fatalf("%s alcanzó la carpeta hermana out-privado", target)
			}
		})
	}
}

// TestSpaFallback_ApiInexistenteDevuelve404JSON: antes, un GET a una ruta de API
// mal escrita (o el verbo equivocado sobre una ruta buena) respondía 200 con
// index.html. El cliente veía éxito, el cuerpo era HTML donde esperaba JSON, y
// cualquier diagnóstico arrancaba con una pista falsa.
func TestSpaFallback_ApiInexistenteDevuelve404JSON(t *testing.T) {
	publicPath, _ := preparaRaizServida(t)
	r := routerConFallback(publicPath)

	casos := []struct {
		method string
		target string
	}{
		{http.MethodGet, "/api/no-existe"},
		{http.MethodPost, "/api/products/create-products"}, // verbo válido, ruta no registrada en este router
		{http.MethodDelete, "/api/sales/999"},
		{http.MethodGet, "/api"},
		{http.MethodPut, "/api/admin/users"},
	}

	for _, caso := range casos {
		t.Run(caso.method+" "+caso.target, func(t *testing.T) {
			rec := pedir(r, caso.method, caso.target)

			if rec.Code != http.StatusNotFound {
				t.Errorf("status = %d; want 404 (antes devolvía 200 con index.html)", rec.Code)
			}
			if strings.Contains(rec.Body.String(), "<html>") {
				t.Errorf("una ruta de API no puede responder HTML: %s", rec.Body.String())
			}

			var parsed map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
				t.Fatalf("el cuerpo no es JSON: %v (%s)", err, rec.Body.String())
			}
			if ok, _ := parsed["success"].(bool); ok {
				t.Error("success debe ser false")
			}
		})
	}
}

// TestSpaFallback_SigueSirviendoLaSPA: el endurecimiento no puede romper el
// comportamiento normal. Rutas de la app siguen devolviendo su HTML y los assets
// siguen saliendo con cacheo largo.
func TestSpaFallback_SigueSirviendoLaSPA(t *testing.T) {
	publicPath, _ := preparaRaizServida(t)
	r := routerConFallback(publicPath)

	t.Run("ruta con html propio", func(t *testing.T) {
		rec := pedir(r, http.MethodGet, "/dashboard")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d; want 200", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "DASHBOARD") {
			t.Errorf("no sirvió dashboard.html: %s", rec.Body.String())
		}
	})

	t.Run("ruta sin html cae en index", func(t *testing.T) {
		rec := pedir(r, http.MethodGet, "/products/nuevo")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d; want 200", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "SPA") {
			t.Errorf("no cayó en index.html: %s", rec.Body.String())
		}
	})

	t.Run("asset js con cacheo inmutable", func(t *testing.T) {
		rec := pedir(r, http.MethodGet, "/_next/app.js")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d; want 200", rec.Code)
		}
		if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
			t.Errorf("Cache-Control = %q; se esperaba cacheo inmutable", cc)
		}
	})

	t.Run("asset inexistente da 404", func(t *testing.T) {
		if rec := pedir(r, http.MethodGet, "/_next/no-existe.js"); rec.Code != http.StatusNotFound {
			t.Errorf("status = %d; want 404", rec.Code)
		}
	})
}

// TestResolveWithinRoot cubre la primitiva directamente.
//
// La invariante es de CONTENCIÓN, no de rechazo: una ruta con ".." puede
// aceptarse siempre que haya quedado colapsada DENTRO de la raíz (ahí sólo
// producirá un 404 al no existir el archivo). Lo que jamás puede pasar es que la
// función devuelva una ruta fuera de la raíz.
func TestResolveWithinRoot(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "out")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		t.Fatalf("abs: %v", err)
	}

	legitimas := []string{"/index.html", "/_next/app.js", "/", "/a/b/c.png"}
	for _, p := range legitimas {
		got, ok := resolveWithinRoot(root, p)
		if !ok {
			t.Errorf("resolveWithinRoot(%q) rechazó una ruta legítima", p)
			continue
		}
		if !strings.HasPrefix(got, absRoot) {
			t.Errorf("resolveWithinRoot(%q) = %q; se salió de %q", p, got, absRoot)
		}
	}

	// Intentos de travesía: o se rechazan, o quedan contenidos. Nunca apuntan
	// fuera de la raíz.
	travesias := []string{
		"/../secreto.txt",
		"/../../../../etc/passwd",
		"/../out-privado/clave.txt",
		"/a/../../fuera.txt",
		"/..\\secreto.txt",
		"/_next/../../../secreto.txt",
		"//../secreto.txt",
		"/./../secreto.txt",
	}
	for _, p := range travesias {
		got, ok := resolveWithinRoot(root, p)
		if !ok {
			continue // rechazada: correcto
		}
		if got != absRoot && !strings.HasPrefix(got, absRoot+string(os.PathSeparator)) {
			t.Errorf("resolveWithinRoot(%q) = %q; APUNTA FUERA de la raíz %q", p, got, absRoot)
		}
	}
}
