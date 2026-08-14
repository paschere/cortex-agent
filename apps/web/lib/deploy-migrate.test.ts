import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * QUE EL DESPLIEGUE SIGA APLICANDO LAS MIGRACIONES.
 *
 * ===========================================================================
 * POR QUÉ ESTO MERECE UNA PRUEBA
 * ===========================================================================
 * El 14 de agosto de 2026, tres pantallas de producción se rompieron a la vez
 * y con tres síntomas que no se parecían entre sí ni a la causa: un error de
 * `CHECK` al guardar un informe, un 500 con un digest en `/company`, y una
 * tercera que todavía no había salido. Las tres eran lo mismo — la base iba por
 * detrás del código porque Vercel publica solo y las migraciones esperaban a
 * que alguien se acordara.
 *
 * `scripts/deploy-migrate.mjs` cierra esa ventana, pero SÓLO si el build lo
 * llama. El día que alguien reescriba el comando de build para añadir un paso y
 * se deje éste por el camino, no falla nada: los despliegues siguen saliendo
 * verdes y la ventana vuelve a abrirse en silencio, hasta que alguien se
 * encuentre otro digest.
 *
 * Eso es exactamente la forma de fallo contra la que este repositorio pone
 * guardias — la misma que `lib/motion-tokens.test.ts` (una animación que no
 * existe no falla, no hace nada) y `lib/type-scale.test.ts`.
 */

const CONFIG = fileURLToPath(new URL('../vercel.json', import.meta.url));

describe('el despliegue', () => {
  it('aplica las migraciones antes de construir', () => {
    const config = JSON.parse(readFileSync(CONFIG, 'utf8')) as { buildCommand?: string };
    const build = config.buildCommand ?? '';

    expect(
      build,
      'El comando de build de Vercel ya no llama a scripts/deploy-migrate.mjs. Sin ese ' +
        'paso, Vercel publica el código nuevo contra la base vieja y la aplicación se ' +
        'rompe con errores que no se parecen a la causa.',
    ).toContain('deploy-migrate.mjs');

    // El orden es la mitad del argumento: si la migración fallara DESPUÉS de
    // construir, ya se habría publicado código que la base no soporta. Antes, un
    // fallo detiene el despliegue y producción sigue sirviendo la combinación
    // anterior, que funcionaba.
    expect(
      build.indexOf('deploy-migrate.mjs'),
      'La migración tiene que correr ANTES del build, no después.',
    ).toBeLessThan(build.indexOf('turbo build'));
  });
});
