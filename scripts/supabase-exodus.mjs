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
// 1. Dump de datos con pg_dump 18 vía Docker. No con el CLI de Supabase: su
//    1.219 embebe pg_dump 15 y el servidor de Supabase corre PG 17 —
//    «server version mismatch» y adiós. La imagen postgres:18 ya está local
//    (es la base del ensayo del éxodo).
//
//    SOLO el esquema public, y eso es deliberado: ahí vive todo el producto,
//    better-auth incluido (migración 0011). Los esquemas auth/storage de
//    Supabase son de GoTrue y de un Storage que ya nadie usa (los archivos
//    viajan dentro de public.app_files desde la 0109), y supabase_migrations
//    ya existe en el destino porque las migraciones llegaron por db push.
// ---------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'cortex-exodus-'));
const dumpPath = join(dir, 'data.sql');
console.log('[1/3] volcando datos de Supabase (pg_dump 18 en Docker)…');
const dump = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    'postgres:18',
    'pg_dump',
    src,
    '--data-only',
    '--schema=public',
    '--no-owner',
    '--no-privileges',
  ],
  { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 },
);
if (dump.status !== 0 || !dump.stdout?.length) {
  console.error('El dump falló; no se tocó nada.');
  process.exit(dump.status ?? 1);
}
const { writeFileSync } = await import('node:fs');
writeFileSync(dumpPath, dump.stdout);
console.log(`      ${(dump.stdout.length / 1024 / 1024).toFixed(1)} MB volcados.`);

// ---------------------------------------------------------------------------
// 2. Carga en Railway. session_replication_role=replica apaga triggers y
//    validación de FK durante la carga — el dump ya viene consistente y el
//    orden de las tablas no tiene por qué respetar el grafo de FKs.
// ---------------------------------------------------------------------------
console.log('[2/3] cargando en Railway (psql 18 en Docker)…');
// psql y no el driver de node: el dump viene con COPY ... FROM stdin, que es
// protocolo que el cliente de node no habla y psql sí. Los -c y el -f corren
// EN LA MISMA SESIÓN, así que el session_replication_role=replica (apagar
// triggers y FKs durante la carga; el dump ya es consistente) sigue vigente
// cuando entra el archivo.
try {
  const load = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${dir}:/exodo:ro`,
      'postgres:18',
      'psql',
      dst,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'set session_replication_role = replica',
      // Vaciar public en el destino antes de cargar: las migraciones dejan
      // seeds (la organización de cuarentena, los agentes de plantilla) que
      // el dump trae de nuevo con los MISMOS ids — la verdad es el origen,
      // no el seed. Esto además hace el éxodo repetible: si la carga se cae
      // a mitad, se corre otra vez y ya.
      '-c',
      `do $$ declare r record; begin
         for r in select tablename from pg_tables where schemaname = 'public' loop
           execute format('truncate table public.%I cascade', r.tablename);
         end loop;
       end $$`,
      '-f',
      '/exodo/data.sql',
    ],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], encoding: 'utf8' },
  );
  if (load.status !== 0) {
    console.error('La carga falló. El destino puede quedar a medias: bórralo y repite (el origen está intacto).');
    process.exit(load.status ?? 1);
  }
  console.log('      datos cargados.');
} finally {
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
