/**
 * Error personalizado de API que conserva status HTTP y datos del backend
 */
export class ApiError extends Error {
  status: number;
  data?: any;
  
  constructor(message: string, status: number, data?: any) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

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
  // Errores de validación de campos (Gin/Gorm)
  'required': 'CAMPO OBLIGATORIO: Faltan datos necesarios',
  'is_active': 'ESTADO DE ACCESO',
  'dni': 'DOCUMENTO DE IDENTIDAD (DNI)',
  'role': 'NIVEL DE ROL / PERMISOS',
  'email': 'CORREO ELECTRÓNICO',
  'unmarshal': 'ERROR DE FORMATO: Los datos enviados no son válidos para el servidor',
  'unsupported format': 'FORMATO NO SOPORTADO: Verifica que los campos numéricos contengan solo números',
  'json: cannot unmarshal': 'VALOR INVÁLIDO: Uno de los campos tiene un formato incompatible con el servidor',
};

/**
 * Analiza un texto de error y busca si coincide con algún error conocido para
 * devolver una descripción más humana.
 */
function translateError(rawError: string): string | null {
  const lower = rawError.toLowerCase();

  // Bloqueo de jerga técnica (Go/JSON/GORM/MySQL)
  const technicalJargon = [
    'json:', 'unmarshal', 'marshal', 'struct', 'field', 'pointer', 'nil', 
    'unexpected EOF', 'syntax error', 'mysql', 'sql', 'gorm', 'uint', 'int64'
  ];

  if (technicalJargon.some(word => lower.includes(word))) {
    return 'FALLO DE PROCESAMIENTO: Uno de los datos tiene un formato no reconocido por el sistema';
  }

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
      if (message && message !== fallback && !message.toLowerCase().includes("formato de datos")) {
        // Aún así, intentar enriquecer con traducción
        const translated = translateError(message);
        return translated || message.toUpperCase();
      }

      // Si llegamos aquí y hay detalles, devolver los detalles (aunque no tengan traducción oficial)
      if (details) {
        return details.toUpperCase();
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
export async function apiFetch<T = any>(
  path: string, 
  options: RequestInit & { fallbackError?: string } = {},
  token?: string
): Promise<T> {
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
    const errorData = await res.json().catch(() => null);
    const errorMsg = await extractApiError(res, fallbackError);
    throw new ApiError(errorMsg, res.status, errorData);
  }
  
  // Intentar parsear como JSON, si no se puede, devolver vacío
  try {
    return await res.json();
  } catch {
    return {} as T;
  }
}
