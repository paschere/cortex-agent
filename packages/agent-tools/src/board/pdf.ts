import {
  A4,
  PdfDocument,
  type Rgb,
  fitText,
  hexToRgb,
  pdfImageFrom,
  textWidth,
  tint,
  wrapText,
} from '../inventory/pdf';
import type { BoardContent, BoardTable } from './shape';

/**
 * EL PDF DEL INFORME PARA SOCIOS, CON LA MARCA DE LA EMPRESA (0191).
 *
 * Mismas piezas que la orden de compra (inventory/pdf.ts: Helvetica estándar,
 * WinAnsi, el logo JPEG/PNG de company_branding), sin dependencias. Puro:
 * recibe el contenido ya guardado y la marca, devuelve bytes. Las cifras son
 * las del informe guardado: el PDF no recalcula nada.
 */

export interface BoardPdfBrand {
  name: string;
  primary: string | null;
  logo: Uint8Array | null;
}

const INK: Rgb = [28, 30, 38];
const MUTED: Rgb = [102, 106, 120];
const M = 48;
const W = A4.width - M * 2;
const BOTTOM = A4.height - 60;

export function renderBoardPdf(c: BoardContent, brand: BoardPdfBrand): Uint8Array {
  const doc = new PdfDocument();
  const color = hexToRgb(brand.primary);
  const image = pdfImageFrom(brand.logo);
  doc.setImage(image);
  let y = 0;

  const header = (first: boolean) => {
    doc.rect(0, 0, A4.width, 6, color);
    if (!first) {
      doc.text(
        M,
        30,
        fitText(`${brand.name} · Informe para socios · ${c.periodLabel}`, 9, W, true),
        {
          size: 9,
          bold: true,
          color: MUTED,
        },
      );
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
    doc.text(A4.width - M, 44, 'INFORME PARA SOCIOS', {
      size: 9,
      bold: true,
      color: MUTED,
      align: 'right',
    });
    const label = c.periodLabel.charAt(0).toUpperCase() + c.periodLabel.slice(1);
    doc.text(A4.width - M, 64, label, { size: 18, bold: true, color: INK, align: 'right' });
    doc.line(M, 96, A4.width - M, 96);
    y = 120;
  };

  const footer = () => {
    doc.line(M, A4.height - 44, A4.width - M, A4.height - 44);
    doc.text(
      M,
      A4.height - 30,
      fitText(
        'Cifras de caja del libro de Cortex (lo que entró y salió), sin causación ni depreciaciones, salvo donde se indica el programa contable.',
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
    opts: { size?: number; bullet?: boolean; color?: Rgb; bold?: boolean } = {},
  ) => {
    const size = opts.size ?? 10;
    const indent = opts.bullet ? 12 : 0;
    const lines = wrapText(text, size, W - indent, opts.bold);
    for (const [i, line] of lines.entries()) {
      ensure(size + 5);
      if (opts.bullet && i === 0) doc.rect(M + 2, y - size * 0.45, 3, 3, color);
      doc.text(M + indent, y, line, { size, color: opts.color ?? INK, bold: opts.bold });
      y += size + 4;
    }
  };

  const drawTable = (t: BoardTable) => {
    const n = t.columns.length;
    // La primera columna es el nombre; el resto se reparte.
    const first = n <= 3 ? W * 0.34 : W * 0.3;
    const rest = (W - first) / Math.max(n - 1, 1);
    const widths = [first, ...Array(Math.max(n - 1, 0)).fill(rest)] as number[];
    const xs = widths.map((_, i) => M + widths.slice(0, i).reduce((s, w) => s + w, 0));
    const numeric = new Set(t.numeric ?? []);
    const rowH = 16;
    const drawHead = () => {
      ensure(rowH + 4);
      doc.rect(M, y - 11, W, rowH, tint(color, 0.88));
      t.columns.forEach((col, i) => {
        const cw = (widths[i] ?? rest) - 8;
        const text = fitText(col, 8, cw, true);
        if (numeric.has(i))
          doc.text((xs[i] ?? M) + (widths[i] ?? rest) - 4, y, text, {
            size: 8,
            bold: true,
            color: MUTED,
            align: 'right',
          });
        else doc.text((xs[i] ?? M) + 4, y, text, { size: 8, bold: true, color: MUTED });
      });
      y += rowH;
    };
    drawHead();
    for (const row of t.rows) {
      // Una celda de texto largo (la fórmula) se parte en renglones.
      const wrapped = row.map((cell, i) =>
        numeric.has(i)
          ? [fitText(cell, 8.5, (widths[i] ?? rest) - 8)]
          : wrapText(cell, 8.5, (widths[i] ?? rest) - 8).slice(0, 4),
      );
      const lines = Math.max(...wrapped.map((w) => w.length), 1);
      const h = lines * 11 + 5;
      if (y + h > BOTTOM) {
        footer();
        doc.addPage();
        header(false);
        drawHead();
      }
      wrapped.forEach((cellLines, i) => {
        cellLines.forEach((line, k) => {
          if (numeric.has(i))
            doc.text((xs[i] ?? M) + (widths[i] ?? rest) - 4, y + k * 11, line, {
              size: 8.5,
              color: INK,
              align: 'right',
            });
          else
            doc.text((xs[i] ?? M) + 4, y + k * 11, line, {
              size: 8.5,
              color: i === 0 ? INK : MUTED,
            });
        });
      });
      y += h;
      doc.line(M, y - 9, A4.width - M, y - 9, [232, 234, 240], 0.4);
    }
    y += 6;
  };

  header(true);
  for (const s of c.sections) {
    ensure(40);
    doc.text(M, y, s.title, { size: 12.5, bold: true, color });
    y += 8;
    doc.line(M, y, M + Math.min(textWidth(s.title, 12.5, true), W), y, color, 1);
    y += 16;
    const lines = s.key === 'resumen' ? c.summary : s.lines;
    for (const line of lines)
      paragraph(line, { bullet: true, size: s.key === 'resumen' ? 10.5 : 9.5 });
    if (s.table) {
      y += 4;
      drawTable(s.table);
    }
    y += 12;
  }
  if (c.gaps.length)
    paragraph(`No se pudo leer: ${c.gaps.join(', ')}.`, { size: 8.5, color: MUTED });
  footer();
  return doc.toBytes({ title: `Informe para socios — ${c.periodLabel}`, author: brand.name });
}
