#!/usr/bin/env node
/**
 * Copia los artículos de ayuda (apps/web/content/ayuda/*.md) al paquete de
 * herramientas como texto crudo, para que `help.search` y /ayuda los lean sin
 * tocar el disco en producción (Vercel no empaqueta archivos sueltos de otra
 * carpeta). El Markdown sigue siendo la fuente: esto sólo lo transporta.
 *
 *   node scripts/build-help-index.mjs          escribe el archivo generado
 *   node scripts/build-help-index.mjs --check  falla si está desactualizado
 *
 * `packages/agent-tools/src/help/__tests__/sources.test.ts` hace la misma
 * comprobación que --check, así que olvidarse de correrlo rompe la prueba.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = join(ROOT, 'apps/web/content/ayuda');
const OUT = join(ROOT, 'packages/agent-tools/src/help/sources.generated.ts');

const files = readdirSync(CONTENT)
  .filter((f) => f.endsWith('.md'))
  .sort();

const entries = files.map((file) => {
  const raw = readFileSync(join(CONTENT, file), 'utf8').replace(/\r\n/g, '\n');
  return `  {\n    file: ${JSON.stringify(file)},\n    raw: ${JSON.stringify(raw)},\n  },`;
});

const source = `// GENERADO por scripts/build-help-index.mjs desde apps/web/content/ayuda/*.md.
// No se edita a mano: se edita el Markdown y se vuelve a correr el script.

export interface HelpSource {
  file: string;
  raw: string;
}

export const HELP_SOURCES: readonly HelpSource[] = [
${entries.join('\n')}
];
`;

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  // El archivo pasa por biome al escribirse; se compara el contenido, no el formato.
  const names = [...current.matchAll(/file: ['"]([^'"]+)['"]/g)].map((m) => m[1]);
  if (names.join('|') !== files.join('|')) {
    console.error('La ayuda generada está desactualizada: corre node scripts/build-help-index.mjs');
    process.exit(1);
  }
  console.log(`OK: ${files.length} artículos.`);
  process.exit(0);
}

writeFileSync(OUT, source);
const biome = join(ROOT, 'node_modules/.bin/biome');
if (existsSync(biome)) execFileSync(biome, ['format', '--write', OUT], { stdio: 'ignore' });
console.log(`Escribí ${files.length} artículos en ${OUT.slice(ROOT.length + 1)}`);
