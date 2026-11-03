import { describe, expect, it } from 'vitest';
import {
  MAX_CODE_FILES,
  MAX_CODE_FILE_BYTES,
  applyFileChanges,
  disallowedPackages,
  entriesFromScreens,
  orphanScreenFiles,
  pathProblem,
  screenSlugOf,
  validateCodeFiles,
} from './files';

describe('pathProblem', () => {
  it('acepta rutas normales', () => {
    expect(pathProblem('screens/torre.tsx')).toBeNull();
    expect(pathProblem('lib/utils/fecha-1.ts')).toBeNull();
  });
  it('rechaza «..», absolutas, raras y vacías', () => {
    expect(pathProblem('../x.ts')).not.toBeNull();
    expect(pathProblem('lib/../x.ts')).not.toBeNull();
    expect(pathProblem('/etc/passwd')).not.toBeNull();
    expect(pathProblem('lib//x.ts')).not.toBeNull();
    expect(pathProblem('lib/a b.ts')).not.toBeNull();
    expect(pathProblem('')).not.toBeNull();
  });
});

describe('validateCodeFiles', () => {
  it('pasa un proyecto sano', () => {
    expect(validateCodeFiles({ 'screens/torre.tsx': 'x' })).toEqual({ 'screens/torre.tsx': 'x' });
  });
  it('rechaza demasiados archivos', () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_CODE_FILES + 1 }, (_, i) => [`lib/f${i}.ts`, '']),
    );
    expect(() => validateCodeFiles(many)).toThrow(/hasta 200/);
  });
  it('rechaza un archivo enorme y el total', () => {
    expect(() => validateCodeFiles({ 'lib/a.ts': 'x'.repeat(MAX_CODE_FILE_BYTES + 1) })).toThrow(
      /512 KB/,
    );
    const big = 'x'.repeat(MAX_CODE_FILE_BYTES);
    const files = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`lib/f${i}.ts`, big]));
    expect(() => validateCodeFiles(files)).toThrow(/4 MB/);
  });
  it('rechaza contenido que no es texto', () => {
    expect(() => validateCodeFiles({ 'lib/a.ts': 3 })).toThrow(/texto/);
  });
});

describe('applyFileChanges', () => {
  it('escribe y borra sin mutar el original', () => {
    const current = { 'lib/a.ts': '1', 'lib/b.ts': '2' };
    const next = applyFileChanges(current, { write: { 'lib/c.ts': '3' }, remove: ['lib/a.ts'] });
    expect(next).toEqual({ 'lib/b.ts': '2', 'lib/c.ts': '3' });
    expect(current).toEqual({ 'lib/a.ts': '1', 'lib/b.ts': '2' });
  });
  it('rechaza una ruta mala', () => {
    expect(() => applyFileChanges({}, { write: { '../x.ts': '1' } })).toThrow();
  });
});

describe('entradas', () => {
  const files = { 'screens/torre.tsx': 'x', 'screens/vieja.tsx': 'y' };
  it('saca las entradas de las pantallas code', () => {
    const { entries, missing } = entriesFromScreens(
      [
        { slug: 'torre', kind: 'code', codeEntry: 'screens/torre.tsx' },
        { slug: 'otra', kind: 'code', codeEntry: null },
        { slug: 'bloques', kind: 'view', codeEntry: null },
      ],
      files,
    );
    expect(entries).toEqual({ torre: 'screens/torre.tsx' });
    expect(missing).toEqual(['otra (screens/otra.tsx)']);
    expect(orphanScreenFiles(entries, files)).toEqual(['screens/vieja.tsx']);
  });
  it('screenSlugOf', () => {
    expect(screenSlugOf('screens/torre.tsx')).toBe('torre');
    expect(screenSlugOf('lib/torre.tsx')).toBeNull();
  });
});

describe('paquetes', () => {
  it('marca los no permitidos', () => {
    const pkg = JSON.stringify({ dependencies: { react: '18', lodash: '4' } });
    expect(disallowedPackages({ 'package.json': pkg })).toEqual(['lodash']);
    expect(disallowedPackages({})).toEqual([]);
  });
});
