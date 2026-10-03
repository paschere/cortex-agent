'use client';

import { TrackersIndex } from '@/app/(app)/trackers/TrackersIndex';
import { TrackerScreen } from '@/app/(app)/trackers/[slug]/TrackerScreen';
import type {
  TrackerActions,
  TrackerCardData,
  TrackersIndexActions,
} from '@/app/(app)/trackers/types';
import { DataGrid } from '@/components/datagrid/DataGrid';
import type { GridColumn, GridRow, GridView } from '@/components/datagrid/types';
import { PageHeader } from '@/components/ui/page-header';
import { fieldKeyFrom, trackerColumns, trackerGridRow } from '@/lib/datagrid/trackers';
import { applyView, normalizeView } from '@/lib/datagrid/view';
import { Truck } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { GUIDE_COLUMNS, makeGuides } from './data';

/** Acciones de mentira: contestan como el servidor, sin guardar nada. */
const wait = (ms = 350) => new Promise((r) => setTimeout(r, ms));

const SAVED: GridView[] = [
  {
    id: 'v-novedades',
    name: 'Novedades de esta semana',
    filters: [
      { key: 'estado', op: 'in', value: ['novedad', 'devuelta'] },
      { key: 'despacho', op: 'last_days', value: 7 },
    ],
    sort: [{ key: 'flete', dir: 'desc' }],
    hidden: [],
    layout: 'table',
    shared: true,
    canManage: true,
  },
  {
    id: 'v-tablero',
    name: 'Tablero por estado',
    filters: [],
    sort: [],
    hidden: [],
    layout: 'board',
    layoutKey: 'estado',
    canManage: true,
  },
];

function useTheme(dark: boolean) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
}

function GridDemo({ rows, server }: { rows: GridRow[]; server: boolean }) {
  const store = useRef(rows);
  store.current = rows;
  const seq = useRef(0);
  const first = useMemo(() => (server ? rows.slice(0, 500) : rows), [rows, server]);

  return (
    <DataGrid
      columns={GUIDE_COLUMNS}
      rows={first}
      total={rows.length}
      savedViews={SAVED}
      onSaveView={async (v) => {
        await wait();
        return { ...v, id: v.id ?? `v-${Date.now()}`, canManage: true };
      }}
      onDeleteView={async () => {
        await wait();
      }}
      onQuery={
        server
          ? async (view, page) => {
              await wait(250);
              const r = applyView(store.current, GUIDE_COLUMNS, normalizeView(GUIDE_COLUMNS, view));
              return {
                rows: r.rows.slice(page.offset, page.offset + page.limit),
                total: r.rows.length,
              };
            }
          : undefined
      }
      onEdit={async (_id, key, value) => {
        await wait();
        if (key === 'notas' && typeof value === 'string' && /error/i.test(value))
          throw new Error(
            'El servidor no aceptó la observación (de mentira). Volvió a su valor anterior.',
          );
      }}
      onBulkEdit={async () => {
        await wait(500);
      }}
      onCreate={async (values) => {
        await wait();
        seq.current += 1;
        return { id: `nueva-${seq.current}`, values };
      }}
      onDelete={async () => {
        await wait();
      }}
      onAddColumn={async (col) => {
        await wait();
        return {
          ...col,
          key: fieldKeyFrom(
            col.label,
            GUIDE_COLUMNS.map((c) => c.key),
          ),
          editable: true,
        } as GridColumn;
      }}
      exportName="Guías de carga"
      noun={{ one: 'guía', many: 'guías', gender: 'f' }}
      askCortexContext="Sobre las guías de carga de Logística Andina:"
      emptyState={{
        title: 'Todavía no hay guías',
        body: 'Las guías llegan solas desde la hoja del despachador, o las creas aquí.',
        action: { label: 'Conectar la hoja', href: '/feed' },
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Las pantallas de tablas con datos de mentira
// ---------------------------------------------------------------------------

const FIELDS = [
  { key: 'guia', label: 'Guía', type: 'text' as const, required: true },
  { key: 'cliente', label: 'Cliente', type: 'text' as const },
  {
    key: 'estado',
    label: 'Estado',
    type: 'select' as const,
    options: ['Por recoger', 'En tránsito', 'Entregada', 'Novedad'],
  },
  { key: 'flete', label: 'Valor flete', type: 'money' as const },
  { key: 'peso', label: 'Peso (kg)', type: 'number' as const },
  { key: 'despacho', label: 'Despacho', type: 'date' as const },
];

function trackerRows(guides: GridRow[]): GridRow[] {
  const label: Record<string, string> = {
    por_recoger: 'Por recoger',
    en_transito: 'En tránsito',
    en_bodega: 'En tránsito',
    entregada: 'Entregada',
    novedad: 'Novedad',
    devuelta: 'Novedad',
  };
  return guides.slice(0, 1200).map((g, i) =>
    trackerGridRow({
      id: `t${i}`,
      label: String(g.values.guia),
      values: {
        guia: String(g.values.guia),
        cliente: String(g.values.cliente),
        estado: label[String(g.values.estado)] ?? 'Por recoger',
        flete: Number(g.values.flete),
        peso: Number(g.values.peso),
        despacho: String(g.values.despacho),
      },
      updated_at: new Date(Date.parse('2026-10-02T15:00:00Z') - i * 3_600_000).toISOString(),
    }),
  );
}

const TRACKER_ACTIONS: TrackerActions = {
  async edit(_t, rowId, key, value) {
    await wait();
    return { ok: true, row: { id: rowId, values: { [key]: value } } };
  },
  async bulkEdit(_t, ids) {
    await wait();
    return { ok: true, changed: ids.length };
  },
  async create(_t, values) {
    await wait();
    return { ok: true, row: { id: `n${Date.now()}`, values } };
  },
  async remove(_t, ids) {
    await wait();
    return { ok: true, removed: ids.length };
  },
  async addColumn(_t, col) {
    await wait();
    const [c] = trackerColumns([{ key: fieldKeyFrom(col.label), label: col.label, type: 'text' }], {
      withUpdated: false,
    });
    return { ok: true, column: { ...(c as GridColumn), pinned: false } };
  },
  async query() {
    return { ok: true, rows: [], total: 0 };
  },
  async history() {
    await wait(400);
    return {
      ok: true,
      entries: [
        {
          at: '2026-10-02T14:10:00Z',
          who: 'Laura Gómez',
          what: 'Estado: «En tránsito» → «Entregada»',
        },
        {
          at: '2026-10-01T21:02:00Z',
          who: 'Andrés Peña',
          what: 'Movió la tarjeta: Estado: «Por recoger» → «En tránsito»',
        },
        {
          at: '2026-09-30T13:30:00Z',
          who: 'La sincronización',
          what: 'La trajo la sincronización',
        },
      ],
    };
  },
  async syncNow() {
    await wait(700);
    return { ok: true, message: 'Listo: la estoy corriendo (de mentira).' };
  },
  async listViews() {
    return SAVED;
  },
  async saveView(_s, v) {
    await wait();
    return { ...v, id: v.id ?? `v-${Date.now()}`, canManage: true };
  },
  async deleteView() {
    await wait();
  },
};

const INDEX_ACTIONS: TrackersIndexActions = {
  async createTracker(input) {
    await wait();
    return {
      ok: true,
      slug: 'nueva_tabla',
      id: 'x',
      keys: input.fields.map((f) => fieldKeyFrom(f.label)),
    };
  },
  async importRows(_t, rows) {
    await wait(300);
    return { ok: true, inserted: rows.length, errors: [] };
  },
  async readSpreadsheet() {
    return { ok: false, error: 'En la vitrina solo se leen CSV.' };
  },
};

const CARDS: TrackerCardData[] = [
  {
    id: 'a',
    slug: 'guias_de_carga',
    name: 'Guías de carga',
    description:
      'Cada guía que sale de bodega, con su estado y su flete. La llena la hoja del despachador.',
    rowCount: 5000,
    fieldCount: 6,
    fields: FIELDS,
    updatedAt: '2026-10-02T14:40:00Z',
    createdBy: 'Laura Gómez',
    syncs: [
      {
        id: 's1',
        kind: 'table_sync',
        source: 'Fuente «Hoja del despachador»',
        every: 'cada 15 min',
        state: 'ok',
        lastRunAt: '2026-10-02T14:40:00Z',
        lastError: null,
        lastInserted: 12,
        lastUpdated: 30,
      },
    ],
    workType: 'despacho',
  },
  {
    id: 'b',
    slug: 'facturas_proveedores',
    name: 'Facturas de proveedores',
    description: 'Las facturas que llegan a la carpeta de Drive, leídas por Cortex.',
    rowCount: 318,
    fieldCount: 8,
    fields: [],
    updatedAt: '2026-10-01T22:10:00Z',
    createdBy: 'Andrés Peña',
    syncs: [
      {
        id: 's2',
        kind: 'drive_folder',
        source: 'Carpeta de Drive «Facturas 2026»',
        every: 'cada 30 min',
        state: 'error',
        lastRunAt: '2026-10-02T09:00:00Z',
        lastError: 'Google Drive dijo que ya no hay permiso para leer la carpeta.',
        lastInserted: 0,
        lastUpdated: 0,
      },
    ],
    workType: null,
  },
  {
    id: 'c',
    slug: 'remates',
    name: 'Remates',
    description: 'Vehículos en remate que el cliente quiere vigilar.',
    rowCount: 42,
    fieldCount: 5,
    fields: [],
    updatedAt: '2026-09-20T15:00:00Z',
    createdBy: 'Camila Ríos',
    syncs: [],
    workType: null,
  },
];

export function DatagridShowcase({
  pantalla,
  dark,
  empty,
  server,
  rows: count,
}: {
  pantalla: 'grilla' | 'tablas' | 'tabla';
  dark: boolean;
  empty: boolean;
  server: boolean;
  rows: number;
}) {
  useTheme(dark);
  const guides = useMemo(() => (empty ? [] : makeGuides(count)), [empty, count]);
  const tracker = useMemo(() => trackerRows(guides), [guides]);

  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <main className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-8 md:py-7">
        {pantalla === 'grilla' ? (
          <>
            <PageHeader
              title="Guías de carga"
              subtitle="5.000 guías de mentira para probar el visualizador: filtra, agrupa, edita, arrastra y exporta."
              icon={<Truck className="h-5 w-5" />}
            />
            <GridDemo rows={guides} server={server} />
          </>
        ) : pantalla === 'tablas' ? (
          <TrackersIndex
            cards={empty ? [] : CARDS}
            actions={INDEX_ACTIONS}
            canCreate
            links={{ base: '/trackers', chatBase: '/chat' }}
            hrefForTable={() => '/v/datagrid-showcase?pantalla=tabla'}
          />
        ) : (
          <TrackerScreen
            data={{
              tracker: {
                id: 'a',
                slug: 'guias_de_carga',
                name: 'Guías de carga',
                description: 'Cada guía que sale de bodega, con su estado y su flete.',
                fields: FIELDS,
                createdBy: null,
                updatedAt: '2026-10-02T14:40:00Z',
              },
              columns: trackerColumns(FIELDS),
              rows: tracker,
              total: tracker.length,
              savedViews: SAVED.slice(0, 1).map((v) => ({ ...v, filters: [] })),
              syncs: [...(CARDS[0]?.syncs ?? []), ...(CARDS[1]?.syncs ?? [])],
              workType: 'despacho',
              syncedRows: 840,
              canChangeSchema: true,
            }}
            actions={TRACKER_ACTIONS}
            links={{
              chatBase: '/chat',
              viewHref: '/chat?prompt=Crea%20una%20vista',
              teamHref: '/team/medir',
              backHref: '/v/datagrid-showcase?pantalla=tablas',
            }}
          />
        )}
      </main>
    </div>
  );
}
