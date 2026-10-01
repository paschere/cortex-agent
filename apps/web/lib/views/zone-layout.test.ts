import { describe, expect, it } from 'vitest';
import {
  clampRect,
  freeSpot,
  moveZone,
  normalizeLayout,
  overlapping,
  placeZone,
  resizeZone,
  visibleRows,
} from './zone-layout';

describe('dibujar un plano a mano', () => {
  it('una zona nunca se sale de la rejilla ni queda sin tamaño', () => {
    expect(clampRect({ zone: 'a', x: 11, y: 20, w: 4, h: 9 })).toEqual({
      zone: 'a',
      x: 8,
      y: 6,
      w: 4,
      h: 6,
    });
    expect(clampRect({ zone: 'a', x: -3, y: 0, w: 0, h: 0 })).toEqual({
      zone: 'a',
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
  });

  it('una zona nueva cae en el primer hueco libre', () => {
    const layout = [{ zone: 'Muelle 1', x: 0, y: 0, w: 4, h: 2 }];
    expect(freeSpot(layout)).toEqual({ x: 4, y: 0 });
    expect(placeZone(layout, 'Bodega')).toContainEqual({ zone: 'Bodega', x: 4, y: 0, w: 4, h: 2 });
    expect(placeZone(layout, 'Muelle 1')).toHaveLength(1);
  });

  it('mover y estirar respetan los bordes', () => {
    const layout = [{ zone: 'a', x: 0, y: 0, w: 4, h: 2 }];
    expect(moveZone(layout, 'a', 10, 0)[0]).toMatchObject({ x: 8 });
    expect(resizeZone(layout, 'a', 20, 9)[0]).toMatchObject({ w: 12, h: 6 });
  });

  it('marca las zonas que se pisan, sin impedirlo', () => {
    const layout = [
      { zone: 'a', x: 0, y: 0, w: 4, h: 2 },
      { zone: 'b', x: 3, y: 1, w: 4, h: 2 },
      { zone: 'c', x: 8, y: 0, w: 4, h: 2 },
    ];
    expect([...overlapping(layout)].sort()).toEqual(['a', 'b']);
  });

  it('del spec guardado: descarta lo que ya no es zona y lo repetido', () => {
    const raw = [
      { zone: 'a', x: 0, y: 0, w: 4, h: 2 },
      { zone: 'borrada', x: 4, y: 0 },
      { zone: 'a', x: 6, y: 0 },
      'basura',
    ];
    expect(normalizeLayout(raw, ['a', 'b'])).toEqual([{ zone: 'a', x: 0, y: 0, w: 4, h: 2 }]);
    expect(visibleRows([{ zone: 'a', x: 0, y: 8, w: 4, h: 2 }])).toBe(12);
  });
});
