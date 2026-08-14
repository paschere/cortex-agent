import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * LA ESCALA, DEFENDIDA — porque un barrido sin guardia se deshace solo.
 *
 * Este repositorio tenía 23 tamaños de letra arbitrarios en 1.849 usos de
 * `text-[Npx]`, y ni un solo color fuera de sus tokens. La asimetría no era de
 * disciplina: `tailwind.config.ts` extendía `colors` y NO extendía `fontSize`,
 * así que había un token para un color y nada a lo que echar mano para un
 * tamaño. Cada componente inventaba el suyo, y los tres más frecuentes eran
 * 12.5px, 12px y 13px — una diferencia que nadie ve y que aun así hubo que
 * decidir cientos de veces.
 *
 * Ahora la escala existe (siete pasos, `docs/design-system.md`). Esto es lo que
 * impide que el codemod que la aplicó sea trabajo perdido en un mes: el
 * siguiente `text-[13px]` falla aquí, con el token que le tocaba en el mensaje.
 */

const WEB = fileURLToPath(new URL('../', import.meta.url));
const SCANNED = ['app', 'components'];
const SKIP = new Set(['node_modules', '.next', 'dist', '.turbo']);

/** Qué token le corresponde a cada tamaño suelto, para que el error enseñe la salida. */
function tokenFor(px: number): string {
  if (px <= 11.5) return 'text-micro';
  if (px <= 12.5) return 'text-xs';
  if (px <= 13.5) return 'text-sm';
  if (px <= 16) return 'text-base';
  if (px <= 20) return 'text-lg';
  if (px <= 26) return 'text-xl';
  return 'text-display';
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('la escala tipográfica', () => {
  it('no admite un tamaño suelto en ninguna clase', () => {
    const offenders: string[] = [];

    for (const root of SCANNED) {
      for (const file of sourceFiles(join(WEB, root))) {
        const src = readFileSync(file, 'utf8');
        for (const [i, line] of src.split('\n').entries()) {
          for (const m of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
            const px = Number(m[1]);
            offenders.push(`${file.slice(WEB.length)}:${i + 1}  ${m[0]} → usa ${tokenFor(px)}`);
          }
        }
      }
    }

    expect(
      offenders,
      'Un tamaño de letra suelto. La escala vive en tailwind.config.ts y está ' +
        'explicada en docs/design-system.md — siete pasos, cada uno con su ' +
        'interlineado. Si de verdad hace falta un tamaño que no está, esa es una ' +
        'conversación sobre la escala, no una excepción en un componente.',
    ).toEqual([]);
  });
});
