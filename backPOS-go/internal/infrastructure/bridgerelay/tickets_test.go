package bridgerelay

import (
	"errors"
	"testing"
	"time"
)

func TestTicketStore_IssueAndConsume(t *testing.T) {
	now := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
	store := NewTicketStore(func() time.Time { return now })

	ident := TicketIdentity{
		CajaID:  "CAJA-01",
		DNI:     "12345",
		Name:    "Juanita",
		Role:    "admin",
		IsAdmin: true,
	}
	tok, err := store.Issue(ident)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if tok == "" {
		t.Fatal("token vacío")
	}

	got, err := store.Consume(tok)
	if err != nil {
		t.Fatalf("Consume: %v", err)
	}
	if got != ident {
		t.Fatalf("want %+v, got %+v", ident, got)
	}
}

func TestTicketStore_ConsumeRejectsReuse(t *testing.T) {
	now := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
	store := NewTicketStore(func() time.Time { return now })

	tok, err := store.Issue(TicketIdentity{CajaID: "CAJA-01", DNI: "1"})
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if _, err := store.Consume(tok); err != nil {
		t.Fatalf("primer consume: %v", err)
	}
	_, err = store.Consume(tok)
	if !errors.Is(err, ErrTicketReused) {
		t.Fatalf("segundo consume debería ser ErrTicketReused, got %v", err)
	}
}

func TestTicketStore_ConsumeExpired(t *testing.T) {
	base := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
	nowFn := func() time.Time { return base }
	store := NewTicketStore(nowFn)

	tok, err := store.Issue(TicketIdentity{CajaID: "CAJA-01"})
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	base = base.Add(TicketTTL + time.Second)
	_, err = store.Consume(tok)
	if !errors.Is(err, ErrTicketExpired) {
		t.Fatalf("want ErrTicketExpired, got %v", err)
	}
	if store.Len() != 0 {
		t.Fatalf("ticket vencido debe desaparecer, Len=%d", store.Len())
	}
}

func TestTicketStore_ConsumeNotFound(t *testing.T) {
	store := NewTicketStore(nil)
	if _, err := store.Consume(""); !errors.Is(err, ErrTicketNotFound) {
		t.Fatalf("Consume(\"\") want ErrTicketNotFound, got %v", err)
	}
	if _, err := store.Consume("otro"); !errors.Is(err, ErrTicketNotFound) {
		t.Fatalf("Consume desconocido want ErrTicketNotFound, got %v", err)
	}
}

func TestTicketStore_PurgePreviosExpirados(t *testing.T) {
	base := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
	store := NewTicketStore(func() time.Time { return base })
	for i := 0; i < 5; i++ {
		_, err := store.Issue(TicketIdentity{CajaID: "CAJA-01"})
		if err != nil {
			t.Fatalf("Issue %d: %v", i, err)
		}
	}
	if store.Len() != 5 {
		t.Fatalf("want 5, got %d", store.Len())
	}

	// Avanzamos más allá del TTL; el siguiente Issue barre lo viejo.
	base = base.Add(TicketTTL + time.Second)
	_, err := store.Issue(TicketIdentity{CajaID: "CAJA-02"})
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if store.Len() != 1 {
		t.Fatalf("tras purge want 1, got %d", store.Len())
	}
}
