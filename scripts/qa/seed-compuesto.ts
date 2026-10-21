/**
 * SEMILLA DE PRUEBA, SEGUNDA PARTE: formularios compuestos y «Buscar en una lista».
 * SOLO LOCAL. Se corre DESPUÉS de seed-vuelos.ts, sobre la misma app:
 *
 *   - «Nueva atención»: las líneas de equipos muestran el costo de cada línea y el total al instante.
 *   - «Mis atenciones»: el detalle lleva debajo el formulario «Cerrar atención» (onRecord, por pasos),
 *     con dos secciones de líneas (equipos y materiales), editables al cerrar.
 *   - «Vuelos»: el número de vuelo busca la aerolínea en cortex.aerolineas (prefijo de 2 letras),
 *     sin IA, y «Registrar vuelo» pide la aerolínea.
 *
 *   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/cortex_qa \
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54391 QA_ORG=<ba_organization.id> \
 *   services/browser/node_modules/.bin/tsx scripts/qa/seed-compuesto.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { listRoles, listScreens, saveRoles } from '../../packages/agent-tools/src/apps/store';
import { publishVersion } from '../../packages/agent-tools/src/apps/versions';
import { createOrgScopedClient } from '../../packages/agent-tools/src/tenancy/scoped-client';
import { defineTracker, getTrackerBySlug } from '../../packages/agent-tools/src/trackers/store';
import { getView, updateView } from '../../packages/agent-tools/src/views/store';

function env(key: string): string {
  if (process.env[key]) return process.env[key] as string;
  const file = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
  for (const line of file.split('\n')) {
    if (line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0 && line.slice(0, eq).trim() === key) return line.slice(eq + 1).trim();
  }
  throw new Error(`falta ${key}`);
}
if (!/(127\.0\.0\.1|localhost)/.test(env('NEXT_PUBLIC_SUPABASE_URL')) || !/(127\.0\.0\.1|localhost)/.test(env('SUPABASE_DB_URL')))
  throw new Error('Sólo para la base local.');
const ORG = process.env.QA_ORG;
if (!ORG) throw new Error('QA_ORG = id de la empresa de prueba');

async function main() {
  const service = createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const db = createOrgScopedClient(service, ORG as string);
  const pgc = new pg.Client({ connectionString: env('SUPABASE_DB_URL') });
  await pgc.connect();
  const admin = (await pgc.query<{ id: string }>("select id from users where organization_id = $1 and email = 'admin@qa.test'", [ORG])).rows[0]?.id;
  const app = (await pgc.query<{ id: string }>("select id from custom_apps where slug = 'control_de_vuelos'")).rows[0]?.id;
  await pgc.end();
  if (!admin || !app) throw new Error('Corre antes seed-vuelos.ts');

  // --- Tablas: materiales hijos de la atención; aerolínea en vuelos con «Buscar en una lista».
  const vuelos = await getTrackerBySlug(db, 'vuelos');
  if (!vuelos) throw new Error('sin vuelos');
  const vFields = vuelos.fields.filter((f) => f.key !== 'aerolinea');
  const numero = vFields.find((f) => f.key === 'numero_vuelo');
  if (numero)
    Object.assign(numero, {
      match: {
        from: 'numero_vuelo',
        extract: { mode: 'prefix', length: 2 },
        source: 'cortex.aerolineas',
        key: 'codigo',
        fills: { aerolinea: 'nombre' },
      },
    });
  vFields.push({ key: 'aerolinea', label: 'Aerolínea', type: 'text', required: false } as never);
  await defineTracker(db, { slug: 'vuelos', name: vuelos.name, description: vuelos.description, fields: vFields, userId: admin });

  if (!(await getTrackerBySlug(db, 'materiales_usados')))
    await defineTracker(db, {
      slug: 'materiales_usados',
      name: 'Materiales usados',
      description: 'Material y cantidad por atención.',
      userId: admin,
      fields: [
        { key: 'atencion', label: 'Atención', type: 'relation', tracker: 'atenciones', required: true },
        { key: 'tarifa', label: 'Material', type: 'relation', tracker: 'tarifas', required: true },
        { key: 'cantidad', label: 'Cantidad', type: 'number', required: true, min: 0 },
        { key: 'precio', label: 'Precio unitario', type: 'money', required: false, lookup: { via: 'tarifa', field: 'precio' } },
        { key: 'costo', label: 'Costo', type: 'money', required: false, formula: '[cantidad] × [precio]' },
      ] as never,
    });

  // --- Permisos: materiales como equipos.
  const roles = await listRoles(db, app);
  await saveRoles(
    db,
    app,
    roles.map((r) => {
      const tables = { ...r.permissions.tables } as Record<string, unknown>;
      const eq = tables.equipos_usados;
      if (eq) tables.materiales_usados = eq;
      return { key: r.key, name: r.name, description: r.description, permissions: { ...r.permissions, tables } as never };
    }),
  );

  // --- Pantallas.
  const screens = await listScreens(db, app);
  const bySlug = (slug: string) => screens.find((s) => s.slug === slug);

  const atencion = bySlug('nueva_atencion');
  if (atencion) {
    const v = await getView(db, atencion.view_id, { appScreens: true });
    if (v) {
      const spec = structuredClone(v.spec);
      for (const b of spec.blocks) if (b.type === 'form' && b.lines) b.lines.amount = 'costo';
      await updateView(db, v.id, { spec, userId: admin, appScreen: true, prompt: 'QA: monto por línea' });
    }
  }

  const mis = bySlug('mis_atenciones');
  if (mis) {
    const v = await getView(db, mis.view_id, { appScreens: true });
    if (v) {
      const spec = structuredClone(v.spec);
      spec.blocks = spec.blocks.filter((b) => b.id !== 'cerrar_atencion');
      for (const b of spec.blocks) if (b.type === 'detail') b.completeWith = 'cerrar_atencion';
      spec.blocks.push({
        id: 'cerrar_atencion',
        type: 'form',
        width: 'full',
        tracker: 'atenciones',
        title: 'Cerrar atención',
        intro: 'Cuenta lo que se usó y cierra.',
        fields: ['personas', 'observaciones', 'estado'],
        steps: [
          { title: 'Cómo fue', fields: ['personas', 'observaciones'] },
          { title: 'Cierre', fields: ['estado'] },
        ],
        submitLabel: 'Guardar',
        successMessage: 'Atención actualizada.',
        editWindowMinutes: 10,
        voice: 'dictate',
        onRecord: true,
        lines: { tracker: 'equipos_usados', parent: 'atencion', item: 'tarifa', qty: 'cantidad', title: 'Equipos usados', itemLabel: 'Equipo', qtyLabel: 'Cantidad', amount: 'costo' },
        moreLines: [
          { tracker: 'materiales_usados', parent: 'atencion', item: 'tarifa', qty: 'cantidad', title: 'Materiales', itemLabel: 'Material', qtyLabel: 'Cantidad', amount: 'costo' },
        ],
      } as never);
      await updateView(db, v.id, { spec, userId: admin, appScreen: true, prompt: 'QA: cerrar atención sobre el registro' });
    }
  }

  const reg = bySlug('registrar_vuelo');
  if (reg) {
    const v = await getView(db, reg.view_id, { appScreens: true });
    if (v) {
      const spec = structuredClone(v.spec);
      for (const b of spec.blocks)
        if (b.type === 'form' && !b.fields.includes('aerolinea')) b.fields = ['numero_vuelo', 'aerolinea', 'matricula', 'fecha'];
      await updateView(db, v.id, { spec, userId: admin, appScreen: true, prompt: 'QA: aerolínea por lista' });
    }
  }
  await publishVersion(db, app, { userId: admin, note: 'QA: formularios compuestos y listas' });
  console.log('listo: compuesto + lista de aerolíneas (publicada)');
}

main().catch((e) => {
  console.dir(e, { depth: 6 });
  process.exit(1);
});
