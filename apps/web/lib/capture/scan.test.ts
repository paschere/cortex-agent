import { describe, expect, it } from 'vitest';
import {
  SCAN_DEBOUNCE_MS,
  SCAN_MAX,
  countRepeats,
  feedbackPlan,
  joinScanLines,
  normalizeScan,
  registerScan,
  scanLines,
} from './scan';

describe('normalizeScan', () => {
  it('quita caracteres de control y espacios de los extremos', () => {
    expect(normalizeScan('  AB-123\u001d\r\n')).toBe('AB-123');
    expect(normalizeScan('﻿7701234567890')).toBe('7701234567890');
  });
  it('descarta vacío, no-texto y larguísimo', () => {
    expect(normalizeScan('   ')).toBeNull();
    expect(normalizeScan(null)).toBeNull();
    expect(normalizeScan(123 as unknown)).toBeNull();
    expect(normalizeScan('x'.repeat(SCAN_MAX + 1))).toBeNull();
    expect(normalizeScan('x'.repeat(SCAN_MAX))).toHaveLength(SCAN_MAX);
  });
  it('en formatos numéricos deja sólo dígitos; UPC-A como EAN-13 vuelve a 12', () => {
    expect(normalizeScan('770 1234 56789 0', 'ean_13')).toBe('7701234567890');
    expect(normalizeScan('0036000291452', 'upc_a')).toBe('036000291452');
    // Un EAN-13 que empieza en 0 NO se recorta: es un EAN legítimo.
    expect(normalizeScan('0036000291452', 'ean_13')).toBe('0036000291452');
    expect(normalizeScan('12-AB', 'ean_13')).toBe('12-AB');
  });
  it('code 39 va en mayúsculas; un QR se respeta tal cual', () => {
    expect(normalizeScan('ab-12', 'code_39')).toBe('AB-12');
    expect(normalizeScan('https://x.co/Ab?c=1', 'qr_code')).toBe('https://x.co/Ab?c=1');
    expect(normalizeScan('ab-12', 'code_128')).toBe('ab-12');
  });
});

describe('registerScan (escaneo continuo)', () => {
  it('suma lo nuevo', () => {
    const a = registerScan([], 'A1', 1000);
    expect(a.status).toBe('new');
    const b = registerScan(a.list, 'B2', 1100);
    expect(b.status).toBe('new');
    expect(b.list.map((e) => e.code)).toEqual(['A1', 'B2']);
  });

  it('ignora el mismo código mientras la cámara lo sigue viendo y renueva la ventana', () => {
    const a = registerScan([], 'A1', 0);
    const again = registerScan(a.list, 'A1', SCAN_DEBOUNCE_MS - 100);
    expect(again.status).toBe('ignored');
    expect(again.list).toHaveLength(1);
    // La cámara no se movió: sigue dentro de la ventana contada desde la última vista.
    const still = registerScan(again.list, 'A1', SCAN_DEBOUNCE_MS + 1500);
    expect(still.status).toBe('ignored');
  });

  it('pasada la ventana, el mismo código es un duplicado que sí suma, marcado', () => {
    const a = registerScan([], 'A1', 0);
    const b = registerScan(a.list, 'A1', SCAN_DEBOUNCE_MS + 1);
    expect(b.status).toBe('duplicate');
    expect(b.list).toHaveLength(2);
    expect(b.list[1]?.duplicate).toBe(true);
  });

  it('avisa si ya estaba en el formulario', () => {
    const r = registerScan([], 'A1', 0, { existing: ['A1', 'Z9'] });
    expect(r.status).toBe('duplicate');
    expect(registerScan([], 'Q7', 0, { existing: ['A1'] }).status).toBe('new');
  });

  it('un código inválido no toca la lista', () => {
    const a = registerScan([], 'A1', 0);
    const r = registerScan(a.list, '  ', 10);
    expect(r).toMatchObject({ status: 'invalid', code: null });
    expect(r.list).toBe(a.list);
  });

  it('normaliza con el formato antes de comparar', () => {
    const a = registerScan([], '770 123', 0, { format: 'ean_8' });
    const b = registerScan(a.list, '770123', SCAN_DEBOUNCE_MS + 5, { format: 'ean_8' });
    expect(b.status).toBe('duplicate');
  });
});

describe('líneas y señales', () => {
  it('un código por línea, sin vacíos', () => {
    expect(scanLines('A1\r\n\n  B2  \nA1')).toEqual(['A1', 'B2', 'A1']);
    expect(joinScanLines(['A1', 'B2'])).toBe('A1\nB2');
    expect(countRepeats(['A1', 'B2', 'A1', 'A1'])).toBe(2);
  });
  it('cada resultado se oye y se siente distinto', () => {
    const ok = feedbackPlan('ok');
    const dup = feedbackPlan('duplicate');
    const err = feedbackPlan('error');
    expect(new Set([ok.vibrate.length, dup.vibrate.length]).size).toBe(2);
    expect(dup.tones.length).toBeGreaterThan(ok.tones.length);
    expect(err.tones[0]?.hz).toBeLessThan(ok.tones[0]?.hz as number);
  });
});
