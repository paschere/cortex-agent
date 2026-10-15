import { AppEditor } from '@/components/apps/editor/AppEditor';
import type { AppEditorData } from '@/components/apps/editor/shared';
import { EmbedChrome } from '@/components/apps/panel/EmbedChrome';
import { computeUsage, suggestTableros } from '@cortex/agent-tools';
import { notFound } from 'next/navigation';

/**
 * EL EDITOR DE UNA APP CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /apps/[id]/edit pide sesión y una base real; aquí se pinta el mismo
 * AppEditor para revisar su diseño. Los botones llaman acciones de servidor
 * que fallan sin sesión: es para mirar, no para guardar.
 */
export const dynamic = 'force-dynamic';

const perms = { tables: {} };

const DATA = {
  app: {
    id: '00000000-0000-4000-8000-000000000001',
    slug: 'control_vuelos',
    name: 'Control de vuelos de carga',
    description:
      'Operarios registran vuelos y llenan sus atenciones; supervisor aprueba y corrige duplicados; gerencia ve indicadores.',
    icon: '✈️',
    status: 'published',
    homeScreen: 'inicio_sup',
    location: {
      enabled: false,
      retentionDays: 30,
      geofences: [
        {
          id: 'bodega_norte',
          name: 'Bodega Norte',
          lat: 4.7512,
          lng: -74.0451,
          radiusM: 180,
          on: 'both',
          notify: { roles: [], admins: true },
        },
        {
          id: 'cliente_exito',
          name: 'Cliente Éxito Calle 80',
          lat: 4.7108,
          lng: -74.0899,
          radiusM: 120,
          on: 'enter',
          notify: { roles: [], admins: false },
        },
      ],
    },
  },
  screens: [
    {
      id: 's1',
      slug: 'registrar_vuelo',
      title: 'Registrar vuelo',
      icon: 'Plane',
      roles: ['operario'],
      viewName: 'Vuelos · formulario',
    },
    {
      id: 's2',
      slug: 'mis_atenciones',
      title: 'Mis atenciones',
      icon: 'ClipboardList',
      roles: ['operario'],
      viewName: 'Atenciones',
    },
    {
      id: 's3',
      slug: 'inicio_sup',
      title: 'Inicio',
      icon: 'LayoutDashboard',
      roles: ['supervisor'],
      viewName: 'Panel del supervisor',
    },
    {
      id: 's4',
      slug: 'indicadores',
      title: 'Indicadores',
      icon: 'BarChart3',
      roles: ['gerencia'],
      viewName: 'Indicadores',
    },
  ],
  roles: [
    { key: 'operario', name: 'Operario', description: 'Registra vuelos', permissions: perms },
    { key: 'supervisor', name: 'Supervisor', description: 'Aprueba', permissions: perms },
    { key: 'gerencia', name: 'Gerencia', description: 'Ve indicadores', permissions: perms },
  ],
  members: [],
  appUsers: [],
  entryPath: '/a/00000000-0000-4000-8000-000000000001',
  kiosk: { enabled: false, idleMinutes: 2, devices: [] },
  attributeValues: {},
  directory: [],
  trackers: [
    {
      slug: 'envios',
      name: 'Envíos',
      fields: [
        { key: 'nombre', label: 'Nombre', type: 'text' },
        {
          key: 'estado',
          label: 'Estado',
          type: 'select',
          options: ['Recibido', 'En bodega', 'Despachado', 'Entregado'],
        },
        { key: 'foto', label: 'Foto de entrega', type: 'file' },
        { key: 'nota', label: 'Nota', type: 'longtext' },
      ],
      actions: [],
      flow: {
        field: 'estado',
        def: {
          states: ['Recibido', 'En bodega', 'Despachado', 'Entregado'],
          transitions: [
            { from: 'Recibido', to: 'En bodega', roles: [] },
            { from: 'En bodega', to: 'Despachado', roles: ['supervisor'] },
            { from: 'Despachado', to: 'Entregado', roles: [] },
          ],
          requirements: { Entregado: [{ kind: 'photo', field: 'foto' }] },
          notify: { Despachado: { roles: ['gerencia'], message: '{{nombre}} salió de bodega' } },
        },
      },
    },
  ],
  unknownTrackers: [],
  brand: {},
  companyBrand: { name: 'Merflex', primary: '#1e3a8a', secondary: null, logoUrl: null },
  home: null,
  homeTrackers: [],
  screenFilters: {},
  draft: {
    publishedNumber: 3,
    publishedAt: '2026-10-10T16:20:00Z',
    hasChanges: true,
    summary: '«Mis atenciones»: 1 bloque más; Tablero nuevo «Equipo y atrasos» (7 widgets)',
    changes: [
      { kind: 'changed', text: '«Mis atenciones»: 1 bloque más' },
      { kind: 'added', text: 'Tablero nuevo «Equipo y atrasos» (7 widgets)' },
    ],
  },
} as unknown as AppEditorData;

/** Uso inventado: se calcula con la MISMA función pura que el editor real. */
function fixtureUsage() {
  const now = new Date('2026-10-12T15:00:00Z');
  const at = (days: number, mins = 0) =>
    new Date(now.getTime() - days * 86_400_000 + mins * 60_000).toISOString();
  const events = [];
  const actors = ['a', 'b', 'c', 'd', 'e'];
  for (let i = 0; i < 160; i++) {
    const actor = actors[i % actors.length] as string;
    events.push({
      kind: 'screen_open' as const,
      screen: ['registrar_vuelo', 'mis_atenciones', 'inicio_sup', 'indicadores'][i % 4] as string,
      blockId: null,
      actorId: actor,
      roleKey: null,
      ref: null,
      at: at(i % 28, -(i % 600)),
    });
  }
  const submissions = [];
  for (let i = 0; i < 90; i++) {
    submissions.push({
      viewId: 'v1',
      actorId: actors[i % 3] as string,
      at: at((i * 5) % 29, -(i % 300)),
    });
    events.push({
      kind: 'form_start' as const,
      screen: 'registrar_vuelo',
      blockId: 'f',
      actorId: 'a',
      roleKey: null,
      ref: `r${i}`,
      at: at((i * 5) % 29, -(i % 300) - 2),
    });
    if (i % 5 !== 0)
      events.push({
        kind: 'form_submit' as const,
        screen: 'registrar_vuelo',
        blockId: 'f',
        actorId: 'a',
        roleKey: null,
        ref: `r${i}`,
        at: at((i * 5) % 29, -(i % 300)),
      });
  }
  return computeUsage({
    now,
    events,
    submissions,
    edits: [],
    externalSeen: [
      { actorId: 'd', at: at(1) },
      { actorId: 'e', at: at(12) },
    ],
    roleOf: new Map([
      ['a', 'operario'],
      ['b', 'operario'],
      ['c', 'supervisor'],
      ['d', 'operario'],
      ['e', 'gerencia'],
    ]),
    roleNames: new Map([
      ['operario', 'Operario'],
      ['supervisor', 'Supervisor'],
      ['gerencia', 'Gerencia'],
    ]),
    screens: [
      { slug: 'registrar_vuelo', title: 'Registrar vuelo', viewId: 'v1' },
      { slug: 'mis_atenciones', title: 'Mis atenciones', viewId: 'v2' },
      { slug: 'inicio_sup', title: 'Inicio', viewId: 'v3' },
      { slug: 'indicadores', title: 'Indicadores', viewId: 'v4' },
    ],
  });
}

const VERSIONS = [
  {
    number: 3,
    note: 'Tablero de gerencia y portal de clientes',
    createdAt: '2026-10-10T16:20:00Z',
    createdBy: null,
    current: true,
    screens: 4,
    roles: 3,
    summary: '',
    changes: [
      { kind: 'added', area: 'dashboards', text: 'Tablero nuevo «Indicadores» (6 widgets)' },
      { kind: 'changed', area: 'portal', text: 'Portal de clientes encendido' },
      { kind: 'changed', area: 'screen', text: '«Registrar vuelo»: 2 bloques más' },
    ],
  },
  {
    number: 2,
    note: '',
    createdAt: '2026-10-03T13:05:00Z',
    createdBy: null,
    current: false,
    screens: 4,
    roles: 3,
    summary: '',
    changes: [
      { kind: 'added', area: 'role', text: 'Rol nuevo «Gerencia»' },
      { kind: 'changed', area: 'role', text: 'Permisos del rol «Supervisor»' },
      { kind: 'removed', area: 'screen', text: 'Pantalla quitada «Bodega»' },
    ],
  },
  {
    number: 1,
    note: 'Primera publicación',
    createdAt: '2026-09-25T11:00:00Z',
    createdBy: null,
    current: false,
    screens: 3,
    roles: 2,
    summary: '',
    changes: [{ kind: 'added', area: 'app', text: 'Primera versión: 3 pantallas y 2 roles.' }],
  },
];

export default async function AppEditorShowcasePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; panel?: string }>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  DATA.versions = VERSIONS as never;
  DATA.usage = fixtureUsage();

  // Tableros sugeridos por rol sobre la tabla «envios» (la misma función que usa «Sugerir uno por rol»).
  DATA.dashboards = suggestTableros({
    trackers: DATA.trackers as never,
    roles: DATA.roles,
    screen: 'registrar_vuelo',
  });
  DATA.homeTrackers = DATA.trackers;
  DATA.portal = {
    enabled: false,
    roleKey: 'cliente',
    attribute: 'cliente',
  } as never;
  const { tab, panel } = await searchParams;
  // `?panel=1`: el diseño compacto que usa el panel de la app al lado del chat.
  if (panel === '1')
    return (
      <div className="cortex-workspace min-h-screen bg-canvas px-3 py-4">
        <EmbedChrome />
        <AppEditor data={DATA} initialTab={tab} compact />
      </div>
    );
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <AppEditor data={DATA} initialTab={tab} />
    </div>
  );
}
