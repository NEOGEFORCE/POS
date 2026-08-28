package models

import "testing"

func days(value int) *int { return &value }

func TestRecommendationDoesNotReorderWhatIsAlreadyOnTheWay(t *testing.T) {
	message, level := BuildRestockRecommendation(RestockDecisionInput{
		InTransitQty: 12, SuggestedOrderQty: 20, AvgDailySales: 2, ABCCategory: "A",
	})
	if level != RestockLevelWait {
		t.Fatalf("nivel = %s, want %s (%s)", level, RestockLevelWait, message)
	}
}

func TestRecommendationFlagsSoldOutProductsAsUrgent(t *testing.T) {
	message, level := BuildRestockRecommendation(RestockDecisionInput{
		CurrentStock: 0, AvgDailySales: 1.36, ABCCategory: "A", SuggestedOrderQty: 10,
	})
	if level != RestockLevelUrgent {
		t.Fatalf("nivel = %s, want %s (%s)", level, RestockLevelUrgent, message)
	}
}

func TestRecommendationSkipsRecentlyReceivedProducts(t *testing.T) {
	for _, elapsed := range []int{0, 1} {
		message, level := BuildRestockRecommendation(RestockDecisionInput{
			CurrentStock: 5, AvgDailySales: 2, ABCCategory: "A",
			SuggestedOrderQty: 8, DaysSinceReception: days(elapsed),
		})
		if level != RestockLevelWait {
			t.Fatalf("recibido hace %d días: nivel = %s, want %s (%s)", elapsed, level, RestockLevelWait, message)
		}
	}
}

func TestRecommendationSkipsProductsWithoutRotation(t *testing.T) {
	// El caso del LOZACREM: existencias suficientes y venta minima.
	message, level := BuildRestockRecommendation(RestockDecisionInput{
		CurrentStock: 4, AvgDailySales: 0.14, ABCCategory: "C",
		SuggestedOrderQty: 0, DaysSinceReception: days(20),
	})
	if level != RestockLevelSkip {
		t.Fatalf("nivel = %s, want %s (%s)", level, RestockLevelSkip, message)
	}

	message, level = BuildRestockRecommendation(RestockDecisionInput{
		CurrentStock: 3, AvgDailySales: 0, ABCCategory: "C", DaysSinceReception: days(45),
	})
	if level != RestockLevelSkip {
		t.Fatalf("sin ventas: nivel = %s, want %s (%s)", level, RestockLevelSkip, message)
	}
}

func TestRecommendationOrdersUsingReceptionAndSales(t *testing.T) {
	message, level := BuildRestockRecommendation(RestockDecisionInput{
		CurrentStock: 2, AvgDailySales: 1.5, ABCCategory: "A",
		SuggestedOrderQty: 9, DaysSinceReception: days(6), SoldSinceReception: 11,
	})
	if level != RestockLevelOrder {
		t.Fatalf("nivel = %s, want %s", level, RestockLevelOrder)
	}
	expected := "Pedir 9: última recepción hace 6 días y 11 vendidas desde entonces"
	if message != expected {
		t.Fatalf("mensaje = %q, want %q", message, expected)
	}
}

func TestRecommendationHandlesProductsNeverReceived(t *testing.T) {
	message, level := BuildRestockRecommendation(RestockDecisionInput{
		CurrentStock: 1, AvgDailySales: 0.8, ABCCategory: "B", SuggestedOrderQty: 5,
	})
	if level != RestockLevelOrder {
		t.Fatalf("nivel = %s, want %s (%s)", level, RestockLevelOrder, message)
	}
	if message != "Pedir 5: sin recepciones registradas" {
		t.Fatalf("mensaje = %q", message)
	}
}
