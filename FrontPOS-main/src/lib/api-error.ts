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
  '1062': 'REGISTRO DUPLICADO: Ya existe un elemento con este código o nombre',
  'UNIQUE': 'REGISTRO DUPLICADO: Este dato ya está registrado',
  'duplicate': 'REGISTRO DUPLICADO: Este dato ya está registrado',
  'foreign key': 'CONFLICTO DE VÍNCULOS: Este elemento tiene información asociada que impide la acción',
  'cannot delete': 'BLOQUEO DE ELIMINACIÓN: Primero debes borrar o desvincular los registros relacionados',
  'Data too long': 'TEXTO DEMASIADO LARGO: Por favor, reduce la descripción o el nombre',
  'Incorrect decimal': 'ERROR EN PRECIO/CANTIDAD: Verifica que los números sean válidos',
  'Out of range': 'NÚMERO INVÁLIDO: El valor es demasiado alto para el sistema',
  'connection refused': 'FALLO DE CONEXIÓN: No hay comunicación con el servidor central',
  'deadline exceeded': 'TIEMPO EXCEDIDO: La respuesta tardó mucho, intenta de nuevo',
  'record not found': 'NO ENCONTRADO: El registro no existe o fue eliminado por otro usuario',
  'not found': 'BÚSQUEDA SIN RESULTADOS: No se encontró lo que buscas',
  
  // Errores de Inventario / POS
  'insufficient stock': 'SIN INVENTARIO: No hay suficiente stock para realizar esta venta',
  'out of stock': 'PRODUCTO AGOTADO: No puedes vender este producto sin existencias',
  'low stock': 'ADVERTENCIA: El stock está por debajo del mínimo permitido',
  'invalid price': 'PRECIO INVÁLIDO: El precio de venta no puede ser menor al de costo',
  'negative quantity': 'CANTIDAD INVÁLIDA: No se permiten valores negativos en este campo',
  'stock cannot be negative': 'ERROR DE STOCK: El inventario no puede quedar en negativo para este producto',
  'already exists': 'YA EXISTE: Ese código o nombre ya está en uso',
  'bad request': 'DATOS INVÁLIDOS: Revisa la información ingresada',
  'internal server error': 'FALLO INTERNO: Hubo un error en el servidor, contacta a soporte',
  'network error': 'ERROR DE RED: Verifica tu conexión a internet',
  'timeout': 'TIEMPO EXCEDIDO: El servidor tardó demasiado en responder',
  
  // Errores de autenticación
  'token': 'SESIÓN EXPIRADA: Tu ingreso ha caducado, por favor vuelve a entrar',
  'unauthorized': 'SIN PERMISOS: No tienes autorización para realizar esta operación',
  'forbidden': 'ROL RESTRINGIDO: Tu nivel de acceso no permite entrar aquí',
  'invalid credentials': 'DATOS INCORRECTOS: El usuario o la contraseña no coinciden',
  'user not found': 'USUARIO NO EXISTE: Revisa el nombre de usuario ingresado',
  'password too short': 'CONTRASEÑA DÉBIL: Debe tener al menos 6 caracteres',

  // Errores de validación de campos (Gin/Gorm)
  'required': 'CAMPO FALTANTE: Es obligatorio completar este dato',
  'unmarshal': 'FORMATO ERRONEO: El valor ingresado no es del tipo esperado (ej: letras en un campo numérico)',
  'unsupported format': 'ARCHIVO O FORMATO NO VÁLIDO: Verifica los datos ingresados',
  'json: cannot unmarshal': 'DATO INVÁLIDO: Ingresaste un texto donde se esperaba un número o viceversa',
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
    
    // Formato 1: Estructurado { error: { code, message, details, fields } }
    if (data?.error && typeof data.error === 'object') {
      const { message, details, fields } = data.error;
      
      // Si hay errores de campos específicos (en 'fields' o 'metadata'), construir un mensaje detallado
      const errorContext = fields || data.error.metadata;
      if (errorContext && typeof errorContext === 'object' && Object.keys(errorContext).length > 0) {
        const fieldMsgs = Object.entries(errorContext).map(([key, msg]) => {
          const friendlyField = humanizeFieldName(key);
          const friendlyMsg = typeof msg === 'string' ? (translateError(msg) || msg) : 'Dato inválido o faltante';
          return `${friendlyField}: ${friendlyMsg}`;
        });
        if (fieldMsgs.length > 0) {
            return `REVISA LO SIGUIENTE:\n${fieldMsgs.join('\n')}`.toUpperCase();
        }
      }

      // Intentar traducir los detalles técnicos primero (más específicos)
      if (details) {
        const translated = translateError(details);
        if (translated) return translated;
      }
      
      // Si el message del backend ya es descriptivo, usarlo
      if (message && message !== fallback && !message.toLowerCase().includes("formato de datos")) {
        const translated = translateError(message);
        return translated || message.toUpperCase();
      }

      if (details) return details.toUpperCase();
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
    // No se pudo parsear el JSON
  }
  
  // Usar el código HTTP para dar contexto
  const httpMessages: Record<number, string> = {
    400: 'DATOS INCOMPLETOS: Revisa que todos los campos obligatorios estén llenos',
    401: 'ACCESO CADUCADO: Vuelve a ingresar tus credenciales',
    403: 'SIN AUTORIZACIÓN: No tienes permiso para realizar esta acción',
    404: 'NO ENCONTRADO: Lo que buscas no existe o ha sido movido',
    409: 'DUPLICADO: Estos datos ya pertenecen a otro registro activo',
    422: 'ERROR DE VALIDACIÓN: Corrige los datos marcados antes de continuar',
    429: 'SISTEMA OCUPADO: Espera unos segundos y vuelve a intentar',
    500: 'FALLO TÉCNICO: Hubo un error en el servidor. Intenta de nuevo.',
    502: 'ERROR DE PUERTA DE ENLACE: Problemas de comunicación con el servidor',
    503: 'SERVIDOR EN MANTENIMIENTO: Intenta en unos minutos',
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
