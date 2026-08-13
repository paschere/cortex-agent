import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLE_TENANCY } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';

/**
 * UNA SOLA PUERTA PARA ESCRIBIR, Y UN SOLO SITIO QUE MIRAR CUANDO CAMBIE LA
 * TABLA.
 *
 * ===========================================================================
 * EL ERROR QUE ESTO EVITA YA PASÓ EN ESTE PRODUCTO
 * ===========================================================================
 * La migración 0064 le añadió `organization_id NOT NULL` a `user_memories` y no
 * volvió sobre `user_memory_remember()`, la función de la 0051 que escribía en
 * ella. Desde ese día Postgres rechazó todas las escrituras con un 23502, y
 * nadie se enteró durante semanas porque la LECTURA no nombra esa columna y
 * seguía funcionando perfectamente: el producto podía recordar lo de antes y no
 * podía aprender nada nuevo. Lo arregló la 0095.
 *
 * La lección no es «acuérdate de revisar los escritores»: es que el número de
 * escritores tiene que ser uno, y que eso tiene que ser comprobable. Con este
 * archivo, «revisa todo lo que escribe en notifications» es una frase con un
 * único destinatario, y el día que aparezca un segundo la prueba lo dice antes
 * de que se mezcle.
 *
 * ===========================================================================
 * Y EL AISLAMIENTO, COMO PROPIEDAD DEL CÓDIGO FUENTE
 * ===========================================================================
 * Un aviso cita el contenido de lo que pasó: el nombre del trámite, el asunto
 * del correo que salió, lo que alguien le encargó a Cortex con sus palabras.
 * Una fuga aquí no sería un identificador suelto, sería un renglón legible.
 * Así que además: la tabla está clasificada `tenant` en el registro —lo que
 * hace que `createOrgScopedClient` filtre toda lectura y estampe toda
 * escritura— y ningún archivo de este módulo toca el cliente crudo.
 */

/** Ambos sin barra final, para que `slice(ROOT.length)` deje una inicial. */
const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const WEB_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const SCANNED = ['app', 'lib', 'inngest'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.turbo']);

/** Este archivo nombra la tabla y el cliente crudo en prosa, sin llamarlos. */
const SELF = join('lib', 'notifications', 'tenancy.test.ts');

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function webSources(): Array<{ path: string; source: string }> {
  const out: Array<{ path: string; source: string }> = [];
  for (const root of SCANNED) {
    for (const file of sourceFiles(join(WEB_ROOT, root))) {
      const relative = file.slice(WEB_ROOT.length + 1);
      if (relative === SELF) continue;
      out.push({ path: relative, source: readFileSync(file, 'utf8') });
    }
  }
  return out;
}

/** `.from('notifications')`, en cualquiera de las dos comillas. */
const TOUCHES = /\.from\(\s*['"]notifications['"]\s*\)/;
/** …seguido, en algún punto de la misma expresión, de una escritura. */
const WRITES = /\.from\(\s*['"]notifications['"]\s*\)\s*\.\s*(insert|upsert)\b/;

describe('la tabla de avisos', () => {
  it('está clasificada como dato de un espacio de trabajo', () => {
    expect(TABLE_TENANCY.notifications).toEqual({ kind: 'tenant', nullable: false });
  });

  it('se escribe desde un único archivo', () => {
    const writers = webSources()
      .filter((f) => WRITES.test(f.source))
      .map((f) => f.path)
      .sort();
    expect(
      writers,
      'Un aviso se escribe con notify() (lib/notifications/notify.ts) y con nada más. ' +
        'Un segundo escritor es un segundo sitio que habrá que revisar la próxima vez que ' +
        'la tabla gane una columna obligatoria — y ese olvido ya costó semanas de memoria ' +
        'perdida en este producto (migraciones 0064 y 0095).',
    ).toEqual(['lib/notifications/notify.ts']);
  });

  it('se lee sólo desde el módulo que la posee', () => {
    const readers = webSources()
      .filter((f) => TOUCHES.test(f.source))
      .map((f) => f.path)
      .sort();
    expect(readers).toEqual(['lib/notifications/notify.ts', 'lib/notifications/repository.ts']);
  });

  it('no reparte el cliente que ve todos los espacios de trabajo', () => {
    const raw = sourceFiles(HERE)
      .filter((f) => !f.endsWith('tenancy.test.ts'))
      .filter((f) => readFileSync(f, 'utf8').includes('getSupabaseServiceClient'))
      .map((f) => f.slice(WEB_ROOT.length + 1));
    expect(raw).toEqual([]);
  });
});
