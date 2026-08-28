package services

import (
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
)

func TestExpensesWithinRangeUsesInclusiveBoundaries(t *testing.T) {
	base := time.Date(2026, time.August, 27, 8, 0, 0, 0, time.UTC)
	expenses := []models.Expense{
		{ID: 1, Date: base.Add(-time.Second)},
		{ID: 2, Date: base},
		{ID: 3, Date: base.Add(time.Hour)},
		{ID: 4, Date: base.Add(2 * time.Hour)},
		{ID: 5, Date: base.Add(2*time.Hour + time.Second)},
	}
	got := expensesWithinRange(expenses, base, base.Add(2*time.Hour))
	if len(got) != 3 || got[0].ID != 2 || got[2].ID != 4 {
		t.Fatalf("expensesWithinRange() = %#v; want IDs 2,3,4", got)
	}
}

func TestExpensesWithinRangeRejectsInvalidRange(t *testing.T) {
	now := time.Now()
	if got := expensesWithinRange([]models.Expense{{ID: 1, Date: now}}, now, now.Add(-time.Second)); got != nil {
		t.Fatalf("invalid range returned %#v", got)
	}
}
