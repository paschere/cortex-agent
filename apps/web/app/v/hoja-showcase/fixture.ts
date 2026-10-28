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
      options: ['OK-BBIC', 'Por revisar', 'Rechazado'],
    },
    { key: 'cobro_adicional', label: 'Cobro adicional', type: 'money', required: false },
  ],
};

const guias: CatalogTracker = {
  slug: 'guias',
  name: 'Guías',
  fields: [
    { key: 'cliente', label: 'Cliente', type: 'text', required: true },
    { key: 'guia', label: 'Guía', type: 'text', required: true },
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
    { key: 'tarifa_usd', label: 'Tarifa USD/kg', type: 'number', required: false },
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
const NOW = new Date('2026-10-27T15:00:00.000Z');
const at = NOW.toISOString();

const MANIFIESTOS: Array<[string, string, string, string, number]> = [
  ['FLEX 1', '3478', 'FVA-1203', 'OK-BBIC', 85_000],
  ['FLEX 2', '3492', 'FVA-1207', 'OK-BBIC', 0],
  ['FLEX 3', '3511', 'FVA-1212', 'Por revisar', 120_000],
];

type G = [string, string, string, string, string, string, number, number, number, number];
const GUIAS: Array<[number, ...G]> = [
  [1, 'Aeroexpress SAS', '172-48810231', 'No', 'AV 2134 / Avianca', '2026-10-05', '2026-10-06', 12, 184.5, 0.09, 3433.71],
  [1, 'Aeroexpress SAS', '172-48810242', 'Sí', 'AV 2134 / Avianca', '2026-10-05', '2026-10-06', 4, 61.2, 0.09, 3433.71],
  [1, 'Logística Andina', '075-91120087', 'No', 'LA 580 / LATAM', '2026-10-05', '2026-10-07', 30, 512.8, 0.09, 3430.1],
  [1, 'Logística Andina', '075-91120098', 'Sí', 'LA 580 / LATAM', '2026-10-05', '2026-10-07', 9, 140.0, 0.09, 3430.1],
  [2, 'Carga del Sur', '134-50081177', 'No', 'CM 232 / Copa', '2026-10-09', '2026-10-10', 22, 330.4, 0.09, 3427.5],
  [2, 'Carga del Sur', '134-50081188', 'No', 'CM 232 / Copa', '2026-10-09', '2026-10-10', 15, 205.75, 0.09, 3427.5],
  [2, 'Floralia Export', '045-33210044', 'Sí', 'AA 922 / American', '2026-10-09', '2026-10-12', 6, 98.3, 0.09, 3427.5],
  [3, 'Aeroexpress SAS', '172-48811300', 'No', 'AV 2134 / Avianca', '2026-10-14', '2026-10-15', 18, 275.0, 0.09, 3433.71],
  [3, 'Floralia Export', '045-33211012', 'No', 'AA 922 / American', '2026-10-14', '2026-10-15', 40, 802.6, 0.09, 3433.71],
  [3, 'Floralia Export', '045-33211023', 'Sí', 'AA 922 / American', '2026-10-14', '2026-10-15', 7, 120.9, 0.09, 3433.71],
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
    ([m, cliente, guia, parcial, vuelo, arribo, traslado, piezas, kilos, tarifa, trm], i) => {
      const totalUsd = Math.round(kilos * tarifa * 100) / 100;
      const man = MANIFIESTOS[m - 1] as (typeof MANIFIESTOS)[number];
      return {
        id: uuid(i + 1),
        label: cliente,
        values: {
          cliente,
          guia,
          parcial,
          vuelo,
          fecha_arribo: arribo,
          fecha_traslado: traslado,
          piezas,
          kilos,
          tarifa_usd: tarifa,
          total_usd: kilos * tarifa,
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
  return new Map<string, ViewSource>([
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
          'parcial',
          'vuelo',
          'fecha_arribo',
          'fecha_traslado',
          'piezas',
          'kilos',
          'tarifa_usd',
          'total_usd',
          'trm',
          'total_cop',
        ],
        frozen: 2,
        editable: [
          'cliente',
          'guia',
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
