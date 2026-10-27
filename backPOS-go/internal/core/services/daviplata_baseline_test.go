package services

import (
	"errors"
	"testing"
	"time"
)

type fakeDaviNet struct {
	net   float64
	err   error
	since time.Time
}

func (f *fakeDaviNet) DaviplataNetSince(since time.Time) (float64, error) {
	f.since = since
	return f.net, f.err
}

func TestDaviplataBaselineBalance_SumaMovimientosDesdeElCorte(t *testing.T) {
	f := &fakeDaviNet{net: 21900 - 5000}
	got, ok := daviplataBaselineBalance(f)
	if !ok || got != DaviplataBaselineAmount+16900 {
		t.Fatalf("saldo = %v ok=%v, want 327955", got, ok)
	}
	if !f.since.Equal(DaviplataBaselineAt) {
		t.Errorf("corte = %v, want %v", f.since, DaviplataBaselineAt)
	}
}

func TestDaviplataBaselineBalance_FallbackSinSoporteOError(t *testing.T) {
	if _, ok := daviplataBaselineBalance(struct{}{}); ok {
		t.Error("repo sin soporte debe caer al cálculo histórico")
	}
	if _, ok := daviplataBaselineBalance(&fakeDaviNet{err: errors.New("db")}); ok {
		t.Error("error de consulta debe caer al cálculo histórico")
	}
}
