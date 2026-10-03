import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { jpegInfo, pngToPdfImage, renderSalesPdf, textWidth, winAnsi, wrapText } from './pdf';
import type { SalesDocumentRow, SalesLineRow } from './shape';

const doc = {
  id: 'd1',
  kind: 'quote',
  number: 12,
  status: 'enviada',
  client_name: 'Nexa Logística S.A.S.',
  client_tax_id: '900123456',
  client_email: 'compras@nexa.co',
  contact_name: 'Carlos Peña',
  issue_date: '2026-10-03',
  valid_until: '2026-10-18',
  due_date: null,
  currency: 'COP',
  payment_form: 'credito',
  payment_days: 30,
  notes: 'Incluye cargue y descargue. ¿Dudas? Escríbenos.',
  terms: null,
  withholdings: { retefuente_pct: 1 },
  provider_number: null,
} as unknown as SalesDocumentRow;

const line = (i: number): SalesLineRow =>
  ({
    id: `l${i}`,
    document_id: 'd1',
    position: i,
    description: i === 1 ? 'Flete Bogotá–Cali, tractomula con carpa' : `Servicio número ${i}`,
    product_ref: null,
    product_code: i === 1 ? 'FLT-BC' : null,
    unit: null,
    quantity: 10,
    unit_price: 1_200_000,
    discount_pct: i === 2 ? 5 : 0,
    tax_rate: 'iva_19',
  }) as unknown as SalesLineRow;

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(
    [...type].map((c) => c.charCodeAt(0)),
    4,
  );
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.slice(4, 8 + data.length)));
  return out;
}

/** Un PNG RGBA de 2×1 con filtro Sub en la fila. */
function tinyPng(): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, 2);
  v.setUint32(4, 1);
  ihdr.set([8, 6, 0, 0, 0], 8);
  // Píxeles (10,20,30,255) y (15,25,35,128) con filtro 1 (Sub).
  const raw = Uint8Array.from([1, 10, 20, 30, 255, 5, 5, 5, 129]);
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('texto', () => {
  it('WinAnsi cubre el español y las rayas tipográficas', () => {
    expect(winAnsi('Ñandú ¿sí? – “ok”')).toEqual([
      0xd1, 0x61, 0x6e, 0x64, 0xfa, 0x20, 0xbf, 0x73, 0xed, 0x3f, 0x20, 0x96, 0x20, 0x93, 0x6f,
      0x6b, 0x94,
    ]);
    expect(winAnsi('→')).toEqual([63]);
  });

  it('mide y parte renglones', () => {
    expect(textWidth('Hola', 10)).toBeCloseTo(((722 + 556 + 222 + 556) * 10) / 1000);
    const lines = wrapText('uno dos tres cuatro cinco seis', 40, 10);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => textWidth(l, 10) <= 40)).toBe(true);
  });
});

describe('imágenes', () => {
  it('lee el tamaño de un JPEG', () => {
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 30, 0, 40, 3, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(jpegInfo(jpeg)).toEqual({ width: 40, height: 30, components: 3 });
    expect(jpegInfo(Uint8Array.from([1, 2, 3]))).toBeNull();
  });

  it('un PNG con transparencia se separa en color y máscara, sin filtros', () => {
    const img = pngToPdfImage(tinyPng());
    expect(img?.width).toBe(2);
    expect([...inflateSync(img?.data as Uint8Array)]).toEqual([10, 20, 30, 15, 25, 35]);
    expect([...inflateSync(img?.mask?.data as Uint8Array)]).toEqual([255, 128]);
  });
});

describe('el PDF', () => {
  it('es un PDF válido con la marca, las líneas y los totales', () => {
    const bytes = renderSalesPdf({
      doc,
      lines: [line(1), line(2)],
      brand: {
        name: 'Transportes Andinos',
        primary: '#0f766e',
        logo: { bytes: tinyPng(), contentType: 'image/png' },
      },
    });
    const text = Buffer.from(bytes).toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('(COTIZACI\\323N)');
    expect(text).toContain('(COT-0012)');
    expect(text).toContain('/SMask 7 0 R');
    expect(text).toContain('(Transportes Andinos)');
    // 12.000.000 + 11.400.000 = 23.400.000 de base; IVA 4.446.000; total 27.846.000
    expect(text).toContain('($27.846.000)');
    expect(text).toContain('(Neto estimado a recibir)');
    // Cada objeto del xref apunta a donde dice.
    const xrefAt = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(xrefAt, xrefAt + 4)).toBe('xref');
    const offsets = [...text.slice(xrefAt).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    offsets.forEach((off, i) => {
      expect(text.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
  });

  it('muchas líneas pasan a otra página', () => {
    const many = Array.from({ length: 60 }, (_, i) => line(i + 1));
    const text = Buffer.from(
      renderSalesPdf({ doc, lines: many, brand: { name: 'X', primary: null } }),
    ).toString('latin1');
    expect(Number(/\/Count (\d+)/.exec(text)?.[1])).toBeGreaterThan(1);
    expect(text).toContain('(P\\341gina 2 de');
  });
});
