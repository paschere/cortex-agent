import { describe, expect, it } from 'vitest';
import type { ViewRow, ViewSource } from '../views/compute';
import {
  buildPortalRole,
  computePortalFromSources,
  mergePortal,
  parsePortal,
  portalProblems,
  portalSchema,
  safePayUrl,
  suggestPortal,
} from './client-portal';

const envios = {
  slug: 'envios',
  name: 'Envíos',
  fields: [
    { key: 'cliente', label: 'Cliente', type: 'text', required: false },
    { key: 'guia', label: 'Guía', type: 'text', required: false },
    {
      key: 'estado',
      label: 'Estado',
      type: 'select',
      required: false,
      options: ['En ruta', 'Entregado'],
    },
  ],
} as never;
const facturas = {
  slug: 'facturas',
  name: 'Facturas',
  fields: [
    { key: 'cliente', label: 'Cliente', type: 'text', required: false },
    { key: 'valor', label: 'Valor', type: 'money', required: false },
    { key: 'vence', label: 'Vence', type: 'date', required: false },
    {
      key: 'estado',
      label: 'Estado',
      type: 'select',
      required: false,
      options: ['Pendiente', 'Pagada'],
    },
    { key: 'enlace', label: 'Enlace de pago', type: 'text', required: false },
  ],
} as never;
const soportes = {
  slug: 'soportes',
  name: 'Soportes de pago',
  fields: [
    { key: 'cliente', label: 'Cliente', type: 'text', required: false },
    { key: 'archivo', label: 'Archivo', type: 'file', required: false },
    { key: 'nota', label: 'Nota', type: 'longtext', required: false },
  ],
} as never;

const row = (id: string, values: Record<string, string | number>): ViewRow => ({
  id,
  label: `R-${id}`,
  values,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
});

const portal = portalSchema.parse({
  enabled: true,
  shipments: { source: 'envios', clientField: 'cliente', columns: ['guia'], statusField: 'estado' },
  invoices: {
    source: 'facturas',
    clientField: 'cliente',
    amountField: 'valor',
    dueField: 'vence',
    statusField: 'estado',
    payUrlField: 'enlace',
  },
  upload: { source: 'soportes', clientField: 'cliente', fileField: 'archivo', noteField: 'nota' },
});

const role = {
  key: 'cliente',
  name: 'Cliente',
  admin: false,
  permissions: buildPortalRole(portal).permissions,
};
const sources = (): Map<string, ViewSource> =>
  new Map([
    [
      'envios',
      {
        tracker: envios,
        truncated: false,
        rows: [
          row('1', { cliente: 'Andina', guia: 'G1' }),
          row('2', { cliente: 'Pacífico', guia: 'G2' }),
        ],
      },
    ],
    [
      'facturas',
      {
        tracker: facturas,
        truncated: false,
        rows: [
          row('f1', {
            cliente: 'Andina',
            valor: 500000,
            vence: '2026-09-01',
            estado: 'Pendiente',
            enlace: 'https://pagos.example/abc',
          }),
          row('f2', {
            cliente: 'Andina',
            valor: 100000,
            vence: '2026-11-01',
            estado: 'Pagada',
            enlace: 'https://pagos.example/def',
          }),
          row('f3', {
            cliente: 'Pacífico',
            valor: 999,
            vence: '2026-09-01',
            estado: 'Pendiente',
            enlace: 'https://pagos.example/otro',
          }),
        ],
      },
    ],
    ['soportes', { tracker: soportes, truncated: false, rows: [] }],
  ]);
const ctx = (cliente: string | null) => ({
  now: new Date('2026-10-12T15:00:00Z'),
  role,
  user: {
    id: 'u1',
    name: 'Cli',
    attributes: (cliente ? { cliente } : {}) as Record<string, string>,
    external: true,
  },
  basePath: '/a/x',
  visibleScreens: new Set(['subir_soporte']),
  appName: 'Mi app',
});

describe('portal de clientes', () => {
  it('un cliente nunca ve filas de otro, aunque la lectura venga sin scope', () => {
    const out = computePortalFromSources(portal, sources(), ctx('Andina'));
    const ship = out.sections.find((s) => s.kind === 'shipments');
    const inv = out.sections.find((s) => s.kind === 'invoices');
    expect(ship?.kind === 'shipments' && ship.rows.map((r) => r.id)).toEqual(['1']);
    expect(inv?.kind === 'invoices' && inv.rows.map((r) => r.id).sort()).toEqual(['f1', 'f2']);
    expect(JSON.stringify(out)).not.toContain('Pacífico');
    expect(JSON.stringify(out)).not.toContain('otro');
  });
  it('sin atributo de cliente no ve NADA (no «todo»)', () => {
    const out = computePortalFromSources(portal, sources(), ctx(null));
    expect(out.client).toBeNull();
    for (const s of out.sections) {
      if (s.kind === 'shipments' || s.kind === 'invoices') expect(s.rows).toHaveLength(0);
    }
  });
  it('lo que debe: suma sólo lo no pagado, marca atrasadas y ofrece Pagar sólo con enlace válido', () => {
    const out = computePortalFromSources(portal, sources(), ctx('Andina'));
    const inv = out.sections.find((s) => s.kind === 'invoices');
    if (inv?.kind !== 'invoices') throw new Error('x');
    expect(inv.owed).toContain('500.000');
    expect(inv.overdueCount).toBe(1);
    const f1 = inv.rows.find((r) => r.id === 'f1');
    expect(f1?.overdue).toBe(true);
    expect(f1?.payUrl).toBe('https://pagos.example/abc');
    expect(inv.rows.find((r) => r.id === 'f2')?.payUrl).toBeNull();
  });
  it('sin campo de enlace de pago no hay Pagar', () => {
    const noPay = parsePortal({
      ...portal,
      invoices: { ...portal.invoices, payUrlField: undefined },
    });
    const out = computePortalFromSources(noPay, sources(), ctx('Andina'));
    const inv = out.sections.find((s) => s.kind === 'invoices');
    expect(inv?.kind === 'invoices' && inv.rows.every((r) => r.payUrl === null)).toBe(true);
    expect(safePayUrl('javascript:alert(1)')).toBeNull();
    expect(safePayUrl('http://x.co')).toBeNull();
  });
  it('el rol sale del portal: lectura por atributo y sólo crea soportes', () => {
    const r = buildPortalRole(portal);
    expect(r.permissions.tables.envios?.read).toEqual({
      field: 'cliente',
      equals: '$user.cliente',
    });
    expect(r.permissions.tables.envios?.create).toBe(false);
    expect(r.permissions.tables.soportes?.create).toBe(true);
    expect(r.permissions.tables.soportes?.fields).toEqual(['archivo', 'nota']);
    expect(r.permissions.export).toBe(false);
  });
  it('valida contra el catálogo y mezcla parches', () => {
    expect(
      portalProblems(portal, { trackers: [envios, facturas, soportes], screenSlugs: [] }),
    ).toEqual([]);
    const bad = mergePortal(portal, {
      documents: { source: 'envios', clientField: 'cliente', fileField: 'guia' } as never,
    });
    expect(
      portalProblems(bad, { trackers: [envios, facturas, soportes], screenSlugs: [] }).join(' '),
    ).toContain('no es un campo de archivo');
    expect(mergePortal(portal, { upload: null }).upload).toBeUndefined();
  });
  it('sugiere el portal sobre las tablas del espacio', () => {
    const s = suggestPortal([envios, facturas, soportes]);
    expect(s.shipments?.source).toBe('envios');
    expect(s.invoices?.payUrlField).toBe('enlace');
    expect(s.upload?.source).toBe('soportes');
    expect(s.enabled).toBe(false);
  });
});
