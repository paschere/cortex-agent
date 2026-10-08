import {
  type CatalogTracker,
  type ComputedView,
  type RecordHistoryRaw,
  type ViewRow,
  type ViewSource,
  computeView,
  viewSpecSchema,
} from '@cortex/agent-tools';

/**
 * LOS CUATRO TIPOS DE PANTALLA NUEVOS, CALCULADOS DE VERDAD.
 *
 * A diferencia de fixture.ts (un `ComputedView` escrito a mano), aquí se
 * arma un spec real y se pasa por `computeView` con filas inventadas, para ver
 * en el escaparate el mismo cálculo que corre en producción: el detalle de un
 * registro con relacionados y línea de tiempo, la lista de tarjetas con
 * filtros rápidos, la agenda día / semana / mes y el tablero TV. Las fechas
 * son relativas a HOY, así los chips «hoy» y «esta semana» siempre muestran algo.
 *
 * Es un módulo de servidor (lo usan page.tsx y data/route.ts): el barril del
 * paquete no entra al bundle del navegador.
 */

export const SCREEN_KINDS = ['detalle', 'tarjetas', 'agenda', 'tv', 'mapa'] as const;
export type ScreenKind = (typeof SCREEN_KINDS)[number];

export const SCREEN_TITLES: Record<ScreenKind, { title: string; subtitle: string }> = {
  detalle: {
    title: 'Despachos de hoy',
    subtitle: 'Toca un despacho: su detalle, sus paquetes y su historia.',
  },
  tarjetas: {
    title: 'Mis despachos',
    subtitle: 'Filtra con los chips, busca o cambia el orden.',
  },
  agenda: {
    title: 'Agenda de despachos',
    subtitle: 'Día, semana o mes, con la hora de cada salida.',
  },
  tv: { title: 'Planta · Despachos', subtitle: 'Pantalla de pared que rota sola.' },
  mapa: {
    title: 'Equipo y entregas',
    subtitle:
      'Dónde están las entregas y las personas en turno; toca a alguien para asignarle una tarea.',
  },
};

const despachos: CatalogTracker = {
  slug: 'despachos',
  name: 'Despachos',
  fields: [
    { key: 'codigo', label: 'Código', type: 'text', required: true },
    {
      key: 'estado',
      label: 'Estado',
      type: 'select',
      required: false,
      options: ['Programado', 'En ruta', 'Entregado', 'Con novedad'],
    },
    { key: 'fecha', label: 'Fecha', type: 'date', required: false },
    { key: 'hora', label: 'Hora de salida', type: 'time', required: false },
    { key: 'destino', label: 'Destino', type: 'text', required: false },
    { key: 'conductor', label: 'Conductor', type: 'text', required: false },
    { key: 'peso', label: 'Peso (kg)', type: 'number', required: false },
    { key: 'evidencia', label: 'Evidencia', type: 'file', required: false },
    { key: 'notas', label: 'Notas', type: 'text', required: false },
    { key: 'ubicacion', label: 'Ubicación', type: 'location', required: false },
  ],
};
const paquetes: CatalogTracker = {
  slug: 'paquetes',
  name: 'Paquetes',
  fields: [
    { key: 'guia', label: 'Guía', type: 'text', required: true },
    { key: 'despacho', label: 'Despacho', type: 'text', required: false },
    { key: 'peso', label: 'Peso (kg)', type: 'number', required: false },
    {
      key: 'estado',
      label: 'Estado',
      type: 'select',
      required: false,
      options: ['Pendiente', 'Entregado'],
    },
  ],
};
const novedades: CatalogTracker = {
  slug: 'novedades',
  name: 'Novedades',
  fields: [
    { key: 'detalle', label: 'Detalle', type: 'text', required: true },
    { key: 'despacho', label: 'Despacho', type: 'relation', tracker: 'despachos', required: false },
    {
      key: 'tipo',
      label: 'Tipo',
      type: 'select',
      required: false,
      options: ['Daño', 'Retraso', 'Dirección'],
    },
  ],
};

const day = (now: Date, offset: number) =>
  new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PHOTO = JSON.stringify({
  url: '/icon-512.png',
  name: 'evidencia.png',
  mime: 'image/png',
  size: 12_000,
});

const DESTINOS = ['Bogotá', 'Medellín', 'Cali', 'Barranquilla', 'Bucaramanga', 'Pereira'];
/** Puntos de entrega inventados, todos dentro de Bogotá (lat,lng). */
const PUNTOS = [
  '4.710989,-74.072092',
  '4.648600,-74.109700',
  '4.609700,-74.081700',
  '4.676000,-74.048000',
  '4.598100,-74.147100',
  '4.735000,-74.030000',
];
const CONDUCTORES = ['Luis Pardo', 'Marta Ríos', 'Andrés Gil', 'Sonia Vega'];

function rows(now: Date) {
  const states = ['Programado', 'En ruta', 'Entregado', 'Con novedad'];
  const out: ViewRow[] = Array.from({ length: 14 }, (_, i) => {
    const offset = [0, 0, 0, 1, 1, 2, 3, -1, -1, -2, 0, 4, 5, 9][i] ?? 0;
    const estado = states[i % 4] as string;
    const hour = 6 + ((i * 3) % 13);
    return {
      id: uuid(i + 1),
      label: `DSP-${String(1040 + i)}`,
      created_at: new Date(now.getTime() - (20 - i) * 3_600_000).toISOString(),
      updated_at: new Date(now.getTime() - (10 - i) * 1_800_000).toISOString(),
      created_by: i % 3 === 0 ? 'demo-user' : 'otro',
      values: {
        codigo: `DSP-${1040 + i}`,
        estado,
        fecha: day(now, offset),
        hora: `${String(hour).padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
        destino: DESTINOS[i % DESTINOS.length] as string,
        conductor: CONDUCTORES[i % CONDUCTORES.length] as string,
        peso: 120 + i * 35,
        ...(i < 11 ? { ubicacion: PUNTOS[i % PUNTOS.length] as string } : {}),
        ...(estado === 'Entregado' ? { evidencia: PHOTO } : {}),
        ...(estado === 'Con novedad' ? { notas: 'Cliente ausente, reprogramar' } : {}),
      },
    };
  });
  return out;
}

function packages(): ViewRow[] {
  return Array.from({ length: 16 }, (_, i) => ({
    id: uuid(100 + i),
    label: `PQ-${5000 + i}`,
    created_at: '2026-10-01T12:00:00Z',
    updated_at: '2026-10-01T12:00:00Z',
    values: {
      guia: `PQ-${5000 + i}`,
      despacho: `DSP-${1040 + (i % 5)}`,
      peso: 4 + (i % 7) * 3,
      estado: i % 3 === 0 ? 'Entregado' : 'Pendiente',
    },
  }));
}

function issues(): ViewRow[] {
  return [
    {
      id: uuid(200),
      label: 'Caja golpeada',
      created_at: '2026-10-01T12:00:00Z',
      updated_at: '2026-10-01T12:00:00Z',
      values: {
        detalle: 'Caja golpeada',
        despacho: JSON.stringify({ id: uuid(1), label: 'DSP-1040' }),
        tipo: 'Daño',
      },
    },
  ];
}

function history(now: Date): RecordHistoryRaw {
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  return {
    created: { at: ago(26 * 60), by: 'Marta Ríos' },
    events: [
      {
        id: 'e1',
        at: ago(20 * 60),
        kind: 'edit',
        actionId: null,
        by: 'Marta Ríos',
        changes: { conductor: { from: 'Sonia Vega', to: 'Luis Pardo' } },
      },
      {
        id: 'e2',
        at: ago(6 * 60),
        kind: 'edit',
        actionId: null,
        by: 'Luis Pardo',
        changes: { estado: { from: 'Programado', to: 'En ruta' }, peso: { from: 120, to: 140 } },
      },
      {
        id: 'e3',
        at: ago(150),
        kind: 'edit',
        actionId: null,
        by: 'Luis Pardo',
        changes: { evidencia: { from: null, to: PHOTO } },
      },
      {
        id: 'e4',
        at: ago(90),
        kind: 'action',
        actionId: '__approve',
        by: 'Tú',
        changes: { estado: { from: 'En ruta', to: 'Entregado' } },
      },
    ],
    runs: [{ id: 'r1', at: ago(89), automation: 'Avisar al cliente por correo', ok: true }],
  };
}

function detail(extra: Record<string, unknown> = {}) {
  return {
    id: 'detalle',
    type: 'detail',
    tracker: 'despachos',
    titleField: 'codigo',
    subtitleField: 'destino',
    statusField: 'estado',
    sections: [
      { title: 'Salida', fields: ['fecha', 'hora', 'destino'] },
      { title: 'Equipo', fields: ['conductor', 'peso', 'notas'] },
    ],
    gallery: ['evidencia'],
    related: [
      {
        id: 'paquetes',
        title: 'Paquetes del despacho',
        tracker: 'paquetes',
        field: 'despacho',
        match: 'value',
        parentField: 'codigo',
        columns: ['guia', 'peso', 'estado'],
        actions: [
          {
            id: 'entregar',
            label: 'Entregado',
            kind: 'set_field',
            field: 'estado',
            value: 'Entregado',
          },
        ],
      },
      {
        id: 'novedades',
        title: 'Novedades',
        tracker: 'novedades',
        field: 'despacho',
        match: 'relation',
        columns: ['detalle', 'tipo'],
      },
    ],
    actions: [
      {
        id: 'cerrar',
        label: 'Marcar entregado',
        kind: 'set_field',
        field: 'estado',
        value: 'Entregado',
        confirm: true,
        tone: 'emerald',
      },
    ],
    recordEditable: ['conductor', 'notas'],
    ...extra,
  };
}

function cards(extra: Record<string, unknown> = {}) {
  return {
    id: 'tarjetas',
    type: 'cards',
    tracker: 'despachos',
    title: 'Despachos',
    titleField: 'codigo',
    subtitleField: 'destino',
    statusField: 'estado',
    imageField: 'evidencia',
    dateField: 'fecha',
    dataFields: ['fecha', 'hora', 'conductor', 'peso'],
    chips: ['status', 'today', 'week', 'mine'],
    sortOptions: ['fecha', 'destino', 'peso'],
    sort: { field: 'fecha', dir: 'asc' },
    pageSize: 6,
    ...extra,
  };
}

function specFor(kind: ScreenKind) {
  const common = { version: 1, editing: 'team', refreshSeconds: 30 };
  if (kind === 'agenda')
    return {
      ...common,
      blocks: [
        {
          id: 'agenda',
          type: 'calendar',
          tracker: 'despachos',
          title: 'Salidas',
          dateField: 'fecha',
          timeField: 'hora',
          labelField: 'codigo',
          colorField: 'estado',
          mode: 'week',
          modes: ['day', 'week', 'month'],
        },
        detail(),
      ],
    };
  if (kind === 'mapa')
    return {
      ...common,
      blocks: [
        {
          id: 'mapa',
          type: 'map',
          tracker: 'despachos',
          title: 'Entregas y equipo',
          locationField: 'ubicacion',
          titleField: 'codigo',
          subtitleField: 'destino',
          colorField: 'estado',
          people: true,
          assign: {
            assigneeField: 'conductor',
            titleField: 'notas',
            descriptionField: 'destino',
            dueField: 'fecha',
            dueTimeField: 'hora',
            priorityField: 'estado',
          },
          actions: [
            {
              id: 'cerrar',
              label: 'Marcar entregado',
              kind: 'set_field',
              field: 'estado',
              value: 'Entregado',
              tone: 'emerald',
            },
          ],
        },
        detail(),
      ],
    };
  if (kind === 'tv')
    return {
      ...common,
      refreshSeconds: 10,
      theme: { layout: 'tv', tv: { rotateSeconds: 10, clock: true } },
      pages: [
        { id: 'cifras', title: 'Indicadores del día', blockIds: ['k1', 'k2', 'k3', 'k4'] },
        { id: 'tablero', title: 'Despachos por estado', blockIds: ['tablero'] },
        { id: 'peso', title: 'Carga por destino', blockIds: ['carga'] },
      ],
      blocks: [
        {
          id: 'k1',
          type: 'metric',
          tracker: 'despachos',
          title: 'Despachos hoy',
          filters: [{ field: 'fecha', op: 'eq', value: 'hoy' }],
          tone: 'primary',
        },
        {
          id: 'k2',
          type: 'metric',
          tracker: 'despachos',
          title: 'En ruta',
          filters: [{ field: 'estado', op: 'eq', value: 'En ruta' }],
          tone: 'sky',
        },
        {
          id: 'k3',
          type: 'metric',
          tracker: 'despachos',
          title: 'Entregados',
          filters: [{ field: 'estado', op: 'eq', value: 'Entregado' }],
          tone: 'emerald',
        },
        {
          id: 'k4',
          type: 'metric',
          tracker: 'despachos',
          title: 'Con novedad',
          filters: [{ field: 'estado', op: 'eq', value: 'Con novedad' }],
          tone: 'rose',
          goal: 2,
          goalDirection: 'down',
        },
        {
          id: 'tablero',
          type: 'board',
          tracker: 'despachos',
          title: 'Estado de la flota',
          groupBy: 'estado',
          cardFields: ['destino', 'conductor'],
          limit: 4,
        },
        {
          id: 'carga',
          type: 'chart',
          tracker: 'despachos',
          title: 'Kilos por destino',
          chart: 'bar',
          groupBy: 'destino',
          aggregate: 'sum',
          field: 'peso',
        },
      ],
    };
  return {
    ...common,
    blocks: [
      kind === 'tarjetas'
        ? cards()
        : cards({ title: 'Despachos de hoy', chips: ['status', 'today', 'mine'] }),
      detail(),
    ],
  };
}

export function screensView(
  kind: ScreenKind,
  opts: { fila?: string | null; d?: string | null; now?: Date } = {},
): ComputedView {
  const now = opts.now ?? new Date();
  const base = rows(now);
  // El spec del TV compara con la fecha de hoy: se resuelve aquí, no en el spec.
  const spec = viewSpecSchema.parse(
    JSON.parse(JSON.stringify(specFor(kind)).replaceAll('"hoy"', JSON.stringify(day(now, 0)))),
  );
  const sources = new Map<string, ViewSource>([
    ['despachos', { tracker: despachos, truncated: false, rows: base }],
    ['paquetes', { tracker: paquetes, truncated: false, rows: packages() }],
    ['novedades', { tracker: novedades, truncated: false, rows: issues() }],
  ]);
  const wanted = opts.fila && base.some((r) => r.id === opts.fila) ? opts.fila : null;
  return computeView(spec, sources, now, {
    writable: true,
    // El escaparate hace de quien ve y asigna: la capa de personas es de mentira (MapBlock, target demo).
    location: { enabled: true, canView: true, canAssign: true },
    viewer: { id: 'demo-user', kind: 'member' },
    record: opts.fila
      ? { rowId: opts.fila, blockId: opts.d ?? null, history: wanted ? history(now) : null }
      : null,
  });
}

export const FIRST_DESPACHO = uuid(1);
