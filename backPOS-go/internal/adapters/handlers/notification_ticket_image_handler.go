package handlers

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

// ============================================================================
// RECIBO GRAFICO: PNG a Telegram
// ============================================================================
//
// Antes el ticket salia a Telegram como texto monoespaciado (ver
// DashboardExportHandler.SendTicketToTelegram). El frontend genera ahora un
// PNG renderizado con Canvas 2D a partir del mismo buildTicketText que
// alimenta la impresora termica, asi que el canal digital puede recibir el
// recibo en forma de imagen listo para compartir por WhatsApp.
//
// Decisiones:
//   - **Mantener el endpoint de texto** por retrocompatibilidad y como
//     fallback cuando Canvas no esta disponible. Son dos endpoints distintos
//     con rutas distintas; no se mezclan.
//   - **Multipart/form-data**: la UI envia `image` como archivo con tipo
//     `image/png` y opcionalmente `caption` como campo de texto.
//   - **Validacion por firma + MIME**: no basta con el MIME (facil de
//     falsificar); se leen los primeros 8 bytes y se comparan con la firma
//     canonica de PNG. Esto evita que un cliente comprometido envie un
//     binario ejecutable disfrazado.
//   - **Limite razonable**: 2 MB para un ticket de hasta ~800 pixeles de
//     ancho. Un ticket thermal normal pesa 20-60 KB; 2 MB deja margen para
//     colores y DPI altos sin abrir la puerta a abuso.
//   - **Reusa TelegramService.SendPhoto**: ya tiene la logica de cola
//     offline, reintentos y manejo de bot caido.

// pngFileSignature son los primeros 8 bytes obligatorios de todo PNG valido
// (RFC 2083): 137 80 78 71 13 10 26 10. Verificar la firma protege contra
// clientes que mandan otro formato o un binario arbitrario con MIME
// falsificado.
var pngFileSignature = []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}

// maxTicketImageBytes acota el tamano del PNG. Un ticket termico renderizado
// a 320x1200 px RGBA pesa alrededor de 50 KB; 2 MB cubre tickets largos con
// detalle alto y recibos a resolucion doble sin dar via libre a payloads
// gigantes.
const maxTicketImageBytes int64 = 2 * 1024 * 1024

// errTicketImageNotPNG se devuelve cuando falla la firma de PNG. Es
// explicito para que los tests de deteccion puedan verificarlo.
var errTicketImageNotPNG = errors.New("imagen invalida: no es un PNG")

// validateTicketImageBytes verifica firma y tamano. Puro, sin io ni gin —
// facil de testear.
func validateTicketImageBytes(data []byte) error {
	if int64(len(data)) == 0 {
		return errors.New("imagen vacia")
	}
	if int64(len(data)) > maxTicketImageBytes {
		return fmt.Errorf("la imagen pesa %d bytes, limite %d", len(data), maxTicketImageBytes)
	}
	if len(data) < len(pngFileSignature) {
		return errTicketImageNotPNG
	}
	if !bytes.HasPrefix(data, pngFileSignature) {
		return errTicketImageNotPNG
	}
	return nil
}

// looksLikePNGExtension verifica que el nombre del archivo multipart tenga
// extension .png (comparacion case-insensitive). No reemplaza la validacion
// de firma; es solo una guarda temprana para evitar leer el cuerpo entero
// cuando el cliente mando otra cosa.
func looksLikePNGExtension(filename string) bool {
	return strings.EqualFold(filepath.Ext(filename), ".png")
}

// looksLikePNGContentType acepta content-type "image/png" exactamente o con
// parametros (ej. "image/png; name=ticket.png").
func looksLikePNGContentType(contentType string) bool {
	ct := strings.ToLower(strings.TrimSpace(contentType))
	if ct == "" {
		return true // multipart puede omitirlo; la firma final valida.
	}
	// Separar el content-type de sus parametros ("image/png; charset=...").
	if idx := strings.Index(ct, ";"); idx >= 0 {
		ct = strings.TrimSpace(ct[:idx])
	}
	return ct == "image/png"
}

// SendTicketImageToTelegram recibe un PNG multipart y lo publica como foto en
// el chat de Telegram configurado.
//
// Request:
//
//	POST /telegram/ticket-image
//	Content-Type: multipart/form-data
//	Campo "image" (archivo, requerido, .png)
//	Campo "caption" (texto, opcional)
//
// Responses:
//
//	200 {"sent": true}
//	400 payload invalido o no PNG
//	413 PNG demasiado grande (via SendError como 400 con el mensaje claro)
//	503 Telegram no configurado
func (h *NotificationHandler) SendTicketImageToTelegram(c *gin.Context) {
	// MaxMultipartMemory del request a nivel Gin tiene su default (32 MB),
	// pero el handler decide su propio limite sobre el archivo real.
	fileHeader, err := c.FormFile("image")
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Debe adjuntar el PNG en el campo \"image\"", err)
		return
	}
	if fileHeader.Size <= 0 {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Imagen vacia", nil)
		return
	}
	if fileHeader.Size > maxTicketImageBytes {
		SendError(c, http.StatusBadRequest, ErrBadRequest,
			fmt.Sprintf("La imagen pesa %d bytes, limite %d", fileHeader.Size, maxTicketImageBytes), nil)
		return
	}
	// Guarda temprana por nombre y content-type, antes de leer bytes.
	if !looksLikePNGExtension(fileHeader.Filename) {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Solo se permiten archivos PNG", nil)
		return
	}
	if !looksLikePNGContentType(fileHeader.Header.Get("Content-Type")) {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Content-Type no es image/png", nil)
		return
	}

	openedFile, err := fileHeader.Open()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "No se pudo abrir el archivo", err)
		return
	}
	defer openedFile.Close()

	imgBytes, err := io.ReadAll(io.LimitReader(openedFile, maxTicketImageBytes+1))
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "No se pudo leer la imagen", err)
		return
	}
	if int64(len(imgBytes)) > maxTicketImageBytes {
		SendError(c, http.StatusBadRequest, ErrBadRequest,
			fmt.Sprintf("La imagen supera el limite de %d bytes", maxTicketImageBytes), nil)
		return
	}
	if err := validateTicketImageBytes(imgBytes); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Imagen invalida: "+err.Error(), err)
		return
	}

	if h.telegramService == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Telegram no esta configurado"})
		return
	}

	caption := strings.TrimSpace(c.PostForm("caption"))
	if caption == "" {
		caption = "Recibo"
	}
	// Telegram limita el caption de una foto a 1024 chars. Un ticket largo
	// podria exceder; se trunca en silencio porque la imagen ya trae el
	// detalle completo.
	if len(caption) > 1024 {
		caption = caption[:1024]
	}

	// SendPhoto nunca retorna error visible: encola offline si el bot no
	// esta activo. El 200 significa "aceptado para envio".
	if err := h.telegramService.SendPhoto(imgBytes, caption); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "No se pudo enviar la imagen", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"sent": true, "bytes": len(imgBytes)})
}
