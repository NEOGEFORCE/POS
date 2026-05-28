/**
 * Error personalizado de API que conserva status HTTP y datos del backend
 */
import { API_URL } from './constants';
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
  '1062': 'Registro Duplicado: Ya existe un elemento con este código o nombre',
  'UNIQUE': 'Registro Duplicado: Este dato ya está registrado',
  'duplicate': 'Registro Duplicado: Este dato ya está registrado',
  'foreign key': 'Conflicto de Vínculos: Este elemento tiene información asociada que impide la acción',
  'cannot delete': 'Bloqueo de Eliminación: Primero debes borrar o desvincular los registros relacionados',
  'Data too long': 'Texto Demasiado Largo: Por favor, reduce la descripción o el nombre',
  'Incorrect decimal': 'Error Numérico: Verifica que los números sean válidos',
  'Out of range': 'Número Inválido: El valor es demasiado alto para el sistema',
  'connection refused': 'Fallo de Conexión: No hay comunicación con el servidor central',
  'deadline exceeded': 'Tiempo Excedido: La respuesta tardó mucho, intenta de nuevo',
  'record not found': 'No Encontrado: El registro no existe o fue eliminado por otro usuario',
  'not found': 'Búsqueda sin Resultados: No se encontró lo que buscas',
  
  // Errores de Inventario / POS
  'insufficient stock': 'Sin Inventario: No hay suficiente stock para realizar esta venta',
  'out of stock': 'Producto Agotado: No puedes vender este producto sin existencias',
  'low stock': 'Advertencia: El stock está por debajo del mínimo permitido',
  'invalid price': 'Precio Inválido: El precio de venta no puede ser menor al de costo',
  'negative quantity': 'Cantidad Inválida: No se permiten valores negativos en este campo',
  'stock cannot be negative': 'Error de Stock: El inventario no puede quedar en negativo para este producto',
  'already exists': 'Ya Existe: Ese código o nombre ya está en uso',
  'bad request': 'Datos Inválidos: Revisa la información ingresada',
  'internal server error': 'Fallo Interno: Hubo un error en el servidor, contacta a soporte',
  'network error': 'Error de Red: Verifica tu conexión a internet',
  'timeout': 'Tiempo Excedido: El servidor tardó demasiado en responder',
  
  // Errores de autenticación
  'token': 'Sesión Expirada: Tu ingreso ha caducado, por favor vuelve a entrar',
  'unauthorized': 'Sin Permisos: No tienes autorización para realizar esta operación',
  'forbidden': 'Rol Restringido: Tu nivel de acceso no permite entrar aquí',
  'invalid credentials': 'Datos Incorrectos: El usuario o la contraseña no coinciden',
  'user not found': 'Usuario no Existe: Revisa el nombre de usuario ingresado',
  'password too short': 'Contraseña Débil: Debe tener al menos 6 caracteres',

  // Errores de validación de campos (Gin/Gorm)
  'required': 'Campo Faltante: Es obligatorio completar este dato',
  'unmarshal': 'Formato Erróneo: El valor ingresado no es del tipo esperado (ej: letras en un campo numérico)',
  'unsupported format': 'Formato no Válido: Verifica los datos ingresados',
  'json: cannot unmarshal': 'Dato Inválido: Ingresaste un texto donde se esperaba un número o viceversa',
};

/**
 * Convierte nombres de campos técnicos del backend a nombres amigables para el usuario.
 */
function humanizeFieldName(field: string): string {
  const fields: Record<string, string> = {
    'productName': 'Nombre del Producto',
    'product_name': 'Nombre del Producto',
    'barcode': 'Código de Barras',
    'salePrice': 'Precio de Venta',
    'sale_price': 'Precio de Venta',
    'purchasePrice': 'Precio de Compra',
    'purchase_price': 'Precio de Compra',
    'quantity': 'Cantidad/Stock',
    'minStock': 'Stock Mínimo',
    'min_stock': 'Stock Mínimo',
    'categoryId': 'Categoría',
    'category_id': 'Categoría',
    'supplierId': 'Proveedor',
    'supplier_id': 'Proveedor',
    'dni': 'Documento de Identidad',
    'email': 'Correo Electrónico',
    'phone': 'Teléfono',
    'address': 'Dirección',
    'amount': 'Monto/Valor',
    'description': 'Descripción',
    'name': 'Nombre',
    'role': 'Nivel de Permisos',
    'password': 'Contraseña',
    'tax_id': 'NIT/RUT',
    'iva': 'Impuesto IVA',
    'packMultiplier': 'Multiplicador de Pack',
    'paymentSource': 'Fuente de Pago',
    'payment_source': 'Fuente de Pago',
    'salariesDetail': 'Detalle de Nómina',
    'expensesDetail': 'Detalle de Gastos',
    'physicalCash': 'Efectivo Físico',
    'physical_cash': 'Efectivo Físico',
  };

  return fields[field] || field.replace(/([A-Z])/g, ' $1').toUpperCase();
}

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
    
    // Prioridad 1: Nueva estructura global {"success": false, "message": "..."}
    if (data?.success === false && typeof data.message === 'string') {
      const translated = translateError(data.message);
      return translated || data.message;
    }

    // Prioridad 2: Estructura de campos detallados { error: { fields: { ... } } }
    if (data?.error?.fields || data?.error?.metadata) {
      const errorContext = data.error.fields || data.error.metadata;
      if (errorContext && typeof errorContext === 'object') {
        const fieldMsgs = Object.entries(errorContext).map(([key, msg]) => {
          const friendlyField = humanizeFieldName(key);
          const friendlyMsg = typeof msg === 'string' ? (translateError(msg) || msg) : 'Dato inválido';
          return `${friendlyField}: ${friendlyMsg}`;
        });
        if (fieldMsgs.length > 0) return `Revisa: ${fieldMsgs.join(' | ')}`;
      }
    }
    
    // Prioridad 3: Formato estructurado legacy { error: { message, details } }
    if (data?.error && typeof data.error === 'object') {
      const { message, details } = data.error;
      const translatedDetails = details ? translateError(details) : null;
      if (translatedDetails) return translatedDetails;
      
      const translatedMsg = message ? translateError(message) : null;
      if (translatedMsg) return translatedMsg;

      if (message) return message;
      if (details) return details;
    }
    
    // Formato 4: Simple { error: "string" } o { message: "string" }
    const directMsg = data?.error || data?.message;
    if (typeof directMsg === 'string') {
      const translated = translateError(directMsg);
      return translated || directMsg;
    }
    
  } catch {
    // No se pudo parsear el JSON
  }
  
  // Usar el código HTTP para dar contexto
  const httpMessages: Record<number, string> = {
    400: 'Datos Incompletos: Revisa que todos los campos obligatorios estén llenos',
    401: 'Acceso Caducado: Vuelve a ingresar tus credenciales',
    403: 'Sin Autorización: No tienes permiso para realizar esta acción',
    404: 'No Encontrado: Lo que buscas no existe o ha sido movido',
    409: 'Duplicado: Estos datos ya pertenecen a otro registro activo',
    422: 'Error de Validación: Corrige los datos marcados antes de continuar',
    429: 'Sistema Ocupado: Espera unos segundos y vuelve a intentar',
    500: 'Fallo Técnico: Hubo un error en el servidor. Intenta de nuevo.',
    502: 'Error de Puerta de Enlace: Problemas de comunicación con el servidor',
    503: 'Servidor en Mantenimiento: Intenta en unos minutos',
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
    res = await fetch(`${API_URL}${path}`, {
      ...fetchOptions,
      headers,
    });
  } catch (networkError) {
    throw new Error('SIN CONEXIÓN: No se pudo comunicar con el servidor. Verifica tu red.');
  }
  
  if (!res.ok) {
    // Clonar la respuesta antes de consumirla para evitar el error "body is already used"
    const clonedRes = res.clone();
    const errorMsg = await extractApiError(res, fallbackError);
    const errorData = await clonedRes.json().catch(() => null);
    
    throw new ApiError(errorMsg, res.status, errorData);
  }
  
  // Intentar parsear como JSON, si no se puede, devolver vacío
  try {
    return await res.json();
  } catch {
    return {} as T;
  }
}
