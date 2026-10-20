/**
 * SEMILLA DE PRUEBA: «Control de vuelos» (empresa de prueba, SOLO LOCAL).
 *
 * Monta, con las mismas funciones que usa el producto (installAppTemplate,
 * saveRoles, setMember, createAutomation, publishVersion), una app genérica
 * para recorrerla de punta a punta en el navegador:
 *
 *   tablas      tarifas (relación) · vuelos · atenciones · equipos_usados
 *               (hija con cantidad; costo = cantidad × tarifa; lookup de precio)
 *   roles       operario (read own) · supervisor · gerencia
 *   pantallas   registrar_vuelo, nueva_atencion (relación + líneas + número +
 *               foto), mis_atenciones (lista + detalle), vuelos (lista +
 *               detalle), tablero (cifras, gráfico, tablero)
 *   reglas      suma de equipos → atención → vuelo; al cerrar la atención el
 *               vuelo queda «Atendido»
 *
 * USO (con la base y el PostgREST locales arriba, y las cuentas ya creadas;
 * ver scripts/qa/README.md):
 *
 *   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/cortex_qa \
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54391 QA_ORG=<ba_organization.id> \
 *   services/browser/node_modules/.bin/tsx scripts/qa/seed-vuelos.ts
 *
 * NUNCA contra producción: se niega si la URL no es local.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { createOrgScopedClient } from '../../packages/agent-tools/src/tenancy/scoped-client';
import { createAutomation } from '../../packages/agent-tools/src/apps/automations/store';
import { installAppTemplate } from '../../packages/agent-tools/src/apps/install';
import { setMember } from '../../packages/agent-tools/src/apps/store';
import type { AppTemplate } from '../../packages/agent-tools/src/apps/templates';
import { publishVersion } from '../../packages/agent-tools/src/apps/versions';
import { getTrackerBySlug, upsertRow } from '../../packages/agent-tools/src/trackers/store';
import { viewSpecSchema } from '../../packages/agent-tools/src/views/spec';

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

const restUrl = env('NEXT_PUBLIC_SUPABASE_URL');
const dbUrl = env('SUPABASE_DB_URL');
if (!/(127\.0\.0\.1|localhost)/.test(restUrl) || !/(127\.0\.0\.1|localhost)/.test(dbUrl))
  throw new Error('Esta semilla es sólo para la base local.');

const ORG = process.env.QA_ORG;
if (!ORG) throw new Error('QA_ORG = id de la empresa de prueba (ba_organization.id)');

// ---------------------------------------------------------------------------
// Tablas
// ---------------------------------------------------------------------------
const tarifasFields = [
  { key: 'nombre', label: 'Equipo o servicio', type: 'text', required: true },
  { key: 'unidad', label: 'Unidad', type: 'text', required: false, placeholder: 'hora' },
  { key: 'precio', label: 'Tarifa', type: 'money', required: true, min: 0 },
] as never;

const vuelosFields = [
  { key: 'numero_vuelo', label: 'Número de vuelo', type: 'text', required: true, placeholder: 'AV-1234' },
  { key: 'matricula', label: 'Matrícula', type: 'text', required: false, placeholder: 'HK-4521' },
  { key: 'fecha', label: 'Fecha', type: 'date', required: true, default: 'today' },
  {
    key: 'estado',
    label: 'Estado',
    type: 'select',
    required: false,
    default: 'Programado',
    options: ['Programado', 'En atención', 'Atendido', 'Cancelado'],
  },
  { key: 'costo_total', label: 'Costo total', type: 'money', required: false },
] as never;

const atencionesFields = [
  { key: 'vuelo', label: 'Vuelo', type: 'relation', tracker: 'vuelos', required: true },
  {
    key: 'tipo',
    label: 'Tipo de atención',
    type: 'select',
    required: true,
    options: ['Combustible', 'Equipaje', 'Limpieza', 'Rampa'],
  },
  { key: 'personas', label: 'Personas en la atención', type: 'number', required: false, min: 1, max: 40 },
  {
    key: 'estado',
    label: 'Estado',
    type: 'select',
    required: false,
    default: 'Abierta',
    options: ['Abierta', 'Cerrada'],
  },
  { key: 'foto', label: 'Foto', type: 'file', required: false, accept: 'image' },
  { key: 'observaciones', label: 'Observaciones', type: 'longtext', required: false },
  { key: 'responsable', label: 'Responsable', type: 'text', required: false, default: 'viewer' },
  { key: 'costo_equipos', label: 'Costo de equipos', type: 'money', required: false },
] as never;

const equiposFields = [
  { key: 'atencion', label: 'Atención', type: 'relation', tracker: 'atenciones', required: true },
  { key: 'tarifa', label: 'Equipo', type: 'relation', tracker: 'tarifas', required: true },
  { key: 'cantidad', label: 'Cantidad', type: 'number', required: true, min: 0 },
  {
    key: 'precio',
    label: 'Precio unitario',
    type: 'money',
    required: false,
    lookup: { via: 'tarifa', field: 'precio' },
  },
  { key: 'costo', label: 'Costo', type: 'money', required: false, formula: '[cantidad] × [precio]' },
] as never;

// ---------------------------------------------------------------------------
// Pantallas
// ---------------------------------------------------------------------------
const OPERATOR = { layout: 'operator', density: 'comfortable' } as const;

const registrarVuelo = viewSpecSchema.parse({
  version: 1,
  accent: 'sky',
  refreshSeconds: 0,
  editing: 'team',
  alerts: [],
  theme: { ...OPERATOR, accent: 'sky' },
  blocks: [
    {
      id: 'form_vuelo',
      type: 'form',
      tracker: 'vuelos',
      title: 'Registrar vuelo',
      intro: 'Anota el vuelo. Al enviar, se abre la atención con este vuelo ya elegido.',
      fields: ['numero_vuelo', 'matricula', 'fecha'],
      submitLabel: 'Registrar vuelo',
      successMessage: 'Vuelo registrado.',
      afterSubmit: { screen: 'nueva_atencion', prefill: { vuelo: '{{fila}}' } },
    },
  ],
});

const nuevaAtencion = viewSpecSchema.parse({
  version: 1,
  accent: 'emerald',
  refreshSeconds: 0,
  editing: 'team',
  alerts: [],
  theme: { ...OPERATOR, accent: 'emerald' },
  blocks: [
    {
      id: 'form_atencion',
      type: 'form',
      tracker: 'atenciones',
      title: 'Nueva atención',
      intro: 'Elige el vuelo, cuenta el equipo usado y cierra con una foto.',
      fields: ['vuelo', 'tipo', 'personas', 'foto', 'observaciones'],
      submitLabel: 'Guardar atención',
      successMessage: 'Atención guardada.',
      lines: {
        tracker: 'equipos_usados',
        parent: 'atencion',
        item: 'tarifa',
        qty: 'cantidad',
        title: 'Equipos usados',
        itemLabel: 'Equipo',
        qtyLabel: 'Cantidad',
      },
    },
  ],
});

const misAtenciones = viewSpecSchema.parse({
  version: 1,
  accent: 'emerald',
  refreshSeconds: 10,
  editing: 'team',
  alerts: [],
  theme: { ...OPERATOR, accent: 'emerald' },
  blocks: [
    {
      id: 'abiertas',
      type: 'metric',
      width: 'half',
      tracker: 'atenciones',
      title: 'Mis abiertas',
      aggregate: 'count',
      filters: [{ field: 'estado', op: 'eq', value: 'Abierta' }],
      tone: 'amber',
      design: { surface: 'tinted', emphasis: 'strong' },
    },
    {
      id: 'cerradas',
      type: 'metric',
      width: 'half',
      tracker: 'atenciones',
      title: 'Mis cerradas',
      aggregate: 'count',
      filters: [{ field: 'estado', op: 'eq', value: 'Cerrada' }],
      tone: 'emerald',
      design: { surface: 'hero' },
    },
    {
      id: 'lista',
      type: 'table',
      tracker: 'atenciones',
      title: 'Mis atenciones',
      columns: ['vuelo', 'tipo', 'estado', 'costo_equipos'],
      sort: { field: 'created_at', dir: 'desc' },
      limit: 50,
      design: { variant: 'zebra' },
      actions: [{ id: 'cerrar', label: 'Cerrar', kind: 'set_field', field: 'estado', value: 'Cerrada', confirm: true, tone: 'emerald' }],
    },
    {
      id: 'detalle',
      type: 'detail',
      tracker: 'atenciones',
      titleField: 'tipo',
      subtitleField: 'responsable',
      statusField: 'estado',
      sections: [
        { title: 'Atención', fields: ['vuelo', 'personas', 'costo_equipos'] },
        { title: 'Notas', fields: ['observaciones'] },
      ],
      gallery: ['foto'],
      related: [
        {
          id: 'equipos',
          title: 'Equipos usados',
          tracker: 'equipos_usados',
          field: 'atencion',
          columns: ['tarifa', 'cantidad', 'costo'],
        },
      ],
      timeline: { show: ['created', 'changes', 'automations'], limit: 30 },
    },
  ],
});

const vuelosLista = viewSpecSchema.parse({
  version: 1,
  accent: 'sky',
  refreshSeconds: 10,
  editing: 'team',
  alerts: [],
  theme: { accent: 'sky', density: 'comfortable' },
  blocks: [
    {
      id: 'lista_vuelos',
      type: 'table',
      tracker: 'vuelos',
      title: 'Vuelos',
      columns: ['numero_vuelo', 'matricula', 'fecha', 'estado', 'costo_total'],
      sort: { field: 'created_at', dir: 'desc' },
      limit: 50,
    },
    {
      id: 'detalle_vuelo',
      type: 'detail',
      tracker: 'vuelos',
      titleField: 'numero_vuelo',
      subtitleField: 'matricula',
      statusField: 'estado',
      sections: [{ title: 'Vuelo', fields: ['fecha', 'costo_total'] }],
      related: [
        {
          id: 'atenciones',
          title: 'Atenciones del vuelo',
          tracker: 'atenciones',
          field: 'vuelo',
          columns: ['tipo', 'estado', 'costo_equipos'],
        },
      ],
      timeline: { show: ['created', 'changes', 'automations'], limit: 30 },
    },
  ],
});

const tablero = viewSpecSchema.parse({
  version: 1,
  accent: 'sky',
  refreshSeconds: 10,
  editing: 'team',
  alerts: [],
  theme: { accent: 'sky', density: 'comfortable' },
  blocks: [
    { id: 'total', type: 'metric', width: 'third', tracker: 'vuelos', title: 'Vuelos', aggregate: 'count', tone: 'sky', design: { surface: 'hero', icon: 'Plane' } },
    { id: 'atendidos', type: 'metric', width: 'third', tracker: 'vuelos', title: 'Atendidos', aggregate: 'count', filters: [{ field: 'estado', op: 'eq', value: 'Atendido' }], tone: 'emerald', design: { variant: 'ring' } },
    { id: 'costo', type: 'metric', width: 'third', tracker: 'vuelos', title: 'Costo total', aggregate: 'sum', field: 'costo_total', format: 'money', tone: 'amber', design: { surface: 'tinted', emphasis: 'strong' } },
    { id: 'por_estado', type: 'chart', width: 'half', tracker: 'vuelos', title: 'Vuelos por estado', chart: 'donut', groupBy: 'estado', design: { variant: 'donut' } },
    { id: 'por_tipo', type: 'chart', width: 'half', tracker: 'atenciones', title: 'Atenciones por tipo', chart: 'bar', groupBy: 'tipo' },
    { id: 'tablero_vuelos', type: 'board', tracker: 'vuelos', title: 'Tablero de vuelos', groupBy: 'estado', cardFields: ['matricula', 'costo_total'], draggable: true },
  ],
});

const T = (slug: string, name: string, description: string, fields: never) => ({ slug, name, description, fields });

const CONTROL_VUELOS: AppTemplate = {
  id: 'qa_control_vuelos',
  name: 'Control de vuelos',
  icon: '✈️',
  body: 'Vuelos, sus atenciones y el equipo usado, con costo calculado.',
  accent: 'sky',
  trackers: [
    T('tarifas', 'Tarifas', 'Equipos y servicios con su tarifa.', tarifasFields),
    T('vuelos', 'Vuelos', 'Cada vuelo atendido.', vuelosFields),
    T('atenciones', 'Atenciones', 'Cada atención de un vuelo.', atencionesFields),
    T('equipos_usados', 'Equipos usados', 'Equipo y cantidad por atención.', equiposFields),
  ],
  roles: [
    {
      key: 'operario',
      name: 'Operario',
      description: 'Registra atenciones y ve sólo las suyas.',
      permissions: {
        tables: {
          vuelos: { read: 'all', create: false, edit: 'none', actions: [] },
          tarifas: { read: 'all', create: false, edit: 'none', actions: [] },
          atenciones: { read: 'own', create: true, edit: 'own', fields: ['vuelo', 'tipo', 'personas', 'foto', 'observaciones', 'estado'], actions: ['cerrar'] },
          equipos_usados: { read: 'own', create: true, edit: 'own', actions: [] },
        },
        export: false,
      },
    },
    {
      key: 'supervisor',
      name: 'Supervisor',
      description: 'Ve todo, registra vuelos y corrige.',
      permissions: {
        tables: {
          vuelos: { read: 'all', create: true, edit: 'all', actions: [] },
          tarifas: { read: 'all', create: true, edit: 'all', actions: [] },
          atenciones: { read: 'all', create: true, edit: 'all', actions: ['cerrar'] },
          equipos_usados: { read: 'all', create: true, edit: 'all', actions: [] },
        },
        export: true,
      },
    },
    {
      key: 'gerencia',
      name: 'Gerencia',
      description: 'Mira el tablero; no escribe.',
      permissions: {
        tables: {
          vuelos: { read: 'all', create: false, edit: 'none', actions: [] },
          atenciones: { read: 'all', create: false, edit: 'none', actions: [] },
          equipos_usados: { read: 'all', create: false, edit: 'none', actions: [] },
          tarifas: { read: 'all', create: false, edit: 'none', actions: [] },
        },
        export: true,
      },
    },
  ],
  screens: [
    { slug: 'registrar_vuelo', title: 'Registrar vuelo', icon: 'Plane', roles: ['supervisor'], spec: registrarVuelo },
    { slug: 'nueva_atencion', title: 'Nueva atención', icon: 'ClipboardPlus', roles: ['operario', 'supervisor'], spec: nuevaAtencion },
    { slug: 'mis_atenciones', title: 'Mis atenciones', icon: 'ListChecks', roles: ['operario'], spec: misAtenciones },
    { slug: 'vuelos', title: 'Vuelos', icon: 'List', roles: ['supervisor', 'gerencia'], spec: vuelosLista },
    { slug: 'tablero', title: 'Tablero', icon: 'BarChart3', roles: ['supervisor', 'gerencia'], spec: tablero },
  ],
  homeScreen: 'nueva_atencion',
};

// ---------------------------------------------------------------------------
async function main() {
  const service = createClient(restUrl, env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const db = createOrgScopedClient(service, ORG as string);

  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  const people = (
    await client.query<{ id: string; email: string }>(
      'select id, email from users where organization_id = $1',
      [ORG],
    )
  ).rows;
  await client.end();
  const uid = (email: string) => {
    const p = people.find((x) => x.email === email);
    if (!p) throw new Error(`${email} no ha entrado a la empresa todavía`);
    return p.id;
  };
  const admin = uid('admin@qa.test');

  const { app, createdTrackers } = await installAppTemplate(db, CONTROL_VUELOS, { userId: admin });
  console.log('app', app.slug, 'tablas', createdTrackers.join(','));

  for (const [email, role] of [
    ['operario@qa.test', 'operario'],
    ['operario2@qa.test', 'operario'],
    ['supervisor@qa.test', 'supervisor'],
    ['gerencia@qa.test', 'gerencia'],
  ] as const)
    await setMember(db, app.id, { userId: uid(email), roleKey: role, by: admin });

  // Reglas: la suma sube de la línea a la atención y de la atención al vuelo;
  // cerrar la atención deja el vuelo «Atendido».
  const rules = [
    {
      name: 'Sumar equipos en la atención',
      trigger: { type: 'row_created', tracker: 'equipos_usados' },
      actions: [{ type: 'rollup', up: 'atencion', target: 'costo_equipos', op: 'sum', field: 'costo' }],
    },
    {
      name: 'Subir el costo de la atención al vuelo',
      trigger: { type: 'row_updated', tracker: 'atenciones', field: 'costo_equipos' },
      actions: [{ type: 'rollup', up: 'vuelo', target: 'costo_total', op: 'sum', field: 'costo_equipos' }],
    },
    {
      name: 'Al cerrar la atención, el vuelo queda Atendido',
      trigger: { type: 'row_updated', tracker: 'atenciones', field: 'estado', to: 'Cerrada' },
      actions: [{ type: 'update_related', up: 'vuelo', set: { estado: 'Atendido' } }],
    },
  ];
  for (const r of rules) {
    try {
      await createAutomation(db, app.id, { ...r, enabled: true, conditions: [] }, admin);
      console.log('regla', r.name);
    } catch (e) {
      console.error('REGLA FALLÓ', r.name, (e as Error).message);
    }
  }

  const tarifas = await getTrackerBySlug(db, 'tarifas');
  if (!tarifas) throw new Error('sin tarifas');
  for (const [nombre, unidad, precio] of [
    ['Escalera de abordaje', 'hora', 85000],
    ['Banda de equipaje', 'hora', 120000],
    ['Camión de combustible', 'servicio', 1850000],
    ['Tractor de remolque', 'hora', 240000],
  ] as const)
    await upsertRow(db, { tracker: tarifas, userId: admin, label: nombre, values: { nombre, unidad, precio } });

  await publishVersion(db, app.id, { userId: admin, note: 'Semilla de prueba' });
  console.log('publicada. Entrar en /a/' + app.slug);
}

main().catch((e) => {
  console.dir(e, { depth: 6 });
  process.exit(1);
});
