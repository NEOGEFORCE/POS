// Package services — lógica pura del módulo de Préstamos.
//
// Este archivo NO depende de GORM, Gin, ni de la base de datos. Expone
// `BuildLoanSchedule`, `NextMonthlyDue`, `AdvanceDueDate` y helpers de
// redondeo a centavos.
//
// POR QUÉ EN INT64 CENTAVOS Y NO FLOAT64
// ============================================================================
// El resto del POS usa float64 por convención (expenses.Amount, etc.). Para la
// aritmética de cuotas eso es un problema: dividir principal en N partes y
// luego sumarlas puede dar 0.01 de drift y los CHECK de la BD rechazan el
// cronograma. El schedule se construye en centavos (int64) y sólo se convierte
// a float64 al salir de la función. Así la suma del cronograma SIEMPRE empata
// con principal + interés total al centavo.
//
// MODOS DE INTERÉS SOPORTADOS
// ============================================================================
//
//   - NONE    — sin interés. `interestRatePct` debe ser 0.
//
//   - SIMPLE  — interés simple FLAT TOTAL aplicado una vez sobre el
//     principal (no es tasa nominal anual):
//     total_payable = principal * (1 + interestRatePct / 100)
//     `interestRatePct` > 0 obligatorio. Semántica histórica,
//     los préstamos pre-sprint-14 funcionan exactamente igual.
//
//   - FRENCH  — Sistema Francés sobre tasa Efectiva Anual (EA). El
//     request pasa la EA en el mismo campo `InterestRatePct`
//     (la columna de BD se llama `annual_effective_rate_pct`
//     y el service la pobla en el modelo Loan a la hora de
//     persistir). Fuerza frecuencia MONTHLY y admite dos
//     extras opcionales:
//
//   - MonthlyInsurance — seguro MENSUAL fijo cobrado por
//     la entidad. Se replica igual en cada cuota.
//
//   - FgaTotal — FGA (Fondo de Garantías) TOTAL cobrado al
//     desembolso. Se DIFIERE entre todas las cuotas
//     (fga_monthly ≈ FgaTotal / termCount, con residuo
//     en la última cuota).
//
//     Conversión EA → mensual:
//     i_m = (1 + InterestRatePct/100)^(1/12) - 1
//     Cuota base:
//     base = P * i_m * (1+i_m)^n / ((1+i_m)^n - 1)
//     Caso de referencia (bancario real): P = 25.000.000,
//     n = 60, EA = 21.3% ⇒ i_m ≈ 1.62% y base ≈ 655.300. El
//     servicio NO reinterpreta SIMPLE como francés: cada modo
//     tiene su propia rama.
//
// FÓRMULA DEL INTERÉS (SIMPLE, flat total — NO anualizado)
// ============================================================================
// total_payable = principal * (1 + interestRatePct / 100)
// interés total = total_payable - principal
// Cuota base = total_payable / termCount (truncada a centavos)
// La última cuota absorbe el residuo (total - sum(cuotas anteriores)) para
// que la suma empate exactamente con total_payable.
//
// NONE: interestRatePct debe ser 0, total_payable = principal.
//
// FECHAS
// ============================================================================
// MONTHLY: avanza mes a mes preservando el día de pago. Si el mes destino no
// tiene ese día (ej. 31 → febrero), cae al último día válido. Zona Bogotá.
// WEEKLY/BIWEEKLY: +7 / +14 días calendario. FRENCH fuerza MONTHLY.
package services

import (
	"errors"
	"math"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// LoanScheduleRequest son los inputs mínimos para construir el cronograma.
// El servicio superior (`LoanService.CreateLoan`) traduce lo que llega del
// handler a este request después de validar negocio.
type LoanScheduleRequest struct {
	PrincipalAmount  float64 // > 0, finito
	InterestRatePct  float64 // >= 0: en SIMPLE es flat total, en FRENCH es EA porcentual (ambas semánticas conviven en el mismo campo del request; la columna de BD difiere)
	InterestMode     string  // "NONE" | "SIMPLE" | "FRENCH"
	TermCount        int     // 1..600
	PaymentFrequency string  // "WEEKLY" | "BIWEEKLY" | "MONTHLY" — FRENCH obliga a MONTHLY
	FirstPaymentDate time.Time

	// Extras del modo FRENCH. En NONE/SIMPLE deben venir en 0 (el
	// validador rechaza valores positivos para esos modos).
	MonthlyInsurance float64 // seguro MENSUAL fijo por cuota (no se difiere)
	FgaTotal         float64 // FGA TOTAL cobrado al desembolso (se difiere entre todas las cuotas)
}

// LoanSchedulePreview describe el cronograma + totales derivados para
// el preview del formulario, sin persistir.
//
// En NONE/SIMPLE los campos `MonthlyInsurance`, `TotalInsurance`,
// `FgaTotal`, `MonthlyFga` y `TotalFga` quedan en 0 (y por lo tanto
// `TotalPayable == principal + totalInterest`). En FRENCH el
// `InstallmentBase` es la cuota puramente de capital+interés
// (idéntica a loans.base_installment_amount) y la cuota total que paga
// el cliente cada mes es `InstallmentBase + MonthlyInsurance +
// MonthlyFga` — por cuota eso vive en los componentes de cada
// LoanInstallment.
type LoanSchedulePreview struct {
	TotalInterest   float64                  `json:"totalInterest"`
	TotalPayable    float64                  `json:"totalPayable"`
	InstallmentBase float64                  `json:"installmentBase"` // cuota base antes de residuo (en FRENCH, sólo capital+interés)
	Installments    []models.LoanInstallment `json:"installments"`

	// Extras del modo FRENCH. En NONE/SIMPLE son 0.
	MonthlyInsurance float64 `json:"monthlyInsurance"`
	TotalInsurance   float64 `json:"totalInsurance"`
	FgaTotal         float64 `json:"fgaTotal"`
	MonthlyFga       float64 `json:"monthlyFga"`
	TotalFga         float64 `json:"totalFga"`

	// Contrato con el frontend (normalizeLoanPreviewResponse). Sólo FRENCH
	// los llena; en NONE/SIMPLE se omiten para no mentirle a la UI.
	//   baseInstallment = InstallmentBase (capital + interés)
	//   monthlyRate     = i_m decimal (0.016222 = 1.6222% M.V.)
	//   monthlyTotal    = baseInstallment + monthlyInsurance + monthlyFga
	BaseInstallment *float64 `json:"baseInstallment,omitempty"`
	MonthlyRate     *float64 `json:"monthlyRate,omitempty"`
	MonthlyTotal    *float64 `json:"monthlyTotal,omitempty"`
}

// Errores de validación del cronograma. El handler los mapea al código
// canónico `LOAN_INVALID_SCHEDULE` (ver loan_handler.go).
var (
	ErrInvalidPrincipal        = errors.New("principal debe ser mayor a cero")
	ErrInvalidTermCount        = errors.New("plazo debe estar entre 1 y 600 cuotas")
	ErrInvalidInterestRate     = errors.New("tasa de interés inválida (debe ser >= 0 y finita)")
	ErrInterestRequiresRate    = errors.New("modo SIMPLE requiere tasa > 0")
	ErrInvalidInterestMode     = errors.New("modo de interés inválido (NONE|SIMPLE|FRENCH)")
	ErrNoneForbidsRate         = errors.New("modo NONE requiere tasa 0")
	ErrInvalidPaymentFrequency = errors.New("frecuencia de pago inválida (WEEKLY|BIWEEKLY|MONTHLY)")
	ErrFirstDueDateMissing     = errors.New("firstPaymentDate requerida")
	ErrPrincipalOverflow       = errors.New("principal demasiado grande o no finito")

	// Errores específicos del modo FRENCH.
	ErrFrenchRequiresMonthly    = errors.New("modo FRENCH exige frecuencia MONTHLY")
	ErrFrenchRequiresEARate     = errors.New("modo FRENCH requiere tasa EA > 0 (interestRatePct)")
	ErrInvalidMonthlyInsurance  = errors.New("seguro mensual inválido (debe ser >= 0, finito y dentro de rango)")
	ErrInvalidFgaTotal          = errors.New("FGA total inválido (debe ser >= 0, finito y dentro de rango)")
	ErrInsuranceOrFgaOnlyFrench = errors.New("seguro mensual y FGA total sólo aplican en modo FRENCH")
)

// La variable `bogotaLocation` ya existe a nivel paquete en
// `restock_nightly_service.go` (`time.FixedZone("America/Bogota", -5*3600)`).
// Reutilizamos esa misma locación para que todos los módulos del POS tengan
// una única fuente de zona horaria dentro de services. Colombia no observa
// DST, así que FixedZone es correcto para aritmética de fechas.

// LoanBogotaLocation expone la zona horaria usada por el módulo. Útil
// para pruebas que necesitan construir fechas en la misma zona.
func LoanBogotaLocation() *time.Location { return bogotaLocation }

// toCents pasa de pesos float64 a centavos int64 con redondeo half-away-from-zero.
// Devuelve 0 para NaN/Inf: el validador los rechaza antes de llegar aquí, pero
// la función es honesta ante entradas corruptas.
func toCents(value float64) int64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	if value >= 0 {
		return int64(math.Round(value * 100))
	}
	return -int64(math.Round(-value * 100))
}

// fromCents convierte centavos int64 a pesos float64. Es exacto porque
// int64 cabe en float64 para valores < 2^53.
func fromCents(cents int64) float64 {
	return float64(cents) / 100.0
}

// Round2 redondea un float64 a 2 decimales. Reexportado porque el
// servicio superior lo usa para comparar amounts recibidos del handler.
func Round2(value float64) float64 {
	return fromCents(toCents(value))
}

// isFiniteMoney devuelve true si el float es un monto financiero válido
// (finito, no NaN, no Inf) y cabe cómodamente en NUMERIC(14,2).
// 10^12 - 1 = 999_999_999_999 centavos es el techo de la escala; nos
// quedamos un orden de magnitud por debajo para no raspar overflow al
// multiplicarlo por una tasa pequeña.
const maxMoneyAbs = 1e12

func isFiniteMoney(v float64) bool {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return false
	}
	if v < -maxMoneyAbs || v > maxMoneyAbs {
		return false
	}
	return true
}

// ValidateLoanScheduleRequest comprueba los parámetros del cronograma.
// Se expone para que el handler haga el 400 antes de persistir, y para
// que BuildLoanSchedule falle rápido si lo llaman directo.
func ValidateLoanScheduleRequest(req LoanScheduleRequest) error {
	if !isFiniteMoney(req.PrincipalAmount) {
		return ErrPrincipalOverflow
	}
	if req.PrincipalAmount <= 0 {
		return ErrInvalidPrincipal
	}
	if req.TermCount < 1 || req.TermCount > 600 {
		return ErrInvalidTermCount
	}
	if math.IsNaN(req.InterestRatePct) || math.IsInf(req.InterestRatePct, 0) || req.InterestRatePct < 0 {
		return ErrInvalidInterestRate
	}
	// Techo defensivo: 1000% es un número bíblico; a partir de ahí es más
	// probable un typo que una tasa real.
	if req.InterestRatePct > 1000 {
		return ErrInvalidInterestRate
	}
	// Extras monetarios: finitos y no negativos.
	if math.IsNaN(req.MonthlyInsurance) || math.IsInf(req.MonthlyInsurance, 0) ||
		req.MonthlyInsurance < 0 || !isFiniteMoney(req.MonthlyInsurance) {
		return ErrInvalidMonthlyInsurance
	}
	if math.IsNaN(req.FgaTotal) || math.IsInf(req.FgaTotal, 0) ||
		req.FgaTotal < 0 || !isFiniteMoney(req.FgaTotal) {
		return ErrInvalidFgaTotal
	}
	switch req.InterestMode {
	case models.InterestModeNone:
		if req.InterestRatePct != 0 {
			return ErrNoneForbidsRate
		}
		// Semántica estricta: seguro/FGA sólo tienen sentido en FRENCH.
		if req.MonthlyInsurance > 0 || req.FgaTotal > 0 {
			return ErrInsuranceOrFgaOnlyFrench
		}
	case models.InterestModeSimple:
		if req.InterestRatePct <= 0 {
			return ErrInterestRequiresRate
		}
		if req.MonthlyInsurance > 0 || req.FgaTotal > 0 {
			return ErrInsuranceOrFgaOnlyFrench
		}
	case models.InterestModeFrench:
		if req.InterestRatePct <= 0 {
			return ErrFrenchRequiresEARate
		}
		if req.PaymentFrequency != models.PaymentFrequencyMonthly {
			return ErrFrenchRequiresMonthly
		}
	default:
		return ErrInvalidInterestMode
	}
	switch req.PaymentFrequency {
	case models.PaymentFrequencyWeekly, models.PaymentFrequencyBiweekly, models.PaymentFrequencyMonthly:
	default:
		return ErrInvalidPaymentFrequency
	}
	if req.FirstPaymentDate.IsZero() {
		return ErrFirstDueDateMissing
	}
	return nil
}

// AdvanceDueDate devuelve la fecha de la siguiente cuota a partir de
// una fecha de pago previa y la frecuencia. MONTHLY avanza por mes
// preservando el día; si el mes destino no tiene ese día (31→febrero),
// cae al último día válido. WEEKLY/BIWEEKLY avanzan +7 / +14 días.
// Zona horaria: Bogotá.
func AdvanceDueDate(previous time.Time, frequency string) time.Time {
	switch frequency {
	case models.PaymentFrequencyWeekly:
		return previous.AddDate(0, 0, 7).In(bogotaLocation)
	case models.PaymentFrequencyBiweekly:
		return previous.AddDate(0, 0, 14).In(bogotaLocation)
	case models.PaymentFrequencyMonthly:
		return addOneMonthPreservingDay(previous)
	default:
		// Caller valida antes; defensa barata: no mover.
		return previous
	}
}

// addOneMonthPreservingDay avanza un mes conservando el día de pago.
// Si el mes destino tiene menos días, usa el último día válido.
// Ejemplo: 31 ene → 29 feb (año bisiesto) o 28 feb (resto).
func addOneMonthPreservingDay(previous time.Time) time.Time {
	previous = previous.In(bogotaLocation)
	year, month, day := previous.Date()
	// Avanzamos al día 1 del próximo mes y luego sumamos día-1 días,
	// pero si el próximo mes tiene menos días que `day`, usamos el último.
	nextMonth := time.Date(year, month+1, 1, 0, 0, 0, 0, bogotaLocation)
	// Último día del mes destino: avanzar a mes+2 día 0.
	lastDayOfNextMonth := time.Date(nextMonth.Year(), nextMonth.Month()+1, 0, 0, 0, 0, 0, bogotaLocation).Day()
	effectiveDay := day
	if effectiveDay > lastDayOfNextMonth {
		effectiveDay = lastDayOfNextMonth
	}
	return time.Date(nextMonth.Year(), nextMonth.Month(), effectiveDay, 0, 0, 0, 0, bogotaLocation)
}

// NextMonthlyDue devuelve el día de vencimiento MONTHLY sugerido cuando
// el usuario no indica firstPaymentDate: un mes después de hoy en zona
// Bogotá, preservando el día.
func NextMonthlyDue(reference time.Time) time.Time {
	return addOneMonthPreservingDay(reference)
}

// BuildLoanSchedule construye el cronograma completo. Es una función
// pura: dado un request válido, devuelve el mismo cronograma siempre.
//
// INVARIANTES garantizadas (válidas para los tres modos):
//
//   - len(installments) == req.TermCount.
//   - installments[i].Number == i+1.
//   - installments[i].DueDate es monotónicamente creciente.
//   - sum(installments[i].PrincipalDue) == req.PrincipalAmount (centavos).
//   - installments[i].PaidAmount == 0, Status == PENDING.
//
// EN NONE/SIMPLE:
//
//   - sum(installments[i].InterestDue) == totalInterest (centavos).
//   - La última cuota absorbe el residuo si el total/termCount no divide
//     exacto. InsuranceDue y FgaDue quedan en 0 para no romper el contrato
//     histórico (los JSON serializados siguen igual que antes del
//     sprint 14).
//
// EN FRENCH:
//
//   - El cronograma se amortiza por saldos: interés_i = round(saldo_i-1
//   - i_m), capital_i = cuotaBase - interés_i, saldo_i = saldo_i-1 -
//     capital_i. La ÚLTIMA cuota absorbe el residuo: capital_last =
//     saldo_prev y interés_last = round(saldo_prev * i_m) de modo que el
//     saldo final queda exactamente en 0 centavos.
//   - installments[i].InsuranceDue == toCents(MonthlyInsurance) /100 en
//     todas las cuotas (no se difiere; es un valor mensual fijo).
//   - sum(installments[i].FgaDue) == toCents(FgaTotal) /100: la última
//     cuota absorbe el residuo del redondeo mensual.
//   - preview.InstallmentBase == cuota francesa pura (capital+interés),
//     sin seguro ni FGA.
//   - preview.TotalPayable == principal + totalInterest + totalInsurance
//   - totalFga (para que remaining_balance <= total_payable en BD).
func BuildLoanSchedule(req LoanScheduleRequest) (LoanSchedulePreview, error) {
	if err := ValidateLoanScheduleRequest(req); err != nil {
		return LoanSchedulePreview{}, err
	}
	if req.InterestMode == models.InterestModeFrench {
		return buildFrenchSchedule(req)
	}
	return buildFlatSchedule(req)
}

// buildFlatSchedule mantiene la implementación histórica para NONE y
// SIMPLE. Se separó en función aparte para que la rama FRENCH no la
// toque y no haya riesgo de reinterpretar SIMPLE como francés.
func buildFlatSchedule(req LoanScheduleRequest) (LoanSchedulePreview, error) {
	principalCents := toCents(req.PrincipalAmount)
	var totalInterestCents int64
	if req.InterestMode == models.InterestModeSimple {
		// interés total = principal * rate / 100. Centavos:
		//   principalCents * rate / 100
		// con redondeo bancario explícito. principalCents cabe en int64 y
		// rate está acotada a 1000 arriba, así que el producto no desborda.
		raw := float64(principalCents) * req.InterestRatePct / 100.0
		totalInterestCents = int64(math.Round(raw))
	}
	// InterestModeNone → totalInterestCents = 0.

	totalCents := principalCents + totalInterestCents
	// Centavos por cuota: división truncada; el residuo lo absorbe la última.
	basePerInstallmentCents := totalCents / int64(req.TermCount)
	residueCents := totalCents - basePerInstallmentCents*int64(req.TermCount)

	// Separación principal/interés por cuota: proporcional.
	basePrincipalCents := principalCents / int64(req.TermCount)
	principalResidueCents := principalCents - basePrincipalCents*int64(req.TermCount)
	baseInterestCents := totalInterestCents / int64(req.TermCount)
	interestResidueCents := totalInterestCents - baseInterestCents*int64(req.TermCount)

	installments := make([]models.LoanInstallment, 0, req.TermCount)
	currentDue := normalizeDueDate(req.FirstPaymentDate)

	// Invariantes al construir con residuo absorbido en la última cuota:
	//
	//   sum(principal_i) = basePrincipal*(n-1) + (basePrincipal + principalResidue)
	//                    = basePrincipal*n + principalResidue
	//                    = principalCents                                 (exacto)
	//   sum(interest_i)  = baseInterest*n + interestResidue
	//                    = totalInterestCents                             (exacto)
	//   sum(total_i)     = principalCents + totalInterestCents
	//                    = totalCents                                     (exacto)
	//
	// Por eso no hace falta un ajuste de "diff" adicional.
	_ = basePerInstallmentCents // documental: cuota uniforme antes de residuo
	_ = residueCents            // documental: residuo total de la cuota

	for i := 0; i < req.TermCount; i++ {
		principalThis := basePrincipalCents
		interestThis := baseInterestCents
		if i == req.TermCount-1 {
			principalThis += principalResidueCents
			interestThis += interestResidueCents
		}

		installments = append(installments, models.LoanInstallment{
			Number:       i + 1,
			DueDate:      currentDue,
			PrincipalDue: fromCents(principalThis),
			InterestDue:  fromCents(interestThis),
			InsuranceDue: 0,
			FgaDue:       0,
			PaidAmount:   0,
			Status:       models.InstallmentStatusPending,
		})

		currentDue = AdvanceDueDate(currentDue, req.PaymentFrequency)
	}

	return LoanSchedulePreview{
		TotalInterest:    fromCents(totalInterestCents),
		TotalPayable:     fromCents(totalCents),
		InstallmentBase:  fromCents(basePerInstallmentCents),
		Installments:     installments,
		MonthlyInsurance: 0,
		TotalInsurance:   0,
		FgaTotal:         0,
		MonthlyFga:       0,
		TotalFga:         0,
	}, nil
}

// buildFrenchSchedule implementa la amortización por Sistema Francés.
//
// La aritmética crítica (cuota base y amortización por saldos) se hace en
// centavos (int64) para que la suma de capitales empate con el principal
// exactamente al centavo. La raíz 12ª y la cuota base viven en float64
// porque son irracionales en el caso general — se redondean a centavos
// inmediatamente y nunca se acumulan sin recortar.
func buildFrenchSchedule(req LoanScheduleRequest) (LoanSchedulePreview, error) {
	n := req.TermCount
	principalCents := toCents(req.PrincipalAmount)
	monthlyInsuranceCents := toCents(req.MonthlyInsurance)
	fgaTotalCents := toCents(req.FgaTotal)

	// EA → mensual: i_m = (1 + EA/100)^(1/12) - 1.
	eaDecimal := req.InterestRatePct / 100.0
	iM := math.Pow(1+eaDecimal, 1.0/12.0) - 1
	if math.IsNaN(iM) || math.IsInf(iM, 0) || iM <= 0 {
		// Validación defensiva: la validación de la fase anterior ya
		// garantiza EA > 0, por lo que esto no debería dispararse.
		return LoanSchedulePreview{}, ErrFrenchRequiresEARate
	}

	// Cuota base del sistema francés redondeada a centavos.
	onePlusI := 1 + iM
	onePlusIpowN := math.Pow(onePlusI, float64(n))
	denominator := onePlusIpowN - 1
	if denominator <= 0 || math.IsNaN(onePlusIpowN) || math.IsInf(onePlusIpowN, 0) {
		return LoanSchedulePreview{}, ErrFrenchRequiresEARate
	}
	cuotaBaseFloat := req.PrincipalAmount * iM * onePlusIpowN / denominator
	if math.IsNaN(cuotaBaseFloat) || math.IsInf(cuotaBaseFloat, 0) {
		return LoanSchedulePreview{}, ErrPrincipalOverflow
	}
	cuotaBaseCents := int64(math.Round(cuotaBaseFloat * 100))

	// FGA mensual: FGA_total / n con residuo en la última cuota.
	// División entera primero, luego residuo final.
	fgaMonthlyCents := int64(0)
	fgaResidueCents := int64(0)
	if n > 0 {
		fgaMonthlyCents = fgaTotalCents / int64(n)
		fgaResidueCents = fgaTotalCents - fgaMonthlyCents*int64(n)
	}

	installments := make([]models.LoanInstallment, 0, n)
	currentDue := normalizeDueDate(req.FirstPaymentDate)
	saldoCents := principalCents
	var totalInterestCents int64

	for i := 0; i < n; i++ {
		var interestCents, capitalCents int64

		if i < n-1 {
			// Interés sobre el saldo PREVIO con redondeo a centavo.
			interestFloat := float64(saldoCents) * iM
			interestCents = int64(math.Round(interestFloat))
			if interestCents < 0 {
				interestCents = 0
			}
			capitalCents = cuotaBaseCents - interestCents
			if capitalCents < 0 {
				// Caso patológico (interés redondeado > cuota base): no
				// amortizar capital en esta cuota evita saldo creciente.
				capitalCents = 0
			}
			if capitalCents > saldoCents {
				// Nunca amortizar más capital del que queda.
				capitalCents = saldoCents
			}
		} else {
			// Última cuota: absorbe todo lo que falta.
			//   capital_last = saldoPrev   → deja saldo final = 0.
			//   interés_last = round(saldoPrev * i_m) (interés real
			//                  sobre el saldo del período).
			//
			// La "cuota" total del último período puede diferir de
			// cuotaBaseCents en ≤ 1 centavo por los redondeos acumulados,
			// y así debe ser: lo importante es que SUM(capital_i) = P
			// y saldo_final = 0 exactos.
			interestFloat := float64(saldoCents) * iM
			interestCents = int64(math.Round(interestFloat))
			if interestCents < 0 {
				interestCents = 0
			}
			capitalCents = saldoCents
		}

		saldoCents -= capitalCents
		if saldoCents < 0 {
			saldoCents = 0
		}
		totalInterestCents += interestCents

		fgaThisCents := fgaMonthlyCents
		if i == n-1 {
			fgaThisCents += fgaResidueCents
		}
		balance := fromCents(saldoCents)

		installments = append(installments, models.LoanInstallment{
			Number:       i + 1,
			DueDate:      currentDue,
			PrincipalDue: fromCents(capitalCents),
			InterestDue:  fromCents(interestCents),
			InsuranceDue: fromCents(monthlyInsuranceCents),
			FgaDue:       fromCents(fgaThisCents),
			Balance:      &balance,
			PaidAmount:   0,
			Status:       models.InstallmentStatusPending,
		})

		currentDue = AdvanceDueDate(currentDue, models.PaymentFrequencyMonthly)
	}

	totalInsuranceCents := monthlyInsuranceCents * int64(n)
	totalFgaCents := fgaTotalCents // SUM(fga_due) == fgaTotalCents por construcción
	totalCents := principalCents + totalInterestCents + totalInsuranceCents + totalFgaCents

	baseInstallment := fromCents(cuotaBaseCents)
	monthlyRate := iM
	monthlyTotal := fromCents(cuotaBaseCents + monthlyInsuranceCents + fgaMonthlyCents)

	return LoanSchedulePreview{
		TotalInterest:    fromCents(totalInterestCents),
		TotalPayable:     fromCents(totalCents),
		InstallmentBase:  fromCents(cuotaBaseCents),
		Installments:     installments,
		MonthlyInsurance: fromCents(monthlyInsuranceCents),
		TotalInsurance:   fromCents(totalInsuranceCents),
		FgaTotal:         fromCents(fgaTotalCents),
		MonthlyFga:       fromCents(fgaMonthlyCents),
		TotalFga:         fromCents(totalFgaCents),
		BaseInstallment:  &baseInstallment,
		MonthlyRate:      &monthlyRate,
		MonthlyTotal:     &monthlyTotal,
	}, nil
}

// normalizeDueDate deja un instante del día 00:00 en la zona de Bogotá,
// para que una columna DATE no derive al día siguiente por conversión
// UTC.
func normalizeDueDate(t time.Time) time.Time {
	t = t.In(bogotaLocation)
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, bogotaLocation)
}

// DeriveInstallmentStatus calcula el status a partir de montos y fecha.
// Lo expone el servicio para que el handler lo pueda invocar al cambiar
// de día (job diario). PaidAmount en centavos como argumento evita
// drift; el servicio superior convierte antes de llamar.
//
// Firma backward-compatible: los campos de seguro/FGA son variádicos y
// opcionales. Si no se proveen (NONE/SIMPLE) se asumen 0 y la fórmula
// se reduce a la histórica (principal+interés). FRENCH debe pasarlos
// explícitamente para que el PAID considere la cuota completa.
func DeriveInstallmentStatus(principalDue, interestDue, paidAmount float64, dueDate, now time.Time, extras ...float64) string {
	var insuranceDue, fgaDue float64
	if len(extras) >= 1 {
		insuranceDue = extras[0]
	}
	if len(extras) >= 2 {
		fgaDue = extras[1]
	}
	totalDueCents := toCents(principalDue) + toCents(interestDue) + toCents(insuranceDue) + toCents(fgaDue)
	paidCents := toCents(paidAmount)
	if paidCents >= totalDueCents {
		return models.InstallmentStatusPaid
	}
	// Fecha vencida: considerar LATE si no se pagó aún.
	dueDay := time.Date(dueDate.Year(), dueDate.Month(), dueDate.Day(), 0, 0, 0, 0, bogotaLocation)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, bogotaLocation)
	if today.After(dueDay) {
		return models.InstallmentStatusLate
	}
	if paidCents > 0 {
		return models.InstallmentStatusPartial
	}
	return models.InstallmentStatusPending
}
