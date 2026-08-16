#!/usr/bin/env node
/**
 * EL ÉXODO: los datos de Supabase se mudan al Postgres de Railway.
 *
 * Este script asume que ya pasó todo lo demás — porque el diseño hizo que
 * «todo lo demás» dejara los datos como lo único pendiente:
 *
 *   * El esquema ya está en Railway (scripts/railway-db-setup.mjs: bootstrap
 *     + las migraciones de siempre).
 *   * Los archivos ya viven en la tabla app_files (migración 0109 y la copia
 *     desde Storage vía /api/admin/storage-migrate), así que un dump de la
 *     base ES un backup completo del producto.
 *   * PostgREST ya corre en Railway apuntando a esa base.
 *
 * Con eso, mudarse es: volcar datos → cargarlos → cambiar 4 variables en
 * Vercel → redesplegar. Este script hace los dos primeros pasos y DICE los
 * otros dos, porque cambiar producción de base es una decisión que ejecuta
 * una persona mirando, no un script.
 *
 * Uso:
 *   SUPABASE_DB_URL_SRC='postgresql://...' \
 *   RAILWAY_DB_URL='postgresql://...' \
 *   node scripts/supabase-exodus.mjs
 *
 * CONGELA EL PRODUCTO MIENTRAS CORRE: cualquier escritura entre el dump y el
 * cambio de variables se queda en Supabase y no viaja. Para este equipo eso
 * es «no uses el chat cinco minutos», no una ventana de mantenimiento.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (process.env.SUPABASE_DB_URL_SRC ?? '').trim();
const dst = (process.env.RAILWAY_DB_URL ?? '').trim();
if (!src || !dst) {
  console.error('Faltan SUPABASE_DB_URL_SRC y/o RAILWAY_DB_URL.');
  process.exit(1);
}

const require = createRequire(join(root, 'apps/web/package.json'));
const { Client } = require('pg');

// ---------------------------------------------------------------------------
// 0. El destino tiene que tener el esquema. Si no, este script te manda al
//    paso que te saltaste en vez de fallar a mitad de carga.
// ---------------------------------------------------------------------------
const check = new Client({ connectionString: dst, ssl: { rejectUnauthorized: false } });
await check.connect();
try {
  const r = await check.query(
    "select count(*)::int as n from supabase_migrations.schema_migrations",
  );
  console.log(`[0/3] destino con ${r.rows[0].n} migraciones aplicadas.`);
  if (r.rows[0].n < 100) throw new Error('el destino tiene menos migraciones de las esperadas');
} catch (err) {
  console.error(
    'El Postgres de Railway no tiene el esquema. Corre primero:\n' +
      "  RAILWAY_DB_URL='...' node scripts/railway-db-setup.mjs\n" +
      `(detalle: ${err instanceof Error ? err.message : err})`,
  );
  await check.end();
  process.exit(1);
}
await check.end();

// ---------------------------------------------------------------------------
// 1. Dump de datos con el CLI de Supabase (trae su propio pg_dump, así que la
//    versión del cliente local no importa). Solo datos: el esquema ya llegó
//    por migraciones, que es la única forma en que un esquema debe viajar.
// ---------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'cortex-exodus-'));
const dumpPath = join(dir, 'data.sql');
console.log('[1/3] volcando datos de Supabase…');
const dump = spawnSync(
  'pnpm',
  ['exec', 'supabase', 'db', 'dump', '--db-url', src, '--data-only', '-f', dumpPath],
  { cwd: root, stdio: 'inherit', encoding: 'utf8' },
);
if (dump.status !== 0) {
  console.error('El dump falló; no se tocó nada.');
  process.exit(dump.status ?? 1);
}

// ---------------------------------------------------------------------------
// 2. Carga en Railway. session_replication_role=replica apaga triggers y
//    validación de FK durante la carga — el dump ya viene consistente y el
//    orden de las tablas no tiene por qué respetar el grafo de FKs.
// ---------------------------------------------------------------------------
console.log('[2/3] cargando en Railway…');
const load = new Client({ connectionString: dst, ssl: { rejectUnauthorized: false } });
await load.connect();
try {
  await load.query('set session_replication_role = replica');
  await load.query(readFileSync(dumpPath, 'utf8'));
  await load.query('set session_replication_role = default');
  console.log('      datos cargados.');
} finally {
  await load.end();
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3. Lo que sigue lo hace una persona, a propósito.
// ---------------------------------------------------------------------------
console.log(`
[3/3] Cutover manual, en este orden:
  1. En Vercel (producción):
     NEXT_PUBLIC_SUPABASE_URL      → https://<dominio del servicio pgrest en Railway>
     SUPABASE_SERVICE_ROLE_KEY     → el valor de SUPABASE_SERVICE_ROLE_KEY_RAILWAY
     NEXT_PUBLIC_SUPABASE_ANON_KEY → el valor de NEXT_PUBLIC_SUPABASE_ANON_KEY_RAILWAY
     SUPABASE_DB_URL               → la RAILWAY_DB_URL que usaste aquí
  2. Redeploy de producción y humo: entrar, chatear, abrir /admin/usage.
  3. Si algo falla: revertir las 4 variables y redesplegar — Supabase sigue
     intacto hasta que tú decidas apagarlo.
`);
