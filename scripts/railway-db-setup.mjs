#!/usr/bin/env node
/**
 * PREPARA EL POSTGRES DE RAILWAY PARA RECIBIR A CORTEX.
 *
 * Dos pasos, en orden, idempotentes los dos:
 *
 *   1. infra/railway/bootstrap.sql — el mundo que Supabase creaba solo
 *      (roles, esquema auth con auth.uid(), esquema storage). Sin esto las
 *      migraciones fallan en la 0001.
 *   2. `supabase db push --db-url` — las 100+ migraciones de siempre, con la
 *      MISMA herramienta de siempre. El CLI de Supabase no necesita que la
 *      base sea de Supabase: solo necesita una URL y su tablita de control
 *      (supabase_migrations), que crea él mismo.
 *
 * Uso:  RAILWAY_DB_URL='postgresql://...' node scripts/railway-db-setup.mjs
 *
 * La URL es la DATABASE_PUBLIC_URL del servicio Postgres en Railway. No se
 * guarda en ningún archivo y no se imprime.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (process.env.RAILWAY_DB_URL ?? '').trim();
if (!url) {
  console.error('Falta RAILWAY_DB_URL (la DATABASE_PUBLIC_URL del Postgres en Railway).');
  process.exit(1);
}

// El driver pg ya vive en apps/web (better-auth lo usa); no se instala nada.
const require = createRequire(join(root, 'apps/web/package.json'));
const { Client } = require('pg');

console.log('[1/2] bootstrap: roles, auth.uid(), esquema storage…');
const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(readFileSync(join(root, 'infra/railway/bootstrap.sql'), 'utf8'));
  console.log('      listo.');
} finally {
  await client.end();
}

console.log('[2/2] migraciones con el CLI de Supabase…');
const result = spawnSync(
  'pnpm',
  ['exec', 'supabase', 'db', 'push', '--workdir', 'infra', '--db-url', url, '--include-all'],
  {
    cwd: root,
    // El CLI pregunta «¿aplicar?»; la respuesta va por stdin como en
    // scripts/deploy-migrate.mjs, y por la misma razón.
    stdio: ['pipe', 'inherit', 'inherit'],
    input: 'y\n',
    encoding: 'utf8',
  },
);
process.exit(result.status ?? 1);
