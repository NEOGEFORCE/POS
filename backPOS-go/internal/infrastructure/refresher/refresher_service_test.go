package refresher

import (
	"strings"
	"testing"
	"time"
)

func TestConcurrentRefreshStatementAllowsOnlyKnownViews(t *testing.T) {
	statement, err := concurrentRefreshStatement("mv_dashboard_stats_monthly")
	if err != nil {
		t.Fatal(err)
	}
	if statement != "REFRESH MATERIALIZED VIEW CONCURRENTLY mv_dashboard_stats_monthly" {
		t.Fatalf("statement = %q", statement)
	}
	if strings.Contains(statement, "MATERIALIZED VIEW mv_") {
		t.Fatalf("statement uses blocking refresh: %q", statement)
	}
	if _, err := concurrentRefreshStatement("mv_dashboard_stats_monthly; DROP TABLE sales"); err == nil {
		t.Fatal("unknown view was accepted")
	}
}

func TestRefreshRetryDelayIsBoundedForConfiguredAttempts(t *testing.T) {
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second}
	for i, expected := range want {
		if got := refreshRetryDelay(i + 1); got != expected {
			t.Errorf("attempt %d delay = %v, want %v", i+1, got, expected)
		}
	}
}
