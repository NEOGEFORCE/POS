package services

import "os"

// ============================================================================
// MODELOS DE IA
// ============================================================================
//
// Los identificadores se centralizan aqui para no dejarlos dispersos en el
// codigo. Cada uno se puede sobrescribir por variable de entorno, de modo que
// actualizar a un modelo nuevo no exige recompilar el servidor.
//
// Vigentes segun la documentacion de Anthropic:
//   claude-opus-5                 mayor capacidad para trabajo complejo
//   claude-sonnet-5               mejor equilibrio de velocidad e inteligencia
//   claude-haiku-4-5-20251001     el mas rapido
//
// Los anteriores claude-opus-4-8 y claude-sonnet-4-5 quedaron superados.
// ============================================================================

const (
	defaultVisionModel = "claude-sonnet-5"
	defaultChatModel   = "claude-sonnet-5"
	defaultFastModel   = "claude-haiku-4-5-20251001"
)

func modelFromEnv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

// VisionModel se usa para lectura de facturas e imagenes.
func VisionModel() string { return modelFromEnv("POS_AI_MODEL_VISION", defaultVisionModel) }

// ChatModel se usa para conversacion y reportes del bot.
func ChatModel() string { return modelFromEnv("POS_AI_MODEL_CHAT", defaultChatModel) }

// FastModel se usa para respuestas cortas y de baja latencia.
func FastModel() string { return modelFromEnv("POS_AI_MODEL_FAST", defaultFastModel) }
