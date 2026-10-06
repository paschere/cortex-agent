import { describe, expect, it } from 'vitest';
import { checkUpload, checkUploadTarget, cleanFileName, normalizeMime } from './upload-rules';

const MB = 1024 * 1024;

describe('checkUpload', () => {
  it('acepta fotos y rechaza documentos en accept image', () => {
    expect(checkUpload({ name: 'a.jpg', type: 'image/jpeg', size: MB }, 'image').ok).toBe(true);
    expect(checkUpload({ name: 'a.pdf', type: 'application/pdf', size: MB }, 'image').ok).toBe(
      false,
    );
  });
  it('acepta pdf/csv con accept any', () => {
    expect(checkUpload({ name: 'a.pdf', type: 'application/pdf', size: MB }, 'any').ok).toBe(true);
    expect(checkUpload({ name: 'a.csv', type: 'text/csv', size: MB }, 'any').ok).toBe(true);
  });
  it('rechaza html y ejecutables', () => {
    expect(checkUpload({ name: 'a.html', type: 'text/html', size: 10 }, 'any').ok).toBe(false);
    expect(checkUpload({ name: 'a.svg', type: 'image/svg+xml', size: 10 }, 'any').ok).toBe(false);
  });
  it('topes de tamaño: 10 MB imágenes, 20 MB otros', () => {
    expect(checkUpload({ name: 'a.png', type: 'image/png', size: 10 * MB + 1 }, 'image').ok).toBe(
      false,
    );
    expect(checkUpload({ name: 'a.pdf', type: 'application/pdf', size: 15 * MB }, 'any').ok).toBe(
      true,
    );
    expect(checkUpload({ name: 'a.pdf', type: 'application/pdf', size: 21 * MB }, 'any').ok).toBe(
      false,
    );
  });
  it('vacío no vale; HEIC sin tipo se reconoce por extensión', () => {
    expect(checkUpload({ name: 'a.jpg', type: 'image/jpeg', size: 0 }, 'image').ok).toBe(false);
    expect(normalizeMime('', 'IMG_1.HEIC')).toBe('image/heic');
    expect(checkUpload({ name: 'IMG_1.HEIC', type: '', size: MB }, 'image').ok).toBe(true);
  });
});

describe('checkUploadTarget', () => {
  const fields = [
    { key: 'foto', type: 'file' },
    { key: 'doc', type: 'file', accept: 'any' as const },
    { key: 'nota', type: 'text' },
  ];
  it('exige form de la vista y campo file permitido', () => {
    expect(checkUploadTarget(undefined, fields, 'foto').ok).toBe(false);
    expect(checkUploadTarget({ id: 'b', type: 'table' }, fields, 'foto').ok).toBe(false);
    expect(checkUploadTarget({ id: 'b', type: 'form', fields: [] }, fields, 'nota').ok).toBe(false);
    expect(checkUploadTarget({ id: 'b', type: 'form', fields: ['nota'] }, fields, 'foto').ok).toBe(
      false,
    );
    expect(checkUploadTarget({ id: 'b', type: 'form', fields: [] }, fields, 'x').ok).toBe(false);
  });
  it('devuelve el accept del campo', () => {
    expect(checkUploadTarget({ id: 'b', type: 'form', fields: [] }, fields, 'foto')).toEqual({
      ok: true,
      accept: 'image',
    });
    expect(checkUploadTarget({ id: 'b', type: 'form' }, fields, 'doc')).toEqual({
      ok: true,
      accept: 'any',
    });
  });
});

describe('cleanFileName', () => {
  it('quita rutas', () => {
    expect(cleanFileName('C:\\x\\y\\foto.jpg')).toBe('foto.jpg');
    expect(cleanFileName('')).toBe('archivo');
  });
});

import { parseFileValue, serializeFileValue } from './upload-rules';

describe('parseFileValue', () => {
  const f = { url: '/api/files/blob/a.b', name: 'x.jpg', mime: 'image/jpeg', size: 5 };
  it('ida y vuelta, uno y varios', () => {
    expect(parseFileValue(serializeFileValue([f], false))).toEqual([f]);
    expect(parseFileValue(serializeFileValue([f, f], true))).toEqual([f, f]);
    expect(serializeFileValue([], true)).toBe('');
  });
  it('tolera basura y URLs sueltas', () => {
    expect(parseFileValue('hola')).toEqual([]);
    expect(parseFileValue('{"x":1}')).toEqual([]);
    expect(parseFileValue('https://a.co/f.pdf')[0]?.name).toBe('f.pdf');
  });
});
