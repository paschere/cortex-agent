import { describe, expect, it } from 'vitest';
import { MAX_BATCH_DELETE, blobPathsOf, describeOutcome, normalizeBatchIds } from './deletion';

describe('blobPathsOf', () => {
  it('un upload deja su source_ref como ruta huérfana', () => {
    expect(
      blobPathsOf({ source: 'upload', source_ref: 'u1/d1/informe.pdf', media_path: null }),
    ).toEqual(['u1/d1/informe.pdf']);
  });

  it('el audio repite la ruta en media_path y no se cuenta dos veces', () => {
    expect(
      blobPathsOf({
        source: 'recording',
        source_ref: 'u1/d2/llamada.webm',
        media_path: 'u1/d2/llamada.webm',
      }),
    ).toEqual(['u1/d2/llamada.webm']);
  });

  it('si audio divergiera en sus dos columnas, se barren ambas', () => {
    expect(blobPathsOf({ source: 'audio', source_ref: 'a', media_path: 'b' }).sort()).toEqual([
      'a',
      'b',
    ]);
  });

  it('el source_ref de gdrive es un id de Drive, no una ruta nuestra', () => {
    expect(blobPathsOf({ source: 'gdrive', source_ref: '1AbCdEf', media_path: null })).toEqual([]);
  });

  it('meeting y url no dejan binario en kb-uploads', () => {
    expect(blobPathsOf({ source: 'meeting', source_ref: 'x', media_path: null })).toEqual([]);
    expect(blobPathsOf({ source: 'url', source_ref: 'https://a', media_path: null })).toEqual([]);
  });

  it('un upload sin ruta (fila vieja o rara) no barre nada', () => {
    expect(blobPathsOf({ source: 'upload', source_ref: null, media_path: null })).toEqual([]);
    expect(blobPathsOf({ source: null, source_ref: 'x', media_path: null })).toEqual([]);
  });
});

describe('normalizeBatchIds', () => {
  it('deduplica y descarta lo que no es un id', () => {
    const res = normalizeBatchIds(['a', 'a', '', '  ', 'b', 42, null]);
    expect(res).toEqual({ ok: true, ids: ['a', 'b'] });
  });

  it('un lote vacío no es un borrado, es un error con frase', () => {
    const res = normalizeBatchIds([]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/nada seleccionado/i);
  });

  it('por encima del tope se rechaza entero, no se recorta en silencio', () => {
    const res = normalizeBatchIds(Array.from({ length: MAX_BATCH_DELETE + 1 }, (_, i) => `d${i}`));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(String(MAX_BATCH_DELETE));
  });

  it('el tope se mide después de deduplicar', () => {
    const res = normalizeBatchIds(Array.from({ length: MAX_BATCH_DELETE * 2 }, () => 'mismo'));
    expect(res).toEqual({ ok: true, ids: ['mismo'] });
  });
});

describe('describeOutcome', () => {
  it('todo borrado: una frase y ya', () => {
    expect(describeOutcome(8, [])).toBe('Listo: 8 borrados.');
    expect(describeOutcome(1, [])).toBe('Listo: 1 borrado.');
  });

  it('resultado parcial: dice cuántos sí y cuántos no, con la razón', () => {
    const text = describeOutcome(8, [
      { id: 'a', reason: 'Sin permiso.' },
      { id: 'b', reason: 'Sin permiso.' },
    ]);
    expect(text).toContain('8 borrados');
    expect(text).toContain('2 se quedaron');
    expect(text).toContain('Sin permiso.');
    // La misma razón dos veces se dice una vez.
    expect(text.match(/Sin permiso\./g)).toHaveLength(1);
  });

  it('nada borrado: lo dice de frente', () => {
    const text = describeOutcome(0, [{ id: 'a', reason: 'Eso ya no está.' }]);
    expect(text).toMatch(/no se borró/i);
    expect(text).toContain('Eso ya no está.');
  });

  it('razones distintas se listan las dos', () => {
    const text = describeOutcome(1, [
      { id: 'a', reason: 'Sin permiso.' },
      { id: 'b', reason: 'Ya no está.' },
    ]);
    expect(text).toContain('Sin permiso.');
    expect(text).toContain('Ya no está.');
  });
});
