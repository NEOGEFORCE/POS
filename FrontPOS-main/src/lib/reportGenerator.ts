import jsPDF from 'jspdf';
import 'jspdf-autotable';
import { formatCurrency } from './utils';

// Extending jsPDF with autotable types for TypeScript
declare module 'jspdf' {
  interface jsPDF {
    autoTable: (options: any) => jsPDF;
  }
}

interface ReportOptions {
  title: string;
  subtitle?: string;
  filename: string;
  columns: { header: string; dataKey: string }[];
  data: any[];
  summary?: { label: string; value: string | number }[];
  sendToTelegram?: boolean;
}

// --- Enterprise Monochromatic Theme Constants ---
const GET_PDF_ENTERPRISE_THEME = () => ({
  colors: {
    black: [0, 0, 0] as [number, number, number],
    white: [255, 255, 255] as [number, number, number],
    grayLight: [229, 231, 235] as [number, number, number], // Gray 200
    grayDark: [31, 41, 55] as [number, number, number],   // Gray 800
  },
  lineWeight: {
    grid: 0.1,
    separator: 0.5,
    border: 0.8
  }
});

export const generatePDFReport = async ({
  title,
  subtitle,
  filename,
  columns,
  data,
  summary,
  sendToTelegram
}: ReportOptions) => {
  const theme = GET_PDF_ENTERPRISE_THEME();
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4'
  });

  const pageWidth = doc.internal.pageSize.width;

  // --- Header (Enterprise Style: No Colors, Only Lines) ---
  doc.setDrawColor(...theme.colors.black);
  doc.setLineWidth(theme.lineWeight.border);
  
  // Titulo Principal
  doc.setTextColor(...theme.colors.black);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.text(title.toUpperCase(), 15, 20);

  // Subtitulo
  if (subtitle) {
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(subtitle.toUpperCase(), 15, 27);
  }

  // Metadatos de impresion
  const today = new Date().toLocaleString();
  doc.setFontSize(8);
  doc.text(`AUDITORIA OFICIAL: ${today}`, pageWidth - 15, 15, { align: 'right' });
  doc.text(`ID REPORTE: ${Math.random().toString(36).substring(7).toUpperCase()}`, pageWidth - 15, 20, { align: 'right' });

  // Linea divisoria gruesa (Fase 1)
  doc.setLineWidth(theme.lineWeight.separator);
  doc.line(15, 32, pageWidth - 15, 32);

  // --- Bloque de Resumen (Visual Audit Grid) ---
  let currentY = 35;
  if (summary && summary.length > 0) {
    const boxWidth = (pageWidth - 30) / summary.length;
    const boxHeight = 18;
    
    summary.forEach((item, index) => {
      const xPos = 15 + (index * boxWidth);
      
      // Rectangulo con borde negro
      doc.setDrawColor(...theme.colors.black);
      doc.setLineWidth(theme.lineWeight.grid);
      doc.rect(xPos, currentY, boxWidth, boxHeight);
      
      // Etiqueta
      doc.setTextColor(...theme.colors.grayDark);
      doc.setFontSize(7);
      doc.setFont('helvetica', 'bold');
      doc.text(item.label.toUpperCase(), xPos + 4, currentY + 6);
      
      // Valor
      doc.setTextColor(...theme.colors.black);
      doc.setFontSize(10);
      doc.text(
        typeof item.value === 'number' ? `$${formatCurrency(item.value)}` : item.value.toString(),
        xPos + 4,
        currentY + 13
      );
    });
    currentY += boxHeight + 8;
  } else {
    currentY += 5;
  }

  // --- Table (Enterprise Grid Theme) ---
  // Sanitizar datos para evitar saltos de linea extranos (Fase 3)
  const sanitizedBody = data.map(item => 
    columns.map(c => {
      const val = item[c.dataKey];
      if (typeof val === 'string') {
        return val.replace(/[\n\r]+/g, ' ').trim();
      }
      return val;
    })
  );

  doc.autoTable({
    startY: currentY,
    theme: 'grid',
    head: [columns.map(c => c.header.toUpperCase())],
    body: sanitizedBody,
    styles: {
      fontSize: 8,
      cellPadding: 3,
      font: 'helvetica',
      lineColor: theme.colors.black,
      lineWidth: theme.lineWeight.grid,
      textColor: theme.colors.black
    },
    headStyles: {
      fillColor: theme.colors.grayLight,
      textColor: theme.colors.black,
      fontStyle: 'bold',
      halign: 'center',
      lineColor: theme.colors.black,
      lineWidth: theme.lineWeight.grid
    },
    columnStyles: columns.reduce((acc: any, col, index) => {
      const header = col.header.toUpperCase();
      if (header.includes('MONTO') || header.includes('TOTAL') || header.includes('VALOR') || 
          header.includes('RECAUDADO') || header.includes('SUBTOTAL') || header.includes('PRECIO') || 
          header.includes('COSTO') || header.includes('CANT') || header.includes('STOCK')) {
        acc[index] = { halign: 'right' };
      }
      return acc;
    }, {}),
    margin: { left: 15, right: 15 },
    didDrawPage: (data: any) => {
        const str = `Pagina ${doc.getNumberOfPages()}`;
        doc.setFontSize(7);
        doc.setTextColor(...theme.colors.grayDark);
        doc.text(str, pageWidth - 15, doc.internal.pageSize.height - 10, { align: 'right' });
        doc.text("SUPERMERCADO SURTIFAMILIAR - DOCUMENTO DE AUDITORIA OFICIAL", 15, doc.internal.pageSize.height - 10);
    }
  });

  // --- Bloque de Firmas (Fase 3) ---
  // @ts-ignore
  const finalY = (doc.lastAutoTable?.finalY || currentY + 50) + 25;
  const signatureWidth = 60;
  
  // Firma 1
  doc.setLineWidth(theme.lineWeight.separator);
  doc.line(20, finalY, 20 + signatureWidth, finalY);
  doc.setFontSize(8);
  doc.text("FIRMA RESPONSABLE (CAJERO)", 20 + (signatureWidth / 2), finalY + 5, { align: 'center' });

  // Firma 2
  doc.line(pageWidth - 20 - signatureWidth, finalY, pageWidth - 20, finalY);
  doc.text("AUDITOR / GERENCIA", pageWidth - 20 - (signatureWidth / 2), finalY + 5, { align: 'center' });

  const pdfBlob = doc.output('blob');

  if (sendToTelegram) {
    try {
      let caption = `ðŸ“Š ${title}\n${subtitle || ''}`;

      // Logica de Plantillas Premium para Telegram
      if (title.toUpperCase().includes('ARQUEO GENERAL DE BOVEDA')) {
        const dataMap = data.reduce((acc: any, curr: any) => {
          acc[curr.label] = curr.amount;
          return acc;
        }, {});

        caption = `ðŸ¦ ARQUEO GENERAL DE BOVEDA
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
ðŸ“… FECHA: ${new Date().toLocaleString('es-CO')}

ðŸ–¥ï¸ 1. CAJAS EN PISO (Registradoras)
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
â–«ï¸ Esperado (Sistema):  ${dataMap['Cajas en Piso (Teorico)'] || '$0'}
â–«ï¸ Reportado (Cajero):  ${dataMap['Cajas en Piso (Fisico)'] || '$0'}
ðŸ‘‰ DESCUADRE CAJAS:     ${dataMap['Descuadre Cajas'] || '$0'}

ðŸ—„ï¸ 2. FONDO / BOVEDA
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
â–«ï¸ Saldo Intacto:       ${dataMap['Fondo Boveda/Caja Fuerte'] || '$0'}

ðŸ’Ž 3. EFECTIVO TOTAL FISICO (LOCAL)
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ðŸ’° TOTAL A CONTAR:      ${dataMap['TOTAL EFECTIVO EN LOCAL'] || '$0'}
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•`;
      } else if (title.toUpperCase().includes('INVENTARIO')) {
        caption = `ðŸ“¦ REPORTE DE INVENTARIO
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
ðŸ“… FECHA: ${new Date().toLocaleDateString('es-CO')}
ðŸ“Š ESTADO: Auditoria Valorizada
${summary ? summary.map(s => `â–«ï¸ ${s.label}: ${s.value}`).join('\n') : ''}
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•`;
      } else if (title.toUpperCase().includes('RESULTADOS') || title.toUpperCase().includes('PNL')) {
        caption = `ðŸ“ˆ ESTADO DE RESULTADOS (PyG)
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
ðŸ“… PERIODO: ${subtitle || 'Actual'}
ðŸ’° UTILIDAD NETA: ${data.find((d: any) => d.label.includes('NETA'))?.amount || 'N/A'}
ðŸ“Š MARGEN: ${summary?.[0]?.value || 'N/A'}
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•`;
      }

      const formData = new FormData();
      formData.append('document', pdfBlob, `${filename}.pdf`);
      formData.append('caption', caption);

      const token = typeof window !== 'undefined' ? (await import('js-cookie')).default.get('org-pos-token') : '';

      const response = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/notifications/telegram`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Error ${response.status}`);
      }
      
      // Notificar exito
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('telegram-success', { 
          detail: { message: 'Reporte enviado a Telegram exitosamente' }
        }));
      }

      // REGISTRAR EN EL HISTORIAL (DATABASE)
      await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/reports/history`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: title,
          type: 'PDF',
          category: subtitle || 'General',
          url: filename
        })
      }).catch(err => console.error("Error registrando historial:", err));
    } catch (error: any) {
      console.error('âŒ Error enviando PDF a Telegram:', error);
      
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('telegram-error', { 
          detail: { message: error.message || 'Error al enviar a Telegram', originalError: error.message }
        }));
      }
    }
  } else {
    // Si no se envia a Telegram, igual registramos en el historial
    const token = typeof window !== 'undefined' ? (await import('js-cookie')).default.get('org-pos-token') : '';
    await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/reports/history`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: title,
          type: 'PDF',
          category: subtitle || 'General',
          url: filename
        })
      }).catch(err => console.error("Error registrando historial:", err));
  }

  // Limpiar el nombre del archivo de caracteres invalidos
  const safeFilename = filename.replace(/[/\\?%*:|"<>]/g, '-').replace(/\.pdf$/i, '');
  
  // Siempre descargar el PDF localmente con extension limpia
  doc.save(`${safeFilename}.pdf`);
  return pdfBlob;
};


