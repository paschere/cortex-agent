import { textWidth, winAnsi, wrapText } from '../../sales/pdf';
import { type Cell, type ColumnKind, type ReportTable, formatCell } from './report';

/**
 * LOS ADJUNTOS DE UN REPORTE: Excel (.xlsx real, con cifras como número para
 * que se puedan sumar) y PDF (escrito a mano con las fuentes estándar, como el
 * de las cotizaciones: sin librería de PDF). Ambos salen de las mismas
 * `ReportTable` que el correo.
 */

function sheetName(raw: string, used: Set<string>): string {
  const base =
    raw
      .replace(/[[\]:*?/\\]/g, ' ')
      .trim()
      .slice(0, 31) || 'Hoja';
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(name.toLowerCase());
  return name;
}

/** Excel no debe interpretar un texto como fórmula. */
function safeText(v: string): string {
  return /^[=+\-@]/.test(v) ? `'${v}` : v;
}

export async function buildReportXlsx(
  title: string,
  tables: ReportTable[],
  now: Date,
): Promise<Uint8Array> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Cortex';
  wb.title = title.slice(0, 120);
  wb.created = now;
  const used = new Set<string>();
  for (const t of tables) {
    const ws = wb.addWorksheet(sheetName(t.title, used), { views: [{ state: 'frozen', ySplit: 1 }] });
    const head = ws.addRow(t.columns.map((c) => c.label));
    head.font = { bold: true };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
    const put = (row: Cell[], bold = false) => {
      const r = ws.addRow(row.map((c) => (typeof c === 'string' ? safeText(c) : c)));
      row.forEach((c, i) => {
        const kind = t.columns[i]?.kind ?? 'text';
        const cell = r.getCell(i + 1);
        if (typeof c === 'number') {
          cell.numFmt = kind === 'money' ? '"$"#,##0' : kind === 'count' ? '#,##0' : '#,##0.00';
        }
      });
      if (bold) r.font = { bold: true };
    };
    for (const r of t.rows) put(r);
    if (t.totals) put(t.totals, true);
    t.columns.forEach((c, i) => {
      const widest = Math.max(
        c.label.length,
        ...t.rows.map((r) => formatCell(r[i] ?? null, c.kind).length),
        t.totals ? formatCell(t.totals[i] ?? null, c.kind).length : 0,
      );
      ws.getColumn(i + 1).width = Math.min(Math.max(widest + 2, 10), 48);
    });
  }
  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

function pdfString(text: string): string {
  return `(${winAnsi(text)
    .map((b) => {
      if (b === 40 || b === 41 || b === 92) return `\\${String.fromCharCode(b)}`;
      if (b < 32 || b > 126) return `\\${b.toString(8).padStart(3, '0')}`;
      return String.fromCharCode(b);
    })
    .join('')})`;
}

type Rgb = [number, number, number];
const INK: Rgb = [0.12, 0.13, 0.16];
const MUTED: Rgb = [0.42, 0.44, 0.5];
const BRAND: Rgb = [0.263, 0.22, 0.792];

class Page {
  ops: string[] = [];
  text(x: number, y: number, s: string, size: number, o: { bold?: boolean; color?: Rgb; right?: boolean } = {}) {
    const w = textWidth(s, size, o.bold);
    const [r, g, b] = o.color ?? INK;
    this.ops.push(
      `BT ${fmt(r)} ${fmt(g)} ${fmt(b)} rg /${o.bold ? 'F2' : 'F1'} ${size} Tf ${fmt(o.right ? x - w : x)} ${fmt(y)} Td ${pdfString(s)} Tj ET`,
    );
  }
  rect(x: number, y: number, w: number, h: number, c: Rgb) {
    this.ops.push(`${fmt(c[0])} ${fmt(c[1])} ${fmt(c[2])} rg ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re f`);
  }
  line(x1: number, y: number, x2: number, c: Rgb = [0.85, 0.86, 0.89]) {
    this.ops.push(`${fmt(c[0])} ${fmt(c[1])} ${fmt(c[2])} RG 0.6 w ${fmt(x1)} ${fmt(y)} m ${fmt(x2)} ${fmt(y)} l S`);
  }
}

export interface ReportPdfInput {
  title: string;
  subtitle?: string | null;
  tables: ReportTable[];
  appName: string;
  notes?: string[];
  generatedLabel: string;
}

export function renderReportPdf(input: ReportPdfInput): Uint8Array {
  const wide = input.tables.some((t) => t.columns.length > 5);
  const W = wide ? 792 : 612;
  const H = wide ? 612 : 792;
  const M = 40;
  const usable = W - M * 2;
  const pages: Page[] = [];
  let page = new Page();
  pages.push(page);
  let y = H - M;

  const newPage = () => {
    page = new Page();
    pages.push(page);
    y = H - M;
  };
  page.rect(0, H - 6, W, 6, BRAND);
  y -= 8;
  page.text(M, y, `Reporte automático · ${input.appName}`.slice(0, 90), 8.5, { color: MUTED });
  y -= 22;
  for (const l of wrapText(input.title, usable, 17, true)) {
    page.text(M, y, l, 17, { bold: true });
    y -= 21;
  }
  if (input.subtitle) {
    page.text(M, y, input.subtitle, 10.5, { color: MUTED });
    y -= 18;
  }
  y -= 6;

  const size = 9;
  const lineH = 12;
  for (const t of input.tables) {
    if (y < M + 80) newPage();
    if (input.tables.length > 1) {
      page.text(M, y, t.title, 11.5, { bold: true });
      y -= 16;
    }
    // Anchos de columna: proporcionales a lo más ancho de cada una (con tope).
    const want = t.columns.map((c, i) =>
      Math.min(
        260,
        Math.max(
          textWidth(c.label, size, true),
          ...t.rows.slice(0, 80).map((r) => textWidth(formatCell(r[i] ?? null, c.kind), size)),
          t.totals ? textWidth(formatCell(t.totals[i] ?? null, c.kind), size, true) : 0,
        ) + 14,
      ),
    );
    const sum = want.reduce((a, b) => a + b, 0);
    const widths = sum > usable ? want.map((w) => (w * usable) / sum) : want;
    const xs: number[] = [];
    widths.reduce((acc, w) => {
      xs.push(acc);
      return acc + w;
    }, M);
    const cellX = (i: number) =>
      t.columns[i]?.kind === 'text' ? (xs[i] as number) + 4 : (xs[i] as number) + (widths[i] as number) - 4;
    const drawHeader = () => {
      page.rect(M, y - 4, usable, lineH + 6, [0.93, 0.94, 0.99]);
      t.columns.forEach((c, i) => {
        const lines = wrapText(c.label, (widths[i] as number) - 8, size, true);
        page.text(cellX(i), y, (lines[0] ?? '').slice(0, 60), size, { bold: true, right: c.kind !== 'text' });
      });
      y -= lineH + 8;
    };
    drawHeader();
    const drawRow = (cells: Cell[], bold = false, shade = false) => {
      const wrapped = cells.map((c, i) => {
        const kind: ColumnKind = t.columns[i]?.kind ?? 'text';
        const s = formatCell(c, kind);
        return kind === 'text' ? wrapText(s, (widths[i] as number) - 8, size, bold).slice(0, 4) : [s];
      });
      const h = Math.max(...wrapped.map((w) => w.length)) * lineH + 4;
      if (y - h < M + 24) {
        newPage();
        drawHeader();
      }
      if (shade) page.rect(M, y - h + lineH - 1, usable, h, [0.975, 0.978, 0.985]);
      wrapped.forEach((lines, i) => {
        lines.forEach((l, k) =>
          page.text(cellX(i), y - k * lineH, l, size, { bold, right: t.columns[i]?.kind !== 'text' }),
        );
      });
      y -= h;
      page.line(M, y + lineH - 2, M + usable);
    };
    t.rows.forEach((r, i) => drawRow(r, false, i % 2 === 1));
    if (t.totals) drawRow(t.totals, true);
    y -= 16;
  }
  for (const n of input.notes ?? []) {
    for (const l of wrapText(n, usable, 8.5)) {
      if (y < M + 24) newPage();
      page.text(M, y, l, 8.5, { color: [0.57, 0.25, 0.05] });
      y -= 11;
    }
  }
  pages.forEach((p, i) => {
    p.text(M, 22, `${input.appName} · ${input.generatedLabel}`.slice(0, 120), 7.5, { color: MUTED });
    p.text(W - M, 22, `Página ${i + 1} de ${pages.length}`, 7.5, { color: MUTED, right: true });
  });
  return assemble(
    pages.map((p) => p.ops),
    W,
    H,
    input.title,
  );
}

function assemble(pages: string[][], W: number, H: number, title: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (b: Uint8Array) => {
    chunks.push(b);
    length += b.length;
  };
  const raw = (s: string) => Uint8Array.from([...s].map((ch) => ch.charCodeAt(0) & 255));
  const object = (id: number, body: string, stream?: Uint8Array) => {
    offsets[id] = length;
    if (stream) {
      push(raw(`${id} 0 obj\n<< ${body} /Length ${stream.length} >>\nstream\n`));
      push(stream);
      push(raw('\nendstream\nendobj\n'));
    } else push(raw(`${id} 0 obj\n${body}\nendobj\n`));
  };
  push(raw('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'));
  const first = 6;
  const ids = pages.map((_, i) => first + i * 2);
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${ids.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  object(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  object(5, `<< /Producer (Cortex) /Title ${pdfString(title.slice(0, 120))} >>`);
  pages.forEach((ops, i) => {
    const id = ids[i] as number;
    object(
      id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${id + 1} 0 R >>`,
    );
    object(id + 1, '', raw(ops.join('\n')));
  });
  const count = first + pages.length * 2;
  const xrefAt = length;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) xref += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`;
  push(raw(`${xref}trailer\n<< /Size ${count} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`));
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** «reporte-costo-de-equipos-2026-10-19.xlsx». */
export function reportFilename(title: string, day: string, ext: 'xlsx' | 'pdf'): string {
  const slug =
    title
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'reporte';
  return `${slug}-${day}.${ext}`;
}
