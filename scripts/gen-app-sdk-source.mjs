#!/usr/bin/env node
/**
 * Genera apps/web/lib/apps/app-sdk-source.generated.ts: el código fuente de
 * packages/app-sdk/src (sin pruebas) como texto dentro de un módulo TS.
 *
 * Por qué así: el compilador de pantallas con código (Vercel Sandbox) necesita
 * el SDK como ARCHIVOS que escribe en node_modules/@cortex/app-sdk. Leerlos
 * del disco en producción depende de que Next los incluya en el rastreo de
 * archivos de la función (outputFileTracingIncludes) y de adivinar la ruta
 * dentro de un monorepo desplegado; un módulo TS importado normalmente viaja
 * en el bundle sin configuración alguna. La prueba code-builder.test.ts falla
 * si este archivo quedó viejo respecto de packages/app-sdk/src.
 *
 * Uso:  node scripts/gen-app-sdk-source.mjs [--check]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'packages/app-sdk/src');
const out = join(root, 'apps/web/lib/apps/app-sdk-source.generated.ts');

export function render() {
  const files = {};
  for (const name of readdirSync(srcDir).sort()) {
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    files[`src/${name}`] = readFileSync(join(srcDir, name), 'utf8');
  }
  return `// GENERADO por scripts/gen-app-sdk-source.mjs a partir de packages/app-sdk/src. No editar a mano.
// Regenerar: node scripts/gen-app-sdk-source.mjs

export const APP_SDK_FILES: Record<string, string> = ${JSON.stringify(files, null, 2)};
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const next = render();
  if (process.argv.includes('--check')) {
    const current = (() => {
      try {
        return readFileSync(out, 'utf8');
      } catch {
        return '';
      }
    })();
    if (current !== next) {
      console.error('app-sdk-source.generated.ts está viejo: node scripts/gen-app-sdk-source.mjs');
      process.exit(1);
    }
  } else writeFileSync(out, next);
}
