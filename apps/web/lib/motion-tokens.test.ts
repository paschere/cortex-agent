import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * UNA CLASE DE ANIMACIÓN QUE NO EXISTE NO FALLA: NO HACE NADA.
 *
 * Es el mismo fallo que dejó esta app con 23 tamaños de letra inventados —
 * `tailwind.config.ts` no extendía `fontSize` y nadie se enteró porque
 * `text-[13px]` sí funciona. Aquí es peor todavía: `animate-orbit` sin su
 * `keyframes` compila, pasa el typecheck, pasa el build y en pantalla el
 * objeto simplemente se queda quieto. No hay ningún error que leer, y lo que
 * se pierde es exactamente la información que el movimiento existía para dar.
 *
 * Así que la lista de animaciones que la app usa tiene que ser un subconjunto
 * de las que la app define. Se lee del propio `tailwind.config.ts` en vez de
 * copiar los nombres aquí, porque una segunda lista que mantener a mano es lo
 * que esta prueba está intentando evitar.
 */

const WEB = fileURLToPath(new URL('../', import.meta.url));
const SCANNED = ['app', 'components'];
const SKIP = new Set(['node_modules', '.next', 'dist', '.turbo']);

/** Las que Tailwind trae de fábrica y por tanto no hace falta declarar. */
const BUILT_IN = new Set(['none', 'spin', 'ping', 'pulse', 'bounce']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Los nombres que la app declara, de las DOS maneras válidas que tiene.
 *
 * `theme.extend.animation` en el config es la primera, y se saca por texto en
 * vez de importando el módulo: el config es TypeScript con un `require()` de un
 * plugin dentro, y cargarlo desde vitest arrastra Tailwind entero para leer
 * cuatro claves.
 *
 * La segunda es una clase `.animate-algo` escrita a mano en `globals.css`, que
 * es donde viven las que necesitan varias propiedades o un `both` — `rise` es
 * la que existía antes que este config tuviera nada. Las dos son legítimas y
 * la prueba no opina sobre cuál usar; sólo exige que la clase exista en alguna.
 */
function declaredAnimations(): Set<string> {
  const names = new Set<string>();

  const config = readFileSync(join(WEB, 'tailwind.config.ts'), 'utf8');
  const block = config.slice(config.indexOf('animation: {'));
  // Las comillas son opcionales porque un nombre con guion —`drift-a`— no es un
  // identificador válido de JavaScript y hay que entrecomillarlo. Exigir que la
  // clave empezara por letra dejaba fuera justo a las que llevan guion, que son
  // las que más fácil se escriben mal.
  for (const m of block.slice(0, block.indexOf('},')).matchAll(/^\s{8}'?([a-z][\w-]*)'?:/gm)) {
    if (m[1]) names.add(m[1]);
  }

  const css = readFileSync(join(WEB, 'app/globals.css'), 'utf8');
  for (const m of css.matchAll(/^\.animate-([a-z][\w-]*)\s*\{/gm)) {
    if (m[1]) names.add(m[1]);
  }

  return names;
}

describe('las animaciones', () => {
  it('todas las que se usan están declaradas', () => {
    const declared = declaredAnimations();
    expect(declared.size, 'no se leyó ninguna animación de tailwind.config.ts').toBeGreaterThan(0);

    const orphans: string[] = [];
    for (const root of SCANNED) {
      for (const file of sourceFiles(join(WEB, root))) {
        const src = readFileSync(file, 'utf8');
        for (const [i, line] of src.split('\n').entries()) {
          // `motion-reduce:animate-none` y demás variantes entran por el mismo
          // patrón: el nombre es lo que va detrás del último `animate-`.
          for (const m of line.matchAll(/\banimate-([a-z][\w-]*)/g)) {
            const name = m[1];
            if (!name || BUILT_IN.has(name) || declared.has(name)) continue;
            orphans.push(`${file.slice(WEB.length)}:${i + 1}  animate-${name}`);
          }
        }
      }
    }

    expect(
      orphans,
      'Una animación que no está en theme.extend.animation de tailwind.config.ts. ' +
        'La clase se genera igual y no hace absolutamente nada: el elemento se ' +
        'queda quieto y no hay ningún error que leer. Declara los keyframes y la ' +
        'animación ahí, junto a las demás.',
    ).toEqual([]);
  });
});
