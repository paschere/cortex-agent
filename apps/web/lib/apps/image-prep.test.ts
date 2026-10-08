import { describe, expect, it } from 'vitest';
import { fitSize, squareRect } from './image-prep';

describe('reducir una imagen', () => {
  it('no agranda y mantiene la proporción', () => {
    expect(fitSize(200, 100, 512)).toEqual({ w: 200, h: 100 });
    expect(fitSize(2048, 1024, 512)).toEqual({ w: 512, h: 256 });
    expect(fitSize(0, 0, 512)).toEqual({ w: 1, h: 1 });
  });
});

describe('ícono cuadrado', () => {
  it('recortar al centro toma el mayor cuadrado central', () => {
    const r = squareRect(400, 200, 512, 'cover');
    expect(r).toMatchObject({ sx: 100, sy: 0, sw: 200, sh: 200, dw: 512, dh: 512 });
  });
  it('logo entero lo centra con margen, sin perder nada', () => {
    const r = squareRect(400, 200, 512, 'contain');
    expect(r).toMatchObject({ sx: 0, sy: 0, sw: 400, sh: 200, dw: 512, dh: 256, dx: 0, dy: 128 });
  });
});
