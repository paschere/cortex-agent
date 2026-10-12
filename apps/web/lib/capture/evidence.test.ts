import { describe, expect, it } from 'vitest';
import {
  buildEvidence,
  coordLabel,
  formatStamp,
  watermarkLayout,
  watermarkLines,
  withEvidence,
} from './evidence';

describe('formatStamp', () => {
  it('siempre en hora de Colombia (UTC-5), sin importar la zona de quien lo ejecuta', () => {
    expect(formatStamp('2026-10-12T19:32:00Z')).toBe('12/10/2026 14:32');
    // Medianoche UTC todavía es el día anterior en Bogotá.
    expect(formatStamp('2026-01-01T03:05:00Z')).toBe('31/12/2025 22:05');
  });
  it('una fecha inválida no rompe', () => {
    expect(formatStamp('nada')).toBe('');
  });
});

describe('buildEvidence', () => {
  const now = new Date('2026-10-12T19:32:00Z');
  it('con GPS guarda coordenadas redondeadas y precisión', () => {
    expect(
      buildEvidence(now, { latitude: 4.710989123, longitude: -74.0720917, accuracy: 12.4 }),
    ).toEqual({
      takenAt: '2026-10-12T19:32:00.000Z',
      lat: 4.710989,
      lng: -74.072092,
      accuracy: 12,
    });
  });
  it('sin GPS (negado) queda sólo la hora', () => {
    expect(buildEvidence(now, null)).toEqual({ takenAt: '2026-10-12T19:32:00.000Z' });
  });
  it('un GPS que miente (0,0 o fuera de rango) no cuenta', () => {
    expect(buildEvidence(now, { latitude: 0, longitude: 0 })).not.toHaveProperty('lat');
    expect(buildEvidence(now, { latitude: 95, longitude: 10 })).not.toHaveProperty('lat');
    expect(buildEvidence(now, { latitude: Number.NaN, longitude: 10 })).not.toHaveProperty('lat');
  });
});

describe('watermarkLines', () => {
  const evidence = {
    takenAt: '2026-10-12T19:32:00Z',
    lat: 4.710989,
    lng: -74.072092,
    accuracy: 12,
  };
  it('fecha, coordenadas con precisión y quién', () => {
    expect(watermarkLines({ evidence, user: 'Ana Gómez', place: 'Control de planta' })).toEqual([
      '12/10/2026 14:32',
      '4.71099, -74.07209 (±12 m)',
      'Ana Gómez · Control de planta',
    ]);
  });
  it('sin GPS lo dice, y sin nombre no deja una línea vacía', () => {
    expect(watermarkLines({ evidence: { takenAt: evidence.takenAt } })).toEqual([
      '12/10/2026 14:32',
      'Sin ubicación',
    ]);
  });
  it('recorta una línea de quién demasiado larga', () => {
    const lines = watermarkLines({ evidence, user: 'x'.repeat(200) });
    expect(lines[2]).toHaveLength(80);
  });
  it('coordLabel con 5 decimales', () => {
    expect(coordLabel(4.7, -74.1)).toBe('4.70000, -74.10000');
  });
});

describe('watermarkLayout y withEvidence', () => {
  it('la letra crece con la imagen pero tiene piso', () => {
    expect(watermarkLayout(300, 200, 3).font).toBe(14);
    expect(watermarkLayout(1920, 1080, 3).font).toBeGreaterThan(30);
  });
  it('la banda alcanza para todas las líneas', () => {
    const l = watermarkLayout(1000, 800, 3);
    expect(l.band).toBe(l.pad * 2 + l.lineHeight * 3);
    expect(watermarkLayout(1000, 800, 0).band).toBeGreaterThan(0);
  });
  it('withEvidence suma los campos al archivo, o lo deja igual', () => {
    const f = { url: '/x', name: 'a.jpg', mime: 'image/jpeg', size: 1 };
    expect(withEvidence(f, { takenAt: 't', lat: 1, lng: 2 })).toMatchObject({
      lat: 1,
      takenAt: 't',
    });
    expect(withEvidence(f, null)).toBe(f);
  });
});
