import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * La entrada de los usuarios externos no tiene cookie de better-auth: `/a` y
 * `/api/apps/public` tienen que estar en PUBLIC_PATHS, y `/api/apps` y `/apps`
 * NO (esas siguen detrás de la sesión).
 */
describe('middleware: rutas públicas de las apps', () => {
  const src = readFileSync(join(__dirname, '../../middleware.ts'), 'utf8');
  const list = src.slice(
    src.indexOf('const PUBLIC_PATHS'),
    src.indexOf('];', src.indexOf('const PUBLIC_PATHS')),
  );
  const has = (p: string) => list.includes(`'${p}',`);

  it('deja pasar la entrada y las rutas de datos públicas', () => {
    expect(has('/a')).toBe(true);
    expect(has('/api/apps/public')).toBe(true);
  });

  it('no abre el resto de /apps ni de /api/apps', () => {
    expect(has('/apps')).toBe(false);
    expect(has('/api/apps')).toBe(false);
  });

  it('el código de una pantalla con código es público solo como <uuid>/<pantalla>.js|css', () => {
    const m = /const CODE_BUNDLE_RE =\s*(\/.+\/i?);/.exec(src);
    expect(m).not.toBeNull();
    const re = new RegExp((m?.[1] ?? '').replace(/^\/|\/i?$/g, ''), 'i');
    const id = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
    expect(re.test(`/api/apps/code/bundle/${id}/tablero.js`)).toBe(true);
    expect(re.test(`/api/apps/code/bundle/${id}/tablero.css`)).toBe(true);
    expect(re.test(`/api/apps/code/bundle/${id}/tablero`)).toBe(false);
    expect(re.test(`/api/apps/code/bundle/${id}/a/b.js`)).toBe(false);
    expect(re.test('/api/apps/code/bundle/x/tablero.js')).toBe(false);
    expect(re.test(`/api/apps/code/bundle/${id}`)).toBe(false);
    expect(re.test(`/api/apps/${id}/code/tablero/frame`)).toBe(false);
  });
});
