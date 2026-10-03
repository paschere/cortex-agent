import {
  A4,
  PdfDocument,
  type Rgb,
  fitText,
  hexToRgb,
  pdfImageFrom,
  tint,
  wrapText,
} from '../inventory/pdf';
import { CLOSE_STATUS_LABEL, type CloseStatus, TASK_STATUS_LABEL, type TaskStatus } from './shape';

/**
 * EL INFORME DEL CIERRE DEL MES, EN PDF (migración 0192).
 *
 * Las mismas piezas que el informe para socios y la orden de compra
 * (inventory/pdf.ts: Helvetica estándar, WinAnsi, el logo de la empresa), sin
 * dependencias. Puro: recibe el cierre ya armado y la marca, devuelve bytes.
 * Un mes cerrado se pinta con la foto que se guardó al cerrarlo; uno abierto,
 * con la revisión de este momento (y lo dice).
 */

export interface ClosePdfBrand {
  name: string;
  primary: string | null;
  logo: Uint8Array | null;
}

export interface ClosePdfInput {
  label: string;
  status: CloseStatus;
  closedAt: string | null;
  closedByName: string | null;
  note: string | null;
  progress: { done: number; total: number };
  tasks: Array<{
    title: string;
    status: TaskStatus;
    ready: boolean;
    detail: string;
    evidence: string | null;
    doneByName: string | null;
  }>;
  /** Lo registrado en el programa contable en el mes, por clase. */
  writebacks: Array<{ label: string; count: number; amount: number }>;
  providerName: string | null;
  generatedAt: string;
}

const INK: Rgb = [28, 30, 38];
const MUTED: Rgb = [102, 106, 120];
const OK: Rgb = [4, 120, 87];
const WARN: Rgb = [180, 83, 9];
const M = 48;
const W = A4.width - M * 2;
const BOTTOM = A4.height - 60;

function money(n: number): string {
  return `$ ${Math.round(n).toLocaleString('es-CO')}`;
}

export function renderClosePdf(input: ClosePdfInput, brand: ClosePdfBrand): Uint8Array {
  const doc = new PdfDocument();
  const color = hexToRgb(brand.primary);
  const image = pdfImageFrom(brand.logo);
  doc.setImage(image);
  let y = 0;

  const header = (first: boolean) => {
    doc.rect(0, 0, A4.width, 6, color);
    if (!first) {
      doc.text(M, 30, fitText(`${brand.name} · Cierre de ${input.label}`, 9, W, true), {
        size: 9,
        bold: true,
        color: MUTED,
      });
      y = 52;
      return;
    }
    let nameX = M;
    if (image) {
      const h = 42;
      const w = Math.min((image.width / image.height) * h, 150);
      const hh = (w / image.width) * image.height;
      doc.drawImage(M, 30, w, hh);
      nameX = M + w + 12;
    }
    doc.text(nameX, image ? 50 : 52, fitText(brand.name, 15, 250, true), {
      size: 15,
      bold: true,
      color: image ? INK : color,
    });
    doc.text(A4.width - M, 44, 'CIERRE DEL MES', {
      size: 9,
      bold: true,
      color: MUTED,
      align: 'right',
    });
    doc.text(A4.width - M, 64, input.label, { size: 18, bold: true, color: INK, align: 'right' });
    doc.line(M, 96, A4.width - M, 96);
    y = 120;
  };

  const footer = () => {
    doc.line(M, A4.height - 44, A4.width - M, A4.height - 44);
    doc.text(
      M,
      A4.height - 30,
      fitText(
        `Generado por Cortex el ${input.generatedAt.slice(0, 10)}. La revisión automática se hace sobre los datos de Cortex (extractos, libro de plata, cuentas por pagar, cartera); no reemplaza la revisión del contador.`,
        7.5,
        W - 60,
      ),
      { size: 7.5, color: MUTED },
    );
    doc.text(A4.width - M, A4.height - 30, `Página ${doc.page}`, {
      size: 7.5,
      color: MUTED,
      align: 'right',
    });
  };

  const ensure = (h: number) => {
    if (y + h <= BOTTOM) return;
    footer();
    doc.addPage();
    header(false);
  };

  const paragraph = (
    text: string,
    opts: { size?: number; color?: Rgb; bold?: boolean; indent?: number } = {},
  ) => {
    const size = opts.size ?? 10;
    const indent = opts.indent ?? 0;
    for (const line of wrapText(text, size, W - indent, opts.bold)) {
      ensure(size + 5);
      doc.text(M + indent, y, line, { size, color: opts.color ?? INK, bold: opts.bold });
      y += size + 4;
    }
  };

  header(true);

  // Estado y avance.
  const statusText =
    input.status === 'cerrado'
      ? `Cerrado${input.closedAt ? ` el ${input.closedAt.slice(0, 10)}` : ''}${input.closedByName ? ` por ${input.closedByName}` : ''}`
      : `${CLOSE_STATUS_LABEL[input.status]} — revisión de este momento, el mes no está cerrado`;
  doc.rect(M, y - 14, W, 46, tint(color, 0.92));
  doc.text(M + 12, y + 4, statusText, { size: 11, bold: true, color: INK });
  doc.text(M + 12, y + 22, `${input.progress.done} de ${input.progress.total} tareas listas`, {
    size: 9.5,
    color: MUTED,
  });
  const barW = 160;
  const barX = A4.width - M - barW - 12;
  doc.rect(barX, y + 2, barW, 8, tint(color, 0.75));
  const share = input.progress.total ? input.progress.done / input.progress.total : 0;
  if (share > 0) doc.rect(barX, y + 2, barW * share, 8, color);
  y += 52;
  if (input.note) paragraph(`Nota del cierre: ${input.note}`, { size: 9.5, color: MUTED });
  y += 6;

  // La lista.
  ensure(30);
  doc.text(M, y, 'La lista del cierre', { size: 12, bold: true, color: INK });
  y += 18;
  for (const t of input.tasks) {
    ensure(34);
    const mark = t.ready ? 'Listo' : 'Falta';
    doc.text(M, y, mark, { size: 8.5, bold: true, color: t.ready ? OK : WARN });
    doc.text(M + 40, y, fitText(t.title, 10, W - 140, true), { size: 10, bold: true, color: INK });
    doc.text(A4.width - M, y, TASK_STATUS_LABEL[t.status], {
      size: 8.5,
      color: MUTED,
      align: 'right',
    });
    y += 13;
    paragraph(t.detail, { size: 8.5, color: MUTED, indent: 40 });
    if (t.evidence)
      paragraph(`Evidencia${t.doneByName ? ` (${t.doneByName})` : ''}: ${t.evidence}`, {
        size: 8.5,
        color: INK,
        indent: 40,
      });
    y += 4;
    doc.line(M + 40, y - 4, A4.width - M, y - 4, [235, 236, 240]);
    y += 4;
  }

  // Lo registrado en el programa.
  y += 8;
  ensure(40);
  doc.text(M, y, `Registrado en ${input.providerName ?? 'el programa contable'} desde Cortex`, {
    size: 12,
    bold: true,
    color: INK,
  });
  y += 18;
  if (!input.writebacks.some((w) => w.count > 0)) {
    paragraph(
      input.providerName
        ? 'Nada este mes.'
        : 'Sin programa contable conectado: lo del mes se registró a mano donde se lleva la contabilidad.',
      { size: 9.5, color: MUTED },
    );
  } else {
    for (const w of input.writebacks) {
      ensure(16);
      doc.text(M, y, w.label, { size: 10, color: INK });
      doc.text(A4.width - M - 120, y, `${w.count}`, { size: 10, color: INK, align: 'right' });
      doc.text(A4.width - M, y, money(w.amount), { size: 10, color: INK, align: 'right' });
      y += 15;
    }
  }

  footer();
  return doc.toBytes({ title: `Cierre de ${input.label}`, author: brand.name });
}
