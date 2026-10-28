import {
  type CatalogTracker,
  type ComputedView,
  type ViewRow,
  type ViewSource,
  computeView,
  viewSpecSchema,
} from '@cortex/agent-tools';

/**
 * LA HOJA DE PREFACTURACIÓN, CALCULADA DE VERDAD con datos inventados: manifiestos
 * (FVA) con sus guías en dos niveles. Es lo que Cortex arma para una operación de
 * carga que hoy vive en una hoja de cálculo: encabezado de grupo con el N° de
 * manifiesto, el FVA, el estado y el cobro adicional; guías con parcial en
 * rosado; total USD = kilos × tarifa y total COP = total USD × TRM.
 * Módulo de servidor: el barril del paquete no entra al bundle del navegador.
 */

const manifiestos: CatalogTracker = {
  slug: 'manifiestos',
  name: 'Manifiestos',
  fields: [
    { key: 'nombre', label: 'Manifiesto', type: 'text', required: true },
    { key: 'numero', label: 'N° manifiesto', type: 'text', required: false },
    { key: 'fva', label: 'FVA', type: 'text', required: false },
    {
      key: 'estado',
      label: 'Estado',
      type: 'select',
      required: false,
      options: ['OK', 'Pendiente', 'Rechazado', 'Enviado a Siigo'],
    },
    { key: 'cobro_adicional', label: 'Cobro adicional', type: 'money', required: false },
  ],
};

const tarifas: CatalogTracker = {
  slug: 'tarifas',
  name: 'Tarifas',
  fields: [
    { key: 'nombre', label: 'Tarifa', type: 'text', required: true },
    { key: 'tarifa_usd_kg', label: 'Tarifa USD/kg', type: 'number', required: false },
    { key: 'notas', label: 'Notas', type: 'text', required: false },
  ],
};

const clientes: CatalogTracker = {
  slug: 'clientes',
  name: 'Clientes',
  fields: [
    { key: 'nombre', label: 'Cliente', type: 'text', required: true },
    { key: 'nit', label: 'NIT', type: 'text', required: false },
    // La tarifa por defecto del cliente: la fila la trae si no tiene una elegida.
    { key: 'tarifa', label: 'Tarifa', type: 'relation', tracker: 'tarifas', required: false },
  ],
};

const guias: CatalogTracker = {
  slug: 'guias',
  name: 'Guías',
  fields: [
    { key: 'cliente', label: 'Cliente', type: 'relation', tracker: 'clientes', required: true },
    {
      key: 'tarifa',
      label: 'Tarifa',
      type: 'relation',
      tracker: 'tarifas',
      required: false,
      lookup: { via: 'cliente', field: 'tarifa', editable: true },
    },
    { key: 'guia', label: 'Guía', type: 'text', required: true },
    {
      key: 'estado',
      label: 'Estado',
      type: 'select',
      required: false,
      options: ['Pendiente', 'OK', 'Rechazado', 'Enviado a Siigo'],
    },
    {
      key: 'parcial',
      label: 'Parcial',
      type: 'select',
      required: false,
      options: ['Sí', 'No'],
    },
    { key: 'vuelo', label: 'Vuelo / aerolínea', type: 'text', required: false },
    { key: 'fecha_arribo', label: 'Arribo', type: 'date', required: false },
    { key: 'fecha_traslado', label: 'Traslado', type: 'date', required: false },
    { key: 'piezas', label: 'Piezas', type: 'number', required: false },
    { key: 'kilos', label: 'Kilos', type: 'number', required: false },
    {
      key: 'tarifa_usd',
      label: 'Tarifa USD/kg',
      type: 'number',
      required: false,
      lookup: { via: 'tarifa', field: 'tarifa_usd_kg', editable: true },
    },
    {
      key: 'total_usd',
      label: 'Total USD',
      type: 'money',
      currency: 'USD',
      formula: '[kilos] × [tarifa_usd]',
      required: false,
    },
    { key: 'trm', label: 'TRM', type: 'number', required: false },
    {
      key: 'total_cop',
      label: 'Total COP',
      type: 'money',
      formula: '[total_usd] × [trm]',
      required: false,
    },
    { key: 'manifiesto', label: 'Manifiesto', type: 'relation', tracker: 'manifiestos', required: false },
  ],
};

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rel = (id: string, label: string) => JSON.stringify({ id, label });
export const TARIFAS_DEMO: Array<{ id: string; nombre: string; tarifa: number; notas: string }> = [
  { id: uuid(300), nombre: 'Estándar', tarifa: 0.09, notas: 'Carga general' },
  { id: uuid(301), nombre: 'Perecederos', tarifa: 0.12, notas: 'Flores y alimentos' },
  { id: uuid(302), nombre: 'Express', tarifa: 0.15, notas: 'Prioridad 24 h' },
];
export const CLIENTES_DEMO: Array<{ id: string; nombre: string; nit: string; tarifa: number }> = [
  { id: uuid(200), nombre: 'Aeroexpress SAS', nit: '900123456-7', tarifa: 0 },
  { id: uuid(201), nombre: 'Logística Andina', nit: '830555123-1', tarifa: 0 },
  { id: uuid(202), nombre: 'Carga del Sur', nit: '901222333-4', tarifa: 0 },
  { id: uuid(203), nombre: 'Floralia Export', nit: '800765432-9', tarifa: 1 },
];
const NOW = new Date('2026-10-27T15:00:00.000Z');
const at = NOW.toISOString();

const MANIFIESTOS: Array<[string, string, string, string, number]> = [
  ['FLEX 1', '3478', 'FVA-1203', 'Enviado a Siigo', 85_000],
  ['FLEX 2', '3492', 'FVA-1207', 'OK', 0],
  ['FLEX 3', '3511', 'FVA-1212', 'Pendiente', 120_000],
  ['FLEX 4', '3530', 'FVA-1219', 'Rechazado', 0],
];

type G = [string, string, string, string, string, string, number, number, number, number, string];
const GUIAS: Array<[number, ...G]> = [
  [1, 'Aeroexpress SAS', '172-48810231', 'No', 'AV 2134 / Avianca', '2026-10-05', '2026-10-06', 12, 184.5, 0.09, 3433.71, 'Enviado a Siigo'],
  [1, 'Aeroexpress SAS', '172-48810242', 'Sí', 'AV 2134 / Avianca', '2026-10-05', '2026-10-06', 4, 61.2, 0.09, 3433.71, 'Enviado a Siigo'],
  [1, 'Logística Andina', '075-91120087', 'No', 'LA 580 / LATAM', '2026-10-05', '2026-10-07', 30, 512.8, 0.09, 3430.1, 'Enviado a Siigo'],
  [1, 'Logística Andina', '075-91120098', 'Sí', 'LA 580 / LATAM', '2026-10-05', '2026-10-07', 9, 140.0, 0.09, 3430.1, 'Enviado a Siigo'],
  [2, 'Carga del Sur', '134-50081177', 'No', 'CM 232 / Copa', '2026-10-09', '2026-10-10', 22, 330.4, 0.09, 3427.5, 'OK'],
  [2, 'Carga del Sur', '134-50081188', 'No', 'CM 232 / Copa', '2026-10-09', '2026-10-10', 15, 205.75, 0.09, 3427.5, 'Pendiente'],
  [2, 'Floralia Export', '045-33210044', 'Sí', 'AA 922 / American', '2026-10-09', '2026-10-12', 6, 98.3, 0.09, 3427.5, 'OK'],
  [3, 'Aeroexpress SAS', '172-48811300', 'No', 'AV 2134 / Avianca', '2026-10-14', '2026-10-15', 18, 275.0, 0.09, 3433.71, 'Pendiente'],
  [3, 'Floralia Export', '045-33211012', 'No', 'AA 922 / American', '2026-10-14', '2026-10-15', 40, 802.6, 0.09, 3433.71, 'Pendiente'],
  [3, 'Floralia Export', '045-33211023', 'Sí', 'AA 922 / American', '2026-10-14', '2026-10-15', 7, 120.9, 0.09, 3433.71, 'Rechazado'],
  [4, 'Carga del Sur', '134-50082001', 'No', 'CM 232 / Copa', '2026-10-21', '2026-10-22', 11, 150.2, 0.09, 3440.2, 'Rechazado'],
  [4, 'Logística Andina', '075-91121100', 'No', 'LA 580 / LATAM', '2026-10-21', '2026-10-23', 25, 401.0, 0.09, 3440.2, 'Pendiente'],
];

function sources(): Map<string, ViewSource> {
  const mRows: ViewRow[] = MANIFIESTOS.map(([nombre, numero, fva, estado, cobro], i) => ({
    id: uuid(100 + i),
    label: nombre,
    values: { nombre, numero, fva, estado, ...(cobro ? { cobro_adicional: cobro } : {}) },
    created_by: null,
    created_at: at,
    updated_at: at,
  }));
  const gRows: ViewRow[] = GUIAS.map(
    ([m, cliente, guia, parcial, vuelo, arribo, traslado, piezas, kilos, _tarifa, trm, estado], i) => {
      const cli = CLIENTES_DEMO.find((c) => c.nombre === cliente) ?? (CLIENTES_DEMO[0] as (typeof CLIENTES_DEMO)[number]);
      const tar = TARIFAS_DEMO[cli.tarifa] as (typeof TARIFAS_DEMO)[number];
      const totalUsd = Math.round(kilos * tar.tarifa * 100) / 100;
      const man = MANIFIESTOS[m - 1] as (typeof MANIFIESTOS)[number];
      return {
        id: uuid(i + 1),
        label: cliente,
        values: {
          cliente: rel(cli.id, cliente),
          tarifa: rel(tar.id, tar.nombre),
          guia,
          estado,
          parcial,
          vuelo,
          fecha_arribo: arribo,
          fecha_traslado: traslado,
          piezas,
          kilos,
          tarifa_usd: tar.tarifa,
          total_usd: totalUsd,
          trm,
          total_cop: Math.round(totalUsd * trm),
          manifiesto: JSON.stringify({ id: uuid(99 + m), label: man[0] }),
        },
        created_by: null,
        created_at: at,
        updated_at: at,
      };
    },
  );
  const tRows: ViewRow[] = TARIFAS_DEMO.map((t) => ({
    id: t.id,
    label: t.nombre,
    values: { nombre: t.nombre, tarifa_usd_kg: t.tarifa, notas: t.notas },
    created_by: null,
    created_at: at,
    updated_at: at,
  }));
  const cRows: ViewRow[] = CLIENTES_DEMO.map((c) => ({
    id: c.id,
    label: c.nombre,
    values: { nombre: c.nombre, nit: c.nit, tarifa: rel((TARIFAS_DEMO[c.tarifa] as { id: string }).id, TARIFAS_DEMO[c.tarifa]?.nombre ?? '') },
    created_by: null,
    created_at: at,
    updated_at: at,
  }));
  return new Map<string, ViewSource>([
    ['tarifas', { tracker: tarifas, truncated: false, rows: tRows }],
    ['clientes', { tracker: clientes, truncated: false, rows: cRows }],
    ['manifiestos', { tracker: manifiestos, truncated: false, rows: mRows }],
    ['guias', { tracker: guias, truncated: false, rows: gRows }],
  ]);
}

export const HOJA_TITLE = 'Hoja de prefacturación';
export const HOJA_SUBTITLE =
  'Manifiestos con sus guías: edita con el teclado, pega desde Excel y mira los totales al pie.';

export function hojaView(): ComputedView {
  const spec = viewSpecSchema.parse({
    version: 1,
    editing: 'team',
    blocks: [
      {
        id: 'hoja',
        type: 'sheet',
        tracker: 'guias',
        title: 'Guías por manifiesto',
        columns: [
          'cliente',
          'guia',
          'estado',
          'parcial',
          'vuelo',
          'fecha_arribo',
          'fecha_traslado',
          'piezas',
          'kilos',
          'tarifa',
          'tarifa_usd',
          'total_usd',
          'trm',
          'total_cop',
        ],
        frozen: 2,
        editable: [
          'cliente',
          'tarifa',
          'guia',
          'estado',
          'parcial',
          'vuelo',
          'fecha_arribo',
          'fecha_traslado',
          'piezas',
          'kilos',
          'tarifa_usd',
          'trm',
          'manifiesto',
        ],
        group: {
          by: 'manifiesto',
          parentTracker: 'manifiestos',
          parentFields: ['numero', 'fva', 'estado', 'cobro_adicional'],
          subtotals: ['piezas', 'kilos', 'total_usd', 'total_cop'],
          sortBy: 'nombre',
        },
        rules: [{ field: 'parcial', op: 'eq', value: 'Sí', tone: 'rose', paint: 'cell' }],
        totals: [
          { field: 'guia', op: 'count' },
          { field: 'piezas', op: 'sum' },
          { field: 'kilos', op: 'sum' },
          { field: 'total_usd', op: 'sum' },
          { field: 'total_cop', op: 'sum' },
        ],
        pasteKey: 'guia',
      },
    ],
  });
  return computeView(spec, sources(), NOW, {
    writable: true,
    viewer: { id: 'demo-user', kind: 'member' },
  });
}
