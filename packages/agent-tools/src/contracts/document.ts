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
import { DRAFT_BANNER, DRAFT_NOTICE } from './shape';

/**
 * EL CONTRATO COMO ARCHIVO: PDF con la marca de la empresa y Word (.docx).
 *
 * Los dos llevan, siempre, que es un BORRADOR PARA REVISIÓN DE UN ABOGADO: el
 * PDF en una franja ámbar en cada página y en el pie; el Word en el primer
 * párrafo, resaltado. Ninguno de los dos se puede generar sin esa marca.
 *
 * Sin dependencias: el PDF reusa el escritor a mano de la orden de compra
 * (inventory/pdf.ts, A4, Helvetica, WinAnsi) y el Word es el mínimo de Office
 * Open XML (cuatro partes) dentro de un ZIP sin compresión, que Word, Google
 * Docs y LibreOffice abren y dejan editar.
 */

export interface ContractBrand {
  name: string;
  primary: string | null;
  logo?: Uint8Array | null;
}

const INK: Rgb = [28, 30, 38];
const MUTED: Rgb = [102, 106, 120];
const AMBER: Rgb = [146, 84, 8];
const AMBER_SOFT: Rgb = [254, 243, 199];

/** Una línea en mayúsculas sostenidas (título, «CONSIDERACIONES»). */
function isHeading(paragraph: string): boolean {
  const letters = paragraph.replace(/[^\p{L}]/gu, '');
  return letters.length >= 4 && paragraph.length <= 120 && letters === letters.toUpperCase();
}

/** Separa «PRIMERA. OBJETO.» del resto del párrafo, si lo tiene. */
export function clauseHead(paragraph: string): { head: string; rest: string } | null {
  const m = /^((?:[A-ZÁÉÍÓÚÑ]+ ){0,2}[A-ZÁÉÍÓÚÑ]+\. (?:[A-ZÁÉÍÓÚÑ ,Y]+\.)?)\s+(.*)$/su.exec(
    paragraph,
  );
  if (!m || (m[1] as string).length > 80) return null;
  return { head: (m[1] as string).trim(), rest: (m[2] as string).trim() };
}

/** El cuerpo sin el aviso de arriba (el PDF y el Word lo ponen a su manera). */
function bodyWithoutNotice(text: string): string {
  const t = text.trimStart();
  return t.startsWith(DRAFT_NOTICE) ? t.slice(DRAFT_NOTICE.length).trimStart() : t;
}

export function renderContractPdf(input: {
  title: string;
  text: string;
  brand: ContractBrand;
  generatedOn: string;
}): Uint8Array {
  const doc = new PdfDocument();
  const color = hexToRgb(input.brand.primary);
  const image = pdfImageFrom(input.brand.logo);
  doc.setImage(image);
  const M = 56;
  const W = A4.width - M * 2;
  const BOTTOM = A4.height - 64;
  const SIZE = 10;
  const LEAD = 14.2;

  const frame = () => {
    doc.rect(0, 0, A4.width, 5, color);
    let nameX = M;
    if (image) {
      const h = 30;
      const w = Math.min((image.width / image.height) * h, 120);
      const hh = (w / image.width) * image.height;
      doc.drawImage(M, 22, w, hh);
      nameX = M + w + 10;
    }
    doc.text(nameX, 40, fitText(input.brand.name, 12, 260, true), {
      size: 12,
      bold: true,
      color: image ? INK : color,
    });
    // La franja de borrador, en cada página.
    doc.rect(M, 62, W, 20, AMBER_SOFT);
    doc.text(M + 10, 75.5, `${DRAFT_BANNER.toUpperCase()} · NO ES ASESORÍA LEGAL`, {
      size: 8,
      bold: true,
      color: AMBER,
    });
    doc.line(M, A4.height - 46, A4.width - M, A4.height - 46, tint(color, 0.75));
    doc.text(
      M,
      A4.height - 32,
      fitText(`${input.title} · Borrador generado con Cortex el ${input.generatedOn}`, 7.5, W - 60),
      {
        size: 7.5,
        color: MUTED,
      },
    );
    doc.text(A4.width - M, A4.height - 32, `Página ${doc.page}`, {
      size: 7.5,
      color: MUTED,
      align: 'right',
    });
  };
  frame();

  let y = 108;
  const newPage = () => {
    doc.addPage();
    frame();
    y = 108;
  };
  const line = (
    text: string,
    opts: { bold?: boolean; size?: number; color?: Rgb; x?: number } = {},
  ) => {
    const size = opts.size ?? SIZE;
    if (y + LEAD > BOTTOM) newPage();
    doc.text(opts.x ?? M, y, text, { size, bold: opts.bold, color: opts.color ?? INK });
    y += size === SIZE ? LEAD : size * 1.4;
  };

  // El aviso completo, una vez, arriba de la primera página.
  for (const l of wrapText(DRAFT_NOTICE, 8.5, W)) line(l, { size: 8.5, color: AMBER });
  y += 8;

  const paragraphs = bodyWithoutNotice(input.text).replace(/\r/g, '').split(/\n/);
  for (const raw of paragraphs) {
    const p = raw.trimEnd();
    if (!p.trim()) {
      y += LEAD * 0.55;
      continue;
    }
    if (isHeading(p)) {
      if (y + LEAD * 2.2 > BOTTOM) newPage();
      for (const l of wrapText(p.trim(), 11, W, true)) line(l, { bold: true, size: 11 });
      y += 2;
      continue;
    }
    const clause = clauseHead(p.trim());
    if (clause) {
      // La cabecera de la cláusula en negrilla, en su propio renglón.
      if (y + LEAD * 2 > BOTTOM) newPage();
      line(clause.head, { bold: true });
      for (const l of wrapText(clause.rest, SIZE, W)) line(l);
      continue;
    }
    for (const l of wrapText(p, SIZE, W)) line(l);
  }

  return doc.toBytes({ title: `${input.title} (borrador)`, author: input.brand.name });
}

// ---------------------------------------------------------------------------
// Word (.docx): Office Open XML mínimo en un ZIP sin compresión
// ---------------------------------------------------------------------------

function xmlEscape(text: string): string {
  // Fuera los controles que XML 1.0 no admite (todo lo menor a 32 salvo tab y saltos).
  const clean = [...text]
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c >= 32 || c === 9 || c === 10 || c === 13;
    })
    .join('');
  return clean
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function run(
  text: string,
  opts: { bold?: boolean; size?: number; color?: string; highlight?: string } = {},
): string {
  const props = [
    opts.bold ? '<w:b/>' : '',
    opts.color ? `<w:color w:val="${opts.color}"/>` : '',
    opts.size ? `<w:sz w:val="${opts.size * 2}"/>` : '',
    opts.highlight ? `<w:shd w:val="clear" w:color="auto" w:fill="${opts.highlight}"/>` : '',
  ].join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

function para(runs: string, opts: { center?: boolean; after?: number } = {}): string {
  const pPr = [
    opts.center ? '<w:jc w:val="center"/>' : '<w:jc w:val="both"/>',
    `<w:spacing w:after="${opts.after ?? 160}"/>`,
  ].join('');
  return `<w:p><w:pPr>${pPr}</w:pPr>${runs}</w:p>`;
}

export function contractDocumentXml(input: {
  title: string;
  text: string;
  companyName: string;
}): string {
  const parts: string[] = [];
  parts.push(
    para(
      run(`${DRAFT_BANNER.toUpperCase()} — ${input.companyName}`, {
        bold: true,
        color: '92400E',
        size: 9,
      }),
      {
        after: 80,
      },
    ),
  );
  parts.push(
    para(run(DRAFT_NOTICE, { color: '92400E', size: 9, highlight: 'FEF3C7' }), { after: 280 }),
  );
  let first = true;
  for (const raw of bodyWithoutNotice(input.text).replace(/\r/g, '').split('\n')) {
    const p = raw.trimEnd();
    if (!p.trim()) continue;
    if (isHeading(p)) {
      parts.push(
        para(run(p.trim(), { bold: true, size: first ? 13 : 11 }), { center: first, after: 200 }),
      );
      first = false;
      continue;
    }
    first = false;
    const clause = clauseHead(p.trim());
    parts.push(
      para(clause ? `${run(`${clause.head} `, { bold: true })}${run(clause.rest)}` : run(p)),
    );
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${parts.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1300" w:bottom="1440" w:left="1300" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="21"/><w:lang w:val="es-CO"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;

function coreXml(title: string, company: string): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(`${title} (borrador)`)}</dc:title><dc:creator>${xmlEscape(company)}</dc:creator><dc:description>${xmlEscape(DRAFT_NOTICE)}</dc:description><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`;
}

let CRC_TABLE: Uint32Array | null = null;
export function crc32(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = (CRC_TABLE[(crc ^ b) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Un ZIP con las entradas tal cual (método 0, sin compresión). */
export function storeZip(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + name.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x0800, true); // nombres en UTF-8
    v.setUint16(8, 0, true);
    v.setUint16(10, 0, true);
    v.setUint16(12, 0x21, true); // 1980-01-01
    v.setUint32(14, crc, true);
    v.setUint32(18, e.data.length, true);
    v.setUint32(22, e.data.length, true);
    v.setUint16(26, name.length, true);
    v.setUint16(28, 0, true);
    local.set(name, 30);
    chunks.push(local, e.data);

    const head = new Uint8Array(46 + name.length);
    const c = new DataView(head.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, 0, true);
    c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, e.data.length, true);
    c.setUint32(24, e.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    head.set(name, 46);
    central.push(head);
    offset += local.length + e.data.length;
  }
  const centralSize = central.reduce((s, b) => s + b.length, 0);
  const end = new Uint8Array(22);
  const d = new DataView(end.buffer);
  d.setUint32(0, 0x06054b50, true);
  d.setUint16(8, entries.length, true);
  d.setUint16(10, entries.length, true);
  d.setUint32(12, centralSize, true);
  d.setUint32(16, offset, true);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
  let at = 0;
  for (const b of all) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

export function renderContractDocx(input: {
  title: string;
  text: string;
  companyName: string;
}): Uint8Array {
  const enc = new TextEncoder();
  return storeZip([
    { name: '[Content_Types].xml', data: enc.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: enc.encode(ROOT_RELS) },
    { name: 'docProps/core.xml', data: enc.encode(coreXml(input.title, input.companyName)) },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(DOC_RELS) },
    { name: 'word/styles.xml', data: enc.encode(STYLES) },
    { name: 'word/document.xml', data: enc.encode(contractDocumentXml(input)) },
  ]);
}
