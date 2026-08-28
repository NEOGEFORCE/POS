/**
 * thermal-ticket.ts — Factura térmica POS para rollo de 58mm y 80mm.
 *
 * Se imprime en un iframe aislado con su propio CSS en vez de usar
 * `@media print` sobre la app: así el ticket no hereda nada de Tailwind ni
 * de HeroUI, que descuadran el ancho del rollo y meten márgenes.
 */

export type TicketWidth = "58mm" | "80mm";

export interface TicketLine {
    name: string;
    quantity: number;
    unitPrice: number;
    total: number;
}

export interface TicketData {
    ticketNumber: string | number;
    date: Date;
    cashier: string;
    clientName?: string;
    clientDni?: string;
    clientPhone?: string;
    lines: TicketLine[];
    subtotal: number;
    taxes?: number;
    total: number;
    paymentMethod: string;
    received?: number;
    change?: number;
    /** Nota opcional al pie (ej. saldo de fiado pendiente). */
    note?: string;
}

// Datos fijos del negocio.
export const STORE = {
    name: "SUPERMERCADO SURTIFAMILIAR",
    nit: "NIT 1.121.876.543-1",
    address: "Villavicencio, Meta",
    phone: "Tel. 320 000 0000",
};

/** Caracteres por línea según el ancho del rollo. */
function charsPerLine(width: TicketWidth): number {
    return width === "58mm" ? 32 : 48;
}

function money(v: number): string {
    const neg = v < 0;
    const digits = Math.round(Math.abs(v)).toString();
    let out = "";
    for (let i = 0; i < digits.length; i++) {
        if (i > 0 && (digits.length - i) % 3 === 0) out += ".";
        out += digits[i];
    }
    return `${neg ? "-" : ""}$${out}`;
}

function pad(text: string, len: number): string {
    return text.length >= len ? text.slice(0, len) : text + " ".repeat(len - text.length);
}

function padLeft(text: string, len: number): string {
    return text.length >= len ? text.slice(-len) : " ".repeat(len - text.length) + text;
}

function center(text: string, width: number): string {
    if (text.length >= width) return text.slice(0, width);
    const left = Math.floor((width - text.length) / 2);
    return " ".repeat(left) + text;
}

/** Parte un nombre largo en varias líneas sin cortar palabras. */
function wrap(text: string, width: number): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = "";
    for (const w of words) {
        if (current === "") current = w;
        else if ((current + " " + w).length <= width) current += " " + w;
        else {
            lines.push(current);
            current = w;
        }
    }
    if (current) lines.push(current);
    return lines.length ? lines : [""];
}

function formatDateTime(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    let h = d.getHours();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(h)}:${p(d.getMinutes())} ${ampm}`;
}

/**
 * buildTicketText arma el ticket como texto monoespaciado. Se usa tanto
 * para imprimir como para enviarlo por Telegram o WhatsApp, así que lo que
 * ve el cliente en el chat es idéntico al papel.
 */
export function buildTicketText(data: TicketData, width: TicketWidth = "58mm"): string {
    const W = charsPerLine(width);
    const sep = "-".repeat(W);
    const dotted = ".".repeat(W);
    const out: string[] = [];

    // --- Encabezado ---
    out.push(center(STORE.name, W));
    out.push(center(STORE.nit, W));
    out.push(center(STORE.address, W));
    out.push(center(STORE.phone, W));
    out.push(sep);

    // --- Datos de la transacción ---
    out.push(`TICKET #${data.ticketNumber}`);
    out.push(formatDateTime(data.date));
    out.push(`Cajero: ${(data.cashier || "N/D").toUpperCase()}`);
    const client = (data.clientName || "CONSUMIDOR FINAL").toUpperCase();
    out.push(`Cliente: ${client}`);
    if (data.clientDni) out.push(`CC/NIT: ${data.clientDni}`);
    if (data.clientPhone) out.push(`Tel: ${data.clientPhone}`);
    out.push(sep);

    // --- Detalle de productos ---
    // Columnas: V.UNIT (9) + TOTAL (10) alineados a la derecha.
    const priceCols = 9;
    const totalCols = 10;
    const nameCols = W - priceCols - totalCols;

    out.push(pad("CANT/PRODUCTO", nameCols) + padLeft("V.UNIT", priceCols) + padLeft("TOTAL", totalCols));
    out.push(sep);

    for (const l of data.lines) {
        const qty = Number.isInteger(l.quantity) ? String(l.quantity) : l.quantity.toFixed(3);
        const nameLines = wrap(`${qty} x ${l.name.toUpperCase()}`, nameCols - 1);
        // La primera línea lleva los importes; las siguientes solo el nombre.
        out.push(
            pad(nameLines[0], nameCols) +
            padLeft(money(l.unitPrice), priceCols) +
            padLeft(money(l.total), totalCols)
        );
        for (let i = 1; i < nameLines.length; i++) out.push("  " + nameLines[i]);
    }

    out.push(sep);

    // --- Resumen financiero ---
    const labelCols = W - totalCols;
    const row = (label: string, value: string) => pad(label, labelCols) + padLeft(value, totalCols);

    out.push(row("SUBTOTAL", money(data.subtotal)));
    out.push(row("IVA / IMPUESTOS", money(data.taxes || 0)));
    out.push(sep);
    out.push(row("TOTAL A PAGAR", money(data.total)));
    out.push(sep);
    out.push(row("PAGO", (data.paymentMethod || "EFECTIVO").toUpperCase()));
    if (data.received !== undefined) out.push(row("RECIBIDO", money(data.received)));
    if (data.change !== undefined) out.push(row("CAMBIO", money(data.change)));
    if (data.note) {
        out.push(sep);
        for (const l of wrap(data.note, W)) out.push(l);
    }

    // --- Pie ---
    out.push(dotted);
    out.push(center("Gracias por su compra en", W));
    out.push(center("SURTIFAMILIAR!", W));
    out.push(dotted);

    return out.join("\n");
}

/** CSS de impresión para rollo térmico. */
function ticketCSS(width: TicketWidth): string {
    const fontSize = width === "58mm" ? "10px" : "11.5px";
    return `
        @page { size: ${width} auto; margin: 0; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body {
            width: ${width};
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
        @media print {
            html, body { width: ${width}; }
        }
    `;
}

/**
 * printThermalTicket imprime el ticket en un iframe oculto. No abre
 * ventanas nuevas (los bloqueadores de pop-ups las matan) y no toca el
 * DOM visible de la app.
 */
export function printThermalTicket(data: TicketData, width: TicketWidth = "58mm"): void {
    if (typeof window === "undefined") return;

    const text = buildTicketText(data, width);
    const escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

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
        `<title>Ticket ${data.ticketNumber}</title>` +
        `<style>${ticketCSS(width)}</style></head>` +
        `<body><pre>${escaped}</pre></body></html>`
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

const AUTO_PRINT_KEY = "pos_auto_print";

export function getAutoPrint(): boolean {
    if (typeof window === "undefined") return false;
    // Por defecto ACTIVO: el flujo normal del POS es entregar tirilla.
    const raw = window.localStorage.getItem(AUTO_PRINT_KEY);
    return raw === null ? true : raw === "true";
}

export function setAutoPrint(value: boolean): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(AUTO_PRINT_KEY, String(value));
}

// =============================================================
// Envío digital
// =============================================================

/** Enlace de WhatsApp con el ticket como texto. */
export function whatsappTicketURL(data: TicketData, phone?: string): string {
    const text = buildTicketText(data, "58mm");
    const clean = (phone || data.clientPhone || "").replace(/\D/g, "");
    // Colombia: si el número viene sin indicativo se le agrega el 57.
    const withCode = clean.length === 10 ? `57${clean}` : clean;
    const base = withCode ? `https://wa.me/${withCode}` : "https://wa.me/";
    return `${base}?text=${encodeURIComponent(text)}`;
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
    const rawDate = sale?.date || sale?.saleDate;

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
        paymentMethod: paymentMethod || (credit > 0 ? "FIADO" : cash > 0 ? "EFECTIVO" : "TRANSFERENCIA"),
        received: cash > 0 ? cash : undefined,
        change: change > 0 ? change : undefined,
        note: credit > 0
            ? `Queda pendiente de fiado: $${Math.round(credit).toLocaleString("es-CO")}`
            : undefined,
    };
}
