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
});
