#!/usr/bin/env node
/**
 * EL CUTOVER: producción deja de mirar a Supabase y mira a Railway.
 *
 * Prerrequisitos (todos verificados antes de correr esto el 17-08-2026):
 * esquema migrado, datos cargados con conteos idénticos, pgrest vivo
 * contestando con la llave acuñada, worker de pg-boss ejecutando crons.
 *
 * Hace UNA cosa: promueve las variables de espera *_RAILWAY a sus nombres
 * canónicos en Vercel (producción), leyéndolas por API y escribiéndolas por
 * API — ningún secreto pasa por la terminal. El redeploy va aparte (un push),
 * y el rollback es volver a poner los valores viejos de Supabase a mano.
 *
 * Uso:  RAILWAY_DB_URL='postgresql://...' node scripts/cutover-to-railway.mjs
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const railwayDb = (process.env.RAILWAY_DB_URL ?? '').trim();
if (!railwayDb) {
  console.error('Falta RAILWAY_DB_URL.');
  process.exit(1);
}
// sslmode=require: es lo que lib/auth.ts usa para saber que la base es remota
// y configurar TLS en el Pool. Sin el parámetro, better-auth intentaría una
// conexión sin TLS contra el proxy de Railway.
const dbUrlWithSsl = railwayDb.includes('sslmode=')
  ? railwayDb
  : `${railwayDb}${railwayDb.includes('?') ? '&' : '?'}sslmode=require`;

const token = JSON.parse(
  readFileSync(join(homedir(), 'Library/Application Support/com.vercel.cli/auth.json'), 'utf8'),
).token;
const api = 'https://api.vercel.com';
const teams = await (
  await fetch(`${api}/v2/teams?limit=5`, { headers: { authorization: `Bearer ${token}` } })
).json();
const teamId = teams.teams[0].id;

const vercel = async (path, init = {}) => {
  const res = await fetch(`${api}${path}${path.includes('?') ? '&' : '?'}teamId=${teamId}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
};

const envs = await vercel('/v9/projects/cortex/env?decrypt=true');
const staged = (key) => {
  const row = envs.envs.find((e) => e.key === key && (e.target ?? []).includes('production'));
  if (!row?.value) throw new Error(`falta la variable de espera ${key}`);
  return row.value;
};

const promotions = [
  ['NEXT_PUBLIC_SUPABASE_URL', staged('NEXT_PUBLIC_SUPABASE_URL_RAILWAY')],
  ['SUPABASE_SERVICE_ROLE_KEY', staged('SUPABASE_SERVICE_ROLE_KEY_RAILWAY')],
  ['NEXT_PUBLIC_SUPABASE_ANON_KEY', staged('NEXT_PUBLIC_SUPABASE_ANON_KEY_RAILWAY')],
  ['SUPABASE_DB_URL', dbUrlWithSsl],
];

for (const [key, value] of promotions) {
  await vercel('/v10/projects/cortex/env?upsert=true', {
    method: 'POST',
    body: JSON.stringify({ key, value, type: 'encrypted', target: ['production'] }),
  });
  console.log(`✓ ${key} → Railway`);
}
console.log('Variables promovidas. Falta el redeploy (un push) y el humo.');
