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
}

export const generatePDFReport = ({
  title,
  subtitle,
  filename,
  columns,
  data,
  summary
}: ReportOptions) => {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4'
  });

  const pageWidth = doc.internal.pageSize.width;

  // --- Header ---
  doc.setFillColor(16, 185, 129); // Emerald 500
  doc.rect(0, 0, pageWidth, 40, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.text(title.toUpperCase(), 15, 25);

  if (subtitle) {
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(subtitle.toUpperCase(), 15, 32);
  }

  const today = new Date().toLocaleString();
  doc.setFontSize(8);
  doc.text(`GENERADO: ${today}`, pageWidth - 15, 15, { align: 'right' });

  // --- Summary Box (Optional) ---
  let startY = 50;
  if (summary && summary.length > 0) {
    doc.setFillColor(243, 244, 246);
    doc.rect(15, startY, pageWidth - 30, 20, 'F');
    
    let xOffset = 25;
    summary.forEach((item) => {
      doc.setTextColor(107, 114, 128);
      doc.setFontSize(7);
      doc.setFont('helvetica', 'bold');
      doc.text(item.label.toUpperCase(), xOffset, startY + 7);
      
      doc.setTextColor(17, 24, 39);
      doc.setFontSize(10);
      doc.text(
        typeof item.value === 'number' ? `$${formatCurrency(item.value)}` : item.value.toString(),
        xOffset,
        startY + 15
      );
      xOffset += (pageWidth - 60) / summary.length;
    });
    startY += 30;
  }

  // --- Table ---
  doc.autoTable({
    startY: startY,
    head: [columns.map(c => c.header.toUpperCase())],
    body: data.map(item => columns.map(c => item[c.dataKey])),
    styles: {
      fontSize: 8,
      cellPadding: 3,
      font: 'helvetica'
    },
    headStyles: {
      fillColor: [31, 41, 55], // Gray 800
      textColor: 255,
      fontStyle: 'bold'
    },
    alternateRowStyles: {
      fillColor: [249, 250, 251]
    },
    margin: { left: 15, right: 15 },
    didDrawPage: (data: any) => {
        // Footer on each page
        const str = `Página ${doc.getNumberOfPages()}`;
        doc.setFontSize(7);
        doc.setTextColor(156, 163, 175);
        doc.text(str, pageWidth - 15, doc.internal.pageSize.height - 10, { align: 'right' });
        doc.text("SISTEMA POS - AUDITORÍA MAESTRA", 15, doc.internal.pageSize.height - 10);
    }
  });

  doc.save(`${filename}.pdf`);
};
