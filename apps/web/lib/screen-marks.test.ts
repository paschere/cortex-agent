import { describe, expect, it } from 'vitest';
import {
  KEPT_FRAMES,
  MAX_MARKS,
  type ScreenFrame,
  markRect,
  normalizeMarks,
  rememberFrame,
} from './screen-marks';

/**
 * Everything the model can get wrong when it points at something.
 *
 * NOTHING HERE CALLS ANTHROPIC, and nothing here could: the three functions
 * under test are arithmetic on numbers somebody else produced, which is exactly
 * why they are in a module of their own. The interesting cases are all failures
 * — a rectangle outside the picture, corners in the wrong order, a box with no
 * words — because the model WILL produce them and the one thing this feature
 * must never do is draw a confident box in the wrong place.
 */

const BOX = { x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.35, label: 'El botón «Radicar»' };

describe('normalizeMarks · lo que se puede dibujar', () => {
  it('deja pasar un recuadro que ya venía bien', () => {
    expect(normalizeMarks([BOX])).toEqual([BOX]);
  });

  it('no devuelve nada cuando no pidieron nada', () => {
    // The empty list is the case the card checks before rendering: no marks
    // means no figure at all, not an empty frame with a caption.
    expect(normalizeMarks([])).toEqual([]);
    expect(normalizeMarks(undefined)).toEqual([]);
    expect(normalizeMarks(null)).toEqual([]);
    expect(normalizeMarks('arriba a la derecha')).toEqual([]);
    expect(normalizeMarks({ marks: [BOX] })).toEqual([]);
  });

  it('recorta al borde lo que se salió un poco', () => {
    // 1,04 is a model that saw the edge of the screen and rounded outwards. The
    // honest reading is "the border", and throwing the mark away over four
    // hundredths would lose a correct answer.
    const out = normalizeMarks([{ ...BOX, x1: -0.05, y2: 1.04 }]);
    expect(out).toHaveLength(1);
    expect(out[0]?.x1).toBe(0);
    expect(out[0]?.y2).toBe(1);
  });

  it('descarta el recuadro que quedó entero fuera de la imagen', () => {
    // Clamping collapses it onto the right border, where it would be a vertical
    // line drawn confidently at the edge of the picture — worse than nothing,
    // because that is somewhere the person will actually look.
    expect(normalizeMarks([{ ...BOX, x1: 1.6, x2: 2.1 }])).toEqual([]);
  });

  it('descarta el que vino en píxeles, en vez de señalar el sitio equivocado', () => {
    // 812×430 on a 1280px frame. Read as fractions it is off the picture in
    // both directions, so it is dropped and the model is told why — see
    // pointAtResult. Guessing the unit would point at the wrong button with
    // exactly as much confidence as pointing at the right one.
    expect(normalizeMarks([{ ...BOX, x1: 812, y1: 430, x2: 902, y2: 466 }])).toEqual([]);
  });

  it('endereza las esquinas invertidas en vez de tirar la marca', () => {
    // Two opposite corners of a real rectangle, named in the wrong order. That
    // is a different mistake from pointing at the wrong place, and it is one
    // that can be repaired without guessing anything.
    const out = normalizeMarks([{ x1: 0.8, y1: 0.7, x2: 0.3, y2: 0.2, label: 'El campo NIT' }]);
    expect(out).toEqual([{ x1: 0.3, y1: 0.2, x2: 0.8, y2: 0.7, label: 'El campo NIT' }]);
  });

  it('descarta el recuadro de área cero', () => {
    // A point, not a box. Nothing to draw, and it usually means the model gave
    // the same corner twice.
    expect(normalizeMarks([{ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5, label: 'Aquí' }])).toEqual([]);
  });

  it('descarta el recuadro sin palabras', () => {
    // A box a screen reader cannot announce is half a feature, and the half
    // that is missing is the half that works for everybody.
    expect(normalizeMarks([{ ...BOX, label: '   ' }])).toEqual([]);
    expect(normalizeMarks([{ ...BOX, label: 42 }])).toEqual([]);
  });

  it('descarta coordenadas que no son números', () => {
    expect(normalizeMarks([{ ...BOX, x2: '0.4' }])).toEqual([]);
    expect(normalizeMarks([{ ...BOX, y2: Number.NaN }])).toEqual([]);
    expect(normalizeMarks([{ ...BOX, y2: Number.POSITIVE_INFINITY }])).toEqual([]);
  });

  it('conserva las buenas aunque venga una mala en el montón', () => {
    const out = normalizeMarks([{ ...BOX, x1: 4, x2: 5 }, BOX]);
    expect(out).toEqual([BOX]);
  });

  it('no dibuja más de las que caben en una respuesta', () => {
    const many = Array.from({ length: MAX_MARKS + 3 }, (_, i) => ({ ...BOX, label: `Paso ${i}` }));
    expect(normalizeMarks(many)).toHaveLength(MAX_MARKS);
    expect(normalizeMarks(many)[0]?.label).toBe('Paso 0');
  });

  it('recorta una etiqueta que se volvió un párrafo', () => {
    const out = normalizeMarks([{ ...BOX, label: 'á'.repeat(400) }]);
    expect(out[0]?.label.length).toBe(120);
  });
});

describe('markRect · de fracción a lo que se pinta', () => {
  /**
   * Asserted to nine decimals rather than exactly, because a fraction of a
   * screen is binary floating point: (0,4 − 0,1) × 100 is 30,000000000000004,
   * and rounding it inside `markRect` would be inventing precision to make a
   * test pass. Nine decimals of a percentage is a millionth of a pixel.
   */
  const expectRect = (
    got: { left: number; top: number; width: number; height: number },
    want: { left: number; top: number; width: number; height: number },
  ) => {
    expect(got.left).toBeCloseTo(want.left, 9);
    expect(got.top).toBeCloseTo(want.top, 9);
    expect(got.width).toBeCloseTo(want.width, 9);
    expect(got.height).toBeCloseTo(want.height, 9);
  };

  it('escala a los píxeles del cuadro que se envió', () => {
    // 1280×720 is what `frameSizeOf` produces for an ordinary laptop tab, so
    // these are the pixels the mark would occupy on the frame the model saw.
    expectRect(markRect(BOX, { width: 1280, height: 720 }), {
      left: 128,
      top: 144,
      width: 384,
      height: 108,
    });
  });

  it('da porcentajes cuando se le pasa 100×100, que es como se dibuja', () => {
    // The card calls it exactly like this and appends '%', which is what makes
    // the marks rescale with the image without measuring anything.
    expectRect(markRect(BOX, { width: 100, height: 100 }), {
      left: 10,
      top: 20,
      width: 30,
      height: 15,
    });
  });

  it('señala el mismo sitio en la ventana y en el monitor', () => {
    // The whole argument for normalised coordinates: the frame arrives at
    // 1280px and is drawn in the chat column at 704px, and the mark has to land
    // on the same button in both. In fractions of the width it does, exactly.
    const big = markRect(BOX, { width: 1280, height: 720 });
    const small = markRect(BOX, { width: 704, height: 396 });
    expect(small.left / small.width).toBeCloseTo(big.left / big.width, 12);
    expect(small.top / small.height).toBeCloseTo(big.top / big.height, 12);
  });

  it('nunca se sale de la imagen, porque las fracciones ya vienen acotadas', () => {
    const mark = normalizeMarks([{ ...BOX, x1: -3, y1: -3, x2: 9, y2: 9 }])[0];
    const rect = markRect(mark ?? BOX, { width: 1280, height: 720 });
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.left + rect.width).toBeLessThanOrEqual(1280);
    expect(rect.top + rect.height).toBeLessThanOrEqual(720);
  });
});

describe('rememberFrame · lo que la pestaña alcanza a sostener', () => {
  const SIZE = { width: 1280, height: 720 };
  const frame = (n: number): ScreenFrame => ({ src: `data:image/jpeg;base64,${n}`, ...SIZE });

  it('guarda el cuadro con la pregunta para la que se tomó', () => {
    const kept = rememberFrame({}, 'a', frame(1));
    expect(kept.a).toEqual(frame(1));
  });

  it('suelta el más viejo en vez de acumular capturas toda la tarde', () => {
    let kept: Record<string, ScreenFrame> = {};
    for (let i = 0; i < KEPT_FRAMES + 2; i++) kept = rememberFrame(kept, `q${i}`, frame(i));
    expect(Object.keys(kept)).toHaveLength(KEPT_FRAMES);
    expect(kept.q0).toBeUndefined();
    expect(kept[`q${KEPT_FRAMES + 1}`]).toEqual(frame(KEPT_FRAMES + 1));
  });

  it('vuelve a poner al final una pregunta que se repite, no la deja donde estaba', () => {
    let kept = rememberFrame({}, 'a', frame(1));
    kept = rememberFrame(kept, 'b', frame(2));
    kept = rememberFrame(kept, 'a', frame(3), 2);
    kept = rememberFrame(kept, 'c', frame(4), 2);
    // 'b' was the oldest once 'a' moved to the end, so 'b' is the one that goes.
    expect(Object.keys(kept)).toEqual(['a', 'c']);
  });

  it('no toca el mapa que le pasaron', () => {
    const before = rememberFrame({}, 'a', frame(1));
    const after = rememberFrame(before, 'b', frame(2));
    expect(Object.keys(before)).toEqual(['a']);
    expect(after).not.toBe(before);
  });
});
