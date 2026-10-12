import { describe, expect, it } from 'vitest';
import { coerceValue, trackerFieldsSchema } from './schema';

/** Los campos de captura de campo: firma, código y foto con evidencia. */

const parse = (fields: unknown[]) => trackerFieldsSchema.parse(fields);

describe('alias del modelo', () => {
  it('«signature» y «firma» son un archivo-firma', () => {
    const [a, b] = parse([
      { key: 'firma', label: 'Firma', type: 'signature' },
      { key: 'firma2', label: 'Firma', type: 'firma', multiple: true, evidence: true },
    ]);
    expect(a).toMatchObject({ type: 'file', accept: 'signature' });
    // Una firma es una sola, sin evidencia de GPS.
    expect(b).toMatchObject({ type: 'file', accept: 'signature' });
    expect(b?.multiple).toBeUndefined();
    expect(b?.evidence).toBeUndefined();
  });

  it('«barcode», «qr» y «código» son un texto con lector', () => {
    const fields = parse([
      { key: 'a', label: 'A', type: 'barcode' },
      { key: 'b', label: 'B', type: 'qr' },
      { key: 'c', label: 'C', type: 'código' },
    ]);
    for (const f of fields) expect(f).toMatchObject({ type: 'text', scan: true });
  });
});

describe('opciones que sólo valen en su tipo', () => {
  it('evidence y watermark sólo en archivos; scanMode sólo en texto largo con lector', () => {
    const [num, text, long, longNoScan, photo] = parse([
      { key: 'n', label: 'N', type: 'number', evidence: true, scanMode: 'continuous' },
      { key: 't', label: 'T', type: 'text', scan: true, scanMode: 'continuous' },
      { key: 'l', label: 'L', type: 'longtext', scan: true, scanMode: 'continuous' },
      { key: 'm', label: 'M', type: 'longtext', scanMode: 'continuous' },
      { key: 'p', label: 'P', type: 'file', accept: 'image', evidence: true, watermark: true },
    ]);
    expect(num).not.toHaveProperty('evidence');
    expect(num).not.toHaveProperty('scanMode');
    expect(text?.scan).toBe(true);
    expect(text).not.toHaveProperty('scanMode');
    expect(long).toMatchObject({ scan: true, scanMode: 'continuous' });
    expect(longNoScan).not.toHaveProperty('scanMode');
    expect(photo).toMatchObject({ evidence: true, watermark: true });
  });
});

describe('valores de archivo con evidencia', () => {
  const [photo, sign] = parse([
    { key: 'foto', label: 'Foto', type: 'file', accept: 'image', evidence: true },
    { key: 'firma', label: 'Firma', type: 'signature' },
  ]) as [Parameters<typeof coerceValue>[0], Parameters<typeof coerceValue>[0]];
  const file = {
    url: 'https://x.co/f.jpg',
    name: 'f.jpg',
    mime: 'image/jpeg',
    size: 1200,
  };

  it('conserva cuándo y dónde se tomó', () => {
    const res = coerceValue(photo, {
      ...file,
      takenAt: '2026-10-12T19:32:00Z',
      lat: 4.710989123,
      lng: -74.072091,
      accuracy: 12.4,
    });
    expect(res.ok).toBe(true);
    if (res.ok)
      expect(JSON.parse(String(res.value))).toMatchObject({
        takenAt: '2026-10-12T19:32:00.000Z',
        lat: 4.710989,
        lng: -74.072091,
        accuracy: 12,
      });
  });

  it('descarta una evidencia que miente (coordenadas fuera de rango o sin pareja)', () => {
    const bad = coerceValue(photo, { ...file, lat: 200, lng: 10 });
    const half = coerceValue(photo, { ...file, lat: 4.7 });
    for (const r of [bad, half]) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(JSON.parse(String(r.value))).not.toHaveProperty('lat');
    }
  });

  it('una firma sólo acepta imágenes', () => {
    expect(coerceValue(sign, { ...file, mime: 'image/png', name: 'firma.png' }).ok).toBe(true);
    const pdf = coerceValue(sign, { ...file, mime: 'application/pdf', name: 'a.pdf' });
    expect(pdf.ok).toBe(false);
  });
});
