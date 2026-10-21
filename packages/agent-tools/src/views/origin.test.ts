import { describe, expect, it } from 'vitest';
import type { TrackerOrigin } from '../trackers/origin';
import { type ViewSource, computeView } from './compute';
import { type CatalogTracker, checkSpecAgainst, viewSpecSchema } from './spec';

/**
 * Las vistas y apps sobre una tabla que viene de una integración (0237):
 * no se ofrecen celdas editables en los campos del origen, el formulario de una
 * tabla que se llena sola dice por qué no se llena, y cada tabla declara su
 * origen para que el bloque diga «Viene de Siigo».
 */

const siigo: TrackerOrigin = {
  kind: 'accounting',
  provider: 'siigo',
  label: 'Siigo',
  ref: 'conn-1',
  fields: ['numero', 'total'],
  creates: true,
};

const facturas: CatalogTracker = {
  slug: 'siigo_facturas',
  name: 'Facturas (Siigo)',
  origins: [siigo],
  fields: [
    { key: 'numero', label: 'Número', type: 'text', required: false },
    { key: 'total', label: 'Total', type: 'money', required: false },
    { key: 'responsable', label: 'Responsable', type: 'text', required: false },
    { key: 'notas', label: 'Notas', type: 'longtext', required: false },
  ],
};

const row = (id: string, values: Record<string, string | number>) => ({
  id,
  label: String(values.numero),
  values,
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-01T10:00:00Z',
});
const sources = (tracker: CatalogTracker = facturas) =>
  new Map<string, ViewSource>([
    [
      tracker.slug,
      {
        tracker,
        truncated: false,
        rows: [row('1', { numero: 'FV-1', total: 100, responsable: 'Ana' })],
      },
    ],
  ]);
const NOW = new Date('2026-10-21T17:00:00Z');
const spec = (blocks: unknown[]) => viewSpecSchema.parse({ version: 1, editing: 'team', blocks });

describe('diseño: lo que se rechaza al guardar', () => {
  it('columnas editables del origen se rechazan; las propias pasan', () => {
    const bad = spec([
      {
        id: 't',
        type: 'table',
        title: 'T',
        tracker: 'siigo_facturas',
        columns: ['numero', 'total', 'responsable'],
        editable: ['total'],
      },
    ]);
    expect(checkSpecAgainst(bad, [facturas]).join(' ')).toContain('«Total» viene de Siigo');
    const ok = spec([
      {
        id: 't',
        type: 'table',
        title: 'T',
        tracker: 'siigo_facturas',
        columns: ['numero', 'total', 'responsable'],
        editable: ['responsable'],
        recordEditable: ['notas'],
      },
    ]);
    expect(checkSpecAgainst(ok, [facturas])).toEqual([]);
  });

  it('un botón que escribe un campo del origen se rechaza', () => {
    const bad = spec([
      {
        id: 't',
        type: 'table',
        title: 'T',
        tracker: 'siigo_facturas',
        columns: ['numero'],
        actions: [
          { id: 'cobrar', label: 'Cobrada', kind: 'set_field', field: 'total', value: '0' },
        ],
      },
    ]);
    expect(checkSpecAgainst(bad, [facturas]).join(' ')).toContain('viene de Siigo');
  });

  it('un formulario sobre una tabla que se llena sola se rechaza con la explicación', () => {
    const form = spec([
      { id: 'f', type: 'form', title: 'T', tracker: 'siigo_facturas', fields: ['responsable'] },
    ]);
    const problems = checkSpecAgainst(form, [facturas]).join(' ');
    expect(problems).toContain('Esta tabla se llena sola desde Siigo');
    expect(problems).toContain('Por enviar a Siigo');
  });

  it('hojas y carpetas: formularios y columnas editables siguen funcionando', () => {
    for (const kind of ['sheet', 'drive_folder'] as const) {
      const t: CatalogTracker = {
        ...facturas,
        slug: 'vuelos',
        origins: [{ ...siigo, kind, provider: undefined }],
      };
      const form = spec([
        { id: 'f', type: 'form', title: 'T', tracker: 'vuelos', fields: ['numero', 'total'] },
        {
          id: 't',
          type: 'table',
          title: 'T',
          tracker: 'vuelos',
          columns: ['total'],
          editable: ['total'],
        },
      ]);
      expect(checkSpecAgainst(form, [t])).toEqual([]);
      const view = computeView(form, sources(t), NOW, { writable: true });
      expect(view.blocks[0]?.type).toBe('form');
      const table = view.blocks[1];
      if (table?.type !== 'table') throw new Error('sin tabla');
      expect(table.columns[0]?.edit).toBeDefined();
    }
  });

  it('una tabla propia no cambia', () => {
    const own: CatalogTracker = { ...facturas, slug: 'mias', origins: undefined };
    const form = spec([{ id: 'f', type: 'form', title: 'T', tracker: 'mias', fields: ['total'] }]);
    expect(checkSpecAgainst(form, [own])).toEqual([]);
  });
});

describe('cálculo: lo que ve quien abre la vista', () => {
  it('sólo los campos propios llevan editor en la celda', () => {
    const view = computeView(
      spec([
        {
          id: 't',
          type: 'table',
          title: 'T',
          tracker: 'siigo_facturas',
          columns: ['numero', 'total', 'responsable'],
          editable: ['total', 'responsable'],
        },
      ]),
      sources(),
      NOW,
      { writable: true },
    );
    const t = view.blocks[0];
    if (t?.type !== 'table') throw new Error(String(t?.type));
    const edit = (key: string) => t.columns.find((c) => c.key === key)?.edit;
    expect(edit('total')).toBeUndefined();
    expect(edit('responsable')).toBeDefined();
  });

  it('el formulario ya guardado sobre una tabla que se llena sola dice por qué no se llena', () => {
    const view = computeView(
      spec([
        { id: 'f', type: 'form', title: 'T', tracker: 'siigo_facturas', fields: ['responsable'] },
      ]),
      sources(),
      NOW,
      { writable: true },
    );
    const f = view.blocks[0];
    if (f?.type !== 'problem') throw new Error(String(f?.type));
    expect(f.message).toContain('se llena sola desde Siigo');
  });

  it('la vista declara los orígenes de sus tablas, con campos de sólo lectura y propios', () => {
    const view = computeView(
      spec([
        { id: 't', type: 'table', title: 'T', tracker: 'siigo_facturas', columns: ['numero'] },
      ]),
      sources(),
      NOW,
    );
    expect(view.origins).toHaveLength(1);
    expect(view.origins?.[0]).toMatchObject({
      tracker: 'siigo_facturas',
      blockIds: ['t'],
      creates: true,
      origin: { kind: 'accounting', name: 'Siigo' },
      lockedLabels: ['Número', 'Total'],
      ownLabels: ['Responsable', 'Notas'],
    });
  });

  it('una tabla propia no declara origen', () => {
    const own: CatalogTracker = { ...facturas, slug: 'mias', origins: undefined };
    const view = computeView(
      spec([{ id: 't', type: 'table', title: 'T', tracker: 'mias', columns: ['numero'] }]),
      sources(own),
      NOW,
    );
    expect(view.origins).toBeUndefined();
  });
});
