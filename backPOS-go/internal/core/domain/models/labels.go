// Package models — tipos para el módulo de generación de códigos de barras,
// impresoras y auditoría del cajón de dinero.
//
// IMPORTANTE: estos modelos NO forman parte de schemaModels() en
// migrations/catalog.go. Las tablas físicas las crea exclusivamente la
// migración `016_label_generator_and_cash_drawer.sql`. Mantenerlos fuera
// de schemaModels protege el checksum de la migración 002 (model_schema)
// y respeta la política del runner: la BD la mutan sólo migraciones
// explícitas durante una ventana aprobada.
//
// Mapping snake_case ↔ Go sigue la convención GORM: las columnas tienen
// `column:` explícito para que un refactor de nombres de campo no mueva
// la columna por accidente.
package models

import "time"

// LabelSizeTemplate describe plantillas reutilizables de tamaño de etiqueta.
// Un admin configura varias (ej. "4x2.5 cm", "60x30 mm QR") y la pantalla
// de impresión selecciona la que aplica.
type LabelSizeTemplate struct {
	ID            uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	Name          string    `gorm:"column:name;type:varchar(80);not null;uniqueIndex" json:"name"`
	WidthMM       float64   `gorm:"column:width_mm;type:numeric(6,2);not null" json:"widthMm"`
	HeightMM      float64   `gorm:"column:height_mm;type:numeric(6,2);not null" json:"heightMm"`
	MarginMM      float64   `gorm:"column:margin_mm;type:numeric(6,2);not null;default:1.0" json:"marginMm"`
	ColumnsCount  int       `gorm:"column:columns_count;not null;default:1" json:"columnsCount"`
	DPI           int       `gorm:"column:dpi;not null;default:203" json:"dpi"`
	BarcodeFormat string    `gorm:"column:barcode_format;type:varchar(16);not null;default:'CODE128'" json:"barcodeFormat"`
	ShowName      bool      `gorm:"column:show_name;not null;default:true" json:"showName"`
	ShowPrice     bool      `gorm:"column:show_price;not null;default:true" json:"showPrice"`
	IsDefault     bool      `gorm:"column:is_default;not null;default:false" json:"isDefault"`
	CreatedAt     time.Time `gorm:"column:created_at;not null;default:now()" json:"createdAt"`
	UpdatedAt     time.Time `gorm:"column:updated_at;not null;default:now()" json:"updatedAt"`
	UpdatedByDNI  string    `gorm:"column:updated_by_dni;type:varchar(32)" json:"updatedByDni,omitempty"`
}

func (LabelSizeTemplate) TableName() string { return "label_size_templates" }

// LabelPrinterProfile describe cómo hablar con una impresora. El protocolo
// determina el driver real (lo ejecuta un bridge local — ver scale-bridge/
// como patrón). drawer_connected indica si el cajón de dinero cuelga del
// puerto DK de esta impresora: habilita el pulso de kickout por el mismo
// canal (ESC/POS: 0x1B 0x70 0x00 0x19 0xFA; TSPL: OPENCASHDRAWER).
type LabelPrinterProfile struct {
	ID               uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	Name             string    `gorm:"column:name;type:varchar(80);not null;uniqueIndex" json:"name"`
	Protocol         string    `gorm:"column:protocol;type:varchar(16);not null" json:"protocol"` // escpos|tspl|zpl|pdf|system
	Target           string    `gorm:"column:target;type:varchar(255);not null" json:"target"`
	RollWidthMM      *float64  `gorm:"column:roll_width_mm;type:numeric(6,2)" json:"rollWidthMm,omitempty"`
	Model            string    `gorm:"column:model;type:varchar(80)" json:"model,omitempty"`
	DrawerConnected  bool      `gorm:"column:drawer_connected;not null;default:false" json:"drawerConnected"`
	IsDefault        bool      `gorm:"column:is_default;not null;default:false" json:"isDefault"`
	CreatedAt        time.Time `gorm:"column:created_at;not null;default:now()" json:"createdAt"`
	UpdatedAt        time.Time `gorm:"column:updated_at;not null;default:now()" json:"updatedAt"`
	UpdatedByDNI     string    `gorm:"column:updated_by_dni;type:varchar(32)" json:"updatedByDni,omitempty"`
}

func (LabelPrinterProfile) TableName() string { return "label_printer_profiles" }

// LabelCode es el código interno que se imprime en la etiqueta. ES el que
// aparece en el barcode físico; es distinto de products.barcode y persiste
// aunque el producto se renombre o se dé de baja (de ahí la ausencia de FK
// dura). Para que la reimpresión sea idempotente, el PK es `code` string.
type LabelCode struct {
	Code            string     `gorm:"column:code;type:varchar(64);primaryKey" json:"code"`
	ProductBarcode  *string    `gorm:"column:product_barcode;type:varchar(64);index" json:"productBarcode,omitempty"`
	SizeTemplateID  *uint      `gorm:"column:size_template_id" json:"sizeTemplateId,omitempty"`
	Note            string     `gorm:"column:note;type:text" json:"note,omitempty"`
	CreatedAt       time.Time  `gorm:"column:created_at;not null;default:now()" json:"createdAt"`
	CreatedByDNI    string     `gorm:"column:created_by_dni;type:varchar(32);not null" json:"createdByDni"`
	LastPrintedAt   *time.Time `gorm:"column:last_printed_at" json:"lastPrintedAt,omitempty"`
	PrintCount      int        `gorm:"column:print_count;not null;default:0" json:"printCount"`
	VoidedAt        *time.Time `gorm:"column:voided_at" json:"voidedAt,omitempty"`
	VoidedByDNI     string     `gorm:"column:voided_by_dni;type:varchar(32)" json:"voidedByDni,omitempty"`
}

func (LabelCode) TableName() string { return "label_codes" }

// LabelPrintJob guarda cada envío a imprimir. Una reimpresión genera una
// fila nueva con trigger_source="reprint" para auditoría. payload_json
// contiene el snapshot del lote enviado, permitiendo reproducir fielmente
// cualquier impresión posterior.
type LabelPrintJob struct {
	ID                uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	CreatedAt         time.Time `gorm:"column:created_at;not null;default:now()" json:"createdAt"`
	CreatedByDNI      string    `gorm:"column:created_by_dni;type:varchar(32);not null" json:"createdByDni"`
	PrinterProfileID  *uint     `gorm:"column:printer_profile_id" json:"printerProfileId,omitempty"`
	SizeTemplateID    *uint     `gorm:"column:size_template_id" json:"sizeTemplateId,omitempty"`
	TriggerSource     string    `gorm:"column:trigger_source;type:varchar(16);not null;default:'new'" json:"triggerSource"` // new|reprint|bulk
	LabelCount        int       `gorm:"column:label_count;not null;default:0" json:"labelCount"`
	Status            string    `gorm:"column:status;type:varchar(16);not null;default:'queued'" json:"status"` // queued|printed|failed|cancelled
	Error             string    `gorm:"column:error;type:text" json:"error,omitempty"`
	PayloadJSON       string    `gorm:"column:payload_json;type:jsonb;not null" json:"payloadJson"`
}

func (LabelPrintJob) TableName() string { return "label_print_jobs" }

// CashDrawerOpen audita cada apertura del cajón. La regla "no abrir sin
// venta salvo admin" vive codificada tanto en la BD (CHECK constraints)
// como en el handler Go. Esta tabla es la fuente única para investigar
// aperturas inusuales.
//
// Migración 025 (en catálogo, aplicación en ventana aprobada): añade
// `otp_challenge_id` para auditar aperturas disparadas por la tecla
// Home de /sales/new mediante challenge OTP. La biyección exacta
// reason='otp_manual' ↔ otp_challenge_id IS NOT NULL vive en el CHECK
// `ck_cash_drawer_opens_otp_reason_coherent` y la coherencia la impone
// el repositorio en una sola transacción.
type CashDrawerOpen struct {
	ID               uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	OpenedAt         time.Time `gorm:"column:opened_at;not null;default:now()" json:"openedAt"`
	ActorDNI         string    `gorm:"column:actor_dni;type:varchar(32);not null" json:"actorDni"`
	Reason           string    `gorm:"column:reason;type:varchar(16);not null" json:"reason"` // sale|return|admin_override|other|otp_manual
	SaleID           *uint     `gorm:"column:sale_id" json:"saleId,omitempty"`
	ReturnID         *uint     `gorm:"column:return_id" json:"returnId,omitempty"`
	OverrideAdmin    bool      `gorm:"column:override_admin;not null;default:false" json:"overrideAdmin"`
	AuthorizedByDNI  string    `gorm:"column:authorized_by_dni;type:varchar(32)" json:"authorizedByDni,omitempty"`
	Note             string    `gorm:"column:note;type:text" json:"note,omitempty"`
	PrinterProfileID *uint     `gorm:"column:printer_profile_id" json:"printerProfileId,omitempty"`
	// OtpChallengeID se puebla sólo cuando reason='otp_manual' (migración
	// 025). El repo escribe este valor en la MISMA transacción que marca
	// el challenge como CONSUMED. Nullable porque las aperturas
	// sale/return/admin_override no llevan challenge.
	OtpChallengeID *uint64 `gorm:"column:otp_challenge_id" json:"otpChallengeId,omitempty"`
}

func (CashDrawerOpen) TableName() string { return "cash_drawer_opens" }

// Razones de apertura del cajón.
const (
	CashDrawerReasonSale          = "sale"
	CashDrawerReasonReturn        = "return"
	CashDrawerReasonAdminOverride = "admin_override"
	CashDrawerReasonOther         = "other"
	// CashDrawerReasonOtpManual se usa cuando un empleado abre el cajón
	// mediante challenge OTP validado (tecla Home de /sales/new,
	// migración 025). Requiere OtpChallengeID poblado — biyección
	// exacta impuesta por `ck_cash_drawer_opens_otp_reason_coherent`.
	CashDrawerReasonOtpManual = "otp_manual"
)

// Estados de un trabajo de impresión.
const (
	PrintJobStatusQueued    = "queued"
	PrintJobStatusPrinted   = "printed"
	PrintJobStatusFailed    = "failed"
	PrintJobStatusCancelled = "cancelled"
)

// Origen del trabajo de impresión.
const (
	PrintTriggerNew     = "new"
	PrintTriggerReprint = "reprint"
	PrintTriggerBulk    = "bulk"
)
