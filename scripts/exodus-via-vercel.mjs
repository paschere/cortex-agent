#!/usr/bin/env node
/**
 * Corre el éxodo (scripts/supabase-exodus.mjs) tomando la SUPABASE_DB_URL de
 * producción DIRECTO de la API de Vercel, descifrada en memoria — nunca
 * impresa, nunca escrita a disco. El mismo trato que scripts/mint-data-keys.mjs
 * le dio a las llaves, y por la misma razón: los secretos viajan entre APIs,
 * no por la terminal.
 *
 * Uso:  RAILWAY_DB_URL='postgresql://...' node scripts/exodus-via-vercel.mjs
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dst = (process.env.RAILWAY_DB_URL ?? '').trim();
if (!dst) {
  console.error('Falta RAILWAY_DB_URL.');
  process.exit(1);
}

const authPath = join(homedir(), 'Library/Application Support/com.vercel.cli/auth.json');
const token = JSON.parse(readFileSync(authPath, 'utf8')).token;

const teams = await (
  await fetch('https://api.vercel.com/v2/teams?limit=5', {
    headers: { authorization: `Bearer ${token}` },
  })
).json();
const teamId = teams.teams[0].id;

const envs = await (
  await fetch(`https://api.vercel.com/v9/projects/cortex/env?teamId=${teamId}&decrypt=true`, {
    headers: { authorization: `Bearer ${token}` },
  })
).json();
const row = (envs.envs ?? []).find(
  (e) => e.key === 'SUPABASE_DB_URL' && (e.target ?? []).includes('production'),
);
if (!row?.value) {
  console.error(
    'No pude descifrar SUPABASE_DB_URL desde Vercel (¿marcada como sensitive?). ' +
      'En ese caso hay que copiarla a mano del dashboard.',
  );
  process.exit(1);
}
console.log('SUPABASE_DB_URL obtenida de Vercel (no se imprime). Arranca el éxodo…');

const child = spawn('node', ['scripts/supabase-exodus.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, SUPABASE_DB_URL_SRC: row.value, RAILWAY_DB_URL: dst },
});
child.on('exit', (code) => process.exit(code ?? 1));
