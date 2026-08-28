package middlewares

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

func TestAuthMiddlewareRejectsQueryTokensIncludingSSE(t *testing.T) {
	gin.SetMode(gin.TestMode)
	const secret = "test-secret"
	oldSecret := os.Getenv("SECRET_KEY")
	if err := os.Setenv("SECRET_KEY", secret); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if oldSecret == "" {
			if err := os.Unsetenv("SECRET_KEY"); err != nil {
				t.Errorf("unsetting SECRET_KEY: %v", err)
			}
			return
		}
		if err := os.Setenv("SECRET_KEY", oldSecret); err != nil {
			t.Errorf("restoring SECRET_KEY: %v", err)
		}
	})

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"dni":  "123",
		"role": "admin",
		"name": "Test",
		"exp":  time.Now().Add(time.Hour).Unix(),
	})
	signed, err := token.SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}

	router := gin.New()
	router.Use(AuthMiddleware())
	router.GET("/api/sse", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	router.GET("/api/restock/suggestions-v2", func(c *gin.Context) { c.Status(http.StatusNoContent) })

	sseRecorder := httptest.NewRecorder()
	sseRequest := httptest.NewRequest(http.MethodGet, "/api/sse?token="+signed, nil)
	router.ServeHTTP(sseRecorder, sseRequest)
	if sseRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("SSE query token status = %d; want %d", sseRecorder.Code, http.StatusUnauthorized)
	}

	sseHeaderRecorder := httptest.NewRecorder()
	sseHeaderRequest := httptest.NewRequest(http.MethodGet, "/api/sse", nil)
	sseHeaderRequest.Header.Set("Authorization", "Bearer "+signed)
	router.ServeHTTP(sseHeaderRecorder, sseHeaderRequest)
	if sseHeaderRecorder.Code != http.StatusNoContent {
		t.Fatalf("SSE Authorization header status = %d; want %d", sseHeaderRecorder.Code, http.StatusNoContent)
	}

	restockRecorder := httptest.NewRecorder()
	restockRequest := httptest.NewRequest(http.MethodGet, "/api/restock/suggestions-v2?token="+signed, nil)
	router.ServeHTTP(restockRecorder, restockRequest)
	if restockRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("non-SSE query token status = %d; want %d", restockRecorder.Code, http.StatusUnauthorized)
	}

	headerRecorder := httptest.NewRecorder()
	headerRequest := httptest.NewRequest(http.MethodGet, "/api/restock/suggestions-v2", nil)
	headerRequest.Header.Set("Authorization", "Bearer "+signed)
	router.ServeHTTP(headerRecorder, headerRequest)
	if headerRecorder.Code != http.StatusNoContent {
		t.Fatalf("Authorization header status = %d; want %d", headerRecorder.Code, http.StatusNoContent)
	}
}

func TestAuthMiddlewareRejectsMissingSecret(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setAuthTestSecret(t, "")

	router := gin.New()
	router.Use(AuthMiddleware())
	router.GET("/protected", func(c *gin.Context) { c.Status(http.StatusNoContent) })

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/protected", nil)
	request.Header.Set("Authorization", "Bearer arbitrary-token")
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d; want %d", recorder.Code, http.StatusInternalServerError)
	}
}

func TestAuthMiddlewareRejectsNonHS256AndUntypedIdentityClaims(t *testing.T) {
	gin.SetMode(gin.TestMode)
	const secret = "strict-test-secret"
	setAuthTestSecret(t, secret)

	tests := []struct {
		name   string
		method jwt.SigningMethod
		claims jwt.MapClaims
	}{
		{
			name:   "HS384",
			method: jwt.SigningMethodHS384,
			claims: jwt.MapClaims{"dni": "123", "role": "admin", "exp": time.Now().Add(time.Hour).Unix()},
		},
		{
			name:   "numeric dni",
			method: jwt.SigningMethodHS256,
			claims: jwt.MapClaims{"dni": float64(123), "role": "admin", "exp": time.Now().Add(time.Hour).Unix()},
		},
		{
			name:   "missing role",
			method: jwt.SigningMethodHS256,
			claims: jwt.MapClaims{"dni": "123", "exp": time.Now().Add(time.Hour).Unix()},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			token := jwt.NewWithClaims(test.method, test.claims)
			signed, err := token.SignedString([]byte(secret))
			if err != nil {
				t.Fatal(err)
			}

			router := gin.New()
			router.Use(AuthMiddleware())
			router.GET("/protected", func(c *gin.Context) { c.Status(http.StatusNoContent) })
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/protected", nil)
			request.Header.Set("Authorization", "Bearer "+signed)
			router.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d; want %d", recorder.Code, http.StatusUnauthorized)
			}
		})
	}
}

func setAuthTestSecret(t *testing.T, value string) {
	t.Helper()
	oldValue, existed := os.LookupEnv("SECRET_KEY")
	if value == "" {
		if err := os.Unsetenv("SECRET_KEY"); err != nil {
			t.Fatal(err)
		}
	} else if err := os.Setenv("SECRET_KEY", value); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if !existed {
			if err := os.Unsetenv("SECRET_KEY"); err != nil {
				t.Errorf("unsetting SECRET_KEY: %v", err)
			}
			return
		}
		if err := os.Setenv("SECRET_KEY", oldValue); err != nil {
			t.Errorf("restoring SECRET_KEY: %v", err)
		}
	})
}
