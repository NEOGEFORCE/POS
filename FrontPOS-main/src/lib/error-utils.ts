/**
 * extractErrorMessage - Extracts a human-readable error message from any API error response.
 * Handles: standard JSON { error: { message } }, Factus 422 validation maps,
 * plain text responses, and network failures.
 */
export function extractErrorMessage(error: unknown, fallback = "Error inesperado"): string {
  // Axios-style error with response
  if (error && typeof error === 'object' && 'response' in error) {
    const axiosErr = error as any;
    const data = axiosErr.response?.data;

    if (data) {
      // Case 1: Standard { error: { message: "..." } }
      if (data.error?.message) return data.error.message;

      // Case 2: Standard { message: "..." }
      if (data.message && typeof data.message === 'string') return data.message;

      // Case 3: Factus/DIAN 422 validation map { errors: { field: ["msg", ...] } }
      if (data.errors && typeof data.errors === 'object') {
        const messages: string[] = [];
        for (const [field, errs] of Object.entries(data.errors)) {
          if (Array.isArray(errs)) {
            messages.push(`${field}: ${errs.join(', ')}`);
          } else if (typeof errs === 'string') {
            messages.push(`${field}: ${errs}`);
          }
        }
        if (messages.length > 0) {
          return `Error de validacion: ${messages.join(' | ')}`;
        }
      }

      // Case 4: Array of errors [{ message: "..." }]
      if (Array.isArray(data) && data[0]?.message) {
        return data.map((e: any) => e.message).join(', ');
      }

      // Case 5: Plain string body
      if (typeof data === 'string' && data.length < 200) return data;
    }

    // Case 6: HTTP status-based fallback
    const status = axiosErr.response?.status;
    if (status === 401) return "Sesion expirada. Inicie sesion nuevamente.";
    if (status === 403) return "No tiene permisos para realizar esta accion.";
    if (status === 404) return "El recurso solicitado no fue encontrado.";
    if (status === 409) return "Conflicto: el registro ya existe o fue modificado.";
    if (status === 422) return "Error de validacion: verifique los campos ingresados.";
    if (status === 500) return "Error interno del servidor. Contacte al administrador.";
    if (status === 503) return "El servidor no esta disponible. Intente mas tarde.";
  }

  // Fetch API response object
  if (error && typeof error === 'object' && 'status' in error && 'json' in error) {
    // Already parsed in the catch block of fetch calls
  }

  // Standard Error object
  if (error instanceof Error) {
    if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      return "Sin conexion al servidor. Verifique su red.";
    }
    return error.message;
  }

  // String error
  if (typeof error === 'string') return error;

  return fallback;
}

/**
 * extractFetchError - For fetch() responses that are not ok.
 * Parses the response body and returns a descriptive error.
 */
export async function extractFetchError(res: Response, fallback = "Error en la operacion"): Promise<string> {
  try {
    const data = await res.json();

    if (data.error?.message) return data.error.message;
    if (data.message && typeof data.message === 'string') return data.message;

    // Factus 422 map
    if (data.errors && typeof data.errors === 'object') {
      const messages: string[] = [];
      for (const [field, errs] of Object.entries(data.errors)) {
        if (Array.isArray(errs)) {
          messages.push(`${field}: ${errs.join(', ')}`);
        } else if (typeof errs === 'string') {
          messages.push(`${field}: ${errs}`);
        }
      }
      if (messages.length > 0) {
        return `Error de validacion: ${messages.join(' | ')}`;
      }
    }

    if (typeof data === 'string') return data;
  } catch {
    // JSON parse failed, try text
    try {
      const text = await res.text();
      if (text && text.length < 200) return text;
    } catch { /* ignore */ }
  }

  // HTTP status fallback
  if (res.status === 401) return "Sesion expirada. Inicie sesion nuevamente.";
  if (res.status === 403) return "No tiene permisos para realizar esta accion.";
  if (res.status === 404) return "El recurso solicitado no fue encontrado.";
  if (res.status === 422) return "Error de validacion: verifique los campos ingresados.";
  if (res.status === 500) return "Error interno del servidor.";

  return fallback;
}
