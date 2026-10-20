import { describe, expect, it } from 'vitest';
import { mergeScan, scanMessage, scannableFields, shapeScan } from './scan-shape';

const fields = [
  { key: 'awb', label: 'Guía', type: 'text' },
  { key: 'piezas', label: 'Piezas', type: 'number' },
  { key: 'valor', label: 'Valor', type: 'money' },
  { key: 'fecha', label: 'Fecha', type: 'date' },
  { key: 'tipo', label: 'Tipo', type: 'select', options: ['Carga', 'Courier'] },
  { key: 'foto', label: 'Foto', type: 'file' },
  { key: 'total', label: 'Total', type: 'number', formula: '[piezas]*2' },
  { key: 'cliente', label: 'Cliente', type: 'relation' },
];

describe('scannableFields', () => {
  it('deja fuera fotos, relaciones y calculados', () => {
    expect(scannableFields(fields).map((f) => f.key)).toEqual([
      'awb',
      'piezas',
      'valor',
      'fecha',
      'tipo',
    ]);
  });
});

describe('shapeScan', () => {
  it('limpia cada valor al formato del campo y descarta lo inválido', () => {
    const out = shapeScan(fields, {
      awb: ' 729-12345675 ',
      piezas: '4',
      valor: '1.250.000',
      fecha: '2026-10-19',
      tipo: 'courier',
      foto: 'x',
      total: 8,
      inventado: 'zzz',
    });
    expect(out.awb?.value).toBe('729-12345675');
    expect(out.piezas?.value).toBe('4');
    expect(out.valor?.value).toBe('1250000');
    expect(out.fecha?.value).toBe('2026-10-19');
    expect(out.tipo?.value).toBe('Courier');
    expect(out.foto).toBeUndefined();
    expect(out.total).toBeUndefined();
    expect(out.inventado).toBeUndefined();
    expect(out.awb?.source).toBe('documento');
  });
  it('ignora null, vacío y valores que no encajan', () => {
    const out = shapeScan(fields, { awb: null, piezas: 'muchas', tipo: 'Otro', fecha: '' });
    expect(out).toEqual({});
  });
});

describe('mergeScan', () => {
  const sug = shapeScan(fields, { awb: '729-1', piezas: '4', tipo: 'Carga' });

  it('llena lo vacío', () => {
    const m = mergeScan(fields, {}, sug);
    expect(m.applied).toEqual({ awb: '729-1', piezas: '4', tipo: 'Carga' });
  });

  it('nunca pisa lo que la persona escribió', () => {
    const m = mergeScan(fields, { awb: 'MIA-77', piezas: '' }, sug);
    expect(m.applied.awb).toBeUndefined();
    expect(m.applied.piezas).toBe('4');
    expect(m.skipped).toContainEqual({ key: 'awb', reason: 'escrito' });
  });

  it('un segundo escaneo reemplaza lo que el primero puso y la persona no tocó', () => {
    const first = mergeScan(fields, {}, sug);
    const second = shapeScan(fields, { awb: '729-2', piezas: '9' });
    const m = mergeScan(fields, { ...first.applied, piezas: '5' }, second, first.applied);
    expect(m.applied.awb).toBe('729-2');
    expect(m.applied.piezas).toBeUndefined(); // la persona lo cambió a 5
  });
});

describe('scanMessage', () => {
  it('dice lo que pasó', () => {
    expect(scanMessage({ applied: {}, sources: {}, skipped: [] }, 0)).toMatch(/No pude leer/);
    expect(
      scanMessage({ applied: { a: '1', b: '2' }, sources: {}, skipped: [] }, 2),
    ).toMatch(/llenó 2 campos/);
    expect(
      scanMessage({ applied: { a: '1' }, sources: {}, skipped: [{ key: 'b', reason: 'escrito' }] }, 2),
    ).toMatch(/dejó los 1 que ya escribiste/);
  });
});
