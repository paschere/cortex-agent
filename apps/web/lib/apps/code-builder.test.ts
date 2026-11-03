import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — script .mjs sin tipos
import { render } from '../../../../scripts/gen-app-sdk-source.mjs';
import { APP_SDK_FILES } from './app-sdk-source.generated';

/**
 * El compilador de pantallas con código lleva la fuente del SDK dentro del
 * bundle (app-sdk-source.generated.ts). Si alguien cambia packages/app-sdk y
 * olvida regenerar, las pantallas compilarían contra un SDK viejo: esta prueba
 * lo ataja. Arreglo: node scripts/gen-app-sdk-source.mjs
 */
describe('fuente del SDK dentro del compilador', () => {
  it('está al día con packages/app-sdk/src', () => {
    const current = readFileSync(join(__dirname, 'app-sdk-source.generated.ts'), 'utf8');
    expect(current).toBe(render());
  });
  it('trae el punto de entrada y no las pruebas', () => {
    expect(Object.keys(APP_SDK_FILES)).toContain('src/index.ts');
    expect(Object.keys(APP_SDK_FILES).some((p) => p.includes('.test.'))).toBe(false);
  });
});
