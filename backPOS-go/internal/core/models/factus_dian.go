package models

// Factus Document Type Parametric Table
type DocumentType struct {
	Code string `gorm:"primaryKey;size:10" json:"code"`
	Name string `gorm:"size:255;not null" json:"name"`
}

// Factus Municipality Parametric Table
type Municipality struct {
	Code string `gorm:"primaryKey;size:10" json:"code"`
	Name string `gorm:"size:255;not null" json:"name"`
}

// Factus Tax Parametric Table
type Tax struct {
	Code        string  `gorm:"primaryKey;size:10" json:"code"`
	Name        string  `gorm:"size:255;not null" json:"name"`
	Description string  `gorm:"size:255" json:"description"`
	Rate        float64 `json:"rate"`
}

// Factus Unit Type Parametric Table
type UnitType struct {
	Code string `gorm:"primaryKey;size:10" json:"code"`
	Name string `gorm:"size:255;not null" json:"name"`
}

// Structs for Factus API integration /v1/bills/validate

type FactusCustomer struct {
	Identification string `json:"identification"`
	Names          string `json:"names,omitempty"`
	Company        string `json:"company,omitempty"`
	TradeName      string `json:"trade_name,omitempty"`
	Email          string `json:"email"`
	Phone          string `json:"phone"`
	LegalOrgID     string `json:"legal_organization_id"`
	TributeID      string `json:"tribute_id"`
	IdentificationDocID string `json:"identification_document_id"`
	MunicipalityID string `json:"municipality_id"`
}

type FactusItem struct {
	CodeDiscount string  `json:"code_discount_1,omitempty"`
	DiscountRate float64 `json:"discount_rate,omitempty"`
	LineExtAmt   float64 `json:"line_extension_amount"`
	PriceAmt     float64 `json:"price_amount"`
	InvoicedQty  float64 `json:"invoiced_quantity"`
	Description  string  `json:"description"`
	BrandName    string  `json:"brand_name,omitempty"`
	ModelName    string  `json:"model_name,omitempty"`
	UnitMeasureID string `json:"unit_measure_id"` // e.g. "94"
	Taxes        []FactusItemTax `json:"taxes,omitempty"`
}

type FactusItemTax struct {
	TaxID       string  `json:"tax_id"` // e.g. "01" (IVA), "04" (INC)
	Percent     float64 `json:"tax_percentage"`
	TaxAmount   float64 `json:"tax_amount"`
	BaseAmount  float64 `json:"taxable_amount"`
}

type FactusPaymentMethod struct {
	PaymentMethodID string `json:"payment_method_id"` // 10=Efectivo
	PaymentFormID   string `json:"payment_form_id"`   // 1=Contado
	PaymentDueDate  string `json:"payment_due_date,omitempty"`
}

type FactusBillRequest struct {
	NumberingRangeID int                   `json:"numbering_range_id"`
	ReferenceCode    string                `json:"reference_code"`
	Observation      string                `json:"observation,omitempty"`
	PaymentMethods   []FactusPaymentMethod `json:"payment_methods"`
	Customer         FactusCustomer        `json:"customer"`
	Items            []FactusItem          `json:"items"`
}

// Structs for Factus API integration /v1/bills/credit-notes

type FactusCreditNoteRequest struct {
	NumberingRangeID   int                   `json:"numbering_range_id"`
	ReferenceCode      string                `json:"reference_code"`
	Observation        string                `json:"observation,omitempty"`
	BillingReference   FactusBillingRef      `json:"billing_reference"`
	DiscrepancyResponse FactusDiscrepancy    `json:"discrepancy_response"`
	PaymentMethods     []FactusPaymentMethod `json:"payment_methods"`
	Customer           FactusCustomer        `json:"customer"`
	Items              []FactusItem          `json:"items"`
}

type FactusBillingRef struct {
	Number      string `json:"number"`
	UUID        string `json:"uuid"`
	IssueDate   string `json:"issue_date"`
}

type FactusDiscrepancy struct {
	ReferenceID       string `json:"reference_id"` // Usually the original bill number
	CorrectionConcept string `json:"correction_concept_id"` // "2" for partial return, "1" for total return
}
