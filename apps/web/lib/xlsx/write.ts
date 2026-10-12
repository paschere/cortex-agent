import { utf8, zipStore } from './zip';

/**
 * ESCRIBIR UN .xlsx REAL (no un CSV con otro nombre).
 *
 * Una hoja con: encabezado en negrita y fondo suave, primera fila congelada,
 * filtro en el encabezado, anchos de columna, y celdas con su TIPO:
 *   - texto   → texto en la celda (nunca una fórmula, aunque empiece por «=»);
 *   - número  → número;
 *   - dinero  → número con formato de pesos (`"$"#,##0`; otras monedas con 2
 *               decimales), para que se pueda sumar y se vea como plata;
 *   - fecha / fecha y hora → fecha de Excel (número serial) con formato;
 *   - sí/no   → booleano.
 * Puro y sin dependencias: se usa en el navegador (grilla y panel del chat) y en
 * las pruebas.
 */

export type XlsxType = 'text' | 'number' | 'percent' | 'money' | 'date' | 'datetime' | 'boolean';

export interface XlsxColumn {
  header: string;
  type: XlsxType;
  /** Moneda de una columna `money` (COP por defecto). */
  currency?: string;
  /** Ancho en caracteres; si falta se calcula del contenido. */
  width?: number;
}

export interface XlsxSheet {
  name: string;
  columns: XlsxColumn[];
  /** Una fila por arreglo, en el orden de las columnas. `null`/`''` = celda vacía. */
  rows: unknown[][];
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Letras de columna: 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Quita lo que XML 1.0 no admite y escapa lo que lo rompería. */
export function xmlText(raw: string): string {
  return (
    raw
      // biome-ignore lint/suspicious/noControlCharactersInRegex: justo lo que XML 1.0 no admite.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  );
}

/** Nombre de hoja válido: sin `[]:*?/\`, máximo 31, nunca vacío. */
export function sheetName(raw: string): string {
  const clean = raw
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '')
    .slice(0, 31)
    .trim();
  return clean || 'Datos';
}

const EPOCH = Date.UTC(1899, 11, 30);

/** Serial de Excel de un día `YYYY-MM-DD` (o del día de un ISO). */
export function excelDate(value: unknown): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? '').trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round((t - EPOCH) / 86_400_000);
}

/** Serial de Excel con hora, de `YYYY-MM-DD[T ]HH:mm[:ss]`, leído tal cual (hora local, sin zona). */
export function excelDateTime(value: unknown): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(
    String(value ?? '').trim(),
  );
  if (!m) return null;
  const day = Math.round(
    (Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - EPOCH) / 86_400_000,
  );
  const secs = Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0);
  return day + secs / 86_400;
}

function moneyFormat(currency: string): string {
  const c = currency.toUpperCase();
  // Pesos completos, sin decimales: así se lee la plata en Colombia.
  if (c === 'COP') return '"$"#,##0';
  if (c === 'USD') return '"US$"#,##0.00';
  return `"${c.replace(/"/g, '')} "#,##0.00`;
}

interface StyleBook {
  /** Código de formato por índice de `numFmt` (id = 164 + posición). */
  formats: string[];
  /** Una entrada por estilo de celda de datos: la clave es el formato. */
  xfs: Array<{ key: string; fmtId: number }>;
}

function styleFor(book: StyleBook, key: string, code: string | null, builtin = 0): number {
  const found = book.xfs.findIndex((x) => x.key === key);
  if (found >= 0) return found + 2; // 0 = general, 1 = encabezado
  let fmtId = builtin;
  if (code) {
    let at = book.formats.indexOf(code);
    if (at < 0) {
      book.formats.push(code);
      at = book.formats.length - 1;
    }
    fmtId = 164 + at;
  }
  book.xfs.push({ key, fmtId });
  return book.xfs.length - 1 + 2;
}

function stylesXml(book: StyleBook): string {
  const numFmts = book.formats.length
    ? `<numFmts count="${book.formats.length}">${book.formats
        .map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${xmlText(f)}"/>`)
        .join('')}</numFmts>`
    : '';
  const xfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>',
    ...book.xfs.map(
      (x) =>
        `<xf numFmtId="${x.fmtId}" fontId="0" fillId="0" borderId="0" xfId="0"${x.fmtId ? ' applyNumberFormat="1"' : ''}/>`,
    ),
  ];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts}<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF1F0EC"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF9C9A92"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return Number(value);
  return null;
}

function isBlank(value: unknown): boolean {
  return (
    value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
  );
}

/** El .xlsx de una hoja, como bytes. */
export function buildXlsx(sheet: XlsxSheet): Uint8Array {
  const book: StyleBook = { formats: [], xfs: [] };
  const colStyles = sheet.columns.map((c) => {
    switch (c.type) {
      case 'money':
        return styleFor(book, `money:${c.currency ?? 'COP'}`, moneyFormat(c.currency ?? 'COP'));
      case 'percent':
        return styleFor(book, 'percent', '0.0"%"');
      case 'date':
        return styleFor(book, 'date', 'yyyy-mm-dd');
      case 'datetime':
        return styleFor(book, 'datetime', 'yyyy-mm-dd hh:mm');
      default:
        return 0;
    }
  });

  const widths = sheet.columns.map((c, i) => {
    if (c.width) return c.width;
    let max = c.header.length;
    for (const row of sheet.rows.slice(0, 200)) {
      const v = row[i];
      if (!isBlank(v)) max = Math.max(max, String(v).length);
    }
    const base =
      c.type === 'money'
        ? Math.max(max, 14)
        : c.type === 'datetime'
          ? 17
          : c.type === 'date'
            ? 12
            : max;
    return Math.min(60, Math.max(8, base + 2));
  });

  const cell = (ref: string, col: XlsxColumn, style: number, value: unknown): string => {
    if (isBlank(value)) return '';
    const s = style ? ` s="${style}"` : '';
    switch (col.type) {
      case 'number':
      case 'money':
      case 'percent': {
        const n = asFiniteNumber(value);
        if (n !== null) return `<c r="${ref}"${s}><v>${n}</v></c>`;
        break;
      }
      case 'date': {
        const n = excelDate(value);
        if (n !== null) return `<c r="${ref}"${s}><v>${n}</v></c>`;
        break;
      }
      case 'datetime': {
        const n = excelDateTime(value);
        if (n !== null) return `<c r="${ref}"${s}><v>${n}</v></c>`;
        break;
      }
      case 'boolean':
        if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
        break;
      default:
        break;
    }
    // Texto (o un valor que no cuadró con su tipo: se conserva como texto).
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(String(value))}</t></is></c>`;
  };

  const lastCol = columnLetter(Math.max(0, sheet.columns.length - 1));
  const rowsXml: string[] = [];
  rowsXml.push(
    `<row r="1" ht="20" customHeight="1">${sheet.columns
      .map(
        (c, i) =>
          `<c r="${columnLetter(i)}1" s="1" t="inlineStr"><is><t xml:space="preserve">${xmlText(c.header)}</t></is></c>`,
      )
      .join('')}</row>`,
  );
  sheet.rows.forEach((row, r) => {
    const n = r + 2;
    const cells = sheet.columns
      .map((c, i) => cell(`${columnLetter(i)}${n}`, c, colStyles[i] ?? 0, row[i]))
      .join('');
    rowsXml.push(`<row r="${n}">${cells}</row>`);
  });

  const lastRow = sheet.rows.length + 1;
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastCol}${lastRow}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${widths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join(
      '',
    )}</cols><sheetData>${rowsXml.join('')}</sheetData><autoFilter ref="A1:${lastCol}${lastRow}"/></worksheet>`;

  const name = sheetName(sheet.name);
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlText(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  return zipStore([
    {
      name: '[Content_Types].xml',
      data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
    },
    { name: 'xl/workbook.xml', data: utf8(workbook) },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: utf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
      ),
    },
    { name: 'xl/styles.xml', data: utf8(stylesXml(book)) },
    { name: 'xl/worksheets/sheet1.xml', data: utf8(sheetXml) },
  ]);
}

/** «guias-de-carga-2026-10-02.xlsx». */
export function xlsxFileName(title: string, day?: string): string {
  const base =
    title
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'cortex';
  return `${base}${day ? `-${day}` : ''}.xlsx`;
}
