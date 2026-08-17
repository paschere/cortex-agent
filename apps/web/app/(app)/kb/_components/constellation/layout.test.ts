import { describe, expect, it } from 'vitest';
import type { ConstellationSpace } from '../types';
import { PALETTE_SIZE, hashUnit, placeConstellation } from './layout';

/**
 * Lo único que vale la pena probar de la constelación es su geometría, y es
 * exactamente lo que NO se puede mirar a ojo: que el cielo sea el mismo entre
 * visitas, que no dependa del orden en que llegaron los datos, y que el tamaño
 * de una esfera diga la verdad sobre sus fragmentos.
 */

function corpus(): ConstellationSpace[] {
  return [
    {
      id: 'espacio-contratos',
      name: 'Contratos',
      documents: [
        { id: 'doc-a', title: 'Contrato marco', chunkCount: 40, createdAt: '2026-01-10T00:00:00Z' },
        { id: 'doc-b', title: 'Anexo tarifas', chunkCount: 10, createdAt: '2026-02-01T00:00:00Z' },
        { id: 'doc-c', title: 'Otrosí', chunkCount: 0, createdAt: '2026-03-01T00:00:00Z' },
      ],
    },
    {
      id: 'espacio-reuniones',
      name: 'Reuniones',
      documents: [
        { id: 'doc-d', title: 'Kickoff', chunkCount: 120, createdAt: '2026-04-01T00:00:00Z' },
      ],
    },
  ];
}

describe('hashUnit', () => {
  it('es estable y queda en [0, 1)', () => {
    expect(hashUnit('un-id', 3)).toBe(hashUnit('un-id', 3));
    for (const id of ['a', 'b', 'espacio-contratos', 'doc-d']) {
      const v = hashUnit(id, 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('la sal separa: el mismo id no da el mismo número para todo', () => {
    expect(hashUnit('un-id', 1)).not.toBe(hashUnit('un-id', 2));
  });
});

describe('placeConstellation', () => {
  it('sin espacios no hay cielo', () => {
    expect(placeConstellation([])).toEqual([]);
  });

  it('es determinista: el mismo corpus dibuja exactamente el mismo cielo', () => {
    expect(placeConstellation(corpus())).toEqual(placeConstellation(corpus()));
  });

  it('no depende del orden de llegada: se siembra por id, no por índice', () => {
    const straight = placeConstellation(corpus());
    const reversed = placeConstellation([...corpus()].reverse());
    expect(reversed).toEqual(straight);
  });

  it('el tamaño de la esfera crece con los fragmentos, con piso para el cero', () => {
    const [contratos] = placeConstellation(corpus());
    const byId = new Map(contratos?.docs.map((d) => [d.id, d.radius] as const));
    const a = byId.get('doc-a') ?? 0;
    const b = byId.get('doc-b') ?? 0;
    const c = byId.get('doc-c') ?? 0;
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    // Un documento aún sin fragmentos embebidos existe y se puede tocar.
    expect(c).toBeGreaterThan(0);
  });

  it('cada documento queda dentro del radio de su cúmulo', () => {
    for (const cluster of placeConstellation(corpus())) {
      for (const doc of cluster.docs) {
        const [x, y, z] = doc.position;
        expect(Math.hypot(x, y, z)).toBeLessThanOrEqual(cluster.radius + 1e-9);
      }
    }
  });

  it('las órbitas son lentas de verdad y el índice de paleta es válido', () => {
    for (const cluster of placeConstellation(corpus())) {
      // «MUY lento»: menos de 0.05 rad/s son más de dos minutos por vuelta.
      expect(cluster.speed).toBeGreaterThan(0);
      expect(cluster.speed).toBeLessThan(0.05);
      expect(Math.abs(cluster.direction)).toBe(1);
      expect(cluster.paletteIndex).toBeGreaterThanOrEqual(0);
      expect(cluster.paletteIndex).toBeLessThan(PALETTE_SIZE);
    }
  });
});
