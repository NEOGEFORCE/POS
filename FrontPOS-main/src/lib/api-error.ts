/**
 * Utilidad centralizada para parsear errores de la API del backend POS.
 * 
 * El backend puede responder errores en dos formatos:
 *   1. Estructurado (SendError): { error: { code, message, details } }
 *   2. Simple (gin.H):           { error: "mensaje" }
 * 
 * Esta función extrae el mensaje más descriptivo posible y lo traduce
 * a un lenguaje claro para el operario.
 */

// Mapa de traducciones para errores comunes de base de datos / red
const ERROR_TRANSLATIONS: Record<string, string> = {
  // Errores de MySQL / base de datos
  '1062': 'REGISTRO DUPLICADO: El documento o código ya existe en el sistema',
  'UNIQUE': 'REGISTRO DUPLICADO: Ya existe un registro con estos datos',
  'duplicate': 'REGISTRO DUPLICADO: Ya existe un registro con estos datos',
  'foreign key': 'CONFLICTO DE DATOS: Este registro está vinculado a otros registros',
  'cannot delete': 'NO SE PUEDE ELIMINAR: Este registro tiene dependencias activas',
  'Data too long': 'DATOS EXCEDEN EL LÍMITE: Reduce la longitud del texto ingresado',
  'Incorrect decimal': 'VALOR NUMÉRICO INVÁLIDO: Verifica los campos de precio o cantidad',
  'Out of range': 'NÚMERO FUERA DE RANGO: El valor ingresado es demasiado grande o pequeño',
  'connection refused': 'SIN CONEXIÓN AL SERVIDOR: Verifica que el servidor esté activo',
  'deadline exceeded': 'TIEMPO AGOTADO: El servidor tardó demasiado en responder',
  'record not found': 'REGISTRO NO ENCONTRADO: El elemento ya fue eliminado o no existe',
  'not found': 'REGISTRO NO ENCONTRADO: El elemento no existe en el sistema',
  // Errores de autenticación
  'token': 'SESIÓN EXPIRADA: Cierra sesión e ingresa nuevamente',
  'unauthorized': 'ACCESO DENEGADO: No tienes permisos para esta acción',
  'forbidden': 'ACCESO PROHIBIDO: Tu rol no permite esta operación',
};

/**
 * Analiza un texto de error y busca si coincide con algún error conocido para
 * devolver una descripción más humana.
 */
function translateError(rawError: string): string | null {
  const lower = rawError.toLowerCase();
  for (const [key, translation] of Object.entries(ERROR_TRANSLATIONS)) {
    if (lower.includes(key.toLowerCase())) {
      return translation;
    }
  }
  return null;
}

/**
 * Extrae el mensaje de error más descriptivo de una respuesta HTTP fallida.
 * 
 * @param res - La respuesta HTTP del fetch
 * @param fallback - Mensaje genérico a mostrar si no se puede extraer nada
 * @returns Un string listo para mostrar al usuario en el toast
 */
export async function extractApiError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    
    // Formato 1: Estructurado { error: { code, message, details } }
    if (data?.error && typeof data.error === 'object') {
      const { message, details } = data.error;
      
      // Intentar traducir los detalles técnicos primero (más específicos)
      if (details) {
        const translated = translateError(details);
        if (translated) return translated;
      }
      
      // Si el message del backend ya es descriptivo, usarlo
      if (message && message !== fallback) {
        // Aún así, intentar enriquecer con traducción
        const translated = translateError(message);
        return translated || message.toUpperCase();
      }
    }
    
    // Formato 2: Simple { error: "string" }
    if (data?.error && typeof data.error === 'string') {
      const translated = translateError(data.error);
      return translated || data.error.toUpperCase();
    }

    // Formato 3: { message: "string" } (algunos endpoints legacy)
    if (data?.message && typeof data.message === 'string') {
      const translated = translateError(data.message);
      return translated || data.message.toUpperCase();
    }
    
  } catch {
    // No se pudo parsear el JSON — probablemente error de red o 500 puro
  }
  
  // Usar el código HTTP para dar contexto
  const httpMessages: Record<number, string> = {
    400: 'SOLICITUD INVÁLIDA: Verifica los datos ingresados',
    401: 'SESIÓN EXPIRADA: Cierra sesión e ingresa nuevamente',
    403: 'ACCESO DENEGADO: No tienes permisos para esta acción',
    404: 'NO ENCONTRADO: El recurso solicitado no existe',
    409: 'CONFLICTO: Ya existe un registro con estos datos',
    422: 'DATOS INVÁLIDOS: Revisa los campos del formulario',
    429: 'DEMASIADAS SOLICITUDES: Espera un momento e intenta de nuevo',
    500: 'ERROR INTERNO DEL SERVIDOR: Contacta al administrador',
    502: 'SERVIDOR NO DISPONIBLE: El servicio está temporalmente fuera de línea',
    503: 'SERVICIO NO DISPONIBLE: Intenta de nuevo en unos minutos',
  };
  
  return httpMessages[res.status] || fallback;
}

/**
 * Wrapper para hacer fetch y lanzar un Error con el mensaje descriptivo.
 * 
 * Uso:
 *   const data = await apiFetch('/admin/register-user', { method: 'POST', body: ... }, token);
 */
export async function apiFetch(
  path: string, 
  options: RequestInit & { fallbackError?: string } = {},
  token?: string
): Promise<any> {
  const { fallbackError = 'OPERACIÓN FALLIDA', ...fetchOptions } = options;
  
  const headers: Record<string, string> = {
    ...(fetchOptions.headers as Record<string, string> || {}),
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  if (fetchOptions.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, {
      ...fetchOptions,
      headers,
    });
  } catch (networkError) {
    throw new Error('SIN CONEXIÓN: No se pudo comunicar con el servidor. Verifica tu red.');
  }
  
  if (!res.ok) {
    const errorMsg = await extractApiError(res, fallbackError);
    throw new Error(errorMsg);
  }
  
  // Intentar parsear como JSON, si no se puede, devolver vacío
  try {
    return await res.json();
  } catch {
    return {};
  }
}
