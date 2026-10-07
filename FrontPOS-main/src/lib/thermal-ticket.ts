/**
 * thermal-ticket.ts — Factura térmica POS para rollo de 58mm y 80mm.
 *
 * Se imprime en un iframe aislado con su propio CSS en vez de usar
 * `@media print` sobre la app: así el ticket no hereda nada de Tailwind ni
 * de HeroUI, que descuadran el ancho del rollo y meten márgenes.
 *
 * ARQUITECTURA
 * ------------
 * La construcción del TEXTO monoespaciado del ticket vive en el módulo
 * puro `./thermal-ticket-text.mjs`. Esta capa (TS) añade los wrappers
 * imperativos del navegador: lectura de `pos_printing_config_v1`,
 * render HTML en iframe, canvas 2D para compartir, Telegram multipart.
 *
 * CONFIGURACIÓN PERSISTENTE
 * -------------------------
 * `printThermalTicket` consulta `pos_printing_config_v1` (LocalStorage)
 * cuando el llamador no pasa overrides explícitos. Lo que consume de la
 * config:
 *
 *   - receipt.paper / widthMm        → ancho tipográfico 58/80 mm (via `receiptWidthKey`)
 *   - receipt.columns                → columnas monoespacio
 *   - receipt.header.*               → encabezado del negocio
 *   - receipt.content.showTaxes      → omite la línea de IVA cuando es false
 *   - receipt.footer.thankYou        → mensaje de agradecimiento al pie
 *   - receipt.cut                    → marcador textual MANUAL/AUTO
 *   - receipt.content.showLogo       → embebe <img> en la plantilla HTML
 *   - receipt.content.showValidationQR → rotula la URL de validación en texto
 *
 * `buildTicketText` SIGUE siendo puro: recibe solo lo que le pasa el
 * llamador y nunca toca `localStorage`. Los tests `node --test` lo
 * ejercen sin mocks.
 *
 * SEGURIDAD HTML
 * --------------
 * El iframe recibe valores del usuario (ticketNumber, logoUrl, el texto
 * del ticket completo). Todos pasan por `escapeHtml` antes de inyectarse
 * para evitar que un ticketNumber `</title><script>...` rompa la plantilla.
 */

import {
    PRINTING_CONFIG_STORAGE_KEY,
    loadPrintingConfig,
    receiptWidthKey,
    type PrintingConfig,
} from "./printing-config.mjs";

import {
    STORE,
    buildTicketText,
    charsPerLine,
    escapeHtml,
} from "./thermal-ticket-text.mjs";

import type {
    StoreHeader,
    TicketCutMode,
    TicketData,
    TicketLine,
    TicketPrintOptions,
    TicketWidth,
} from "./thermal-ticket-text.mjs";

// Re-exportaciones públicas: los consumidores (`UniversalPaymentModal`,
// `SaleDetailModal`, etc.) siguen importando de `@/lib/thermal-ticket`.
export { STORE, buildTicketText };
export type { TicketCutMode, TicketData, TicketLine, TicketPrintOptions, TicketWidth };

/**
 * Lee la configuración persistida SOLO en el browser. En Node (SSR o tests)
 * devuelve `null` para preservar la pureza de `buildTicketText`.
 */
function readPersistedConfig(): PrintingConfig | null {
    try {
        if (typeof window === "undefined") return null;
        if (!window.localStorage) return null;
        // Primero vemos si existe la clave: así distinguimos "default implícito"
        // (sin storage) de "default guardado deliberadamente".
        const raw = window.localStorage.getItem(PRINTING_CONFIG_STORAGE_KEY);
        if (!raw) return null;
        return loadPrintingConfig(window.localStorage);
    } catch {
        return null;
    }
}

/**
 * Extrae un override `store` desde el header configurado en /labels/config.
 * Si no hay nada relevante, devuelve `undefined` para que la plantilla
 * caiga al `STORE` default.
 */
function resolveStoreFromConfig(cfg: PrintingConfig): Partial<StoreHeader> | undefined {
    const h = cfg.receipt.header;
    const anySet = !!(h.businessName || h.nit || h.address || h.phone);
    if (!anySet) return undefined;
    return {
        name: h.businessName || undefined,
        nit: h.nit || undefined,
        address: h.address || undefined,
        phone: h.phone || undefined,
    };
}

/** CSS de impresión para rollo térmico. */
function ticketCSS(
    width: TicketWidth,
    customWidthMm?: number,
    fontSizePx?: number,
    cut?: TicketCutMode,
): string {
    const widthValue = customWidthMm && Number.isFinite(customWidthMm) && customWidthMm > 0
        ? `${Math.round(customWidthMm)}mm`
        : width;
    const defaultFont = width === "58mm" ? "10px" : "11.5px";
    const fontSize = fontSizePx && Number.isFinite(fontSizePx) && fontSizePx >= 7 && fontSizePx <= 20
        ? `${fontSizePx}px`
        : defaultFont;
    // Para corte MANUAL marcamos la impresión como "no cortar": muchos
    // drivers ESC/POS respetan `page-break-after: avoid` para desactivar
    // el cutter del propio spooler. En AUTO dejamos el comportamiento
    // nativo del driver y simplemente añadimos un pequeño margen inferior
    // para que el cutter no mastique la última línea.
    const cutCss = cut === "MANUAL"
        ? `html, body { page-break-after: avoid; break-after: avoid; }`
        : cut === "AUTO"
            ? `pre { padding-bottom: 10mm; }`
            : "";
    return `
        @page { size: ${widthValue} auto; margin: 0; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body {
            width: ${widthValue};
            background: #fff;
            color: #000;
        }
        pre {
            font-family: "Courier New", Consolas, monospace;
            font-size: ${fontSize};
            line-height: 1.25;
            font-weight: 700;           /* alto contraste en térmica */
            white-space: pre;
            padding: 2mm 1mm 6mm 1mm;   /* margen inferior para el corte */
            -webkit-font-smoothing: none;
        }
        .ticket-logo {
            display: flex;
            justify-content: center;
            padding: 2mm 1mm 1mm 1mm;
        }
        .ticket-logo img {
            max-width: 90%;
            max-height: 20mm;
            object-fit: contain;
        }
        ${cutCss}
        @media print {
            html, body { width: ${widthValue}; }
        }
    `;
}

/**
 * Resuelve los `TicketPrintOptions` efectivos combinando lo que mandó el
 * llamador con la configuración persistida. El overrides explícito manda:
 * si el llamador fija `showTaxes`, ignoramos lo que diga la config.
 */
function composeEffectiveOptions(
    options: TicketPrintOptions | undefined,
    persisted: PrintingConfig | null,
): TicketPrintOptions {
    const r = persisted?.receipt;
    return {
        columns: options?.columns ?? (r ? r.columns : undefined),
        store: options?.store ?? (persisted ? resolveStoreFromConfig(persisted) : undefined),
        fontSizePx: options?.fontSizePx,
        showTaxes: options?.showTaxes ?? (r ? r.content.showTaxes : undefined),
        thankYou: options?.thankYou ?? (r ? r.footer.thankYou : undefined),
        cut: options?.cut ?? ((r ? r.cut : undefined) as TicketCutMode | undefined),
        showLogo: options?.showLogo ?? (r ? r.content.showLogo : undefined),
        showValidationQR: options?.showValidationQR ?? (r ? r.content.showValidationQR : undefined),
    };
}

/**
 * Decide si realmente podemos embeber un logo. Es honesto: aunque la
 * config diga `showLogo = true`, sin URL no hay nada que pintar.
 */
function logoHtmlOrEmpty(options: TicketPrintOptions, data: TicketData): string {
    if (!options.showLogo) return "";
    const url = typeof data.logoUrl === "string" ? data.logoUrl.trim() : "";
    if (!url) return "";
    return `<div class="ticket-logo"><img src="${escapeHtml(url)}" alt="" /></div>`;
}

/**
 * printThermalTicket imprime el ticket en un iframe oculto. No abre
 * ventanas nuevas (los bloqueadores de pop-ups las matan) y no toca el
 * DOM visible de la app.
 *
 * Cuando `width` NO se pasa, consulta `pos_printing_config_v1` del navegador
 * y usa su `receiptWidthKey`. Si no hay nada persistido (storage limpio o
 * en Node), cae al default histórico de "58mm" para preservar comportamiento.
 * Las columnas, el header del negocio y los toggles de contenido/corte
 * también vienen de la config guardada cuando el llamador no los pasa.
 */
export function printThermalTicket(
    data: TicketData,
    width?: TicketWidth,
    options?: TicketPrintOptions,
): void {
    if (typeof window === "undefined") return;

    const persisted = readPersistedConfig();
    const effectiveWidth: TicketWidth = width || (persisted ? receiptWidthKey(persisted) : "58mm");
    const customWidthMm = persisted && persisted.receipt.paper === "CUSTOM"
        ? persisted.receipt.widthMm
        : undefined;

    const mergedOptions = composeEffectiveOptions(options, persisted);

    const text = buildTicketText(data, effectiveWidth, mergedOptions);
    const escapedText = escapeHtml(text);
    const titleSafe = escapeHtml(String(data.ticketNumber ?? ""));
    const logoHtml = logoHtmlOrEmpty(mergedOptions, data);
    const cutAttr = mergedOptions.cut ? ` data-cut-mode="${escapeHtml(mergedOptions.cut)}"` : "";

    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.position = "fixed";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.style.visibility = "hidden";
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow?.document;
    if (!doc) {
        document.body.removeChild(iframe);
        return;
    }

    doc.open();
    doc.write(
        `<!DOCTYPE html><html><head><meta charset="utf-8">` +
        `<title>Ticket ${titleSafe}</title>` +
        `<style>${ticketCSS(effectiveWidth, customWidthMm, mergedOptions.fontSizePx, mergedOptions.cut)}</style></head>` +
        `<body${cutAttr}>${logoHtml}<pre>${escapedText}</pre></body></html>`,
    );
    doc.close();

    // Se imprime tras el load para que la fuente monoespaciada ya esté
    // aplicada; si no, la primera impresión sale descuadrada.
    const fire = () => {
        try {
            iframe.contentWindow?.focus();
            iframe.contentWindow?.print();
        } finally {
            // Se retira después de un margen para no cancelar el diálogo.
            setTimeout(() => {
                if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
            }, 1500);
        }
    };
    if (iframe.contentWindow?.document.readyState === "complete") fire();
    else iframe.onload = fire;
}

// =============================================================
// Preferencia de impresión automática
// =============================================================
//
// Vive en una SOLA clave canónica (`pos_auto_print`). Antes convivía con la
// clave legacy `pos_auto_print_ticket` que escribía UniversalPaymentModal,
// así que la decisión del cajero podía quedar en una u otra según la
// pantalla donde la configuraba. Al leer honramos la legacy si existe para
// no perder la preferencia histórica; al guardar siempre vamos a la nueva y
// de paso limpiamos la antigua.

const AUTO_PRINT_KEY = "pos_auto_print";
const AUTO_PRINT_KEY_LEGACY = "pos_auto_print_ticket";

export function getAutoPrint(): boolean {
    if (typeof window === "undefined") return false;
    // Prioridad: la clave canónica manda. Si no está escrita, se honra la
    // legacy para no borrar la preferencia del cajero que configuró el flag
    // antes de la unificación. Si no hay ninguna, se asume ACTIVO (default
    // del POS: entregar tirilla).
    const raw = window.localStorage.getItem(AUTO_PRINT_KEY);
    if (raw !== null) return raw === "true";
    const legacy = window.localStorage.getItem(AUTO_PRINT_KEY_LEGACY);
    if (legacy !== null) return legacy === "true";
    return true;
}

export function setAutoPrint(value: boolean): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(AUTO_PRINT_KEY, String(value));
    // La clave vieja se purga para que una próxima lectura por otra vía no
    // reviva el valor anterior.
    try { window.localStorage.removeItem(AUTO_PRINT_KEY_LEGACY); } catch { /* storage lleno */ }
}

// =============================================================
// Render del ticket como imagen (Canvas 2D, sin dependencias extra)
// =============================================================
//
// Se usa la MISMA fuente del ticket impreso (buildTicketText) para que lo
// que el cliente recibe por WhatsApp o Telegram sea idéntico a la tirilla.
// No dependemos de html2canvas ni de ninguna librería nueva: el renderer
// escribe las líneas monoespaciadas directamente en un canvas.

/** Opciones de renderizado. Las medidas default encajan en 58 mm a 203 dpi. */
export interface TicketImageOptions {
    width?: TicketWidth;
    /** Píxeles por carácter de ancho. Default 10 para que entren 32 chars en 320 px. */
    charWidthPx?: number;
    /** Alto de línea en píxeles. */
    lineHeightPx?: number;
    /** Margen (en px) alrededor del bloque de texto. */
    paddingPx?: number;
    /** Multiplicador de resolución para pantallas HiDPI. Default 2. */
    scale?: number;
}

const DEFAULT_IMAGE_OPTIONS: Required<TicketImageOptions> = {
    width: "58mm",
    charWidthPx: 10,
    lineHeightPx: 18,
    paddingPx: 16,
    scale: 2,
};

/**
 * renderTicketCanvas pinta el texto del ticket en un canvas 2D y devuelve
 * el canvas listo para exportarlo (toBlob/toDataURL). Es sincrónico y no
 * requiere red: perfecto para fallback offline.
 */
export function renderTicketCanvas(
    data: TicketData,
    options: TicketImageOptions = {},
): HTMLCanvasElement {
    if (typeof document === "undefined") {
        throw new Error("renderTicketCanvas requiere un entorno de navegador");
    }
    const config: Required<TicketImageOptions> = { ...DEFAULT_IMAGE_OPTIONS, ...options };
    const text = buildTicketText(data, config.width);
    const lines = text.split("\n");

    const columns = charsPerLine(config.width);
    const width = Math.ceil(columns * config.charWidthPx) + config.paddingPx * 2;
    const height = Math.ceil(lines.length * config.lineHeightPx) + config.paddingPx * 2;

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * config.scale);
    canvas.height = Math.round(height * config.scale);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D no disponible en este entorno");

    ctx.scale(config.scale, config.scale);
    // Fondo blanco: la impresora térmica mete contraste negativo si llega
    // transparente y los clientes de chat lo pintan sobre el tema del celular.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = "#000000";
    ctx.textBaseline = "top";
    // Font monoespaciada en negrita para empujar contraste, igual que el CSS
    // de impresión en ticketCSS.
    const fontSize = Math.max(12, Math.floor(config.lineHeightPx * 0.78));
    ctx.font = `700 ${fontSize}px "Courier New", Consolas, monospace`;

    let y = config.paddingPx;
    for (const line of lines) {
        ctx.fillText(line.replace(/\t/g, "    "), config.paddingPx, y);
        y += config.lineHeightPx;
    }

    return canvas;
}

/**
 * ticketImageBlob exporta el canvas rendizado a un Blob PNG. Si el navegador
 * no soporta `canvas.toBlob` cae a `toDataURL` + conversión manual para
 * mantener el flujo en Safari antiguos.
 */
export function ticketImageBlob(
    data: TicketData,
    options: TicketImageOptions = {},
): Promise<Blob> {
    return new Promise((resolve, reject) => {
        try {
            const canvas = renderTicketCanvas(data, options);
            if (typeof canvas.toBlob === "function") {
                canvas.toBlob((blob) => {
                    if (blob) resolve(blob);
                    else reject(new Error("Canvas.toBlob devolvió null"));
                }, "image/png");
                return;
            }
            const dataUrl = canvas.toDataURL("image/png");
            const base64 = dataUrl.split(",")[1] ?? "";
            const bin = atob(base64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            resolve(new Blob([bytes], { type: "image/png" }));
        } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
        }
    });
}

/** Nombre sugerido del archivo PNG. Útil para `download` y `share`. */
export function ticketImageFileName(data: TicketData): string {
    const id = String(data.ticketNumber ?? "ticket").replace(/[^a-zA-Z0-9_-]/g, "");
    return `ticket-${id || "pos"}.png`;
}

// =============================================================
// Envío digital
// =============================================================

/** Enlace de WhatsApp con el ticket como texto completo (fallback plano). */
export function whatsappTicketURL(data: TicketData, phone?: string): string {
    const text = buildTicketText(data, "58mm");
    const clean = (phone || data.clientPhone || "").replace(/\D/g, "");
    // Colombia: si el número viene sin indicativo se le agrega el 57.
    const withCode = clean.length === 10 ? `57${clean}` : clean;
    const base = withCode ? `https://wa.me/${withCode}` : "https://wa.me/";
    return `${base}?text=${encodeURIComponent(text)}`;
}

/**
 * Nota corta que se usa como pie del WhatsApp cuando la factura va como
 * imagen adjunta. Antes el fallback mandaba el ticket completo con emojis,
 * duplicando el detalle: el cliente abría WhatsApp con 40 líneas de texto
 * aunque el PNG ya iba adjunto. Esto deja solo el aviso de que se adjunta la
 * imagen y los datos indispensables (número + total).
 */
export function whatsappShortTicketText(data: TicketData): string {
    const totalFormatted = `$${Math.round(data.total).toLocaleString("es-CO")}`;
    const number = String(data.ticketNumber ?? "S/N");
    return [
        `Factura #${number} — ${STORE.name}`,
        `Total: ${totalFormatted}`,
        "Te adjunto la factura como imagen.",
    ].join("\n");
}

/**
 * Enlace de WhatsApp para el caso en que la imagen se descargue aparte y el
 * cliente la adjunte manualmente. Lleva un texto corto que explica que viene
 * la imagen; NO repite el detalle completo del ticket.
 */
export function whatsappShortURL(data: TicketData, phone?: string): string {
    const text = whatsappShortTicketText(data);
    const clean = (phone || data.clientPhone || "").replace(/\D/g, "");
    const withCode = clean.length === 10 ? `57${clean}` : clean;
    const base = withCode ? `https://wa.me/${withCode}` : "https://wa.me/";
    return `${base}?text=${encodeURIComponent(text)}`;
}

/**
 * canShareFiles comprueba, de forma defensiva, si el navegador soporta el
 * share nativo con archivos adjuntos. Es sincrónico y no abre ningún
 * diálogo: solo se usa para decidir el camino de compartir.
 */
export function canShareFiles(files: File[]): boolean {
    if (typeof navigator === "undefined") return false;
    const nav = navigator as Navigator & { canShare?: (data: { files?: File[] }) => boolean };
    if (typeof nav.share !== "function") return false;
    // iOS Safari expone share() pero no canShare(): asumimos que soporta
    // archivos cuando la API share está pero canShare no, dejando que el
    // usuario reciba el fallback si llegara a fallar.
    if (typeof nav.canShare !== "function") return true;
    try {
        return nav.canShare({ files });
    } catch {
        return false;
    }
}

/**
 * Dispara el flujo recomendado para compartir el PNG del ticket:
 *
 *   1. Si el navegador soporta `navigator.share({ files })`, lo usa.
 *   2. Si no, descarga el PNG localmente y abre WhatsApp con un texto corto
 *      que le dice al cajero "adjunta la factura descargada". No se vuelve a
 *      mandar el detalle completo por chat.
 *
 * Devuelve el método que terminó usándose, útil para el toast de feedback.
 */
export async function shareTicketImage(
    data: TicketData,
    options: { phone?: string; imageOptions?: TicketImageOptions } = {},
): Promise<"share" | "download+whatsapp"> {
    if (typeof window === "undefined") throw new Error("shareTicketImage requiere navegador");
    const blob = await ticketImageBlob(data, options.imageOptions);
    const fileName = ticketImageFileName(data);
    const file = new File([blob], fileName, { type: "image/png" });

    if (canShareFiles([file])) {
        try {
            await (navigator as Navigator & { share: (data: ShareData & { files?: File[] }) => Promise<void> })
                .share({
                    title: `Factura ${data.ticketNumber}`,
                    text: whatsappShortTicketText(data),
                    files: [file],
                });
            return "share";
        } catch (err) {
            // El usuario puede cancelar: en ese caso no hay fallback (lo pidió).
            if (err instanceof Error && err.name === "AbortError") return "share";
            // Si falló por otra razón, caemos al flujo de descarga.
        }
    }

    // Fallback: descargar el PNG + abrir WhatsApp con el texto corto.
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    // Pequeño delay para que el navegador procese la descarga antes de abrir
    // la nueva pestaña, de lo contrario Chrome puede ignorarla.
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    const whatsappUrl = whatsappShortURL(data, options.phone);
    window.open(whatsappUrl, "_blank");
    return "download+whatsapp";
}

/**
 * sendTicketImageToTelegram sube el PNG renderizado al backend como
 * multipart/form-data en el endpoint protegido `POST /telegram/ticket-image`.
 *
 * Contrato con el backend (Go — `notification_ticket_image_handler.go`):
 *  - Headers: `Authorization: Bearer <token>`.
 *  - FormData con el campo **`image`** (File PNG, nombre `ticket-<id>.png`).
 *    El backend lee `c.FormFile("image")`; cualquier otro nombre devuelve
 *    400 ("Debe adjuntar el PNG en el campo \"image\""). El nombre del
 *    campo es parte del contrato público — no lo renombres.
 *  - El backend valida MIME (image/png) + firma mágica `89 50 4E 47` antes
 *    de pasar al bot. Si valida, reutiliza `TelegramService.SendPhoto`.
 *  - Límite razonable: ~2 MB. El renderer actual produce ~40–80 KB para un
 *    ticket típico, así que queda muy debajo del tope.
 *
 * Se mantiene `POST /telegram/ticket` (texto plano) para compatibilidad con
 * backends viejos y como fallback si la imagen fallara por tamaño.
 */
export async function sendTicketImageToTelegram(
    data: TicketData,
    options: { token: string; apiBase: string; caption?: string; imageOptions?: TicketImageOptions },
): Promise<{ ok: boolean; status: number }> {
    const blob = await ticketImageBlob(data, options.imageOptions);
    const form = new FormData();
    // Campo "image": el backend hace c.FormFile("image"). Cambiarle el nombre
    // rompe el endpoint silenciosamente — el guardián en
    // tests/thermal-ticket-sharing.test.mjs fija este contrato.
    form.append("image", new File([blob], ticketImageFileName(data), { type: "image/png" }));
    if (options.caption) form.append("caption", options.caption);

    const url = `${options.apiBase.replace(/\/+$/, "")}/telegram/ticket-image`;
    const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.token}` },
        body: form,
    });
    return { ok: response.ok, status: response.status };
}

// =============================================================
// Reimpresión desde el historial de ventas
// =============================================================

/**
 * saleToTicket convierte una venta ya guardada (historial) al mismo
 * formato de ticket que usa la caja, para poder reimprimir o reenviar un
 * comprobante idéntico al original.
 *
 * Se tolera la forma flexible del objeto Sale porque el historial y la
 * caja exponen los campos con nombres distintos según el endpoint.
 */
export function saleToTicket(sale: any, paymentMethod?: string): TicketData {
    const details: any[] = Array.isArray(sale?.details)
        ? sale.details
        : Array.isArray(sale?.saleDetails)
            ? sale.saleDetails
            : [];

    const lines: TicketLine[] = details.map((d) => {
        const quantity = Number(d.quantity) || 0;
        const total = Number(d.subtotal) || 0;
        const unitPrice = Number(d.unitPrice) || (quantity > 0 ? total / quantity : 0);
        return {
            name: d.product?.productName || d.productName || d.barcode || "PRODUCTO",
            quantity,
            unitPrice,
            total: total || unitPrice * quantity,
        };
    });

    const total = Number(sale?.total ?? sale?.totalAmount) || 0;
    const cash = Number(sale?.cashAmount) || 0;
    const change = Number(sale?.change) || 0;
    const credit = Number(sale?.creditAmount) || 0;
    const transferAmount = Number(sale?.transferAmount) || 0;
    const transferNequi = Number(sale?.transferNequi) || 0;
    const transferDaviplata = Number(sale?.transferDaviplata) || 0;
    const transferSource = typeof sale?.transferSource === "string" ? sale.transferSource : "";
    const rawDate = sale?.date || sale?.saleDate;

    // Reglas: si el llamador no mando `paymentMethod`, lo componemos desde el
    // DESGLOSE real de la venta. Antes el fallback mostraba solo "EFECTIVO" o
    // "TRANSFERENCIA" segun hubiera cash o no, lo que escondia las ventas
    // mixtas (p.ej. Nequi + Daviplata) y las imprimia como una sola etiqueta
    // generica. Preservamos "MIXTO" solo como ultimo recurso si no hay
    // ningun monto > 0 pero la venta antigua traia ese literal.
    function fallbackPaymentMethod(): string {
        const parts: string[] = [];
        if (cash > 0) parts.push("EFECTIVO");
        if (transferNequi > 0) parts.push("NEQUI");
        if (transferDaviplata > 0) parts.push("DAVIPLATA");
        const otherTransfer = transferAmount - transferNequi - transferDaviplata;
        if (otherTransfer > 0.5) {
            const src = transferSource.toUpperCase().trim();
            const forbidden = new Set(["", "MIXTO", "NEQUI", "DAVIPLATA"]);
            parts.push(forbidden.has(src) ? "TRANSFERENCIA" : src);
        }
        if (credit > 0) parts.push("FIADO");
        if (parts.length > 0) return parts.join(" + ");
        const legacy = (sale?.paymentMethod || "").toString().toUpperCase().trim();
        if (legacy) return legacy;
        return credit > 0 ? "FIADO" : cash > 0 ? "EFECTIVO" : "TRANSFERENCIA";
    }

    return {
        ticketNumber: sale?.id ?? sale?.saleId ?? "S/N",
        date: rawDate ? new Date(rawDate) : new Date(),
        cashier: sale?.employee?.name || sale?.employeeName || sale?.employeeDni || "OPERADOR",
        clientName: sale?.client?.name,
        clientDni: sale?.client?.dni,
        clientPhone: sale?.client?.phone,
        lines,
        subtotal: total,
        taxes: 0,
        total,
        paymentMethod: paymentMethod || fallbackPaymentMethod(),
        received: cash > 0 ? cash : undefined,
        change: change > 0 ? change : undefined,
        note: credit > 0
            ? `Queda pendiente de fiado: $${Math.round(credit).toLocaleString("es-CO")}`
            : undefined,
    };
}
