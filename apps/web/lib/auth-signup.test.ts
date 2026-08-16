import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * NADIE ESCRIBE EN `public.users` FUERA DE `lib/session.ts`.
 *
 * ===========================================================================
 * EL FALLO QUE ESTO IMPIDE QUE VUELVA
 * ===========================================================================
 * `lib/auth.ts` insertaba en `public.users` desde el gancho de registro con
 * `on conflict (email)`. Ese único global lo BORRÓ la migración 0064 —para que
 * dos empresas puedan tener cada una su ana@acme.com— y lo cambió por
 * `(organization_id, lower(email))`. Contra la base real:
 *
 *     ERROR: there is no unique or exclusion constraint matching
 *            the ON CONFLICT specification
 *
 * Y la misma sentencia tampoco pasaba `organization_id`, que esa migración
 * dejó `not null`. Registrarse por correo devolvía 500.
 *
 * Lo que lo hacía indetectable: LA CUENTA SÍ SE CREA. El gancho revienta
 * DESPUÉS, así que quien se registraba veía un error, creía que no había
 * funcionado, y en realidad ya podía entrar por /login. El síntoma y la causa
 * ni se parecen, y nadie reporta «me dio error pero sí me dejó entrar».
 *
 * ===========================================================================
 * POR QUÉ SE DEFIENDE ASÍ Y NO CON UNA PRUEBA DE LA CONSULTA
 * ===========================================================================
 * La regla que importa no es «esa consulta está bien escrita»: es que sólo hay
 * UN sitio que provisiona una persona, y es el que conoce su organización.
 * Cualquier segundo escritor volvería a tener que adivinar el espacio y el rol,
 * que es exactamente de lo que salió este fallo.
 *
 * `lib/session.ts` es la excepción porque es el único que corre DESPUÉS de que
 * la organización esté resuelta.
 */

const WEB = fileURLToPath(new URL('../', import.meta.url));
const SCANNED = ['app', 'lib', 'inngest'];
const SKIP = new Set(['node_modules', '.next', 'dist', '.turbo']);

/** El único que puede, y el porqué está en la cabecera de este archivo. */
const ALLOWED = new Set(['lib/session.ts', 'lib/auth-signup.test.ts']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    try {
      if (readdirSync(full).length >= 0) sourceFiles(full, out);
    } catch {
      if (/\.tsx?$/.test(entry)) out.push(full);
    }
  }
  return out;
}

describe('quién provisiona a una persona', () => {
  it('sólo lib/session.ts escribe en public.users', () => {
    const offenders: string[] = [];

    for (const root of SCANNED) {
      for (const file of sourceFiles(join(WEB, root))) {
        const rel = file.slice(WEB.length);
        if (ALLOWED.has(rel)) continue;
        const src = readFileSync(file, 'utf8');
        for (const [i, line] of src.split('\n').entries()) {
          // SQL crudo contra la tabla, y el camino de Supabase: `from('users')`
          // seguido de una escritura. Un `select` no cuenta.
          if (/\b(insert|update|upsert)\s+into\s+public\.users\b/i.test(line)) {
            offenders.push(`${rel}:${i + 1}`);
          }
        }
      }
    }

    expect(
      offenders,
      'Alguien más escribe en public.users. Ese sitio tendría que adivinar la ' +
        'organización y el rol de la persona, que es de donde salió el 500 del ' +
        'registro por correo. Provisiona desde lib/session.ts, que corre cuando la ' +
        'organización ya está resuelta.',
    ).toEqual([]);
  });

  it('el gancho de registro ya no toca esa tabla', () => {
    /**
     * SE MIRA EL CÓDIGO, NO LOS COMENTARIOS, y no es un detalle.
     *
     * La primera versión de esto falló al escribirla: el comentario que
     * documenta el fallo en `lib/auth.ts` nombra `on conflict (email)`, así que
     * la prueba lo encontraba ahí. Es el reverso del error que ya se cometió
     * hoy en `lib/pwa.test.ts` —donde la documentación del fallo SATISFACÍA la
     * comprobación—, y las dos veces la causa es la misma: leer el archivo
     * entero cuando lo que se afirma es sobre lo que se ejecuta.
     */
    const auth = readFileSync(join(WEB, 'lib/auth.ts'), 'utf8')
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .replaceAll(/^\s*\/\/.*$/gm, '');
    expect(auth).not.toMatch(/insert\s+into\s+public\.users/i);
    expect(auth, 'El `on conflict (email)` no existe desde la migración 0064.').not.toContain(
      'on conflict (email)',
    );
  });
});
