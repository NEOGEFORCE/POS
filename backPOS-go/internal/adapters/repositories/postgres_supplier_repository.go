package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"fmt"
	"log"
	"strings"

	"backPOS-go/internal/infrastructure/cache"
	"backPOS-go/internal/infrastructure/sse"
	"gorm.io/gorm"
)

type PostgresSupplierRepository struct {
	db *gorm.DB
}

func NewPostgresSupplierRepository(db *gorm.DB) *PostgresSupplierRepository {
	return &PostgresSupplierRepository{db: db}
}

func (r *PostgresSupplierRepository) Save(supplier *models.Supplier) error {
	err := r.db.Create(supplier).Error
	if err == nil {
		cache.InvalidateCache(cache.CacheKeySuppliers)
		sse.GetSSEService().Broadcast("SUPPLIER_UPDATE", nil)
	}
	return err
}

func (r *PostgresSupplierRepository) GetByID(id uint) (*models.Supplier, error) {
	var supplier models.Supplier
	err := r.db.First(&supplier, id).Error
	return &supplier, err
}

func (r *PostgresSupplierRepository) GetByName(name string) (*models.Supplier, error) {
	var supplier models.Supplier
	err := r.db.Where("UPPER(name) = UPPER(?)", name).First(&supplier).Error
	return &supplier, err
}

func (r *PostgresSupplierRepository) GetAll() ([]models.Supplier, error) {
	log.Printf("[PostgresSupplierRepository] Iniciando GetAll...")

	suppliers := []models.Supplier{}

	// Usar Find simple con Limit y Order
	log.Printf("[PostgresSupplierRepository] Ejecutando consulta Find con LIMIT 100...")
	err := r.db.Where("\"is_active\" = ?", true).Order("name ASC").Limit(100).Find(&suppliers).Error

	if err != nil {
		log.Printf("[PostgresSupplierRepository] ERROR en consulta SQL: %v", err)
		return nil, fmt.Errorf("error SQL en GetAll: %w", err)
	}

	log.Printf("[PostgresSupplierRepository] Consulta exitosa: %d proveedores encontrados", len(suppliers))

	// Log detallado de los primeros proveedores para debug
	for i, s := range suppliers {
		if i < 5 {
			log.Printf("[PostgresSupplierRepository] Proveedor %d: id=%d, name=%s", i, s.ID, s.Name)
		}
	}
	if len(suppliers) > 5 {
		log.Printf("[PostgresSupplierRepository] ... y %d proveedores más", len(suppliers)-5)
	}

	return suppliers, nil
}

// Update aplica los cambios enviados por el CRUD manual del dueno.
//
// DECISIONES CLAVE (agosto 2026):
//
// (a) is_active NO esta en la lista.
//
//	GORM con Select() escribe la columna aunque el struct traiga el
//	zero-value: cualquier llamador que olvide setear IsActive
//	DESACTIVARIA silenciosamente al proveedor (GetAll filtra
//	is_active = true, asi que desaparece de la lista). Para evitar la
//	trampa, activar/desactivar se hace por SetActive(id, active), no
//	por Update. El formulario del dueno nunca cambia el estado y ese
//	campo ni siquiera se envia desde el frontend.
//
// (b) VisitDays / DeliveryDays llegan como StringArray.
//
//	Cuando el dueno DESMARCA todos los dias, el frontend envia []
//	(empty slice, no null): StringArray.Value() serializa a "[]"::jsonb
//	y GORM llama a Value() como parte del Updates(). Al ser el slice
//	no-nil pero vacio, la columna se actualiza a un arreglo vacio y
//	NO queda un NULL ambiguo ni se preserva lo anterior. Ver
//	TestStringArrayValueSlicesVaciosVsNil en supplier_update_test.go
//	para la garantia a nivel Value().
//
// (c) Las columnas learned_* (learned_visit_days, learned_delivery_days,
//
//	learned_lead_time_days, learned_sample_count, learned_at) NO estan
//	en el Select y por tanto NO se tocan desde este metodo. Son
//	propiedad exclusiva del batch nocturno. El test guardian
//	TestNoAutoWriteToVisitDaysOrDeliveryDays ya blinda el simetrico
//	(visit_days/delivery_days no se escriben desde flujos automaticos).
//
// (d) Campos que se conservan en el Select y por que:
//
//	    name, phone, vendorName, restock_method: datos basicos del
//	        directorio, controlados por el dueno.
//	    visit_days, delivery_days: la agenda MANUAL sagrada. Se
//	        actualizan aca porque el CRUD manual ES el unico camino
//	        legitimo para modificarlas.
//	    visitDay, deliveryDay: campos legacy que el frontend sigue
//	        llenando por CSV. Se mantienen sincronizados.
//	    updatedByDni: auditoria.
//	Campos deliberadamente OMITIDOS:
//	    imageUrl: el formulario actual no lo captura; si algun dia se
//	        agrega, ampliamos el Select.
//	    lead_time_days: no se expone en el formulario del dueno; la
//	        agenda efectiva se deriva de visit_days/delivery_days.
//	    visit_frequency_days: legacy learned, se mantiene fuera para no
//	        pisarla desde el CRUD (queda para calculos internos).
//	    learned_*: ver (c).
//	    is_active: ver (a).
//	    createdByDni, createdByName, imageUrl, deleted_at: no son del
//	        flujo de edicion normal.
func (r *PostgresSupplierRepository) Update(id uint, supplier *models.Supplier) error {
	err := r.db.Model(&models.Supplier{}).Where("id = ?", id).Select(
		"name", "phone", "vendorName", "visit_days", "delivery_days",
		"visitDay", "deliveryDay", "restock_method", "updatedByDni",
	).Updates(supplier).Error
	if err == nil {
		cache.InvalidateCache(cache.CacheKeySuppliers)
		sse.GetSSEService().Broadcast("SUPPLIER_UPDATE", nil)
	}
	return err
}

// manualScheduleWriteMarker permite al guardián estático distinguir esta
// acción administrativa explícita de cualquier autoescritura prohibida.
const manualScheduleWriteMarker = "MANUAL_SUPPLIER_SCHEDULE_WRITE"

// UpdateManualSchedule modifica exclusivamente la agenda manual presente en
// el PATCH. La existencia, la actualización y la lectura de respuesta ocurren
// en una sola transacción; learned_* y el resto del proveedor nunca entran al
// mapa de cambios.
func (r *PostgresSupplierRepository) UpdateManualSchedule(id uint, update ports.SupplierScheduleUpdate) (*models.Supplier, error) {
	var updated models.Supplier
	err := r.db.Transaction(func(tx *gorm.DB) error {
		var exists int64
		if err := tx.Model(&models.Supplier{}).
			Where("id = ? AND deleted_at IS NULL", id).
			Count(&exists).Error; err != nil {
			return err
		}
		if exists == 0 {
			return ports.ErrSupplierNotFound
		}

		fields := make(map[string]interface{}, 5)
		if update.VisitDays != nil {
			fields["visit_days"] = *update.VisitDays
			fields["visitDay"] = strings.Join([]string(*update.VisitDays), ", ")
		}
		if update.DeliveryDays != nil {
			fields["delivery_days"] = *update.DeliveryDays
			fields["deliveryDay"] = strings.Join([]string(*update.DeliveryDays), ", ")
		}
		if update.LeadTimeDays != nil {
			if *update.LeadTimeDays == nil {
				fields["lead_time_days"] = nil
			} else {
				fields["lead_time_days"] = **update.LeadTimeDays
			}
		}

		if len(fields) > 0 {
			_ = manualScheduleWriteMarker
			if err := tx.Model(&models.Supplier{}).Where("id = ?", id).Updates(fields).Error; err != nil {
				return err
			}
		}
		return tx.First(&updated, id).Error
	})
	if err != nil {
		return nil, err
	}

	cache.InvalidateCache(cache.CacheKeySuppliers)
	sse.GetSSEService().Broadcast("SUPPLIER_UPDATE", updated)
	return &updated, nil
}

// SetActive activa o desactiva un proveedor de forma EXPLICITA, sin pasar
// por Update. Es la unica ruta que este repositorio ofrece para tocar
// is_active — asi Update() nunca desactiva un proveedor por omision.
//
// Se usa desde el handler de creacion (para reactivar un proveedor
// previamente borrado logicamente cuando llega un CREATE con el mismo
// nombre) y desde Delete (que pasa active=false).
func (r *PostgresSupplierRepository) SetActive(id uint, active bool) error {
	err := r.db.Model(&models.Supplier{}).
		Where("id = ?", id).
		Update("is_active", active).Error
	if err == nil {
		cache.InvalidateCache(cache.CacheKeySuppliers)
		sse.GetSSEService().Broadcast("SUPPLIER_UPDATE", nil)
	}
	return err
}

func (r *PostgresSupplierRepository) Delete(id uint) error {
	// Soft-delete: se conserva la fila pero se marca inactiva. Usa la ruta
	// EXPLICITA de estado para respetar la regla de que Update() no puede
	// tocar is_active.
	return r.SetActive(id, false)
}

func (r *PostgresSupplierRepository) GetByVisitDay(day string) ([]models.Supplier, error) {
	var suppliers []models.Supplier
	whereSQL, args := BuildDayMatchWhere("visit_days", `"visitDay"`, day)
	err := r.db.
		Where(whereSQL+` AND "is_active" = ?`, append(args, true)...).
		Order("name ASC").
		Limit(100).
		Find(&suppliers).Error
	return suppliers, err
}

// BuildDayMatchWhere arma un fragmento WHERE (sin la palabra WHERE) que
// resuelve "el proveedor tiene 'day' entre sus dias" tolerando tildes,
// mayusculas, espacios y CSV en el campo legacy.
//
// Contexto del bug (agosto 2026): el formulario del frontend
// (SupplierFormModal.tsx) guarda los dias SIN tilde ("Miercoles", "Sabado")
// mientras el cron mandaba nombres CON tilde ("Miércoles", "Sábado") y la
// comparacion era EXACTA:
//
//	WHERE ("visitDay" = ? OR visit_days @> ?::jsonb)
//
// El resultado: proveedores de miercoles y sabado nunca disparaban la alerta
// diaria porque los strings byte-a-byte no coincidian. Los otros cinco dias
// funcionaban por casualidad, porque no llevan tilde.
//
// Regla del dueno: NO se pueden reescribir los datos ya guardados. La
// LECTURA es la que tiene que tolerar. Se usan dos herramientas de
// PostgreSQL:
//
//   - unaccent(...) para colapsar tildes. La extension esta instalada en
//     esta base (migrations/sql/001_legacy_preflight.sql) y ya se usa en
//     postgres_product_repository.GetPaginated.
//   - jsonb_array_elements_text(...) para desarmar el arreglo jsonb y
//     comparar cada elemento por separado; @>::jsonb hace comparacion
//     exacta byte-a-byte y no sirve.
//
// El campo legacy (columna "visitDay"/"deliveryDay") a veces trae CSV como
// "Lunes, Miercoles". Se compara contra el texto completo con unaccent y
// tambien contra las partes separadas usando regexp_split_to_table, para
// cubrir tanto "Miércoles" solo como "Lunes, Miercoles".
//
// La funcion es pura y determinista: recibe un nombre de dia crudo, devuelve
// SQL + argumentos, sin tocar la base ni depender del entorno. Los tests
// verifican el shape del SQL sin necesitar un cluster real.
//
// Parametros:
//   - jsonbColumn: nombre de la columna jsonb (ej. "visit_days" o
//     "delivery_days"). Ya se cita en el SQL, no pasar como identifier
//     entre comillas.
//   - legacyColumn: nombre de la columna legacy en formato SQL listo para
//     concatenar (con comillas si es camelCase). Ej: `"visitDay"` o
//     `"deliveryDay"`. Puede ser cadena vacia si no hay campo legacy.
//   - day: nombre del dia a buscar (crudo, con o sin tilde, con o sin
//     mayusculas). Se pasa como parametro, NO se interpola.
func BuildDayMatchWhere(jsonbColumn, legacyColumn, day string) (string, []interface{}) {
	// Todos los matchers comparan contra unaccent(lower(?)) del parametro,
	// asi que el mismo argumento se repite. Se usa un placeholder por cada
	// aparicion (postgres no soporta reutilizar '?' con GORM).
	//
	// El OR se arma condicional segun exista o no el campo legacy, para no
	// dejar clausulas vacias.
	if jsonbColumn == "" && legacyColumn == "" {
		// Defensa contra caller que no pase nada. Devolvemos algo que no
		// matchea a nadie pero es SQL valido.
		return "FALSE", nil
	}

	clauses := make([]string, 0, 2)
	args := make([]interface{}, 0, 4)

	if jsonbColumn != "" {
		// EXISTS (SELECT 1 FROM jsonb_array_elements_text(col) d WHERE
		//   unaccent(lower(d)) = unaccent(lower(?)))
		// Se envuelve en CASE para tolerar la columna en NULL sin que
		// jsonb_array_elements_text explote.
		clauses = append(clauses, `EXISTS (
			SELECT 1
			FROM jsonb_array_elements_text(COALESCE(`+jsonbColumn+`, '[]'::jsonb)) d
			WHERE unaccent(lower(d)) = unaccent(lower(?))
		)`)
		args = append(args, day)
	}

	if legacyColumn != "" {
		// El campo legacy es un texto que a veces trae CSV. Se compara:
		//   (a) el texto completo (por si el operador guardo solo un dia)
		//   (b) cada elemento del split-by-coma (para "Lunes, Miercoles")
		// Ambos con unaccent+lower+trim.
		clauses = append(clauses, `(
			unaccent(lower(trim(COALESCE(`+legacyColumn+`, '')))) = unaccent(lower(?))
			OR EXISTS (
				SELECT 1
				FROM regexp_split_to_table(COALESCE(`+legacyColumn+`, ''), '\s*,\s*') part
				WHERE unaccent(lower(trim(part))) = unaccent(lower(?))
			)
		)`)
		args = append(args, day, day)
	}

	// Envolver en parentesis para que un AND externo no rompa la precedencia.
	return "(" + strings.Join(clauses, " OR ") + ")", args
}

// ============================================================
// Auto-Aprendizaje de Rutas de Proveedores — DESACTIVADO
// ============================================================
//
// Regla del dueño (agosto 2026): la agenda manual del proveedor
// (columnas suppliers.visit_days y suppliers.delivery_days) es SAGRADA
// y NO puede ser modificada por ningún flujo automático. El
// aprendizaje real vive ahora en scheduling.LearnSupplierSchedule y
// se persiste EXCLUSIVAMENTE en las columnas learned_* (migración
// 014_supplier_learned_schedule.sql).
//
// La firma de LearnDay se conserva para no romper callers que aún
// no se hayan podado, pero el cuerpo es un no-op deliberado. Si algún
// caller nuevo llama a esta función, no pasa nada: retorna nil sin
// tocar la base. targetColumn se ignora.
//
// Historia: antes de este cambio, LearnDay hacía un UPDATE que
// appendeaba el weekday actual a visit_days o delivery_days del
// proveedor cada vez que se creaba un egreso, una orden de compra,
// se confirmaba la lista de compras, o se recibía un pedido. En una
// semana, todos los días de la semana quedaban en la ficha del
// proveedor, pulverizando lo que el dueño había configurado a mano.
// Ese error fue reportado explícitamente por el dueño y prohibido
// para siempre.
func (r *PostgresSupplierRepository) LearnDay(supplierID uint, targetColumn string) error {
	_ = supplierID
	_ = targetColumn
	return nil
}
