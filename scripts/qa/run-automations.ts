/**
 * Sustituto LOCAL del trabajo `apps/automation.run` (Inngest no corre en la
 * base de pruebas): toma las corridas `queued` y las ejecuta con el motor de
 * verdad (`executeRun`), con correo y push simulados. Repite hasta vaciar la
 * cola, porque una regla puede encolar la siguiente (suma → vuelo).
 *
 *   SUPABASE_DB_URL=… NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54391 \
 *   services/browser/node_modules/.bin/tsx scripts/qa/run-automations.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { executeRun, type AutomationDeps } from '../../packages/agent-tools/src/apps/automations/run';
import { createOrgScopedClient } from '../../packages/agent-tools/src/tenancy/scoped-client';

function env(key: string): string {
  if (process.env[key]) return process.env[key] as string;
  const file = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
  for (const line of file.split('\n')) {
    const eq = line.indexOf('=');
    if (!line.startsWith('#') && eq > 0 && line.slice(0, eq).trim() === key) return line.slice(eq + 1).trim();
  }
  throw new Error(`falta ${key}`);
}
const url = env('NEXT_PUBLIC_SUPABASE_URL');
if (!/(127\.0\.0\.1|localhost)/.test(url)) throw new Error('sólo local');
const service = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

const deps: AutomationDeps = {
  baseUrl: 'http://localhost:3100',
  signingSecret: 'qa',
  sendEmail: async (m) => {
    console.log('  [correo simulado]', m.to, '|', m.subject);
    return { sent: true };
  },
  notifyMembers: async (_db, ids) => ids.length,
  pushAppUsers: async () => [],
  askCortex: async () => ({ summary: 'simulado', staged: 0 }),
};

async function main() {
  for (let round = 0; round < 10; round++) {
    const { data } = await service
      .from('custom_app_automation_runs')
      .select('id, organization_id')
      .eq('status', 'queued')
      .limit(50);
    const runs = (data ?? []) as Array<{ id: string; organization_id: string }>;
    if (!runs.length) break;
    for (const r of runs) {
      const db = createOrgScopedClient(service, r.organization_id);
      const out = await executeRun(db, r.id, r.organization_id, deps);
      console.log('corrida', r.id.slice(0, 8), JSON.stringify(out).slice(0, 160));
    }
  }
  const { data } = await service
    .from('custom_app_automation_runs')
    .select('status, error, custom_app_automations(name)')
    .order('created_at');
  console.log(JSON.stringify(data, null, 1));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
