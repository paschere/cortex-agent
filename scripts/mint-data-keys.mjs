#!/usr/bin/env node
/**
 * ACUÑA LAS LLAVES DE LA API DE DATOS (PostgREST en Railway) SIN MOSTRARLAS.
 *
 * Cuando Cortex deje Supabase, supabase-js seguirá necesitando dos llaves:
 * una service (rol service_role) y una anon. En Supabase las emitía su
 * gateway; aquí las firmamos nosotros con el MISMO secreto que ya comparte la
 * infraestructura de Railway (JOBS_SECRET — PostgREST lo recibe como
 * PGRST_JWT_SECRET por referencia de variable, así que firmar con él es
 * firmar con lo que PostgREST verifica).
 *
 * DISEÑO DELIBERADO: este script NO imprime ningún secreto. Lee el secreto de
 * las variables de Vercel por API (con el token local del CLI), acuña los dos
 * JWT en memoria y los sube a Vercel como variables *_RAILWAY — los nombres
 * de espera. El cutover consiste en copiar esos valores sobre
 * SUPABASE_SERVICE_ROLE_KEY y NEXT_PUBLIC_SUPABASE_ANON_KEY. Nada sensible
 * pasa por la terminal ni queda en el historial.
 *
 * Uso:  node scripts/mint-data-keys.mjs
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const authPath = join(homedir(), 'Library/Application Support/com.vercel.cli/auth.json');
const token = JSON.parse(readFileSync(authPath, 'utf8')).token;
const api = 'https://api.vercel.com';

const teams = await (
  await fetch(`${api}/v2/teams?limit=5`, { headers: { authorization: `Bearer ${token}` } })
).json();
const teamId = teams.teams[0].id;

const vercel = async (path, init = {}) => {
  const res = await fetch(`${api}${path}${path.includes('?') ? '&' : '?'}teamId=${teamId}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
};

// 1. El secreto compartido, descifrado por la API (nunca impreso).
const envs = await vercel('/v9/projects/cortex/env?decrypt=true');
const secretRow = envs.envs.find((e) => e.key === 'JOBS_SECRET' && e.target.includes('production'));
if (!secretRow?.value) {
  console.error('No hay JOBS_SECRET en producción; corre primero la configuración de la cola.');
  process.exit(1);
}
const secret = secretRow.value;

// 2. Dos JWT HS256, hechos a mano para no arrastrar dependencias.
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const mint = (role) => {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  // iat fijo y exp a diez años: son llaves de servicio de larga vida, igual
  // que las que emitía Supabase. Rotarlas = cambiar JOBS_SECRET y re-correr.
  const payload = b64url(
    JSON.stringify({ iss: 'cortex-railway', role, iat: 1755300000, exp: 2070660000 }),
  );
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
};

// 3. A Vercel, con nombres de espera. El cutover los promueve.
for (const [key, role] of [
  ['SUPABASE_SERVICE_ROLE_KEY_RAILWAY', 'service_role'],
  ['NEXT_PUBLIC_SUPABASE_ANON_KEY_RAILWAY', 'anon'],
]) {
  await vercel('/v10/projects/cortex/env?upsert=true', {
    method: 'POST',
    body: JSON.stringify({ key, value: mint(role), type: 'encrypted', target: ['production'] }),
  });
  console.log(`✓ ${key} listo en Vercel (producción).`);
}
console.log('Llaves acuñadas y guardadas. Ningún secreto se imprimió.');
