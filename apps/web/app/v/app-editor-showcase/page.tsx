import { AppEditor } from '@/components/apps/editor/AppEditor';
import type { AppEditorData } from '@/components/apps/editor/shared';
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
    location: { enabled: false, retentionDays: 30 },
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
  trackers: [],
  unknownTrackers: [],
  brand: {},
  companyBrand: { name: 'Merflex', primary: '#1e3a8a', secondary: null, logoUrl: null },
  home: null,
  homeTrackers: [],
  screenFilters: {},
} as unknown as AppEditorData;

export default function AppEditorShowcasePage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <AppEditor data={DATA} />
    </div>
  );
}
